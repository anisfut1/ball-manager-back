import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";
import { encryptSecret } from "../../security/crypto.js";
import { FbiError } from "../../integrations/fbi/errors.js";
import { conflict } from "../../api-error.js";

let state: FakeClubSupabaseState;
let currentUserId = "user-a";

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return { ...actual, verifyAccessToken: vi.fn(async () => ({ id: currentUserId, email: `${currentUserId}@example.test` })) };
});

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { mockSyncFfbb } = vi.hoisted(() => ({ mockSyncFfbb: vi.fn() }));
vi.mock("../../integrations/ffbb/sync.js", () => ({ syncFfbb: mockSyncFfbb }));
vi.mock("../../integrations/ffbb/public-provider.js", () => ({ FfbbPublicProvider: vi.fn() }));

const { mockHttpLogin } = vi.hoisted(() => ({ mockHttpLogin: vi.fn() }));
vi.mock("../../integrations/fbi/http-client.js", () => ({
  HttpFbiClient: class FakeHttpFbiClient {
    login = mockHttpLogin;
  },
}));

const { mockAttemptBrowserFbiLogin } = vi.hoisted(() => ({ mockAttemptBrowserFbiLogin: vi.fn() }));
vi.mock("../../integrations/fbi/browser-login-attempt.js", () => ({ attemptBrowserFbiLogin: mockAttemptBrowserFbiLogin }));

const { mockClaimNextJobForClub } = vi.hoisted(() => ({ mockClaimNextJobForClub: vi.fn() }));
vi.mock("../../jobs/claim.js", () => ({ claimNextJobForClub: mockClaimNextJobForClub }));

const { mockProcessTestConnectionJob } = vi.hoisted(() => ({ mockProcessTestConnectionJob: vi.fn() }));
vi.mock("../../jobs/process-test-connection.js", () => ({ processTestConnectionJob: mockProcessTestConnectionJob }));

const { mockProcessDiscoverEmarqueJob } = vi.hoisted(() => ({ mockProcessDiscoverEmarqueJob: vi.fn() }));
vi.mock("../../jobs/process-discover-emarque.js", () => ({ processDiscoverEmarqueJob: mockProcessDiscoverEmarqueJob }));

const { mockParseDownloadedEmarqueDocuments } = vi.hoisted(() => ({ mockParseDownloadedEmarqueDocuments: vi.fn() }));
vi.mock("../../jobs/parse-downloaded-documents.js", () => ({ parseDownloadedEmarqueDocuments: mockParseDownloadedEmarqueDocuments }));

const { mockCheckAllDerogationsForClubSync } = vi.hoisted(() => ({ mockCheckAllDerogationsForClubSync: vi.fn() }));
vi.mock("../derogations/check-all-derogations-sync.js", () => ({ checkAllDerogationsForClubSync: mockCheckAllDerogationsForClubSync }));

const { app } = await import("../../app.js");
const { resetEnvCacheForTests } = await import("../../config/env.js");

