import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";

let state: FakeClubSupabaseState;
const currentUserId = "user-a";

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

const CLUB_A = {
  id: "aaaaaaaa-0000-0000-0000-000000000000",
  slug: "club-a",
  name: "Club A Basket",
  short_name: null,
  logo_url: null,
  accent_color: null,
  timezone: "Europe/Paris",
  status: "active" as const,
  ffbb_club_id: "AAA0000001",
  ffbb_enabled: true,
  ffbb_next_sync_at: null,
};

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs${path}`, { ...init, headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers } });
}

beforeEach(() => {
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }],
    memberships: [{ id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" }],
    roles: [{ membership_id: "membership-a1", role: "club_admin" }],
  });
});


// Horloge figée (seul `Date` est simulé) — correction automatique du 27/09/2026 : "récente" uniquement si l'horloge est figée juste après ; sans ça ces tests
// échouent dès que la date réelle dépasse celle des fixtures.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T08:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

describe("GET /:clubId/issues", () => {
  it("renvoie les anomalies e-Marque (emarque_status en erreur/à vérifier), comme avant l'ajout du rapprochement FBI", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "42",
        journee: null,
        match_datetime: "2026-09-26T13:30:00.000Z",
        is_home: true,
        opponent_name: "Adversaire",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "played",
        emarque_status: "needs_review",
        team_id: null,
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({
      matchId: "match-1",
      integration: "emarque",
      type: "emarque_needs_review",
      severity: "warning",
    });
  });

  it("renvoie une anomalie de rapprochement calendrier FBI enrichie des infos du match FFBB correspondant", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "3",
        journee: null,
        match_datetime: "2026-09-26T11:30:00.000Z",
        is_home: true,
        opponent_name: "Frontignan",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
      },
    ];
    state.fbiScheduleDiscrepancies = [
      {
        id: "disc-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        division_code: "BU13MN23",
        numero: "3",
        kind: "mismatch",
        field_name: "match_datetime",
        ffbb_value: "26/09/2026 13:30",
        fbi_value: "27/09/2026 15:00",
        fbi_opponent_name: "Frontignan",
        detected_at: "2026-09-25T10:00:00.000Z",
        resolved_at: null,
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({
      matchId: "match-1",
      opponentName: "Frontignan",
      matchDatetime: "2026-09-26T11:30:00.000Z",
      integration: "fbi_schedule",
      type: "fbi_schedule_mismatch",
      severity: "warning",
      technicalCode: "FBI_SCHEDULE_MISMATCH",
    });
    expect(body.issues[0].message).toContain("26/09/2026 13:30");
    expect(body.issues[0].message).toContain("27/09/2026 15:00");
  });

  it("n'affiche plus les rencontres vues d'un seul côté FBI/FFBB (retour du club : « elles servent à rien »)", async () => {
    state.fbiScheduleDiscrepancies = [
      {
        id: "disc-2",
        club_id: CLUB_A.id,
        match_id: null,
        division_code: "BU11FN2",
        numero: "12",
        kind: "missing_in_ffbb",
        field_name: null,
        ffbb_value: null,
        fbi_value: "SC Sète – Agde",
        fbi_opponent_name: "SC Sète – Agde",
        detected_at: "2026-09-25T10:00:00.000Z",
        resolved_at: null,
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    const body = await res.json();

    expect(body.issues).toEqual([]);
  });

  it("affiche une anomalie mismatch récemment corrigée automatiquement (FBI l'emporte sur FFBB, demande du club 2026-09-27), au passé et status auto_corrected", async () => {
    state.matches = [
      {
        id: "match-1",
        club_id: CLUB_A.id,
        numero: "3",
        journee: null,
        // Déjà corrigée avec la valeur FBI par processReconcileScheduleJob.
        match_datetime: "2026-09-27T13:00:00.000Z",
        is_home: true,
        opponent_name: "Frontignan",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
      },
    ];
    state.fbiScheduleDiscrepancies = [
      {
        id: "disc-1",
        club_id: CLUB_A.id,
        match_id: "match-1",
        division_code: "BU13MN23",
        numero: "3",
        kind: "mismatch",
        field_name: "match_datetime",
        ffbb_value: "26/09/2026 13:30",
        fbi_value: "27/09/2026 15:00",
        fbi_opponent_name: "Frontignan",
        detected_at: "2026-09-25T10:00:00.000Z",
        resolved_at: "2026-09-27T08:00:00.000Z",
        auto_corrected_at: "2026-09-27T08:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    const body = await res.json();

    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]).toMatchObject({ status: "auto_corrected", resolvedAt: "2026-09-27T08:00:00.000Z" });
    expect(body.issues[0].message).toContain("corrigé automatiquement");
  });

  it("n'affiche plus une anomalie auto-corrigée après la fenêtre de transparence (7 jours)", async () => {
    state.fbiScheduleDiscrepancies = [
      {
        id: "disc-1",
        club_id: CLUB_A.id,
        match_id: null,
        division_code: "BU13MN23",
        numero: "3",
        kind: "mismatch",
        field_name: "match_datetime",
        ffbb_value: "26/09/2026 13:30",
        fbi_value: "27/09/2026 15:00",
        fbi_opponent_name: "Frontignan",
        detected_at: "2026-09-01T10:00:00.000Z",
        resolved_at: "2026-09-02T08:00:00.000Z",
        auto_corrected_at: "2026-09-02T08:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    const body = await res.json();

    expect(body.issues).toEqual([]);
  });

  it("exclut les anomalies e-Marque d'une saison déjà terminée (demande du club : 'on s'en fout de 2025')", async () => {
    state.matches = [
      {
        id: "match-old",
        club_id: CLUB_A.id,
        numero: "561",
        journee: null,
        match_datetime: "2025-05-18T10:00:00.000Z",
        is_home: true,
        opponent_name: "Vieux match",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "played",
        emarque_status: "error",
        team_id: null,
      },
      {
        id: "match-current-season",
        club_id: CLUB_A.id,
        numero: "10",
        journee: null,
        match_datetime: "2026-09-20T10:00:00.000Z",
        is_home: true,
        opponent_name: "Match récent",
        venue_raw_label: null,
        score_home: null,
        score_away: null,
        status: "played",
        emarque_status: "error",
        team_id: null,
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    const body = await res.json();

    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].matchId).toBe("match-current-season");
  });

  it("détecte un conflit horaire/lieu entre deux rencontres à domicile (demande du club : '2 équipes qui jouent le dimanche à 11h à Clavel')", async () => {
    state.matches = [
      {
        id: "match-u9",
        club_id: CLUB_A.id,
        numero: "1",
        journee: null,
        match_datetime: "2026-10-11T09:00:00.000Z",
        is_home: true,
        opponent_name: "U9 adversaire",
        venue_raw_label: "GYMNASE CLAVEL",
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
      },
      {
        id: "match-u11",
        club_id: CLUB_A.id,
        numero: "2",
        journee: null,
        match_datetime: "2026-10-11T09:00:00.000Z",
        is_home: true,
        opponent_name: "U11 adversaire",
        venue_raw_label: "GYMNASE CLAVEL",
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
      },
      {
        id: "match-away",
        club_id: CLUB_A.id,
        numero: "3",
        journee: null,
        match_datetime: "2026-10-11T09:00:00.000Z",
        is_home: false,
        opponent_name: "Extérieur, même horaire mais jamais un conflit",
        venue_raw_label: "GYMNASE CLAVEL",
        score_home: null,
        score_away: null,
        status: "scheduled",
        emarque_status: "not_applicable",
        team_id: null,
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    const body = await res.json();

    // Une seule anomalie par conflit, qui montre les DEUX rencontres (les deux coachs à contacter).
    const conflicts = body.issues.filter((i: { integration: string }) => i.integration === "scheduling");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ type: "venue_time_conflict", severity: "error", technicalCode: "VENUE_TIME_CONFLICT" });
    expect(conflicts[0].relatedMatches.map((m: { matchId: string }) => m.matchId).sort()).toEqual(["match-u11", "match-u9"]);
  });

  it("n'inclut jamais une anomalie déjà résolue (resolved_at renseigné)", async () => {
    state.fbiScheduleDiscrepancies = [
      {
        id: "disc-3",
        club_id: CLUB_A.id,
        match_id: null,
        division_code: "RM3",
        numero: "5",
        kind: "missing_in_ffbb",
        field_name: null,
        ffbb_value: null,
        fbi_value: null,
        fbi_opponent_name: null,
        detected_at: "2026-09-20T10:00:00.000Z",
        resolved_at: "2026-09-24T10:00:00.000Z",
      },
    ];

    const res = await request(`/${CLUB_A.id}/issues`);
    const body = await res.json();
    expect(body.issues).toEqual([]);
  });

  it("détecte une même équipe programmée deux fois le même jour", async () => {
    const base = { club_id: CLUB_A.id, journee: null, is_home: false, venue_raw_label: null, score_home: null, score_away: null, status: "scheduled", emarque_status: "not_applicable", team_id: "team-u13" };
    state.matches = [
      { ...base, id: "match-a", numero: "10", match_datetime: "2026-10-11T08:00:00.000Z", opponent_name: "A" },
      { ...base, id: "match-b", numero: "11", match_datetime: "2026-10-11T14:00:00.000Z", opponent_name: "B" },
    ];
    state.teams = [{ id: "team-u13", club_id: CLUB_A.id, name: "U13 M" }];
    state.licencies = [
      { id: "lic-coach", club_id: CLUB_A.id, first_name: "Camille", last_name: "Coach", license_number: null, birth_date: null, email: null, phone: "0600000000", photo_url: null, active: true, public_coach: true, coached_team_ids: ["team-u13"] },
      { id: "lic-autre", club_id: CLUB_A.id, first_name: "Pas", last_name: "Coach", license_number: null, birth_date: null, email: null, phone: null, photo_url: null, active: true, public_coach: false, coached_team_ids: ["team-u13"] },
    ];

    const body = await (await request(`/${CLUB_A.id}/issues`)).json();
    const team = body.issues.filter((i: { type: string }) => i.type === "team_double_booking");
    expect(team).toHaveLength(1);
    expect(team[0].relatedMatches.map((m: { matchId: string }) => m.matchId)).toEqual(["match-a", "match-b"]);
    expect(team[0].relatedMatches[0]).toMatchObject({ teamName: "U13 M", coaches: [{ name: "Camille Coach", phone: "0600000000" }] });
  });

  it("retire une anomalie de la liste (bouton « Retirer »), sans toucher aux autres", async () => {
    const base = { club_id: CLUB_A.id, journee: null, is_home: true, venue_raw_label: "GYMNASE CLAVEL", score_home: null, score_away: null, status: "scheduled", emarque_status: "not_applicable", team_id: null };
    state.matches = [
      { ...base, id: "match-a", numero: "1", match_datetime: "2026-10-11T09:00:00.000Z", opponent_name: "A" },
      { ...base, id: "match-b", numero: "2", match_datetime: "2026-10-11T09:30:00.000Z", opponent_name: "B" },
      { ...base, id: "match-c", numero: "3", match_datetime: "2026-10-18T09:00:00.000Z", opponent_name: "C" },
      { ...base, id: "match-d", numero: "4", match_datetime: "2026-10-18T09:30:00.000Z", opponent_name: "D" },
    ];

    const before = await (await request(`/${CLUB_A.id}/issues`)).json();
    expect(before.issues).toHaveLength(2);

    const res = await request(`/${CLUB_A.id}/issues/dismiss`, { method: "POST", body: JSON.stringify({ key: before.issues[0].key }) });
    expect(res.status).toBe(200);

    const after = await (await request(`/${CLUB_A.id}/issues`)).json();
    expect(after.issues).toHaveLength(1);
    expect(after.issues[0].key).toBe(before.issues[1].key);
  });
});
