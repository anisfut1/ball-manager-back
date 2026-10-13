import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership } from "../../auth/middleware.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../api-error.js";
import { createServiceSupabaseClient, type DbClient } from "../../db/client.js";
import {
  CreateDerogationRequestDtoSchema,
  DerogationActionDtoSchema,
  DerogationAvailabilityQueryDtoSchema,
  DerogationRequestListQueryDtoSchema,
  DerogationSlotCheckQueryDtoSchema,
  PostDerogationMessageDtoSchema,
  ProposeDerogationSlotDtoSchema,
} from "../../contracts/derogation-requests.js";
import { DEFAULT_MATCH_DURATION_MINUTES, DEFAULT_SLOT_STEP_MINUTES } from "../../scheduling/match-slot.js";
import { localTimeKey, parseLocalDate, zonedWallTimeToUtc } from "../../util/timezone.js";
import { computeAvailability, validateRequestedSlot, type CandidateSlot, type SlotConflict, type SlotWarning } from "./availability.js";
import { canCreateForTeam, canManageRequests, canPerformAction, canPropose, canCreateAny, canReadRequest, canSubmitOfficial, isAuthor, nextStatus, roleLabelFor, type Actor } from "./policy.js";
import { CreateDerogationDtoSchema } from "../../contracts/derogations.js";
import { createDerogationForClub } from "../derogations/create-derogation.js";
import { notifyDerogationRequest } from "./notify.js";
import { notify } from "../push/service.js";
import { paths } from "../../links/links.js";
import {
  REQUEST_COLUMNS,
  buildDetail,
  buildSummaries,
  coordinatorsConfigured,
  loadActor,
  loadClubVenues,
  loadMatch,
  loadMatchLabels,
  loadPendingProposals,
  loadPlanningRules,
  loadRequest,
  loadScheduledMatches,
  matchRef,
  requestRef,
  resolveRequesterName,
  venueRefs,
  type ClubVenueRow,
  type MatchRow,
  type RequestRow,
} from "./service.js";

/**
 * DEMANDES DE DÉROGATION INTERNES (coach → coordinateur), retour du club
 * 2026-10-01. Le logiciel ORGANISE, VÉRIFIE et FACILITE LA COMMUNICATION ;
 * le coordinateur DÉCIDE et effectue la dérogation officielle. Aucune route
 * de ce module n'écrit sur FFBB/FBI ni ne modifie `matches` (voir les tests
 * "aucune écriture externe").
 */

export const NO_COORDINATOR_MESSAGE = "Aucun coordinateur n'est actuellement configuré pour recevoir les demandes de dérogation.";

const service = (): DbClient => createServiceSupabaseClient();

function formatSlot(startAt: Date, timezone: string, venueName: string | null): string {
  const day = startAt.toLocaleDateString("fr-FR", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" });
  return `${day} à ${localTimeKey(startAt, timezone)}${venueName ? ` — ${venueName}` : ""}`;
}

/** « U13 M contre MEZE LOUPIAN (samedi 3 octobre) » pour l'email au coordinateur. */
async function matchLabelFor(ctx: Ctx, match: MatchRow): Promise<string> {
  const { teamName } = await loadMatchLabels(ctx.db, [match]);
  const team = match.team_id ? (teamName.get(match.team_id) ?? null) : null;
  const day = match.match_datetime ? new Date(match.match_datetime).toLocaleDateString("fr-FR", { timeZone: ctx.timezone, weekday: "long", day: "numeric", month: "long" }) : null;
  const label = [team ?? "le match", match.opponent_name ? `contre ${match.opponent_name}` : null].filter(Boolean).join(" ");
  return day ? `${label} (${day})` : label;
}

/** Prévient les coordinateurs (jamais bloquant, jamais l'auteur lui-même). */
async function notifyCoordinators(ctx: Ctx, input: { requestId: string; kind: "created" | "reproposed"; requesterName: string; match: MatchRow; startAt: Date; venueName: string | null; comment: string | null }) {
  const authorEmail = await ctx.authorEmail?.().catch(() => null);
  await notifyDerogationRequest(ctx.db, {
    clubId: ctx.clubId,
    requestId: input.requestId,
    kind: input.kind,
    requesterName: input.requesterName,
    matchLabel: await matchLabelFor(ctx, input.match),
    slotLabel: formatSlot(input.startAt, ctx.timezone, input.venueName),
    comment: input.comment,
    excludeEmails: authorEmail ? [authorEmail] : [],
  });
}

function conflictDto(conflict: SlotConflict, venues: readonly ClubVenueRow[]) {
  return {
    type: conflict.type,
    matchId: conflict.match.id,
    teamName: conflict.match.teamName,
    opponentName: conflict.match.opponentName,
    startAt: conflict.window.start.toISOString(),
    endAt: conflict.window.end.toISOString(),
    venueName: conflict.match.clubVenueId ? (venues.find((v) => v.id === conflict.match.clubVenueId)?.name ?? null) : null,
  };
}

function warningDto(warning: SlotWarning) {
  const start = warning.proposal.startAt;
  return {
    type: warning.type,
    requestId: warning.proposal.requestId,
    teamName: warning.proposal.teamName,
    opponentName: warning.proposal.opponentName,
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + DEFAULT_MATCH_DURATION_MINUTES * 60_000).toISOString(),
  };
}

