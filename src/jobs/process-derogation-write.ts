import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { logError, logInfo } from "../logger.js";
import { createDerogationWithVerification, noteOfficialResult, type CreateDerogationParams, type OfficialConversation } from "../modules/derogations/create-derogation.js";
import { respondWithVerification, type RespondToDerogationParams } from "../modules/derogations/respond-derogation.js";
import { finishFbiWriteJob, withVercelFbiSession, type FbiWriteResult } from "../modules/derogations/fbi-write-routing.js";
import type { SharedFbiSession } from "./shared-session.js";

/**
 * Écriture FBI mise en file (`create_derogation` / `respond_derogation`) :
 * traitée par le worker du poste du club dans SA session, ou — s'il s'est
 * arrêté avant — par Vercel avec sa propre connexion. Jamais rejouée :
 * le résultat (succès ou message FBI) est rangé dans `result`, une erreur
 * inattendue passe le job en `failed`.
 */
/** Nouvel essai automatique (envoi incertain ou FBI injoignable) : pas de 2 min, 6 essais au plus. */
const RETRY_DELAY_MS = 2 * 60_000;
const MAX_AUTO_ATTEMPTS = 6;

export async function processDerogationWriteJob(supabase: DbClient, job: FbiJobRow, shared?: SharedFbiSession): Promise<FbiWriteResult | null> {
  const payload = (job.payload ?? {}) as { params?: Record<string, unknown>; conversation?: OfficialConversation | null; verifyFirst?: boolean; since?: string };
  const since = new Date(payload.since ?? job.created_at);
  await supabase.from("fbi_jobs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", job.id);
  try {
    if (!payload.params || payload.params.clubId !== job.club_id) throw new Error("Données de l'envoi absentes ou d'un autre club.");
    const run = (session: SharedFbiSession): Promise<FbiWriteResult> =>
      job.type === "create_derogation"
        ? createDerogationWithVerification(supabase, session, payload.params as unknown as CreateDerogationParams, { since, verifyFirst: payload.verifyFirst === true })
        : respondWithVerification(supabase, session, payload.params as unknown as RespondToDerogationParams, { verifyFirst: payload.verifyFirst === true });
    const result = shared ? await run(shared) : await withVercelFbiSession(supabase, job.club_id, "Écriture FBI en file", { jobId: job.id }, run);
    // Rien d'envoyé (FBI injoignable) ou envoi incertain à revérifier : la demande reste en file,
    // reprise dans 2 min par le poste du club ou Vercel — FBI relu avant tout renvoi (jamais de doublon).
    const notSent = "notSent" in result && result.notSent === true;
    const verifyLater = "verifyLater" in result && result.verifyLater === true;
    if ((notSent || verifyLater) && job.attempt_count < MAX_AUTO_ATTEMPTS) {
      await supabase
        .from("fbi_jobs")
        .update({
          status: "pending",
          claimed_at: null,
          claimed_by: null,
          scheduled_at: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
          last_error: result.message,
          payload: { ...payload, verifyFirst: payload.verifyFirst === true || verifyLater, since: since.toISOString() },
        })
        .eq("id", job.id);
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
