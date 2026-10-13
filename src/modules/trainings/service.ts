import type { DbClient } from "../../db/client.js";
import { badRequest, conflict, forbidden, notFound } from "../../api-error.js";
import type {
  PlanningEventDto,
  TrainingAttendanceValue,
  TrainingCountsDto,
  TrainingOccurrenceDto,
  TrainingResponseValue,
  TrainingSeriesDto,
} from "../../contracts/trainings.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import { localDateKey } from "../../util/timezone.js";
import { generateOccurrences, localToUtc } from "./recurrence.js";
import { notifyTrainingChange } from "../push/hooks.js";

/**
 * Vie d'équipe — entraînements (Lot 1, voir docs/TEAM_LIFE.md). Logique
 * commune à l'espace club (comptes) et à l'espace public (lien personnel) :
 * les routes ne font que construire le contexte et appeler ces fonctions.
 */

/** Qui agit : admin du club, coach de certaines équipes, et/ou licencié (lien personnel). */
export interface TrainingActor {
  isAdmin: boolean;
  coachTeamIds: "ALL" | ReadonlySet<string>;
  userId: string | null;
  licencieId: string | null;
}

export interface TrainingCtx {
  db: DbClient;
  clubId: string;
  timezone: string;
  actor: TrainingActor;
}

/** Licencié coach (lien personnel) de cette équipe : jamais interrogé pour ses propres entraînements. */
export function coachesTeam(l: { public_coach?: boolean | null; coached_team_ids?: string[] | null }, teamId: string): boolean {
  return l.public_coach === true && (l.coached_team_ids ?? []).includes(teamId);
}

export function canManageTeam(actor: TrainingActor, teamId: string): boolean {
  return actor.isAdmin || actor.coachTeamIds === "ALL" || actor.coachTeamIds.has(teamId);
}

function requireManage(ctx: TrainingCtx, teamId: string): void {
  if (!canManageTeam(ctx.actor, teamId)) throw forbidden("Réservé aux coachs de cette équipe et aux administrateurs du club.", "TEAM_MANAGER_REQUIRED");
}

interface SeriesRow {
  id: string;
  club_id: string;
  team_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  club_venue_id: string | null;
  location_label: string | null;
  starts_on: string;
  ends_on: string;
}

interface OccurrenceRow {
  id: string;
  club_id: string;
  team_id: string;
  series_id: string | null;
  series_date: string | null;
  starts_at: string;
  ends_at: string;
  club_venue_id: string | null;
  location_label: string | null;
  status: "scheduled" | "cancelled";
  cancel_reason: string | null;
  is_modified: boolean;
}

const SERIES_COLUMNS = "id, club_id, team_id, weekday, start_time, end_time, club_venue_id, location_label, starts_on, ends_on";
const OCCURRENCE_COLUMNS = "id, club_id, team_id, series_id, series_date, starts_at, ends_at, club_venue_id, location_label, status, cancel_reason, is_modified";

const hhmm = (time: string) => time.slice(0, 5);

function today(ctx: TrainingCtx): string {
  return localDateKey(new Date(), ctx.timezone);
}

function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

async function loadTeam(ctx: TrainingCtx, teamId: string): Promise<{ id: string; name: string }> {
  const { data } = await ctx.db.from("teams").select("id, name, sexe").eq("id", teamId).eq("club_id", ctx.clubId).maybeSingle();
  if (!data) throw notFound("Équipe introuvable pour ce club.");
  return { id: data.id, name: formatTeamNameWithGender(data.name, data.sexe) };
}

async function teamNames(ctx: TrainingCtx, teamIds: string[]): Promise<Map<string, string>> {
  if (teamIds.length === 0) return new Map();
  const { data } = await ctx.db.from("teams").select("id, name, sexe").eq("club_id", ctx.clubId).in("id", teamIds);
  return new Map((data ?? []).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));
}

