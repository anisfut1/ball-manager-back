import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";

let state: FakeClubSupabaseState;
let currentUserId = "admin";

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return { ...actual, verifyAccessToken: vi.fn(async () => ({ id: currentUserId, email: `${currentUserId}@example.test` })) };
});

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

const CLUB_A = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };
const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", ffbb_club_id: "B1" };
const TEAM_U15F = "11111111-1111-4111-8111-000000000015";
const TEAM_B = "11111111-1111-4111-8111-0000000000bb";
const M_ADMIN = "44444444-4444-4444-8444-00000000000a";
const M_ANIS = "44444444-4444-4444-8444-00000000000b";

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}/members${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: "Bearer test-jwt", "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  currentUserId = "admin";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    teams: [
      { id: TEAM_U15F, club_id: CLUB_A.id, name: "U15", sexe: "F", active: true },
      { id: TEAM_B, club_id: CLUB_B.id, name: "U15", sexe: "F", active: true },
    ],
    memberships: [
      { id: M_ADMIN, club_id: CLUB_A.id, user_id: "admin", status: "active" },
      { id: M_ANIS, club_id: CLUB_A.id, user_id: "anis", status: "active" },
    ],
    roles: [
      { membership_id: M_ADMIN, role: "club_admin", scope_team_id: null },
      { membership_id: M_ANIS, role: "joueur", scope_team_id: null },
    ],
    profiles: [{ user_id: "anis", display_name: "Anis" }],
  });
});

describe("membres & rôles (club_admin)", () => {
  it("liste les membres avec leurs rôles et portées", async () => {
    const res = await request("");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { members: { membershipId: string; displayName: string | null; roles: unknown[]; isMe: boolean }[] };
    expect(body.members.find((m) => m.membershipId === M_ANIS)).toMatchObject({ displayName: "Anis", roles: [{ role: "joueur", scopeTeamId: null }], isMe: false });
  });

  it("nomme Anis coach U15F et coordinateur (remplacement complet des rôles)", async () => {
    const res = await request(`/${M_ANIS}/roles`, { method: "PUT", body: { roles: [{ role: "coach", scopeTeamId: TEAM_U15F }, { role: "correspondant_club", scopeTeamId: null }] } });
    expect(res.status).toBe(200);
    expect(state.roles.filter((r) => r.membership_id === M_ANIS).map((r) => [r.role, r.scope_team_id])).toEqual([
      ["coach", TEAM_U15F],
      ["correspondant_club", null],
    ]);
  });

  it("refuse une équipe d'un autre club et le retrait de son propre rôle d'administrateur", async () => {
    const otherClubTeam = await request(`/${M_ANIS}/roles`, { method: "PUT", body: { roles: [{ role: "coach", scopeTeamId: TEAM_B }] } });
    expect(otherClubTeam.status).toBe(400);
    const selfDemote = await request(`/${M_ADMIN}/roles`, { method: "PUT", body: { roles: [{ role: "coach", scopeTeamId: null }] } });
    expect(selfDemote.status).toBe(409);
  });

  it("réservé au club_admin : un coach reçoit 403", async () => {
    currentUserId = "anis";
    expect((await request("")).status).toBe(403);
  });
});

