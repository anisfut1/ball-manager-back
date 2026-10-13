import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { badRequest, conflict } from "../../api-error.js";
import { getFbiCredentials, getFbiUsername, saveFbiCredentials } from "../../integrations/fbi/credentials-store.js";
import { HttpFbiClient } from "../../integrations/fbi/http-client.js";
import { attemptBrowserFbiLogin } from "../../integrations/fbi/browser-login-attempt.js";
import { FbiError, type FbiErrorCode } from "../../integrations/fbi/errors.js";
import { FfbbPublicProvider } from "../../integrations/ffbb/public-provider.js";
import { syncFfbb } from "../../integrations/ffbb/sync.js";
import { claimNextDiscoverJobInSession, claimNextJobForClub } from "../../jobs/claim.js";
import { processJobBatch } from "../../jobs/process-batch.js";
import { checkAllDerogationsForClubSync } from "../derogations/check-all-derogations-sync.js";
import { reclaimStaleReconcileScheduleJob } from "../derogations/fbi-session-lock.js";
import { getEnv } from "../../config/env.js";
import { logError } from "../../logger.js";
import {
  PatchFbiIntegrationDtoSchema,
  PatchFfbbIntegrationDtoSchema,
  type FbiActiveJobDto,
  type FbiIntegrationStatusDto,
  type IntegrationStatusDto,
  type SyncRunDto,
} from "../../contracts/integrations.js";
import type { DbClient } from "../../db/client.js";

export const integrationsRouter = new Hono<AppEnv>();

integrationsRouter.use("*", requireAuth);
integrationsRouter.use("*", requireClubMembership);

function messageForFbiErrorCode(code: FbiErrorCode): string {
  switch (code) {
    case "LOGIN_FAILED":
      return "Connexion FBI impossible : identifiant ou mot de passe incorrect.";
    case "LOGIN_PAGE_UNREACHABLE":
      return "Connexion FBI impossible : le site FBI est injoignable pour le moment. Réessaie plus tard.";
    case "LOGIN_FORM_NOT_RECOGNIZED":
      return "Connexion FBI impossible : la page de connexion FBI a changé de structure.";
    case "EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED":
      return "Connecté à FBI, mais la récupération des documents e-Marque n'est pas encore confirmée techniquement.";
    default:
      return "Connexion FBI impossible.";
  }
}

/**
 * Job FBI `claimed`/`running` EN COURS pour ce club — retour du club,
 * 2026-09-29 : "il me faut un truc pour savoir quand ya un truc en cours".
 * Même fenêtre de fraîcheur (10 min) que le garde-fou "un seul job actif
 * par club" côté `claim_next_fbi_job(_for_club)` (migration
 * 20260924140000) — un job `claimed` plus vieux que ça a forcément été tué
 * par un timeout/crash Vercel, jamais affiché comme "en cours" ici non
 * plus (cohérent avec le fait qu'il ne bloque plus la file côté claim).
 */
async function findActiveFbiJob(supabase: DbClient, clubId: string): Promise<FbiActiveJobDto | null> {
  const { data } = await supabase
    .from("fbi_jobs")
    .select("type, claimed_at")
    .eq("club_id", clubId)
    .in("status", ["claimed", "running"])
    .gt("claimed_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .order("claimed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.claimed_at) return null;
  return { type: data.type, startedAt: data.claimed_at };
}

/**
 * Construit le statut FBI exposé à l'API (gap 8 de la demande) : lit
 * `fbi_integration_status` via le client passé (RLS pour une lecture,
 * service role pour rester cohérent juste après une écriture service
 * role) ET `fbi_credentials.username` — JAMAIS le mot de passe/ciphertext,
 * voir `credentials-store.ts#getFbiUsername`.
 */
async function buildFbiStatusDto(supabase: DbClient, clubId: string): Promise<FbiIntegrationStatusDto> {
  const [{ data: fbiStatus }, username, activeJob] = await Promise.all([
    supabase.from("fbi_integration_status").select("configured, last_login_success, last_login_at, auto_import_emarque, last_error").eq("club_id", clubId).maybeSingle(),
    getFbiUsername(supabase, clubId),
    findActiveFbiJob(supabase, clubId),
  ]);

  return {
    configured: fbiStatus?.configured ?? false,
    username,
    connected: fbiStatus?.last_login_success ?? false,
    lastLoginAt: fbiStatus?.last_login_at ?? null,
    autoImportEmarque: fbiStatus?.auto_import_emarque ?? false,
    lastError: fbiStatus?.last_error ?? null,
    activeJob,
  };
}