function candidateDto(slot: CandidateSlot, venues: readonly ClubVenueRow[]) {
  return {
    startAt: slot.startAt.toISOString(),
    endAt: slot.endAt.toISOString(),
    localStart: slot.localStart,
    localEnd: slot.localEnd,
    available: slot.available,
    conflicts: slot.conflicts.map((c) => conflictDto(c, venues)),
    warnings: slot.warnings.map(warningDto),
  };
}

function isUpcoming(match: MatchRow, now: Date): boolean {
  if (!match.match_datetime || ["cancelled", "played", "forfeit"].includes(match.status)) return false;
  return new Date(match.match_datetime) > now;
}

interface SlotCheckParams {
  db: DbClient;
  clubId: string;
  timezone: string;
  match: MatchRow;
  startAt: Date;
  venueId: string | null;
  venues: readonly ClubVenueRow[];
  now: Date;
}

/** Validation AUTORITAIRE (création, nouvelle proposition, vérification d'heure personnalisée) — toujours recalculée ici. */
async function checkSlot(params: SlotCheckParams) {
  const isHome = params.match.is_home === true;
  if (params.venueId && !params.venues.some((v) => v.id === params.venueId)) throw badRequest("Gymnase inconnu pour ce club.", "UNKNOWN_VENUE");
  if (!isHome && params.venueId) throw badRequest("Match à l'extérieur : aucun gymnase du club à choisir.", "AWAY_MATCH_NO_VENUE");

  const dayStart = new Date(params.startAt.getTime() - 24 * 3_600_000);
  const dayEnd = new Date(params.startAt.getTime() + 24 * 3_600_000);
  const [rules, matches, pending] = await Promise.all([
    loadPlanningRules(params.db, params.clubId),
    loadScheduledMatches(params.db, params.clubId, dayStart, dayEnd, params.venues),
    loadPendingProposals(params.db, params.clubId, dayStart, dayEnd),
  ]);

  return validateRequestedSlot({
    startAt: params.startAt,
    clubVenueId: isHome ? params.venueId : null,
    isHome,
    targetMatchId: params.match.id,
    targetTeamId: params.match.team_id,
    matches,
    pending,
    timezone: params.timezone,
    rules,
    now: params.now,
    venueNames: new Map(params.venues.map((v) => [v.id, v.name])),
  });
}

function throwIfInvalid(result: Awaited<ReturnType<typeof checkSlot>>, venues: readonly ClubVenueRow[]): asserts result is Extract<Awaited<ReturnType<typeof checkSlot>>, { ok: true }> {
  if (result.ok) return;
  if (result.code === "DEROGATION_SLOT_CONFLICT") throw conflict(result.message, result.code, { conflicts: result.conflicts.map((c) => conflictDto(c, venues)) });
  throw badRequest(result.message, result.code);
}

async function insertMessage(db: DbClient, row: { club_id: string; request_id: string; author_user_id: string | null; author_licencie_id: string | null; author_membership_id: string | null; author_display_name: string; author_role_label: string | null; body: string; message_type: "USER" | "SYSTEM"; event?: string | null }) {
  const { error } = await db.from("derogation_messages").insert({ ...row, event: row.event ?? null });
  if (error) throw new Error(`Écriture du message échouée : ${error.message}`);
}

async function touch(db: DbClient, requestId: string, patch: Partial<Pick<RequestRow, "status" | "requested_start_at" | "requested_club_venue_id" | "is_custom_weekday">> = {}) {
  const now = new Date().toISOString();
  const { error } = await db.from("derogation_requests").update({ ...patch, updated_at: now, last_message_at: now }).eq("id", requestId);
  if (error) throw new Error(`Mise à jour de la demande échouée : ${error.message}`);
}

/** Identité qui agit : compte (espace club) ou licencié (lien personnel, espace public). */
export interface Ctx {
  db: DbClient;
  actor: Actor;
  clubId: string;
  timezone: string;
  membershipId: string | null;
  /** Nom affiché (« Demande formulée par ») et sa provenance. */
  identity: () => Promise<{ name: string; source: "LICENCIE" | "PROFILE" | "EMAIL" }>;
  /** Adresse de l'auteur : il ne reçoit pas l'email de sa propre demande. */
  authorEmail?: () => Promise<string | null>;
}