describe("gymnases du club", () => {
  it("lecture pour tout membre, modification réservée au club_admin", async () => {
    state.clubVenues = [{ id: "55555555-5555-4555-8555-000000000001", club_id: CLUB_A.id, name: "GYMNASE A", address: null, venue_id: "v", active: true, sort_order: 0 }];
    currentUserId = "anis";
    const list = await app.request(`/v1/clubs/${CLUB_A.id}/venues`, { headers: { authorization: "Bearer test-jwt" } });
    expect(list.status).toBe(200);
    const patchAsMember = await app.request(`/v1/clubs/${CLUB_A.id}/venues/55555555-5555-4555-8555-000000000001`, { method: "PATCH", headers: { authorization: "Bearer test-jwt", "content-type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect(patchAsMember.status).toBe(403);
    currentUserId = "admin";
    const patch = await app.request(`/v1/clubs/${CLUB_A.id}/venues/55555555-5555-4555-8555-000000000001`, { method: "PATCH", headers: { authorization: "Bearer test-jwt", "content-type": "application/json" }, body: JSON.stringify({ active: false, name: "Gymnase Maurice Clavel" }) });
    expect(patch.status).toBe(200);
    expect(state.clubVenues[0]).toMatchObject({ active: false, name: "Gymnase Maurice Clavel" });
  });

  it("indisponibilités : ajout par le club_admin, conflits avec match à domicile et entraînement, suppression", async () => {
    const VENUE = "55555555-5555-4555-8555-000000000001";
    state.clubVenues = [{ id: VENUE, club_id: CLUB_A.id, name: "COMPLEXE SPORTIF DU LIDO", address: null, venue_id: "ffbb-lido", active: true, sort_order: 0 }];
    state.matches = [
      { id: "66666666-6666-4666-8666-000000000001", club_id: CLUB_A.id, team_id: TEAM_U15F, opponent_name: "Montpellier", match_datetime: "2099-11-07T10:00:00Z", venue_id: "ffbb-lido", venue_raw_label: null, is_home: true, status: "scheduled" },
      { id: "66666666-6666-4666-8666-000000000002", club_id: CLUB_A.id, team_id: TEAM_U15F, opponent_name: "Agde", match_datetime: "2099-11-07T10:00:00Z", venue_id: "ffbb-agde", venue_raw_label: null, is_home: false, status: "scheduled" },
    ] as never;
    state.trainingOccurrences = [{ id: "77777777-7777-4777-8777-000000000001", club_id: CLUB_A.id, team_id: TEAM_U15F, starts_at: "2099-11-07T17:00:00Z", ends_at: "2099-11-07T18:30:00Z", club_venue_id: VENUE, status: "scheduled" }];
    const body = { clubVenueId: VENUE, startDate: "2099-11-07", endDate: "2099-11-07", period: "afternoon", reason: "Tournoi de handball" };
    const post = (as: string) => {
      currentUserId = as;
      return app.request(`/v1/clubs/${CLUB_A.id}/venues/closures`, { method: "POST", headers: { authorization: "Bearer test-jwt", "content-type": "application/json" }, body: JSON.stringify(body) });
    };

    expect((await post("anis")).status).toBe(403);
    const created = await post("admin");
    expect(created.status).toBe(201);
    const { closure } = (await created.json()) as { closure: { id: string; conflicts: { kind: string; teamName: string | null }[] } };
    // Après-midi fermé : l'entraînement de 18 h est en conflit ; le match de 11 h (matin) et le match à l'extérieur non.
    expect(closure).toMatchObject({ venueName: "COMPLEXE SPORTIF DU LIDO", period: "afternoon", reason: "Tournoi de handball", conflicts: [{ kind: "TRAINING", teamName: "U15" }] });

    currentUserId = "anis";
    const list = await app.request(`/v1/clubs/${CLUB_A.id}/venues/closures`, { headers: { authorization: "Bearer test-jwt" } });
    expect(((await list.json()) as { closures: unknown[] }).closures).toHaveLength(1);

    currentUserId = "admin";
    const del = await app.request(`/v1/clubs/${CLUB_A.id}/venues/closures/${closure.id}`, { method: "DELETE", headers: { authorization: "Bearer test-jwt" } });
    expect(del.status).toBe(200);
    expect(state.venueClosures).toHaveLength(0);
  });

  it("indisponibilité : journée entière en conflit avec le match à domicile ; dates incohérentes refusées", async () => {
    const VENUE = "55555555-5555-4555-8555-000000000001";
    state.clubVenues = [{ id: VENUE, club_id: CLUB_A.id, name: "COMPLEXE SPORTIF DU LIDO", address: null, venue_id: "ffbb-lido", active: true, sort_order: 0 }];
    state.matches = [{ id: "66666666-6666-4666-8666-000000000001", club_id: CLUB_A.id, team_id: TEAM_U15F, opponent_name: "Montpellier", match_datetime: "2099-11-07T10:00:00Z", venue_id: "ffbb-lido", venue_raw_label: null, is_home: true, status: "scheduled" }] as never;
    const send = (payload: unknown) => app.request(`/v1/clubs/${CLUB_A.id}/venues/closures`, { method: "POST", headers: { authorization: "Bearer test-jwt", "content-type": "application/json" }, body: JSON.stringify(payload) });
    const res = await send({ clubVenueId: VENUE, startDate: "2099-11-06", endDate: "2099-11-08" });
    expect(((await res.json()) as { closure: unknown }).closure).toMatchObject({ period: "day", conflicts: [{ kind: "MATCH", opponentName: "Montpellier" }] });
    expect((await send({ clubVenueId: VENUE, startDate: "2099-11-08", endDate: "2099-11-06" })).status).toBe(400);
  });
});
