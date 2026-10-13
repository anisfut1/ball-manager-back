import type { DbClient } from "../../db/client.js";
import { badRequest, unauthorized } from "../../api-error.js";
import { hashPublicToken } from "../public-tables/token.js";
import { generateAuthCode, generateSessionSecret, isValidCodeChallenge, sha256Hex, verifyPkce } from "./secrets.js";

/**
 * Sessions d'APPAREIL (app iOS ; plus tard le web) et codes d'autorisation.
 * Voir docs/MOBILE_AUTH.md.
 *
 * L'identité reste le licencié du lien personnel : une session ne fait
 * qu'ADOSSER des droits (`device_session_grants`) aux jetons personnels qui
 * les ont prouvés. Jeton révoqué (réinitialisation admin) ⇒ droit perdu à la
 * requête suivante. Le secret de session n'est jamais stocké en clair.
 */

/** 180 jours GLISSANTS : une famille qui ouvre l'app de temps en temps reste connectée ; un téléphone abandonné finit par expirer. */
export const DEVICE_SESSION_TTL_MS = 180 * 86_400_000;
/** Renouvellement du glissement au plus une fois par heure (évite une écriture par requête). */
export const DEVICE_SESSION_TOUCH_MS = 3_600_000;
/** Code de la connexion depuis Safari (ASWebAuthenticationSession) : quelques minutes suffisent. */
export const SSO_CODE_TTL_MS = 5 * 60_000;
/** Lien de connexion par email (AUTH_LINK_CODES=1) : court, mais laisse le temps de lire l'email. */
export const LOGIN_LINK_CODE_TTL_MS = 48 * 3_600_000;
/** Personnes par session (parent avec plusieurs enfants) — même plafond que le web. */
export const MAX_GRANTS = 8;

export type DevicePlatform = "ios" | "web";

export interface ProvenToken {
  tokenId: string;
  licencieId: string;
}

export interface DeviceSessionGrant {
  licencieId: string;
  tokenId: string;
}

export interface ResolvedDeviceSession {
  id: string;
  clubId: string;
  platform: DevicePlatform;
  grants: DeviceSessionGrant[];
}

interface TokenRow {
  id: string;
  licencie_id: string;
  revoked_at: string | null;
}

/** Jetons personnels VALIDES de ce club (les autres sont ignorés, jamais une erreur qui aiderait à deviner). */
export async function proveTokens(db: DbClient, clubId: string, tokens: readonly string[]): Promise<ProvenToken[]> {
  const hashes = [...new Set(tokens.filter((t) => typeof t === "string" && t.length >= 8 && t.length <= 512))].slice(0, MAX_GRANTS).map(hashPublicToken);
  if (hashes.length === 0) return [];
  const { data } = await db.from("licencie_public_tokens").select("id, licencie_id, revoked_at").eq("club_id", clubId).in("token_hash", hashes).is("revoked_at", null);
  const rows = (data ?? []) as TokenRow[];
  const licencieIds = [...new Set(rows.map((r) => r.licencie_id))];
  if (licencieIds.length === 0) return [];
  const { data: active } = await db.from("licencies").select("id").eq("club_id", clubId).in("id", licencieIds);
  const known = new Set(((active ?? []) as { id: string }[]).map((l) => l.id));
  return rows.filter((r) => known.has(r.licencie_id)).map((r) => ({ tokenId: r.id, licencieId: r.licencie_id }));
}

/** Jetons encore actifs parmi ces identifiants (code d'autorisation consommé plus tard). */
export async function provenFromTokenIds(db: DbClient, clubId: string, tokenIds: readonly string[]): Promise<ProvenToken[]> {
  if (tokenIds.length === 0) return [];
  const { data } = await db.from("licencie_public_tokens").select("id, licencie_id, revoked_at").eq("club_id", clubId).in("id", [...tokenIds]).is("revoked_at", null);
  return ((data ?? []) as TokenRow[]).map((r) => ({ tokenId: r.id, licencieId: r.licencie_id }));
}