async function venues(ctx: TrainingCtx): Promise<Map<string, { name: string; address: string | null }>> {
  const { data } = await ctx.db.from("club_venues").select("id, name, address").eq("club_id", ctx.clubId);
  return new Map((data ?? []).map((v) => [v.id, { name: v.name, address: v.address ?? null }]));
}

async function checkVenue(ctx: TrainingCtx, clubVenueId: string | null | undefined): Promise<void> {
  if (!clubVenueId) return;
  const { data } = await ctx.db.from("club_venues").select("id").eq("id", clubVenueId).eq("club_id", ctx.clubId).maybeSingle();
  if (!data) throw badRequest("Gymnase introuvable pour ce club.", "VENUE_NOT_FOUND");
}

function location(venueMap: Map<string, { name: string; address: string | null }>, clubVenueId: string | null, label: string | null) {
  const venue = clubVenueId ? venueMap.get(clubVenueId) : undefined;
  return { clubVenueId, label: label ?? venue?.name ?? null, address: label ? null : (venue?.address ?? null) };
}

/**
 * Effectif d'une équipe à l'entraînement : licenciés actifs rattachés
 * (`team_id`), SAUF ceux qui coachent cette équipe (retour du club,
 * 2026-10-10 : « faut pas demander au coach s'il est dispo à l'entraînement »).
 */
async function rosters(ctx: TrainingCtx, teamIds: string[]): Promise<Map<string, { id: string; first_name: string; last_name: string; photo_url: string | null }[]>> {
  const out = new Map<string, { id: string; first_name: string; last_name: string; photo_url: string | null }[]>();
  if (teamIds.length === 0) return out;
  const { data } = await ctx.db.from("licencies").select("id, first_name, last_name, photo_url, team_id, public_coach, coached_team_ids").eq("club_id", ctx.clubId).eq("active", true).in("team_id", teamIds);
  for (const l of data ?? []) {
    if (!l.team_id) continue;
    if (coachesTeam(l, l.team_id)) continue;
    out.set(l.team_id, [...(out.get(l.team_id) ?? []), { id: l.id, first_name: l.first_name, last_name: l.last_name, photo_url: l.photo_url ?? null }]);
  }
  return out;
}

async function responsesFor(ctx: TrainingCtx, occurrenceIds: string[]): Promise<{ occurrence_id: string; licencie_id: string; response: TrainingResponseValue; responded_at: string }[]> {
  if (occurrenceIds.length === 0) return [];
  const { data } = await ctx.db.from("training_responses").select("occurrence_id, licencie_id, response, responded_at").eq("club_id", ctx.clubId).in("occurrence_id", occurrenceIds);
  return (data ?? []) as { occurrence_id: string; licencie_id: string; response: TrainingResponseValue; responded_at: string }[];
}

function countsFor(occurrence: OccurrenceRow, roster: { id: string }[], responses: { occurrence_id: string; licencie_id: string; response: TrainingResponseValue }[]): TrainingCountsDto {
  const members = new Set(roster.map((r) => r.id));
  const mine = responses.filter((r) => r.occurrence_id === occurrence.id && members.has(r.licencie_id));
  const present = mine.filter((r) => r.response === "PRESENT").length;
  const absent = mine.filter((r) => r.response === "ABSENT").length;
  const uncertain = mine.filter((r) => r.response === "UNCERTAIN").length;
  return { present, absent, uncertain, noResponse: members.size - mine.length, total: members.size };
}

/** Séances → DTO (avec les compteurs pour qui gère l'équipe, jamais pour un parent). */
async function attendanceFor(ctx: TrainingCtx, occurrenceIds: string[]): Promise<{ occurrence_id: string; licencie_id: string; status: TrainingAttendanceValue }[]> {
  if (occurrenceIds.length === 0) return [];
  const { data } = await ctx.db.from("training_attendance").select("occurrence_id, licencie_id, status").eq("club_id", ctx.clubId).in("occurrence_id", occurrenceIds);
  return (data ?? []) as { occurrence_id: string; licencie_id: string; status: TrainingAttendanceValue }[];
}