/** Colonnes d'auteur communes (compte OU licencié). */
function authorColumns(ctx: Ctx) {
  return { author_user_id: ctx.actor.userId, author_licencie_id: ctx.actor.licencieId, author_membership_id: ctx.membershipId };
}

async function context(c: { get: (k: "club" | "user") => unknown }): Promise<Ctx> {
  const club = c.get("club") as { club: { id: string; timezone: string }; membershipId: string };
  const user = c.get("user") as { id: string; email?: string | null };
  const db = service();
  const actor = await loadActor(db, club.membershipId, user.id);
  return {
    db,
    actor,
    clubId: club.club.id,
    timezone: club.club.timezone,
    membershipId: club.membershipId,
    identity: () => resolveRequesterName(db, club.membershipId, user.id, user.email ?? null),
    authorEmail: async () => user.email ?? null,
  };
}

async function readableRequestOrThrow(ctx: Ctx, requestId: string): Promise<RequestRow> {
  const row = await loadRequest(ctx.db, ctx.clubId, requestId);
  // 404 (jamais 403) : ne révèle pas l'existence d'une demande hors de ses permissions.
  if (!row || !canReadRequest(ctx.actor, requestRef(row))) throw notFound("Demande de dérogation introuvable.");
  return row;
}

// ---------------------------------------------------------------------------
// Handlers partagés (espace club authentifié ET espace public par lien personnel)
// ---------------------------------------------------------------------------

/** Identité du demandeur, coordinateur configuré, gymnases, matchs éligibles. */
export async function handleContext(ctx: Ctx) {
  const now = new Date();
  const [requester, hasCoordinator, venues] = await Promise.all([ctx.identity(), coordinatorsConfigured(ctx.db, ctx.clubId), loadClubVenues(ctx.db, ctx.clubId)]);

  const canCreate = canCreateAny(ctx.actor);
  let eligible: (ReturnType<typeof matchRef> & { activeRequestId: string | null })[] = [];
  if (canCreate) {
    const { data } = await ctx.db
      .from("matches")
      .select("id, club_id, numero, team_id, is_home, match_datetime, opponent_name, venue_id, venue_raw_label, status, competition_id")
      .eq("club_id", ctx.clubId)
      .gte("match_datetime", now.toISOString())
      .order("match_datetime")
      .limit(300);
    const rows = ((data ?? []) as MatchRow[]).filter((m) => isUpcoming(m, now) && canCreateForTeam(ctx.actor, m.team_id));
    const labels = await loadMatchLabels(ctx.db, rows);
    const { data: active } = rows.length
      ? await ctx.db.from("derogation_requests").select("id, match_id, status").eq("club_id", ctx.clubId).in("match_id", rows.map((m) => m.id)).in("status", ["REQUESTED", "IN_PROGRESS", "NEEDS_CHANGE"])
      : { data: [] };
    const activeByMatch = new Map((active ?? []).map((r) => [r.match_id, r.id]));
    eligible = rows.map((m) => ({ ...matchRef(m, labels), activeRequestId: activeByMatch.get(m.id) ?? null }));
  }

  return {
    requesterDisplayName: requester.name,
    requesterNameSource: requester.source,
    coordinatorsConfigured: hasCoordinator,
    canCreate,
    canManage: canManageRequests(ctx.actor),
    timezone: ctx.timezone,
    venues: venueRefs(venues),
    eligibleMatches: eligible,
  };
}

/** Inbox coordinateur (toutes) / demandes du coach (ses équipes + les siennes). */
export async function handleList(ctx: Ctx, rawQuery: Record<string, string>) {
  const query = DerogationRequestListQueryDtoSchema.safeParse(rawQuery);
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));

  let builder = ctx.db.from("derogation_requests").select(REQUEST_COLUMNS).eq("club_id", ctx.clubId);
  if (query.data.status) builder = builder.eq("status", query.data.status);
  if (query.data.teamId) builder = builder.eq("team_id", query.data.teamId);
  if (query.data.matchId) builder = builder.eq("match_id", query.data.matchId);
  const { data, error } = await builder.order("last_message_at", { ascending: false });
  if (error) throw new Error(`Lecture des demandes échouée : ${error.message}`);

  const manager = canManageRequests(ctx.actor);
  const visible = ((data ?? []) as RequestRow[])
    .filter((row) => canReadRequest(ctx.actor, requestRef(row)))
    .filter((row) => query.data.createdByMe !== "true" || isAuthor(ctx.actor, requestRef(row)))
    // Inbox coordinateur : d'abord ce qui attend son attention, puis la dernière activité.
    .sort((a, b) => (manager ? Number(b.status === "REQUESTED") - Number(a.status === "REQUESTED") : 0) || b.last_message_at.localeCompare(a.last_message_at));

  const limit = query.data.limit ?? 50;
  const offset = query.data.offset ?? 0;
  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const requests = await buildSummaries(ctx.db, visible.slice(offset, offset + limit), ctx.actor, venues);
  return { requests, pagination: { limit, offset, total: visible.length } };
}