/** GET /v1/clubs/:clubId/integrations */
integrationsRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const [{ data: lastFfbbRun }, fbi] = await Promise.all([
    supabase.from("sync_runs").select("started_at, status").eq("club_id", club.id).eq("provider", "ffbb").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    buildFbiStatusDto(supabase, club.id),
  ]);

  const dto: IntegrationStatusDto = {
    ffbb: {
      enabled: club.ffbbEnabled,
      lastSyncAt: lastFfbbRun?.started_at ?? null,
      lastSyncStatus: lastFfbbRun?.status ?? null,
    },
    fbi,
  };

  return c.json(dto);
});

/**
 * POST /v1/clubs/:clubId/integrations/fbi — enregistre les identifiants
 * (chiffrés, AAD=club_id, §34 de la demande). `fbi_credentials` n'a AUCUNE
 * policy RLS pour `authenticated` (voir supabase/migrations) : le client
 * service role est utilisé ICI, seulement après que `requireClubRole`
 * a vérifié le rôle via LA RLS. Réponse enrichie (§14 de la demande) —
 * jamais le mot de passe, jamais le ciphertext.
 */
integrationsRouter.post("/fbi", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({}) as { username?: string; password?: string });

  const username = (body.username ?? "").trim();
  const password = body.password ?? "";

  if (!username) throw badRequest("L'identifiant est requis.");

  const serviceSupabase = createServiceSupabaseClient();

  if (password) {
    await saveFbiCredentials(serviceSupabase, club.id, { username, password }, user.id);
  } else {
    const existing = await getFbiCredentials(serviceSupabase, club.id);
    if (!existing) throw badRequest("Un mot de passe est requis lors du premier enregistrement.");
    await saveFbiCredentials(serviceSupabase, club.id, { username, password: existing.password }, user.id);
  }

  const fbi = await buildFbiStatusDto(serviceSupabase, club.id);
  return c.json({ saved: true as const, fbi });
});

/**
 * PATCH /v1/clubs/:clubId/integrations/fbi (gap 4 de la demande) — active/
 * désactive l'intégration ou l'auto-import e-Marque SANS redemander les
 * identifiants. `enabled` pilote `fbi_integration_status.configured`
 * (§16 de la demande : réutilise la colonne existante plutôt que d'en
 * ajouter une redondante) — le désactiver ne supprime jamais les
 * identifiants déjà enregistrés, seulement l'exposition de la capability
 * (voir `tenancy/club-capabilities.ts`).
 *
 * `autoImportEmarque=true` sans identifiants configurés est une erreur
 * métier explicite (`FBI_NOT_CONFIGURED`, §6 de la demande), pas un 400
 * générique.
 */
integrationsRouter.patch("/fbi", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const body = await c.req.json().catch(() => ({}));
  const parsed = PatchFbiIntegrationDtoSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((issue) => issue.message).join(" "));
  }

  const serviceSupabase = createServiceSupabaseClient();

  // Seule une valeur `true` a une précondition (des identifiants doivent
  // déjà exister) — désactiver l'un ou l'autre réglage est toujours permis,
  // sans condition (§6 de la demande).
  const requiresCredentials = parsed.data.enabled === true || parsed.data.autoImportEmarque === true;
  if (requiresCredentials) {
    const existing = await getFbiCredentials(serviceSupabase, club.id);
    if (!existing) throw conflict("Configure d'abord un identifiant/mot de passe FBI avant d'activer cette intégration.", "FBI_NOT_CONFIGURED");
  }

  const patch: { club_id: string; updated_at: string; configured?: boolean; auto_import_emarque?: boolean } = {
    club_id: club.id,
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.enabled !== undefined) patch.configured = parsed.data.enabled;
  if (parsed.data.autoImportEmarque !== undefined) patch.auto_import_emarque = parsed.data.autoImportEmarque;

  const { error } = await serviceSupabase.from("fbi_integration_status").upsert(patch, { onConflict: "club_id" });
  if (error) throw new Error(`Mise à jour des réglages FBI échouée : ${error.message}`);

  const fbi = await buildFbiStatusDto(serviceSupabase, club.id);
  return c.json({ fbi });
});

