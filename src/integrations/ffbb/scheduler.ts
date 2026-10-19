import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/types.js";
import type { FfbbPublicProvider } from "./public-provider.js";
import { FFBB_BLOCKED_RETRY_MINUTES, FFBB_SYNC_BATCH_SIZE, FFBB_SYNC_INTERVAL_MINUTES } from "./config.js";
import { syncFfbb } from "./sync.js";
import { logError, logInfo } from "../../logger.js";

type Client = SupabaseClient<Database>;

export interface SyncAllClubsResult {
  clubsDue: number;
  clubsSynced: number;
  clubsSkippedLocked: number;
  clubsFailed: number;
}

/**
 * Point d'entrée multi-club du cron FFBB (§25/§26 du brief SaaS) : plus de
 * "sync SC Sète" — on cherche les clubs actifs dus, on verrouille chacun
 * individuellement (évite un chevauchement avec un déclenchement manuel
 * admin), on synchronise, on décale son échéance. Séquentiel et par petits
 * lots aujourd'hui (simple à 2 clubs) ; le point de montée en charge future
 * est un worker/queue qui consommerait la même requête "clubs dus" — voir
 * docs/MULTI_TENANCY.md.
 */
export async function syncAllDueClubs(supabase: Client, provider: FfbbPublicProvider): Promise<SyncAllClubsResult> {
  const now = new Date().toISOString();

  const { data: dueClubs, error: dueClubsError } = await supabase
    .from("clubs")
    .select("id, ffbb_club_id")
    .eq("status", "active")
    .eq("ffbb_enabled", true)
    .or(`ffbb_next_sync_at.is.null,ffbb_next_sync_at.lte.${now}`)
    .limit(FFBB_SYNC_BATCH_SIZE);

  if (dueClubsError) {
    throw new Error(`Recherche des clubs dus pour la synchronisation FFBB échouée : ${dueClubsError.message}`);
  }

  const result: SyncAllClubsResult = { clubsDue: dueClubs?.length ?? 0, clubsSynced: 0, clubsSkippedLocked: 0, clubsFailed: 0 };

  for (const club of dueClubs ?? []) {
    const { data: acquired, error: lockError } = await supabase.rpc("try_acquire_sync_lock", {
      p_club_id: club.id,
      p_integration: "ffbb",
    });

    if (lockError) {
      logError("Acquisition du verrou de synchronisation FFBB échouée", lockError, { clubId: club.id });
      result.clubsFailed += 1;
      continue;
    }

    if (!acquired) {
      logInfo("Synchronisation FFBB déjà en cours pour ce club, ignorée", { clubId: club.id });
      result.clubsSkippedLocked += 1;
      continue;
    }

    try {
      const syncResult = await syncFfbb(supabase, provider, { id: club.id, ffbbClubId: club.ffbb_club_id });

      await supabase
        .from("clubs")
        .update({ ffbb_next_sync_at: new Date(Date.now() + (syncResult.blocked ? FFBB_BLOCKED_RETRY_MINUTES : FFBB_SYNC_INTERVAL_MINUTES) * 60_000).toISOString() })
        .eq("id", club.id);

      if (syncResult.status === "error") result.clubsFailed += 1;
      else result.clubsSynced += 1;
    } catch (error) {
      result.clubsFailed += 1;
      logError("Synchronisation FFBB d'un club en erreur", error, { clubId: club.id });
    } finally {
      await supabase.rpc("release_sync_lock", { p_club_id: club.id, p_integration: "ffbb" });
    }
  }

  logInfo("Synchronisation FFBB multi-club terminée", { ...result });

  return result;
}
