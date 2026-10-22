import type { DbClient } from "../../db/client.js";
import { badRequest, conflict } from "../../api-error.js";
import { getFbiCredentials } from "../../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../../integrations/fbi/errors.js";
import { getEnv } from "../../config/env.js";
import { currentSeasonStart } from "../../season.js";
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

export interface CheckAllDerogationsSyncResult {
  derogationsFound: number;
  matched: number;
  unmatched: number;
}

/**
 * Vérifie TOUTES les dérogations du club, SYNCHRONE — "doit y avoir rien
 * en attente" (demande du club, 2026-09-28), même raisonnement que
 * `checkDerogationForMatchSync` (voir sa doc) : login/consulte/enregistre
 * DANS la requête HTTP, résultat immédiat, jamais un job `fbi_jobs` à
 * espérer voir traité par un futur clic.
 *
 * Le cron quotidien (`enqueue-fbi-verifications.ts`) continue d'empiler un
 * job `check_all_derogations` chaque matin, traité en arrière-plan par
 * `/internal/cron/fbi-jobs` (`processCheckAllDerogationsJob`, conservé tel
 * quel) — CETTE fonction est le chemin MANUEL (bouton "Vérifier toutes les
 * dérogations"), volontairement séparé du job quotidien automatique.
 */
export async function checkAllDerogationsForClubSync(supabase: DbClient, params: { clubId: string }): Promise<CheckAllDerogationsSyncResult> {
  const { clubId } = params;

  const credentials = await getFbiCredentials(supabase, clubId);
  if (!credentials) throw conflict("Configure d'abord un identifiant/mot de passe FBI avant de vérifier les dérogations.", "FBI_NOT_CONFIGURED");

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
    logError("Vérification globale des dérogations : connexion FBI échouée", error, { clubId, loginStatus: status });
    await browser.close();
    throw badRequest(`Connexion FBI impossible : ${message}`);
  }

  try {
    const derogations = await client.fetchAllDerogations(session);

    const { data: matches, error: matchesError } = await supabase
      .from("matches")
      .select("id, numero, competition_id")
      .eq("club_id", clubId)
      .gte("match_datetime", currentSeasonStart().toISOString());
    if (matchesError) throw new Error(`Lecture des rencontres du club échouée : ${matchesError.message}`);

    const competitionIds = Array.from(new Set((matches ?? []).map((m) => m.competition_id).filter((id): id is string => Boolean(id))));
    const { data: competitions, error: competitionsError } = competitionIds.length
      ? await supabase.from("competitions").select("id, code").in("id", competitionIds)
      : { data: [], error: null };
    if (competitionsError) throw new Error(`Lecture des compétitions du club échouée : ${competitionsError.message}`);
    const competitionCodeById = new Map((competitions ?? []).map((c) => [c.id, c.code]));

    const matchIdByKey = new Map<string, string>();
    for (const match of matches ?? []) {
      if (!match.numero) continue;
      const division = match.competition_id ? competitionCodeById.get(match.competition_id) ?? null : null;
      matchIdByKey.set(`${match.numero}@${division}`, match.id);
    }

    const { data: existingChecks, error: existingChecksError } = await supabase
      .from("fbi_derogation_checks")
      .select("fbi_row_key, demandeur, motif, date_rencontre_demandee, heure_demandee, adversaire, date_reponse, acceptation, motif_refus")
      .eq("club_id", clubId);
    if (existingChecksError) throw new Error(`Lecture du détail de dérogation déjà connu échouée : ${existingChecksError.message}`);
    const existingByRowKey = new Map((existingChecks ?? []).map((c) => [c.fbi_row_key, c]));

    const now = new Date().toISOString();
    let matched = 0;
    let unmatched = 0;

    for (const derogation of derogations) {
      const matchId = derogation.numero ? matchIdByKey.get(`${derogation.numero}@${derogation.division}`) : undefined;
      if (!matchId) {
        unmatched += 1;
        continue;
      }

      const fbiRowKey = derogation.idDerogation ?? `${matchId}:${derogation.numero}:${derogation.dateDepot}`;
      const existing = existingByRowKey.get(fbiRowKey);

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
          demandeur: derogation.demandeur ?? existing?.demandeur ?? null,
          motif: derogation.motif ?? existing?.motif ?? null,
          date_rencontre_demandee: derogation.dateRencontreDemandee ?? existing?.date_rencontre_demandee ?? null,
          heure_demandee: derogation.heureDemandee ?? existing?.heure_demandee ?? null,
          adversaire: derogation.adversaire ?? existing?.adversaire ?? null,
          date_reponse: derogation.dateReponse ?? existing?.date_reponse ?? null,
          acceptation: derogation.acceptation ?? existing?.acceptation ?? null,
          motif_refus: derogation.motifRefus ?? existing?.motif_refus ?? null,
          checked_at: now,
          updated_at: now,
        },
        { onConflict: "club_id,fbi_row_key" },
      );
      if (upsertError) throw new Error(`Écriture du résultat de dérogation échouée : ${upsertError.message}`);
      matched += 1;
    }

    await settleRequestsFromFbi(supabase, clubId);
    const result = { derogationsFound: derogations.length, matched, unmatched };
    logInfo("Vérification globale des dérogations réussie (synchrone)", { clubId, ...result });
    return result;
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
