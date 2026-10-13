import { badRequest, conflict, forbidden, notFound } from "../../api-error.js";
import type {
  AvailabilityCountsDto,
  ConvocationCountsDto,
  ConvocationResponseValue,
  MatchAvailabilityValue,
  MatchSnapshotDto,
  MatchTeamLifeDto,
  TeamLifeMatchDto,
} from "../../contracts/convocations.js";
import { formatTeamNameWithGender } from "../../util/team-name.js";
import { canManageTeam, coachesTeam, type TrainingCtx } from "../trainings/service.js";
import { audienceFor, renderConvocationMessage, type ConvocationAudience } from "./render.js";
import { laundryDutiesFor, laundryOf } from "./laundry.js";
import { notify } from "../push/service.js";
import { paths } from "../../links/links.js";

/**
 * Vie d'équipe — Lot 2 : disponibilités des matchs et convocations (voir
 * docs/TEAM_LIFE.md). Commun à l'espace club (comptes) et à l'espace public
 * (lien personnel) : les routes construisent le contexte, tout le reste est ici.
 *
 * DISPONIBLE ≠ CONVOQUÉ ≠ CONFIRMÉ. Les matchs restent la source FFBB : la
 * convocation garde une PHOTO du match envoyé et signale toute différence au
 * coach, sans jamais modifier en silence ce que les familles ont lu.
 */

export interface MatchRow {
  id: string;
  club_id: string;
  team_id: string | null;
  match_datetime: string | null;
  is_home: boolean | null;
  opponent_name: string | null;
  venue_id: string | null;
  venue_raw_label: string | null;
  status: string;
}

export interface ConvocationRow {
  id: string;
  match_id: string;
  team_id: string;
  draft_licencie_ids: string[];
  draft_meeting_at: string | null;
  draft_meeting_point: string | null;
  draft_meeting_venue_id: string | null;
  draft_coach_message: string | null;
  revision: number;
  meeting_at: string | null;
  meeting_point: string | null;
  meeting_venue_id: string | null;
  coach_message: string | null;
  match_snapshot: MatchSnapshotDto | null;
  sent_at: string | null;
  /** Dernière relance des « en attente » (affichée aux familles concernées). */
  reminded_at?: string | null;
}

export interface RecipientRow {
  convocation_id: string;
  licencie_id: string;
  response: ConvocationResponseValue;
  responded_at: string | null;
  removed_at: string | null;
}

export interface RosterEntry {
  id: string;
  first_name: string;
  last_name: string;
  photo_url: string | null;
  birth_date: string | null;
}

const MATCH_COLUMNS = "id, club_id, team_id, match_datetime, is_home, opponent_name, venue_id, venue_raw_label, status";
const CONVOCATION_COLUMNS =
  "id, match_id, team_id, draft_licencie_ids, draft_meeting_at, draft_meeting_point, draft_meeting_venue_id, draft_coach_message, revision, meeting_at, meeting_point, meeting_venue_id, coach_message, match_snapshot, sent_at, reminded_at";

/** Matchs proposés au coach sur la Home (demander / préparer / suivre). */
export const COACH_MATCH_DAYS = 14;
/** Disponibilités et convocations visibles des familles. */
export const FAMILY_MATCH_DAYS = 21;

export function requireManage(ctx: TrainingCtx, teamId: string): void {
  if (!canManageTeam(ctx.actor, teamId)) throw forbidden("Réservé aux coachs de cette équipe et aux administrateurs du club.", "TEAM_MANAGER_REQUIRED");
}

/** Match fermé : annulé, reporté, joué, forfait, ou déjà commencé — plus de demande ni de confirmation. */
export function isMatchClosed(match: { status: string; match_datetime: string | null }, now: Date = new Date()): boolean {
  if (match.status !== "scheduled") return true;
  return match.match_datetime !== null && new Date(match.match_datetime).getTime() <= now.getTime();
}

// ─── Lecture ─────────────────────────────────────────────────────────────────

async function loadMatches(ctx: TrainingCtx, ids: string[]): Promise<MatchRow[]> {
  if (ids.length === 0) return [];
  const { data } = await ctx.db.from("matches").select(MATCH_COLUMNS).eq("club_id", ctx.clubId).in("id", ids);
  return (data ?? []) as MatchRow[];
}

export async function loadMatch(ctx: TrainingCtx, matchId: string): Promise<MatchRow & { team_id: string }> {
  const [match] = await loadMatches(ctx, [matchId]);
  if (!match) throw notFound("Match introuvable pour ce club.");
  if (!match.team_id) throw conflict("Ce match n'est rattaché à aucune équipe du club.", "MATCH_WITHOUT_TEAM");
  return match as MatchRow & { team_id: string };
}