function attendanceSummary(marks: { status: TrainingAttendanceValue }[]) {
  return { late: marks.filter((m) => m.status === "LATE").length, absent: marks.filter((m) => m.status === "ABSENT").length, recorded: marks.length > 0 };
}

async function toDtos(ctx: TrainingCtx, rows: OccurrenceRow[]): Promise<TrainingOccurrenceDto[]> {
  const teamIds = [...new Set(rows.map((r) => r.team_id))];
  const managed = teamIds.filter((id) => canManageTeam(ctx.actor, id));
  const nowIso = new Date().toISOString();
  const startedManaged = rows.filter((r) => canManageTeam(ctx.actor, r.team_id) && r.starts_at <= nowIso).map((r) => r.id);
  const [names, venueMap, rosterMap, responses, marks] = await Promise.all([
    teamNames(ctx, teamIds),
    venues(ctx),
    rosters(ctx, managed),
    responsesFor(
      ctx,
      rows.filter((r) => canManageTeam(ctx.actor, r.team_id)).map((r) => r.id),
    ),
    attendanceFor(ctx, startedManaged),
  ]);
  return rows.map((r) => {
    const manage = canManageTeam(ctx.actor, r.team_id);
    return {
      id: r.id,
      seriesId: r.series_id,
      team: { id: r.team_id, name: names.get(r.team_id) ?? "Équipe" },
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      location: location(venueMap, r.club_venue_id, r.location_label),
      status: r.status,
      cancelReason: r.cancel_reason,
      isModified: r.is_modified,
      counts: manage ? countsFor(r, rosterMap.get(r.team_id) ?? [], responses) : null,
      canManage: manage,
      attendance: manage && r.starts_at <= nowIso && r.status === "scheduled" ? attendanceSummary(marks.filter((m) => m.occurrence_id === r.id)) : null,
    };
  });
}

// ─── Séries ────────────────────────────────────────────────────────────────

async function loadSeries(ctx: TrainingCtx, seriesId: string): Promise<SeriesRow> {
  const { data } = await ctx.db.from("training_series").select(SERIES_COLUMNS).eq("id", seriesId).eq("club_id", ctx.clubId).maybeSingle();
  if (!data) throw notFound("Créneau d'entraînement introuvable.");
  return data as SeriesRow;
}

/**
 * Aligne les séances FUTURES d'une série sur sa forme actuelle : crée les
 * manquantes, met à jour les non modifiées, retire celles sorties de la
 * période (supprimées sans réponse, annulées sinon). Une séance modifiée à
 * la main n'est jamais touchée ; le passé non plus.
 */
async function syncSeries(ctx: TrainingCtx, series: SeriesRow, fromDate: string): Promise<void> {
  const from = fromDate > today(ctx) ? fromDate : today(ctx);
  const wanted = generateOccurrences(
    { weekday: series.weekday, startTime: hhmm(series.start_time), endTime: hhmm(series.end_time), startsOn: series.starts_on > from ? series.starts_on : from, endsOn: series.ends_on },
    ctx.timezone,
  );
  const { data: existingRows } = await ctx.db.from("training_occurrences").select(OCCURRENCE_COLUMNS).eq("club_id", ctx.clubId).eq("series_id", series.id).gte("series_date", from);
  const existing = new Map(((existingRows ?? []) as OccurrenceRow[]).map((o) => [o.series_date!, o]));
  const wantedDates = new Set(wanted.map((w) => w.seriesDate));
  const now = new Date().toISOString();

  const inserts: Record<string, unknown>[] = [];
  for (const w of wanted) {
    const current = existing.get(w.seriesDate);
    const fields = { starts_at: w.startsAt, ends_at: w.endsAt, club_venue_id: series.club_venue_id, location_label: series.location_label };
    if (!current) inserts.push({ club_id: ctx.clubId, team_id: series.team_id, series_id: series.id, series_date: w.seriesDate, ...fields });
    else if (!current.is_modified) await ctx.db.from("training_occurrences").update({ ...fields, updated_at: now }).eq("id", current.id);
  }
  if (inserts.length > 0) {
    const { error } = await ctx.db.from("training_occurrences").insert(inserts as never);
    if (error) throw new Error(`Création des séances échouée : ${error.message}`);
  }

  const outside = [...existing.values()].filter((o) => !wantedDates.has(o.series_date!) && !o.is_modified);
  await removeOccurrences(ctx, outside, "Créneau modifié");
}

