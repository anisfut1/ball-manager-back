import { describe, expect, it } from "vitest";
import { detectTeamConflicts, detectVenueConflicts, groupConflicts, type VenueConflictCandidate } from "./venue-conflicts.js";

function candidate(overrides: Partial<VenueConflictCandidate> = {}): VenueConflictCandidate {
  return {
    id: "match-1",
    numero: "1",
    opponentName: "Adversaire",
    matchDatetime: "2026-10-11T09:00:00.000Z", // dimanche 11h heure de Paris (CEST, UTC+2)
    venueId: null,
    venueRawLabel: "GYMNASE CLAVEL",
    ...overrides,
  };
}

describe("detectVenueConflicts", () => {
  it("ne détecte aucun conflit quand une seule rencontre occupe la salle à cet horaire", () => {
    expect(detectVenueConflicts([candidate()])).toEqual([]);
  });

  it("détecte deux rencontres au même horaire ET même salle (venueRawLabel) — le cas 'Clavel' cité par le club", () => {
    const matchA = candidate({ id: "match-a", numero: "1", opponentName: "U9" });
    const matchB = candidate({ id: "match-b", numero: "2", opponentName: "U11" });

    const conflicts = detectVenueConflicts([matchA, matchB]);

    expect(conflicts).toHaveLength(2);
    expect(conflicts).toContainEqual({ matchId: "match-a", conflictingMatchIds: ["match-b"], conflictingLabel: "n°2 vs U11 à 11:00" });
    expect(conflicts).toContainEqual({ matchId: "match-b", conflictingMatchIds: ["match-a"], conflictingLabel: "n°1 vs U9 à 11:00" });
  });

  it("ne détecte pas de conflit si même horaire mais salle différente", () => {
    const matchA = candidate({ id: "match-a", venueRawLabel: "GYMNASE CLAVEL" });
    const matchB = candidate({ id: "match-b", venueRawLabel: "GYMNASE MAURICE C" });

    expect(detectVenueConflicts([matchA, matchB])).toEqual([]);
  });

  it("ne détecte pas de conflit si même salle mais horaire différent", () => {
    const matchA = candidate({ id: "match-a", matchDatetime: "2026-10-11T09:00:00.000Z" });
    const matchB = candidate({ id: "match-b", matchDatetime: "2026-10-11T11:00:00.000Z" });

    expect(detectVenueConflicts([matchA, matchB])).toEqual([]);
  });

  it("détecte deux créneaux qui se chevauchent dans la même salle (11h et 12h)", () => {
    const matchA = candidate({ id: "match-a", matchDatetime: "2026-10-11T09:00:00.000Z" });
    const matchB = candidate({ id: "match-b", numero: "2", matchDatetime: "2026-10-11T10:00:00.000Z" });

    expect(detectVenueConflicts([matchA, matchB])).toHaveLength(2);
  });

  it("normalise la casse/les espaces de venueRawLabel avant comparaison", () => {
    const matchA = candidate({ id: "match-a", venueRawLabel: "  gymnase clavel  " });
    const matchB = candidate({ id: "match-b", numero: "2", venueRawLabel: "GYMNASE CLAVEL" });

    expect(detectVenueConflicts([matchA, matchB])).toHaveLength(2);
  });

  it("préfère venueId (identité de salle résolue) à venueRawLabel quand les deux sont présents", () => {
    const matchA = candidate({ id: "match-a", venueId: "venue-1", venueRawLabel: "GYMNASE A (LIBELLÉ BRUT)" });
    const matchB = candidate({ id: "match-b", numero: "2", venueId: "venue-1", venueRawLabel: "GYMNASE A (AUTRE LIBELLÉ)" });

    expect(detectVenueConflicts([matchA, matchB])).toHaveLength(2);
  });

  it("ignore une rencontre sans salle connue (venueId et venueRawLabel tous deux absents)", () => {
    const matchA = candidate({ id: "match-a", venueId: null, venueRawLabel: null });
    const matchB = candidate({ id: "match-b", venueId: null, venueRawLabel: null });

    expect(detectVenueConflicts([matchA, matchB])).toEqual([]);
  });

  it("gère un conflit à trois rencontres simultanées (chacune référence les deux autres)", () => {
    const matchA = candidate({ id: "match-a", numero: "1" });
    const matchB = candidate({ id: "match-b", numero: "2" });
    const matchC = candidate({ id: "match-c", numero: "3" });

    const conflicts = detectVenueConflicts([matchA, matchB, matchC]);

    expect(conflicts).toHaveLength(3);
    const forA = conflicts.find((c) => c.matchId === "match-a");
    expect(forA?.conflictingMatchIds.sort()).toEqual(["match-b", "match-c"]);
  });
});

describe("detectTeamConflicts", () => {
  const base = { numero: "1", opponentName: "Adversaire", teamId: "team-u13" };

  it("détecte une même équipe programmée deux fois le même jour", () => {
    const conflicts = detectTeamConflicts([
      { ...base, id: "match-a", matchDatetime: "2026-10-11T08:00:00.000Z" },
      { ...base, id: "match-b", numero: "2", matchDatetime: "2026-10-11T14:00:00.000Z" },
    ]);
    expect(conflicts.map((c) => c.matchId).sort()).toEqual(["match-a", "match-b"]);
  });

  it("ignore deux équipes différentes ou deux jours différents", () => {
    expect(
      detectTeamConflicts([
        { ...base, id: "match-a", matchDatetime: "2026-10-11T08:00:00.000Z" },
        { ...base, id: "match-b", teamId: "team-u15", matchDatetime: "2026-10-11T08:00:00.000Z" },
        { ...base, id: "match-c", matchDatetime: "2026-10-12T08:00:00.000Z" },
      ]),
    ).toEqual([]);
  });
});

describe("doublons FFBB", () => {
  it("ne signale pas une même rencontre présente deux fois côté FFBB (même numéro, adversaire, horaire)", () => {
    const matchA = candidate({ id: "match-a", numero: "5356", opponentName: "FO PISCENOIS - 1" });
    const matchB = candidate({ id: "match-b", numero: "5356", opponentName: "FO PISCENOIS - 1" });
    expect(detectVenueConflicts([matchA, matchB])).toEqual([]);
    expect(detectTeamConflicts([{ ...matchA, teamId: "t" }, { ...matchB, teamId: "t" }])).toEqual([]);
  });
});


describe("groupConflicts", () => {
  it("regroupe les rencontres liées en un seul conflit", () => {
    const a = candidate({ id: "a", numero: "1" });
    const b = candidate({ id: "b", numero: "2" });
    const c = candidate({ id: "c", numero: "3", venueRawLabel: "AUTRE SALLE" });
    const d = candidate({ id: "d", numero: "4", venueRawLabel: "AUTRE SALLE" });
    expect(groupConflicts(detectVenueConflicts([a, b, c, d])).sort()).toEqual([["a", "b"], ["c", "d"]]);
  });
});