/**
 * POST /v1/clubs/:clubId/integrations/fbi/test — teste réellement la
 * stratégie principale (`HttpFbiClient`, §35 de la demande). Chemin
 * synchrone : le login HTTP est rapide.
 *
 * Si l'échec est `LOGIN_FORM_NOT_RECOGNIZED` OU `LOGIN_FAILED` et que
 * `BROWSER_FBI_ENABLED=true`, un login navigateur (`attemptBrowserFbiLogin`,
 * `BrowserFbiClient`) est tenté ICI, DANS LA MÊME REQUÊTE — plus de pattern
 * 202+jobId (retiré le 2026-09-24, voir docs/FBI.md) : un admin cliquant
 * "Tester la connexion" attend un résultat immédiat, jamais besoin de
 * déclencher `/internal/cron/fbi-jobs` à la main sur le dashboard Vercel
 * (le cron ne tourne qu'une fois par jour, voir vercel.json — bloquant
 * constaté en production le 2026-09-24). `maxDuration: 300` (vercel.json)
 * laisse largement la place pour un login navigateur en plus du login HTTP
 * (quelques secondes en pratique, voir docs/FBI.md).
 *
 * `LOGIN_FAILED` ajouté au déclencheur (2026-09-22, voir docs/FBI.md) :
 * un premier club a confirmé des identifiants corrects (login manuel
 * réussi sur extranet.ffbb.com/fbi) alors que `HttpFbiClient` échouait
 * systématiquement, même avec un User-Agent de navigateur — signature
 * cohérente avec une protection anti-bot qu'un `fetch` brut ne peut pas
 * contourner (empreinte TLS/JS), mais qu'un vrai Chromium (`BrowserFbiClient`)
 * peut potentiellement franchir. Un `LOGIN_FAILED` du navigateur reste
 * possible (vraiment mauvais identifiants) — mais c'est alors un signal
 * plus fiable que celui du client HTTP seul.
 */
integrationsRouter.post("/fbi/test", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();
  const credentials = await getFbiCredentials(serviceSupabase, club.id);

  if (!credentials) {
    return c.json({ success: false, message: "Aucun identifiant FBI enregistré pour l'instant." }, 200);
  }

  const testedAt = new Date().toISOString();
  const client = new HttpFbiClient({ baseUrl: getEnv().FBI_BASE_URL });

  try {
    await client.login(credentials);

    await serviceSupabase.from("fbi_integration_status").upsert(
      // last_error: null — sinon un échec précédent (ex: LOGIN_FAILED HTTP,
      // avant le repli navigateur) reste affiché indéfiniment sur
      // /admin/intégrations à côté d'un statut "Connecté ✅", contradiction
      // constatée en production le 2026-09-22 (voir docs/FBI.md).
      { club_id: club.id, configured: true, last_test_at: testedAt, last_test_success: true, last_test_message: "Connexion réussie.", last_login_at: testedAt, last_login_success: true, last_error: null, updated_at: testedAt },
      { onConflict: "club_id" },
    );

    return c.json({ success: true, message: "FBI connecté ✅" });
  } catch (error) {
    logError("Connexion FBI (HTTP) échouée, tentative navigateur si activée", error, { clubId: club.id });

    if (
      error instanceof FbiError &&
      (error.code === "LOGIN_FORM_NOT_RECOGNIZED" || error.code === "LOGIN_FAILED") &&
      getEnv().BROWSER_FBI_ENABLED
    ) {
      const attempt = await attemptBrowserFbiLogin(credentials);

      await serviceSupabase.from("fbi_integration_status").upsert(
        {
          club_id: club.id,
          configured: true,
          last_test_at: testedAt,
          last_test_success: attempt.success,
          last_test_message: attempt.message,
          last_login_at: attempt.success ? testedAt : undefined,
          last_login_success: attempt.success,
          last_error: attempt.success ? null : attempt.message,
          updated_at: testedAt,
        },
        { onConflict: "club_id" },
      );

      if (!attempt.success) logError("Test de connexion FBI échoué (navigateur)", new Error(attempt.message), { clubId: club.id, loginStatus: attempt.loginStatus });

      return c.json({ success: attempt.success, message: attempt.message });
    }

    const message = error instanceof FbiError ? messageForFbiErrorCode(error.code) : "Connexion FBI impossible.";

    await serviceSupabase.from("fbi_integration_status").upsert(
      { club_id: club.id, configured: true, last_test_at: testedAt, last_test_success: false, last_test_message: message, last_login_success: false, last_error: message, updated_at: testedAt },
      { onConflict: "club_id" },
    );

    return c.json({ success: false, message });
  }
});

