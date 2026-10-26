import type { DbClient } from "../../db/client.js";
import { logError, logInfo } from "../../logger.js";

/**
 * Doublons FFBB (retour du club, 2026-10-23, U11 2 M : « le match apparaît
 * en double, à 11h et à 13h ») : l'API FFBB renvoie pour une même rencontre
 * (même `uniqueKey` = poule + journée + numéro, même équipe du club) deux
 * fiches d'identifiants différents — l'ancien calendrier et le nouveau. La
 * FFBB applique les dérogations à la plus récente (identifiant le plus
 * grand) ; l'ancienne est une fiche périmée. Une seule fiche par rencontre
 * est gardée.
 */
export interface DedupableMatch {
  ffbbId: string;
  uniqueKey: string | null;
  ourEngagementFfbbId: string;
}

function newer(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) > BigInt(b);
  return a > b;
}

/** Une fiche par rencontre (uniqueKey + équipe du club) : la plus récente. Sans uniqueKey : gardée telle quelle. */
export function latestPerUniqueKey<T extends DedupableMatch>(matches: readonly T[]): { kept: T[]; superseded: T[] } {
  const best = new Map<string, T>();
  const free: T[] = [];
  for (const match of matches) {
    if (!match.uniqueKey) {
      free.push(match);
      continue;
    }
    const key = `${match.ourEngagementFfbbId}|${match.uniqueKey}`;
    const current = best.get(key);
    if (!current || newer(match.ffbbId, current.ffbbId)) best.set(key, match);
  }
  const keptIds = new Set([...best.values()].map((m) => m.ffbbId));
  return { kept: matches.filter((m) => !m.uniqueKey || keptIds.has(m.ffbbId)), superseded: matches.filter((m) => m.uniqueKey && !keptIds.has(m.ffbbId)) };
}

/** Données du club rattachées à un match : jamais supprimées avec une fiche périmée. */
const DEPENDENT_TABLES = ["derogation_requests", "match_convocations", "match_availability_requests", "table_assignments", "fbi_derogation_checks", "match_laundry_assignments", "emarque_imports"] as const;

/**
 * Supprime les fiches périmées en base (même rencontre qu'une fiche gardée,
 * autre identifiant FFBB) — seulement si rien n'y est rattaché ; sinon
 * journalisé et laissé pour traitement manuel. Renvoie le nombre supprimé.
 */
export async function removeSupersededMatches(supabase: DbClient, clubId: string, kept: readonly DedupableMatch[]): Promise<number> {
  const keptByKey = new Map(kept.filter((m) => m.uniqueKey).map((m) => [m.uniqueKey as string, m.ffbbId]));
  if (keptByKey.size === 0) return 0;
  let removed = 0;
  const keys = [...keptByKey.keys()];
  for (let i = 0; i < keys.length; i += 100) {
    const { data: rows, error } = await supabase.from("matches").select("id, ffbb_match_id, ffbb_unique_key, numero").eq("club_id", clubId).in("ffbb_unique_key", keys.slice(i, i + 100));
    if (error) {
      logError("Lecture des doublons FFBB échouée", error, { clubId });
      return removed;
    }
    for (const row of rows ?? []) {
      const keptId = row.ffbb_unique_key ? keptByKey.get(row.ffbb_unique_key) : undefined;
      if (!keptId || row.ffbb_match_id === keptId) continue;
      const counts = await Promise.all(DEPENDENT_TABLES.map((table) => supabase.from(table).select("match_id", { count: "exact", head: true }).eq("match_id", row.id)));
      // Comptage impossible = on ne sait pas : la fiche est gardée.
      if (counts.some((c) => c.error || (c.count ?? 0) > 0)) {
        logError("Doublon FFBB conservé : données rattachées", null, { clubId, matchId: row.id, numero: row.numero, ffbbMatchId: row.ffbb_match_id, keptFfbbMatchId: keptId });
        continue;
      }
      const { error: deleteError } = await supabase.from("matches").delete().eq("id", row.id).eq("club_id", clubId);
      if (deleteError) logError("Suppression d'un doublon FFBB échouée", deleteError, { clubId, matchId: row.id });
      else removed += 1;
    }
  }
  if (removed > 0) logInfo("Doublons FFBB supprimés (fiches périmées)", { clubId, removed });
  return removed;
}