/** Match → DTO : nom d'équipe, salle (gymnase du club si la salle FFBB y est rattachée). */
export async function toMatchDtos(ctx: TrainingCtx, matches: MatchRow[]): Promise<Map<string, TeamLifeMatchDto>> {
  const teamIds = [...new Set(matches.map((m) => m.team_id).filter((id): id is string => Boolean(id)))];
  const venueIds = [...new Set(matches.map((m) => m.venue_id).filter((id): id is string => Boolean(id)))];
  const [teams, venues, clubVenues] = await Promise.all([
    teamIds.length ? ctx.db.from("teams").select("id, name, sexe").eq("club_id", ctx.clubId).in("id", teamIds) : Promise.resolve({ data: [] }),
    venueIds.length ? ctx.db.from("venues").select("id, name, address").in("id", venueIds) : Promise.resolve({ data: [] }),
    venueIds.length ? ctx.db.from("club_venues").select("venue_id, name, address").eq("club_id", ctx.clubId).in("venue_id", venueIds) : Promise.resolve({ data: [] }),
  ]);
  const teamName = new Map(((teams.data ?? []) as { id: string; name: string; sexe: "M" | "F" | null }[]).map((t) => [t.id, formatTeamNameWithGender(t.name, t.sexe)]));
  const venue = new Map(((venues.data ?? []) as { id: string; name: string | null; address: string | null }[]).map((v) => [v.id, v]));
  const clubVenue = new Map(((clubVenues.data ?? []) as { venue_id: string | null; name: string; address: string | null }[]).filter((v) => v.venue_id).map((v) => [v.venue_id!, v]));
  return new Map(
    matches.map((m) => {
      const cv = m.venue_id ? clubVenue.get(m.venue_id) : undefined;
      const v = m.venue_id ? venue.get(m.venue_id) : undefined;
      return [
        m.id,
        {
          id: m.id,
          team: { id: m.team_id ?? "", name: (m.team_id && teamName.get(m.team_id)) || "Équipe" },
          startsAt: m.match_datetime,
          isHome: m.is_home,
          opponent: m.opponent_name,
          venueName: cv?.name ?? v?.name ?? m.venue_raw_label ?? null,
          venueAddress: cv?.address ?? v?.address ?? null,
          status: m.status,
        },
      ];
    }),
  );
}

/** Effectif du match : joueurs de l'équipe, sans ceux qui la coachent (retour du club, 2026-10-10 : « le coach n'a pas besoin de confirmer sa dispo au match »). */
export async function roster(ctx: TrainingCtx, teamId: string): Promise<RosterEntry[]> {
  const { data } = await ctx.db.from("licencies").select("id, first_name, last_name, photo_url, birth_date, public_coach, coached_team_ids").eq("club_id", ctx.clubId).eq("active", true).eq("team_id", teamId);
  return ((data ?? []) as (RosterEntry & { public_coach?: boolean; coached_team_ids?: string[] })[]).filter((l) => !coachesTeam(l, teamId)).sort((a, b) => a.last_name.localeCompare(b.last_name, "fr") || a.first_name.localeCompare(b.first_name, "fr"));
}

export async function availabilityRequest(ctx: TrainingCtx, matchId: string, teamId: string) {
  const { data } = await ctx.db.from("match_availability_requests").select("id, opened_at, reminded_at").eq("club_id", ctx.clubId).eq("match_id", matchId).eq("team_id", teamId).maybeSingle();
  return data as { id: string; opened_at: string; reminded_at?: string | null } | null;
}

export async function convocationOf(ctx: TrainingCtx, matchId: string, teamId: string): Promise<ConvocationRow | null> {
  const { data } = await ctx.db.from("match_convocations").select(CONVOCATION_COLUMNS).eq("club_id", ctx.clubId).eq("match_id", matchId).eq("team_id", teamId).maybeSingle();
  return (data as ConvocationRow | null) ?? null;
}

export async function recipientsOf(ctx: TrainingCtx, convocationIds: string[]): Promise<RecipientRow[]> {
  if (convocationIds.length === 0) return [];
  const { data } = await ctx.db.from("match_convocation_recipients").select("convocation_id, licencie_id, response, responded_at, removed_at").eq("club_id", ctx.clubId).in("convocation_id", convocationIds);
  return (data ?? []) as RecipientRow[];
}

function availabilityCounts(rosterIds: string[], responses: Map<string, MatchAvailabilityValue>): AvailabilityCountsDto {
  const c = { available: 0, unavailable: 0, uncertain: 0, noResponse: 0, total: rosterIds.length };
  for (const id of rosterIds) {
    const r = responses.get(id);
    if (r === "AVAILABLE") c.available += 1;
    else if (r === "UNAVAILABLE") c.unavailable += 1;
    else if (r === "UNCERTAIN") c.uncertain += 1;
    else c.noResponse += 1;
  }
  return c;
}

function convocationCounts(active: RecipientRow[]): ConvocationCountsDto {
  return {
    convoked: active.length,
    confirmed: active.filter((r) => r.response === "CONFIRMED").length,
    declined: active.filter((r) => r.response === "DECLINED").length,
    pending: active.filter((r) => r.response === "PENDING").length,
  };
}

function snapshotOf(match: TeamLifeMatchDto): MatchSnapshotDto {
  return { startsAt: match.startsAt ?? "", isHome: match.isHome, opponent: match.opponent, venueName: match.venueName, venueAddress: match.venueAddress, teamName: match.team.name };
}

/** Ce qui a changé côté FFBB depuis l'envoi (jamais corrigé en silence). */
export function matchChangesSince(snapshot: MatchSnapshotDto | null, match: TeamLifeMatchDto): ("DATE" | "VENUE" | "STATUS")[] {
  if (!snapshot) return [];
  const out: ("DATE" | "VENUE" | "STATUS")[] = [];
  if ((match.startsAt ? new Date(match.startsAt).getTime() : null) !== (snapshot.startsAt ? new Date(snapshot.startsAt).getTime() : null)) out.push("DATE");
  if ((match.venueName ?? "") !== (snapshot.venueName ?? "")) out.push("VENUE");
  if (match.status !== "scheduled") out.push("STATUS");
  return out;
}

/** Lieu de rendez-vous effectif : à domicile, le gymnase du match par défaut. */
function effectiveMeetingPoint(draftPoint: string | null, match: TeamLifeMatchDto): string | null {
  if (draftPoint?.trim()) return draftPoint.trim();
  return match.isHome !== false ? match.venueName : null;
}

export const licRef = (l: RosterEntry) => ({ id: l.id, firstName: l.first_name, lastName: l.last_name, photoUrl: l.photo_url ?? null });

// ─── Écran coach ─────────────────────────────────────────────────────────────

