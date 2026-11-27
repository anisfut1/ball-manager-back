import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { DbClient } from "../../db/client.js";
import type { AuthUser } from "../../auth/jwt.js";
import { badRequest, forbidden, notFound } from "../../api-error.js";
import { isPersonalLinkExpired } from "../public-tables/token.js";
import { licencieFromToken } from "../public/personal-token.js";
import { resolveDeviceSession } from "../device-auth/service.js";
import { isAccountClubAdmin } from "../device-auth/admin-session.js";

/**
 * Comptes utilisateurs de l'espace licencié (docs/ACCOUNTS.md).
 *
 * Un compte suit un ou plusieurs licenciés via `account_licencie_links`. Un
 * lien devient ACTIF seulement s'il est prouvé : adresse VÉRIFIÉE déjà
 * connue sur la fiche, lien personnel, session d'appareil, invitation d'un
 * proche déjà lié, ou décision d'un admin du club. Sinon il reste EN ATTENTE.
 */

export type LinkStatus = "active" | "pending" | "refused";
export type LinkSource = "email_match" | "personal_link" | "device_session" | "invite" | "admin" | "request";

/** Licenciés suivis par un compte, au plus (parent d'une grande fratrie compris). */
export const MAX_LINKS_PER_ACCOUNT = 8;
/** Invitation d'un proche : 7 jours, usage unique. */
export const INVITE_TTL_MS = 7 * 86_400_000;

export interface AccountPerson {
  licencieId: string;
  firstName: string;
  lastName: string;
  teamId: string | null;
  status: LinkStatus;
}

interface LinkRow {
  id: string;
  licencie_id: string;
  status: LinkStatus;
}

/** Licenciés ACTIFS d'un compte dans ce club (ordre de rattachement). */
export async function activeLicencieIds(db: DbClient, clubId: string, userId: string): Promise<string[]> {
  const { data } = await db.from("account_licencie_links").select("licencie_id, created_at").eq("club_id", clubId).eq("user_id", userId).eq("status", "active").order("created_at", { ascending: true });
  return ((data ?? []) as { licencie_id: string }[]).map((r) => r.licencie_id);
}

/** Tous les liens du compte dans ce club (actifs et en attente ; les refus ne sont pas montrés). */
export async function accountPeople(db: DbClient, clubId: string, userId: string): Promise<AccountPerson[]> {
  const { data } = await db.from("account_licencie_links").select("id, licencie_id, status, created_at").eq("club_id", clubId).eq("user_id", userId).in("status", ["active", "pending"]).order("created_at", { ascending: true });
  const links = (data ?? []) as LinkRow[];
  if (links.length === 0) return [];
  const { data: rows } = await db.from("licencies").select("id, first_name, last_name, team_id").eq("club_id", clubId).in("id", links.map((l) => l.licencie_id));
  const byId = new Map(((rows ?? []) as { id: string; first_name: string; last_name: string; team_id: string | null }[]).map((l) => [l.id, l]));
  return links.flatMap((link) => {
    const l = byId.get(link.licencie_id);
    return l ? [{ licencieId: l.id, firstName: l.first_name, lastName: l.last_name, teamId: l.team_id, status: link.status }] : [];
  });
}

/** Adresses déjà connues pour ce licencié : la fiche (FBI) et ses liens personnels actifs. */
export async function knownEmails(db: DbClient, clubId: string, licencieId: string, now: Date = new Date()): Promise<Set<string>> {
  const emails = new Set<string>();
  const { data: licencie } = await db.from("licencies").select("email").eq("club_id", clubId).eq("id", licencieId).maybeSingle();
  const ficheEmail = (licencie as { email: string | null } | null)?.email;
  if (ficheEmail) emails.add(ficheEmail.trim().toLowerCase());
  const { data: tokens } = await db.from("licencie_public_tokens").select("email, expires_at").eq("club_id", clubId).eq("licencie_id", licencieId).is("revoked_at", null);
  for (const t of (tokens ?? []) as { email: string | null; expires_at: string | null }[]) {
    if (t.email && !isPersonalLinkExpired(t.expires_at, now)) emails.add(t.email.trim().toLowerCase());
  }
  return emails;
}

async function upsertLink(db: DbClient, input: { clubId: string; userId: string; licencieId: string; status: LinkStatus; source: LinkSource; decidedBy?: string | null }, now: Date): Promise<LinkStatus> {
  const { data: existing } = await db.from("account_licencie_links").select("id, status").eq("user_id", input.userId).eq("licencie_id", input.licencieId).maybeSingle();
  const current = existing as { id: string; status: LinkStatus } | null;
  // Un lien actif ne redescend jamais en attente par une nouvelle demande.
  if (current?.status === "active") return "active";
  const decided = input.status === "active" ? { decided_at: now.toISOString(), decided_by: input.decidedBy ?? null } : { decided_at: null, decided_by: null };
  if (current) {
    await db.from("account_licencie_links").update({ status: input.status, source: input.source, ...decided }).eq("id", current.id);
  } else {
    const { error } = await db.from("account_licencie_links").insert({ club_id: input.clubId, user_id: input.userId, licencie_id: input.licencieId, status: input.status, source: input.source, ...decided });
    if (error) throw new Error(`Rattachement du compte échoué : ${error.message}`);
  }
  return input.status;
}

