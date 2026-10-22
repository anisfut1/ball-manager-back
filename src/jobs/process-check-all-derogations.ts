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
import { currentSeasonStart } from "../season.js";
import { derogationNotificationEvents, type DerogationSnapshot } from "../modules/derogations/notification-events.js";
import { notifyFbiDerogationEvents } from "../modules/derogation-requests/notify.js";
import { settleRequestsFromFbi } from "../modules/derogation-requests/fbi-settle.js";
import { logError, logInfo } from "../logger.js";

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
 * Traite un job `check_all_derogations` : login FBI (UNE SEULE fois pour
 * tout le club — "je veux un bouton global qui check toutes les demandes,
 * pas match par match", demande du club, 2026-09-25), récupère TOUTES les
 * dérogations FBI en une recherche non filtrée
 * (`BrowserFbiClient.fetchAllDerogations`), les rapproche des rencontres du
 * club déjà synchronisées FFBB par (numéro, division), écrit les lignes
 * `fbi_derogation_checks` correspondantes (plusieurs par rencontre
 * possibles depuis le round "82 vs 51", voir migration
 * `fbi_derogation_multiple_per_match`). LECTURE SEULE, jamais d'écriture
 * sur FBI (voir docs/FBI.md).
 */
export async function processCheckAllDerogationsJob(supabase: DbClient, job: FbiJobRow, shared?: SharedFbiSession): Promise<boolean> {
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

      logError("Job check_all_derogations : connexion FBI échouée", error, { clubId: job.club_id, jobId: job.id, loginStatus: status });
      await browser?.close();
      return false;
    }
  }

  try {
    /**
     * Ce qui est déjà connu en base, lu AVANT FBI (2026-10-07) : le détail
     * d'une dérogation (page FBI dédiée) n'est rouvert que si elle est
     * nouvelle, si son détail manque, ou si son état / sa date de
     * dérogation a changé dans le tableau — un club qui démarre de zéro lit
     * donc TOUT, un club à jour ne rouvre que ce qui a bougé.
     */
    const { data: existingChecks, error: existingChecksError } = await supabase
      .from("fbi_derogation_checks")
      .select("fbi_row_key, etat, date_depot, date_derogation, demandeur, motif, date_rencontre_demandee, heure_demandee, adversaire, date_reponse, acceptation, motif_refus, modifier_date, modifier_horaire, modifier_salle, salle_demandee, inverser_rencontre, inverser_equipe, changes_read_at")
      .eq("club_id", job.club_id);
    if (existingChecksError) throw new Error(`Lecture du détail de dérogation déjà connu échouée : ${existingChecksError.message}`);
    const existingByRowKey = new Map((existingChecks ?? []).map((c) => [c.fbi_row_key, c]));

    const needsDetail = (row: { idDerogation: string | null; etat: string | null; dateDerogation: string | null }): boolean => {
      const existing = row.idDerogation ? existingByRowKey.get(row.idDerogation) : undefined;
      if (!existing) return true;
      const detailKnown = Boolean(
        existing.demandeur || existing.motif || existing.date_rencontre_demandee || existing.heure_demandee || existing.adversaire || existing.date_reponse || existing.acceptation || existing.motif_refus,
      );
      // `changes_read_at` absent : détail lu avant la lecture des cases
      // (salle, inversion…) — relu une fois pour les connaître.
      return !detailKnown || !existing.changes_read_at || existing.etat !== row.etat || existing.date_derogation !== row.dateDerogation;
    };

    const derogations = await client.fetchAllDerogations(session, {
      needsDetail,
      onDetailProgress: (done, total) => {
        if (done === total || done % 5 === 0) logInfo(`Dérogations : détail ${done}/${total}`, { clubId: job.club_id, jobId: job.id });
      },
    });
    const passDiagnostics = client.getLastDerogationPassDiagnostics();
    const detailStats = client.getLastDerogationDetailStats();

    // Scopé à la saison EN COURS (même convention que `currentSeasonStart`
    // côté /v1/clubs/:clubId/issues) — `numero` n'est PAS unique sur toute
    // l'historique d'un club : constaté en production le 2026-09-25, une
    // dérogation de septembre 2026 s'est vue associée à un match de mai
    // 2026 (saison précédente) partageant le même numéro de rencontre,
    // faussant complètement la date/l'adversaire affichés.
    const { data: matches, error: matchesError } = await supabase
      .from("matches")
      .select("id, numero, competition_id, is_home")
      .eq("club_id", job.club_id)
      .gte("match_datetime", currentSeasonStart().toISOString());
    if (matchesError) throw new Error(`Lecture des rencontres du club échouée : ${matchesError.message}`);

    /**
     * `numero` n'est PAS unique au club (§ "82 vs 51", docs/FBI.md,
     * 2026-09-27, capture d'écran du club) : le même numéro de rencontre
     * existe dans PLUSIEURS divisions distinctes (ex: "23" en BU11FN23 ET
     * en BU11MN2). Le rapprochement se fait donc par (numéro, division) —
     * `division` côté FBI correspond à `competitions.code` côté FFBB, lu
     * séparément (2 requêtes simples plutôt qu'un embedded select, jamais
     * éprouvé dans ce module) et croisé en mémoire.
     */
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

    /**
     * Détail déjà connu d'une exécution précédente (`processCheckDerogationJob`,
     * le bouton "Vérifier sur FBI" d'un match précis, OU un précédent
     * `check_all_derogations` qui avait eu le temps de lire ce détail) —
     * lu ICI, une seule fois pour tout le club, jamais une requête par
     * ligne dans la boucle ci-dessous. Sert de FILET DE SÉCURITÉ pour
     * `derogationDetailBudgetMs` (browser-client.ts) : si CETTE exécution
     * n'a pas eu le temps de lire le détail d'une ligne (budget dépassé,
     * best effort), l'upsert ne doit jamais ÉCRASER un détail déjà connu
     * avec `null` — une régression déjà vécue en production le
     * 2026-09-27 ("on récupère plus le demandeur le motif...", après le
     * round précédent qui avait retiré tout détail par ligne DU LOT et
     * l'écrasait donc systématiquement à `null`, y compris pour des
     * lignes dont le détail avait été lu par ailleurs). Clé désormais
     * `fbi_row_key` (une VRAIE dérogation), jamais `match_id` (plusieurs
     * lignes possibles par rencontre depuis le round "82 vs 51").
     */

    // Aucune dérogation lue alors que le club en a déjà en base : lecture FBI
    // ratée, jamais un "succès" (constaté le 2026-10-07 : 3 lignes vides lues,
    // job marqué réussi, affichage figé au 30/09 sans que personne le sache).
    if (derogations.length === 0 && existingByRowKey.size > 0) {
      const diagnostic = passDiagnostics[0];
      // Diagnostic conservé en base malgré l'échec (preuve de ce qui a été lu).
      await supabase.from("fbi_jobs").update({ result: { derogationsFound: 0, passDiagnostics } }).eq("id", job.id);
      throw new Error(
        `Aucune dérogation lue sur FBI alors que ${existingByRowKey.size} sont connues (lignes brutes : ${diagnostic?.rawRowCount ?? "?"}, conteneur trouvé : ${diagnostic?.derogationContainerFound ?? "?"}) — tableau FBI illisible, nouvel essai planifié.`,
      );
    }

    const isHomeByMatchId = new Map((matches ?? []).map((m) => [m.id, m.is_home ?? null]));
    const snapshots: DerogationSnapshot[] = [];
    const now = new Date().toISOString();
    let matched = 0;
    let unmatched = 0;

    for (const derogation of derogations) {
      const matchId = derogation.numero ? matchIdByKey.get(`${derogation.numero}@${derogation.division}`) : undefined;
      if (!matchId) {
        // Dérogation FBI sans rencontre FFBB correspondante trouvée (pas
        // encore synchronisée, ou (numéro, division) non reconnu) —
        // ignorée : cette table est scopée par match_id (contrainte NOT
        // NULL), jamais de ligne orpheline créée.
        unmatched += 1;
        continue;
      }

      /**
       * Clé d'upsert d'UNE VRAIE dérogation FBI — `idDerogation` (jeton du
       * lien de détail, voir `FbiDerogationRow`) en priorité ; repli
       * composite si jamais absent (lien introuvable, best effort) —
       * jamais `match_id` seul, qui écraserait à tort les AUTRES
       * dérogations de la même rencontre (§ "82 vs 51", docs/FBI.md).
       */
      const fbiRowKey = derogation.idDerogation ?? `${matchId}:${derogation.numero}:${derogation.dateDepot}`;
      const existing = existingByRowKey.get(fbiRowKey);
      const changesRead = "modifierSalle" in derogation;

      const { error: upsertError } = await supabase.from("fbi_derogation_checks").upsert(
        {
          club_id: job.club_id,
          match_id: matchId,
          fbi_row_key: fbiRowKey,
          id_derogation: derogation.idDerogation,
          numero: derogation.numero,
          etat: derogation.etat,
          date_depot: derogation.dateDepot ?? derogation.dateDepotDetail ?? existing?.date_depot ?? null,
          date_derogation: derogation.dateDerogation,
          date_rencontre: derogation.dateRencontre,
          heure: derogation.heure,
          domicile: derogation.domicile,
          visiteur: derogation.visiteur,
          // Champs de DÉTAIL uniquement (jamais etat/dates ci-dessus, TOUJOURS
          // connus de façon fiable depuis le tableau de résultats) : garde la
          // valeur déjà connue en base si CETTE exécution n'a pas pu lire le
          // détail de cette ligne (budget de temps dépassé, voir la note
          // au-dessus de `existingByRowKey`).
          demandeur: derogation.demandeur ?? existing?.demandeur ?? null,
          motif: derogation.motif ?? existing?.motif ?? null,
          date_rencontre_demandee: derogation.dateRencontreDemandee ?? existing?.date_rencontre_demandee ?? null,
          heure_demandee: derogation.heureDemandee ?? existing?.heure_demandee ?? null,
          adversaire: derogation.adversaire ?? existing?.adversaire ?? null,
          date_reponse: derogation.dateReponse ?? existing?.date_reponse ?? null,
          acceptation: derogation.acceptation ?? existing?.acceptation ?? null,
          motif_refus: derogation.motifRefus ?? existing?.motif_refus ?? null,
          // Cases du formulaire : présentes dans `derogation` seulement si
          // sa page de détail a été lue CETTE fois (sinon valeur connue gardée).
          ...(changesRead
            ? {
                modifier_date: derogation.modifierDate ?? null,
                modifier_horaire: derogation.modifierHoraire ?? null,
                modifier_salle: derogation.modifierSalle ?? null,
                salle_demandee: derogation.salleDemandee ?? null,
                inverser_rencontre: derogation.inverserRencontre ?? null,
                inverser_equipe: derogation.inverserEquipe ?? null,
                changes_read_at: now,
              }
            : {}),
          checked_at: now,
          updated_at: now,
        },
        { onConflict: "club_id,fbi_row_key" },
      );
      if (upsertError) throw new Error(`Écriture du résultat de dérogation échouée : ${upsertError.message}`);
      matched += 1;
      snapshots.push({
        fbiRowKey,
        etat: derogation.etat,
        previousEtat: existing?.etat,
        demandeur: derogation.demandeur ?? existing?.demandeur ?? null,
        isHome: isHomeByMatchId.get(matchId) ?? null,
        domicile: derogation.domicile,
        visiteur: derogation.visiteur,
        dateRencontre: derogation.dateRencontre,
        heure: derogation.heure,
        dateRencontreDemandee: derogation.dateRencontreDemandee ?? existing?.date_rencontre_demandee ?? null,
        heureDemandee: derogation.heureDemandee ?? existing?.heure_demandee ?? null,
        salleDemandee: ("salleDemandee" in derogation ? derogation.salleDemandee : null) ?? existing?.salle_demandee ?? null,
        motif: derogation.motif ?? existing?.motif ?? null,
      });
    }

    // PAS de suppression automatique des lignes "non retrouvées cette
    // fois" : tenté le 2026-09-25 (nettoyage des lignes dont checked_at
    // est antérieur à cette exécution), et retiré le jour même après avoir
    // constaté en production qu'une exécution ayant trouvé anormalement
    // PEU de dérogations (recherche FBI dégradée/partielle, jamais garanti
    // exhaustive) avait alors supprimé TOUTES les lignes connues du club —
    // une perte de données pour un simple affichage périmé, un échange
    // largement défavorable. Une ligne "A Créer" périmée qui reste
    // affichée quelques exécutions de plus est un moindre mal ; elle se
    // corrige d'elle-même dès qu'une exécution future la retrouve.

    /**
     * Diagnostic riche AJOUTÉ le 2026-09-26 (constaté en production : un
     * lot connu de ~20 dérogations est retombé à `derogationsFound: 3,
     * matched: 0` juste après le déploiement de l'extraction de détail par
     * `href`/nouvel onglet, § "cinquième round", docs/FBI.md) — jusqu'ici
     * `result` ne gardait que des COMPTEURS, impossible de distinguer
     * depuis la base (sans dépendre des logs Vercel, lus une seule fois
     * puis perdus) DEUX hypothèses très différentes :
     * 1. La recherche FBI elle-même a régressé (état/pagination cassés par
     *    le nouvel onglet de détail, qui n'a jamais été éprouvé contre le
     *    VRAI FBI) — les numéros trouvés seraient alors un SOUS-ENSEMBLE
     *    anormal des numéros déjà connus.
     * 2. La recherche a bien trouvé 3 VRAIES dérogations récentes, mais
     *    dont la rencontre FFBB correspondante n'est pas encore synchronisée
     *    (numéros absents de `matches` pour la saison en cours) — un simple
     *    problème de synchronisation, sans rapport avec ce job.
     * Persisté dans `fbi_jobs.result` (consultable en base immédiatement,
     * jamais un aller-retour Vercel) : le détail par ligne trouvée (numéro/
     * état/si le motif a pu être lu) et un échantillon des numéros de
     * `matches` disponibles pour comparaison.
     */
    // `foundDerogations`/`motifLu`/`pass` par ligne retirés le 2026-09-27
    // (§ "Timeout Vercel", docs/FBI.md) : `fetchAllDerogations` ne fait
    // plus qu'une seule passe SANS détail par ligne (voir sa doc), ces
    // deux champs étaient devenus systématiquement `false`/`null` — le
    // diagnostic utile (état réellement sélectionné, lignes brutes vs
    // conservées) reste dans `passDiagnostics`.
    // Emails aux coordinateurs : dérogations adverses à traiter, réponses reçues (une fois chacune).
    const notificationsSent = await notifyFbiDerogationEvents(supabase, job.club_id, derogationNotificationEvents(snapshots));

    // Demandes internes réglées par une dérogation acceptée sur FBI (2026-10-22).
    const requestsSettled = await settleRequestsFromFbi(supabase, job.club_id);

    const result = {
      notificationsSent,
      requestsSettled,
      derogationsFound: derogations.length,
      matched,
      unmatched,
      foundNumeros: derogations.map((d) => `${d.numero}@${d.division}`).sort(),
      matchKeysDisponibles: Array.from(matchIdByKey.keys()).sort(),
      passDiagnostics,
      detailStats,
    };
    await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: now, result }).eq("id", job.id);

    logInfo("Job check_all_derogations réussi", { clubId: job.club_id, jobId: job.id, ...result });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (job.attempt_count >= job.max_attempts) {
      await failJob(supabase, job, message);
    } else {
      await rescheduleJob(supabase, job, nextErrorBackoffSeconds(job.attempt_count), message);
    }

    logError("Job check_all_derogations en erreur", error, { clubId: job.club_id, jobId: job.id });
    return false;
  } finally {
    if (!shared) {
      await client.closeSession(session);
      await browser?.close();
    }
  }
}
