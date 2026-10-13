import type { DbClient } from "../../db/client.js";
import { badRequest, forbidden, unauthorized } from "../../api-error.js";
import { licencieFromToken } from "./personal-token.js";
import { looksLikeSessionSecret } from "../device-auth/secrets.js";
import { resolveDeviceSession, type ResolvedDeviceSession } from "../device-auth/service.js";

/**
 * Identité de l'espace public — UN seul point d'entrée pour toutes les routes
 * `/v1/public/clubs/{slug}/…` (voir docs/MOBILE_AUTH.md) :
 *
 *  1. Session d'appareil (app iOS) : `Authorization: Bearer bmd_…`, et
 *     `X-BM-As: <licencieId>` pour choisir la personne active parmi celles
 *     de la session (parent avec plusieurs enfants). Sans `X-BM-As` : la
 *     première personne de la session.
 *  2. Lien personnel (web, inchangé) : en-tête `X-Personal-Link-Token`
 *     (prioritaire, jamais journalisé dans une URL) ou `?token=`.
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

export function personalTokenFrom(req: RequestLike): string | null {
  return req.header(PERSONAL_LINK_HEADER) || req.query("token") || null;
}

/** Session d'appareil de la requête (`null` sans en-tête), 401 si présente mais invalide. */
export async function deviceSessionFromRequest(req: RequestLike, db: DbClient, clubId: string): Promise<ResolvedDeviceSession | null> {
  const secret = bearerSessionSecret(req);
  if (!secret) return null;
  const session = await resolveDeviceSession(db, clubId, secret);
  if (!session || session.grants.length === 0) throw unauthorized("Session expirée ou révoquée : reconnecte-toi.", "SESSION_INVALID");
  return session;
}

/** Personne active de la requête (session d'appareil ou lien personnel). */
export async function licencieFromRequest(req: RequestLike, db: DbClient, clubId: string): Promise<PublicLicencieRow> {
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