export async function createDeviceSession(
  db: DbClient,
  clubId: string,
  proven: readonly ProvenToken[],
  meta: { platform: DevicePlatform; appVersion?: string | null; deviceLabel?: string | null },
  now: Date = new Date(),
): Promise<{ secret: string; sessionId: string; expiresAt: string }> {
  if (proven.length === 0) throw unauthorized("Lien personnel invalide ou révoqué.", "INVALID_PERSONAL_LINK");
  const secret = generateSessionSecret();
  const expiresAt = new Date(now.getTime() + DEVICE_SESSION_TTL_MS).toISOString();
  const { data, error } = await db
    .from("device_sessions")
    .insert({
      club_id: clubId,
      secret_hash: sha256Hex(secret),
      platform: meta.platform,
      app_version: meta.appVersion?.slice(0, 32) ?? null,
      device_label: meta.deviceLabel?.slice(0, 64) ?? null,
      last_used_at: now.toISOString(),
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Création de la session d'appareil échouée : ${error?.message ?? "sans résultat"}`);
  await insertGrants(db, data.id as string, clubId, proven);
  return { secret, sessionId: data.id as string, expiresAt };
}

async function insertGrants(db: DbClient, sessionId: string, clubId: string, proven: readonly ProvenToken[]): Promise<void> {
  const byLicencie = new Map<string, ProvenToken>();
  for (const p of proven) byLicencie.set(p.licencieId, p);
  const rows = [...byLicencie.values()].slice(0, MAX_GRANTS).map((p) => ({ session_id: sessionId, club_id: clubId, licencie_id: p.licencieId, token_id: p.tokenId }));
  if (rows.length) await db.from("device_session_grants").upsert(rows, { onConflict: "session_id,licencie_id" });
}

/**
 * Session valide pour CE club, non révoquée, non expirée, avec ses droits
 * encore adossés à un lien personnel actif. `null` sinon (l'appelant répond
 * 401, jamais une distinction plus fine).
 */
export async function resolveDeviceSession(db: DbClient, clubId: string, secret: string, now: Date = new Date()): Promise<ResolvedDeviceSession | null> {
  const { data: session } = await db.from("device_sessions").select("id, club_id, platform, last_used_at, expires_at, revoked_at").eq("secret_hash", sha256Hex(secret)).maybeSingle();
  if (!session || session.club_id !== clubId || session.revoked_at) return null;
  if (new Date(session.expires_at as string).getTime() <= now.getTime()) return null;

  const { data: grantRows } = await db.from("device_session_grants").select("licencie_id, token_id").eq("session_id", session.id);
  const grants = ((grantRows ?? []) as { licencie_id: string; token_id: string }[]).map((g) => ({ licencieId: g.licencie_id, tokenId: g.token_id }));
  const live = grants.length ? await provenFromTokenIds(db, clubId, grants.map((g) => g.tokenId)) : [];
  const liveTokens = new Set(live.map((l) => l.tokenId));

  if (now.getTime() - new Date(session.last_used_at as string).getTime() >= DEVICE_SESSION_TOUCH_MS) {
    await db
      .from("device_sessions")
      .update({ last_used_at: now.toISOString(), expires_at: new Date(now.getTime() + DEVICE_SESSION_TTL_MS).toISOString() })
      .eq("id", session.id);
  }
  return { id: session.id as string, clubId, platform: session.platform as DevicePlatform, grants: grants.filter((g) => liveTokens.has(g.tokenId)) };
}

export async function addGrants(db: DbClient, session: ResolvedDeviceSession, proven: readonly ProvenToken[]): Promise<void> {
  const room = MAX_GRANTS - session.grants.filter((g) => !proven.some((p) => p.licencieId === g.licencieId)).length;
  await insertGrants(db, session.id, session.clubId, proven.slice(0, Math.max(0, room)));
}

export async function removeGrant(db: DbClient, session: ResolvedDeviceSession, licencieId: string): Promise<void> {
  await db.from("device_session_grants").delete().eq("session_id", session.id).eq("licencie_id", licencieId);
}

/** Déconnexion : la session et son jeton push ne servent plus. */
export async function revokeDeviceSession(db: DbClient, sessionId: string, now: Date = new Date()): Promise<void> {
  await db.from("device_sessions").update({ revoked_at: now.toISOString() }).eq("id", sessionId);
  await db.from("device_push_tokens").update({ revoked_at: now.toISOString(), revoked_reason: "logout" }).eq("session_id", sessionId).is("revoked_at", null);
}

/**
 * « Lien perdu ? » renvoyé à la MÊME adresse : le nouveau jeton reprend les
 * droits des sessions d'appareil (la famille reste connectée dans l'app).
 * Jamais appelé pour une réinitialisation admin ni pour une autre adresse.
 */
export async function moveGrantsToToken(db: DbClient, fromTokenId: string, toTokenId: string): Promise<void> {
  await db.from("device_session_grants").update({ token_id: toTokenId }).eq("token_id", fromTokenId);
}

export type AuthCodePurpose = "app_sso" | "login_link";

export async function createAuthCode(
  db: DbClient,
  clubId: string,
  input: { purpose: AuthCodePurpose; tokenIds: readonly string[]; codeChallenge?: string | null; redirectPath?: string | null; ttlMs: number },
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  if (input.tokenIds.length === 0) throw unauthorized("Lien personnel invalide ou révoqué.", "INVALID_PERSONAL_LINK");
  if (input.purpose === "app_sso" && !isValidCodeChallenge(input.codeChallenge)) throw badRequest("code_challenge (S256) requis.", "PKCE_REQUIRED");
  const code = generateAuthCode();
  const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
  const { error } = await db.from("auth_codes").insert({
    club_id: clubId,
    code_hash: sha256Hex(code),
    purpose: input.purpose,
    token_ids: [...input.tokenIds],
    code_challenge: input.codeChallenge ?? null,
    redirect_path: sanitizeRedirectPath(input.redirectPath),
    expires_at: expiresAt,
  });
  if (error) throw new Error(`Création du code d'autorisation échouée : ${error.message}`);
  return { code, expiresAt };
}

/**
 * Consomme un code : existe pour ce club, non expiré, jamais utilisé, PKCE
 * vérifié s'il a été émis avec un challenge (obligatoire pour `app_sso`).
 * L'usage unique est garanti par une mise à jour conditionnelle
 * (`used_at is null`) : deux échanges simultanés ne passent jamais tous les deux.
 */
export async function consumeAuthCode(
  db: DbClient,
  clubId: string,
  code: string,
  opts: { codeVerifier?: string | null; expectedPurpose?: AuthCodePurpose } = {},
  now: Date = new Date(),
): Promise<{ tokenIds: string[]; purpose: AuthCodePurpose; redirectPath: string | null }> {
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(code)) throw badRequest("Code invalide.", "INVALID_CODE");
  const { data: row } = await db.from("auth_codes").select("id, club_id, purpose, token_ids, code_challenge, redirect_path, expires_at, used_at").eq("code_hash", sha256Hex(code)).maybeSingle();
  if (!row || row.club_id !== clubId) throw badRequest("Code invalide.", "INVALID_CODE");
  if (opts.expectedPurpose && row.purpose !== opts.expectedPurpose) throw badRequest("Code invalide.", "INVALID_CODE");
  if (row.used_at) throw badRequest("Ce lien a déjà été utilisé. Demande un nouveau lien.", "CODE_USED");
  if (new Date(row.expires_at as string).getTime() <= now.getTime()) throw badRequest("Ce lien a expiré. Demande un nouveau lien.", "CODE_EXPIRED");
  if (row.purpose === "app_sso" || row.code_challenge) {
    if (!row.code_challenge || !opts.codeVerifier || !verifyPkce(opts.codeVerifier, row.code_challenge as string)) throw badRequest("Vérification PKCE échouée.", "PKCE_FAILED");
  }
  const { data: claimed } = await db.from("auth_codes").update({ used_at: now.toISOString() }).eq("id", row.id).is("used_at", null).select("id").maybeSingle();
  if (!claimed) throw badRequest("Ce lien a déjà été utilisé. Demande un nouveau lien.", "CODE_USED");
  return { tokenIds: (row.token_ids ?? []) as string[], purpose: row.purpose as AuthCodePurpose, redirectPath: (row.redirect_path as string | null) ?? null };
}

/** Destination après connexion : un chemin interne de l'espace public seulement (jamais une URL externe, jamais `//hôte`). */
export function sanitizeRedirectPath(path: string | null | undefined): string | null {
  if (typeof path !== "string" || path.length > 300) return null;
  if (!/^\/public\/[a-z0-9][a-z0-9-]{0,63}(\/[A-Za-z0-9\-._~%/]*)?(\?[A-Za-z0-9\-._~%&=]*)?$/.test(path)) return null;
  if (path.includes("//") || path.includes("..")) return null;
  return path;
}
