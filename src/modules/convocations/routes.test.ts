import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow, type FakeMatchRow } from "../../test-support/fake-club-supabase.js";
import { hashPublicToken } from "../public-tables/token.js";

/**
 * Vie d'équipe — Lot 2 : disponibilités des matchs et convocations (retour
 * du club, 2026-10-09). Scénarios du cahier des charges (§100 à §105).
 * Données fictives.
 */
let state: FakeClubSupabaseState;
let currentUserId = "coach-u15";

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
const U15F = "11111111-1111-4111-8111-000000000015";
const U18M = "11111111-1111-4111-8111-000000000018";
const AWAY = "33333333-3333-4333-8333-00000000000a";
const HOME = "33333333-3333-4333-8333-00000000000b";
const U18_MATCH = "33333333-3333-4333-8333-00000000000c";
const ID = { sarah: "44444444-4444-4444-8444-000000000001", lina: "44444444-4444-4444-8444-000000000002", emma: "44444444-4444-4444-8444-000000000003", coach: "44444444-4444-4444-8444-000000000004", tom: "44444444-4444-4444-8444-000000000005" };

function lic(id: string, firstName: string, teamId: string | null, extra: Partial<FakeLicencieRow> & { birth_date?: string | null } = {}): FakeLicencieRow {
  return { id, club_id: CLUB_A.id, first_name: firstName, last_name: "MARTIN", license_number: null, birth_date: "2011-03-01", email: null, phone: null, photo_url: null, active: true, team_id: teamId, ...extra } as FakeLicencieRow;
}
function match(id: string, teamId: string, at: string, isHome: boolean, extra: Partial<FakeMatchRow> = {}): FakeMatchRow {
  return { id, club_id: CLUB_A.id, numero: null, journee: null, match_datetime: at, is_home: isHome, opponent_name: "Agde", venue_raw_label: isHome ? "Maurice Clavel" : "Gymnase Agde Basket", score_home: null, score_away: null, status: "scheduled", emarque_status: "not_applicable", team_id: teamId, venue_id: null, ...extra };
}

function club(path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}/team-life${path}`, { method: init.method ?? "GET", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
function pub(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  // Le jeton personnel ne voyage plus qu'en en-tête (le back n'accepte plus `?token=`).
  return app.request(`/v1/public/clubs/club-a/team-life${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(init.token ? { "x-personal-link-token": init.token } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const json = async <T>(res: Response) => (await res.json()) as T;

interface TeamLife {
  matchClosed: boolean;
  availability: { openedAt: string | null; counts: { available: number; unavailable: number; uncertain: number; noResponse: number; total: number }; roster: { licencie: { firstName: string }; response: string | null }[] };
  convocation: null | {
    revision: number;
    draft: { licencieIds: string[] };
    hasUnsentChanges: boolean;
    matchChanges: string[];
    counts: { convoked: number; confirmed: number; declined: number; pending: number };
    recipients: { licencie: { firstName: string }; response: string }[];
  };
}
interface Home {
  actions: { type: string; licencieId?: string; firstName?: string; currentResponse?: string | null; reminded?: boolean; stage?: string; match?: { id: string }; convocation?: { message: string; meetingPoint: string } }[];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T08:00:00.000Z"));
  currentUserId = "coach-u15";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }],
    teams: [
      { id: U15F, club_id: CLUB_A.id, name: "U15", sexe: "F", active: true },
      { id: U18M, club_id: CLUB_A.id, name: "U18", sexe: "M", active: true },
    ],
    memberships: [{ id: "m-coach15", club_id: CLUB_A.id, user_id: "coach-u15", status: "active" }],
    roles: [{ membership_id: "m-coach15", role: "coach", scope_team_id: U15F }],
    matches: [match(AWAY, U15F, "2026-10-10T16:00:00.000Z", false), match(HOME, U15F, "2026-10-17T16:00:00.000Z", true), match(U18_MATCH, U18M, "2026-10-11T16:00:00.000Z", true)],
    licencies: [
      lic(ID.sarah, "Sarah", U15F),
      lic(ID.lina, "Lina", U15F),
      lic(ID.emma, "Emma", U15F),
      lic(ID.tom, "Tom", U18M),
      lic(ID.coach, "Claire", null, { last_name: "DURAND", birth_date: "1990-01-01", public_coach: true, coached_team_ids: [U15F] }),
    ],
  });
  state.publicTokens = (["sarah", "lina", "emma", "tom", "coach"] as const).map((k) => ({ id: `tok-${k}`, club_id: CLUB_A.id, licencie_id: ID[k], token_hash: hashPublicToken(`token-${k}`), email: null, created_at: "2026-10-01T00:00:00Z", revoked_at: null, revoked_by: null }));
});

