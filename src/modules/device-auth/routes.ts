import { Hono, type Context } from "hono";
import type { DbClient } from "../../db/client.js";
import { badRequest, tooManyRequests, unauthorized } from "../../api-error.js";
import { resolvePublicClub, type PublicClub } from "../public/club-resolver.js";
import { deviceSessionFromRequest } from "../public/credential.js";
import { clientIp, hitRateLimit } from "../../security/rate-limit.js";
import { parse } from "../trainings/routes.js";
import { decryptPublicToken } from "../public-tables/personal-link.js";
import type { EncryptedPayload } from "../../security/crypto.js";
import { AddSessionPeopleDtoSchema, CreateAuthCodeDtoSchema, CreateDeviceSessionDtoSchema, ExchangeAuthCodeDtoSchema, PutPushTokenDtoSchema } from "../../contracts/device-auth.js";
import { registerPushToken, removePushToken } from "../push/service.js";
import {
  addGrants,
  consumeAuthCode,
  createAuthCode,
  createDeviceSession,
  proveTokens,
  provenFromTokenIds,
  removeGrant,
  revokeDeviceSession,
  SSO_CODE_TTL_MS,
  type ResolvedDeviceSession,
} from "./service.js";

/**
 * `/v1/public/clubs/{clubSlug}/auth/…` — authentification de l'app iOS.
 * Voir docs/MOBILE_AUTH.md. Aucune de ces routes ne renvoie un jeton
 * personnel à l'app : seulement un secret de session d'appareil.
 */
interface Env {
  Variables: { supabase: DbClient; publicClub: PublicClub };
}

export const deviceAuthRouter = new Hono<Env>();
deviceAuthRouter.use("*", resolvePublicClub<Env>());

const NO_STORE = { "Cache-Control": "no-store" };

function limit(c: Context<Env>, bucket: string, max: number): void {
  if (!hitRateLimit(`device-auth:${bucket}:${clientIp(c.req.header("x-forwarded-for"))}`, max, 60_000)) throw tooManyRequests("Trop de tentatives. Réessaie dans une minute.", "RATE_LIMITED");
}

async function peopleOf(db: DbClient, clubId: string, licencieIds: readonly string[]) {
  if (licencieIds.length === 0) return [];
  const { data } = await db.from("licencies").select("id, first_name, last_name, team_id").eq("club_id", clubId).in("id", [...licencieIds]);
  const byId = new Map(((data ?? []) as { id: string; first_name: string; last_name: string; team_id: string | null }[]).map((l) => [l.id, l]));
  return licencieIds.flatMap((id) => {
    const l = byId.get(id);
    return l ? [{ licencieId: l.id, firstName: l.first_name, lastName: l.last_name, teamId: l.team_id }] : [];
  });
}

async function requireSession(c: Context<Env>): Promise<ResolvedDeviceSession> {
  const session = await deviceSessionFromRequest(c.req, c.get("supabase"), c.get("publicClub").id);
  if (!session) throw unauthorized("Session d'appareil requise.", "SESSION_REQUIRED");
  return session;
}

/**
 * POST …/auth/device-sessions — amorçage depuis un lien personnel reçu par
 * l'app (Universal Link). POST explicite de l'app : un scanner d'email qui
 * précharge le lien n'exécute jamais cet échange.
 */
deviceAuthRouter.post("/device-sessions", async (c) => {
  limit(c, "create", 20);
  const body = await parse(CreateDeviceSessionDtoSchema, c);
  const db = c.get("supabase");
  const club = c.get("publicClub");
  const proven = await proveTokens(db, club.id, body.tokens);
  if (proven.length === 0) throw unauthorized("Lien personnel invalide ou révoqué.", "INVALID_PERSONAL_LINK");
  const session = await createDeviceSession(db, club.id, proven, { platform: "ios", appVersion: body.appVersion, deviceLabel: body.deviceLabel });
  return c.json({ sessionSecret: session.secret, expiresAt: session.expiresAt, people: await peopleOf(db, club.id, proven.map((p) => p.licencieId)), redirectPath: null }, 201, NO_STORE);
});

/** GET …/auth/session — personnes de la session (Bearer). */
deviceAuthRouter.get("/session", async (c) => {
  const session = await requireSession(c);
  return c.json({ platform: session.platform, people: await peopleOf(c.get("supabase"), session.clubId, session.grants.map((g) => g.licencieId)) }, 200, NO_STORE);
});

/** DELETE …/auth/session — déconnexion de cet appareil (la session et ses notifications cessent). */
deviceAuthRouter.delete("/session", async (c) => {
  const session = await requireSession(c);
  await revokeDeviceSession(c.get("supabase"), session.id);
  return c.body(null, 204);
});

