import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/types.js";
import { formatParisDateTime } from "../fbi/schedule-reconciliation.js";

type Client = SupabaseClient<Database>;
type MatchInsert = Database["public"]["Tables"]["matches"]["Insert"];

/** Dernière correction FBI appliquée à un champ d'un match : la valeur FFBB qu'elle a remplacée (format de `fbi_schedule_discrepancies.ffbb_value`). */
export interface FbiCorrection {
  field: "match_datetime" | "venue_raw_label";
  ffbbValueReplaced: string | null;
}

/**
 * FBI fait foi sur la date/heure et la salle (demande du club, 2026-09-27) :
 * `reconcile_schedule` corrige `matches`, mais la synchro FFBB suivante
 * réécrivait la valeur FFBB, puis FBI la recorrigeait — un aller-retour à
 * chaque passage (et une notification "Match modifié" à chaque fois).
 *
 * Garde donc la valeur actuelle (celle de FBI) tant que FFBB renvoie
 * exactement la valeur que FBI a corrigée. Si FFBB change à son tour
 * (nouvelle valeur), elle est prise et le prochain rapprochement FBI
 * tranchera de nouveau.
 */
export function applyFbiPrecedence(
  row: MatchInsert,
  existing: { match_datetime: string | null; venue_raw_label: string | null } | null,
  corrections: readonly FbiCorrection[],
): MatchInsert {
  if (!existing || corrections.length === 0) return row;
  let next = row;
  for (const correction of corrections) {
    if (correction.field === "match_datetime") {
      const incoming = row.match_datetime ? formatParisDateTime(row.match_datetime) : null;
      if (incoming !== null && incoming === correction.ffbbValueReplaced) next = { ...next, match_datetime: existing.match_datetime };
    } else if ((row.venue_raw_label ?? null) === correction.ffbbValueReplaced) {
      next = { ...next, venue_raw_label: existing.venue_raw_label };
    }
  }
  return next;
}

/** Dernière correction FBI par match et par champ, pour tout le club (une seule requête par synchro). */
export async function loadFbiCorrections(supabase: Client, clubId: string): Promise<Map<string, FbiCorrection[]>> {
  const { data, error } = await supabase
    .from("fbi_schedule_discrepancies")
    .select("match_id, field_name, ffbb_value, auto_corrected_at")
    .eq("club_id", clubId)
    .eq("kind", "mismatch")
    .not("auto_corrected_at", "is", null)
    .not("match_id", "is", null)
    .order("auto_corrected_at", { ascending: false });
  if (error) throw new Error(`Lecture des corrections FBI échouée : ${error.message}`);

  const byMatch = new Map<string, FbiCorrection[]>();
  for (const d of data ?? []) {
    if (!d.match_id || (d.field_name !== "match_datetime" && d.field_name !== "venue_raw_label")) continue;
    const list = byMatch.get(d.match_id) ?? [];
    // Trié du plus récent au plus ancien : seule la dernière correction d'un champ compte.
    if (!list.some((c) => c.field === d.field_name)) list.push({ field: d.field_name, ffbbValueReplaced: d.ffbb_value });
    byMatch.set(d.match_id, list);
  }
  return byMatch;
}