/** Demande + match + propositions + conversation + permissions. */
export async function handleGet(ctx: Ctx, requestId: string) {
  const row = await readableRequestOrThrow(ctx, requestId);
  return buildDetail(ctx.db, row, ctx.actor, await loadClubVenues(ctx.db, ctx.clubId));
}

/** Création. Demandeur, nom affiché et club déduits de l'identité, jamais du corps. */
export async function handleCreate(ctx: Ctx, rawBody: unknown) {
  const body = CreateDerogationRequestDtoSchema.safeParse(rawBody);
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const now = new Date();

  const match = await loadMatch(ctx.db, ctx.clubId, body.data.matchId);
  if (!match) throw notFound("Match introuvable.");
  if (!canCreateForTeam(ctx.actor, match.team_id)) throw forbidden("Tu ne peux demander une dérogation que pour les matchs des équipes que tu encadres.", "DEROGATION_FORBIDDEN");
  if (!isUpcoming(match, now)) throw conflict("Une demande de dérogation ne concerne qu'un match à venir.", "MATCH_NOT_UPCOMING");
  if (!(await coordinatorsConfigured(ctx.db, ctx.clubId))) throw conflict(NO_COORDINATOR_MESSAGE, "NO_COORDINATOR");

  const { data: existing } = await ctx.db.from("derogation_requests").select("id").eq("match_id", match.id).in("status", ["REQUESTED", "IN_PROGRESS", "NEEDS_CHANGE"]).maybeSingle();
  if (existing) throw conflict("Une demande de dérogation est déjà en cours pour ce match.", "DEROGATION_REQUEST_ALREADY_ACTIVE", { requestId: existing.id });

  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const startAt = new Date(body.data.requestedStartAt);
  const venueId = body.data.requestedVenueId ?? null;
  const validation = await checkSlot({ db: ctx.db, clubId: ctx.clubId, timezone: ctx.timezone, match, startAt, venueId, venues, now });
  throwIfInvalid(validation, venues);

  const requester = await ctx.identity();
  // Nom saisi accepté seulement quand aucun nom exploitable n'est connu (jamais pour usurper un prénom connu).
  const displayName = requester.source === "EMAIL" && body.data.requesterDisplayName ? body.data.requesterDisplayName : requester.name;

  const { data: created, error } = await ctx.db
    .from("derogation_requests")
    .insert({
      club_id: ctx.clubId,
      match_id: match.id,
      team_id: match.team_id,
      created_by_user_id: ctx.actor.userId,
      created_by_licencie_id: ctx.actor.licencieId,
      requester_membership_id: ctx.membershipId,
      requester_display_name: displayName,
      original_scheduled_at: match.match_datetime,
      original_venue_id: match.venue_id,
      requested_start_at: startAt.toISOString(),
      requested_club_venue_id: venueId,
      is_custom_weekday: validation.isCustomWeekday,
      status: "REQUESTED",
    })
    .select(REQUEST_COLUMNS)
    .single();
  if (error || !created) {
    // Double clic / course entre deux coachs : l'index unique partiel garantit une seule demande active.
    if (error?.code === "23505") throw conflict("Une demande de dérogation est déjà en cours pour ce match.", "DEROGATION_REQUEST_ALREADY_ACTIVE");
    throw new Error(`Création de la demande échouée : ${error?.message}`);
  }
  const row = created as RequestRow;

  const venueName = venueId ? (venues.find((v) => v.id === venueId)?.name ?? null) : null;
  await ctx.db.from("derogation_proposals").insert({ club_id: ctx.clubId, request_id: row.id, proposed_by_user_id: ctx.actor.userId, proposed_by_licencie_id: ctx.actor.licencieId, proposed_by_display_name: displayName, requested_start_at: row.requested_start_at, requested_club_venue_id: venueId, is_custom_weekday: validation.isCustomWeekday });
  const roleLabel = roleLabelFor(ctx.actor, requestRef(row));
  await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, ...authorColumns(ctx), author_display_name: displayName, author_role_label: roleLabel, body: `${displayName} a envoyé la demande : ${formatSlot(startAt, ctx.timezone, venueName)}.`, message_type: "SYSTEM", event: "REQUEST_CREATED" });
  if (body.data.comment) {
    await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, ...authorColumns(ctx), author_display_name: displayName, author_role_label: roleLabel, body: body.data.comment, message_type: "USER" });
  }
  await notifyCoordinators(ctx, { requestId: row.id, kind: "created", requesterName: displayName, match, startAt, venueName, comment: body.data.comment ?? null });

  return buildDetail(ctx.db, row, ctx.actor, venues);
}