afterEach(() => vi.useRealTimers());

async function prepareAway(selection: string[]) {
  await club(`/matches/${AWAY}/availability/open`, { method: "POST" });
  await pub(`/matches/${AWAY}/availability/response`, { method: "PUT", token: "token-sarah", body: { response: "AVAILABLE" } });
  await pub(`/matches/${AWAY}/availability/response`, { method: "PUT", token: "token-lina", body: { response: "AVAILABLE" } });
  await pub(`/matches/${AWAY}/availability/response`, { method: "PUT", token: "token-emma", body: { response: "UNAVAILABLE" } });
  return club(`/matches/${AWAY}/convocation/draft`, {
    method: "PUT",
    body: { licencieIds: selection, meetingAt: "2026-10-10T14:15:00.000Z", meetingPoint: "Parking Maurice Clavel", coachMessage: "Tenue complète." },
  });
}

describe("Disponibilités d'un match", () => {
  it("le coach demande les disponibilités (aucune convocation créée) ; la Home du parent propose Disponible / Indisponible / Incertaine", async () => {
    const before = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-lina"] } }));
    expect(before.actions.filter((a) => a.type === "MATCH_AVAILABILITY")).toHaveLength(0);

    const opened = await json<TeamLife>(await club(`/matches/${AWAY}/availability/open`, { method: "POST" }));
    expect(opened.availability.openedAt).not.toBeNull();
    expect(opened.convocation).toBeNull();

    const home = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-lina"] } }));
    expect(home.actions.find((a) => a.type === "MATCH_AVAILABILITY")).toMatchObject({ firstName: "Lina", currentResponse: null, match: { id: AWAY } });

    // §101 : réponse en un clic, l'action n'est plus « à faire » ensuite.
    expect((await pub(`/matches/${AWAY}/availability/response`, { method: "PUT", token: "token-lina", body: { response: "AVAILABLE" } })).status).toBe(200);
    const after = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-lina"] } }));
    expect(after.actions.find((a) => a.type === "MATCH_AVAILABILITY")?.currentResponse).toBe("AVAILABLE");
  });

  it("le coach voit les compteurs puis les disponibles d'abord, les indisponibles en dernier", async () => {
    await prepareAway([]);
    const view = await json<TeamLife>(await club(`/matches/${AWAY}`));
    expect(view.availability.counts).toEqual({ available: 2, unavailable: 1, uncertain: 0, noResponse: 0, total: 3 });
    expect(view.availability.roster.map((r) => r.response)).toEqual(["AVAILABLE", "AVAILABLE", "UNAVAILABLE"]);
  });

  it("§102 : on ne répond jamais pour un autre ; pas avant la demande du coach", async () => {
    expect((await pub(`/matches/${AWAY}/availability/response`, { method: "PUT", token: "token-lina", body: { response: "AVAILABLE" } })).status).toBe(409);
    await club(`/matches/${AWAY}/availability/open`, { method: "POST" });
    // Tom (U18) ne fait pas partie de l'équipe du match.
    expect((await pub(`/matches/${AWAY}/availability/response`, { method: "PUT", token: "token-tom", body: { response: "AVAILABLE" } })).status).toBe(403);
  });

  it("§103 : le coach U15F gère U15F, jamais U18M", async () => {
    expect((await club(`/matches/${U18_MATCH}/availability/open`, { method: "POST" })).status).toBe(403);
    expect((await club(`/matches/${U18_MATCH}`)).status).toBe(403);
    expect((await pub(`/matches/${U18_MATCH}/availability/open`, { method: "POST", token: "token-coach" })).status).toBe(403);
    expect((await pub(`/matches/${AWAY}/availability/open`, { method: "POST", token: "token-coach" })).status).toBe(200);
    // Un parent n'a pas accès à l'écran coach.
    expect((await pub(`/matches/${AWAY}`, { token: "token-lina" })).status).toBe(403);
  });
});

