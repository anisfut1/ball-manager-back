import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";
import { hashPublicToken } from "../public-tables/token.js";
import { resetRateLimits } from "../../security/rate-limit.js";

/**
 * Comptes de l'espace licencié (docs/ACCOUNTS.md) : rattachements, droits,
 * invitations, administration, suppression, notifications. Données fictives.
 */
let state: FakeClubSupabaseState;
/** Compte « connecté » : le JWT `jwt-<id>` désigne l'utilisateur `<id>`. */
const users: Record<string, { email: string; emailConfirmed: boolean }> = {};

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return {
    ...actual,
    verifyAccessToken: vi.fn(async (token: string) => {
      const id = token.replace(/^jwt-/, "");
      const user = users[id];
      if (!user) throw new Error("jeton invalide");
      return { id, email: user.email, emailConfirmed: user.emailConfirmed };
    }),
  };
});

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");
const { licencieFromRequest } = await import("../public/credential.js");
const { pushTargets } = await import("../push/service.js");

const CLUB_A = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };
const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", name: "Club B", ffbb_club_id: "B1" };
const LINA = "44444444-4444-4444-8444-000000000001";
const HUGO = "44444444-4444-4444-8444-000000000002";
const OTHER_CLUB_KID = "44444444-4444-4444-8444-000000000009";
const M_ADMIN = "55555555-5555-4555-8555-00000000000a";

function lic(id: string, firstName: string, clubId = CLUB_A.id, email: string | null = null): FakeLicencieRow {
  return { id, club_id: clubId, first_name: firstName, last_name: "MARTIN", license_number: null, birth_date: "2012-01-01", email, phone: null, photo_url: null, active: true, team_id: null } as FakeLicencieRow;
}

const call = (path: string, init: { method?: string; body?: unknown; as?: string; headers?: Record<string, string> } = {}) =>
  app.request(path, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.as ? { authorization: `Bearer jwt-${init.as}` } : {}), ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const account = (path: string, init: Parameters<typeof call>[1] = {}) => call(`/v1/public/clubs/club-a/account${path}`, init);
const json = async <T>(res: Response) => (await res.json()) as T;

function req(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower[name.toLowerCase()], query: () => undefined };
}

beforeEach(() => {
  resetRateLimits();
  for (const key of Object.keys(users)) delete users[key];
  users.mere = { email: "mere@example.test", emailConfirmed: true };
  users.pere = { email: "pere@example.test", emailConfirmed: true };
  users.inconnu = { email: "inconnu@example.test", emailConfirmed: false };
  users.admin = { email: "admin@example.test", emailConfirmed: true };
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    licencies: [lic(LINA, "Lina", CLUB_A.id, "Mere@Example.test"), lic(HUGO, "Hugo"), lic(OTHER_CLUB_KID, "Zoé", CLUB_B.id)],
    memberships: [{ id: M_ADMIN, club_id: CLUB_A.id, user_id: "admin", status: "active" }],
    roles: [{ membership_id: M_ADMIN, role: "club_admin", scope_team_id: null }],
    authUsers: Object.entries(users).map(([id, u]) => ({ id, email: u.email })),
  });
});

