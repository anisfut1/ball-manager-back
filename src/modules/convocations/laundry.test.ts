import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow, type FakeMatchRow } from "../../test-support/fake-club-supabase.js";
import { hashPublicToken } from "../public-tables/token.js";

/** Vie d'équipe — Lot 3 : lavage des maillots (§107 équité, §108 aucune écriture automatique). Données fictives. */
let state: FakeClubSupabaseState;

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return { ...actual, verifyAccessToken: vi.fn(async () => ({ id: "coach-u15", email: "coach@example.test" })) };
});
vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

const CLUB = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };
const U15 = "11111111-1111-4111-8111-000000000015";
const PREV = "33333333-3333-4333-8333-000000000001";
const NEXT = "33333333-3333-4333-8333-000000000002";
const ID = { a: "44444444-4444-4444-8444-00000000000a", b: "44444444-4444-4444-8444-00000000000b", c: "44444444-4444-4444-8444-00000000000c", senior: "44444444-4444-4444-8444-00000000000d" };

const lic = (id: string, first: string, last: string, birth: string): FakeLicencieRow =>
  ({ id, club_id: CLUB.id, first_name: first, last_name: last, license_number: null, birth_date: birth, email: null, phone: null, photo_url: null, active: true, team_id: U15 }) as FakeLicencieRow;
const match = (id: string, at: string): FakeMatchRow => ({ id, club_id: CLUB.id, numero: null, journee: null, match_datetime: at, is_home: true, opponent_name: "Agde", venue_raw_label: "Maurice Clavel", score_home: null, score_away: null, status: "scheduled", emarque_status: "not_applicable", team_id: U15, venue_id: null });

