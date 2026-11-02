import { forbidden, notFound } from "../../api-error.js";
import type { LaundryCandidateDto, LaundryDto } from "../../contracts/convocations.js";
import { currentSeasonStart } from "../../season.js";
import type { TrainingCtx } from "../trainings/service.js";
import { audienceFor } from "./render.js";
import { availabilityRequest, convocationOf, licRef, loadMatch, recipientsOf, requireManage, roster, type RosterEntry } from "./service.js";

/**
 * Vie d'équipe — Lot 3 : lavage des maillots (voir docs/TEAM_LIFE.md).
 * Le logiciel SUGGÈRE, le coach DÉCIDE : lire les suggestions n'écrit
 * jamais rien. Équité : on compte les affectations RÉELLES de la saison
 * (jamais les suggestions) ; à situation égale, moins de lavages d'abord ;
 * éviter la même personne deux matchs de suite (critère secondaire).
 */

/** Libellé sans nom de famille inventé : « Parent de Lina Martin » (mineur / âge inconnu) ou « Anis Abed » (majeur). */
export function laundryLabel(l: Pick<RosterEntry, "first_name" | "last_name" | "birth_date">, matchStartsAt: string): string {
  return audienceFor(l.birth_date, matchStartsAt) === "ADULT" ? `${l.first_name} ${l.last_name}` : `Parent de ${l.first_name} ${l.last_name}`;
}

type Tier = { rank: number; status: LaundryCandidateDto["status"] };

/** Priorité : confirmé, convoqué, disponible ; jamais en tête un non-convoqué, un refus ou un indisponible. */
function tierOf(convocationSent: boolean, convocation: string | undefined, availability: string | undefined): Tier {
  if (convocationSent) {
    if (convocation === "CONFIRMED") return { rank: 0, status: "CONFIRMED" };
    if (convocation === "PENDING") return { rank: 1, status: "CONVOKED" };
    if (convocation === "DECLINED") return { rank: 4, status: "DECLINED" };
    return { rank: 3, status: "NOT_CONVOKED" };
  }
  if (availability === "AVAILABLE") return { rank: 1, status: "AVAILABLE" };
  if (availability === "UNAVAILABLE") return { rank: 4, status: "UNAVAILABLE" };
  return { rank: 2, status: availability === "UNCERTAIN" ? "UNCERTAIN" : "NO_RESPONSE" };
}

/** Lavages réels de la saison par licencié (toutes équipes), et dernier match de l'équipe avant celui-ci. */
async function seasonCounts(ctx: TrainingCtx, licencieIds: string[], now: Date = new Date()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (licencieIds.length === 0) return out;
  const { data } = await ctx.db.from("match_laundry_assignments").select("match_id, licencie_id").eq("club_id", ctx.clubId).in("licencie_id", licencieIds);
  const rows = (data ?? []) as { match_id: string; licencie_id: string }[];
  if (rows.length === 0) return out;
  const { data: matches } = await ctx.db.from("matches").select("id, match_datetime").eq("club_id", ctx.clubId).in("id", [...new Set(rows.map((r) => r.match_id))]);
  const start = currentSeasonStart(now).toISOString();
  const inSeason = new Set(((matches ?? []) as { id: string; match_datetime: string | null }[]).filter((m) => (m.match_datetime ?? "") >= start).map((m) => m.id));
  for (const r of rows) if (inSeason.has(r.match_id)) out.set(r.licencie_id, (out.get(r.licencie_id) ?? 0) + 1);
  return out;
}

async function previousAssignee(ctx: TrainingCtx, teamId: string, before: string): Promise<string | null> {
  const { data: prev } = await ctx.db.from("matches").select("id, match_datetime").eq("club_id", ctx.clubId).eq("team_id", teamId).lt("match_datetime", before).order("match_datetime", { ascending: false }).limit(1);
  const last = (prev ?? [])[0] as { id: string } | undefined;
  if (!last) return null;
  const { data } = await ctx.db.from("match_laundry_assignments").select("licencie_id").eq("club_id", ctx.clubId).eq("match_id", last.id).eq("team_id", teamId).maybeSingle();
  return (data as { licencie_id: string } | null)?.licencie_id ?? null;
}

async function assignmentOf(ctx: TrainingCtx, matchId: string, teamId: string) {
  const { data } = await ctx.db.from("match_laundry_assignments").select("licencie_id, assigned_at, seen_at").eq("club_id", ctx.clubId).eq("match_id", matchId).eq("team_id", teamId).maybeSingle();
  return data as { licencie_id: string; assigned_at: string; seen_at: string | null } | null;
}

/** Affectation actuelle d'un match (écran coach). */
export async function laundryOf(ctx: TrainingCtx, match: { id: string; team_id: string; match_datetime: string | null }): Promise<LaundryDto> {
  const current = await assignmentOf(ctx, match.id, match.team_id);
  if (!current) return { assignee: null };
  const { data } = await ctx.db.from("licencies").select("id, first_name, last_name, photo_url, birth_date").eq("club_id", ctx.clubId).eq("id", current.licencie_id).maybeSingle();
  if (!data) return { assignee: null };
  const l = data as RosterEntry;
  const count = (await seasonCounts(ctx, [l.id])).get(l.id) ?? 0;
  return { assignee: { licencie: licRef(l), label: laundryLabel(l, match.match_datetime ?? new Date().toISOString()), seasonCount: count, seenAt: current.seen_at } };
}