describe("rattachement d'un licencié au compte", () => {
  it("adresse vérifiée déjà connue sur la fiche : actif tout de suite", async () => {
    const res = await account("/links", { method: "POST", as: "mere", body: { licencieId: LINA } });
    expect(res.status).toBe(201);
    const body = await json<{ status: string; account: { people: { licencieId: string; status: string }[] } }>(res);
    expect(body.status).toBe("active");
    expect(body.account.people).toEqual([expect.objectContaining({ licencieId: LINA, firstName: "Lina", status: "active" })]);
  });

  it("adresse inconnue de la fiche : actif tout de suite, sans validation du club", async () => {
    const res = await account("/links", { method: "POST", as: "pere", body: { licencieId: LINA } });
    expect((await json<{ status: string }>(res)).status).toBe("active");
    expect(state.accountLinks[0]).toEqual(expect.objectContaining({ status: "active", source: "request" }));
    expect((await licencieFromRequest(req({ authorization: "Bearer jwt-pere" }), buildFakeClubSupabase(state), CLUB_A.id)).id).toBe(LINA);
  });

  it("adresse connue mais PAS vérifiée : actif, mais pas noté comme preuve", async () => {
    users.inconnu = { email: "mere@example.test", emailConfirmed: false };
    const res = await account("/links", { method: "POST", as: "inconnu", body: { licencieId: LINA } });
    expect((await json<{ status: string }>(res)).status).toBe("active");
    expect(state.accountLinks[0]!.source).toBe("request");
  });

  it("lien personnel valide du même licencié : actif ; celui d'un autre : refusé", async () => {
    state.publicTokens.push({ id: "tok-hugo", club_id: CLUB_A.id, licencie_id: HUGO, token_hash: hashPublicToken("hugo-token-123456"), email: null, revoked_at: null } as never);
    const ok = await account("/links", { method: "POST", as: "pere", body: { licencieId: HUGO, personalLinkToken: "hugo-token-123456" } });
    expect((await json<{ status: string }>(ok)).status).toBe("active");
    const ko = await account("/links", { method: "POST", as: "pere", body: { licencieId: LINA, personalLinkToken: "hugo-token-123456" } });
    expect(ko.status).toBe(403);
  });

  it("licencié d'un autre club : introuvable", async () => {
    const res = await account("/links", { method: "POST", as: "mere", body: { licencieId: OTHER_CLUB_KID } });
    expect(res.status).toBe(404);
  });

  it("sans compte : 401 ; jeton invalide : 401", async () => {
    expect((await account("/links", { method: "POST", body: { licencieId: LINA } })).status).toBe(401);
    expect((await account("", { as: "fantome" })).status).toBe(401);
  });

  it("une nouvelle demande ne fait jamais redescendre un lien actif", async () => {
    await account("/links", { method: "POST", as: "mere", body: { licencieId: LINA } });
    users.mere.emailConfirmed = false;
    const again = await account("/links", { method: "POST", as: "mere", body: { licencieId: LINA } });
    expect((await json<{ status: string }>(again)).status).toBe("active");
  });
});

describe("droits : le compte agit pour ses licenciés ACTIFS seulement", () => {
  it("aucun lien : NO_LINKED_LICENCIE ; en attente : pas encore de droits", async () => {
    await expect(licencieFromRequest(req({ authorization: "Bearer jwt-pere" }), buildFakeClubSupabase(state), CLUB_A.id)).rejects.toMatchObject({ code: "NO_LINKED_LICENCIE" });
    state.accountLinks.push({ id: "l-pending", club_id: CLUB_A.id, user_id: "pere", licencie_id: LINA, status: "pending", source: "request" });
    await expect(licencieFromRequest(req({ authorization: "Bearer jwt-pere" }), buildFakeClubSupabase(state), CLUB_A.id)).rejects.toMatchObject({ status: 403 });
  });

  it("X-BM-As choisit parmi ses licenciés, jamais un autre", async () => {
    await account("/links", { method: "POST", as: "mere", body: { licencieId: LINA } });
    const db = buildFakeClubSupabase(state);
    expect((await licencieFromRequest(req({ authorization: "Bearer jwt-mere" }), db, CLUB_A.id)).id).toBe(LINA);
    expect((await licencieFromRequest(req({ authorization: "Bearer jwt-mere", "x-bm-as": LINA }), db, CLUB_A.id)).id).toBe(LINA);
    await expect(licencieFromRequest(req({ authorization: "Bearer jwt-mere", "x-bm-as": HUGO }), db, CLUB_A.id)).rejects.toMatchObject({ code: "NOT_LINKED" });
  });

  it("le lien d'un club ne donne aucun droit dans un autre", async () => {
    await account("/links", { method: "POST", as: "mere", body: { licencieId: LINA } });
    await expect(licencieFromRequest(req({ authorization: "Bearer jwt-mere" }), buildFakeClubSupabase(state), CLUB_B.id)).rejects.toMatchObject({ code: "NO_LINKED_LICENCIE" });
  });
});

