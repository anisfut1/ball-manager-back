import type { DbClient } from "../../db/client.js";
import { forbidden, unauthorized } from "../../api-error.js";

/**
 * Administration du club dans l'app (demande du club, 2026-10-22 : « que
 * le truc soit accessible qu'aux admins ») : connexion avec le COMPTE du
 * site, faite ici côté serveur (aucune clé Supabase dans l'app). Seul un
 * compte `club_admin` actif DE CE CLUB obtient une session ; le badge
 * « Admin » d'un licencié (`public_admin`) ne suffit pas. Les routes
 * `/v1/clubs/{clubId}/…` revérifient ensuite le rôle à chaque appel.
 */
export interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user: { id: string; email?: string | null };
}

/** Sous-ensemble de `supabase.auth` utilisé (injectable pour les tests). */
export interface PasswordAuth {
  signInWithPassword(credentials: { email: string; password: string }): Promise<{ data: { session: AuthSession | null }; error: unknown }>;
  refreshSession(input: { refresh_token: string }): Promise<{ data: { session: AuthSession | null }; error: unknown }>;
}

export interface AdminSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  clubId: string;
  email: string | null;
}

export async function isAccountClubAdmin(db: DbClient, clubId: string, userId: string): Promise<boolean> {
  const { data: memberships } = await db.from("club_memberships").select("id").eq("club_id", clubId).eq("user_id", userId).eq("status", "active");
  const ids = (memberships ?? []).map((m) => m.id as string);
  if (ids.length === 0) return false;
  const { data: roles } = await db.from("membership_roles").select("membership_id").in("membership_id", ids).eq("role", "club_admin");
  return (roles ?? []).length > 0;
}

async function toAdminSession(db: DbClient, clubId: string, session: AuthSession | null): Promise<AdminSession> {
  if (!session) throw unauthorized("Email ou mot de passe incorrect.", "ADMIN_LOGIN_FAILED");
  if (!(await isAccountClubAdmin(db, clubId, session.user.id))) {
    throw forbidden("Ce compte n'est pas administrateur de ce club.", "ADMIN_ROLE_REQUIRED");
  }
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: new Date((session.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString(),
    clubId,
    email: session.user.email ?? null,
  };
}

export async function createAdminSession(db: DbClient, auth: PasswordAuth, clubId: string, email: string, password: string): Promise<AdminSession> {
  const { data, error } = await auth.signInWithPassword({ email, password });
  return toAdminSession(db, clubId, error ? null : data.session);
}

/** Rafraîchissement : le rôle est revérifié (un admin retiré perd l'accès). */
export async function refreshAdminSession(db: DbClient, auth: PasswordAuth, clubId: string, refreshToken: string): Promise<AdminSession> {
  const { data, error } = await auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) throw unauthorized("Session d'administration expirée. Reconnecte-toi.", "ADMIN_SESSION_EXPIRED");
  return toAdminSession(db, clubId, data.session);
}