async function assertRoomForLink(db: DbClient, userId: string, licencieId: string): Promise<void> {
  const { data } = await db.from("account_licencie_links").select("licencie_id").eq("user_id", userId).in("status", ["active", "pending"]);
  const ids = new Set(((data ?? []) as { licencie_id: string }[]).map((r) => r.licencie_id));
  if (!ids.has(licencieId) && ids.size >= MAX_LINKS_PER_ACCOUNT) throw badRequest(`Un compte suit au plus ${MAX_LINKS_PER_ACCOUNT} licenciés.`, "TOO_MANY_LINKS");
}

async function assertLicencieInClub(db: DbClient, clubId: string, licencieId: string): Promise<void> {
  const { data } = await db.from("licencies").select("id").eq("club_id", clubId).eq("id", licencieId).maybeSingle();
  if (!data) throw notFound("Licencié introuvable.");
}

/**
 * « C'est moi / c'est mon enfant » après la recherche du nom. Actif tout de
 * suite si une preuve est fournie (lien personnel) ou si l'adresse VÉRIFIÉE du
 * compte est déjà connue sur la fiche ; sinon en attente d'un admin du club.
 */
export async function requestLink(
  db: DbClient,
  clubId: string,
  user: AuthUser,
  input: { licencieId: string; personalLinkToken?: string | null },
  now: Date = new Date(),
): Promise<LinkStatus> {
  await assertLicencieInClub(db, clubId, input.licencieId);
  await assertRoomForLink(db, user.id, input.licencieId);

  if (input.personalLinkToken) {
    const proven = await licencieFromToken(db, clubId, input.personalLinkToken);
    if (proven.id !== input.licencieId) throw forbidden("Ce lien personnel est celui d'une autre personne.", "TOKEN_MISMATCH");
    return upsertLink(db, { clubId, userId: user.id, licencieId: input.licencieId, status: "active", source: "personal_link" }, now);
  }

  const email = user.email?.trim().toLowerCase();
  if (email && user.emailConfirmed && (await knownEmails(db, clubId, input.licencieId, now)).has(email)) {
    return upsertLink(db, { clubId, userId: user.id, licencieId: input.licencieId, status: "active", source: "email_match" }, now);
  }
  return upsertLink(db, { clubId, userId: user.id, licencieId: input.licencieId, status: "pending", source: "request" }, now);
}

/** Reprise d'une session d'appareil existante (app iOS d'avant les comptes) : toutes ses personnes deviennent actives sur le compte. */
export async function linkFromDeviceSession(db: DbClient, clubId: string, user: AuthUser, sessionSecret: string, now: Date = new Date()): Promise<string[]> {
  const session = await resolveDeviceSession(db, clubId, sessionSecret);
  if (!session || session.grants.length === 0) throw forbidden("Session d'appareil expirée ou révoquée.", "SESSION_INVALID");
  const ids = [...new Set(session.grants.map((g) => g.licencieId))];
  for (const licencieId of ids) {
    await assertRoomForLink(db, user.id, licencieId);
    await upsertLink(db, { clubId, userId: user.id, licencieId, status: "active", source: "device_session" }, now);
  }
  return ids;
}

export async function removeLink(db: DbClient, clubId: string, userId: string, licencieId: string): Promise<void> {
  await db.from("account_licencie_links").delete().eq("club_id", clubId).eq("user_id", userId).eq("licencie_id", licencieId);
}

// ─── Invitations d'un proche ────────────────────────────────────────────────

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Lien à partager (Messages, WhatsApp…) : seul un compte ACTIF sur ce licencié peut inviter. */
export async function createInvite(db: DbClient, clubId: string, userId: string, licencieId: string, now: Date = new Date()): Promise<{ code: string; expiresAt: string }> {
  const active = await activeLicencieIds(db, clubId, userId);
  if (!active.includes(licencieId)) throw forbidden("Tu ne suis pas ce licencié.", "NOT_LINKED");
  const code = randomBytes(18).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const { error } = await db.from("account_invites").insert({ club_id: clubId, licencie_id: licencieId, invited_by: userId, code_hash: hashCode(code), expires_at: expiresAt });
  if (error) throw new Error(`Création de l'invitation échouée : ${error.message}`);
  return { code, expiresAt };
}