/** POST …/auth/session/people — ajouter un enfant sur cet appareil (son lien personnel le prouve). */
deviceAuthRouter.post("/session/people", async (c) => {
  limit(c, "people", 20);
  const session = await requireSession(c);
  const body = await parse(AddSessionPeopleDtoSchema, c);
  const db = c.get("supabase");
  const proven = await proveTokens(db, session.clubId, body.tokens);
  if (proven.length === 0) throw unauthorized("Lien personnel invalide ou révoqué.", "INVALID_PERSONAL_LINK");
  await addGrants(db, session, proven);
  const ids = [...new Set([...session.grants.map((g) => g.licencieId), ...proven.map((p) => p.licencieId)])];
  return c.json({ platform: session.platform, people: await peopleOf(db, session.clubId, ids) }, 200, NO_STORE);
});

/** DELETE …/auth/session/people/{licencieId} — retirer une personne de cet appareil. */
deviceAuthRouter.delete("/session/people/:licencieId", async (c) => {
  const session = await requireSession(c);
  await removeGrant(c.get("supabase"), session, c.req.param("licencieId"));
  return c.body(null, 204);
});

/**
 * PUT …/auth/session/push-token — jeton APNs de cet iPhone, demandé APRÈS la
 * connexion et l'explication (jamais au lancement). Un jeton par session :
 * la déconnexion ou la réinitialisation du lien coupe aussi les notifications.
 */
deviceAuthRouter.put("/session/push-token", async (c) => {
  limit(c, "push", 20);
  const session = await requireSession(c);
  const body = await parse(PutPushTokenDtoSchema, c);
  await registerPushToken(c.get("supabase"), session, body);
  return c.body(null, 204);
});

/** DELETE …/auth/session/push-token — plus de notifications de ce club sur cet appareil. */
deviceAuthRouter.delete("/session/push-token", async (c) => {
  const session = await requireSession(c);
  await removePushToken(c.get("supabase"), session.id);
  return c.body(null, 204);
});

/**
 * POST …/auth/codes — appelé par la page web `/public/{slug}/auth/app`
 * (ouverte par ASWebAuthenticationSession), qui a déjà la session web :
 * émet un code court, à usage unique, lié au `code_challenge` PKCE de l'app.
 */
deviceAuthRouter.post("/codes", async (c) => {
  limit(c, "codes", 20);
  const body = await parse(CreateAuthCodeDtoSchema, c);
  const db = c.get("supabase");
  const club = c.get("publicClub");
  const proven = await proveTokens(db, club.id, body.tokens);
  if (proven.length === 0) throw unauthorized("Lien personnel invalide ou révoqué.", "INVALID_PERSONAL_LINK");
  const code = await createAuthCode(db, club.id, { purpose: "app_sso", tokenIds: proven.map((p) => p.tokenId), codeChallenge: body.codeChallenge, redirectPath: body.redirectPath, ttlMs: SSO_CODE_TTL_MS });
  return c.json(code, 201, NO_STORE);
});

/**
 * POST …/auth/token — échange d'un code (usage unique).
 *  - `platform: "ios"` : session d'appareil (connexion Safari avec PKCE, ou lien de connexion reçu par email) ;
 *  - `platform: "web"` : lien de connexion par email ouvert dans un navigateur → liens personnels
 *    pour la session web (`bm_session`), comme un lien `?token=` aujourd'hui.
 */
deviceAuthRouter.post("/token", async (c) => {
  limit(c, "token", 30);
  const body = await parse(ExchangeAuthCodeDtoSchema, c);
  const db = c.get("supabase");
  const club = c.get("publicClub");
  const consumed = await consumeAuthCode(db, club.id, body.code, { codeVerifier: body.codeVerifier });
  const proven = await provenFromTokenIds(db, club.id, consumed.tokenIds);
  if (proven.length === 0) throw unauthorized("Lien personnel invalide ou révoqué.", "INVALID_PERSONAL_LINK");

  if (body.platform === "web") {
    if (consumed.purpose !== "login_link") throw badRequest("Code invalide.", "INVALID_CODE");
    const { data } = await db.from("licencie_public_tokens").select("id, licencie_id, token_ciphertext").eq("club_id", club.id).in("id", proven.map((p) => p.tokenId));
    const tokens = ((data ?? []) as { licencie_id: string; token_ciphertext: unknown }[]).flatMap((row) => {
      try {
        return row.token_ciphertext ? [decryptPublicToken(row.token_ciphertext as EncryptedPayload, club.id, row.licencie_id)] : [];
      } catch {
        return [];
      }
    });
    if (tokens.length === 0) throw badRequest("Ce lien a expiré. Demande un nouveau lien.", "CODE_EXPIRED");
    return c.json({ tokens, redirectPath: consumed.redirectPath }, 200, NO_STORE);
  }

  const session = await createDeviceSession(db, club.id, proven, { platform: "ios", appVersion: body.appVersion, deviceLabel: body.deviceLabel });
  return c.json({ sessionSecret: session.secret, expiresAt: session.expiresAt, people: await peopleOf(db, club.id, proven.map((p) => p.licencieId)), redirectPath: consumed.redirectPath }, 201, NO_STORE);
});