/** Réponse dans la conversation. */
export async function handleMessage(ctx: Ctx, requestId: string, rawBody: unknown) {
  const body = PostDerogationMessageDtoSchema.safeParse(rawBody);
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const row = await readableRequestOrThrow(ctx, requestId);
  if (row.status === "CANCELLED") throw conflict("Cette demande a été annulée.", "DEROGATION_REQUEST_CANCELLED");

  const author = await ctx.identity();
  await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, ...authorColumns(ctx), author_display_name: author.name, author_role_label: roleLabelFor(ctx.actor, requestRef(row)), body: body.data.message, message_type: "USER" });
  await touch(ctx.db, row.id);

  const fresh = (await loadRequest(ctx.db, ctx.clubId, row.id)) as RequestRow;
  return buildDetail(ctx.db, fresh, ctx.actor, await loadClubVenues(ctx.db, ctx.clubId));
}

const ACTION_EVENTS: Record<string, { event: string; text: (name: string) => string }> = {
  TAKE_IN_CHARGE: { event: "TAKEN_IN_CHARGE", text: (name) => `${name} a pris en charge la demande.` },
  REQUEST_CHANGE: { event: "CHANGE_REQUESTED", text: (name) => `${name} indique que cette demande n'est pas possible — un autre créneau est demandé.` },
  COMPLETE: { event: "COMPLETED", text: (name) => `${name} a marqué la dérogation comme traitée (traitement indiqué comme terminé par le coordinateur).` },
  CANCEL: { event: "CANCELLED", text: (name) => `${name} a annulé la demande.` },
};

/** Machine d'état (Je m'en occupe / Pas possible / Traitée / Annuler). */
export async function handleAction(ctx: Ctx, requestId: string, rawBody: unknown) {
  const body = DerogationActionDtoSchema.safeParse(rawBody);
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const row = await readableRequestOrThrow(ctx, requestId);
  const { action } = body.data;

  if (!canPerformAction(ctx.actor, requestRef(row), action)) throw forbidden("Cette action est réservée au coordinateur.", "DEROGATION_FORBIDDEN");
  const to = nextStatus(action, row.status);
  if (!to) throw conflict(`Action impossible depuis le statut actuel (${row.status}).`, "INVALID_TRANSITION");
  if (action === "REQUEST_CHANGE" && !body.data.message) throw unprocessable("Explique pourquoi ce n'est pas possible : le coach verra immédiatement la raison.", "MESSAGE_REQUIRED");

  // Garde optimiste : la transition ne s'applique que si le statut n'a pas changé entre-temps.
  const now = new Date().toISOString();
  const { data: updated, error } = await ctx.db.from("derogation_requests").update({ status: to, updated_at: now, last_message_at: now }).eq("id", row.id).eq("status", row.status).select("id").maybeSingle();
  if (error) throw new Error(`Changement de statut échoué : ${error.message}`);
  if (!updated) throw conflict("La demande a été modifiée entre-temps, recharge la page.", "INVALID_TRANSITION");

  const author = await ctx.identity();
  const roleLabel = roleLabelFor(ctx.actor, requestRef(row));
  const meta = ACTION_EVENTS[action]!;
  await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, ...authorColumns(ctx), author_display_name: author.name, author_role_label: roleLabel, body: meta.text(author.name), message_type: "SYSTEM", event: meta.event });
  if (body.data.message) {
    await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, ...authorColumns(ctx), author_display_name: author.name, author_role_label: roleLabel, body: body.data.message, message_type: "USER" });
  }

  // Push au coach qui a fait la demande, quand c'est quelqu'un d'autre qui la fait avancer.
  if (action !== "CANCEL" && row.created_by_licencie_id && row.created_by_licencie_id !== ctx.actor.licencieId) {
    await notify(ctx.db, {
      clubId: ctx.clubId,
      kind: "DEROGATION_UPDATED",
      dedupeKey: `derogation:${row.id}:${to}:${now}`,
      licencieIds: [row.created_by_licencie_id],
      title: "Demande de dérogation",
      body: action === "REQUEST_CHANGE" ? "Ta demande n'est pas possible : un autre créneau est demandé." : action === "COMPLETE" ? "Ta demande de dérogation est traitée." : "Ta demande de dérogation est prise en charge.",
      path: (slug) => paths.derogation(slug, row.id),
    });
  }

  const fresh = (await loadRequest(ctx.db, ctx.clubId, row.id)) as RequestRow;
  return buildDetail(ctx.db, fresh, ctx.actor, await loadClubVenues(ctx.db, ctx.clubId));
}

