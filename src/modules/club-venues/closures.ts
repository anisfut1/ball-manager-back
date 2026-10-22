import type { DbClient } from "../../db/client.js";
import { MATCH_SLOT_MINUTES } from "../issues/venue-conflicts.js";
import { parseLocalDate, zonedWallTimeToUtc } from "../../util/timezone.js";

/**
 * Indisponibilités des gymnases (demande du club, 2026-10-22) : une période
 * de jours, journée entière, matin (avant 13 h) ou après-midi (à partir de
 * 13 h), heure du club. Conflit = match À DOMICILE dans ce gymnase (créneau
 * de `MATCH_SLOT_MINUTES`) ou séance d'entraînement prévue dans ce gymnase,
 * qui chevauche l'indisponibilité.
 */
export type ClosurePeriod = "day" | "morning" | "afternoon";

export const HALF_DAY_SPLIT_HOUR = 13;

export interface ClosureRow {
  id: string;
  club_venue_id: string;
  start_date: string;
  end_date: string;
  period: ClosurePeriod;
  reason: string | null;
}

export interface VenueRow {
  id: string;
  name: string;
  venue_id: string | null;
}

export interface ConflictMatch {
  id: string;
  team_id: string | null;
  opponent_name: string | null;
  match_datetime: string;
  venue_id: string | null;
  venue_raw_label: string | null;
}

export interface ConflictTraining {
  id: string;
  team_id: string;
  starts_at: string;
  ends_at: string;
  club_venue_id: string | null;
}

export interface ClosureConflict {
  kind: "MATCH" | "TRAINING";
  id: string;
  teamName: string | null;
  opponentName: string | null;
  startsAt: string;
  endsAt: string;
}

function addDays(dateKey: string, days: number): string {
  const d = parseLocalDate(dateKey)!;
  return new Date(Date.UTC(d.year, d.month - 1, d.day + days)).toISOString().slice(0, 10);
}

/** Créneaux UTC [début, fin[ couverts par l'indisponibilité, un par jour. */
export function closureWindows(closure: Pick<ClosureRow, "start_date" | "end_date" | "period">, timezone: string): { start: Date; end: Date }[] {
  const windows: { start: Date; end: Date }[] = [];
  for (let day = closure.start_date; day <= closure.end_date; day = addDays(day, 1)) {
    const d = parseLocalDate(day);
    if (!d) break;
    const next = parseLocalDate(addDays(day, 1))!;
    const midnight = zonedWallTimeToUtc(d.year, d.month, d.day, 0, 0, 0, timezone);
    const split = zonedWallTimeToUtc(d.year, d.month, d.day, HALF_DAY_SPLIT_HOUR, 0, 0, timezone);
    const nextMidnight = zonedWallTimeToUtc(next.year, next.month, next.day, 0, 0, 0, timezone);
    if (closure.period === "morning") windows.push({ start: midnight, end: split });
    else if (closure.period === "afternoon") windows.push({ start: split, end: nextMidnight });
    else windows.push({ start: midnight, end: nextMidnight });
  }
  return windows;
}

function normalize(label: string | null): string {
  return (label ?? "").split(/\s[—–-]\s|,/)[0]!.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
}

/** Le match à domicile se joue-t-il dans ce gymnase ? Identité FFBB d'abord, sinon nom de la salle. */
export function matchInVenue(match: Pick<ConflictMatch, "venue_id" | "venue_raw_label">, venue: VenueRow): boolean {
  if (match.venue_id && venue.venue_id) return match.venue_id === venue.venue_id;
  const label = normalize(match.venue_raw_label);
  return label !== "" && label === normalize(venue.name);
}

