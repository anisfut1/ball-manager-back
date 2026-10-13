import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";
import { hashPublicToken } from "../public-tables/token.js";
import { encryptPublicToken } from "../public-tables/personal-link.js";
import { generateSessionSecret, isValidCodeVerifier, looksLikeSessionSecret, s256Challenge, verifyPkce } from "./secrets.js";
import { createAuthCode, LOGIN_LINK_CODE_TTL_MS, moveGrantsToToken, sanitizeRedirectPath } from "./service.js";

/**
 * App iOS — sessions d'appareil dérivées du lien personnel et codes
 * d'autorisation PKCE (docs/MOBILE_AUTH.md). Données fictives.
 */
let state: FakeClubSupabaseState;

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

const CLUB_A = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };
const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", name: "Club B", ffbb_club_id: "B1" };
const U15 = "11111111-1111-4111-8111-000000000015";
const LINA = "44444444-4444-4444-8444-000000000001";
const HUGO = "44444444-4444-4444-8444-000000000002";
const EMMA = "44444444-4444-4444-8444-000000000003";

function lic(id: string, firstName: string): FakeLicencieRow {
  return { id, club_id: CLUB_A.id, first_name: firstName, last_name: "MARTIN", license_number: null, birth_date: "2012-01-01", email: null, phone: null, photo_url: null, active: true, team_id: U15 } as FakeLicencieRow;
}