describe("Convocation", () => {
  it("préparer : les disponibles sont présélectionnés ; alerte (non bloquante) pour un indisponible sélectionné", async () => {
    await club(`/matches/${AWAY}/availability/open`, { method: "POST" });
    await pub(`/matches/${AWAY}/availability/response`, { method: "PUT", token: "token-sarah", body: { response: "AVAILABLE" } });
    await pub(`/matches/${AWAY}/availability/response`, { method: "PUT", token: "token-emma", body: { response: "UNAVAILABLE" } });
    const draft = await json<TeamLife>(await club(`/matches/${AWAY}/convocation/draft`, { method: "PUT", body: {} }));
    expect(draft.convocation?.draft.licencieIds).toEqual([ID.sarah]);

    await club(`/matches/${AWAY}/convocation/draft`, { method: "PUT", body: { licencieIds: [ID.sarah, ID.emma] } });
    const preview = await json<{ unavailableSelected: string[]; blockers: string[] }>(await club(`/matches/${AWAY}/convocation/preview`, { method: "POST" }));
    expect(preview.unavailableSelected).toEqual(["Emma"]);
    // Extérieur : heure et lieu de rendez-vous obligatoires.
    expect(preview.blockers.join(" ")).toMatch(/heure de rendez-vous/);
    expect(preview.blockers.join(" ")).toMatch(/extérieur.*lieu de rendez-vous/);
    expect((await club(`/matches/${AWAY}/convocation/send`, { method: "POST" })).status).toBe(400);
  });

  it("§104 : seules Sarah et Lina reçoivent la convocation ; §98/§99 message parent avec rendez-vous ET lieu du match", async () => {
    await prepareAway([ID.sarah, ID.lina]);
    const preview = await json<{ samples: { audience: string; text: string }[]; blockers: string[] }>(await club(`/matches/${AWAY}/convocation/preview`, { method: "POST" }));
    expect(preview.blockers).toEqual([]);
    expect(preview.samples[0]?.audience).toBe("GUARDIAN");

    const sent = await json<TeamLife>(await club(`/matches/${AWAY}/convocation/send`, { method: "POST" }));
    expect(sent.convocation).toMatchObject({ revision: 1, hasUnsentChanges: false, counts: { convoked: 2, confirmed: 0, declined: 0, pending: 2 } });

    const lina = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-lina"] } }));
    const conv = lina.actions.find((a) => a.type === "CONVOCATION_RESPONSE")!;
    expect(conv.currentResponse).toBe("PENDING");
    for (const part of ["Convocation pour Lina avec les U15 (F).", "U15 (F) contre Agde", "Samedi 10 octobre à 18:00", "Rendez-vous :\n16:15\nParking Maurice Clavel", "Lieu du match :\nGymnase Agde Basket", "« Tenue complète. »"]) {
      expect(conv.convocation?.message).toContain(part);
    }
    // Plus de question de disponibilité une fois convoquée.
    expect(lina.actions.some((a) => a.type === "MATCH_AVAILABILITY")).toBe(false);

    const emma = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-emma"] } }));
    expect(emma.actions.some((a) => a.type === "CONVOCATION_RESPONSE")).toBe(false);
    expect((await pub(`/matches/${AWAY}/convocation/response`, { method: "PUT", token: "token-emma", body: { response: "CONFIRMED" } })).status).toBe(403);
    expect(state.convocationDispatches).toHaveLength(2);
  });

  it("§105 : Lina décline, le coach voit 1 refus ; Sarah confirme", async () => {
    await prepareAway([ID.sarah, ID.lina]);
    await club(`/matches/${AWAY}/convocation/send`, { method: "POST" });
    await pub(`/matches/${AWAY}/convocation/response`, { method: "PUT", token: "token-lina", body: { response: "DECLINED" } });
    await pub(`/matches/${AWAY}/convocation/response`, { method: "PUT", token: "token-sarah", body: { response: "CONFIRMED" } });
    const view = await json<TeamLife>(await club(`/matches/${AWAY}`));
    expect(view.convocation?.counts).toEqual({ convoked: 2, confirmed: 1, declined: 1, pending: 0 });
    expect(view.convocation?.recipients.map((r) => [r.licencie.firstName, r.response])).toEqual([
      ["Lina", "DECLINED"],
      ["Sarah", "CONFIRMED"],
    ]);
    const coachHome = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-coach"] } }));
    expect(coachHome.actions.find((a) => a.type === "COACH_MATCH" && a.match?.id === AWAY)).toMatchObject({ stage: "CONVOCATION_SENT" });
  });

  it("§45 : une modification après envoi n'est pas visible avant « Envoyer la mise à jour » ; heure changée → reconfirmer", async () => {
    await prepareAway([ID.sarah, ID.lina]);
    await club(`/matches/${AWAY}/convocation/send`, { method: "POST" });
    await pub(`/matches/${AWAY}/convocation/response`, { method: "PUT", token: "token-sarah", body: { response: "CONFIRMED" } });

    const edited = await json<TeamLife>(await club(`/matches/${AWAY}/convocation/draft`, { method: "PUT", body: { meetingAt: "2026-10-10T14:00:00.000Z" } }));
    expect(edited.convocation?.hasUnsentChanges).toBe(true);
    const stillOld = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-sarah"] } }));
    expect(stillOld.actions.find((a) => a.type === "CONVOCATION_RESPONSE")?.convocation?.message).toContain("16:15");

    const resent = await json<TeamLife>(await club(`/matches/${AWAY}/convocation/send`, { method: "POST" }));
    expect(resent.convocation).toMatchObject({ revision: 2, hasUnsentChanges: false, counts: { confirmed: 0, pending: 2 } });
    const updated = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-sarah"] } }));
    expect(updated.actions.find((a) => a.type === "CONVOCATION_RESPONSE")?.convocation?.message).toContain("16:00");
  });

  it("§93/§94 : match déplacé par la FFBB → signalé au coach, message envoyé inchangé ; match annulé → plus de confirmation", async () => {
    await prepareAway([ID.sarah, ID.lina]);
    await club(`/matches/${AWAY}/convocation/send`, { method: "POST" });
    state.matches.find((m) => m.id === AWAY)!.match_datetime = "2026-10-10T17:00:00.000Z";
    const view = await json<TeamLife>(await club(`/matches/${AWAY}`));
    expect(view.convocation?.matchChanges).toEqual(["DATE"]);
    const lina = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-lina"] } }));
    expect(lina.actions.find((a) => a.type === "CONVOCATION_RESPONSE")?.convocation?.message).toContain("à 18:00");

    state.matches.find((m) => m.id === AWAY)!.status = "cancelled";
    expect((await pub(`/matches/${AWAY}/convocation/response`, { method: "PUT", token: "token-lina", body: { response: "CONFIRMED" } })).status).toBe(409);
    expect(state.convocations).toHaveLength(1);
  });

  it("match à domicile : le lieu de rendez-vous par défaut est le gymnase du match", async () => {
    await club(`/matches/${HOME}/convocation/draft`, { method: "PUT", body: { licencieIds: [ID.sarah], meetingAt: "2026-10-17T15:00:00.000Z" } });
    const preview = await json<{ blockers: string[]; samples: { text: string }[] }>(await club(`/matches/${HOME}/convocation/preview`, { method: "POST" }));
    expect(preview.blockers).toEqual([]);
    expect(preview.samples[0]?.text).toContain("Rendez-vous :\n17:00\nMaurice Clavel");
    expect(preview.samples[0]?.text).not.toContain("Lieu du match");
  });
});

