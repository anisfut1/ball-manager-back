import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";
import { hashPublicToken } from "../public-tables/token.js";
import { encryptPublicToken } from "../public-tables/personal-link.js";

/**
 * DELETE /v1/public/clubs/{slug}/auth/me — suppression de l'accès de TOUTES
 * les personnes de la session d'appareil (docs/MOBILE_AUTH.md). Données fictives.
 */
let state: FakeClubSupabaseState;

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

const CLUB_A = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };
const LINA = "44444444-4444-4444-8444-000000000001";
const HUGO = "44444444-4444-4444-8444-000000000002";
const EMMA = "44444444-4444-4444-8444-000000000003";
const photo = (id: string) => `https://x.supabase.co/storage/v1/object/public/licencie-photos/${CLUB_A.id}/${id}/p.webp`;

function lic(id: string, firstName: string): FakeLicencieRow {
  return { id, club_id: CLUB_A.id, first_name: firstName, last_name: "MARTIN", license_number: `LIC-${firstName}`, birth_date: "2012-01-01", email: `sentinelle-${firstName.toLowerCase()}@example.invalid`, phone: "+33600000001", photo_url: photo(id), active: true, public_coach: true } as FakeLicencieRow;
}

const pub = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.request(`/v1/public/clubs/club-a${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function bootstrap(tokens: string[]) {
  const res = await pub("/auth/device-sessions", { method: "POST", body: { tokens, platform: "ios" } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionSecret: string }).sessionSecret;
}

const ofPerson = (id: string) =>
  JSON.stringify({ l: state.licencies.filter((x) => x.id === id), t: state.publicTokens.filter((x) => x.licencie_id === id), g: state.deviceSessionGrants.filter((x) => x.licencie_id === id) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T08:00:00.000Z"));
  state = makeFakeClubSupabaseState({ clubs: [{ ...CLUB_A }], licencies: [lic(LINA, "Lina"), lic(HUGO, "Hugo"), lic(EMMA, "Emma")] });
  state.publicTokens = ([["lina", LINA], ["hugo", HUGO], ["emma", EMMA]] as const).map(([k, id]) => ({
    id: `tok-${k}`,
    club_id: CLUB_A.id,
    licencie_id: id,
    token_hash: hashPublicToken(`token-${k}-0000`),
    token_ciphertext: encryptPublicToken(`token-${k}-0000`, CLUB_A.id, id),
    email: `${k}@example.test`,
    created_at: "2026-10-01T00:00:00Z",
    revoked_at: null,
    revoked_by: null,
  }));
});
afterEach(() => vi.useRealTimers());

describe("DELETE …/auth/me", () => {
  it("sans session : 401, rien n'est supprimé", async () => {
    const before = JSON.stringify(state.licencies) + JSON.stringify(state.publicTokens);
    expect((await pub("/auth/me", { method: "DELETE" })).status).toBe(401);
    // Un lien personnel (web) ne suffit pas : session d'appareil uniquement.
    expect((await pub("/auth/me", { method: "DELETE", headers: { "x-personal-link-token": "token-lina-0000" } })).status).toBe(401);
    expect(JSON.stringify(state.licencies) + JSON.stringify(state.publicTokens)).toBe(before);
  });

  it("session valide : 204, accès de toutes les personnes de la session supprimé, session ensuite refusée", async () => {
    const secret = await bootstrap(["token-lina-0000", "token-hugo-0000"]);

    const res = await pub("/auth/me", { method: "DELETE", headers: bearer(secret) });
    expect(res.status).toBe(204);

    for (const id of [LINA, HUGO]) {
      expect(state.publicTokens.some((t) => t.licencie_id === id)).toBe(false);
      expect(state.licencies.find((l) => l.id === id)).toMatchObject({ email: null, phone: null, photo_url: null, public_coach: false, license_number: expect.stringContaining("LIC-") });
    }
    expect(state.deviceSessions).toEqual([]);
    expect(state.storageRemovals.flatMap((r) => r.paths).sort()).toEqual([`${CLUB_A.id}/${HUGO}/p.webp`, `${CLUB_A.id}/${LINA}/p.webp`].sort());
    expect((await pub("/me", { headers: bearer(secret) })).status).toBe(401);
  });

  it("deuxième appel avec la session supprimée : 401, jamais 500", async () => {
    const secret = await bootstrap(["token-lina-0000"]);
    expect((await pub("/auth/me", { method: "DELETE", headers: bearer(secret) })).status).toBe(204);
    expect((await pub("/auth/me", { method: "DELETE", headers: bearer(secret) })).status).toBe(401);
  });

  it("un identifiant de licencié ou de club glissé dans le corps ou la requête est ignoré : le témoin reste inchangé", async () => {
    const secret = await bootstrap(["token-lina-0000"]);
    await bootstrap(["token-emma-0000"]);
    const emmaBefore = ofPerson(EMMA);

    const res = await pub(`/auth/me?licencieId=${EMMA}&clubId=${CLUB_A.id}`, { method: "DELETE", headers: bearer(secret), body: { licencieId: EMMA, licencieIds: [EMMA], clubId: CLUB_A.id } });

    expect(res.status).toBe(204);
    expect(ofPerson(EMMA)).toBe(emmaBefore);
    expect(state.licencies.find((l) => l.id === EMMA)!.email).toBe("sentinelle-emma@example.invalid");
    expect(state.deleteLicencieAccessCalls).toEqual([{ p_club_id: CLUB_A.id, p_licencie_ids: [LINA] }]);
    expect(state.licencies.find((l) => l.id === LINA)!.email).toBeNull();
  });

  it("transaction en échec : 500 et rien n'est supprimé (session et photos conservées)", async () => {
    const secret = await bootstrap(["token-lina-0000"]);
    state.deleteLicencieAccessFailure = "boom";

    expect((await pub("/auth/me", { method: "DELETE", headers: bearer(secret) })).status).toBe(500);

    expect(state.storageRemovals).toEqual([]);
    expect(state.licencies.find((l) => l.id === LINA)!.email).toBe("sentinelle-lina@example.invalid");
    expect((await pub("/auth/session", { headers: bearer(secret) })).status).toBe(200);
  });
});