/**
 * Supprime DÉFINITIVEMENT une demande interne terminée ou annulée (retour
 * du club, 2026-10-08 : "les demandes de dérogations terminées, faut les
 * archiver voire supprimer avec bouton supprimer"). Coordinateur /
 * administrateur seulement ; jamais une demande encore ouverte. Messages et
 * créneaux proposés supprimés avec (cascade). La dérogation OFFICIELLE
 * FBI n'est jamais touchée.
 */
export async function handleDelete(ctx: Ctx, requestId: string) {
  const row = await readableRequestOrThrow(ctx, requestId);
  if (!canManageRequests(ctx.actor)) throw forbidden("Seul le coordinateur peut supprimer une demande.", "DEROGATION_FORBIDDEN");
  if (row.status !== "COMPLETED" && row.status !== "CANCELLED") throw conflict("Seule une demande terminée ou annulée peut être supprimée.", "INVALID_TRANSITION");
  const { data, error } = await ctx.db.from("derogation_requests").delete().eq("id", row.id).eq("club_id", ctx.clubId).eq("status", row.status).select("id");
  if (error) throw new Error(`Suppression de la demande échouée : ${error.message}`);
  if (!data || data.length === 0) throw conflict("La demande a été modifiée entre-temps, recharge la page.", "INVALID_TRANSITION");
  return { deleted: true as const, id: row.id };
}

/** Reproposer un créneau (historique conservé, retour en « Demande envoyée »). */
export async function handlePropose(ctx: Ctx, requestId: string, rawBody: unknown) {
  const body = ProposeDerogationSlotDtoSchema.safeParse(rawBody);
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const row = await readableRequestOrThrow(ctx, requestId);
  if (!canPropose(ctx.actor, requestRef(row))) throw conflict("Un nouveau créneau ne peut être proposé que tant que la demande n'est pas prise en charge.", "INVALID_TRANSITION");

  const now = new Date();
  const match = await loadMatch(ctx.db, ctx.clubId, row.match_id);
  if (!match || !isUpcoming(match, now)) throw conflict("Le match n'est plus à venir.", "MATCH_NOT_UPCOMING");
  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const startAt = new Date(body.data.requestedStartAt);
  const venueId = body.data.requestedVenueId ?? null;
  const validation = await checkSlot({ db: ctx.db, clubId: ctx.clubId, timezone: ctx.timezone, match, startAt, venueId, venues, now });
  throwIfInvalid(validation, venues);

  const author = await ctx.identity();
  await ctx.db.from("derogation_proposals").insert({ club_id: ctx.clubId, request_id: row.id, proposed_by_user_id: ctx.actor.userId, proposed_by_licencie_id: ctx.actor.licencieId, proposed_by_display_name: author.name, requested_start_at: startAt.toISOString(), requested_club_venue_id: venueId, is_custom_weekday: validation.isCustomWeekday });
  await touch(ctx.db, row.id, { status: "REQUESTED", requested_start_at: startAt.toISOString(), requested_club_venue_id: venueId, is_custom_weekday: validation.isCustomWeekday });

  const roleLabel = roleLabelFor(ctx.actor, requestRef(row));
  const venueName = venueId ? (venues.find((v) => v.id === venueId)?.name ?? null) : null;
  await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, ...authorColumns(ctx), author_display_name: author.name, author_role_label: roleLabel, body: `${author.name} a proposé un nouveau créneau : ${formatSlot(startAt, ctx.timezone, venueName)}.`, message_type: "SYSTEM", event: "SLOT_PROPOSED" });
  if (body.data.message) {
    await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, ...authorColumns(ctx), author_display_name: author.name, author_role_label: roleLabel, body: body.data.message, message_type: "USER" });
  }
  await notifyCoordinators(ctx, { requestId: row.id, kind: "reproposed", requesterName: author.name, match, startAt, venueName, comment: body.data.message ?? null });

  const fresh = (await loadRequest(ctx.db, ctx.clubId, row.id)) as RequestRow;
  return buildDetail(ctx.db, fresh, ctx.actor, venues);
}