/**
 * Un seul job `discover_emarque` RÉEL par invocation — voir la note
 * détaillée sur `JOB_BATCH_SIZE` dans `src/api/internal/index.ts` (même
 * constat en production le 2026-09-24, § "Vingt-deuxième déclenchement",
 * docs/FBI.md) : ~3min30 pour un job réel contre le vrai FBI, un lot de 3
 * (l'ancienne valeur) risque de dépasser `maxDuration: 300` et de tuer le
 * process en cours de traitement d'un job suivant, le laissant bloqué en
 * `status = 'claimed'`. Le bouton "Traiter les jobs FBI en attente"
 * (`ProcessFbiJobsButton.tsx` côté ball-manager-web) boucle déjà automatiquement tant
 * qu'il reste des jobs — traiter un seul job par clic/itération est donc
 * sans perte fonctionnelle, juste plus de requêtes.
 */
const CLUB_JOB_BATCH_SIZE = 1;
const CLUB_PARSE_BATCH_SIZE = 10;

/**
 * POST /v1/clubs/:clubId/integrations/fbi/process-jobs — §9 de la demande :
 * "je veux un bouton qui va faire ce que je fais sur vercel mais via le
 * site". `/internal/cron/fbi-jobs` (vercel.json) ne tourne qu'une fois par
 * jour — jusqu'ici, la seule façon de faire avancer les jobs
 * `discover_emarque`/`test_connection` en attente plus tôt était de
 * déclencher ce cron à la main sur le dashboard Vercel (constaté en
 * production le 2026-09-24 : 8 jobs `discover_emarque` en attente depuis
 * plus d'une journée, voir docs/FBI.md "Neuvième déclenchement").
 *
 * Traite un PETIT lot (`CLUB_JOB_BATCH_SIZE`, même logique que le cron)
 * synchroniquement, DANS CETTE REQUÊTE — un admin cliquant "Traiter les
 * jobs en attente" attend un résultat immédiat. `claim_next_fbi_job_for_club`
 * (supabase/migrations/20260924100000_fbi_jobs_claim_for_club.sql) filtre
 * strictement sur `club.id` : cette route ne peut jamais réclamer/traiter
 * un job d'un autre club, contrairement à `claim_next_fbi_job` (le cron).
 * Le `discover_emarque` traité ici pilote `BrowserFbiClient` (Playwright) —
 * `maxDuration: 300` (vercel.json) laisse la place pour plusieurs jobs.
 */
integrationsRouter.post("/fbi/process-jobs", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();
  const workerId = `admin-app#${club.id}#${Date.now()}`;

  const { fbiPausedUntil, recentFbiCredentialLogin } = await import("../../integrations/fbi/fbi-diagnostics.js");
  const pausedUntil = await fbiPausedUntil(serviceSupabase);
  if (pausedUntil) return c.json({ claimed: 0, succeeded: 0, failed: 0 });
  // Connexion FBI toute récente pour ce club : pas de nouvelle connexion (voir `FBI_MIN_LOGIN_GAP_MS`).
  if (await recentFbiCredentialLogin(serviceSupabase, club.id)) return c.json({ claimed: 0, succeeded: 0, failed: 0 });

  const result = await processJobBatch(serviceSupabase, CLUB_JOB_BATCH_SIZE, () => claimNextJobForClub(serviceSupabase, club.id, workerId), {
    claimNextDiscoverInSession: () => claimNextDiscoverJobInSession(serviceSupabase, club.id, workerId),
  });

  return c.json(result);
});

/**
 * POST /v1/clubs/:clubId/integrations/fbi/reconcile-schedule — rapprochement
 * calendrier FFBB/FBI (demande du club, voir docs/FBI.md) : "FBI est l'info
 * réelle. si ya une info sur fbi pour la même rencontre différente de ffbb,
 * c'est une anomalie. si un match est sur fbi, et pas sur ffbb, c'est à
 * alerter aussi." Empile un job `reconcile_schedule` (un seul par club, voir
 * la contrainte `fbi_jobs_unique_pending_reconcile_schedule`) plutôt que de
 * faire tourner Playwright dans cette requête — même modèle que
 * `discover_emarque` : consommé par `POST .../fbi/process-jobs` (ou le cron),
 * jamais synchrone ici. FFBB reste la SEULE source écrite dans `matches`
 * pour TOUS les clubs — cette route n'existe QUE pour les clubs ayant FBI
 * configuré, elle ne remplace jamais la synchro FFBB.
 */