const club = (path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(`/v1/clubs/${CLUB.id}/team-life${path}`, { method: init.method ?? "GET", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
const pub = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  app.request(`/v1/public/clubs/club-a/team-life${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(init.token ? { "x-personal-link-token": init.token } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
const json = async <T>(r: Response) => (await r.json()) as T;

interface Suggestions {
  candidates: { licencie: { id: string }; label: string; seasonCount: number; status: string; repeat: boolean; suggested: boolean }[];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T08:00:00.000Z"));
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB }],
    teams: [{ id: U15, club_id: CLUB.id, name: "U15", sexe: "F", active: true }],
    memberships: [{ id: "m1", club_id: CLUB.id, user_id: "coach-u15", status: "active" }],
    roles: [{ membership_id: "m1", role: "coach", scope_team_id: U15 }],
    matches: [match(PREV, "2026-09-20T16:00:00.000Z"), match(NEXT, "2026-10-10T16:00:00.000Z")],
    licencies: [lic(ID.a, "Alice", "DUPONT", "2011-01-01"), lic(ID.b, "Bea", "MARTIN", "2011-01-01"), lic(ID.c, "Chloé", "LOPEZ", "2011-01-01"), lic(ID.senior, "Anis", "ABED", "1995-01-01")],
  });
  state.publicTokens = (["a", "b"] as const).map((k) => ({ id: `t-${k}`, club_id: CLUB.id, licencie_id: ID[k], token_hash: hashPublicToken(`token-${k}`), email: null, created_at: "2026-10-01T00:00:00Z", revoked_at: null, revoked_by: null }));
});
afterEach(() => vi.useRealTimers());

describe("Lavage des maillots", () => {
  it("§107 : à situation égale, moins de lavages cette saison d'abord ; libellés sans nom de famille inventé", async () => {
    // Alice a déjà lavé 3 fois cette saison (affectations RÉELLES), Bea jamais.
    for (const [i, at] of ["2026-09-01", "2026-09-08", "2026-09-15"].entries()) {
      const id = `33333333-3333-4333-8333-00000000010${i}`;
      state.matches.push(match(id, `${at}T16:00:00.000Z`));
      state.laundry.push({ id: `l${i}`, club_id: CLUB.id, match_id: id, team_id: U15, licencie_id: ID.a, seen_at: null });
    }
    const s = await json<Suggestions>(await club(`/matches/${NEXT}/laundry/suggestions`));
    const order = s.candidates.map((c) => c.licencie.id);
    expect(order.indexOf(ID.b)).toBeLessThan(order.indexOf(ID.a));
    expect(s.candidates.find((c) => c.licencie.id === ID.a)?.seasonCount).toBe(3);
    expect(s.candidates.find((c) => c.licencie.id === ID.b)?.label).toBe("Parent de Bea MARTIN");
    expect(s.candidates.find((c) => c.licencie.id === ID.senior)?.label).toBe("Anis ABED");
  });

  it("§108 : lire les suggestions ne crée aucune affectation ; le coach décide", async () => {
    await club(`/matches/${NEXT}/laundry/suggestions`);
    expect(state.laundry).toHaveLength(0);
    const r = await json<{ assignee: { label: string; seasonCount: number } }>(await club(`/matches/${NEXT}/laundry`, { method: "PUT", body: { licencieId: ID.b } }));
    expect(r.assignee).toMatchObject({ label: "Parent de Bea MARTIN", seasonCount: 1 });
    expect(state.laundry).toHaveLength(1);
  });

  it("§56 : convoqués confirmés en tête ; refus et non-convoqués jamais en tête ; même personne deux matchs de suite en dernier recours", async () => {
    state.laundry.push({ id: "prev", club_id: CLUB.id, match_id: PREV, team_id: U15, licencie_id: ID.c, seen_at: null });
    await club(`/matches/${NEXT}/convocation/draft`, { method: "PUT", body: { licencieIds: [ID.a, ID.b, ID.c], meetingAt: "2026-10-10T15:00:00.000Z" } });
    await club(`/matches/${NEXT}/convocation/send`, { method: "POST" });
    await pub(`/matches/${NEXT}/convocation/response`, { method: "PUT", token: "token-a", body: { response: "DECLINED" } });
    await pub(`/matches/${NEXT}/convocation/response`, { method: "PUT", token: "token-b", body: { response: "CONFIRMED" } });
    const s = await json<Suggestions>(await club(`/matches/${NEXT}/laundry/suggestions`));
    expect(s.candidates.map((c) => [c.licencie.id, c.status, c.suggested])).toEqual([
      [ID.b, "CONFIRMED", true],
      [ID.c, "CONVOKED", true],
      [ID.senior, "NOT_CONVOKED", false],
      [ID.a, "DECLINED", false],
    ]);
    expect(s.candidates.find((c) => c.licencie.id === ID.c)?.repeat).toBe(true);
  });

  it("§63/§64 : Home de la famille désignée + « J'ai vu » ; ligne dans SA convocation seulement", async () => {
    await club(`/matches/${NEXT}/laundry`, { method: "PUT", body: { licencieId: ID.b } });
    await club(`/matches/${NEXT}/convocation/draft`, { method: "PUT", body: { licencieIds: [ID.a, ID.b], meetingAt: "2026-10-10T15:00:00.000Z" } });
    await club(`/matches/${NEXT}/convocation/send`, { method: "POST" });
    const msg = (id: string) => String(state.convocationDispatches.find((d) => d.licencie_id === id)?.rendered_message);
    expect(msg(ID.b)).toContain("Vous êtes en charge du lavage des maillots après le match.");
    expect(msg(ID.a)).not.toContain("Maillots");

    const home = await json<{ actions: { type: string; seenAt?: string | null }[] }>(await pub("/action-center", { method: "POST", body: { tokens: ["token-b"] } }));
    expect(home.actions.find((a) => a.type === "LAUNDRY_DUTY")?.seenAt).toBeNull();
    expect((await pub(`/matches/${NEXT}/laundry/seen`, { method: "POST", token: "token-a" })).status).toBe(403);
    expect((await pub(`/matches/${NEXT}/laundry/seen`, { method: "POST", token: "token-b" })).status).toBe(200);
    const after = await json<{ actions: { type: string; seenAt?: string | null }[] }>(await pub("/action-center", { method: "POST", body: { tokens: ["token-b"] } }));
    expect(after.actions.find((a) => a.type === "LAUNDRY_DUTY")?.seenAt).not.toBeNull();
  });
});
