import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";
import { hashPublicToken } from "../public-tables/token.js";
import { apnsPayload, isPermanentFailure, providerToken, type PushMessage, type PushResult, type PushSender } from "./apns.js";
import { notify, OUTBOX_MAX_ATTEMPTS, processOutbox, pushTargets, setPushSenderFactoryForTests } from "./service.js";
import { notifyMatchChange, notifyTrainingChange } from "./hooks.js";

/**
 * Notifications push (APNs simulé : AUCUN envoi réel dans ces tests).
 * Données fictives.
 */
let state: FakeClubSupabaseState;

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

const CLUB_A = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "A1", ffbb_enabled: true, ffbb_next_sync_at: null };
const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", name: "Club B", ffbb_club_id: "B1" };
const U15 = "11111111-1111-4111-8111-000000000015";
const LINA = "44444444-4444-4444-8444-000000000001";
const HUGO = "44444444-4444-4444-8444-000000000002";
const EMMA = "44444444-4444-4444-8444-000000000003";
const DEVICE_1 = "a".repeat(64);
const DEVICE_2 = "b".repeat(64);

function lic(id: string, firstName: string): FakeLicencieRow {
  return { id, club_id: CLUB_A.id, first_name: firstName, last_name: "MARTIN", license_number: null, birth_date: "2012-01-01", email: null, phone: null, photo_url: null, active: true, team_id: U15 } as FakeLicencieRow;
}