export async function matchTeamLife(ctx: TrainingCtx, matchId: string): Promise<MatchTeamLifeDto> {
  const match = await loadMatch(ctx, matchId);
  requireManage(ctx, match.team_id);
  const dto = (await toMatchDtos(ctx, [match])).get(match.id)!;
  const [people, request, convocation] = await Promise.all([roster(ctx, match.team_id), availabilityRequest(ctx, match.id, match.team_id), convocationOf(ctx, match.id, match.team_id)]);

  const responses = new Map<string, { response: MatchAvailabilityValue; responded_at: string }>();
  if (request) {
    const { data } = await ctx.db.from("match_availability_responses").select("licencie_id, response, responded_at").eq("club_id", ctx.clubId).eq("request_id", request.id);
    for (const r of (data ?? []) as { licencie_id: string; response: MatchAvailabilityValue; responded_at: string }[]) responses.set(r.licencie_id, r);
  }
  const order: Record<string, number> = { AVAILABLE: 0, UNCERTAIN: 1, NONE: 2, UNAVAILABLE: 3 };
  const availabilityRoster = people
    .map((l) => ({ licencie: licRef(l), response: responses.get(l.id)?.response ?? null, respondedAt: responses.get(l.id)?.responded_at ?? null }))
    .sort((a, b) => order[a.response ?? "NONE"]! - order[b.response ?? "NONE"]!);

  let convocationDto: MatchTeamLifeDto["convocation"] = null;
  if (convocation) {
    const recipients = (await recipientsOf(ctx, [convocation.id])).filter((r) => !r.removed_at);
    const byId = new Map(people.map((l) => [l.id, l]));
    // Un convoqué qui aurait quitté l'équipe reste visible (nom chargé à part).
    const missing = recipients.filter((r) => !byId.has(r.licencie_id)).map((r) => r.licencie_id);
    if (missing.length) {
      const { data } = await ctx.db.from("licencies").select("id, first_name, last_name, photo_url, birth_date").eq("club_id", ctx.clubId).in("id", missing);
      for (const l of (data ?? []) as RosterEntry[]) byId.set(l.id, l);
    }
    const sentIds = new Set(recipients.map((r) => r.licencie_id));
    const draftIds = new Set(convocation.draft_licencie_ids ?? []);
    const draftPoint = effectiveMeetingPoint(convocation.draft_meeting_point, dto);
    const hasUnsentChanges =
      convocation.revision > 0 &&
      (draftIds.size !== sentIds.size ||
        [...draftIds].some((id) => !sentIds.has(id)) ||
        new Date(convocation.draft_meeting_at ?? 0).getTime() !== new Date(convocation.meeting_at ?? 0).getTime() ||
        (draftPoint ?? "") !== (convocation.meeting_point ?? "") ||
        (convocation.draft_coach_message ?? "") !== (convocation.coach_message ?? ""));
    const rank: Record<ConvocationResponseValue, number> = { DECLINED: 0, PENDING: 1, CONFIRMED: 2 };
    convocationDto = {
      id: convocation.id,
      revision: convocation.revision,
      sentAt: convocation.sent_at,
      draft: { licencieIds: [...draftIds], meetingAt: convocation.draft_meeting_at, meetingPoint: convocation.draft_meeting_point, meetingVenueId: convocation.draft_meeting_venue_id, coachMessage: convocation.draft_coach_message },
      sent: convocation.revision > 0 && convocation.match_snapshot ? { meetingAt: convocation.meeting_at, meetingPoint: convocation.meeting_point, coachMessage: convocation.coach_message, matchSnapshot: convocation.match_snapshot } : null,
      hasUnsentChanges,
      remindedAt: remindedSince(convocation.reminded_at, convocation.sent_at),
      matchChanges: convocation.revision > 0 ? matchChangesSince(convocation.match_snapshot, dto) : [],
      counts: convocationCounts(recipients),
      recipients: recipients
        .filter((r) => byId.has(r.licencie_id))
        .map((r) => ({ licencie: licRef(byId.get(r.licencie_id)!), response: r.response, respondedAt: r.responded_at }))
        .sort((a, b) => rank[a.response] - rank[b.response] || a.licencie.lastName.localeCompare(b.licencie.lastName, "fr")),
    };
  }

  return {
    match: dto,
    canManage: true,
    matchClosed: isMatchClosed(match),
    laundry: await laundryOf(ctx, match),
    availability: {
      openedAt: request?.opened_at ?? null,
      remindedAt: request?.reminded_at ?? null,
      counts: availabilityCounts(people.map((l) => l.id), new Map([...responses].map(([id, r]) => [id, r.response]))),
      roster: availabilityRoster,
    },
    convocation: convocationDto,
  };
}

// ─── Disponibilités ──────────────────────────────────────────────────────────

/** « Demander les disponibilités » : ne crée JAMAIS de convocation. */
export async function openAvailability(ctx: TrainingCtx, matchId: string): Promise<MatchTeamLifeDto> {
  const match = await loadMatch(ctx, matchId);
  requireManage(ctx, match.team_id);
  if (isMatchClosed(match)) throw conflict("Ce match est passé, annulé ou reporté.", "MATCH_CLOSED");
  await ctx.db
    .from("match_availability_requests")
    .upsert({ club_id: ctx.clubId, match_id: match.id, team_id: match.team_id, opened_by_user_id: ctx.actor.userId, opened_by_licencie_id: ctx.actor.licencieId }, { onConflict: "match_id,team_id", ignoreDuplicates: true });
  const result = await matchTeamLife(ctx, matchId);
  await notify(ctx.db, {
    clubId: ctx.clubId,
    kind: "AVAILABILITY_REQUEST",
    dedupeKey: `availability:${match.id}:${match.team_id}`,
    licencieIds: result.availability.roster.filter((r) => !r.response).map((r) => r.licencie.id),
    title: "Disponibilités",
    body: "Le coach demande tes disponibilités pour un prochain match.",
    path: (slug) => paths.match(slug, match.id),
  });
  return result;
}

