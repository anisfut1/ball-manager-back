import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { getEnv } from "../../config/env.js";
import { unauthorized } from "../../api-error.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { syncAllDueClubs } from "../../integrations/ffbb/scheduler.js";
import { FfbbPublicProvider } from "../../integrations/ffbb/public-provider.js";
import { enqueueEmarqueDiscoveryJobsForAllClubs } from "../../jobs/enqueue-emarque.js";
import { enqueueFbiVerificationJobsForAllClubs } from "../../jobs/enqueue-fbi-verifications.js";
import { claimNextDiscoverJobInSession, claimNextJob } from "../../jobs/claim.js";
import { processJobBatch } from "../../jobs/process-batch.js";
import { logError } from "../../logger.js";

/**
 * `processDiscoverEmarqueJob`/`processTestConnectionJob` (via
 * browser-launcher.ts) et `parseDownloadedEmarqueDocuments` (via le
 * pipeline OCR/PDF) tirent playwright-core/@sparticuz/chromium/tesseract.js/
 * @napi-rs/canvas — des dépendances natives volumineuses. Ce fichier
 * n'utilisant PAS de bundler sur Vercel (chaque .ts est transpilé et
 * exécuté individuellement par le runtime, voir docs/DEPLOYMENT.md),
 * un `import` statique ici les chargerait à CHAQUE démarrage à froid de la
 * fonction — y compris pour `/health` ou `/v1/clubs`, qui ne les utilisent
 * jamais — au point de dépasser le temps d'exécution du plan Vercel Hobby.
 * Import dynamique : le coût n'est payé que par les invocations qui
 * traitent réellement un job FBI/e-Marque.
 */

/**
 * Traitements automatiques — JAMAIS sous `/v1` (§8 de la demande). Protégé
 * par `CRON_SECRET` (en-tête `Authorization: Bearer <CRON_SECRET>`),
 * exactement le mécanisme que Vercel Cron envoie déjà par défaut pour les
 * routes déclarées dans `vercel.json` (voir docs/DEPLOYMENT.md).
 */
export const internalRouter = new Hono<AppEnv>();

internalRouter.use("*", async (c, next) => {
  const header = c.req.header("authorization");
  if (header !== `Bearer ${getEnv().CRON_SECRET}`) {
    throw unauthorized("Route interne protégée par CRON_SECRET.");
  }
  await next();
});

/** GET /internal/cron/ffbb — §29 de la demande : clubs dus, petit lot, le cron suivant reprendra le reste. */
internalRouter.get("/cron/ffbb", async (c) => {
  const supabase = createServiceSupabaseClient();
  try {
    const result = await syncAllDueClubs(supabase, new FfbbPublicProvider());
    return c.json(result);
  } catch (error) {
    logError("Cron FFBB en erreur", error);
    return c.json({ error: "ffbb_sync_failed" }, 500);
  }
});

/**
 * GET /internal/cron/fbi-enqueue — empile TOUS les jobs FBI récurrents
 * (discover_emarque, reconcile_schedule, check_all_derogations), ne pilote
 * jamais Playwright lui-même (c'est `/cron/fbi-jobs` qui les consomme).
 * `reconcile_schedule`/`check_all_derogations` regroupés ici plutôt que
 * dans une route cron séparée : demande du club (2026-09-25) de ne plus
 * dépendre des boutons manuels "Vérifier le calendrier"/"Vérifier toutes
 * les dérogations" (Intégrations → FBI) pour que ces vérifications
 * tournent "H24 sans cliquer" — un seul passage quotidien d'empilement
 * pour tous les jobs récurrents, cohérent avec l'unique cron déjà en place
 * plutôt que d'en ajouter un de plus.
 */
internalRouter.get("/cron/fbi-enqueue", async (c) => {
  const supabase = createServiceSupabaseClient();
  try {
    const emarque = await enqueueEmarqueDiscoveryJobsForAllClubs(supabase);
    const verifications = await enqueueFbiVerificationJobsForAllClubs(supabase);
    return c.json({ emarque, verifications });
  } catch (error) {
    logError("Cron d'empilement FBI en erreur", error);
    return c.json({ error: "fbi_enqueue_failed" }, 500);
  }
});

/**
 * Un seul job `discover_emarque` RÉEL par invocation — constaté en
 * production le 2026-09-24 (§ "Vingt-deuxième déclenchement", docs/FBI.md) :
 * le tout premier succès de bout en bout (rencontre n°1481, 5 documents
 * téléchargés) a pris ~3min30 (login + navigation + recherche + téléchargement
 * réels contre le vrai FBI, bien plus lent que les fixtures locales). Un lot
 * de 3 (l'ancienne valeur) peut donc dépasser `maxDuration: 300` (vercel.json)
 * dès le 2ᵉ ou 3ᵉ job — provoquant un "Vercel Runtime Timeout Error", qui tue
 * le process AVANT que le job en cours puisse passer en `succeeded`/`failed`
 * ou même que son `finally` (fermeture de session/browser) s'exécute : il
 * reste bloqué en `status = 'claimed'` indéfiniment, ce qui bloque ENSUITE
 * tout nouveau job pour ce club via la contrainte "un job actif par club"
 * (voir la garde d'auto-guérison ajoutée aux deux fonctions SQL
 * `claim_next_fbi_job*`, migration 20260924140000).
 */
const JOB_BATCH_SIZE = 1;

/**
 * GET /internal/cron/fbi-jobs — §27/§28 de la demande : réclame un PETIT lot
 * de jobs (jamais 50 clubs d'un coup), les traite séquentiellement dans
 * CETTE invocation, s'arrête. Le cron suivant (5 min plus tard, voir
 * vercel.json) reprendra la suite — c'est LUI le "scheduler", pas une
 * boucle infinie dans une seule invocation.
 */
