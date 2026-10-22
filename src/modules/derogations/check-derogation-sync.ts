import type { DbClient } from "../../db/client.js";
import { badRequest, conflict, notFound } from "../../api-error.js";
import { getFbiCredentials } from "../../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../../integrations/fbi/errors.js";
import { getEnv } from "../../config/env.js";
import { logError, logInfo } from "../../logger.js";
import { assertNoActiveFbiJob } from "./fbi-session-lock.js";
import { settleRequestsFromFbi } from "../derogation-requests/fbi-settle.js";

async function recordLoginOutcome(supabase: DbClient, clubId: string, success: boolean, message: string | null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("fbi_integration_status").upsert(
    { club_id: clubId, configured: true, last_login_at: now, last_login_success: success, last_job_at: now, last_job_status: success ? "success" : "error", last_error: success ? null : message, updated_at: now },
    { onConflict: "club_id" },
  );
}

/**
 * Vérifie la dérogation d'UN match, SYNCHRONE — "doit y avoir rien en
 * attente" (demande du club, 2026-09-28) : contrairement à l'ancien modèle
 * `fbi_jobs` (empiler puis espérer qu'un `process-jobs` traite CE job
 * précis parmi d'éventuels autres plus anciens du club — source directe
 * de la confusion "ca marche tjr pas"), cette fonction login/consulte/
 * enregistre DANS la requête HTTP et renvoie le résultat immédiatement.
 * Même logique métier que l'ancien `processCheckDerogationJob` (jobs/
 * process-check-derogation.ts, conservé pour le cron quotidien qui, lui,
 * empile légitimement des jobs en arrière-plan — voir
 * `enqueue-fbi-verifications.ts`), sans la couche de bookkeeping `fbi_jobs`
 * : une erreur ici part directement comme réponse HTTP, jamais une
 * replanification.
 */
export async function checkDerogationForMatchSync(supabase: DbClient, params: { clubId: string; matchId: string }): Promise<{ found: boolean }> {
  const { clubId, matchId } = params;

  const { data: match, error: matchError } = await supabase.from("matches").select("id, numero, competition_id").eq("id", matchId).eq("club_id", clubId).maybeSingle();
  if (matchError) throw new Error(`Lecture du match échouée : ${matchError.message}`);
  if (!match || !match.numero) throw notFound("Match introuvable ou sans numéro de rencontre connu.");

  let division: string | null = null;
  if (match.competition_id) {
    const { data: competition } = await supabase.from("competitions").select("code").eq("id", match.competition_id).maybeSingle();
    division = competition?.code ?? null;
  }

  const credentials = await getFbiCredentials(supabase, clubId);
  if (!credentials) throw conflict("Configure d'abord un identifiant/mot de passe FBI avant de vérifier une dérogation.", "FBI_NOT_CONFIGURED");

  await assertNoActiveFbiJob(supabase, clubId);

  const browser = await launchServerlessBrowser();
  const client = new BrowserFbiClient({ baseUrl: getEnv().FBI_BASE_URL, browser });
  let session: BrowserFbiSession;

  try {
    session = await client.login(credentials);
    await recordLoginOutcome(supabase, clubId, true, null);
  } catch (error) {
    const status = classifyFbiLoginStatus(error);
    const message = error instanceof FbiError ? error.message : "Connexion FBI impossible.";
    await recordLoginOutcome(supabase, clubId, false, message);
    logError("Vérification de dérogation : connexion FBI échouée", error, { clubId, matchId, loginStatus: status });
    await browser.close();
    throw badRequest(`Connexion FBI impossible : ${message}`);
  }

  try {
    const derogation = await client.fetchDerogationForMatch(session, match.numero, division);
    const now = new Date().toISOString();

    if (derogation) {
      const fbiRowKey = derogation.idDerogation ?? `${matchId}:${derogation.numero}:${derogation.dateDepot}`;
      const { error: upsertError } = await supabase.from("fbi_derogation_checks").upsert(
        {
          club_id: clubId,
          match_id: matchId,
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
      await supabase.from("fbi_derogation_checks").delete().eq("club_id", clubId).eq("match_id", matchId);
    }

    await settleRequestsFromFbi(supabase, clubId);
    logInfo("Vérification de dérogation réussie (synchrone)", { clubId, matchId, found: Boolean(derogation) });
    return { found: Boolean(derogation) };
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