/** Une relance antérieure au dernier envoi ne compte plus (la mise à jour remet tout le monde « en attente »). */
function remindedSince(remindedAt: string | null | undefined, sentAt: string | null): string | null {
  if (!remindedAt) return null;
  return sentAt && remindedAt < sentAt ? null : remindedAt;
}

/**
 * Relance en un clic des « sans réponse » (retour du club, 2026-10-10) :
 * convocation envoyée → les « en attente » ; sinon disponibilités demandées
 * → les sans réponse. Marque la relance (Home des familles concernées :
 * « Le coach attend ta réponse ») — aucun email / SMS / push en V1.
 */
export async function remindNoResponse(ctx: TrainingCtx, matchId: string): Promise<MatchTeamLifeDto> {
  const match = await loadMatch(ctx, matchId);
  requireManage(ctx, match.team_id);
  if (isMatchClosed(match)) throw conflict("Ce match est passé, annulé ou reporté.", "MATCH_CLOSED");
  const current = await matchTeamLife(ctx, matchId);
  const now = new Date().toISOString();
  let waiting: string[];
  if (current.convocation?.sent) {
    if (current.convocation.counts.pending === 0) throw conflict("Tous les convoqués ont déjà répondu.", "NOTHING_TO_REMIND");
    await ctx.db.from("match_convocations").update({ reminded_at: now }).eq("club_id", ctx.clubId).eq("id", current.convocation.id);
    waiting = current.convocation.recipients.filter((r) => r.response === "PENDING").map((r) => r.licencie.id);
  } else if (current.availability.openedAt) {
    if (current.availability.counts.noResponse === 0) throw conflict("Tout le monde a déjà répondu.", "NOTHING_TO_REMIND");
    await ctx.db.from("match_availability_requests").update({ reminded_at: now }).eq("club_id", ctx.clubId).eq("match_id", match.id).eq("team_id", match.team_id);
    waiting = current.availability.roster.filter((r) => !r.response).map((r) => r.licencie.id);
  } else {
    throw conflict("Aucune demande en cours : demande d'abord les disponibilités.", "NOTHING_TO_REMIND");
  }
  await notify(ctx.db, {
    clubId: ctx.clubId,
    kind: "RESPONSE_REMINDER",
    dedupeKey: `reminder:${match.id}:${match.team_id}:${now}`,
    licencieIds: waiting,
    title: "Réponse attendue",
    body: "Le coach attend ta réponse pour un prochain match.",
    path: (slug) => (current.convocation?.sent ? paths.convocation(slug, match.id) : paths.match(slug, match.id)),
  });
  return matchTeamLife(ctx, matchId);
}

/** Réponse d'un licencié de l'équipe (jamais un autre, même UUID connu). */
export async function respondAvailability(ctx: TrainingCtx, matchId: string, licencieId: string, response: MatchAvailabilityValue) {
  const match = await loadMatch(ctx, matchId);
  if (isMatchClosed(match)) throw conflict("Ce match est passé, annulé ou reporté.", "MATCH_CLOSED");
  const { data: licencie } = await ctx.db.from("licencies").select("id, team_id").eq("id", licencieId).eq("club_id", ctx.clubId).maybeSingle();
  if (!licencie || licencie.team_id !== match.team_id) throw forbidden("Ce licencié ne fait pas partie de cette équipe.", "NOT_IN_TEAM");
  const request = await availabilityRequest(ctx, match.id, match.team_id);
  if (!request) throw conflict("Le coach n'a pas encore demandé les disponibilités pour ce match.", "AVAILABILITY_NOT_OPEN");
  const now = new Date().toISOString();
  const { data, error } = await ctx.db
    .from("match_availability_responses")
    .upsert(
      { club_id: ctx.clubId, request_id: request.id, licencie_id: licencieId, response, responded_at: now, responded_by_user_id: ctx.actor.userId, responded_by_licencie_id: ctx.actor.licencieId, updated_at: now },
      { onConflict: "request_id,licencie_id" },
    )
    .select("licencie_id, response, responded_at")
    .single();
  if (error || !data) throw new Error(`Disponibilité non enregistrée : ${error?.message}`);
  return { matchId: match.id, licencieId, response: data.response as MatchAvailabilityValue, respondedAt: data.responded_at as string };
}

// ─── Convocation : brouillon, aperçu, envoi ─────────────────────────────────

async function ensureConvocation(ctx: TrainingCtx, match: MatchRow & { team_id: string }): Promise<ConvocationRow> {
  const existing = await convocationOf(ctx, match.id, match.team_id);
  if (existing) return existing;
  // Première préparation : les disponibles sont présélectionnés (le coach décide ensuite).
  const request = await availabilityRequest(ctx, match.id, match.team_id);
  let preselected: string[] = [];
  if (request) {
    const { data } = await ctx.db.from("match_availability_responses").select("licencie_id, response").eq("club_id", ctx.clubId).eq("request_id", request.id);
    const teamIds = new Set((await roster(ctx, match.team_id)).map((l) => l.id));
    preselected = ((data ?? []) as { licencie_id: string; response: string }[]).filter((r) => r.response === "AVAILABLE" && teamIds.has(r.licencie_id)).map((r) => r.licencie_id);
  }
  await ctx.db
    .from("match_convocations")
    .upsert({ club_id: ctx.clubId, match_id: match.id, team_id: match.team_id, draft_licencie_ids: preselected }, { onConflict: "match_id,team_id", ignoreDuplicates: true });
  const created = await convocationOf(ctx, match.id, match.team_id);
  if (!created) throw new Error("Convocation non créée.");
  return created;
}

export interface DraftPatch {
  licencieIds?: string[];
  meetingAt?: string | null;
  meetingPoint?: string | null;
  meetingVenueId?: string | null;
  coachMessage?: string | null;
}