/** Retire des séances futures : supprimées si personne n'a répondu, sinon annulées (jamais en silence). */
async function removeOccurrences(ctx: TrainingCtx, rows: OccurrenceRow[], reason: string): Promise<void> {
  if (rows.length === 0) return;
  const answered = new Set((await responsesFor(ctx, rows.map((r) => r.id))).map((r) => r.occurrence_id));
  const toDelete = rows.filter((r) => !answered.has(r.id)).map((r) => r.id);
  const toCancel = rows.filter((r) => answered.has(r.id)).map((r) => r.id);
  for (const id of toDelete) await ctx.db.from("training_occurrences").delete().eq("id", id).eq("club_id", ctx.clubId);
  if (toCancel.length > 0) await ctx.db.from("training_occurrences").update({ status: "cancelled", cancel_reason: reason, updated_at: new Date().toISOString() }).in("id", toCancel);
}

export async function listSeries(ctx: TrainingCtx, teamId: string): Promise<TrainingSeriesDto[]> {
  await loadTeam(ctx, teamId);
  const { data } = await ctx.db.from("training_series").select(SERIES_COLUMNS).eq("club_id", ctx.clubId).eq("team_id", teamId);
  const rows = ((data ?? []) as SeriesRow[]).filter((s) => s.ends_on >= today(ctx));
  const venueMap = await venues(ctx);
  const { data: occ } = rows.length
    ? await ctx.db.from("training_occurrences").select("series_id, status").eq("club_id", ctx.clubId).in("series_id", rows.map((s) => s.id)).gte("starts_at", new Date().toISOString())
    : { data: [] as { series_id: string | null; status: string }[] };
  return rows
    .sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time))
    .map((s) => ({
      id: s.id,
      teamId: s.team_id,
      weekday: s.weekday,
      startTime: hhmm(s.start_time),
      endTime: hhmm(s.end_time),
      location: location(venueMap, s.club_venue_id, s.location_label),
      startsOn: s.starts_on,
      endsOn: s.ends_on,
      upcomingCount: (occ ?? []).filter((o) => o.series_id === s.id && o.status === "scheduled").length,
    }));
}

export async function createSeries(
  ctx: TrainingCtx,
  teamId: string,
  input: { slots: { weekday: number; startTime: string; endTime: string; clubVenueId?: string | null; locationLabel?: string | null }[]; startsOn: string; endsOn: string },
): Promise<TrainingSeriesDto[]> {
  requireManage(ctx, teamId);
  await loadTeam(ctx, teamId);
  for (const slot of input.slots) await checkVenue(ctx, slot.clubVenueId);
  for (const slot of input.slots) {
    const { data, error } = await ctx.db
      .from("training_series")
      .insert({
        club_id: ctx.clubId,
        team_id: teamId,
        weekday: slot.weekday,
        start_time: slot.startTime,
        end_time: slot.endTime,
        club_venue_id: slot.clubVenueId ?? null,
        location_label: slot.locationLabel ?? null,
        starts_on: input.startsOn,
        ends_on: input.endsOn,
        created_by_user_id: ctx.actor.userId,
        created_by_licencie_id: ctx.actor.licencieId,
      })
      .select(SERIES_COLUMNS)
      .single();
    if (error || !data) throw new Error(`Création du créneau échouée : ${error?.message}`);
    await syncSeries(ctx, data as SeriesRow, input.startsOn);
  }
  return listSeries(ctx, teamId);
}

