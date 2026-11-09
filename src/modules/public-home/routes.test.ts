import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeMatchRow } from "../../test-support/fake-club-supabase.js";
import { hashPublicToken } from "../public-tables/token.js";

let state: FakeClubSupabaseState;

vi.mock("../../db/client.js", () => ({
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

/**
 * Accueil personnel de l'espace public (retour du club, 2026-10-01) : le
 * joueur voit son équipe, le coach l'agenda de ses équipes coachées, chacun
 * ses tables de marque. Jamais les données d'un autre club.
 */
const CLUB_A = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };
const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", ffbb_club_id: "B1" };
const U15F = "11111111-1111-4111-8111-000000000015";
const U13M = "11111111-1111-4111-8111-000000000013";
const OTHER_CLUB_TEAM = "11111111-1111-4111-8111-0000000000bb";

const base: FakeMatchRow = { id: "m0", club_id: CLUB_A.id, numero: "1", journee: null, match_datetime: "2026-10-10T11:00:00Z", is_home: true, opponent_name: "ST ANDRE", venue_raw_label: "GYMNASE", score_home: null, score_away: null, status: "scheduled", emarque_status: "not_applicable", team_id: U15F };
const NEXT_U15F: FakeMatchRow = { ...base, id: "33333333-3333-4333-8333-000000000001" };
const NEXT_U13M: FakeMatchRow = { ...base, id: "33333333-3333-4333-8333-000000000002", team_id: U13M, match_datetime: "2026-10-04T08:00:00Z" };
const PAST_U15F: FakeMatchRow = { ...base, id: "33333333-3333-4333-8333-000000000003", match_datetime: "2026-09-20T13:00:00Z", status: "played", score_home: 60, score_away: 52 };
const OTHER_CLUB: FakeMatchRow = { ...base, id: "33333333-3333-4333-8333-000000000004", club_id: CLUB_B.id, team_id: OTHER_CLUB_TEAM };

function lic(id: string, first: string, extra: Record<string, unknown> = {}) {
  return { id, club_id: CLUB_A.id, first_name: first, last_name: "Test", license_number: null, birth_date: null, email: null, phone: null, photo_url: null, active: true, ...extra };
}

function token(licencieId: string, value: string) {
  state.publicTokens.push({ id: `t-${licencieId}`, club_id: CLUB_A.id, licencie_id: licencieId, token_hash: hashPublicToken(value), email: null, created_at: "2026-09-30T10:00:00Z", revoked_at: null, revoked_by: null });
}

const home = (t: string | null, slug = CLUB_A.slug) => app.request(`/v1/public/clubs/${slug}/home`, { headers: t ? { "x-personal-link-token": t } : {} });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T10:00:00.000Z"));
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    teams: [
      { id: U15F, club_id: CLUB_A.id, name: "U15", sexe: "F", active: true },
      { id: U13M, club_id: CLUB_A.id, name: "U13", sexe: "M", active: true },
      { id: OTHER_CLUB_TEAM, club_id: CLUB_B.id, name: "U15", sexe: "F", active: true },
    ],
    licencies: [lic("lic-player", "Léa", { team_id: U15F }), lic("lic-coach", "Karim", { public_coach: true, coached_team_ids: [U13M, U15F, OTHER_CLUB_TEAM] })],
    matches: [{ ...NEXT_U15F }, { ...NEXT_U13M }, { ...PAST_U15F }, { ...OTHER_CLUB }],
  });
  token("lic-player", "tok-player");
  token("lic-coach", "tok-coach");
  state.tableAssignments = [{ id: "a1", club_id: CLUB_A.id, match_id: NEXT_U15F.id, role: "SCORER", licencie_id: "lic-player", created_by: null }];
});

describe("GET /v1/public/clubs/:slug/home — accueil personnel", () => {
  it("joueur : son équipe, ses prochains matchs, ses résultats et sa table de marque", async () => {
    const res = await home("tok-player");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: { id: string; relation: string }[]; upcoming: { match: { id: string }; relations: string[] }[]; recentResults: { match: { id: string } }[]; tableDuties: { matchId: string; role: string }[]; roles: { coach: boolean } };
    expect(body.teams).toEqual([{ id: U15F, name: expect.any(String), relation: "PLAYER" }]);
    expect(body.upcoming.map((u) => [u.match.id, u.relations])).toEqual([[NEXT_U15F.id, ["PLAYER"]]]);
    expect(body.recentResults.map((r) => r.match.id)).toEqual([PAST_U15F.id]);
    expect(body.tableDuties).toEqual([expect.objectContaining({ matchId: NEXT_U15F.id, role: "SCORER" })]);
    expect(body.roles.coach).toBe(false);
  });

  it("coach : agenda de ses équipes coachées, triées par date ; équipe d'un autre club ignorée", async () => {
    const body = (await (await home("tok-coach")).json()) as { teams: { id: string; relation: string }[]; upcoming: { match: { id: string }; relations: string[] }[]; roles: { coach: boolean } };
    expect(body.roles.coach).toBe(true);
    expect(body.teams.map((t) => [t.id, t.relation]).sort()).toEqual([[U13M, "COACH"], [U15F, "COACH"]].sort());
    expect(body.upcoming.map((u) => u.match.id)).toEqual([NEXT_U13M.id, NEXT_U15F.id]);
    expect(body.upcoming.every((u) => u.relations.includes("COACH"))).toBe(true);
    expect(JSON.stringify(body)).not.toContain(OTHER_CLUB.id);
  });

  it("lien absent → 400, invalide → 401, lien d'un autre club → 401", async () => {
    expect((await home(null)).status).toBe(400);
    expect((await home("inconnu")).status).toBe(401);
    expect((await home("tok-player", CLUB_B.slug)).status).toBe(401);
  });
});
