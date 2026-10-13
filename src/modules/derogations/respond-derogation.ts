import type { DbClient } from "../../db/client.js";
import { badRequest, conflict, notFound } from "../../api-error.js";
import { getFbiCredentials } from "../../integrations/fbi/credentials-store.js";
import { BrowserFbiClient, type BrowserFbiSession } from "../../integrations/fbi/browser-client.js";
import { launchServerlessBrowser } from "../../integrations/fbi/browser-launcher.js";
import { classifyFbiLoginStatus, FbiError } from "../../integrations/fbi/errors.js";
import { getEnv } from "../../config/env.js";
import { logError, logInfo } from "../../logger.js";
import { isDerogationActionRequired } from "./action-required.js";
import { assertNoActiveFbiJob } from "./fbi-session-lock.js";
import type { DerogationResponseDecision } from "../../integrations/fbi/types.js";

export interface RespondToDerogationResult {
  outcome: "success" | "error" | "unknown";
  message: string | null;
}

async function recordLoginOutcome(supabase: DbClient, clubId: string, success: boolean, message: string | null): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("fbi_integration_status").upsert(
    { club_id: clubId, configured: true, last_login_at: now, last_login_success: success, last_job_at: now, last_job_status: success ? "success" : "error", last_error: success ? null : message, updated_at: now },
    { onConflict: "club_id" },
  );
}

/**
 * ÉCRIT réellement sur FBI/FFBB — traite `POST .../derogations/:derogationId/respond`
 * (demande du club, 2026-09-27 : "je veux le faire via loutil... voici les
 * boutons a utiliser pour accetper ou refuser"). SYNCHRONE (contrairement à
 * `check_derogation`/`check_all_derogations`, qui empilent un job traité
 * séparément) : une action volontaire, ponctuelle, où l'admin attend une
 * confirmation immédiate — jamais réintroduire l'ambiguïté "le job est-il
 * déjà passé ?" déjà vécue avec la file `fbi_jobs` (voir la doc de
 * `claim_next_fbi_job_for_club`, migration `20260927020000`).
 *
 * Revalide `actionRequired` CÔTÉ SERVEUR (jamais confiance dans le client) :
 * le bouton ne doit exister côté ball-manager-web que quand c'est vrai, mais une requête
 * directe à cette route sans repasser par l'UI ne doit jamais pouvoir
 * soumettre une réponse pour une dérogation qui n'attend pas celle du club.
 *
 * Journalise CHAQUE tentative dans `fbi_derogation_responses` (succès,
 * erreur, ou état indéterminé) avant de retourner — action réelle et
 * engageante envers un tiers, jamais silencieuse même en cas d'échec.
 */