/**
 * Modifier un créneau à partir d'une date (ex. « à partir de janvier, 19h30
 * au lieu de 19h ») : avant cette date rien ne change. Le créneau est coupé
 * en deux (l'ancien s'arrête la veille, un nouveau commence ce jour-là) ; les
 * séances futures restent les mêmes si le jour ne change pas (réponses
 * conservées), sinon elles sont recréées au nouveau jour.
 */
export async function updateSeries(
  ctx: TrainingCtx,
  seriesId: string,
  patch: { fromDate: string; weekday?: number; startTime?: string; endTime?: string; clubVenueId?: string | null; locationLabel?: string | null; endsOn?: string },
): Promise<TrainingSeriesDto[]> {
  const old = await loadSeries(ctx, seriesId);
  requireManage(ctx, old.team_id);
  if (patch.clubVenueId !== undefined) await checkVenue(ctx, patch.clubVenueId);
  const next = {
    weekday: patch.weekday ?? old.weekday,
    start_time: patch.startTime ?? hhmm(old.start_time),
    end_time: patch.endTime ?? hhmm(old.end_time),
    club_venue_id: patch.clubVenueId !== undefined ? patch.clubVenueId : old.club_venue_id,
    location_label: patch.locationLabel !== undefined ? patch.locationLabel : old.location_label,
    ends_on: patch.endsOn ?? old.ends_on,
  };
  if (next.end_time <= next.start_time) throw badRequest("L'heure de fin doit être après l'heure de début.");
  const from = patch.fromDate > today(ctx) ? patch.fromDate : today(ctx);
  if (next.ends_on < from) throw badRequest("La date de fin doit être après la date de début de la modification.");
  const now = new Date().toISOString();

  let target: SeriesRow;
  if (from <= old.starts_on) {
    const { data } = await ctx.db.from("training_series").update({ ...next, updated_at: now }).eq("id", old.id).select(SERIES_COLUMNS).single();
    target = data as SeriesRow;
  } else {
    const { data, error } = await ctx.db
      .from("training_series")
      .insert({ club_id: ctx.clubId, team_id: old.team_id, ...next, starts_on: from, created_by_user_id: ctx.actor.userId, created_by_licencie_id: ctx.actor.licencieId })
      .select(SERIES_COLUMNS)
      .single();
    if (error || !data) throw new Error(`Modification du créneau échouée : ${error?.message}`);
    target = data as SeriesRow;
    await ctx.db.from("training_series").update({ ends_on: addDays(from, -1), updated_at: now }).eq("id", old.id);

    const { data: futureRows } = await ctx.db.from("training_occurrences").select(OCCURRENCE_COLUMNS).eq("club_id", ctx.clubId).eq("series_id", old.id).gte("series_date", from);
    const future = (futureRows ?? []) as OccurrenceRow[];
    if (next.weekday === old.weekday) {
      // Même jour : les séances (et leurs réponses) passent au nouveau créneau, puis sont recalées.
      if (future.length > 0) await ctx.db.from("training_occurrences").update({ series_id: target.id, updated_at: now }).in("id", future.map((o) => o.id));
    } else {
      await removeOccurrences(ctx, future.filter((o) => !o.is_modified), "Créneau déplacé");
      const kept = future.filter((o) => o.is_modified).map((o) => o.id);
      if (kept.length > 0) await ctx.db.from("training_occurrences").update({ series_id: target.id, updated_at: now }).in("id", kept);
    }
  }
  await syncSeries(ctx, target, from);
  return listSeries(ctx, old.team_id);
}