describe("§100 : Home du parent", () => {
  it("entraînement à répondre + disponibilité de match + convocation à confirmer : les trois actions, convocation après les réponses", async () => {
    await club("/teams/" + U15F + "/training-series", { method: "POST", body: { startsOn: "2026-10-05", endsOn: "2026-10-31", slots: [{ weekday: 2, startTime: "19:00", endTime: "20:30", locationLabel: "Salle" }] } });
    await prepareAway([ID.lina]);
    await club(`/matches/${AWAY}/convocation/send`, { method: "POST" });
    await club(`/matches/${HOME}/availability/open`, { method: "POST" });

    const home = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-lina"] } }));
    const types = home.actions.map((a) => a.type);
    expect(types).toContain("TRAINING_RESPONSE");
    expect(types).toContain("MATCH_AVAILABILITY");
    expect(types).toContain("CONVOCATION_RESPONSE");
    expect(types.indexOf("CONVOCATION_RESPONSE")).toBeGreaterThan(types.lastIndexOf("MATCH_AVAILABILITY"));
  });

  it("coach : étapes demander → préparer pour les matchs des 14 prochains jours de son équipe seulement", async () => {
    const home = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-coach"] } }));
    const coach = home.actions.filter((a) => a.type === "COACH_MATCH");
    expect(coach.map((a) => [a.match?.id, a.stage])).toEqual([
      [AWAY, "ASK_AVAILABILITY"],
      [HOME, "ASK_AVAILABILITY"],
    ]);
    await club(`/matches/${AWAY}/availability/open`, { method: "POST" });
    const next = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-coach"] } }));
    expect(next.actions.find((a) => a.type === "COACH_MATCH" && a.match?.id === AWAY)?.stage).toBe("PREPARE_CONVOCATION");
  });
});