export async function respondToDerogationForClub(
  supabase: DbClient,
  params: { clubId: string; derogationCheckId: string; decision: DerogationResponseDecision; motifRefus: string | null; submittedBy: string | null },
): Promise<RespondToDerogationResult> {
  const { clubId, derogationCheckId, decision, motifRefus, submittedBy } = params;

  const { data: check, error: checkError } = await supabase
    .from("fbi_derogation_checks")
    .select("id, match_id, fbi_row_key, id_derogation, etat, demandeur")
    .eq("id", derogationCheckId)
    .eq("club_id", clubId)
    .maybeSingle();
  if (checkError) throw new Error(`Lecture de la dérogation échouée : ${checkError.message}`);
  if (!check) throw notFound("Dérogation introuvable.");

  const { data: match, error: matchError } = await supabase
    .from("matches")
    .select("id, numero, competition_id, is_home")
    .eq("id", check.match_id)
    .eq("club_id", clubId)
    .maybeSingle();
  if (matchError) throw new Error(`Lecture du match associé échouée : ${matchError.message}`);
  if (!match || !match.numero) throw notFound("Match associé introuvable ou sans numéro de rencontre connu.");

  if (!isDerogationActionRequired({ etat: check.etat, demandeur: check.demandeur, isHome: match.is_home })) {
    throw conflict("Cette dérogation n'attend pas de réponse du club (déjà tranchée, ou c'est le club qui est demandeur).", "DEROGATION_ACTION_NOT_REQUIRED");
  }

  if (!check.id_derogation) {
    throw conflict(
      "Identifiant FBI manquant pour cette dérogation (connue avant l'ajout de cette fonctionnalité) — relance une vérification (\"Vérifier sur FBI\") avant de répondre.",
      "DEROGATION_ID_MISSING",
    );
  }

  const credentials = await getFbiCredentials(supabase, clubId);
  if (!credentials) throw conflict("Configure d'abord un identifiant/mot de passe FBI avant de répondre à une dérogation.", "FBI_NOT_CONFIGURED");

  await assertNoActiveFbiJob(supabase, clubId);

  let division: string | null = null;
  if (match.competition_id) {
    const { data: competition } = await supabase.from("competitions").select("code").eq("id", match.competition_id).maybeSingle();
    division = competition?.code ?? null;
  }

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
    logError("Réponse à une dérogation : connexion FBI échouée", error, { clubId, derogationCheckId, loginStatus: status });
    await browser.close();
    throw badRequest(`Connexion FBI impossible : ${message}`);
  }

  try {
    const result = await client.respondToDerogation(session, check.id_derogation, decision, motifRefus);

    await supabase.from("fbi_derogation_responses").insert({
      club_id: clubId,
      match_id: match.id,
      fbi_row_key: check.fbi_row_key,
      id_derogation: check.id_derogation,
      decision,
      motif_refus: decision === "refused" ? motifRefus : null,
      submitted_by: submittedBy,
      outcome: result.outcome,
      fbi_message: result.outcome === "success" ? null : result.message,
    });

    logInfo("Réponse à une dérogation FBI", { clubId, derogationCheckId, decision, outcome: result.outcome });

    if (result.outcome === "success") {
      // Rafraîchit IMMÉDIATEMENT l'état connu depuis FBI (jamais deviné/
      // simulé côté applicatif) — même session déjà authentifiée, même
      // logique d'upsert que `processCheckDerogationJob` (voir sa doc).
      try {
        const refreshed = await client.fetchDerogationForMatch(session, match.numero, division);
        if (refreshed) {
          const now = new Date().toISOString();
          const fbiRowKey = refreshed.idDerogation ?? check.fbi_row_key;
          await supabase.from("fbi_derogation_checks").upsert(
            {
              club_id: clubId,
              match_id: match.id,
              fbi_row_key: fbiRowKey,
              id_derogation: refreshed.idDerogation,
              numero: refreshed.numero,
              etat: refreshed.etat,
              date_depot: refreshed.dateDepot,
              date_derogation: refreshed.dateDerogation,
              date_rencontre: refreshed.dateRencontre,
              heure: refreshed.heure,
              domicile: refreshed.domicile,
              visiteur: refreshed.visiteur,
              demandeur: refreshed.demandeur,
              motif: refreshed.motif,
              date_rencontre_demandee: refreshed.dateRencontreDemandee,
              heure_demandee: refreshed.heureDemandee,
              adversaire: refreshed.adversaire,
              date_reponse: refreshed.dateReponse,
              acceptation: refreshed.acceptation,
              motif_refus: refreshed.motifRefus,
              checked_at: now,
              updated_at: now,
            },
            { onConflict: "club_id,fbi_row_key" },
          );
        }
      } catch (error) {
        // Best effort : la réponse a bien été enregistrée sur FBI (résultat
        // déjà journalisé ci-dessus) — un échec de ce simple rafraîchissement
        // ne doit jamais faire paraître la soumission elle-même en échec.
        logError("Réponse à une dérogation FBI : rafraîchissement post-soumission échoué", error, { clubId, derogationCheckId });
      }
    }

    return { outcome: result.outcome, message: result.outcome === "success" ? null : result.message };
  } finally {
    await client.closeSession(session);
    await browser.close();
  }
}
