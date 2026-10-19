/**
 * Worker FBI local (2026-10-07) : récupère les feuilles e-Marque avec le code
 * de PRODUCTION depuis un poste dont l'accès à FBI fonctionne (Mac du club),
 * à la place de Vercel, en gardant UNE session FBI ouverte :
 *
 * - un seul navigateur Chromium, lancé au démarrage et gardé ouvert ;
 * - une connexion FBI, puis la MÊME session réutilisée à chaque passe :
 *   aucune connexion tant qu'elle est authentifiée, aucune déconnexion ;
 * - chaque passe (15 min) commence par vérifier la session (page d'accueil
 *   FBI) ; renvoi vers l'identification = session expirée, journalisée avec
 *   ses preuves, traitements de la passe arrêtés. Nouvelle connexion : UNE
 *   seule, au plus tôt à la passe suivante et 12 min après la précédente
 *   (`FBI_LOCAL_RELOGIN=never` pour l'interdire) ;
 * - FBI injoignable (requête anonyme avant chaque passe) : passe sautée,
 *   session conservée ;
 * - prise de relais : bail de 30 min sur `fbi_paused_until`, renouvelé à
 *   chaque passe — Vercel ne se connecte plus à FBI ; libéré à l'arrêt
 *   (Ctrl+C), expiré seul si le poste s'éteint.
 *
 * Tous les jobs FBI du club passent par CETTE session : feuilles e-Marque,
 * calendrier (`reconcile_schedule`), dérogations (`check_all_derogations`,
 * `check_derogation`), test de connexion. Le parsing des feuilles et les
 * stats restent faits par l'API.
 *
 * Configuration : `.env.fbi-local` à la racine (voir README), sur le poste.
 * Journal : `fbi-local-worker-<date>.jsonl` (jamais d'identifiant, de mot de
 * passe ni de valeur de cookie).
 */
import { appendFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

const ENV_FILE = ".env.fbi-local";
if (!existsSync(ENV_FILE)) {
  console.error(`Fichier ${ENV_FILE} introuvable à la racine du dépôt — voir ops/fbi-local-worker/README.md.`);
  process.exit(1);
}
process.loadEnvFile(ENV_FILE);
// Sans la clé de chiffrement (variable « Sensitive » sur Vercel, illisible) :
// mot de passe FBI saisi au démarrage, gardé en mémoire le temps du processus.
// Clé factice uniquement pour la validation de configuration (jamais utilisée).
const ASK_PASSWORD = !process.env.FBI_CREDENTIALS_ENCRYPTION_KEY;
if (ASK_PASSWORD) process.env.FBI_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
process.env.BROWSER_FBI_ENABLED = "true";
process.env.FBI_LOCAL_BROWSER = "1";
// Requis par la validation de configuration de l'API, inutilisés ici.
process.env.CRON_SECRET ||= "worker-local-non-utilise";
process.env.FRONTEND_ORIGINS ||= "http://localhost";
// Notifications (synchro FFBB : match déplacé/annulé) : mises en file ici,
// envoyées par Vercel (cron /internal/cron/push), seul à avoir les clés APNs.
process.env.PUSH_QUEUE_ONLY = "1";

// Cadence (2026-10-07, après les premières passes : ~3 s de travail réel par
// feuille, la pause de 20 s dominait) — même session, aucune connexion en plus.
const INTERVAL_MIN = Number(process.env.FBI_LOCAL_INTERVAL_MIN || 5);
const MAX_JOBS_PER_PASS = Number(process.env.FBI_LOCAL_MAX_JOBS_PER_PASS || 10);
const PAUSE_BETWEEN_JOBS_MS = Number(process.env.FBI_LOCAL_PAUSE_MS || 5_000);
const RELOGIN = process.env.FBI_LOCAL_RELOGIN !== "never";
const LEASE_MIN = 30;
const BASE_URL = process.env.FBI_BASE_URL || "https://extranet.ffbb.com/fbi";

const { createServiceSupabaseClient } = await import("../../src/db/client.js");
const { claimNextJobForClub } = await import("../../src/jobs/claim.js");
const { enqueueEmarqueDiscoveryJobsForClub } = await import("../../src/jobs/enqueue-emarque.js");
const { enqueueFbiVerificationJobsForClub } = await import("../../src/jobs/enqueue-fbi-verifications.js");
const { processReconcileScheduleJob } = await import("../../src/jobs/process-reconcile-schedule.js");
const { processCheckAllDerogationsJob } = await import("../../src/jobs/process-check-all-derogations.js");
const { processCheckDerogationJob } = await import("../../src/jobs/process-check-derogation.js");
const { processImportLicencesJob } = await import("../../src/jobs/process-import-licences.js");
const { processDiscoverEmarqueJobInSession } = await import("../../src/jobs/process-discover-emarque.js");
const { checkFbiReachability, recordFbiReachability, recentFbiCredentialLogin } = await import("../../src/integrations/fbi/fbi-diagnostics.js");
const { getFbiCredentials } = await import("../../src/integrations/fbi/credentials-store.js");
const { launchServerlessBrowser } = await import("../../src/integrations/fbi/browser-launcher.js");
const { BrowserFbiClient } = await import("../../src/integrations/fbi/browser-client.js");
const selectors = await import("../../src/integrations/fbi/selectors.js");
const { ask } = await import("../fbi-session-worker/prompt.js");
const { syncAllDueClubs } = await import("../../src/integrations/ffbb/scheduler.js");
const { FfbbPublicProvider } = await import("../../src/integrations/ffbb/public-provider.js");
const { FFBB_LOCAL_LEASE_KEY } = await import("../../src/integrations/ffbb/local-lease.js");
type Session = Awaited<ReturnType<InstanceType<typeof BrowserFbiClient>["login"]>>;

const supabase = createServiceSupabaseClient();
const workerId = `local#${hostname()}`;
const logFile = `fbi-local-worker-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;

function record(event: string, data: Record<string, unknown> = {}, message?: string): void {
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
  console.log(`[${new Date().toISOString()}] ${message ?? event}`);
}

// Synchro FFBB depuis ce poste (2026-10-19) : api.ffbb.app refuse l'adresse
// de Vercel depuis le 13/10 mais répond à celle du club. `FFBB_LOCAL=0` pour
// la laisser à Vercel.
const FFBB_LOCAL = process.env.FFBB_LOCAL !== "0";

async function setFfbbLease(until: Date | null): Promise<void> {
  const { error } = await supabase
    .from("platform_settings")
    .upsert({ key: FFBB_LOCAL_LEASE_KEY, value: until ? until.toISOString() : "", updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) record("ffbb_lease_error", { error: error.message }, `bail FFBB : écriture impossible (${error.message})`);
}

/** Clubs dont la synchro FFBB est due (même planification que Vercel, pause de 6 h après un refus 403). */
async function syncFfbbIfDue(): Promise<void> {
  await setFfbbLease(new Date(Date.now() + LEASE_MIN * 60_000));
  try {
    const result = await syncAllDueClubs(supabase, new FfbbPublicProvider());
    if (result.clubsDue > 0) record("ffbb_sync", { ...result }, `synchro FFBB : ${result.clubsSynced} club(s) à jour, ${result.clubsFailed} en erreur`);
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    record("ffbb_sync", { error: message }, `synchro FFBB en erreur : ${message}`);
  }
}

async function setLease(until: Date | null): Promise<void> {
  const { error } = await supabase
    .from("platform_settings")
    .upsert({ key: "fbi_paused_until", value: until ? until.toISOString() : "", updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) record("lease_error", { error: error.message }, `bail Vercel : écriture impossible (${error.message})`);
}

// Club dont le compte FBI est utilisé (un seul aujourd'hui ; `FBI_LOCAL_CLUB_ID` pour choisir).
async function resolveClubId(): Promise<string> {
  if (process.env.FBI_LOCAL_CLUB_ID) return process.env.FBI_LOCAL_CLUB_ID;
  const { data, error } = await supabase.from("fbi_credentials").select("club_id");
  if (error || !data || data.length === 0) throw new Error(`aucun identifiant FBI en base (${error?.message ?? "table vide"})`);
  if (data.length > 1) throw new Error("plusieurs clubs ont des identifiants FBI : préciser FBI_LOCAL_CLUB_ID dans .env.fbi-local");
  return data[0].club_id;
}

const clubId = await resolveClubId();

let typedCredentials: { username: string; password: string } | null = null;
if (ASK_PASSWORD) {
  const { data } = await supabase.from("fbi_credentials").select("username").eq("club_id", clubId).maybeSingle();
  const username = data?.username || (await ask("Identifiant FBI : ", false));
  console.log(`Identifiant FBI : ${username}`);
  const password = await ask("Mot de passe FBI (masqué, gardé en mémoire seulement) : ", true);
  typedCredentials = { username, password };
}
const browser = await launchServerlessBrowser();
// Session complète (scripts FBI chargés) : le calendrier et les dérogations en ont besoin.
// Pas de limite Vercel ici : le détail de CHAQUE dérogation (demandeur, motif,
// horaire demandé, réponse) a le temps d'être lu, jamais tronqué à 220 s.
// Détail des dérogations : une page toutes les 5 s au plus (FBI_LOCAL_DETAIL_PAUSE_MS),
// seulement pour les dérogations nouvelles ou modifiées, arrêt si FBI ne répond plus.
const client = new BrowserFbiClient({
  baseUrl: BASE_URL,
  browser,
  derogationDetailBudgetMs: 25 * 60_000,
  derogationDetailPauseMs: Number(process.env.FBI_LOCAL_DETAIL_PAUSE_MS || 5_000),
});
let session: Session | null = null;
let sessionSince: string | null = null;
let expiredOnce = false;

async function jsessionFingerprint(): Promise<string | null> {
  if (!session) return null;
  const cookie = (await session.context.cookies(BASE_URL)).find((c) => c.name === "JSESSIONID");
  return cookie ? createHash("sha256").update(cookie.value).digest("hex").slice(0, 10) : null;
}

/** Page d'accueil FBI dans la session gardée : authentifiée, renvoyée vers l'identification, ou erreur réseau (jamais devinée). */
async function checkSession(): Promise<"authenticated" | "expired" | "network_error"> {
  if (!session) return "expired";
  const before = await jsessionFingerprint();
  try {
    const response = await session.page.goto(`${BASE_URL}/accueil.fbi`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const finalPath = new URL(session.page.url()).pathname;
    const passwordField = await selectors.looksLikeLoginPage(session.page);
    const expired = /\/(identification|connexion)\.fbi/.test(finalPath) || passwordField;
    record("session_check", { status: response?.status() ?? null, finalPath, passwordField, jsessionBefore: before, jsessionAfter: await jsessionFingerprint(), sessionSince }, `session : ${expired ? "EXPIRÉE (renvoi vers l'identification)" : "authentifiée"} — ouverte depuis ${sessionSince}`);
    return expired ? "expired" : "authenticated";
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : String(error);
    record("session_check", { error: message, sessionSince }, `session : vérification impossible (${message}) — session conservée`);
    return "network_error";
  }
}

/** UNE connexion, sans nouvel essai. */
async function loginOnce(): Promise<boolean> {
  const credentials = typedCredentials ?? (await getFbiCredentials(supabase, clubId));
  if (!credentials) {
    record("login", { ok: false, error: "aucun identifiant FBI" }, "connexion impossible : aucun identifiant FBI en base");
    return false;
  }
  await supabase.from("fbi_integration_status").upsert({ club_id: clubId, last_credential_login_at: new Date().toISOString() }, { onConflict: "club_id" });
  try {
    session = await client.login(credentials);
    sessionSince = new Date().toISOString();
    record("login", { ok: true, jsession: await jsessionFingerprint() }, "connexion FBI réussie — session gardée ouverte");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    record("login", { ok: false, error: message }, `connexion FBI échouée : ${message} (pas de nouvel essai avant la passe suivante)`);
    return false;
  }
}

async function dropSession(): Promise<void> {
  // Fermeture locale seulement : aucune requête de déconnexion vers FBI.
  await session?.context.close().catch(() => undefined);
  session = null;
  sessionSince = null;
}

async function pass(): Promise<void> {
  await setLease(new Date(Date.now() + LEASE_MIN * 60_000));
  // FFBB d'abord : indépendant de FBI (une passe FBI sautée ne bloque pas les matchs).
  if (FFBB_LOCAL) await syncFfbbIfDue();

  // Matchs tout juste passés « joués » (synchro FFBB) : recherche de feuille
  // créée dès cette passe, sans attendre le planificateur de l'API (base seule).
  const enqueued = await enqueueEmarqueDiscoveryJobsForClub(supabase, clubId).catch(() => null);
  if (enqueued?.jobsCreated) record("enqueued", { jobsCreated: enqueued.jobsCreated }, `${enqueued.jobsCreated} nouvelle(s) feuille(s) e-Marque à chercher`);
  // Dérogations + calendrier : une fois par jour (idempotent, base seule),
  // même sans aucun match à traiter.
  const verifications = await enqueueFbiVerificationJobsForClub(supabase, clubId).catch(() => null);
  if (verifications?.checkAllDerogationsCreated || verifications?.reconcileScheduleCreated) {
    record("enqueued", { verifications }, "vérification quotidienne des dérogations et du calendrier planifiée");
  }

  const { data: due, error } = await supabase
    .from("fbi_jobs")
    .select("id")
    .eq("status", "pending")
    .eq("club_id", clubId)
    .lte("scheduled_at", new Date().toISOString());
  if (error) return record("pass_skipped", { error: error.message }, `lecture des jobs impossible : ${error.message}`);

  const reachability = await checkFbiReachability(undefined);
  await recordFbiReachability(supabase, reachability);
  if (!reachability.ok) {
    return record("pass_skipped", { reachability }, `FBI injoignable (${reachability.error ?? `HTTP ${reachability.httpStatus}`}) : passe sautée, session conservée`);
  }

  if (session) {
    const state = await checkSession();
    if (state === "network_error") return;
    if (state === "expired") {
      expiredOnce = true;
      record("session_expired", { sessionSince }, "session FBI expirée : traitements de cette passe arrêtés");
      await dropSession();
      return;
    }
  }

  if (!due || due.length === 0) return record("idle", {}, `aucun job FBI à traiter${session ? " (session gardée ouverte)" : ""}`);

  if (!session) {
    if (expiredOnce && !RELOGIN) return record("pass_skipped", {}, "session expirée et FBI_LOCAL_RELOGIN=never : aucune nouvelle connexion");
    const lastLogin = await recentFbiCredentialLogin(supabase, clubId);
    if (lastLogin) return record("pass_skipped", { lastLogin }, `dernière connexion FBI à ${lastLogin.toISOString()} (< 12 min) : connexion à la passe suivante`);
    if (!(await loginOnce())) return;
  }

  for (let done = 0; done < MAX_JOBS_PER_PASS && session; done += 1) {
    const job = await claimNextJobForClub(supabase, clubId, workerId);
    if (!job) break;
    if (done > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_JOBS_MS));
    const outcome = await runJob(job, session);
    record("job", { jobId: job.id, type: job.type, matchId: job.match_id, outcome }, `${JOB_LABELS[job.type] ?? job.type}${job.match_id ? ` (match ${job.match_id})` : ""} : ${outcome}`);
    // Erreur : on n'enchaîne pas, la session est revérifiée à la passe suivante.
    if (outcome.startsWith("erreur")) break;
  }
}

const JOB_LABELS: Record<string, string> = {
  discover_emarque: "feuille e-Marque",
  reconcile_schedule: "calendrier FBI",
  check_all_derogations: "dérogations (toutes)",
  check_derogation: "dérogation",
  import_licences: "licences validées",
  test_connection: "test de connexion",
};

/** Un job, dans la session gardée — jamais de connexion ni de déconnexion ici. */
async function runJob(job: Awaited<ReturnType<typeof claimNextJobForClub>> & object, current: Session): Promise<string> {
  const shared = { client, session: current };
  switch (job.type) {
    case "discover_emarque": {
      const outcome = await processDiscoverEmarqueJobInSession(supabase, job, client, current);
      return outcome === "succeeded" ? "feuille récupérée" : outcome === "not_yet" ? "pas encore disponible (nouvel essai planifié)" : outcome === "error" ? "erreur FBI (nouvel essai planifié)" : "job invalide";
    }
    case "reconcile_schedule":
      return (await processReconcileScheduleJob(supabase, job, shared)) ? "calendrier rapproché" : "erreur (nouvel essai planifié)";
    case "check_all_derogations":
      return (await processCheckAllDerogationsJob(supabase, job, shared)) ? "dérogations vérifiées" : "erreur (nouvel essai planifié)";
    case "check_derogation":
      return (await processCheckDerogationJob(supabase, job, shared)) ? "dérogation vérifiée" : "erreur (nouvel essai planifié)";
    case "import_licences":
      return (await processImportLicencesJob(supabase, job, shared)) ? "licenciés mis à jour" : "erreur (nouvel essai planifié)";
    case "test_connection": {
      // La session gardée vient d'être vérifiée authentifiée en début de passe.
      const now = new Date().toISOString();
      await supabase.from("fbi_integration_status").upsert({ club_id: clubId, configured: true, last_test_at: now, last_test_success: true, last_test_message: "Connexion FBI valide (session du worker local)", updated_at: now }, { onConflict: "club_id" });
      await supabase.from("fbi_jobs").update({ status: "succeeded", finished_at: now, result: { loginStatus: "SUCCESS", via: "worker local" } }).eq("id", job.id);
      return "connexion valide";
    }
    default:
      await supabase.from("fbi_jobs").update({ status: "pending", scheduled_at: new Date(Date.now() + 60 * 60_000).toISOString(), last_error: `[info] Type de job non pris en charge par le worker local : ${job.type}` }).eq("id", job.id);
      return `erreur : type ${job.type} non pris en charge`;
  }
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(130);
  stopping = true;
  record("stopped", {}, "arrêt : baux FBI et FFBB libérés (Vercel reprend la main), navigateur fermé sans déconnexion FBI");
  void setLease(null)
    .then(() => (FFBB_LOCAL ? setFfbbLease(null) : undefined))
    .then(() => browser.close())
    .finally(() => process.exit(0));
});

record("started", { workerId, clubId, intervalMin: INTERVAL_MIN, maxJobsPerPass: MAX_JOBS_PER_PASS, relogin: RELOGIN, ffbbLocal: FFBB_LOCAL }, `worker FBI${FFBB_LOCAL ? " + FFBB" : ""} local démarré, une passe toutes les ${INTERVAL_MIN} min — journal ${logFile} — Ctrl+C pour arrêter`);
for (;;) {
  try {
    await pass();
  } catch (error) {
    record("pass_error", { error: error instanceof Error ? error.message.split("\n")[0] : String(error) }, `passe en erreur : ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MIN * 60_000));
}