/** Supprimer un créneau à partir d'une date : séances futures retirées (annulées si quelqu'un a répondu). */
export async function stopSeries(ctx: TrainingCtx, seriesId: string, fromDate: string | undefined): Promise<TrainingSeriesDto[]> {
  const series = await loadSeries(ctx, seriesId);
  requireManage(ctx, series.team_id);
  const from = fromDate && fromDate > today(ctx) ? fromDate : today(ctx);
  const { data: futureRows } = await ctx.db.from("training_occurrences").select(OCCURRENCE_COLUMNS).eq("club_id", ctx.clubId).eq("series_id", series.id).gte("series_date", from);
  await removeOccurrences(ctx, ((futureRows ?? []) as OccurrenceRow[]).filter((o) => o.status === "scheduled"), "Créneau supprimé");
  if (from <= series.starts_on) await ctx.db.from("training_series").delete().eq("id", series.id).eq("club_id", ctx.clubId);
  else await ctx.db.from("training_series").update({ ends_on: addDays(from, -1), updated_at: new Date().toISOString() }).eq("id", series.id);
  return listSeries(ctx, series.team_id);
}

// ─── Séances ───────────────────────────────────────────────────────────────

async function loadOccurrence(ctx: TrainingCtx, occurrenceId: string): Promise<OccurrenceRow> {
  const { data } = await ctx.db.from("training_occurrences").select(OCCURRENCE_COLUMNS).eq("id", occurrenceId).eq("club_id", ctx.clubId).maybeSingle();
  if (!data) throw notFound("Séance introuvable.");
  return data as OccurrenceRow;
}

export async function listOccurrences(ctx: TrainingCtx, input: { teamIds: string[] | "ALL"; from: string; to: string }): Promise<TrainingOccurrenceDto[]> {
  let query = ctx.db.from("training_occurrences").select(OCCURRENCE_COLUMNS).eq("club_id", ctx.clubId).gte("starts_at", input.from).lt("starts_at", input.to);
  if (input.teamIds !== "ALL") {
    if (input.teamIds.length === 0) return [];
    query = query.in("team_id", input.teamIds);
  }
  const { data } = await query.order("starts_at", { ascending: true });
  return toDtos(ctx, (data ?? []) as OccurrenceRow[]);
}

/** Détail d'une séance : la liste nominative des réponses n'est visible que de qui gère l'équipe. */
export async function occurrenceDetail(ctx: TrainingCtx, occurrenceId: string) {
  const occurrence = await loadOccurrence(ctx, occurrenceId);
  requireManage(ctx, occurrence.team_id);
  const [[training], rosterMap, responses, marks] = await Promise.all([toDtos(ctx, [occurrence]), rosters(ctx, [occurrence.team_id]), responsesFor(ctx, [occurrence.id]), attendanceFor(ctx, [occurrence.id])]);
  const byLicencie = new Map(responses.map((r) => [r.licencie_id, r]));
  const markOf = new Map(marks.map((m) => [m.licencie_id, m.status]));
  const order: Record<string, number> = { PRESENT: 0, UNCERTAIN: 1, ABSENT: 2 };
  const roster = (rosterMap.get(occurrence.team_id) ?? [])
    .map((l) => {
      const r = byLicencie.get(l.id);
      return { licencie: { id: l.id, firstName: l.first_name, lastName: l.last_name, photoUrl: l.photo_url }, response: r?.response ?? null, respondedAt: r?.responded_at ?? null, attendance: markOf.get(l.id) ?? null };
    })
    .sort((a, b) => (a.response ? order[a.response]! : 3) - (b.response ? order[b.response]! : 3) || a.licencie.lastName.localeCompare(b.licencie.lastName, "fr"));
  return { training: training!, roster };
}

