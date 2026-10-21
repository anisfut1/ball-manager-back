import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { logError, logInfo } from "../logger.js";
import { createDerogationInSession, noteOfficialResult, type CreateDerogationParams, type OfficialConversation } from "../modules/derogations/create-derogation.js";
import { respondToDerogationInSession, type RespondToDerogationParams } from "../modules/derogations/respond-derogation.js";
import { finishFbiWriteJob, withVercelFbiSession, type FbiWriteResult } from "../modules/derogations/fbi-write-routing.js";
import type { SharedFbiSession } from "./shared-session.js";

/**
 * Écriture FBI mise en file (`create_derogation` / `respond_derogation`) :
 * traitée par le worker du poste du club dans SA session, ou — s'il s'est
 * arrêté avant — par Vercel avec sa propre connexion. Jamais rejouée :
 * le résultat (succès ou message FBI) est rangé dans `result`, une erreur
 * inattendue passe le job en `failed`.
 */
export async function processDerogationWriteJob(supabase: DbClient, job: FbiJobRow, shared?: SharedFbiSession): Promise<FbiWriteResult | null> {
  const payload = (job.payload ?? {}) as { params?: Record<string, unknown>; conversation?: OfficialConversation | null };
  await supabase.from("fbi_jobs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", job.id);
  try {
    if (!payload.params || payload.params.clubId !== job.club_id) throw new Error("Données de l'envoi absentes ou d'un autre club.");
    const run = (session: SharedFbiSession): Promise<FbiWriteResult> =>
      job.type === "create_derogation"
        ? createDerogationInSession(supabase, session, payload.params as unknown as CreateDerogationParams)
        : respondToDerogationInSession(supabase, session, payload.params as unknown as RespondToDerogationParams);
    const result = shared ? await run(shared) : await withVercelFbiSession(supabase, job.club_id, "Écriture FBI en file", { jobId: job.id }, run);
    // Vercel toujours bloqué par FBI, rien n'a été envoyé : la demande reste en attente du poste du club.
    if (!shared && "notSent" in result && result.notSent) {
      await supabase.from("fbi_jobs").update({ status: "pending", claimed_at: null, claimed_by: null, last_error: result.message }).eq("id", job.id);
      return null;
    }
    // La conversation d'abord : quand l'appelant voit le job terminé, le message y est déjà.
    if (job.type === "create_derogation" && payload.conversation) await noteOfficialResult(supabase, job.club_id, payload.conversation, result, true);
    await finishFbiWriteJob(supabase, job.id, result);
    logInfo("Écriture FBI traitée", { jobId: job.id, type: job.type, outcome: result.outcome, via: shared ? "worker local" : "vercel" });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : "Erreur interne.";
    logError("Écriture FBI en file : échec", error, { jobId: job.id, type: job.type });
    if (job.type === "create_derogation" && payload.conversation) {
      await noteOfficialResult(supabase, job.club_id, payload.conversation, { outcome: "error", message }, true).catch(() => undefined);
    }
    await finishFbiWriteJob(supabase, job.id, { failed: message });
    return null;
  }
}