/** Brouillon (sélection, rendez-vous, message) : jamais visible des familles avant « Envoyer ». */
export async function saveDraft(ctx: TrainingCtx, matchId: string, patch: DraftPatch): Promise<MatchTeamLifeDto> {
  const match = await loadMatch(ctx, matchId);
  requireManage(ctx, match.team_id);
  const convocation = await ensureConvocation(ctx, match);
  const update: { updated_at: string; draft_licencie_ids?: string[]; draft_meeting_at?: string | null; draft_meeting_point?: string | null; draft_meeting_venue_id?: string | null; draft_coach_message?: string | null } = { updated_at: new Date().toISOString() };
  if (patch.licencieIds !== undefined) {
    const allowed = new Set((await roster(ctx, match.team_id)).map((l) => l.id));
    // Déjà convoqué puis sorti de l'équipe : peut rester sélectionné.
    for (const r of await recipientsOf(ctx, [convocation.id])) if (!r.removed_at) allowed.add(r.licencie_id);
    const unknown = patch.licencieIds.filter((id) => !allowed.has(id));
    if (unknown.length) throw badRequest("Seuls les joueurs de cette équipe peuvent être convoqués.", "NOT_IN_TEAM");
    update.draft_licencie_ids = [...new Set(patch.licencieIds)];
  }
  if (patch.meetingAt !== undefined) update.draft_meeting_at = patch.meetingAt ? new Date(patch.meetingAt).toISOString() : null;
  if (patch.meetingPoint !== undefined) update.draft_meeting_point = patch.meetingPoint?.trim() || null;
  if (patch.meetingVenueId !== undefined) {
    if (patch.meetingVenueId) {
      const { data } = await ctx.db.from("club_venues").select("id").eq("id", patch.meetingVenueId).eq("club_id", ctx.clubId).maybeSingle();
      if (!data) throw badRequest("Gymnase introuvable pour ce club.", "VENUE_NOT_FOUND");
    }
    update.draft_meeting_venue_id = patch.meetingVenueId;
  }
  if (patch.coachMessage !== undefined) update.draft_coach_message = patch.coachMessage?.trim() || null;
  await ctx.db.from("match_convocations").update(update).eq("id", convocation.id).eq("club_id", ctx.clubId);
  return matchTeamLife(ctx, matchId);
}

interface Prepared {
  match: MatchRow & { team_id: string };
  dto: TeamLifeMatchDto;
  convocation: ConvocationRow;
  selected: RosterEntry[];
  meetingAt: string | null;
  meetingPoint: string | null;
  blockers: string[];
  unavailableSelected: string[];
}

async function prepare(ctx: TrainingCtx, matchId: string): Promise<Prepared> {
  const match = await loadMatch(ctx, matchId);
  requireManage(ctx, match.team_id);
  const dto = (await toMatchDtos(ctx, [match])).get(match.id)!;
  const convocation = await ensureConvocation(ctx, match);
  const ids = convocation.draft_licencie_ids ?? [];
  const { data } = ids.length ? await ctx.db.from("licencies").select("id, first_name, last_name, photo_url, birth_date").eq("club_id", ctx.clubId).in("id", ids) : { data: [] };
  const selected = ((data ?? []) as RosterEntry[]).sort((a, b) => a.last_name.localeCompare(b.last_name, "fr"));

  const meetingPoint = effectiveMeetingPoint(convocation.draft_meeting_point, dto);
  const blockers: string[] = [];
  if (isMatchClosed(match)) blockers.push("Le match est passé, annulé ou reporté.");
  if (!dto.startsAt) blockers.push("La date du match n'est pas encore connue.");
  if (selected.length === 0) blockers.push("Sélectionne au moins un joueur.");
  if (!convocation.draft_meeting_at) blockers.push("Indique l'heure de rendez-vous.");
  if (!meetingPoint) blockers.push(dto.isHome === false ? "Match à l'extérieur : indique le lieu de rendez-vous." : "Indique le lieu de rendez-vous.");

  const request = await availabilityRequest(ctx, match.id, match.team_id);
  let unavailableSelected: string[] = [];
  if (request && ids.length) {
    const { data: r } = await ctx.db.from("match_availability_responses").select("licencie_id, response").eq("club_id", ctx.clubId).eq("request_id", request.id).in("licencie_id", ids);
    const unavailable = new Set(((r ?? []) as { licencie_id: string; response: string }[]).filter((x) => x.response === "UNAVAILABLE").map((x) => x.licencie_id));
    unavailableSelected = selected.filter((l) => unavailable.has(l.id)).map((l) => l.first_name);
  }
  return { match, dto, convocation, selected, meetingAt: convocation.draft_meeting_at, meetingPoint, blockers, unavailableSelected };
}

function messageFor(ctx: TrainingCtx, p: { dto: TeamLifeMatchDto; meetingAt: string | null; meetingPoint: string | null; coachMessage: string | null; laundryLicencieId?: string | null }, player: RosterEntry, snapshot?: MatchSnapshotDto): { audience: ConvocationAudience; text: string } {
  const startsAt = snapshot?.startsAt ?? p.dto.startsAt ?? "";
  const audience = audienceFor(player.birth_date, startsAt || new Date().toISOString());
  const text = renderConvocationMessage({
    audience,
    playerFirstName: player.first_name,
    teamName: snapshot?.teamName ?? p.dto.team.name,
    opponent: snapshot ? snapshot.opponent : p.dto.opponent,
    isHome: snapshot ? snapshot.isHome : p.dto.isHome,
    matchStartsAt: startsAt,
    matchVenue: { name: snapshot ? snapshot.venueName : p.dto.venueName, address: snapshot ? snapshot.venueAddress : p.dto.venueAddress },
    meetingAt: p.meetingAt,
    meetingPoint: p.meetingPoint,
    coachMessage: p.coachMessage,
    timezone: ctx.timezone,
    laundry: Boolean(p.laundryLicencieId && p.laundryLicencieId === player.id),
  });
  return { audience, text };
}