/** Modifier UNE séance (date, horaires, lieu) : la série n'est jamais modifiée. */
export async function updateOccurrence(
  ctx: TrainingCtx,
  occurrenceId: string,
  input: { date: string; startTime: string; endTime: string; clubVenueId?: string | null; locationLabel?: string | null },
): Promise<TrainingOccurrenceDto> {
  const occurrence = await loadOccurrence(ctx, occurrenceId);
  requireManage(ctx, occurrence.team_id);
  if (input.clubVenueId !== undefined) await checkVenue(ctx, input.clubVenueId);
  const patch = {
    starts_at: localToUtc(input.date, input.startTime, ctx.timezone),
    ends_at: localToUtc(input.date, input.endTime, ctx.timezone),
    club_venue_id: input.clubVenueId !== undefined ? input.clubVenueId : occurrence.club_venue_id,
    location_label: input.locationLabel !== undefined ? input.locationLabel : occurrence.location_label,
    is_modified: true,
    updated_at: new Date().toISOString(),
  };
  const { data } = await ctx.db.from("training_occurrences").update(patch).eq("id", occurrence.id).select(OCCURRENCE_COLUMNS).single();
  const changed = data as OccurrenceRow;
  if (occurrence.status === "scheduled" && (changed.starts_at !== occurrence.starts_at || changed.ends_at !== occurrence.ends_at || changed.club_venue_id !== occurrence.club_venue_id || changed.location_label !== occurrence.location_label)) {
    await notifyTrainingChange(ctx.db, { clubId: ctx.clubId, occurrence: { id: changed.id, team_id: changed.team_id, starts_at: changed.starts_at, updated_at: patch.updated_at }, change: "changed" });
  }
  return (await toDtos(ctx, [changed]))[0]!;
}

export async function setOccurrenceStatus(ctx: TrainingCtx, occurrenceId: string, status: "scheduled" | "cancelled", reason: string | null): Promise<TrainingOccurrenceDto> {
  const occurrence = await loadOccurrence(ctx, occurrenceId);
  requireManage(ctx, occurrence.team_id);
  const { data } = await ctx.db
    .from("training_occurrences")
    .update({ status, cancel_reason: status === "cancelled" ? reason : null, updated_at: new Date().toISOString() })
    .eq("id", occurrence.id)
    .select(OCCURRENCE_COLUMNS)
    .single();
  if (status === "cancelled" && occurrence.status !== "cancelled") {
    await notifyTrainingChange(ctx.db, { clubId: ctx.clubId, occurrence: { id: occurrence.id, team_id: occurrence.team_id, starts_at: occurrence.starts_at }, change: "cancelled" });
  }
  return (await toDtos(ctx, [data as OccurrenceRow]))[0]!;
}

/**
 * Réponse Présent / Absent / Incertain pour un licencié de l'équipe, jusqu'à
 * la fin de la séance. Qui répond est déduit du contexte (compte ou lien
 * personnel), jamais du corps de la requête.
 */
export async function respond(ctx: TrainingCtx, occurrenceId: string, licencieId: string, response: TrainingResponseValue) {
  const occurrence = await loadOccurrence(ctx, occurrenceId);
  if (occurrence.status === "cancelled") throw conflict("Cet entraînement est annulé.", "TRAINING_CANCELLED");
  if (occurrence.ends_at <= new Date().toISOString()) throw conflict("Cet entraînement est terminé.", "TRAINING_PAST");
  const { data: licencie } = await ctx.db.from("licencies").select("id, team_id").eq("id", licencieId).eq("club_id", ctx.clubId).maybeSingle();
  if (!licencie || licencie.team_id !== occurrence.team_id) throw forbidden("Ce licencié ne fait pas partie de cette équipe.", "NOT_IN_TEAM");
  const now = new Date().toISOString();
  const { data, error } = await ctx.db
    .from("training_responses")
    .upsert(
      { club_id: ctx.clubId, occurrence_id: occurrence.id, licencie_id: licencieId, response, responded_at: now, responded_by_user_id: ctx.actor.userId, responded_by_licencie_id: ctx.actor.licencieId, updated_at: now },
      { onConflict: "occurrence_id,licencie_id" },
    )
    .select("occurrence_id, licencie_id, response, responded_at")
    .single();
  if (error || !data) throw new Error(`Réponse non enregistrée : ${error?.message}`);
  return { occurrenceId: data.occurrence_id, licencieId: data.licencie_id, response: data.response as TrainingResponseValue, respondedAt: data.responded_at };
}

