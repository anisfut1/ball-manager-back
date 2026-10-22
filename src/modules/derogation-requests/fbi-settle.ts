import type { DbClient } from "../../db/client.js";
import { logError, logInfo } from "../../logger.js";
import { paths } from "../../links/links.js";
import { notify } from "../push/service.js";

/**
 * Demandes internes réglées par FBI (retour du club, 2026-10-22, match 5018 :
 * dérogation déposée directement sur FBI et acceptée, mais demande toujours
 * « en cours » sur Ball Manager) : après chaque vérification FBI, une demande
 * encore ouverte est marquée traitée quand une dérogation ACCEPTÉE existe sur
 * FBI pour le même match, déposée le jour de la demande ou après (une
 * dérogation plus ancienne ne répond pas à cette demande).
 */
export interface OpenRequest {
  id: string;
  matchId: string;
  createdAt: string;
}

export interface FbiDerogationRow {
  matchId: string;
  etat: string | null;
  dateDepot: string | null; // « JJ/MM/AAAA HH:MM » (heure de Paris)
  heureDemandee: string | null;
  dateRencontreDemandee: string | null;
}

/** « 22/10/2026 09:48 » → « 2026-10-22 » (null si illisible). */
function depotDay(value: string | null): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(value?.trim() ?? "");
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

export function isAcceptedEtat(etat: string | null): boolean {
  return /^accept/i.test(etat?.trim() ?? "");
}

export function requestsSettledByFbi(requests: readonly OpenRequest[], derogations: readonly FbiDerogationRow[]): { request: OpenRequest; derogation: FbiDerogationRow }[] {
  const settled: { request: OpenRequest; derogation: FbiDerogationRow }[] = [];
  for (const request of requests) {
    const requestDay = request.createdAt.slice(0, 10);
    const derogation = derogations
      .filter((d) => d.matchId === request.matchId && isAcceptedEtat(d.etat))
      .map((d) => ({ d, day: depotDay(d.dateDepot) }))
      .filter(({ day }) => day !== null && day >= requestDay)
      .sort((a, b) => (b.day as string).localeCompare(a.day as string))[0]?.d;
    if (derogation) settled.push({ request, derogation });
  }
  return settled;
}

export function settledMessage(derogation: FbiDerogationRow): string {
  const asked = [derogation.dateRencontreDemandee, derogation.heureDemandee].filter(Boolean).join(" à ");
  return `Dérogation trouvée sur FBI${derogation.dateDepot ? ` (déposée le ${derogation.dateDepot}${asked ? `, demandé : ${asked}` : ""})` : ""} — ${derogation.etat}. Demande marquée comme traitée.`;
}

/** Best effort : jamais un échec de la vérification FBI pour ça. Renvoie le nombre de demandes fermées. */
export async function settleRequestsFromFbi(supabase: DbClient, clubId: string): Promise<number> {
  try {
    const { data: open, error } = await supabase.from("derogation_requests").select("id, match_id, created_at, status, created_by_licencie_id").eq("club_id", clubId).in("status", ["REQUESTED", "IN_PROGRESS", "NEEDS_CHANGE"]);
    if (error) throw new Error(error.message);
    if (!open || open.length === 0) return 0;

    const { data: checks, error: checksError } = await supabase
      .from("fbi_derogation_checks")
      .select("match_id, etat, date_depot, heure_demandee, date_rencontre_demandee")
      .eq("club_id", clubId)
      .in("match_id", [...new Set(open.map((r) => r.match_id as string))]);
    if (checksError) throw new Error(checksError.message);

    const settled = requestsSettledByFbi(
      open.map((r) => ({ id: r.id as string, matchId: r.match_id as string, createdAt: r.created_at as string })),
      (checks ?? []).map((c) => ({ matchId: c.match_id as string, etat: c.etat, dateDepot: c.date_depot, heureDemandee: c.heure_demandee, dateRencontreDemandee: c.date_rencontre_demandee })),
    );

    let closed = 0;
    for (const { request, derogation } of settled) {
      const row = open.find((r) => r.id === request.id)!;
      const now = new Date().toISOString();
      // Garde optimiste : rien si le statut a changé entre-temps.
      const { data: updated } = await supabase.from("derogation_requests").update({ status: "COMPLETED", updated_at: now, last_message_at: now }).eq("id", request.id).eq("status", row.status).select("id").maybeSingle();
      if (!updated) continue;
      closed += 1;
      await supabase.from("derogation_messages").insert({ club_id: clubId, request_id: request.id, author_display_name: "FBI", author_role_label: "Synchronisation", body: settledMessage(derogation), message_type: "SYSTEM", event: "COMPLETED" });
      if (row.created_by_licencie_id) {
        await notify(supabase, {
          clubId,
          kind: "DEROGATION_UPDATED",
          dedupeKey: `derogation:${request.id}:COMPLETED:fbi`,
          licencieIds: [row.created_by_licencie_id as string],
          title: "Demande de dérogation",
          body: "Ta demande de dérogation est acceptée sur FBI.",
          path: (slug) => paths.derogation(slug, request.id),
        });
      }
    }
    if (closed > 0) logInfo("Demandes de dérogation réglées par FBI", { clubId, closed });
    return closed;
  } catch (error) {
    logError("Mise à jour des demandes depuis FBI échouée", error, { clubId });
    return 0;
  }
}