describe("Coach qui joue dans l'équipe qu'il coache (retour du club, 2026-10-10)", () => {
  it("pas de disponibilité de match demandée au coach, et il n'est pas dans l'effectif du match", async () => {
    state.licencies.push(lic("44444444-4444-4444-8444-000000000009", "Clément", U15F, { last_name: "DURAND", birth_date: "1995-01-01", public_coach: true, coached_team_ids: [U15F] }));
    state.publicTokens.push({ id: "tok-pc", club_id: CLUB_A.id, licencie_id: "44444444-4444-4444-8444-000000000009", token_hash: hashPublicToken("token-pc"), email: null, created_at: "2026-10-01T00:00:00Z", revoked_at: null, revoked_by: null });
    await club(`/matches/${AWAY}/availability/open`, { method: "POST" });
    const home = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-pc"] } }));
    expect(home.actions.some((a) => a.type === "MATCH_AVAILABILITY")).toBe(false);
    expect(home.actions.some((a) => a.type === "COACH_MATCH")).toBe(true);
    const view = await json<TeamLife>(await club(`/matches/${AWAY}`));
    expect(view.availability.counts.total).toBe(3);
    expect(view.availability.roster.map((r) => r.licencie.firstName)).not.toContain("Clément");
  });
});

describe("Accueil coach : table de marque des matchs à domicile (retour du club, 2026-10-10)", () => {
  it("postes pourvus / à pourvoir ; 3 postes sans arbitre club ; rien à l'extérieur", async () => {
    state.tableAssignments.push({ id: "ta1", club_id: CLUB_A.id, match_id: HOME, licencie_id: ID.sarah, role: "SCORER", created_by: null } as never);
    const home = await json<{ actions: { type: string; match?: { id: string }; tables?: { filled: number; total: number } | null }[] }>(await pub("/action-center", { method: "POST", body: { tokens: ["token-coach"] } }));
    const byMatch = Object.fromEntries(home.actions.filter((a) => a.type === "COACH_MATCH").map((a) => [a.match!.id, a.tables]));
    expect(byMatch[HOME]).toEqual({ filled: 1, total: 4 });
    expect(byMatch[AWAY]).toBeNull();
  });
});