/** Réponses existantes de licenciés donnés (Home). */
export async function responsesOf(ctx: TrainingCtx, occurrenceIds: string[], licencieIds: string[]) {
  if (occurrenceIds.length === 0 || licencieIds.length === 0) return [];
  const { data } = await ctx.db.from("training_responses").select("occurrence_id, licencie_id, response").eq("club_id", ctx.clubId).in("occurrence_id", occurrenceIds).in("licencie_id", licencieIds);
  return (data ?? []) as { occurrence_id: string; licencie_id: string; response: TrainingResponseValue }[];
}

// ─── Planning ──────────────────────────────────────────────────────────────

/** Matchs FFBB (lus dans `matches`, jamais recopiés) + entraînements, triés par date. */
export async function planning(ctx: TrainingCtx, input: { teamIds: string[] | "ALL"; from: string; to: string; kinds?: ("MATCH" | "TRAINING")[] }): Promise<PlanningEventDto[]> {
  const kinds = input.kinds ?? ["MATCH", "TRAINING"];
  const events: PlanningEventDto[] = [];
  if (kinds.includes("TRAINING")) {
    for (const t of await listOccurrences(ctx, input)) {
      events.push({ kind: "TRAINING", id: t.id, team: t.team, startsAt: t.startsAt, endsAt: t.endsAt, title: "Entraînement", isHome: null, location: t.location.label, status: t.status });
    }
  }
  if (kinds.includes("MATCH") && (input.teamIds === "ALL" || input.teamIds.length > 0)) {
    let query = ctx.db.from("matches").select("id, team_id, match_datetime, opponent_name, is_home, venue_raw_label, status").eq("club_id", ctx.clubId).gte("match_datetime", input.from).lt("match_datetime", input.to);
    if (input.teamIds !== "ALL") query = query.in("team_id", input.teamIds);
    const { data: matches } = await query;
    const names = await teamNames(ctx, [...new Set((matches ?? []).map((m) => m.team_id).filter((id): id is string => Boolean(id)))]);
    for (const m of matches ?? []) {
      if (!m.match_datetime) continue;
      events.push({
        kind: "MATCH",
        id: m.id,
        team: m.team_id ? { id: m.team_id, name: names.get(m.team_id) ?? "Équipe" } : null,
        startsAt: m.match_datetime,
        endsAt: null,
        title: m.opponent_name ?? "Match",
        isHome: m.is_home,
        location: m.venue_raw_label,
        status: m.status,
      });
    }
  }
  return events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

// ─── Présence réelle (après le début de la séance) ─────────────────────────

/**
 * Le coach relève les absents et les retards d'une séance commencée
 * (retour du club, 2026-10-10). Pas de relevé = présent.
 */
export async function markAttendance(ctx: TrainingCtx, occurrenceId: string, licencieId: string, status: TrainingAttendanceValue) {
  const occurrence = await loadOccurrence(ctx, occurrenceId);
  requireManage(ctx, occurrence.team_id);
  if (occurrence.status === "cancelled") throw conflict("Cet entraînement est annulé.", "TRAINING_CANCELLED");
  if (occurrence.starts_at > new Date().toISOString()) throw conflict("La présence se relève une fois la séance commencée.", "TRAINING_NOT_STARTED");
  const roster = (await rosters(ctx, [occurrence.team_id])).get(occurrence.team_id) ?? [];
  if (!roster.some((l) => l.id === licencieId)) throw forbidden("Ce licencié ne fait pas partie de cette équipe.", "NOT_IN_TEAM");
  const now = new Date().toISOString();
  await ctx.db
    .from("training_attendance")
    .upsert(
      { club_id: ctx.clubId, occurrence_id: occurrence.id, licencie_id: licencieId, status, marked_at: now, marked_by_user_id: ctx.actor.userId, marked_by_licencie_id: ctx.actor.licencieId, updated_at: now },
      { onConflict: "occurrence_id,licencie_id" },
    );
  return { occurrenceId: occurrence.id, licencieId, status };
}