const CLUB_A = {
  id: "aaaaaaaa-0000-0000-0000-000000000000",
  slug: "club-a",
  name: "Club A Basket",
  short_name: null,
  logo_url: null,
  accent_color: null,
  timezone: "Europe/Paris",
  status: "active" as const,
  ffbb_club_id: "AAA0000001",
  ffbb_enabled: true,
  ffbb_next_sync_at: null,
};

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}${path}`, {
    ...init,
    headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers },
  });
}

beforeEach(() => {
  currentUserId = "user-a";
  mockSyncFfbb.mockReset();
  mockSyncFfbb.mockResolvedValue({ syncRunId: "run-1", status: "success", stats: {} });
  mockHttpLogin.mockReset();
  mockHttpLogin.mockResolvedValue({ cookieJar: {} });
  mockAttemptBrowserFbiLogin.mockReset();
  mockClaimNextJobForClub.mockReset();
  mockClaimNextJobForClub.mockResolvedValue(null);
  mockProcessTestConnectionJob.mockReset();
  mockProcessDiscoverEmarqueJob.mockReset();
  mockParseDownloadedEmarqueDocuments.mockReset();
  mockParseDownloadedEmarqueDocuments.mockResolvedValue({ candidatesExamined: 0, imported: 0, errors: 0 });
  delete process.env.BROWSER_FBI_ENABLED;
  resetEnvCacheForTests();
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }],
    memberships: [
      { id: "membership-a1", club_id: CLUB_A.id, user_id: "user-a", status: "active" },
      { id: "membership-a2-coach", club_id: CLUB_A.id, user_id: "user-coach", status: "active" },
    ],
    roles: [
      { membership_id: "membership-a1", role: "club_admin" },
      { membership_id: "membership-a2-coach", role: "coach" },
    ],
  });
});

describe("PATCH /integrations/ffbb (gap 2 de la demande)", () => {
  it("club_admin peut changer le code club FFBB — replanifie next_sync_at", async () => {
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ clubCode: "occ0099999" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clubCode).toBe("OCC0099999"); // normalisé en majuscules
    expect(body.nextSyncAt).not.toBeNull();
    expect(state.clubs[0]!.ffbb_club_id).toBe("OCC0099999");
  });

  it("un coach reçoit 403", async () => {
    currentUserId = "user-coach";
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ clubCode: "OCC0099999" }) });
    expect(res.status).toBe(403);
  });

  it("rejette un code FFBB mal formé (validation sérieuse)", async () => {
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ clubCode: "a" }) });
    expect(res.status).toBe(400);
  });

  it("rejette un corps vide (au moins un champ requis)", async () => {
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it("enabled=false désactive la synchro sans toucher au code club", async () => {
    const res = await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(res.status).toBe(200);
    expect(state.clubs[0]!.ffbb_enabled).toBe(false);
    expect(state.clubs[0]!.ffbb_club_id).toBe("AAA0000001");
  });

  it("ne supprime jamais l'historique déjà synchronisé (aucun DELETE sur matches — cette route ne touche que `clubs`)", async () => {
    await request("/integrations/ffbb", { method: "PATCH", body: JSON.stringify({ clubCode: "OCC0099999" }) });
    // Le fake Supabase ne connaît PAS la table `matches` : si la route
    // tentait d'y toucher, cet appel lèverait "Table inattendue" et le test précédent aurait déjà échoué.
    expect(state.clubs).toHaveLength(1);
  });
});

describe("PATCH /integrations/fbi (gap 4 de la demande)", () => {
  it("rejette autoImportEmarque=true sans identifiants configurés (FBI_NOT_CONFIGURED, §6 de la demande)", async () => {
    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ autoImportEmarque: true }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("FBI_NOT_CONFIGURED");
  });

  it("rejette enabled=true sans identifiants configurés", async () => {
    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    expect(res.status).toBe(409);
  });

  it("enabled=false est toujours permis, même sans identifiants configurés", async () => {
    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(res.status).toBe(200);
  });

  it("autoImportEmarque=true fonctionne une fois des identifiants enregistrés, et ne redemande jamais username/password", async () => {
    const encrypted = encryptSecret("s3cret-fbi-password", CLUB_A.id);
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_auth_tag: encrypted.authTag,
    });

    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ autoImportEmarque: true }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fbi.autoImportEmarque).toBe(true);
    expect(body.fbi.username).toBe("club-a-fbi"); // gap 8 : le username reste affichable
    expect(JSON.stringify(body)).not.toMatch(/ciphertext|password/i);
  });

  it("un coach reçoit 403", async () => {
    currentUserId = "user-coach";
    const res = await request("/integrations/fbi", { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(res.status).toBe(403);
  });
});

describe("GET /integrations (gap 8 de la demande)", () => {
  it("expose le username FBI configuré, jamais le mot de passe", async () => {
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: "secret-cipher",
      password_iv: "iv",
      password_auth_tag: "tag",
    });

    const res = await request("/integrations", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fbi.username).toBe("club-a-fbi");
    expect(JSON.stringify(body)).not.toContain("secret-cipher");
  });

  it("username = null quand FBI n'est pas configuré (jamais une erreur)", async () => {
    const res = await request("/integrations", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fbi.username).toBeNull();
    expect(body.fbi.configured).toBe(false);
  });

  it("activeJob = null quand aucun job n'est en cours pour ce club", async () => {
    const res = await request("/integrations", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fbi.activeJob).toBeNull();
  });

  it("expose le job FBI en cours (claimed, récent) — retour du club : 'savoir quand ya un truc en cours'", async () => {
    state.fbiJobs.push({
      id: "job-active",
      club_id: CLUB_A.id,
      match_id: null,
      type: "check_all_derogations",
      status: "claimed",
      claimed_at: new Date(Date.now() - 3 * 60_000).toISOString(),
    });

    const res = await request("/integrations", { method: "GET" });
    const body = await res.json();
    expect(body.fbi.activeJob).toMatchObject({ type: "check_all_derogations" });
  });

  it("ignore un job claimed VIEUX (> 10 min) — tué par un timeout/crash, ne bloque plus rien (même garde-fou que claim_next_fbi_job)", async () => {
    state.fbiJobs.push({
      id: "job-stale",
      club_id: CLUB_A.id,
      match_id: null,
      type: "discover_emarque",
      status: "claimed",
      claimed_at: new Date(Date.now() - 15 * 60_000).toISOString(),
    });

    const res = await request("/integrations", { method: "GET" });
    const body = await res.json();
    expect(body.fbi.activeJob).toBeNull();
  });

  it("ignore un job d'un AUTRE club (isolation tenant)", async () => {
    state.fbiJobs.push({
      id: "job-other-club",
      club_id: "bbbbbbbb-0000-0000-0000-000000000000",
      match_id: null,
      type: "check_all_derogations",
      status: "claimed",
      claimed_at: new Date().toISOString(),
    });

    const res = await request("/integrations", { method: "GET" });
    const body = await res.json();
    expect(body.fbi.activeJob).toBeNull();
  });
});

describe("POST /integrations/ffbb/sync — verrou de concurrence", () => {
  it("synchronise et libère le verrou, même déclenché plusieurs fois d'affilée", async () => {
    const res1 = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res1.status).toBe(200);
    expect(mockSyncFfbb).toHaveBeenCalledTimes(1);

    // Le verrou a été libéré après le premier appel : un second déclenchement passe aussi.
    const res2 = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res2.status).toBe(200);
    expect(mockSyncFfbb).toHaveBeenCalledTimes(2);
  });

  it("refuse avec 409 un déclenchement pendant qu'une synchronisation est déjà en cours pour ce club", async () => {
    state.syncLocks.add(`${CLUB_A.id}:ffbb`);

    const res = await request("/integrations/ffbb/sync", { method: "POST" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("FFBB_SYNC_ALREADY_RUNNING");
    expect(mockSyncFfbb).not.toHaveBeenCalled();
  });

  it("libère le verrou même si syncFfbb lève une exception (jamais de verrou bloqué durablement)", async () => {
    mockSyncFfbb.mockRejectedValueOnce(new Error("panne FFBB simulée"));

    const res = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res.status).toBe(500);
    expect(state.syncLocks.has(`${CLUB_A.id}:ffbb`)).toBe(false);

    // Le verrou étant libéré, un nouveau déclenchement est accepté.
    const res2 = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res2.status).toBe(200);
  });

  it("un coach reçoit 403 (jamais d'acquisition de verrou pour un rôle non autorisé)", async () => {
    currentUserId = "user-coach";
    const res = await request("/integrations/ffbb/sync", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockSyncFfbb).not.toHaveBeenCalled();
  });
});

describe("POST /integrations/fbi/test", () => {
  it("connexion réussie : efface un last_error précédent (jamais un statut « Connecté » affiché à côté d'une erreur périmée)", async () => {
    const encrypted = encryptSecret("s3cret-fbi-password", CLUB_A.id);
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_auth_tag: encrypted.authTag,
    });
    state.fbiIntegrationStatus.push({
      club_id: CLUB_A.id,
      configured: true,
      last_login_success: false,
      last_login_at: null,
      auto_import_emarque: false,
      last_error: "Connexion FBI impossible : identifiant ou mot de passe incorrect.",
    });

    const res = await request("/integrations/fbi/test", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(state.fbiIntegrationStatus.find((r) => r.club_id === CLUB_A.id)?.last_error).toBeNull();
  });

  it("connexion refusée : enregistre le message d'erreur", async () => {
    const encrypted = encryptSecret("mauvais-mdp", CLUB_A.id);
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_auth_tag: encrypted.authTag,
    });
    mockHttpLogin.mockRejectedValue(new FbiError("refusé", "LOGIN_FAILED"));

    const res = await request("/integrations/fbi/test", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(state.fbiIntegrationStatus.find((r) => r.club_id === CLUB_A.id)?.last_error).not.toBeNull();
  });

  it("HTTP refusé + BROWSER_FBI_ENABLED=true : bascule sur le navigateur DANS LA MÊME REQUÊTE (jamais un job/202 — un admin qui clique attend un résultat immédiat, voir docs/FBI.md)", async () => {
    process.env.BROWSER_FBI_ENABLED = "true";
    resetEnvCacheForTests();

    const encrypted = encryptSecret("s3cret-fbi-password", CLUB_A.id);
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_auth_tag: encrypted.authTag,
    });
    mockHttpLogin.mockRejectedValue(new FbiError("refusé côté HTTP", "LOGIN_FAILED"));
    mockAttemptBrowserFbiLogin.mockResolvedValue({ success: true, message: "Connexion réussie (navigateur).", loginStatus: "CONNECTED" });

    const res = await request("/integrations/fbi/test", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.jobId).toBeUndefined();
    expect(body.success).toBe(true);
    expect(body.message).toBe("Connexion réussie (navigateur).");
    expect(mockAttemptBrowserFbiLogin).toHaveBeenCalledOnce();
    const status = state.fbiIntegrationStatus.find((r) => r.club_id === CLUB_A.id);
    expect(status?.last_login_success).toBe(true);
    expect(status?.last_error).toBeNull();
  });

  it("échec HTTP puis navigateur : enregistre le message du navigateur comme dernière erreur", async () => {
    process.env.BROWSER_FBI_ENABLED = "true";
    resetEnvCacheForTests();

    const encrypted = encryptSecret("s3cret-fbi-password", CLUB_A.id);
    state.fbiCredentials.push({
      club_id: CLUB_A.id,
      username: "club-a-fbi",
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_auth_tag: encrypted.authTag,
    });
    mockHttpLogin.mockRejectedValue(new FbiError("refusé côté HTTP", "LOGIN_FAILED"));
    mockAttemptBrowserFbiLogin.mockResolvedValue({ success: false, message: "Vos identifiants ne sont pas corrects.", loginStatus: "INVALID_CREDENTIALS" });

    const res = await request("/integrations/fbi/test", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.message).toBe("Vos identifiants ne sont pas corrects.");
    expect(state.fbiIntegrationStatus.find((r) => r.club_id === CLUB_A.id)?.last_error).toBe("Vos identifiants ne sont pas corrects.");
  });
});

describe("POST /integrations/fbi/process-jobs (§9 : traiter les jobs FBI en attente sans passer par le dashboard Vercel)", () => {
  function makeJob(overrides: Partial<{ id: string; type: "test_connection" | "discover_emarque" }> = {}) {
    return {
      id: overrides.id ?? "job-1",
      club_id: CLUB_A.id,
      match_id: "match-1",
      type: overrides.type ?? "discover_emarque",
      status: "claimed" as const,
      attempt_count: 1,
      max_attempts: 6,
      scheduled_at: "2026-01-01T00:00:00.000Z",
      claimed_at: "2026-01-01T00:00:00.000Z",
      claimed_by: "worker",
      started_at: null,
      finished_at: null,
      last_error: null,
      result: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };
  }

  it("aucun job en attente : renvoie claimed=0 sans appeler les processeurs", async () => {
    const res = await request("/integrations/fbi/process-jobs", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ claimed: 0, succeeded: 0, failed: 0 });
    expect(mockProcessDiscoverEmarqueJob).not.toHaveBeenCalled();
    expect(mockProcessTestConnectionJob).not.toHaveBeenCalled();
  });

  it("traite un lot de jobs de ce club, dispatché par type", async () => {
    /**
     * Un seul job réel par requête depuis le 2026-09-24 (§ "Vingt-deuxième
     * déclenchement", docs/FBI.md : CLUB_JOB_BATCH_SIZE réduit de 3 à 1 —
     * un job discover_emarque réel contre le vrai FBI peut prendre ~3min30,
     * un lot de plusieurs risquait de dépasser maxDuration: 300). Deux
     * requêtes successives (le bouton "Traiter les jobs FBI en attente"
     * boucle déjà côté ball-manager-web) couvrent toujours le dispatch par type.
     */
    const jobs = [makeJob({ id: "job-1", type: "discover_emarque" }), makeJob({ id: "job-2", type: "test_connection" })];
    mockClaimNextJobForClub.mockImplementation(() => Promise.resolve(jobs.shift() ?? null));
    mockProcessDiscoverEmarqueJob.mockResolvedValue(true);
    mockProcessTestConnectionJob.mockResolvedValue(true);

    const res1 = await request("/integrations/fbi/process-jobs", { method: "POST" });
    expect(res1.status).toBe(200);
    expect(await res1.json()).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    const res2 = await request("/integrations/fbi/process-jobs", { method: "POST" });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ claimed: 1, succeeded: 1, failed: 0 });

    expect(mockProcessDiscoverEmarqueJob).toHaveBeenCalledTimes(1);
    expect(mockProcessTestConnectionJob).toHaveBeenCalledTimes(1);
  });

  it("réclame exclusivement les jobs de CE club (jamais ceux d'un autre club)", async () => {
    await request("/integrations/fbi/process-jobs", { method: "POST" });

    expect(mockClaimNextJobForClub).toHaveBeenCalledWith(expect.anything(), CLUB_A.id, expect.any(String));
  });

  it("un coach reçoit 403 (jamais de réclamation de job pour un rôle non autorisé)", async () => {
    currentUserId = "user-coach";
    const res = await request("/integrations/fbi/process-jobs", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockClaimNextJobForClub).not.toHaveBeenCalled();
  });
});

describe("POST /integrations/fbi/parse-documents (deuxième étape : documents téléchargés → participants/stats/officiels affichables)", () => {
  it("appelle parseDownloadedEmarqueDocuments scopé à CE club avec un plafond de lot, et renvoie le résumé", async () => {
    mockParseDownloadedEmarqueDocuments.mockResolvedValue({ candidatesExamined: 3, imported: 2, errors: 1 });

    const res = await request("/integrations/fbi/parse-documents", { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ candidatesExamined: 3, imported: 2, errors: 1 });
    expect(mockParseDownloadedEmarqueDocuments).toHaveBeenCalledWith(expect.anything(), { clubId: CLUB_A.id, limit: expect.any(Number) });
  });

  it("un coach reçoit 403 (jamais de parsing déclenché pour un rôle non autorisé)", async () => {
    currentUserId = "user-coach";
    const res = await request("/integrations/fbi/parse-documents", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockParseDownloadedEmarqueDocuments).not.toHaveBeenCalled();
  });
});

describe("POST /integrations/fbi/check-all-derogations (voir docs/FBI.md — SYNCHRONE depuis 2026-09-28, 'doit y avoir rien en attente')", () => {
  it("délègue à checkAllDerogationsForClubSync (scopé au club) et renvoie son résultat immédiatement", async () => {
    mockCheckAllDerogationsForClubSync.mockResolvedValueOnce({ derogationsFound: 3, matched: 2, unmatched: 1 });

    const res = await request("/integrations/fbi/check-all-derogations", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ derogationsFound: 3, matched: 2, unmatched: 1 });
    expect(mockCheckAllDerogationsForClubSync).toHaveBeenCalledWith(expect.anything(), { clubId: CLUB_A.id });
  });

  it("rejette (409) quand FBI n'est pas configuré (propagé depuis checkAllDerogationsForClubSync)", async () => {
    mockCheckAllDerogationsForClubSync.mockRejectedValueOnce(conflict("Configure d'abord un identifiant/mot de passe FBI avant de vérifier les dérogations.", "FBI_NOT_CONFIGURED"));

    const res = await request("/integrations/fbi/check-all-derogations", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("un coach reçoit 403 (jamais de vérification déclenchée pour un rôle non autorisé)", async () => {
    currentUserId = "user-coach";
    const res = await request("/integrations/fbi/check-all-derogations", { method: "POST" });
    expect(res.status).toBe(403);
    expect(mockCheckAllDerogationsForClubSync).not.toHaveBeenCalled();
  });
});