/** Aperçu avant envoi : un exemple « parent » et un exemple « joueur majeur » si la sélection en contient. */
export async function previewConvocation(ctx: TrainingCtx, matchId: string) {
  const p = await prepare(ctx, matchId);
  const samples: { audience: ConvocationAudience; firstName: string; text: string }[] = [];
  const seen = new Set<ConvocationAudience>();
  for (const player of p.selected) {
    if (!p.dto.startsAt) break;
    const m = messageFor(ctx, { ...p, coachMessage: p.convocation.draft_coach_message }, player);
    if (seen.has(m.audience)) continue;
    seen.add(m.audience);
    samples.push({ audience: m.audience, firstName: player.first_name, text: m.text });
  }
  return { recipientsCount: p.selected.length, samples, unavailableSelected: p.unavailableSelected, blockers: p.blockers };
}

/**
 * Envoi (ou mise à jour) : photo du match, révision + 1, message rendu pour
 * chacun et gardé tel quel. Convoqués retirés : gardés pour l'historique
 * (removed_at). Si l'heure, le lieu ou le match ont changé, les réponses déjà
 * données repassent « en attente » (les familles doivent reconfirmer).
 */
export async function sendConvocation(ctx: TrainingCtx, matchId: string): Promise<MatchTeamLifeDto> {
  const p = await prepare(ctx, matchId);
  if (p.blockers.length) throw badRequest(p.blockers.join(" "), "CONVOCATION_INCOMPLETE");
  const snapshot = snapshotOf(p.dto);
  const previous = p.convocation;
  const meetingAt = new Date(p.meetingAt!).toISOString();
  const essentialsChanged =
    previous.revision > 0 &&
    (new Date(previous.meeting_at ?? 0).getTime() !== new Date(meetingAt).getTime() || (previous.meeting_point ?? "") !== (p.meetingPoint ?? "") || matchChangesSince(previous.match_snapshot, p.dto).length > 0);
  const revision = previous.revision + 1;
  const now = new Date().toISOString();

  await ctx.db
    .from("match_convocations")
    .update({
      revision,
      meeting_at: meetingAt,
      meeting_point: p.meetingPoint,
      meeting_venue_id: previous.draft_meeting_venue_id,
      coach_message: previous.draft_coach_message,
      match_snapshot: snapshot,
      draft_meeting_point: p.meetingPoint,
      sent_at: now,
      sent_by_user_id: ctx.actor.userId,
      sent_by_licencie_id: ctx.actor.licencieId,
      updated_at: now,
    })
    .eq("id", previous.id)
    .eq("club_id", ctx.clubId);

  const existing = new Map((await recipientsOf(ctx, [previous.id])).map((r) => [r.licencie_id, r]));
  const selectedIds = new Set(p.selected.map((l) => l.id));
  for (const player of p.selected) {
    const current = existing.get(player.id);
    if (!current) {
      await ctx.db.from("match_convocation_recipients").insert({ club_id: ctx.clubId, convocation_id: previous.id, licencie_id: player.id, response: "PENDING" });
    } else if (current.removed_at || essentialsChanged) {
      await ctx.db
        .from("match_convocation_recipients")
        .update({ removed_at: null, response: "PENDING", responded_at: null, responded_by_user_id: null, responded_by_licencie_id: null, updated_at: now })
        .eq("convocation_id", previous.id)
        .eq("licencie_id", player.id);
    }
  }
  const removed = [...existing.values()].filter((r) => !r.removed_at && !selectedIds.has(r.licencie_id)).map((r) => r.licencie_id);
  if (removed.length) await ctx.db.from("match_convocation_recipients").update({ removed_at: now, updated_at: now }).eq("convocation_id", previous.id).in("licencie_id", removed);

  // Maillots attribués AVANT l'envoi : ligne ajoutée au message de la famille concernée seulement.
  const laundryLicencieId = (await laundryOf(ctx, p.match)).assignee?.licencie.id ?? null;
  const dispatches = p.selected.map((player) => ({
    club_id: ctx.clubId,
    convocation_id: previous.id,
    licencie_id: player.id,
    revision,
    rendered_message: messageFor(ctx, { dto: p.dto, meetingAt, meetingPoint: p.meetingPoint, coachMessage: previous.draft_coach_message, laundryLicencieId }, player, snapshot).text,
    sent_at: now,
  }));
  if (dispatches.length) await ctx.db.from("match_convocation_dispatches").insert(dispatches);

  // Push : première convocation → tous ; mise à jour → tous si l'heure, le lieu
  // ou le match ont changé (reconfirmation), sinon seulement les nouveaux convoqués.
  const added = p.selected.filter((l) => !existing.get(l.id) || existing.get(l.id)!.removed_at).map((l) => l.id);
  const updated = revision > 1 && essentialsChanged;
  await notify(ctx.db, {
    clubId: ctx.clubId,
    kind: updated ? "CONVOCATION_UPDATED" : "CONVOCATION_NEW",
    dedupeKey: `convocation:${previous.id}:r${revision}`,
    licencieIds: updated ? p.selected.map((l) => l.id) : revision === 1 ? p.selected.map((l) => l.id) : added,
    title: updated ? "Convocation modifiée" : "Nouvelle convocation",
    body: updated ? "L'heure ou le lieu a changé : confirme à nouveau ta présence." : "Tu es convoqué pour un prochain match. Confirme ta présence.",
    path: (slug) => paths.convocation(slug, p.match.id),
  });
  return matchTeamLife(ctx, matchId);
}