integrationsRouter.post("/fbi/reconcile-schedule", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();

  const credentials = await getFbiCredentials(serviceSupabase, club.id);
  if (!credentials) throw conflict("Configure d'abord un identifiant/mot de passe FBI avant de lancer un rapprochement calendrier.", "FBI_NOT_CONFIGURED");

  // Récupère tout job `reconcile_schedule` fantôme (pending/claimed/running
  // bloqué au-delà de 10 min) avant l'insert — sinon `fbi_jobs_unique_
  // pending_reconcile_schedule` bloque ce club indéfiniment, voir
  // reclaimStaleReconcileScheduleJob.
  await reclaimStaleReconcileScheduleJob(serviceSupabase, club.id);

  const { error } = await serviceSupabase.from("fbi_jobs").insert({ club_id: club.id, type: "reconcile_schedule" });

  if (error) {
    if (error.code === "23505") {
      throw conflict("Un rapprochement calendrier FBI est déjà en attente ou en cours pour ce club.", "RECONCILE_SCHEDULE_ALREADY_QUEUED");
    }
    throw new Error(`Création du job de rapprochement calendrier échouée : ${error.message}`);
  }

  return c.json({ queued: true as const });
});

/**
 * POST /v1/clubs/:clubId/integrations/fbi/check-all-derogations — "je veux
 * un bouton global qui check toutes les demandes, pas match par match"
 * (demande du club, 2026-09-25, voir docs/FBI.md). SYNCHRONE depuis
 * 2026-09-28 ("doit y avoir rien en attente" — l'ancien modèle empilait un
 * job `fbi_jobs`, mais chaque clic sur "Traiter les jobs en attente" ne
 * traitait qu'UN job du club, potentiellement un AUTRE plus ancien, jamais
 * forcément celui-ci — confusion directe constatée en production, "ca
 * marche tjr pas" pendant qu'un job restait en attente plus d'une
 * journée). `checkAllDerogationsForClubSync` login/consulte/enregistre
 * DANS cette requête et renvoie le résultat immédiatement — le cron
 * quotidien (`enqueue-fbi-verifications.ts`) continue lui d'empiler un job
 * `check_all_derogations` séparément, traité en arrière-plan (voir sa
 * doc). LECTURE SEULE : ne soumet/modifie jamais une dérogation.
 */
integrationsRouter.post("/fbi/check-all-derogations", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();

  const result = await checkAllDerogationsForClubSync(serviceSupabase, { clubId: club.id });

  return c.json(result);
});

/**
 * POST /v1/clubs/:clubId/integrations/fbi/parse-documents — §9 de la
 * demande, deuxième étape du même problème : `POST .../fbi/process-jobs`
 * télécharge les documents e-Marque (Playwright), mais ne les PARSE pas —
 * c'est une étape séparée (`parseDownloadedEmarqueDocuments`, jamais de
 * navigateur, juste OCR/PDF), qui ne tournait jusqu'ici QUE via
 * `/internal/cron/emarque-parse` (une fois par jour). Sans elle, un
 * document "Téléchargé" ne devient jamais "Importé" — rien à afficher côté
 * composition/stats/officiels tant que ce n'est pas fait (constaté en
 * production le 2026-09-24 : 14 documents `downloaded`, 0 `emarque_imports`).
 *
 * `CLUB_PARSE_BATCH_SIZE` (10, plus élevé que `CLUB_JOB_BATCH_SIZE` : pas
 * de navigateur ici, un parsing OCR/PDF est nettement plus rapide qu'un
 * login+scrape FBI) borne le lot pour rester sous `maxDuration: 300` même
 * si beaucoup de documents attendent.
 */
integrationsRouter.post("/fbi/parse-documents", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();

  const { parseDownloadedEmarqueDocuments } = await import("../../jobs/parse-downloaded-documents.js");
  const result = await parseDownloadedEmarqueDocuments(serviceSupabase, { clubId: club.id, limit: CLUB_PARSE_BATCH_SIZE });

  return c.json(result);
});