describe("Relance des sans réponse (retour du club, 2026-10-10)", () => {
  it("disponibilités : la relance est marquée et seuls les sans réponse voient « relancé » sur leur Home", async () => {
    expect((await club(`/matches/${AWAY}/remind`, { method: "POST" })).status).toBe(409);
    await club(`/matches/${AWAY}/availability/open`, { method: "POST" });
    await pub(`/matches/${AWAY}/availability/response`, { method: "PUT", token: "token-sarah", body: { response: "AVAILABLE" } });
    const reminded = await json<TeamLife & { availability: { remindedAt: string | null } }>(await club(`/matches/${AWAY}/remind`, { method: "POST" }));
    expect(reminded.availability.remindedAt).not.toBeNull();

    const lina = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-lina"] } }));
    expect(lina.actions.find((a) => a.type === "MATCH_AVAILABILITY")?.reminded).toBe(true);
    const sarah = await json<Home>(await pub("/action-center", { method: "POST", body: { tokens: ["token-sarah"] } }));
    expect(sarah.actions.find((a) => a.type === "MATCH_AVAILABILITY")?.reminded).toBe(false);
    // Jamais un parent : réservé à qui gère l'équipe.
    expect((await pub(`/matches/${AWAY}/remind`, { method: "POST", token: "token-lina" })).status).toBe(403);
  });

  it("convocation : relance des « en attente » ; un nouvel envoi efface la relance ; rien à relancer si tout le monde a répondu", async () => {
    await prepareAway([ID.sarah, ID.lina]);
    await club(`/matches/${AWAY}/convocation/send`, { method: "POST" });
    await pub(`/matches/${AWAY}/convocation/response`, { method: "PUT", token: "token-sarah", body: { response: "CONFIRMED" } });
    const view = await json<{ convocation: { remindedAt: string | null } }>(await club(`/matches/${AWAY}/remind`, { method: "POST" }));
    expect(view.convocation.remindedAt).not.toBeNull();
    const lina = await json<{ actions: { type: string; reminded?: boolean }[] }>(await pub("/action-center", { method: "POST", body: { tokens: ["token-lina"] } }));
    expect(lina.actions.find((a) => a.type === "CONVOCATION_RESPONSE")?.reminded).toBe(true);

    // Mise à jour envoyée plus tard : tout le monde « en attente », la relance précédente ne compte plus.
    vi.setSystemTime(new Date("2026-10-06T08:00:00.000Z"));
    await club(`/matches/${AWAY}/convocation/draft`, { method: "PUT", body: { meetingAt: "2026-10-10T14:00:00.000Z" } });
    const resent = await json<{ convocation: { remindedAt: string | null } }>(await club(`/matches/${AWAY}/convocation/send`, { method: "POST" }));
    expect(resent.convocation.remindedAt).toBeNull();

    await pub(`/matches/${AWAY}/convocation/response`, { method: "PUT", token: "token-sarah", body: { response: "CONFIRMED" } });
    await pub(`/matches/${AWAY}/convocation/response`, { method: "PUT", token: "token-lina", body: { response: "DECLINED" } });
    const none = await club(`/matches/${AWAY}/remind`, { method: "POST" });
    expect(none.status).toBe(409);
    expect((await json<{ error: { code: string } }>(none)).error.code).toBe("NOTHING_TO_REMIND");
  });
});
