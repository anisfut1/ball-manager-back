import type { DbClient } from "../../db/client.js";
import { badRequest, forbidden, unauthorized } from "../../api-error.js";
import { licencieFromToken } from "./personal-token.js";
import { looksLikeSessionSecret } from "../device-auth/secrets.js";
import { resolveDeviceSession, type ResolvedDeviceSession } from "../device-auth/service.js";
import { verifyAccessToken, type AuthUser } from "../../auth/jwt.js";
import { activeLicencieIds } from "../user-accounts/service.js";

/**
 * Identité de l'espace public — UN seul point d'entrée pour toutes les routes
 * `/v1/public/clubs/{slug}/…` (voir docs/MOBILE_AUTH.md et docs/ACCOUNTS.md) :
 *
 *  0. Compte (web et app iOS) : `Authorization: Bearer <JWT Supabase>`, et
 *     `X-BM-As: <licencieId>` parmi les licenciés que le compte suit (lien
 *     ACTIF). Sans `X-BM-As` : le premier licencié suivi.
 *  1. Session d'appareil (app iOS) : `Authorization: Bearer bmd_…`, et
 *     `X-BM-As: <licencieId>` pour choisir la personne active parmi celles
 *     de la session (parent avec plusieurs enfants). Sans `X-BM-As` : la
 *     première personne de la session.
 *  2. Lien personnel (web) : en-tête `X-Personal-Link-Token` UNIQUEMENT
 *     (jamais journalisé dans une URL). `?token=` n'est plus accepté.
 *
 * Mêmes règles de droits ensuite : la personne résolue est exactement celle
 * qu'aurait donnée son lien personnel.
 */
export const PERSONAL_LINK_HEADER = "x-personal-link-token";
export const ACT_AS_HEADER = "x-bm-as";

export interface RequestLike {
  header(name: string): string | undefined;
  query(name: string): string | undefined;
}

export interface PublicLicencieRow {
  id: string;
  first_name: string;
  last_name: string;
  team_id: string | null;
}

export function bearerSessionSecret(req: RequestLike): string | null {
  const auth = req.header("authorization");
  const match = auth ? /^Bearer\s+(\S+)$/i.exec(auth) : null;
  return match && looksLikeSessionSecret(match[1]) ? match[1]! : null;
}

/** JWT de compte (tout Bearer qui n'est pas un secret de session d'appareil). */
export function bearerAccountToken(req: RequestLike): string | null {
  const auth = req.header("authorization");
  const match = auth ? /^Bearer\s+(\S+)$/i.exec(auth) : null;
  return match && !looksLikeSessionSecret(match[1]!) ? match[1]! : null;
}

let accountVerifier: (token: string) => Promise<AuthUser> = verifyAccessToken;

/** Réservé aux tests : vérification du JWT simulée. */
export function setAccountVerifierForTests(verifier: ((token: string) => Promise<AuthUser>) | null): void {
  accountVerifier = verifier ?? verifyAccessToken;
}

/** Compte de la requête (`null` sans Bearer de compte), 401 si le jeton est invalide ou expiré. */
export async function accountFromRequest(req: RequestLike): Promise<AuthUser | null> {
  const token = bearerAccountToken(req);
  if (!token) return null;
  try {
    return await accountVerifier(token);
  } catch {
    throw unauthorized("Session expirée : reconnecte-toi.", "SESSION_EXPIRED");
  }
}

export function personalTokenFrom(req: RequestLike): string | null {
  // `?token=` n'est plus accepté : un jeton dans l'URL se retrouve dans les journaux, le Referer et l'historique.
  return req.header(PERSONAL_LINK_HEADER) || null;
}

/** Session d'appareil de la requête (`null` sans en-tête), 401 si présente mais invalide. */
export async function deviceSessionFromRequest(req: RequestLike, db: DbClient, clubId: string): Promise<ResolvedDeviceSession | null> {
  const secret = bearerSessionSecret(req);
  if (!secret) return null;
  const session = await resolveDeviceSession(db, clubId, secret);
  if (!session || session.grants.length === 0) throw unauthorized("Session expirée ou révoquée : reconnecte-toi.", "SESSION_INVALID");
  return session;
}

/**
 * Personnes que la requête peut désigner par `as:<licencieId>` (accueil et
 * planning de famille) : licenciés ACTIFS du compte, ou personnes de la
 * session d'appareil. `null` : ni compte ni session (web à liens personnels).
 */
export async function grantedLicencieIds(req: RequestLike, db: DbClient, clubId: string): Promise<Set<string> | null> {
  const account = await accountFromRequest(req);
  if (account) return new Set(await activeLicencieIds(db, clubId, account.id));
  const session = await deviceSessionFromRequest(req, db, clubId);
  return session ? new Set(session.grants.map((g) => g.licencieId)) : null;
}

/** Personne active de la requête (compte, session d'appareil ou lien personnel). */
export async function licencieFromRequest(req: RequestLike, db: DbClient, clubId: string): Promise<PublicLicencieRow> {
  const account = await accountFromRequest(req);
  if (account) {
    const ids = await activeLicencieIds(db, clubId, account.id);
    const wanted = req.header(ACT_AS_HEADER);
    const licencieId = wanted ? ids.find((id) => id === wanted) : ids[0];
    if (!licencieId) throw forbidden(ids.length === 0 ? "Ton compte ne suit encore aucun licencié de ce club." : "Ton compte ne suit pas cette personne.", ids.length === 0 ? "NO_LINKED_LICENCIE" : "NOT_LINKED");
    const { data } = await db.from("licencies").select("id, first_name, last_name, team_id").eq("id", licencieId).eq("club_id", clubId).maybeSingle();
    if (!data) throw forbidden("Ton compte ne suit pas cette personne.", "NOT_LINKED");
    return data as PublicLicencieRow;
  }
  const session = await deviceSessionFromRequest(req, db, clubId);
  if (session) {
    const wanted = req.header(ACT_AS_HEADER);
    const grant = wanted ? session.grants.find((g) => g.licencieId === wanted) : session.grants[0];
    if (!grant) throw forbidden("Cette personne n'est pas rattachée à cet appareil.", "NOT_IN_SESSION");
    const { data } = await db.from("licencies").select("id, first_name, last_name, team_id").eq("id", grant.licencieId).eq("club_id", clubId).maybeSingle();
    if (!data) throw unauthorized("Session expirée ou révoquée : reconnecte-toi.", "SESSION_INVALID");
    return data as PublicLicencieRow;
  }
  const token = personalTokenFrom(req);
  if (!token) throw badRequest("Lien personnel manquant.", "TOKEN_REQUIRED");
  return licencieFromToken(db, clubId, token);
}
