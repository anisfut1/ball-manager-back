import type { DbClient } from "../../db/client.js";
import { conflict } from "../../api-error.js";

/**
 * `claim_next_fbi_job(_for_club)` garantit qu'un club n'a JAMAIS deux jobs
 * `fbi_jobs` actifs (`claimed`/`running`) simultanément — un garde-fou
 * direct contre le blocage anti-bot FBI déjà constaté en production (voir
 * ProcessFbiJobsButton.tsx côté ball-manager-web, incident du 2026-09-24 : ~190
 * connexions FBI enchaînées sans pause).
 *
 * Les actions FBI SYNCHRONES (`respond-derogation.ts`, `check-derogation-
 * sync.ts`, `check-all-derogations-sync.ts` — jamais passées par
 * `fbi_jobs`, exécutées directement dans la requête pour donner un
 * résultat immédiat, demande du club 2026-09-28 : "doit y avoir rien en
 * attente") contournent ce verrou par construction. Le cron quotidien
 * (`/internal/cron/fbi-enqueue`) empile lui un job `check_all_derogations`/
 * `reconcile_schedule` chaque matin, traité plus tard par `/internal/cron/
 * fbi-jobs` — sans ce contrôle, un clic manuel synchrone pourrait tomber
 * EN MÊME TEMPS qu'un de ces jobs en cours de traitement et ouvrir une
 * DEUXIÈME session FBI simultanée pour le même club.
 *
 * Fenêtre de fraîcheur de 10 minutes — MÊME seuil que
 * `claim_next_fbi_job(_for_club)` (migration `20260924140000_fbi_jobs_claim_stale_recovery.sql`,
 * § "Vingt-deuxième déclenchement", docs/FBI.md) : un job `claimed`/`running`
 * plus vieux que ça a forcément été tué par un timeout Vercel (`maxDuration:
 * 300`) ou un crash, jamais un vrai traitement en cours. Sans cette fenêtre,
 * un job fantôme bloquerait ce verrou INDÉFINIMENT — constaté en
 * production le 2026-09-28 (rencontre 9538) : le job `check_all_derogations`
 * resté bloqué en "claimed" depuis la veille (§ "Vérifications manuelles
 * rendues SYNCHRONES" plus haut) empêchait alors TOUTE action FBI
 * synchrone pour ce club, "erreur lors de confirmation".
 */
const STALE_JOB_THRESHOLD_MINUTES = 10;

export async function assertNoActiveFbiJob(supabase: DbClient, clubId: string): Promise<void> {
  const freshSince = new Date(Date.now() - STALE_JOB_THRESHOLD_MINUTES * 60_000).toISOString();
  const { data } = await supabase.from("fbi_jobs").select("id").eq("club_id", clubId).in("status", ["claimed", "running"]).gt("claimed_at", freshSince).limit(1).maybeSingle();

  if (data) {
    throw conflict("Une vérification FBI est déjà en cours pour ce club (job en arrière-plan) — réessaie dans quelques instants.", "FBI_SESSION_ACTIVE");
  }
}

/**
 * `fbi_jobs_unique_pending_reconcile_schedule` (migration
 * `20260925120000_fbi_schedule_reconciliation.sql`) empêche définitivement
 * un DEUXIÈME job `reconcile_schedule` actif (`pending`/`claimed`/`running`)
 * pour un même club — mais, contrairement à `claim_next_fbi_job(_for_club)`
 * et `assertNoActiveFbiJob` ci-dessus, cette contrainte n'a AUCUNE fenêtre
 * de fraîcheur : un job qui reste bloqué en `pending` (jamais réclamé par
 * aucun worker/cron) bloque `POST .../fbi/reconcile-schedule` INDÉFINIMENT,
 * contrairement au cas `claimed`/`running` déjà couvert. Constaté en
 * production le 2026-09-28 : un job `reconcile_schedule` empilé à 03:18
 * jamais traité (aucun appel `process-jobs` déclenché derrière) bloquait le
 * bouton "Vérifier le calendrier (FFBB vs FBI)" avec "Un rapprochement
 * calendrier FBI est déjà en attente ou en cours pour ce club." des heures
 * plus tard, alors même que le bouton, une fois cliqué, appelle justement
 * `process-jobs` juste après — donc un job encore `pending` après le seuil
 * de fraîcheur n'est jamais une vraie course bénigne, seulement un job
 * jamais traité.
 *
 * Appelée AVANT l'`insert` dans la route, pour les 2 cas (comme
 * `claim_next_fbi_job` couvre déjà `claimed`/`running` mais jamais
 * `pending`) : marque `failed` tout job `reconcile_schedule` de ce club
 * bloqué au-delà du seuil de fraîcheur, qu'il soit encore `pending`
 * (référence `scheduled_at`) ou `claimed`/`running` (référence
 * `claimed_at`, même seuil que `assertNoActiveFbiJob`). Le job fantôme
 * reste en base en `failed` (trace d'audit), jamais supprimé.
 */
export async function reclaimStaleReconcileScheduleJob(supabase: DbClient, clubId: string): Promise<void> {
  const staleSince = new Date(Date.now() - STALE_JOB_THRESHOLD_MINUTES * 60_000).toISOString();
  const lastError = "Job récupéré automatiquement : resté bloqué au-delà du seuil de fraîcheur (10 min) sans jamais être réclamé/terminé par un worker.";

  await supabase
    .from("fbi_jobs")
    .update({ status: "failed", finished_at: new Date().toISOString(), last_error: lastError })
    .eq("club_id", clubId)
    .eq("type", "reconcile_schedule")
    .eq("status", "pending")
    .lt("scheduled_at", staleSince);

  await supabase
    .from("fbi_jobs")
    .update({ status: "failed", finished_at: new Date().toISOString(), last_error: lastError })
    .eq("club_id", clubId)
    .eq("type", "reconcile_schedule")
    .in("status", ["claimed", "running"])
    .lt("claimed_at", staleSince);
}
