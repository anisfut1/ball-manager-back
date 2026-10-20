import type { DbClient } from "../../db/client.js";
import type { FbiJobRow } from "../../db/types.js";
import { badRequest, conflict } from "../../api-error.js";
import { getFbiCredentials } from "../../integrations/fbi/credentials-store.js";
import { BrowserFbiClient } from "../../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../../integrations/fbi/errors.js";
import { fbiPausedUntil } from "../../integrations/fbi/fbi-diagnostics.js";
import { getEnv } from "../../config/env.js";
import { logError } from "../../logger.js";
import type { SharedFbiSession } from "../../jobs/shared-session.js";

/** Résultat d'une écriture FBI (dérogation officielle, réponse à une dérogation). */
export interface FbiWriteResult {
  outcome: "success" | "error" | "unknown";
  message: string | null;
}

export type FbiWriteJobType = "create_derogation" | "respond_derogation";

/**
 * Où part une écriture FBI (2026-10-20, « si le mac est connecté, la demande
 * s'envoie via le worker du mac, et si je déco, ça envoie via vercel ») :
 * le worker du poste du club tient la session FBI tant que son bail
 * `fbi_paused_until` court (renouvelé à chaque passe, libéré à l'arrêt).
 * Depuis Vercel, FBI coupe l'accès — et une seconde connexion ferait tomber
 * la session du poste.
 */
export async function localWorkerHoldsFbi(supabase: DbClient): Promise<boolean> {
  return (await fbiPausedUntil(supabase)) !== null;
}

/** Attente du résultat du poste : il traite les écritures en quelques secondes, sauf s'il finit une autre tâche FBI. */
const LOCAL_WORKER_WAIT_MS = 120_000;
const POLL_MS = 2_000;

export const LOCAL_WORKER_PENDING_MESSAGE =
  "Le poste du club termine une autre tâche FBI : l'envoi partira dès qu'il sera libre, le résultat s'affichera ici. Inutile de renvoyer.";

/**
 * Confie l'écriture au worker du poste et attend son résultat. Jamais de
 * doublon : un envoi encore en file pour ce match est refusé. Une écriture
 * n'est jamais rejouée automatiquement (`max_attempts = 1`).
 */
export async function runOnLocalWorker(
  supabase: DbClient,
  job: { clubId: string; matchId: string; type: FbiWriteJobType; payload: Record<string, unknown> },
  waitMs = LOCAL_WORKER_WAIT_MS,
): Promise<FbiWriteResult> {
  const { data: pending } = await supabase
    .from("fbi_jobs")
    .select("id")
    .eq("club_id", job.clubId)
    .eq("match_id", job.matchId)
    .eq("type", job.type)
    .in("status", ["pending", "claimed", "running"])
    .limit(1)
    .maybeSingle();
  if (pending) throw conflict("Un envoi à FBI est déjà en cours pour ce match : son résultat s'affichera dès qu'il sera traité.", "FBI_WRITE_PENDING");

  const { data: created, error } = await supabase
    .from("fbi_jobs")
    .insert({ club_id: job.clubId, match_id: job.matchId, type: job.type, payload: job.payload, max_attempts: 1 })
    .select("id")
    .single();
  if (error || !created) throw new Error(`Mise en file de l'écriture FBI échouée : ${error?.message ?? "aucune ligne"}`);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const { data: row } = await supabase.from("fbi_jobs").select("status, result, last_error").eq("id", created.id).maybeSingle();
    if (row?.status === "succeeded") return writeResultOf(row.result);
    if (row?.status === "failed") return { outcome: "error", message: row.last_error ?? "Envoi à FBI impossible." };
  }
  return { outcome: "unknown", message: LOCAL_WORKER_PENDING_MESSAGE };
}

function writeResultOf(value: unknown): FbiWriteResult {
  const result = (value ?? {}) as Partial<FbiWriteResult>;
  const outcome = result.outcome === "success" || result.outcome === "error" ? result.outcome : "unknown";
  return { outcome, message: typeof result.message === "string" ? result.message : null };
}

/** Prochaine écriture FBI en file pour ce club, réservée pour ce worker (la plus ancienne d'abord). */
export async function claimNextFbiWriteJob(supabase: DbClient, clubId: string, workerId: string): Promise<FbiJobRow | null> {
  const { data: next } = await supabase
    .from("fbi_jobs")
    .select("id, attempt_count")
    .eq("club_id", clubId)
    .in("type", ["create_derogation", "respond_derogation"])
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!next) return null;
  const { data: claimed } = await supabase
    .from("fbi_jobs")
    .update({ status: "claimed", claimed_at: new Date().toISOString(), claimed_by: workerId, attempt_count: next.attempt_count + 1 })
    .eq("id", next.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  return (claimed as FbiJobRow | null) ?? null;
}

export async function finishFbiWriteJob(supabase: DbClient, jobId: string, result: FbiWriteResult | { failed: string }): Promise<void> {
  const now = new Date().toISOString();
  if ("failed" in result) await supabase.from("fbi_jobs").update({ status: "failed", finished_at: now, last_error: result.failed }).eq("id", jobId);
  else await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: now, result }).eq("id", jobId);
}

async function recordLoginOutcome(supabase: DbClient, clubId: string, success: boolean, message: string | null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("fbi_integration_status").upsert(
    { club_id: clubId, configured: true, last_login_at: now, last_login_success: success, last_job_at: now, last_job_status: success ? "success" : "error", last_error: success ? null : message, updated_at: now },
    { onConflict: "club_id" },
  );
}

/** Session FBI le temps d'une écriture depuis Vercel : navigateur, connexion, puis déconnexion et fermeture. */
export async function withVercelFbiSession<T>(supabase: DbClient, clubId: string, logLabel: string, logContext: Record<string, unknown>, run: (shared: SharedFbiSession) => Promise<T>): Promise<T> {
  const credentials = await getFbiCredentials(supabase, clubId);
  if (!credentials) throw conflict("Configure d'abord un identifiant/mot de passe FBI.", "FBI_NOT_CONFIGURED");
  const browser = await launchServerlessBrowser();
  const client = new BrowserFbiClient({ baseUrl: getEnv().FBI_BASE_URL, browser });
  let session: SharedFbiSession["session"];
  try {
    session = await client.login(credentials);
    await recordLoginOutcome(supabase, clubId, true, null);
  } catch (error) {
    const status = classifyFbiLoginStatus(error);
    const message = error instanceof FbiError ? error.message : "Connexion FBI impossible.";
    await recordLoginOutcome(supabase, clubId, false, message);
    logError(`${logLabel} : connexion FBI échouée`, error, { clubId, ...logContext, loginStatus: status });
    await browser.close();
    throw badRequest(`Connexion FBI impossible : ${message}`);
  }
  try {
    return await run({ client, session });
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
