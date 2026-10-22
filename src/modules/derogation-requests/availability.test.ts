import { describe, expect, it } from "vitest";
import { computeAvailability, evaluateSlot, localSlotStart, validateRequestedSlot, type PlanningRules, type ScheduledMatch } from "./availability.js";
import { intervalsOverlap, matchSlotsOverlap } from "../../scheduling/match-slot.js";

const TZ = "Europe/Paris";
// Configuration SC Sète (club_scheduling_rules) : samedi 13:00→21:00, dimanche 09:00→16:00.
const RULES: PlanningRules = { 6: { earliestStart: "13:00", latestStart: "21:00" }, 0: { earliestStart: "09:00", latestStart: "16:00" } };
const SATURDAY = "2026-10-10";
const SUNDAY = "2026-10-11";
const NOW = new Date("2026-10-01T10:00:00Z");
const VENUE_A = { id: "venue-a", name: "Gymnase A", address: null };
const VENUE_B = { id: "venue-b", name: "Gymnase B", address: null };

const at = (date: string, time: string) => localSlotStart(date, time, TZ);

function match(overrides: Partial<ScheduledMatch>): ScheduledMatch {
  return { id: "m-other", startAt: at(SATURDAY, "15:00"), clubVenueId: VENUE_A.id, teamId: "team-other", teamName: "U13F", opponentName: "Montpellier", isHome: true, ...overrides };
}

function validate(date: string, time: string, overrides: Partial<Parameters<typeof validateRequestedSlot>[0]> = {}) {
  return validateRequestedSlot({
    startAt: at(date, time),
    clubVenueId: VENUE_A.id,
    isHome: true,
    targetMatchId: "target",
    targetTeamId: "team-u15f",
    matches: [],
    pending: [],
    timezone: TZ,
    rules: RULES,
    now: NOW,
    ...overrides,
  });
}

describe("source de vérité partagée (src/scheduling/match-slot.ts)", () => {
  it("15h–17h et 17h–19h compatibles ; 15h–17h et 16h–18h en conflit", () => {
    expect(matchSlotsOverlap(at(SATURDAY, "15:00"), at(SATURDAY, "17:00"))).toBe(false);
    expect(matchSlotsOverlap(at(SATURDAY, "15:00"), at(SATURDAY, "16:00"))).toBe(true);
    expect(intervalsOverlap(at(SATURDAY, "15:00"), at(SATURDAY, "17:00"), at(SATURDAY, "17:00"), at(SATURDAY, "19:00"))).toBe(false);
  });
});

describe("règles du samedi (13:00 → 21:00)", () => {
  it.each([
    ["12:00", false],
    ["13:00", true],
    ["21:00", true],
    ["22:00", false],
  ])("%s → %s", (time, ok) => {
    const result = validate(SATURDAY, time);
    expect(result.ok).toBe(ok);
    if (!ok && !result.ok) expect(result.code).toBe("DEROGATION_SLOT_OUT_OF_RANGE");
  });
});

describe("règles du dimanche (09:00 → 16:00)", () => {
  it.each([
    ["08:00", false],
    ["09:00", true],
    ["16:00", true],
    ["17:00", false],
  ])("%s → %s", (time, ok) => {
    expect(validate(SUNDAY, time).ok).toBe(ok);
  });
});