/** « Je confirme » / « Je ne peux pas venir » : seulement un convoqué, match non fermé. */
export async function respondConvocation(ctx: TrainingCtx, matchId: string, licencieId: string, response: "CONFIRMED" | "DECLINED") {
  const match = await loadMatch(ctx, matchId);
  const convocation = await convocationOf(ctx, match.id, match.team_id);
  if (!convocation || convocation.revision === 0) throw notFound("Aucune convocation envoyée pour ce match.");
  const { data: recipient } = await ctx.db.from("match_convocation_recipients").select("licencie_id, removed_at").eq("club_id", ctx.clubId).eq("convocation_id", convocation.id).eq("licencie_id", licencieId).maybeSingle();
  if (!recipient || recipient.removed_at) throw forbidden("Ce licencié n'est pas convoqué pour ce match.", "NOT_CONVOKED");
  if (isMatchClosed(match)) throw conflict("Ce match est passé, annulé ou reporté : la convocation ne peut plus être confirmée.", "MATCH_CLOSED");
  const now = new Date().toISOString();
  await ctx.db
    .from("match_convocation_recipients")
    .update({ response, responded_at: now, responded_by_user_id: ctx.actor.userId, responded_by_licencie_id: ctx.actor.licencieId, updated_at: now })
    .eq("convocation_id", convocation.id)
    .eq("licencie_id", licencieId);
  return { matchId: match.id, licencieId, response, respondedAt: now };
}

/**
 * Table de marque des matchs à domicile (retour du club, 2026-10-10 : « table
 * prévue pour le match, 1/4 postes définis ») : postes pourvus / postes à
 * pourvoir (4, ou 3 sans arbitre club).
 */
async function tableStatus(ctx: TrainingCtx, homeMatchIds: string[]): Promise<Map<string, { filled: number; total: number }>> {
  const out = new Map<string, { filled: number; total: number }>();
  if (homeMatchIds.length === 0) return out;
  const [{ data: rows }, { data: overrides }] = await Promise.all([
    ctx.db.from("table_assignments").select("match_id, role").eq("club_id", ctx.clubId).in("match_id", homeMatchIds),
    ctx.db.from("match_referee_overrides").select("match_id, no_referee_needed").eq("club_id", ctx.clubId).in("match_id", homeMatchIds),
  ]);
  const noReferee = new Set(((overrides ?? []) as { match_id: string; no_referee_needed: boolean }[]).filter((o) => o.no_referee_needed).map((o) => o.match_id));
  for (const id of homeMatchIds) {
    const roles = new Set(((rows ?? []) as { match_id: string; role: string }[]).filter((r) => r.match_id === id).map((r) => r.role));
    if (noReferee.has(id)) roles.delete("REFEREE");
    out.set(id, { filled: roles.size, total: noReferee.has(id) ? 3 : 4 });
  }
  return out;
}

// ─── Home « À faire » ────────────────────────────────────────────────────────

export interface HomePerson {
  licencieId: string;
  firstName: string;
  teamId: string | null;
  coachTeams: string[];
}

/**
 * Actions « matchs » de la Home : disponibilité à donner, convocation à
 * confirmer (message tel qu'envoyé), et pour le coach l'étape suivante de
 * chaque match proche (demander, préparer, suivre).
 */