internalRouter.get("/cron/fbi-jobs", async (c) => {
  const supabase = createServiceSupabaseClient();
  const workerId = `vercel-cron#${Date.now()}`;

  const { fbiPausedUntil, recentFbiCredentialLogin } = await import("../../integrations/fbi/fbi-diagnostics.js");
  const pausedUntil = await fbiPausedUntil(supabase);
  if (pausedUntil) return c.json({ claimed: 0, succeeded: 0, failed: 0, skipped: "fbi_en_pause", until: pausedUntil.toISOString() });
  // Une connexion FBI à la fois, espacées (voir `FBI_MIN_LOGIN_GAP_MS`) :
  // les appels suivants de la boucle du workflow ne se connectent pas.
  // Un seul compte FBI aujourd'hui : écart global (par club quand il y en aura plusieurs).
  const lastLogin = await recentFbiCredentialLogin(supabase);
  if (lastLogin) return c.json({ claimed: 0, succeeded: 0, failed: 0, skipped: "connexion_fbi_recente", since: lastLogin.toISOString() });

  // Rien de dû : aucun accès à FBI, même pas la vérification.
  const { data: due } = await supabase.from("fbi_jobs").select("id").eq("status", "pending").lte("scheduled_at", new Date().toISOString()).limit(1);
  if (!due || due.length === 0) return c.json({ claimed: 0, succeeded: 0, failed: 0 });

  // FBI répond-il ? (2026-10-06 : FBI coupe par moments l'adresse utilisée.)
  // Une seule requête légère, sans identifiant ; injoignable = passage sauté,
  // les jobs gardent leur créneau — jamais de navigateur ni de connexion qui
  // prolongeraient la coupure. Historique : `fbi_reachability_checks`.
  const { bypassFbiProxyForThisRun, resetFbiProxyBypass, resolveFbiProxy } = await import("../../integrations/fbi/browser-launcher.js");
  const { checkFbiReachability, recordFbiReachability } = await import("../../integrations/fbi/fbi-diagnostics.js");
  resetFbiProxyBypass();
  const proxy = await resolveFbiProxy();
  let reachability = await checkFbiReachability(proxy);
  await recordFbiReachability(supabase, reachability);
  if (!reachability.ok && proxy) {
    // Adresse du proxy coupée par FBI : essai en direct (adresse Vercel).
    reachability = await checkFbiReachability(undefined);
    await recordFbiReachability(supabase, reachability);
    if (reachability.ok) bypassFbiProxyForThisRun();
  }
  if (!reachability.ok) {
    return c.json({ claimed: 0, succeeded: 0, failed: 0, skipped: "fbi_injoignable", via: reachability.via, detail: reachability.error ?? `HTTP ${reachability.httpStatus}` });
  }

  const result = await processJobBatch(supabase, JOB_BATCH_SIZE, () => claimNextJob(supabase, workerId), {
    claimNextDiscoverInSession: (clubId) => claimNextDiscoverJobInSession(supabase, clubId, workerId),
  });
  return c.json(result);
});

/**
 * GET /internal/cron/fbi-reachability — UNE requête légère vers la page de
 * connexion FBI (sans identifiant), à chaque passage du planificateur, même
 * sans travail dû : historique des coupures FBI (`fbi_reachability_checks`).
 */
internalRouter.get("/cron/fbi-reachability", async (c) => {
  const { resolveFbiProxy } = await import("../../integrations/fbi/browser-launcher.js");
  const { checkFbiReachability, recordFbiReachability } = await import("../../integrations/fbi/fbi-diagnostics.js");
  const supabase = createServiceSupabaseClient();
  const proxy = await resolveFbiProxy();
  const checks = [await checkFbiReachability(proxy)];
  if (proxy) checks.push(await checkFbiReachability(undefined));
  for (const check of checks) await recordFbiReachability(supabase, check);
  return c.json(checks.map((check) => ({ via: check.via, ok: check.ok, httpStatus: check.httpStatus, elapsedMs: check.elapsedMs, error: check.error })));
});

/** GET /internal/cron/emarque-parse — étape parsing (OCR/PDF), jamais de Playwright ici. */
internalRouter.get("/cron/emarque-parse", async (c) => {
  const supabase = createServiceSupabaseClient();
  try {
    const { parseDownloadedEmarqueDocuments, purgeExpiredEmarqueDocuments, requeueOutdatedEmarqueParses } = await import("../../jobs/parse-downloaded-documents.js");
    // Charge bornée à chaque appel : au plus 3 lectures OCR (les matchs les
    // plus récents d'abord), 2 relectures remises en file, 20 suppressions.
    const purged = await purgeExpiredEmarqueDocuments(supabase);
    const requeued = await requeueOutdatedEmarqueParses(supabase);
    const result = await parseDownloadedEmarqueDocuments(supabase, { limit: 3 });
    return c.json({ ...result, purged, requeued });
  } catch (error) {
    logError("Cron de parsing e-Marque en erreur", error);
    return c.json({ error: "emarque_parse_failed" }, 500);
  }
});

/**
 * GET /internal/cron/push — notifications push en attente (échecs passagers à
 * réessayer, réservations abandonnées). L'envoi normal est immédiat, au
 * moment de l'action ; ce passage ne fait que rattraper. Sans clé APNs :
 * `{ enabled: false }`, rien n'est fait.
 */
internalRouter.get("/cron/push", async (c) => {
  const supabase = createServiceSupabaseClient();
  try {
    const { processOutbox } = await import("../../modules/push/service.js");
    return c.json(await processOutbox(supabase));
  } catch (error) {
    logError("Cron push en erreur", error);
    return c.json({ error: "push_failed" }, 500);
  }
});