describe("conflit de 2 heures", () => {
  const existing = [match({ startAt: at(SATURDAY, "15:00") })];

  it("match existant 15h–17h : 16h refusé avec un message explicite", () => {
    const result = validate(SATURDAY, "16:00", { matches: existing, venueNames: new Map([[VENUE_A.id, "Gymnase A"]]) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("DEROGATION_SLOT_CONFLICT");
    expect(result.message).toBe("Créneau impossible. Un match est déjà programmé dans ce gymnase : U13F vs Montpellier, 15:00 → 17:00 — Gymnase A.");
  });

  it("match existant 15h–17h : 17h autorisé (les créneaux se touchent)", () => {
    expect(validate(SATURDAY, "17:00", { matches: existing }).ok).toBe(true);
  });

  it("le match cible n'entre jamais en conflit avec lui-même", () => {
    expect(validate(SATURDAY, "16:00", { matches: [match({ id: "target", startAt: at(SATURDAY, "15:00") })] }).ok).toBe(true);
  });

  it("l'équipe ne peut pas avoir deux matchs qui se chevauchent, même dans un autre gymnase ou à l'extérieur", () => {
    const result = validate(SATURDAY, "15:00", { matches: [match({ clubVenueId: null, isHome: false, teamId: "team-u15f", startAt: at(SATURDAY, "16:00") })] });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === "DEROGATION_SLOT_CONFLICT") expect(result.conflicts[0]!.type).toBe("TEAM_MATCH");
  });
});

describe("plusieurs gymnases", () => {
  it("A occupé 15h–17h, B libre : 15h impossible en A, possible en B", () => {
    const matches = [match({ startAt: at(SATURDAY, "15:00"), clubVenueId: VENUE_A.id })];
    expect(validate(SATURDAY, "15:00", { matches, clubVenueId: VENUE_A.id }).ok).toBe(false);
    expect(validate(SATURDAY, "15:00", { matches, clubVenueId: VENUE_B.id }).ok).toBe(true);

    const availability = computeAvailability({ date: SATURDAY, timezone: TZ, rules: RULES, isHome: true, venues: [VENUE_A, VENUE_B], matches, pending: [], targetMatchId: "target", targetTeamId: "team-u15f", now: NOW });
    const slot = (venueId: string, time: string) => availability.venues.find((v) => v.venue.id === venueId)!.candidates.find((c) => c.localStart === time)!;
    // Demi-heures (retour du club, 2026-10-22) : 13:00, 13:30… 21:00.
    expect(availability.venues[0]!.candidates.map((c) => c.localStart)).toEqual(["13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00"]);
    expect(slot(VENUE_A.id, "16:30").available).toBe(false); // 16h30–18h30 chevauche 15h–17h
    expect(slot(VENUE_A.id, "14:00").available).toBe(false); // 14h–16h chevauche 15h–17h
    expect(slot(VENUE_A.id, "15:00").available).toBe(false);
    expect(slot(VENUE_A.id, "16:00").available).toBe(false);
    expect(slot(VENUE_A.id, "17:00").available).toBe(true);
    expect(slot(VENUE_B.id, "15:00").available).toBe(true);
    expect(availability.venues[0]!.existingMatches).toHaveLength(1);
  });
});

describe("demande en cours (soft conflict)", () => {
  it("une autre demande vise B à 15h : le créneau reste sélectionnable, avec un avertissement", () => {
    const pending = [{ requestId: "r2", matchId: "m-other", startAt: at(SATURDAY, "15:00"), clubVenueId: VENUE_B.id, teamName: "U18M", opponentName: "Agde" }];
    const result = validate(SATURDAY, "15:00", { clubVenueId: VENUE_B.id, pending });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toHaveLength(1);
    const evaluation = evaluateSlot({ startAt: at(SATURDAY, "15:00"), clubVenueId: VENUE_B.id, isHome: true, targetMatchId: "target", targetTeamId: null, matches: [], pending });
    expect(evaluation.conflicts).toHaveLength(0);
    expect(evaluation.warnings[0]!.type).toBe("PENDING_REQUEST");
  });
});

describe("semaine et extérieur", () => {
  it("en semaine sans règle configurée : aucune restriction horaire arbitraire (seules durée + collisions)", () => {
    const result = validate("2026-10-14", "07:30");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.isCustomWeekday).toBe(true);
  });

  it("match extérieur : pas de gymnase, pas de plage horaire, seul le conflit d'équipe compte", () => {
    expect(validate(SATURDAY, "11:00", { isHome: false, clubVenueId: null }).ok).toBe(true);
    const availability = computeAvailability({ date: SATURDAY, timezone: TZ, rules: RULES, isHome: false, venues: [VENUE_A], matches: [], pending: [], targetMatchId: "target", targetTeamId: null, now: NOW });
    expect(availability.venues).toEqual([]);
    expect(availability.awayCandidates.length).toBeGreaterThan(0);
  });

  it("refuse un créneau passé et un match à domicile sans gymnase", () => {
    expect(validate("2026-09-26", "15:00").ok).toBe(false);
    const noVenue = validate(SATURDAY, "15:00", { clubVenueId: null });
    expect(!noVenue.ok && noVenue.code).toBe("DEROGATION_VENUE_REQUIRED");
  });
});

describe("fuseau horaire du club", () => {
  it("15:00 à Paris en heure d'été = 13:00 UTC ; en heure d'hiver = 14:00 UTC", () => {
    expect(at(SATURDAY, "15:00").toISOString()).toBe("2026-10-10T13:00:00.000Z");
    expect(at("2026-11-07", "15:00").toISOString()).toBe("2026-11-07T14:00:00.000Z");
  });
});