export async function acceptInvite(db: DbClient, clubId: string, user: AuthUser, code: string, now: Date = new Date()): Promise<string> {
  const invalid = () => badRequest("Invitation invalide, déjà utilisée ou expirée. Demande-en une nouvelle.", "INVITE_INVALID");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) throw invalid();
  const { data } = await db.from("account_invites").select("id, licencie_id, expires_at, accepted_at").eq("club_id", clubId).eq("code_hash", hashCode(code)).maybeSingle();
  const invite = data as { id: string; licencie_id: string; expires_at: string; accepted_at: string | null } | null;
  if (!invite || invite.accepted_at || new Date(invite.expires_at).getTime() <= now.getTime()) throw invalid();
  await assertRoomForLink(db, user.id, invite.licencie_id);
  // Usage unique : la mise à jour ne passe que si personne ne l'a acceptée entre-temps.
  const { data: claimed } = await db.from("account_invites").update({ accepted_at: now.toISOString(), accepted_by: user.id }).eq("id", invite.id).is("accepted_at", null).select("id");
  if (!claimed || claimed.length === 0) throw invalid();
  await upsertLink(db, { clubId, userId: user.id, licencieId: invite.licencie_id, status: "active", source: "invite" }, now);
  return invite.licencie_id;
}

// ─── Administration du club ─────────────────────────────────────────────────

export interface AdminLinkRow {
  id: string;
  licencieId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  status: LinkStatus;
  source: LinkSource;
  createdAt: string;
}

export async function listClubLinks(db: DbClient, clubId: string, filter: { status?: LinkStatus; licencieId?: string }): Promise<AdminLinkRow[]> {
  let query = db.from("account_licencie_links").select("id, user_id, licencie_id, status, source, created_at").eq("club_id", clubId).order("created_at", { ascending: false }).limit(500);
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.licencieId) query = query.eq("licencie_id", filter.licencieId);
  const { data } = await query;
  const rows = (data ?? []) as { id: string; user_id: string; licencie_id: string; status: LinkStatus; source: LinkSource; created_at: string }[];
  if (rows.length === 0) return [];
  const { data: licencies } = await db.from("licencies").select("id, first_name, last_name").eq("club_id", clubId).in("id", [...new Set(rows.map((r) => r.licencie_id))]);
  const byId = new Map(((licencies ?? []) as { id: string; first_name: string; last_name: string }[]).map((l) => [l.id, l]));
  const emails = new Map<string, string | null>();
  await Promise.all(
    [...new Set(rows.map((r) => r.user_id))].map(async (id) => {
      const { data: user } = await db.auth.admin.getUserById(id);
      emails.set(id, user?.user?.email ?? null);
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    licencieId: r.licencie_id,
    firstName: byId.get(r.licencie_id)?.first_name ?? "",
    lastName: byId.get(r.licencie_id)?.last_name ?? "",
    email: emails.get(r.user_id) ?? null,
    status: r.status,
    source: r.source,
    createdAt: r.created_at,
  }));
}

export async function decideLink(db: DbClient, clubId: string, linkId: string, decision: "active" | "refused", adminId: string, now: Date = new Date()): Promise<void> {
  const { data } = await db.from("account_licencie_links").update({ status: decision, decided_at: now.toISOString(), decided_by: adminId }).eq("club_id", clubId).eq("id", linkId).select("id");
  if (!data || data.length === 0) throw notFound("Demande introuvable.");
}

export async function deleteClubLink(db: DbClient, clubId: string, linkId: string): Promise<void> {
  const { data } = await db.from("account_licencie_links").delete().eq("club_id", clubId).eq("id", linkId).select("id");
  if (!data || data.length === 0) throw notFound("Lien introuvable.");
}

// ─── Suppression du compte ──────────────────────────────────────────────────

/**
 * Suppression du COMPTE (guideline Apple 5.1.1(v)) : l'utilisateur Auth, et
 * en cascade ses liens, invitations acceptées et jetons push. Les fiches
 * sportives restent au club. Un administrateur de club passe par la
 * plateforme (le club ne doit pas se retrouver sans admin par erreur).
 */
export async function deleteAccount(db: DbClient, clubId: string, userId: string): Promise<void> {
  if (await isAccountClubAdmin(db, clubId, userId)) throw forbidden("Compte administrateur du club : demande sa suppression à la plateforme.", "ADMIN_ACCOUNT");
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) throw new Error(`Suppression du compte échouée : ${error.message}`);
}

// ─── Codes de vérification (création de compte) ─────────────────────────────

export const SIGNUP_CODE_TTL_MS = 30 * 60_000;
export const SIGNUP_CODE_MAX_ATTEMPTS = 5;

export function generateSignupCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashSignupCode(userId: string, code: string): string {
  return createHash("sha256").update(`${userId}:${code}`).digest("hex");
}

export function signupCodeMatches(userId: string, code: string, expectedHash: string): boolean {
  const a = Buffer.from(hashSignupCode(userId, code), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
