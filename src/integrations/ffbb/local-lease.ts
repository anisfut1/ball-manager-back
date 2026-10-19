import type { DbClient } from "../../db/client.js";

/**
 * Synchronisation FFBB confiée au poste du club (2026-10-19) : depuis le
 * 13/10, api.ffbb.app refuse l'adresse de Vercel (HTTP 403, page de
 * pare-feu) alors qu'elle répond normalement depuis le Mac du club. Le
 * worker local (ops/fbi-local-worker) pose ce bail à chaque passe ; tant
 * qu'il court, Vercel ne synchronise plus FFBB. Libéré à l'arrêt du worker,
 * expiré seul si le poste s'éteint : Vercel reprend alors la main.
 */
export const FFBB_LOCAL_LEASE_KEY = "ffbb_local_until";

/** Bail encore valide à `now`, sinon `null` (absent, vide, expiré ou illisible). */
export function activeLeaseUntil(value: string | null | undefined, now: Date): Date | null {
  const until = value ? new Date(value) : null;
  return until && !Number.isNaN(until.getTime()) && until.getTime() > now.getTime() ? until : null;
}

/** Fin du bail du worker local, ou `null` si Vercel a la main. Réglage illisible : Vercel garde la main. */
export async function ffbbLocalWorkerUntil(supabase: DbClient, now: Date = new Date()): Promise<Date | null> {
  try {
    const { data } = await supabase.from("platform_settings").select("value").eq("key", FFBB_LOCAL_LEASE_KEY).maybeSingle();
    return activeLeaseUntil(data?.value, now);
  } catch {
    return null;
  }
}
