import { connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { getEnv } from "../../config/env.js";

/**
 * Envoi APNs direct (HTTP/2 + jeton JWT ES256 signé avec la clé .p8), sans
 * service tiers. Voir ball-manager-web/docs/IOS_PUSH.md.
 */

export type PushEnvironment = "development" | "production";

export interface PushMessage {
  title: string;
  body: string;
  /** Chemin relatif /public/{slug}/… ouvert par le routeur de l'app. */
  path: string;
  /** Regroupement dans le centre de notifications (ex. convocations). */
  threadId: string;
  /** Remplace une notification encore affichée pour la même ressource. */
  collapseId?: string;
}

export type PushResult =
  | { ok: true }
  /** `permanent` : jeton à révoquer (app supprimée, jeton d'un autre environnement…). */
  | { ok: false; status: number; reason: string; permanent: boolean };

export interface PushSender {
  send(token: string, environment: PushEnvironment, message: PushMessage): Promise<PushResult>;
  close(): void;
}

interface ApnsConfig {
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKey: string;
}

export function apnsConfig(): ApnsConfig | null {
  const env = getEnv();
  if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_PRIVATE_KEY) return null;
  return { teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID, bundleId: env.APNS_BUNDLE_ID, privateKey: env.APNS_PRIVATE_KEY.replace(/\\n/g, "\n") };
}

/** Push activé seulement si la clé APNs est configurée (sinon rien n'est mis en file). */
export function pushEnabled(): boolean {
  return apnsConfig() !== null;
}

const HOSTS: Record<PushEnvironment, string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** Raisons APNs qui signifient « ce jeton ne servira plus jamais ». */
const PERMANENT_REASONS = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic", "TopicDisallowed"]);

export function isPermanentFailure(status: number, reason: string): boolean {
  return status === 410 || PERMANENT_REASONS.has(reason);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** JWT du fournisseur (ES256, `iat` en secondes). Apple le refuse au-delà d'1 h : renouvelé toutes les 50 min. */
export function providerToken(config: Pick<ApnsConfig, "teamId" | "keyId">, key: KeyObject, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64url(JSON.stringify({ iss: config.teamId, iat: nowSeconds }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${b64url(signature)}`;
}

/** Contenu minimal sur l'écran verrouillé : titre + phrase courte, jamais de nom ni de donnée sensible. */
export function apnsPayload(message: PushMessage): string {
  return JSON.stringify({ aps: { alert: { title: message.title, body: message.body }, sound: "default", "thread-id": message.threadId }, path: message.path });
}

export function createApnsSender(config: ApnsConfig, now: () => number = Date.now): PushSender {
  const key = createPrivateKey(config.privateKey);
  let jwt: { value: string; at: number } | null = null;
  const sessions = new Map<PushEnvironment, ClientHttp2Session>();

  const bearer = () => {
    const t = now();
    if (!jwt || t - jwt.at > 50 * 60_000) jwt = { value: providerToken(config, key, Math.floor(t / 1000)), at: t };
    return jwt.value;
  };
  const session = (environment: PushEnvironment) => {
    let s = sessions.get(environment);
    if (!s || s.closed || s.destroyed) {
      s = connect(HOSTS[environment]);
      s.on("error", () => sessions.delete(environment));
      sessions.set(environment, s);
    }
    return s;
  };

  return {
    send(token, environment, message) {
      return new Promise<PushResult>((resolve) => {
        const headers: Record<string, string> = {
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${bearer()}`,
          "apns-topic": config.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          // Inutile après 24 h (une convocation déjà vue sur le site, etc.).
          "apns-expiration": String(Math.floor(now() / 1000) + 86_400),
        };
        if (message.collapseId) headers["apns-collapse-id"] = message.collapseId.slice(0, 64);
        let req;
        try {
          req = session(environment).request(headers);
        } catch (error) {
          resolve({ ok: false, status: 0, reason: error instanceof Error ? error.message : "connexion APNs impossible", permanent: false });
          return;
        }
        let status = 0;
        let body = "";
        req.setTimeout(15_000, () => req.close());
        req.on("response", (h) => (status = Number(h[":status"] ?? 0)));
        req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        req.on("error", (error) => resolve({ ok: false, status: 0, reason: error.message, permanent: false }));
        req.on("close", () => {
          if (status === 200) return resolve({ ok: true });
          let reason = "";
          try {
            reason = (JSON.parse(body) as { reason?: string }).reason ?? "";
          } catch {
            reason = body.slice(0, 80);
          }
          resolve({ ok: false, status, reason: reason || `HTTP ${status}`, permanent: isPermanentFailure(status, reason) });
        });
        req.end(apnsPayload(message));
      });
    },
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}