describe("invitation d'un proche", () => {
  it("la mère invite le père : actif, usage unique", async () => {
    await account("/links", { method: "POST", as: "mere", body: { licencieId: LINA } });
    const created = await account("/invites", { method: "POST", as: "mere", body: { licencieId: LINA } });
    expect(created.status).toBe(201);
    const invite = await json<{ code: string; url: string }>(created);
    expect(invite.url).toContain(`/public/club-a/invitation#${invite.code}`);
    expect(state.accountInvites[0]!.code_hash).not.toBe(invite.code);

    const accepted = await account("/invites/accept", { method: "POST", as: "pere", body: { code: invite.code } });
    expect(accepted.status).toBe(200);
    expect((await json<{ people: { licencieId: string; status: string }[] }>(accepted)).people).toEqual([expect.objectContaining({ licencieId: LINA, status: "active" })]);

    users.oncle = { email: "oncle@example.test", emailConfirmed: true };
    const again = await account("/invites/accept", { method: "POST", as: "oncle", body: { code: invite.code } });
    expect(again.status).toBe(400);
  });

  it("seul un compte ACTIF sur le licencié peut inviter", async () => {
    state.accountLinks.push({ id: "l-pending", club_id: CLUB_A.id, user_id: "pere", licencie_id: LINA, status: "pending", source: "request" });
    const res = await account("/invites", { method: "POST", as: "pere", body: { licencieId: LINA } });
    expect(res.status).toBe(403);
  });
});

describe("administration : comptes rattachés", () => {
  const admin = (path: string, init: Parameters<typeof call>[1] = {}) => call(`/v1/clubs/${CLUB_A.id}/account-links${path}`, { as: "admin", ...init });
  const linkId = async () => (await json<{ links: { id: string }[] }>(await admin(""))).links[0]!.id;

  it("l'admin voit les comptes rattachés", async () => {
    await account("/links", { method: "POST", as: "pere", body: { licencieId: LINA } });
    const list = await json<{ links: { email: string; firstName: string; status: string }[] }>(await admin("?status=active"));
    expect(list.links).toEqual([expect.objectContaining({ email: "pere@example.test", firstName: "Lina", status: "active" })]);
  });

  it("retirer un rattachement coupe l'accès et bloque une nouvelle demande", async () => {
    await account("/links", { method: "POST", as: "pere", body: { licencieId: LINA } });
    expect((await admin(`/${await linkId()}`, { method: "DELETE" })).status).toBe(204);
    expect(state.accountLinks[0]!.status).toBe("refused");
    await expect(licencieFromRequest(req({ authorization: "Bearer jwt-pere" }), buildFakeClubSupabase(state), CLUB_A.id)).rejects.toBeTruthy();
    const again = await account("/links", { method: "POST", as: "pere", body: { licencieId: LINA } });
    expect(again.status).toBe(403);
    // L'admin peut le rétablir.
    expect((await admin(`/${state.accountLinks[0]!.id}/accept`, { method: "POST" })).status).toBe(204);
    expect(state.accountLinks[0]!.status).toBe("active");
  });

  it("retirer le compte : liens coupés, jetons effacés, compte supprimé s'il ne suit personne ailleurs", async () => {
    await account("/links", { method: "POST", as: "pere", body: { licencieId: LINA } });
    await account("/links", { method: "POST", as: "pere", body: { licencieId: HUGO } });
    await account("/push-token", { method: "PUT", as: "pere", body: { token: "c".repeat(64), environment: "production" } });
    const res = await admin(`/${await linkId()}/remove-account`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await json<{ accountDeleted: boolean }>(res)).toEqual({ accountDeleted: true });
    expect(state.deletedAuthUsers).toEqual(["pere"]);
  });

  it("retirer le compte : il reste s'il suit quelqu'un dans un autre club", async () => {
    await account("/links", { method: "POST", as: "pere", body: { licencieId: LINA } });
    state.accountLinks.push({ id: "66666666-6666-4666-8666-000000000002", club_id: CLUB_B.id, user_id: "pere", licencie_id: OTHER_CLUB_KID, status: "active", source: "request" });
    const res = await admin(`/${state.accountLinks[0]!.id}/remove-account`, { method: "POST" });
    expect(await json<{ accountDeleted: boolean }>(res)).toEqual({ accountDeleted: false });
    expect(state.deletedAuthUsers).toEqual([]);
    expect(state.accountLinks.map((l) => `${l.club_id === CLUB_A.id ? "A" : "B"}:${l.status}`)).toEqual(["A:refused", "B:active"]);
  });

  it("un compte membre du club (staff) n'est jamais supprimé par cette voie", async () => {
    state.accountLinks.push({ id: "66666666-6666-4666-8666-000000000003", club_id: CLUB_A.id, user_id: "admin", licencie_id: LINA, status: "active", source: "request" });
    users.coach = { email: "coach@example.test", emailConfirmed: true };
    state.memberships.push({ id: "55555555-5555-4555-8555-00000000000b", club_id: CLUB_A.id, user_id: "coach", status: "active" } as never);
    state.accountLinks.push({ id: "66666666-6666-4666-8666-000000000004", club_id: CLUB_A.id, user_id: "coach", licencie_id: HUGO, status: "active", source: "request" });
    expect((await admin("/66666666-6666-4666-8666-000000000003/remove-account", { method: "POST" })).status).toBe(400);
    const res = await admin("/66666666-6666-4666-8666-000000000004/remove-account", { method: "POST" });
    expect(await json<{ accountDeleted: boolean }>(res)).toEqual({ accountDeleted: false });
    expect(state.deletedAuthUsers).toEqual([]);
  });

  it("refus d'une ancienne demande en attente : le compte n'a pas de droits", async () => {
    state.accountLinks.push({ id: "66666666-6666-4666-8666-000000000005", club_id: CLUB_A.id, user_id: "pere", licencie_id: LINA, status: "pending", source: "request" });
    expect((await admin("/66666666-6666-4666-8666-000000000005/refuse", { method: "POST" })).status).toBe(204);
    expect(state.accountLinks[0]!.status).toBe("refused");
  });

  it("un compte sans rôle admin n'y a pas accès", async () => {
    const res = await call(`/v1/clubs/${CLUB_A.id}/account-links`, { as: "pere" });
    expect([403, 404]).toContain(res.status);
  });

  it("un lien d'un autre club est introuvable", async () => {
    state.accountLinks.push({ id: "66666666-6666-4666-8666-000000000001", club_id: CLUB_B.id, user_id: "pere", licencie_id: OTHER_CLUB_KID, status: "active", source: "request" });
    expect((await admin("/66666666-6666-4666-8666-000000000001/remove-account", { method: "POST" })).status).toBe(404);
    expect((await admin("/66666666-6666-4666-8666-000000000001", { method: "DELETE" })).status).toBe(404);
  });
});