const pub = (slug: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.request(`/v1/public/clubs/${slug}${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
const json = async <T>(res: Response) => (await res.json()) as T;
const bearer = (secret: string, as?: string) => ({ authorization: `Bearer ${secret}`, ...(as ? { "x-bm-as": as } : {}) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T08:00:00.000Z"));
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    teams: [{ id: U15, club_id: CLUB_A.id, name: "U15", sexe: "F", active: true }],
    licencies: [lic(LINA, "Lina"), lic(HUGO, "Hugo"), lic(EMMA, "Emma")],
  });
  state.publicTokens = (
    [
      ["lina", LINA],
      ["hugo", HUGO],
      ["emma", EMMA],
    ] as const
  ).map(([k, id]) => ({ id: `tok-${k}`, club_id: CLUB_A.id, licencie_id: id, token_hash: hashPublicToken(`token-${k}-0000`), token_ciphertext: encryptPublicToken(`token-${k}-0000`, CLUB_A.id, id), email: `${k}@example.test`, created_at: "2026-10-01T00:00:00Z", revoked_at: null, revoked_by: null }));
});
afterEach(() => vi.useRealTimers());

async function bootstrap(tokens: string[] = ["token-lina-0000"]) {
  const res = await pub("club-a", "/auth/device-sessions", { method: "POST", body: { tokens, platform: "ios", appVersion: "1.0.0" } });
  expect(res.status).toBe(201);
  return json<{ sessionSecret: string; people: { licencieId: string; firstName: string }[] }>(res);
}

describe("secrets", () => {
  it("session : bmd_ + 32 octets ; PKCE S256 uniquement", () => {
    expect(looksLikeSessionSecret(generateSessionSecret())).toBe(true);
    expect(looksLikeSessionSecret("token-lina-0000")).toBe(false);
    const verifier = "a".repeat(43);
    expect(isValidCodeVerifier(verifier)).toBe(true);
    expect(verifyPkce(verifier, s256Challenge(verifier))).toBe(true);
    expect(verifyPkce("b".repeat(43), s256Challenge(verifier))).toBe(false);
    expect(verifyPkce(verifier, verifier.slice(0, 43))).toBe(false);
  });

  it("destination après connexion : chemin interne /public seulement", () => {
    expect(sanitizeRedirectPath("/public/club-a/matchs/123")).toBe("/public/club-a/matchs/123");
    expect(sanitizeRedirectPath("https://evil.example/x")).toBeNull();
    expect(sanitizeRedirectPath("//evil.example")).toBeNull();
    expect(sanitizeRedirectPath("/c/club-a/admin")).toBeNull();
    expect(sanitizeRedirectPath("/public/club-a/../c")).toBeNull();
  });
});

describe("session d'appareil (amorçage par lien personnel)", () => {
  it("le lien personnel devient une session ; l'app n'a plus besoin du jeton", async () => {
    const session = await bootstrap();
    expect(session.people.map((p) => p.firstName)).toEqual(["Lina"]);
    expect(state.deviceSessions[0]!.secret_hash).not.toBe(session.sessionSecret);

    const me = await json<{ licencie: { firstName: string } }>(await pub("club-a", "/me", { headers: bearer(session.sessionSecret) }));
    expect(me.licencie.firstName).toBe("Lina");
  });

  it("jeton invalide : 401, aucune session créée", async () => {
    const res = await pub("club-a", "/auth/device-sessions", { method: "POST", body: { tokens: ["token-inconnu-00"], platform: "ios" } });
    expect(res.status).toBe(401);
    expect(state.deviceSessions).toHaveLength(0);
  });

  it("plusieurs enfants : X-BM-As choisit la personne, jamais une personne hors session", async () => {
    const session = await bootstrap(["token-lina-0000", "token-hugo-0000"]);
    const hugo = await json<{ licencie: { firstName: string } }>(await pub("club-a", "/me", { headers: bearer(session.sessionSecret, HUGO) }));
    expect(hugo.licencie.firstName).toBe("Hugo");
    const emma = await pub("club-a", "/me", { headers: bearer(session.sessionSecret, EMMA) });
    expect(emma.status).toBe(403);
  });

  it("isolation : une session du club A ne vaut rien sur le club B", async () => {
    const session = await bootstrap();
    expect((await pub("club-b", "/me", { headers: bearer(session.sessionSecret) })).status).toBe(401);
  });

  it("lien réinitialisé par un admin : l'app perd l'accès ; « lien perdu ? » vers la même adresse : l'app garde l'accès", async () => {
    const session = await bootstrap();
    // Rotation par le propriétaire : les droits passent sur le nouveau jeton.
    state.publicTokens.push({ ...state.publicTokens[0]!, id: "tok-lina-2", token_hash: hashPublicToken("token-lina-2222") });
    state.publicTokens[0]!.revoked_at = "2026-10-11T09:00:00Z";
    await moveGrantsToToken(buildFakeClubSupabase(state) as never, "tok-lina", "tok-lina-2");
    expect((await pub("club-a", "/me", { headers: bearer(session.sessionSecret) })).status).toBe(200);
    // Réinitialisation admin : jeton révoqué sans transfert.
    state.publicTokens.find((t) => t.id === "tok-lina-2")!.revoked_at = "2026-10-11T10:00:00Z";
    const res = await pub("club-a", "/me", { headers: bearer(session.sessionSecret) });
    expect(res.status).toBe(401);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("SESSION_INVALID");
  });

  it("déconnexion : la session ne sert plus", async () => {
    const session = await bootstrap();
    expect((await pub("club-a", "/auth/session", { method: "DELETE", headers: bearer(session.sessionSecret) })).status).toBe(204);
    expect((await pub("club-a", "/me", { headers: bearer(session.sessionSecret) })).status).toBe(401);
  });

  it("expiration après 180 jours sans usage", async () => {
    const session = await bootstrap();
    vi.setSystemTime(new Date("2027-04-20T08:00:00.000Z"));
    expect((await pub("club-a", "/me", { headers: bearer(session.sessionSecret) })).status).toBe(401);
  });

  it("ajouter / retirer un enfant sur l'appareil", async () => {
    const session = await bootstrap();
    const added = await json<{ people: { firstName: string }[] }>(await pub("club-a", "/auth/session/people", { method: "POST", headers: bearer(session.sessionSecret), body: { tokens: ["token-hugo-0000"] } }));
    expect(added.people.map((p) => p.firstName).sort()).toEqual(["Hugo", "Lina"]);
    expect((await pub("club-a", `/auth/session/people/${HUGO}`, { method: "DELETE", headers: bearer(session.sessionSecret) })).status).toBe(204);
    expect((await pub("club-a", "/me", { headers: bearer(session.sessionSecret, HUGO) })).status).toBe(403);
  });

  it("accueil « À faire » : la session remplace les liens (`as:<licencieId>`), index conservés", async () => {
    const session = await bootstrap(["token-lina-0000", "token-hugo-0000"]);
    const res = await pub("club-a", "/team-life/action-center", { method: "POST", headers: bearer(session.sessionSecret), body: { tokens: [`as:${HUGO}`, `as:${EMMA}`, `as:${LINA}`] } });
    const body = await json<{ people: { tokenIndex: number; firstName: string }[]; invalidTokenIndexes: number[] }>(res);
    expect(body.people.map((p) => [p.tokenIndex, p.firstName])).toEqual([
      [0, "Hugo"],
      [2, "Lina"],
    ]);
    expect(body.invalidTokenIndexes).toEqual([1]);
  });

  it("le web reste inchangé : ?token= et l'en-tête X-Personal-Link-Token", async () => {
    expect((await pub("club-a", "/me?token=token-lina-0000")).status).toBe(200);
    expect((await pub("club-a", "/me", { headers: { "x-personal-link-token": "token-lina-0000" } })).status).toBe(200);
    expect((await pub("club-a", "/me")).status).toBe(400);
  });
});

describe("connexion depuis Safari (code d'autorisation + PKCE)", () => {
  const verifier = "v".repeat(20) + "-._~" + "w".repeat(30);

  async function code(redirectPath?: string) {
    const res = await pub("club-a", "/auth/codes", { method: "POST", body: { tokens: ["token-lina-0000"], codeChallenge: s256Challenge(verifier), codeChallengeMethod: "S256", redirectPath } });
    expect(res.status).toBe(201);
    return (await json<{ code: string }>(res)).code;
  }

  it("code + bon verifier → session ; destination d'origine conservée", async () => {
    const c = await code("/public/club-a/matchs/42");
    const res = await pub("club-a", "/auth/token", { method: "POST", body: { code: c, codeVerifier: verifier, platform: "ios" } });
    expect(res.status).toBe(201);
    const body = await json<{ sessionSecret: string; redirectPath: string }>(res);
    expect(looksLikeSessionSecret(body.sessionSecret)).toBe(true);
    expect(body.redirectPath).toBe("/public/club-a/matchs/42");
  });

  it("mauvais verifier, code réutilisé, code expiré, autre club : refusés", async () => {
    const c = await code();
    const wrong = await pub("club-a", "/auth/token", { method: "POST", body: { code: c, codeVerifier: "x".repeat(43), platform: "ios" } });
    expect((await json<{ error: { code: string } }>(wrong)).error.code).toBe("PKCE_FAILED");
    expect((await pub("club-a", "/auth/token", { method: "POST", body: { code: c, codeVerifier: verifier, platform: "ios" } })).status).toBe(201);
    const reused = await pub("club-a", "/auth/token", { method: "POST", body: { code: c, codeVerifier: verifier, platform: "ios" } });
    expect((await json<{ error: { code: string } }>(reused)).error.code).toBe("CODE_USED");

    const late = await code();
    vi.setSystemTime(new Date("2026-10-11T08:06:00.000Z"));
    const expired = await pub("club-a", "/auth/token", { method: "POST", body: { code: late, codeVerifier: verifier, platform: "ios" } });
    expect((await json<{ error: { code: string } }>(expired)).error.code).toBe("CODE_EXPIRED");

    vi.setSystemTime(new Date("2026-10-11T08:00:00.000Z"));
    const other = await code();
    expect((await pub("club-b", "/auth/token", { method: "POST", body: { code: other, codeVerifier: verifier, platform: "ios" } })).status).toBe(400);
  });

  it("PKCE obligatoire pour la connexion depuis Safari", async () => {
    const res = await pub("club-a", "/auth/codes", { method: "POST", body: { tokens: ["token-lina-0000"], codeChallengeMethod: "S256" } });
    expect(res.status).toBe(400);
  });
});

describe("lien de connexion par email (AUTH_LINK_CODES=1)", () => {
  it("web : le code donne les liens personnels de la session web ; usage unique ; le GET de la page ne consomme rien", async () => {
    const { code } = await createAuthCode(buildFakeClubSupabase(state) as never, CLUB_A.id, { purpose: "login_link", tokenIds: ["tok-lina"], redirectPath: "/public/club-a/accueil", ttlMs: LOGIN_LINK_CODE_TTL_MS });
    const first = await pub("club-a", "/auth/token", { method: "POST", body: { code, platform: "web" } });
    expect(await json(first)).toEqual({ tokens: ["token-lina-0000"], redirectPath: "/public/club-a/accueil" });
    const second = await pub("club-a", "/auth/token", { method: "POST", body: { code, platform: "web" } });
    expect((await json<{ error: { code: string } }>(second)).error.code).toBe("CODE_USED");
  });

  it("app : le même type de code ouvre une session d'appareil", async () => {
    const { code } = await createAuthCode(buildFakeClubSupabase(state) as never, CLUB_A.id, { purpose: "login_link", tokenIds: ["tok-hugo"], ttlMs: LOGIN_LINK_CODE_TTL_MS });
    const res = await pub("club-a", "/auth/token", { method: "POST", body: { code, platform: "ios" } });
    expect(res.status).toBe(201);
    expect((await json<{ people: { firstName: string }[] }>(res)).people.map((p) => p.firstName)).toEqual(["Hugo"]);
  });
});

describe("liste des clubs (choix du club dans l'app)", () => {
  it("clubs actifs : nom, slug, logo seulement", async () => {
    const res = await app.request("/v1/public/clubs");
    expect(await json(res)).toEqual({ clubs: [{ slug: "club-a", name: "Club A", logoUrl: null }, { slug: "club-b", name: "Club B", logoUrl: null }] });
  });
});