export async function matchHomeActions(ctx: TrainingCtx, people: HomePerson[], now: Date = new Date()) {
  const playerTeams = [...new Set(people.map((p) => p.teamId).filter((id): id is string => Boolean(id)))];
  const coachTeams = [...new Set(people.flatMap((p) => p.coachTeams))].filter((id) => canManageTeam(ctx.actor, id));
  const teams = [...new Set([...playerTeams, ...coachTeams])];
  if (teams.length === 0) return [];
  const until = new Date(now.getTime() + FAMILY_MATCH_DAYS * 86_400_000).toISOString();
  const { data } = await ctx.db.from("matches").select(MATCH_COLUMNS).eq("club_id", ctx.clubId).in("team_id", teams).gte("match_datetime", now.toISOString()).lte("match_datetime", until);
  const matches = ((data ?? []) as MatchRow[]).filter((m) => m.team_id).sort((a, b) => (a.match_datetime ?? "").localeCompare(b.match_datetime ?? ""));
  if (matches.length === 0) return [];
  const ids = matches.map((m) => m.id);
  const dtos = await toMatchDtos(ctx, matches);

  const [{ data: requests }, { data: convs }] = await Promise.all([
    ctx.db.from("match_availability_requests").select("id, match_id, team_id, reminded_at").eq("club_id", ctx.clubId).in("match_id", ids),
    ctx.db.from("match_convocations").select(CONVOCATION_COLUMNS).eq("club_id", ctx.clubId).in("match_id", ids),
  ]);
  const requestOf = new Map(((requests ?? []) as { id: string; match_id: string; team_id: string; reminded_at?: string | null }[]).map((r) => [`${r.match_id}:${r.team_id}`, r]));
  const convOf = new Map(((convs ?? []) as ConvocationRow[]).filter((c) => c.revision > 0).map((c) => [`${c.match_id}:${c.team_id}`, c]));
  const requestIds = [...requestOf.values()].map((r) => r.id);
  const { data: avail } = requestIds.length ? await ctx.db.from("match_availability_responses").select("request_id, licencie_id, response").eq("club_id", ctx.clubId).in("request_id", requestIds) : { data: [] };
  const availability = (avail ?? []) as { request_id: string; licencie_id: string; response: MatchAvailabilityValue }[];
  const recipients = await recipientsOf(ctx, [...convOf.values()].map((c) => c.id));
  const convIds = [...convOf.values()].map((c) => c.id);
  const { data: disp } = convIds.length && people.length ? await ctx.db.from("match_convocation_dispatches").select("convocation_id, licencie_id, revision, rendered_message").eq("club_id", ctx.clubId).in("convocation_id", convIds).in("licencie_id", people.map((p) => p.licencieId)) : { data: [] };
  const dispatches = (disp ?? []) as { convocation_id: string; licencie_id: string; revision: number; rendered_message: string }[];

  const actions: unknown[] = [];
  for (const person of people) {
    if (!person.teamId) continue;
    // Coach de sa propre équipe : ni disponibilité ni convocation à donner.
    if (person.coachTeams.includes(person.teamId)) continue;
    for (const m of matches.filter((x) => x.team_id === person.teamId)) {
      const key = `${m.id}:${m.team_id}`;
      const dto = dtos.get(m.id)!;
      const conv = convOf.get(key);
      const recipient = conv ? recipients.find((r) => r.convocation_id === conv.id && r.licencie_id === person.licencieId && !r.removed_at) : undefined;
      if (conv && recipient && conv.match_snapshot) {
        const sent = dispatches.filter((d) => d.convocation_id === conv.id && d.licencie_id === person.licencieId).sort((a, b) => b.revision - a.revision)[0];
        actions.push({
          type: "CONVOCATION_RESPONSE",
          licencieId: person.licencieId,
          firstName: person.firstName,
          match: dto,
          convocation: { revision: conv.revision, meetingAt: conv.meeting_at, meetingPoint: conv.meeting_point, coachMessage: conv.coach_message, matchSnapshot: conv.match_snapshot, message: sent?.rendered_message ?? "" },
          currentResponse: recipient.response,
          matchClosed: isMatchClosed(m, now),
          reminded: recipient.response === "PENDING" && remindedSince(conv.reminded_at, conv.sent_at) !== null,
        });
        continue;
      }
      // Convocation envoyée sans cette personne : plus de question de disponibilité.
      if (conv) continue;
      const request = requestOf.get(key);
      if (request && !isMatchClosed(m, now)) {
        const r = availability.find((a) => a.request_id === request.id && a.licencie_id === person.licencieId);
        actions.push({ type: "MATCH_AVAILABILITY", licencieId: person.licencieId, firstName: person.firstName, match: dto, currentResponse: r?.response ?? null, reminded: !r && Boolean(request.reminded_at) });
      }
    }
  }

  const coachUntil = now.getTime() + COACH_MATCH_DAYS * 86_400_000;
  const { data: laundryRows } = await ctx.db.from("match_laundry_assignments").select("match_id, team_id").eq("club_id", ctx.clubId).in("match_id", ids);
  const laundryAssigned = new Set(((laundryRows ?? []) as { match_id: string; team_id: string }[]).map((r) => `${r.match_id}:${r.team_id}`));
  const tables = await tableStatus(ctx, matches.filter((m) => m.is_home === true && m.team_id && coachTeams.includes(m.team_id)).map((m) => m.id));
  for (const teamId of coachTeams) {
    const coach = people.find((p) => p.coachTeams.includes(teamId));
    if (!coach) continue;
    const teamRoster = (await roster(ctx, teamId)).map((l) => l.id);
    for (const m of matches.filter((x) => x.team_id === teamId && new Date(x.match_datetime ?? 0).getTime() <= coachUntil && !isMatchClosed(x, now))) {
      const key = `${m.id}:${teamId}`;
      const dto = dtos.get(m.id)!;
      const conv = convOf.get(key);
      const request = requestOf.get(key);
      if (conv) {
        const active = recipients.filter((r) => r.convocation_id === conv.id && !r.removed_at);
        actions.push({ type: "COACH_MATCH", coachLicencieId: coach.licencieId, match: dto, stage: "CONVOCATION_SENT", availabilityCounts: null, convocationCounts: convocationCounts(active), matchChanged: matchChangesSince(conv.match_snapshot, dto).length > 0, tables: tables.get(m.id) ?? null, laundryAssigned: laundryAssigned.has(key) });
      } else if (request) {
        const responses = new Map(availability.filter((a) => a.request_id === request.id).map((a) => [a.licencie_id, a.response]));
        actions.push({ type: "COACH_MATCH", coachLicencieId: coach.licencieId, match: dto, stage: "PREPARE_CONVOCATION", availabilityCounts: availabilityCounts(teamRoster, responses), convocationCounts: null, matchChanged: false, tables: tables.get(m.id) ?? null, laundryAssigned: laundryAssigned.has(key) });
      } else {
        actions.push({ type: "COACH_MATCH", coachLicencieId: coach.licencieId, match: dto, stage: "ASK_AVAILABILITY", availabilityCounts: null, convocationCounts: null, matchChanged: false, tables: tables.get(m.id) ?? null, laundryAssigned: laundryAssigned.has(key) });
      }
    }
  }
  return actions;
}

/** Maillots sur la Home : du jour où c'est attribué jusqu'à 2 jours après le match (« après le match »). */
export const LAUNDRY_AFTER_DAYS = 2;

export async function laundryHomeActions(ctx: TrainingCtx, people: HomePerson[], now: Date = new Date()) {
  const duties = await laundryDutiesFor(ctx, people.map((p) => p.licencieId));
  if (duties.length === 0) return [];
  const matches = (await loadMatches(ctx, [...new Set(duties.map((d) => d.match_id))])).filter((m) => m.match_datetime && new Date(m.match_datetime).getTime() >= now.getTime() - LAUNDRY_AFTER_DAYS * 86_400_000 && m.status !== "cancelled");
  const dtos = await toMatchDtos(ctx, matches);
  return duties
    .filter((d) => dtos.has(d.match_id))
    .map((d) => ({ type: "LAUNDRY_DUTY" as const, licencieId: d.licencie_id, firstName: people.find((p) => p.licencieId === d.licencie_id)?.firstName ?? "", match: dtos.get(d.match_id)!, seenAt: d.seen_at }));
}