/** Suggestions (lecture seule, aucune écriture) : SUGGÉRÉS puis AUTRES. */
export async function laundrySuggestions(ctx: TrainingCtx, matchId: string): Promise<{ candidates: LaundryCandidateDto[] }> {
  const match = await loadMatch(ctx, matchId);
  requireManage(ctx, match.team_id);
  const startsAt = match.match_datetime ?? new Date().toISOString();
  const [people, convocation, request] = await Promise.all([roster(ctx, match.team_id), convocationOf(ctx, match.id, match.team_id), availabilityRequest(ctx, match.id, match.team_id)]);
  const sent = Boolean(convocation && convocation.revision > 0);
  const recipients = sent ? (await recipientsOf(ctx, [convocation!.id])).filter((r) => !r.removed_at) : [];
  const convocationOfLic = new Map(recipients.map((r) => [r.licencie_id, r.response]));
  const availabilityOfLic = new Map<string, string>();
  if (request) {
    const { data } = await ctx.db.from("match_availability_responses").select("licencie_id, response").eq("club_id", ctx.clubId).eq("request_id", request.id);
    for (const r of (data ?? []) as { licencie_id: string; response: string }[]) availabilityOfLic.set(r.licencie_id, r.response);
  }
  const [counts, previous] = await Promise.all([seasonCounts(ctx, people.map((l) => l.id)), previousAssignee(ctx, match.team_id, startsAt)]);

  const rows = people.map((l) => {
    const tier = tierOf(sent, convocationOfLic.get(l.id), availabilityOfLic.get(l.id));
    return { l, tier, count: counts.get(l.id) ?? 0, repeat: previous === l.id };
  });
  rows.sort((a, b) => a.tier.rank - b.tier.rank || a.count - b.count || Number(a.repeat) - Number(b.repeat) || a.l.last_name.localeCompare(b.l.last_name, "fr") || a.l.first_name.localeCompare(b.l.first_name, "fr"));
  // SUGGÉRÉS : réellement concernés par le match (confirmés / convoqués / disponibles) ; à défaut, les sans-réponse.
  const best = rows.some((r) => r.tier.rank <= 1) ? 1 : 2;
  return {
    candidates: rows.map((r) => ({ licencie: licRef(r.l), label: laundryLabel(r.l, startsAt), seasonCount: r.count, status: r.tier.status, repeat: r.repeat, suggested: r.tier.rank <= best })),
  };
}

/** Le coach désigne qui lave les maillots (remplace l'affectation précédente). */
export async function assignLaundry(ctx: TrainingCtx, matchId: string, licencieId: string): Promise<LaundryDto> {
  const match = await loadMatch(ctx, matchId);
  requireManage(ctx, match.team_id);
  const teamIds = new Set((await roster(ctx, match.team_id)).map((l) => l.id));
  if (!teamIds.has(licencieId)) throw forbidden("Ce licencié ne fait pas partie de cette équipe.", "NOT_IN_TEAM");
  const now = new Date().toISOString();
  await ctx.db
    .from("match_laundry_assignments")
    .upsert(
      { club_id: ctx.clubId, match_id: match.id, team_id: match.team_id, licencie_id: licencieId, assigned_at: now, assigned_by_user_id: ctx.actor.userId, assigned_by_licencie_id: ctx.actor.licencieId, seen_at: null, updated_at: now },
      { onConflict: "match_id,team_id" },
    );
  return laundryOf(ctx, match);
}

export async function removeLaundry(ctx: TrainingCtx, matchId: string): Promise<LaundryDto> {
  const match = await loadMatch(ctx, matchId);
  requireManage(ctx, match.team_id);
  await ctx.db.from("match_laundry_assignments").delete().eq("club_id", ctx.clubId).eq("match_id", match.id).eq("team_id", match.team_id);
  return { assignee: null };
}

/** « J'ai vu » (famille / joueur désigné, lien personnel). */
export async function markLaundrySeen(ctx: TrainingCtx, matchId: string, licencieId: string) {
  const match = await loadMatch(ctx, matchId);
  const current = await assignmentOf(ctx, match.id, match.team_id);
  if (!current) throw notFound("Aucun lavage de maillots attribué pour ce match.");
  if (current.licencie_id !== licencieId) throw forbidden("Le lavage des maillots est attribué à quelqu'un d'autre.", "NOT_ASSIGNEE");
  const now = new Date().toISOString();
  await ctx.db.from("match_laundry_assignments").update({ seen_at: now, updated_at: now }).eq("club_id", ctx.clubId).eq("match_id", match.id).eq("team_id", match.team_id);
  return { matchId: match.id, seenAt: now };
}

/** Lavages attribués aux personnes de l'appareil, matchs récents / à venir (Home). */
export async function laundryDutiesFor(ctx: TrainingCtx, licencieIds: string[]) {
  if (licencieIds.length === 0) return [];
  const { data } = await ctx.db.from("match_laundry_assignments").select("match_id, team_id, licencie_id, seen_at").eq("club_id", ctx.clubId).in("licencie_id", licencieIds);
  return (data ?? []) as { match_id: string; team_id: string; licencie_id: string; seen_at: string | null }[];
}
