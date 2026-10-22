import { describe, expect, it } from "vitest";
import { closureConflicts, closureWindows, matchInVenue, type ClosureRow, type ConflictMatch, type ConflictTraining, type VenueRow } from "./closures.js";

const TZ = "Europe/Paris";
const lido: VenueRow = { id: "cv-lido", name: "COMPLEXE SPORTIF DU LIDO", venue_id: "ffbb-lido" };
const teams = new Map([
  ["t-u11", "U11 M1"],
  ["t-sen", "Séniors M1"],
]);

function closure(overrides: Partial<ClosureRow> = {}): ClosureRow {
  return { id: "c1", club_venue_id: "cv-lido", start_date: "2026-11-07", end_date: "2026-11-07", period: "day", reason: null, ...overrides };
}

function match(overrides: Partial<ConflictMatch> = {}): ConflictMatch {
  return { id: "m1", team_id: "t-u11", opponent_name: "Montpellier", match_datetime: "2026-11-07T10:00:00Z", venue_id: "ffbb-lido", venue_raw_label: null, ...overrides };
}

function training(overrides: Partial<ConflictTraining> = {}): ConflictTraining {
  return { id: "tr1", team_id: "t-sen", starts_at: "2026-11-07T18:00:00Z", ends_at: "2026-11-07T19:30:00Z", club_venue_id: "cv-lido", ...overrides };
}

describe("closureWindows", () => {
  it("journée, matin (avant 13 h) et après-midi (à partir de 13 h), heure de Paris", () => {
    expect(closureWindows(closure(), TZ)).toEqual([{ start: new Date("2026-11-06T23:00:00Z"), end: new Date("2026-11-07T23:00:00Z") }]);
    expect(closureWindows(closure({ period: "morning" }), TZ)).toEqual([{ start: new Date("2026-11-06T23:00:00Z"), end: new Date("2026-11-07T12:00:00Z") }]);
    expect(closureWindows(closure({ period: "afternoon" }), TZ)).toEqual([{ start: new Date("2026-11-07T12:00:00Z"), end: new Date("2026-11-07T23:00:00Z") }]);
  });

  it("une fenêtre par jour sur une période, changement d'heure compris", () => {
    const windows = closureWindows(closure({ start_date: "2026-10-24", end_date: "2026-10-26", period: "morning" }), TZ);
    expect(windows).toHaveLength(3);
    expect(windows[0]!.start.toISOString()).toBe("2026-10-23T22:00:00.000Z");
    expect(windows[2]!.start.toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("matchInVenue", () => {
  it("identité FFBB d'abord, sinon nom de la salle (libellé FFBB « NOM — adresse »)", () => {
    expect(matchInVenue({ venue_id: "ffbb-lido", venue_raw_label: null }, lido)).toBe(true);
    expect(matchInVenue({ venue_id: "ffbb-clavel", venue_raw_label: "COMPLEXE SPORTIF DU LIDO" }, lido)).toBe(false);
    expect(matchInVenue({ venue_id: null, venue_raw_label: "Complexe sportif du Lido — 213 rue du Dauphiné" }, { ...lido, venue_id: null })).toBe(true);
    expect(matchInVenue({ venue_id: null, venue_raw_label: null }, lido)).toBe(false);
  });
});

describe("closureConflicts", () => {
  const input = (matches: ConflictMatch[], trainings: ConflictTraining[], venue = lido) => ({ venue, matches, trainings, teamNameById: teams, timezone: TZ });

  it("match à domicile et entraînement prévus pendant la journée fermée", () => {
    expect(closureConflicts(closure(), input([match()], [training()]))).toEqual([
      { kind: "MATCH", id: "m1", teamName: "U11 M1", opponentName: "Montpellier", startsAt: "2026-11-07T10:00:00.000Z", endsAt: "2026-11-07T11:30:00.000Z" },
      { kind: "TRAINING", id: "tr1", teamName: "Séniors M1", opponentName: null, startsAt: "2026-11-07T18:00:00.000Z", endsAt: "2026-11-07T19:30:00.000Z" },
    ]);
  });

  it("matin fermé : le match de 11 h est en conflit, l'entraînement du soir non", () => {
    expect(closureConflicts(closure({ period: "morning" }), input([match()], [training()])).map((c) => c.id)).toEqual(["m1"]);
  });

  it("un match de 12 h 00 déborde sur l'après-midi fermé (créneau de 90 min)", () => {
    expect(closureConflicts(closure({ period: "afternoon" }), input([match({ match_datetime: "2026-11-07T11:00:00Z" })], [])).map((c) => c.id)).toEqual(["m1"]);
    expect(closureConflicts(closure({ period: "afternoon" }), input([match({ match_datetime: "2026-11-07T09:00:00Z" })], []))).toEqual([]);
  });

  it("ignore un autre gymnase, un autre jour", () => {
    expect(closureConflicts(closure(), input([match({ venue_id: "ffbb-clavel" }), match({ id: "m2", match_datetime: "2026-11-08T10:00:00Z" })], [training({ club_venue_id: "cv-clavel" })]))).toEqual([]);
  });
});