describe("suppression du compte et notifications", () => {
  it("supprime le compte, ses liens et ses jetons ; les autres comptes restent", async () => {
    await account("/links", { method: "POST", as: "mere", body: { licencieId: LINA } });
    state.accountLinks.push({ id: "l2", club_id: CLUB_A.id, user_id: "pere", licencie_id: LINA, status: "active", source: "admin" });
    const token = "a".repeat(64);
    expect((await account("/push-token", { method: "PUT", as: "mere", body: { token, environment: "production" } })).status).toBe(204);
    expect(await pushTargets(buildFakeClubSupabase(state), CLUB_A.id, [LINA])).toEqual([{ token, environment: "production" }]);

    expect((await account("", { method: "DELETE", as: "mere" })).status).toBe(204);
    expect(state.deletedAuthUsers).toEqual(["mere"]);
    expect(state.accountLinks.map((l) => l.user_id)).toEqual(["pere"]);
    expect(await pushTargets(buildFakeClubSupabase(state), CLUB_A.id, [LINA])).toEqual([]);
  });

  it("un compte administrateur du club ne se supprime pas depuis l'espace licencié", async () => {
    const res = await account("", { method: "DELETE", as: "admin" });
    expect(res.status).toBe(403);
    expect(state.deletedAuthUsers).toEqual([]);
  });

  it("un jeton push d'un lien EN ATTENTE ne reçoit rien", async () => {
    state.accountLinks.push({ id: "l-pending", club_id: CLUB_A.id, user_id: "pere", licencie_id: LINA, status: "pending", source: "request" });
    await account("/push-token", { method: "PUT", as: "pere", body: { token: "b".repeat(64), environment: "production" } });
    expect(await pushTargets(buildFakeClubSupabase(state), CLUB_A.id, [LINA])).toEqual([]);
  });
});
