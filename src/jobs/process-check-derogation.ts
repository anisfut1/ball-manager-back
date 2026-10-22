import type { DbClient } from "../db/client.js";
import type { FbiJobRow } from "../db/types.js";
import { getFbiCredentials } from "../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../integrations/fbi/browser-launcher.js";
import type { Browser } from "playwright-core";
import type { SharedFbiSession } from "./shared-session.js";
import { classifyFbiLoginStatus, FbiError } from "../integrations/fbi/errors.js";
import { nextErrorBackoffSeconds } from "./backoff.js";
import { getEnv } from "../config/env.js";
import { logError, logInfo } from "../logger.js";
import { settleRequestsFromFbi } from "../modules/derogation-requests/fbi-settle.js";

async function rescheduleJob(supabase: DbClient, job: FbiJobRow, delaySeconds: number, lastError: string | null): Promise<void> {
  await supabase
    .from("fbi_jobs")
    .update({ status: "pending", scheduled_at: new Date(Date.now() + delaySeconds * 1000).toISOString(), last_error: lastError })
    .eq("id", job.id);
}

async function failJob(supabase: DbClient, job: FbiJobRow, message: string): Promise<void> {
  await supabase.from("fbi_jobs").update({ status: "failed", finished_at: new Date().toISOString(), last_error: message }).eq("id", job.id);
}

async function recordLoginOutcome(supabase: DbClient, clubId: string, success: boolean, message: string | null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("fbi_integration_status").upsert(
    { club_id: clubId, configured: true, last_login_at: now, last_login_success: success, last_job_at: now, last_job_status: success ? "success" : "error", last_error: success ? null : message, updated_at: now },
    { onConflict: "club_id" },
  );
}

/**
 * Traite un job `check_derogation` : login FBI (navigateur), consulte
 * l'état de la dérogation d'UN match par numéro de rencontre
 * (`rechercherDerogation.fbi`, voir docs/FBI.md — demande du club, "faut
 * qu'on gere les derog depuis l'outil"), journalise le résultat dans
 * `fbi_derogation_checks`. LECTURE SEULE : ne soumet/modifie jamais de
 * dérogation — cette phase (écriture) est volontairement pas construite
 * (voir "Ce qui n'est pas fait" dans docs/FBI.md).
 */
export async function processCheckDerogationJob(supabase: DbClient, job: FbiJobRow, shared?: SharedFbiSession): Promise<boolean> {
  if (!job.match_id) {
    await failJob(supabase, job, "Job check_derogation sans match_id (ne devrait jamais arriver, voir la contrainte NOT NULL applicative).");
    return false;
  }

  const { data: match, error: matchError } = await supabase.from("matches").select("id, club_id, numero, competition_id").eq("id", job.match_id).maybeSingle();

  if (matchError || !match || !match.numero) {
    await failJob(supabase, job, `Match introuvable ou sans numéro de rencontre : ${matchError?.message ?? "numero manquant"}`);
    return false;
  }

  // `division` (§ "82 vs 51", docs/FBI.md, 2026-09-27) désambiguïse un
  // numéro de rencontre qui n'est PAS unique au club — voir
  // `BrowserFbiClient.fetchDerogationForMatch`. `null` (compétition
  // inconnue) reste un repli best-effort, jamais un échec du job.
  let division: string | null = null;
  if (match.competition_id) {
    const { data: competition } = await supabase.from("competitions").select("code").eq("id", match.competition_id).maybeSingle();
    division = competition?.code ?? null;
  }

  let browser: Browser | null = null;
  let client: BrowserFbiClient;
  let session: BrowserFbiSession;
  if (shared) {
    ({ client, session } = shared);
  } else {
    const credentials = await getFbiCredentials(supabase, job.club_id);
    if (!credentials) {
      await failJob(supabase, job, "Aucun identifiant FBI enregistré pour ce club.");
      return false;
    }

    browser = await launchServerlessBrowser();
    client = new BrowserFbiClient({ baseUrl: getEnv().FBI_BASE_URL, browser });

    try {
      session = await client.login(credentials);
      await recordLoginOutcome(supabase, job.club_id, true, null);
    } catch (error) {
      const status = classifyFbiLoginStatus(error);
      const message = error instanceof FbiError ? error.message : "Connexion FBI impossible.";
      await recordLoginOutcome(supabase, job.club_id, false, message);

      if (status === "INVALID_CREDENTIALS" || status === "AUTH_FLOW_CHANGED") {
        await failJob(supabase, job, message);
      } else if (job.attempt_count >= job.max_attempts) {
        await failJob(supabase, job, `Connexion FBI en échec après ${job.attempt_count} tentatives : ${message}`);
      } else {
        await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
      }

      logError("Job check_derogation : connexion FBI échouée", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
      await browser?.close();
      return false;
    }
  }

  try {
    const derogation = await client.fetchDerogationForMatch(session, match.numero, division);
    const now = new Date().toISOString();

    if (derogation) {
      // Clé d'upsert d'UNE VRAIE dérogation FBI — même principe que
      // `processCheckAllDerogationsJob` (voir sa doc) : `idDerogation` en
      // priorité, jamais `match_id` seul (une rencontre peut avoir
      // plusieurs dérogations, voir migration `fbi_derogation_multiple_per_match`).
      const fbiRowKey = derogation.idDerogation ?? `${job.match_id}:${derogation.numero}:${derogation.dateDepot}`;

      const { error: upsertError } = await supabase.from("fbi_derogation_checks").upsert(
        {
          club_id: job.club_id,
          match_id: job.match_id,
          fbi_row_key: fbiRowKey,
          id_derogation: derogation.idDerogation,
          numero: derogation.numero,
          etat: derogation.etat,
          date_depot: derogation.dateDepot,
          date_derogation: derogation.dateDerogation,
          date_rencontre: derogation.dateRencontre,
          heure: derogation.heure,
          domicile: derogation.domicile,
          visiteur: derogation.visiteur,
          demandeur: derogation.demandeur,
          motif: derogation.motif,
          date_rencontre_demandee: derogation.dateRencontreDemandee,
          heure_demandee: derogation.heureDemandee,
          adversaire: derogation.adversaire,
          date_reponse: derogation.dateReponse,
          acceptation: derogation.acceptation,
          motif_refus: derogation.motifRefus,
          checked_at: now,
          updated_at: now,
        },
        { onConflict: "club_id,fbi_row_key" },
      );
      if (upsertError) throw new Error(`Écriture du résultat de dérogation échouée : ${upsertError.message}`);
    } else {
      // Aucune dérogation trouvée pour ce match — supprime une éventuelle
      // ligne périmée d'une vérification précédente plutôt que de la
      // laisser afficher un état obsolète.
      await supabase.from("fbi_derogation_checks").delete().eq("club_id", job.club_id).eq("match_id", job.match_id);
    }

    await settleRequestsFromFbi(supabase, job.club_id);
    await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: now, result: { found: Boolean(derogation) } }).eq("id", job.id);

    logInfo("Job check_derogation réussi", { clubId: job.club_id, jobId: job.id, matchId: job.match_id, found: Boolean(derogation) });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, message);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    logError("Job check_derogation en erreur", error, { clubId: job.club_id, jobId: job.id, matchId: job.match_id });
    return false;
  } finally {
    if (!shared) {
      await client.closeSession(session);
      await browser?.close();
    }
  }
}
