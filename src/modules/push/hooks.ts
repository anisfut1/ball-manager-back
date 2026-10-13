import type { DbClient } from "../../db/client.js";
import { paths } from "../../links/links.js";
import { notify } from "./service.js";

/**
 * Déclencheurs qui ne viennent pas d'une action du coach : changements
 * détectés par la synchro FFBB, séances modifiées / annulées. Textes courts
 * et sans nom (écran verrouillé) ; le détail est dans l'app.
 */

/** Joueurs actifs de l'équipe (les coachs reçoivent aussi : ils sont licenciés de l'équipe ou rattachés par lien). */
async function teamLicencieIds(db: DbClient, clubId: string, teamId: string): Promise<string[]> {
  const { data } = await db.from("licencies").select("id").eq("club_id", clubId).eq("team_id", teamId).eq("active", true);
  return ((data ?? []) as { id: string }[]).map((l) => l.id);
}

/**
 * Synchro FFBB : match à venir déplacé (date / heure / salle), annulé ou
 * reporté. Jamais pour un score ni pour un match passé.
 */
export async function notifyMatchChange(
  db: DbClient,
  input: { clubId: string; matchId: string; teamId: string | null; matchDatetime: string | null; status: string; diffs: readonly { field: string; newValue: string | null }[]; syncRunId: string },
  now: Date = new Date(),
): Promise<void> {
  if (!input.teamId || input.diffs.length === 0) return;
  const statusDiff = input.diffs.find((d) => d.field === "status");
  const cancelled = statusDiff && (input.status === "cancelled" || input.status === "postponed");
  const moved = input.diffs.some((d) => d.field === "match_datetime" || d.field === "venue_raw_label");
  if (!cancelled && !moved) return;
  if (!cancelled && (!input.matchDatetime || new Date(input.matchDatetime).getTime() <= now.getTime())) return;
  if (!cancelled && input.status !== "scheduled") return;
  const licencieIds = await teamLicencieIds(db, input.clubId, input.teamId);
  await notify(db, {
    clubId: input.clubId,
    kind: cancelled ? "MATCH_CANCELLED" : "MATCH_CHANGED",
    dedupeKey: `match:${input.matchId}:${input.syncRunId}`,
    licencieIds,
    title: cancelled ? (input.status === "postponed" ? "Match reporté" : "Match annulé") : "Match modifié",
    body: cancelled ? "Un match de ton équipe n'aura pas lieu à la date prévue." : "La date, l'heure ou la salle d'un match de ton équipe a changé.",
    path: (slug) => paths.match(slug, input.matchId),
  });
}

/** Séance à venir modifiée ou annulée (une seule séance, par le coach). */
export async function notifyTrainingChange(
  db: DbClient,
  input: { clubId: string; occurrence: { id: string; team_id: string; starts_at: string; updated_at?: string | null }; change: "changed" | "cancelled" },
  now: Date = new Date(),
): Promise<void> {
  if (new Date(input.occurrence.starts_at).getTime() <= now.getTime()) return;
  const licencieIds = await teamLicencieIds(db, input.clubId, input.occurrence.team_id);
  await notify(db, {
    clubId: input.clubId,
    kind: input.change === "cancelled" ? "TRAINING_CANCELLED" : "TRAINING_CHANGED",
    dedupeKey: `training:${input.occurrence.id}:${input.change}:${input.occurrence.updated_at ?? now.toISOString()}`,
    licencieIds,
    title: input.change === "cancelled" ? "Entraînement annulé" : "Entraînement modifié",
    body: input.change === "cancelled" ? "Une séance d'entraînement de ton équipe est annulée." : "L'horaire ou le lieu d'une séance d'entraînement a changé.",
    path: (slug) => paths.training(slug, { id: input.occurrence.id, teamId: input.occurrence.team_id }, "family"),
  });
}