const pub = (slug: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.request(`/v1/public/clubs/${slug}${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(init.headers ?? {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

/** Expéditeur simulé : enregistre les envois, réponses programmables par jeton. */
function fakeSender(responses: Record<string, PushResult> = {}) {
  const sent: { token: string; environment: string; message: PushMessage }[] = [];
  const sender: PushSender = {
    send: async (token, environment, message) => {
      sent.push({ token, environment, message });
      return responses[token] ?? { ok: true };
    },
    close: () => {},
  };
  return { sent, sender, responses };
}

let apns: ReturnType<typeof fakeSender>;
const db = () => buildFakeClubSupabase(state);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T08:00:00.000Z"));
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    teams: [{ id: U15, club_id: CLUB_A.id, name: "U15", sexe: "F", active: true }],
    licencies: [lic(LINA, "Lina"), lic(HUGO, "Hugo"), lic(EMMA, "Emma")],
  });
  state.publicTokens = (
    [
      ["lina", LINA],
      ["hugo", HUGO],
      ["emma", EMMA],
    ] as const
  ).map(([k, id]) => ({ id: `tok-${k}`, club_id: CLUB_A.id, licencie_id: id, token_hash: hashPublicToken(`token-${k}-0000`), token_ciphertext: null, email: `${k}@example.test`, created_at: "2026-10-01T00:00:00Z", revoked_at: null, revoked_by: null }));
  apns = fakeSender();
  setPushSenderFactoryForTests(() => apns.sender);
});
afterEach(() => vi.useRealTimers());

async function device(tokens: string[], pushToken?: string, environment: "development" | "production" = "production") {
  const res = await pub("club-a", "/auth/device-sessions", { method: "POST", body: { tokens, platform: "ios" } });
  expect(res.status).toBe(201);
  const { sessionSecret } = (await res.json()) as { sessionSecret: string };
  if (pushToken) {
    const put = await pub("club-a", "/auth/session/push-token", { method: "PUT", headers: bearer(sessionSecret), body: { token: pushToken, environment, appVersion: "1.0.0" } });
    expect(put.status).toBe(204);
  }
  return sessionSecret;
}

const convocation = (licencieIds: string[], dedupeKey = "convocation:c1:r1") =>
  notify(db(), { clubId: CLUB_A.id, kind: "CONVOCATION_NEW", dedupeKey, licencieIds, title: "Nouvelle convocation", body: "Tu es convoqué pour un prochain match. Confirme ta présence.", path: (slug) => `/public/${slug}/matchs/m1#convocation` });

describe("jeton push (PUT / DELETE …/auth/session/push-token)", () => {
  it("session d'appareil obligatoire ; jeton APNs validé", async () => {
    expect((await pub("club-a", "/auth/session/push-token", { method: "PUT", body: { token: DEVICE_1, environment: "production" } })).status).toBe(401);
    const secret = await device(["token-lina-0000"]);
    const bad = await pub("club-a", "/auth/session/push-token", { method: "PUT", headers: bearer(secret), body: { token: "pas-un-jeton", environment: "production" } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    expect(state.devicePushTokens).toHaveLength(0);
  });

  it("un jeton par session (ré-enregistrement = mise à jour) ; DELETE coupe les notifications", async () => {
    const secret = await device(["token-lina-0000"], DEVICE_1, "development");
    await pub("club-a", "/auth/session/push-token", { method: "PUT", headers: bearer(secret), body: { token: DEVICE_2, environment: "production" } });
    expect(state.devicePushTokens).toHaveLength(1);
    expect(state.devicePushTokens[0]).toMatchObject({ token: DEVICE_2, environment: "production", revoked_at: null });
    expect((await pub("club-a", "/auth/session/push-token", { method: "DELETE", headers: bearer(secret) })).status).toBe(204);
    expect(await pushTargets(db(), CLUB_A.id, [LINA])).toEqual([]);
  });
});

describe("destinataires", () => {
  it("un appareil avec deux enfants convoqués : UNE notification", async () => {
    await device(["token-lina-0000", "token-hugo-0000"], DEVICE_1);
    await device(["token-emma-0000"], DEVICE_2);
    await convocation([LINA, HUGO]);
    expect(apns.sent.map((s) => s.token)).toEqual([DEVICE_1]);
    expect(apns.sent[0]!.message).toMatchObject({ path: "/public/club-a/matchs/m1#convocation", threadId: "CONVOCATION_NEW" });
    expect(state.notificationOutbox[0]).toMatchObject({ status: "sent", devices_sent: 1 });
  });

  it("déconnexion, lien réinitialisé par un admin, session expirée : plus rien", async () => {
    const lina = await device(["token-lina-0000"], DEVICE_1);
    await device(["token-hugo-0000"], DEVICE_2);
    await pub("club-a", "/auth/session", { method: "DELETE", headers: bearer(lina) });
    state.publicTokens.find((t) => t.id === "tok-hugo")!.revoked_at = "2026-10-11T07:00:00Z";
    await convocation([LINA, HUGO]);
    expect(apns.sent).toHaveLength(0);

    state.publicTokens.find((t) => t.id === "tok-hugo")!.revoked_at = null;
    for (const s of state.deviceSessions) s.expires_at = "2026-10-10T00:00:00Z";
    await convocation([HUGO], "convocation:c1:r2");
    expect(apns.sent).toHaveLength(0);
  });

  it("jamais l'appareil d'un autre club", async () => {
    await device(["token-lina-0000"], DEVICE_1);
    await notify(db(), { clubId: CLUB_B.id, kind: "CONVOCATION_NEW", dedupeKey: "b:1", licencieIds: [LINA], title: "t", body: "b", path: (s) => `/public/${s}/accueil` });
    expect(apns.sent).toHaveLength(0);
  });

  it("idempotence : la même clé n'envoie qu'une fois", async () => {
    await device(["token-lina-0000"], DEVICE_1);
    await convocation([LINA]);
    await convocation([LINA]);
    expect(apns.sent).toHaveLength(1);
    expect(state.notificationOutbox).toHaveLength(1);
  });

  it("push non configuré (pas de clé APNs) : rien n'est mis en file", async () => {
    setPushSenderFactoryForTests(() => null);
    await device(["token-lina-0000"], DEVICE_1);
    await convocation([LINA]);
    expect(state.notificationOutbox).toHaveLength(0);
    expect(await processOutbox(db())).toMatchObject({ enabled: false });
  });
});

describe("échecs APNs", () => {
  it("jeton invalide (410 / Unregistered) : révoqué, jamais réessayé", async () => {
    await device(["token-lina-0000"], DEVICE_1);
    apns.responses[DEVICE_1] = { ok: false, status: 410, reason: "Unregistered", permanent: true };
    await convocation([LINA]);
    expect(state.devicePushTokens[0]).toMatchObject({ revoked_reason: "Unregistered" });
    expect(state.notificationOutbox[0]).toMatchObject({ status: "sent", devices_sent: 0 });
  });

  it("échec passager : nouvel essai par le cron, puis abandon après 5 essais", async () => {
    await device(["token-lina-0000"], DEVICE_1);
    apns.responses[DEVICE_1] = { ok: false, status: 503, reason: "ServiceUnavailable", permanent: false };
    await convocation([LINA]);
    expect(state.notificationOutbox[0]).toMatchObject({ status: "pending", attempts: 1, last_error: "ServiceUnavailable" });

    // Pas encore dû : rien.
    expect(await processOutbox(db())).toMatchObject({ retried: 0, sent: 0 });
    for (let i = 2; i <= OUTBOX_MAX_ATTEMPTS; i += 1) {
      vi.setSystemTime(new Date(Date.now() + 20 * 60_000));
      await processOutbox(db(), { now: new Date() });
    }
    expect(state.notificationOutbox[0]).toMatchObject({ status: "failed", attempts: OUTBOX_MAX_ATTEMPTS });
  });

  it("le cron rattrape un envoi en attente, et expire après 24 h", async () => {
    await device(["token-lina-0000"], DEVICE_1);
    apns.responses[DEVICE_1] = { ok: false, status: 500, reason: "InternalServerError", permanent: false };
    await convocation([LINA]);
    delete apns.responses[DEVICE_1];
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    expect(await processOutbox(db(), { now: new Date() })).toMatchObject({ sent: 1 });

    await convocation([LINA], "convocation:c1:r9");
    const late = state.notificationOutbox.find((r) => r.dedupe_key === "convocation:c1:r9")!;
    Object.assign(late, { status: "pending", created_at: "2026-10-01T00:00:00Z", next_attempt_at: "2026-10-01T00:00:00Z" });
    expect(await processOutbox(db(), { now: new Date() })).toMatchObject({ expired: 1 });
  });
});

describe("déclencheurs", () => {
  it("synchro FFBB : match déplacé → « Match modifié » ; score seul → rien ; annulé → « Match annulé »", async () => {
    await device(["token-lina-0000"], DEVICE_1);
    const base = { clubId: CLUB_A.id, matchId: "m1", teamId: U15, matchDatetime: "2026-10-18T14:00:00Z", status: "scheduled", syncRunId: "run-1" };
    await notifyMatchChange(db(), { ...base, diffs: [{ field: "score_home", newValue: "60" }] });
    expect(apns.sent).toHaveLength(0);
    await notifyMatchChange(db(), { ...base, diffs: [{ field: "match_datetime", newValue: "2026-10-18T14:00:00Z" }] });
    await notifyMatchChange(db(), { ...base, syncRunId: "run-2", status: "cancelled", diffs: [{ field: "status", newValue: "cancelled" }] });
    expect(apns.sent.map((s) => s.message.title)).toEqual(["Match modifié", "Match annulé"]);
    expect(apns.sent[0]!.message.path).toBe("/public/club-a/matchs/m1");
  });

  it("match passé déplacé : rien", async () => {
    await device(["token-lina-0000"], DEVICE_1);
    await notifyMatchChange(db(), { clubId: CLUB_A.id, matchId: "m0", teamId: U15, matchDatetime: "2026-10-01T14:00:00Z", status: "scheduled", syncRunId: "r", diffs: [{ field: "match_datetime", newValue: "x" }] });
    expect(apns.sent).toHaveLength(0);
  });

  it("séance annulée : l'équipe est prévenue, chemin de la séance", async () => {
    await device(["token-lina-0000"], DEVICE_1);
    await notifyTrainingChange(db(), { clubId: CLUB_A.id, occurrence: { id: "o1", team_id: U15, starts_at: "2026-10-12T17:00:00Z" }, change: "cancelled" });
    expect(apns.sent[0]!.message).toMatchObject({ title: "Entraînement annulé", path: "/public/club-a/accueil#seance-o1" });
  });
});

describe("APNs (sans réseau)", () => {
  it("JWT fournisseur ES256 vérifiable, kid / iss / iat", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwt = providerToken({ teamId: "ABCDE12345", keyId: "KEY1234567" }, privateKey, 1_760_000_000);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toEqual({ iss: "ABCDE12345", iat: 1_760_000_000 });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  it("contenu : titre, phrase, chemin — rien d'autre", () => {
    expect(JSON.parse(apnsPayload({ title: "Nouvelle convocation", body: "Confirme ta présence.", path: "/public/x/matchs/m1#convocation", threadId: "CONVOCATION_NEW" }))).toEqual({
      aps: { alert: { title: "Nouvelle convocation", body: "Confirme ta présence." }, sound: "default", "thread-id": "CONVOCATION_NEW" },
      path: "/public/x/matchs/m1#convocation",
    });
    expect(isPermanentFailure(410, "")).toBe(true);
    expect(isPermanentFailure(400, "BadDeviceToken")).toBe(true);
    expect(isPermanentFailure(429, "TooManyRequests")).toBe(false);
  });
});