/**
 * Envoi de la dérogation OFFICIELLE sur FBI depuis la demande interne —
 * retour du club, 2026-10-01 : « en tant que coordinateur, il me faut un
 * bouton pour faire une demande de dérogation officielle une fois que je dis
 * je m'en occupe (process qui existe déjà) ». Réutilise EXACTEMENT
 * `createDerogationForClub` (même écriture FBI, même journal
 * `fbi_derogation_creations`) ; seul le déclencheur est nouveau. Action
 * explicite du coordinateur, jamais automatique.
 */
export async function handleOfficial(ctx: Ctx, requestId: string, rawBody: unknown) {
  const body = CreateDerogationDtoSchema.safeParse(rawBody);
  if (!body.success) throw badRequest(body.error.issues[0]?.message ?? "Corps de requête invalide.");
  const row = await readableRequestOrThrow(ctx, requestId);
  if (!canManageRequests(ctx.actor)) throw forbidden("L'envoi officiel est réservé au coordinateur.", "DEROGATION_FORBIDDEN");
  if (!canSubmitOfficial(ctx.actor, requestRef(row))) throw conflict("Prends d'abord la demande en charge (« Je m'en occupe ») avant l'envoi officiel.", "INVALID_TRANSITION");

  const result = await createDerogationForClub(ctx.db, {
    clubId: ctx.clubId,
    matchId: row.match_id,
    motif: body.data.motif,
    modifierDate: body.data.modifierDate,
    dateDerogation: body.data.dateDerogation ?? null,
    modifierHoraire: body.data.modifierHoraire,
    horaire: body.data.horaire ?? null,
    inverserRencontre: body.data.inverserRencontre,
    inverserEquipe: body.data.inverserEquipe,
    submittedBy: ctx.actor.userId,
  });

  if (result.outcome === "success") {
    const author = await ctx.identity();
    await insertMessage(ctx.db, { club_id: ctx.clubId, request_id: row.id, ...authorColumns(ctx), author_display_name: author.name, author_role_label: roleLabelFor(ctx.actor, requestRef(row)), body: `${author.name} a envoyé la demande de dérogation officielle à la FFBB (FBI).`, message_type: "SYSTEM", event: "OFFICIAL_SUBMITTED" });
    await touch(ctx.db, row.id);
  }

  const fresh = (await loadRequest(ctx.db, ctx.clubId, row.id)) as RequestRow;
  return { outcome: result.outcome, message: result.message, request: await buildDetail(ctx.db, fresh, ctx.actor, await loadClubVenues(ctx.db, ctx.clubId)) };
}

async function matchForPlanning(ctx: Ctx, matchId: string): Promise<MatchRow> {
  const match = await loadMatch(ctx.db, ctx.clubId, matchId);
  if (!match) throw notFound("Match introuvable.");
  if (!canCreateForTeam(ctx.actor, match.team_id) && !canManageRequests(ctx.actor)) throw forbidden("Tu ne peux consulter cette disponibilité que pour les équipes que tu encadres.", "DEROGATION_FORBIDDEN");
  return match;
}

/** Occupation des gymnases et créneaux candidats d'un jour (match cible exclu). */
export async function handleAvailability(ctx: Ctx, matchId: string, rawQuery: Record<string, string>) {
  const query = DerogationAvailabilityQueryDtoSchema.safeParse(rawQuery);
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));
  const date = parseLocalDate(query.data.date);
  if (!date) throw badRequest("Date invalide.");
  const match = await matchForPlanning(ctx, matchId);

  const dayStart = zonedWallTimeToUtc(date.year, date.month, date.day, 0, 0, 0, ctx.timezone);
  const dayEnd = new Date(dayStart.getTime() + 26 * 3_600_000);
  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const [rules, matches, pending] = await Promise.all([
    loadPlanningRules(ctx.db, ctx.clubId),
    loadScheduledMatches(ctx.db, ctx.clubId, dayStart, dayEnd, venues),
    loadPendingProposals(ctx.db, ctx.clubId, dayStart, dayEnd),
  ]);

  const isHome = match.is_home === true;
  const result = computeAvailability({ date: query.data.date, timezone: ctx.timezone, rules, isHome, venues: venueRefs(venues), matches, pending, targetMatchId: match.id, targetTeamId: match.team_id, now: new Date() });

  return {
    matchType: isHome ? ("HOME" as const) : ("AWAY" as const),
    date: query.data.date,
    timezone: ctx.timezone,
    rules: { durationMinutes: result.durationMinutes, slotStepMinutes: DEFAULT_SLOT_STEP_MINUTES, earliestStart: result.rule?.earliestStart ?? null, latestStart: result.rule?.latestStart ?? null, gridStart: result.grid.earliestStart, gridEnd: result.grid.latestStart },
    venues: result.venues.map((v) => ({
      venue: v.venue,
      existingMatches: v.existingMatches.map((e) => ({ matchId: e.match.id, teamName: e.match.teamName, opponentName: e.match.opponentName, startAt: e.start.toISOString(), endAt: e.end.toISOString(), localStart: localTimeKey(e.start, ctx.timezone), localEnd: localTimeKey(e.end, ctx.timezone) })),
      pendingRequests: v.pendingRequests.map((p) => ({ requestId: p.proposal.requestId, teamName: p.proposal.teamName, opponentName: p.proposal.opponentName, startAt: p.start.toISOString(), endAt: p.end.toISOString(), localStart: localTimeKey(p.start, ctx.timezone), localEnd: localTimeKey(p.end, ctx.timezone) })),
      candidateStartTimes: v.candidates.map((slot) => candidateDto(slot, venues)),
    })),
    awayCandidateStartTimes: result.awayCandidates.map((slot) => candidateDto(slot, venues)),
  };
}