export function closureConflicts(
  closure: ClosureRow,
  input: { venue: VenueRow; matches: readonly ConflictMatch[]; trainings: readonly ConflictTraining[]; teamNameById: ReadonlyMap<string, string>; timezone: string },
): ClosureConflict[] {
  const windows = closureWindows(closure, input.timezone);
  const overlaps = (start: Date, end: Date) => windows.some((w) => start < w.end && end > w.start);
  const conflicts: ClosureConflict[] = [];
  for (const m of input.matches) {
    if (!matchInVenue(m, input.venue)) continue;
    const start = new Date(m.match_datetime);
    const end = new Date(start.getTime() + MATCH_SLOT_MINUTES * 60_000);
    if (overlaps(start, end)) {
      conflicts.push({ kind: "MATCH", id: m.id, teamName: m.team_id ? (input.teamNameById.get(m.team_id) ?? null) : null, opponentName: m.opponent_name, startsAt: start.toISOString(), endsAt: end.toISOString() });
    }
  }
  for (const t of input.trainings) {
    if (t.club_venue_id !== input.venue.id) continue;
    const start = new Date(t.starts_at);
    const end = new Date(t.ends_at);
    if (overlaps(start, end)) {
      conflicts.push({ kind: "TRAINING", id: t.id, teamName: input.teamNameById.get(t.team_id) ?? null, opponentName: null, startsAt: start.toISOString(), endsAt: end.toISOString() });
    }
  }
  return conflicts.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export interface ClosureDto {
  id: string;
  clubVenueId: string;
  venueName: string;
  startDate: string;
  endDate: string;
  period: ClosurePeriod;
  reason: string | null;
  conflicts: ClosureConflict[];
}

export const CLOSURE_COLUMNS = "id, club_venue_id, start_date, end_date, period, reason";

/** Indisponibilités (déjà filtrées) avec leurs conflits : matchs à domicile et séances prévues. */
export async function withConflicts(db: DbClient, clubId: string, timezone: string, closures: readonly ClosureRow[]): Promise<ClosureDto[]> {
  if (closures.length === 0) return [];
  const from = closures.reduce((min, c) => (c.start_date < min ? c.start_date : min), closures[0]!.start_date);
  const to = closures.reduce((max, c) => (c.end_date > max ? c.end_date : max), closures[0]!.end_date);
  // Bornes larges (± 1 jour) : le tri fin se fait dans le fuseau du club.
  const fromIso = new Date(`${addDays(from, -1)}T00:00:00Z`).toISOString();
  const toIso = new Date(`${addDays(to, 2)}T00:00:00Z`).toISOString();

  const [{ data: venues, error: venuesError }, { data: matches, error: matchesError }, { data: trainings, error: trainingsError }, { data: teams }] = await Promise.all([
    db.from("club_venues").select("id, name, venue_id").eq("club_id", clubId),
    db.from("matches").select("id, team_id, opponent_name, match_datetime, venue_id, venue_raw_label, is_home, status").eq("club_id", clubId).gte("match_datetime", fromIso).lt("match_datetime", toIso),
    db.from("training_occurrences").select("id, team_id, starts_at, ends_at, club_venue_id, status").eq("club_id", clubId).eq("status", "scheduled").lt("starts_at", toIso).gt("ends_at", fromIso),
    db.from("teams").select("id, name").eq("club_id", clubId),
  ]);
  if (venuesError) throw new Error(`Lecture des gymnases échouée : ${venuesError.message}`);
  if (matchesError) throw new Error(`Lecture des matchs échouée : ${matchesError.message}`);
  if (trainingsError) throw new Error(`Lecture des entraînements échouée : ${trainingsError.message}`);

  const venueById = new Map((venues ?? []).map((v) => [v.id, v as VenueRow]));
  const homeMatches = (matches ?? []).filter((m): m is typeof m & { match_datetime: string } => Boolean(m.match_datetime) && m.is_home !== false && m.status !== "cancelled" && m.status !== "postponed");
  const teamNameById = new Map((teams ?? []).map((t) => [t.id, t.name]));

  return closures.map((closure) => {
    const venue = venueById.get(closure.club_venue_id);
    return {
      id: closure.id,
      clubVenueId: closure.club_venue_id,
      venueName: venue?.name ?? "Gymnase",
      startDate: closure.start_date,
      endDate: closure.end_date,
      period: closure.period,
      reason: closure.reason,
      conflicts: venue ? closureConflicts(closure, { venue, matches: homeMatches, trainings: (trainings ?? []) as ConflictTraining[], teamNameById, timezone }) : [],
    };
  });
}
