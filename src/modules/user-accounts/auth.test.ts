import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../db/client.js";
import type { PasswordAuth } from "../device-auth/admin-session.js";

/** Création de compte avec code à 6 chiffres, connexion. Données fictives, aucun envoi réel. */
const sent: { to: string; subject: string; text: string }[] = [];
vi.mock("../../email/resend.js", () => ({ sendEmail: vi.fn(async (m: { to: string; subject: string; text: string }) => void sent.push(m)) }));

const { startSignUp, verifySignUp, signIn } = await import("./auth.js");

interface FakeUser {
  id: string;
  email: string;
  password: string;
  email_confirmed_at: string | null;
  app_metadata: Record<string, unknown>;
}
let users: FakeUser[];

const db = {
  // Seul `clubs` est lu (lien des emails vers l'espace du club).
  from: () => {
    const q = { slug: "" as string, select: () => q, eq: (_c: string, v: string) => ((q.slug = v), q), maybeSingle: async () => ({ data: q.slug === "club-a" ? { slug: "club-a" } : null, error: null }) };
    return q;
  },
  auth: {
    admin: {
      listUsers: async () => ({ data: { users }, error: null }),
      createUser: async (input: { email: string; password: string }) => {
        const user = { id: `u${users.length + 1}`, email: input.email, password: input.password, email_confirmed_at: null, app_metadata: {} };
        users.push(user);
        return { data: { user }, error: null };
      },
      updateUserById: async (id: string, patch: { password?: string; email_confirm?: boolean; app_metadata?: Record<string, unknown> }) => {
        const user = users.find((u) => u.id === id)!;
        if (patch.password) user.password = patch.password;
        if (patch.email_confirm) user.email_confirmed_at = "2026-11-27T00:00:00Z";
        if (patch.app_metadata) user.app_metadata = patch.app_metadata;
        return { data: { user }, error: null };
      },
    },
  },
} as unknown as DbClient;

const auth: PasswordAuth = {
  signInWithPassword: async ({ email, password }) => {
    const user = users.find((u) => u.email === email);
    if (!user || user.password !== password) return { data: { session: null }, error: { message: "Invalid login credentials" } };
    return { data: { session: { access_token: `jwt-${user.id}`, refresh_token: `r-${user.id}`, expires_at: 1_900_000_000, user: { id: user.id, email, email_confirmed_at: user.email_confirmed_at } as never } }, error: null };
  },
  refreshSession: async () => ({ data: { session: null }, error: { message: "nope" } }),
};

const codeFromLastEmail = () => /\b(\d{6})\b/.exec(sent.at(-1)!.subject)![1]!;

beforeEach(() => {
  users = [];
  sent.length = 0;
});

describe("création de compte", () => {
  it("code par email, puis session ; le code n'est stocké que haché", async () => {
    await startSignUp(db, "Parent@Example.test", "motdepasse1");
    expect(users[0]!.email).toBe("parent@example.test");
    const code = codeFromLastEmail();
    expect(JSON.stringify(users[0]!.app_metadata)).not.toContain(code);

    const session = await verifySignUp(db, auth, { email: "parent@example.test", code, password: "motdepasse1" });
    expect(session).toMatchObject({ accessToken: "jwt-u1", user: { id: "u1" } });
    expect(users[0]!.email_confirmed_at).not.toBeNull();
  });

  it("mauvais code : refusé, et bloqué après 5 essais même avec le bon", async () => {
    await startSignUp(db, "p@example.test", "motdepasse1");
    const code = codeFromLastEmail();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(verifySignUp(db, auth, { email: "p@example.test", code: wrong, password: "motdepasse1" })).rejects.toMatchObject({ code: "INVALID_CODE" });
    await expect(verifySignUp(db, auth, { email: "p@example.test", code, password: "motdepasse1" })).rejects.toMatchObject({ code: "INVALID_CODE" });
  });

  it("adresse déjà inscrite : aucun compte créé ni mot de passe changé, email « tu as déjà un compte »", async () => {
    users.push({ id: "u1", email: "p@example.test", password: "ancien-mdp", email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: {} });
    await startSignUp(db, "p@example.test", "nouveau-mdp");
    expect(users).toHaveLength(1);
    expect(users[0]!.password).toBe("ancien-mdp");
    expect(sent.at(-1)!.subject).toContain("déjà un compte");
  });

  it("le lien de l'email ramène à l'espace du club d'où vient la personne (club inconnu : accueil)", async () => {
    await startSignUp(db, "a@example.test", "motdepasse1", new Date(), "club-a");
    expect(sent.at(-1)!.text).toContain("/public/club-a/compte");
    await startSignUp(db, "b@example.test", "motdepasse1", new Date(), "inconnu");
    expect(sent.at(-1)!.text).not.toContain("/public/");
    users.push({ id: "u9", email: "c@example.test", password: "x", email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: {} });
    await startSignUp(db, "c@example.test", "motdepasse1", new Date(), "club-a");
    expect(sent.at(-1)!.text).toContain("/public/club-a/compte");
  });

  it("mot de passe trop court : refusé avant tout", async () => {
    await expect(startSignUp(db, "p@example.test", "court")).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
    expect(users).toHaveLength(0);
  });
});

describe("connexion", () => {
  it("adresse non vérifiée : EMAIL_NOT_CONFIRMED ; mauvais mot de passe : LOGIN_FAILED", async () => {
    await startSignUp(db, "p@example.test", "motdepasse1");
    await expect(signIn(auth, "p@example.test", "motdepasse1")).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIRMED" });
    await expect(signIn(auth, "p@example.test", "faux-mdp")).rejects.toMatchObject({ code: "LOGIN_FAILED" });
  });
});