/** GET /v1/clubs/:clubId/sync-runs */
integrationsRouter.get("/sync-runs", async (c) => {
  const { club } = c.get("club");
  const { data, error } = await c
    .get("supabase")
    .from("sync_runs")
    .select("id, provider, status, started_at, finished_at, error_log")
    .eq("club_id", club.id)
    .order("started_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(`Lecture des synchronisations échouée : ${error.message}`);

  const syncRuns: SyncRunDto[] = (data ?? []).map((run) => ({
    id: run.id,
    provider: run.provider,
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    errorLog: run.error_log,
  }));

  return c.json({ syncRuns });
});

/**
 * POST /v1/clubs/:clubId/integrations/ffbb/sync — diagnostic admin (§18 de
 * la demande), le cron fait déjà tourner ce même service automatiquement.
 *
 * Acquiert `try_acquire_sync_lock` (même verrou que `scheduler.ts`, voir
 * supabase/migrations/20260921100070_sync_locks.sql) — jusqu'ici ce verrou
 * n'était posé QUE côté cron, jamais ici : un admin cliquant plusieurs fois
 * sur "Relancer maintenant", ou un clic pendant que le cron tourne déjà,
 * lançait deux `syncFfbb` en parallèle pour le même club (constaté en
 * production dans l'historique `sync_runs`, voir docs/FFBB.md). 409 explicite
 * plutôt qu'un chevauchement silencieux.
 */
integrationsRouter.post("/ffbb/sync", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();

  const { data: acquired, error: lockError } = await serviceSupabase.rpc("try_acquire_sync_lock", {
    p_club_id: club.id,
    p_integration: "ffbb",
  });
  if (lockError) throw new Error(`Acquisition du verrou de synchronisation échouée : ${lockError.message}`);
  if (!acquired) {
    throw conflict("Une synchronisation FFBB est déjà en cours pour ce club — réessaie dans quelques minutes.", "FFBB_SYNC_ALREADY_RUNNING");
  }

  try {
    const result = await syncFfbb(serviceSupabase, new FfbbPublicProvider(), { id: club.id, ffbbClubId: club.ffbbClubId });
    return c.json({ syncRunId: result.syncRunId, status: result.status, stats: result.stats });
  } catch (error) {
    logError("Synchronisation FFBB manuelle échouée", error, { clubId: club.id });
    throw error;
  } finally {
    await serviceSupabase.rpc("release_sync_lock", { p_club_id: club.id, p_integration: "ffbb" });
  }
});

/**
 * PATCH /v1/clubs/:clubId/integrations/ffbb (gap 2 de la demande) — change
 * la source FFBB (`clubCode`) et/ou active/désactive la synchro
 * (`enabled`). `ffbb_club_id`/`ffbb_enabled`/`ffbb_next_sync_at` ne sont
 * PAS dans le privilège de colonne `authenticated` sur `clubs` (voir
 * `PATCH /v1/clubs/:clubId` plus haut) : cette route utilise volontairement
 * la service role, seulement après `requireClubRole("club_admin")`, même
 * schéma que `POST .../fbi`.
 *
 * Change de source de données SANS jamais supprimer l'historique déjà
 * synchronisé (§4 de la demande) — un `UPDATE` sur `clubs`, jamais un
 * `DELETE` sur `matches`. Un changement de code valide replanifie
 * immédiatement une resynchronisation (`ffbb_next_sync_at = now()`)
 * plutôt que d'attendre jusqu'à `FFBB_SYNC_INTERVAL_MINUTES`.
 */
integrationsRouter.patch("/ffbb", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const body = await c.req.json().catch(() => ({}));
  const parsed = PatchFfbbIntegrationDtoSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((issue) => issue.message).join(" "));
  }

  if (parsed.data.clubCode === undefined && parsed.data.enabled === undefined) {
    throw badRequest("Au moins un champ (clubCode ou enabled) est requis.");
  }

  const patch: { ffbb_club_id?: string; ffbb_next_sync_at?: string; ffbb_enabled?: boolean } = {};
  if (parsed.data.clubCode !== undefined) {
    patch.ffbb_club_id = parsed.data.clubCode;
    patch.ffbb_next_sync_at = new Date().toISOString();
  }
  if (parsed.data.enabled !== undefined) patch.ffbb_enabled = parsed.data.enabled;

  const serviceSupabase = createServiceSupabaseClient();
  const { data, error } = await serviceSupabase.from("clubs").update(patch).eq("id", club.id).select("ffbb_club_id, ffbb_enabled, ffbb_next_sync_at").single();

  if (error) throw new Error(`Mise à jour de l'intégration FFBB échouée : ${error.message}`);

  return c.json({
    clubCode: data.ffbb_club_id,
    enabled: data.ffbb_enabled,
    nextSyncAt: data.ffbb_next_sync_at,
  });
});