/** Vérification serveur d'une heure personnalisée (jamais un calcul front seul). */
export async function handleSlotCheck(ctx: Ctx, matchId: string, rawQuery: Record<string, string>) {
  const query = DerogationSlotCheckQueryDtoSchema.safeParse(rawQuery);
  if (!query.success) throw badRequest(query.error.issues.map((i) => i.message).join(" "));
  const match = await matchForPlanning(ctx, matchId);
  const venues = await loadClubVenues(ctx.db, ctx.clubId);
  const startAt = new Date(query.data.startAt);
  const result = await checkSlot({ db: ctx.db, clubId: ctx.clubId, timezone: ctx.timezone, match, startAt, venueId: query.data.venueId ?? null, venues, now: new Date() });
  const endAt = new Date(startAt.getTime() + DEFAULT_MATCH_DURATION_MINUTES * 60_000);

  return {
    ok: result.ok,
    code: result.ok ? null : result.code,
    message: result.ok ? null : result.message,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    conflicts: !result.ok && result.code === "DEROGATION_SLOT_CONFLICT" ? result.conflicts.map((cf) => conflictDto(cf, venues)) : [],
    warnings: result.ok ? result.warnings.map(warningDto) : [],
  };
}

// ---------------------------------------------------------------------------
// /v1/clubs/:clubId/derogation-requests (espace club, compte)
// ---------------------------------------------------------------------------
export const derogationRequestsRouter = new Hono<AppEnv>();
derogationRequestsRouter.use("*", requireAuth);
derogationRequestsRouter.use("*", requireClubMembership);

derogationRequestsRouter.get("/context", async (c) => c.json(await handleContext(await context(c))));
derogationRequestsRouter.get("/", async (c) => c.json(await handleList(await context(c), c.req.query())));
derogationRequestsRouter.get("/:requestId", async (c) => c.json(await handleGet(await context(c), c.req.param("requestId"))));
derogationRequestsRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return c.json(await handleCreate(await context(c), body), 201);
});
derogationRequestsRouter.post("/:requestId/messages", async (c) => c.json(await handleMessage(await context(c), c.req.param("requestId"), await c.req.json().catch(() => ({})))));
derogationRequestsRouter.post("/:requestId/actions", async (c) => c.json(await handleAction(await context(c), c.req.param("requestId"), await c.req.json().catch(() => ({})))));
derogationRequestsRouter.post("/:requestId/official", async (c) => c.json(await handleOfficial(await context(c), c.req.param("requestId"), await c.req.json().catch(() => ({})))));
derogationRequestsRouter.delete("/:requestId", async (c) => c.json(await handleDelete(await context(c), c.req.param("requestId"))));
derogationRequestsRouter.post("/:requestId/proposals", async (c) => c.json(await handlePropose(await context(c), c.req.param("requestId"), await c.req.json().catch(() => ({})))));

// ---------------------------------------------------------------------------
// /v1/clubs/:clubId/matches/:matchId/derogation-availability (+ slot-check)
// ---------------------------------------------------------------------------
// Middlewares PAR ROUTE (jamais `use("*")`) : ce routeur partage le préfixe
// `/matches/:matchId` avec les Tables de marque (`matchTablesRouter`), dont
// les middlewares de rôle ne doivent pas s'appliquer ici — et inversement.
// Monté AVANT `matchTablesRouter` (src/api/v1/index.ts).
export const derogationAvailabilityRouter = new Hono<AppEnv>();

derogationAvailabilityRouter.get("/derogation-availability", requireAuth, requireClubMembership, async (c) => c.json(await handleAvailability(await context(c), c.req.param("matchId") as string, c.req.query())));
derogationAvailabilityRouter.get("/derogation-slot-check", requireAuth, requireClubMembership, async (c) => c.json(await handleSlotCheck(await context(c), c.req.param("matchId") as string, c.req.query())));
