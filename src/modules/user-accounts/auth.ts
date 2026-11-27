import type { User } from "@supabase/supabase-js";
import type { DbClient } from "../../db/client.js";
import { badRequest, forbidden, unauthorized } from "../../api-error.js";
import { appBaseUrl, findUserByEmail } from "../../auth/account-invites.js";
import { sendEmail } from "../../email/resend.js";
import { buildAlreadyRegisteredEmail, buildSignupCodeEmail } from "../../email/account-emails.js";
import { PLATFORM_NAME } from "../../email/layout.js";
import type { AuthSession, PasswordAuth } from "../device-auth/admin-session.js";
import { generateSignupCode, hashSignupCode, SIGNUP_CODE_MAX_ATTEMPTS, SIGNUP_CODE_TTL_MS, signupCodeMatches } from "./service.js";

/**
 * Création de compte et connexion par email + mot de passe, faites côté
 * serveur pour le web et l'app iOS (aucune clé Supabase dans l'app).
 *
 * L'adresse est vérifiée par un code à 6 chiffres envoyé par NOTRE email
 * (Resend, en français) : jamais l'email Supabase par défaut. Le code n'est
 * stocké que haché, dans `app_metadata` (non modifiable par l'utilisateur).
 * Les réponses de création sont identiques que l'adresse soit inscrite ou
 * non : jamais un moyen de savoir qui a un compte.
 *
 * Aucun mot de passe, code ni jeton n'est jamais journalisé.
 */

export const MIN_PASSWORD_LENGTH = 8;

export interface AccountSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  user: { id: string; email: string | null };
}

interface CodeMetadata {
  signup_code_hash?: string | null;
  signup_code_expires_at?: string | null;
  signup_code_attempts?: number | null;
}

function toAccountSession(session: AuthSession): AccountSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: new Date((session.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString(),
    user: { id: session.user.id, email: session.user.email ?? null },
  };
}

async function sendNewCode(db: DbClient, user: User, now: Date): Promise<void> {
  const code = generateSignupCode();
  const metadata: CodeMetadata = {
    signup_code_hash: hashSignupCode(user.id, code),
    signup_code_expires_at: new Date(now.getTime() + SIGNUP_CODE_TTL_MS).toISOString(),
    signup_code_attempts: 0,
  };
  const { error } = await db.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, ...metadata } });
  if (error) throw new Error(`Enregistrement du code échoué : ${error.message}`);
  const message = buildSignupCodeEmail({ code, link: appBaseUrl() });
  await sendEmail({ to: user.email!, fromName: PLATFORM_NAME, ...message });
}

/**
 * Création de compte (ou reprise d'une création jamais terminée) : envoie un
 * code. Adresse déjà inscrite et vérifiée : email « tu as déjà un compte » à
 * cette adresse, et la même réponse à l'appelant.
 */
export async function startSignUp(db: DbClient, email: string, password: string, now: Date = new Date()): Promise<void> {
  if (password.length < MIN_PASSWORD_LENGTH) throw badRequest(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`, "WEAK_PASSWORD");
  const address = email.trim().toLowerCase();
  const existing = await findUserByEmail(db, address);

  if (existing?.email_confirmed_at) {
    const message = buildAlreadyRegisteredEmail({ link: appBaseUrl() });
    await sendEmail({ to: address, fromName: PLATFORM_NAME, ...message });
    return;
  }

  if (existing) {
    // Création jamais terminée : personne n'a prouvé posséder l'adresse, on reprend avec le nouveau mot de passe.
    const { data, error } = await db.auth.admin.updateUserById(existing.id, { password });
    if (error || !data.user) throw mapPasswordError(error);
    await sendNewCode(db, data.user, now);
    return;
  }

  const { data, error } = await db.auth.admin.createUser({ email: address, password, email_confirm: false });
  if (error || !data.user) throw mapPasswordError(error);
  await sendNewCode(db, data.user, now);
}

function mapPasswordError(error: { message?: string } | null): Error {
  const message = error?.message ?? "";
  if (/password/i.test(message)) return badRequest("Mot de passe refusé : choisis-en un plus long ou moins courant.", "WEAK_PASSWORD");
  return new Error(`Création du compte échouée : ${message || "réponse incomplète"}`);
}

/** Renvoi du code (même réponse dans tous les cas). */
export async function resendSignUpCode(db: DbClient, email: string, now: Date = new Date()): Promise<void> {
  const existing = await findUserByEmail(db, email.trim().toLowerCase());
  if (existing && !existing.email_confirmed_at) await sendNewCode(db, existing, now);
}

/** Vérifie le code, confirme l'adresse, puis ouvre la session avec le mot de passe choisi. */
export async function verifySignUp(db: DbClient, auth: PasswordAuth, input: { email: string; code: string; password: string }, now: Date = new Date()): Promise<AccountSession> {
  const invalid = () => badRequest("Code incorrect ou expiré. Demande un nouveau code.", "INVALID_CODE");
  const address = input.email.trim().toLowerCase();
  const user = await findUserByEmail(db, address);
  if (!user) throw invalid();

  if (!user.email_confirmed_at) {
    const meta = (user.app_metadata ?? {}) as CodeMetadata;
    const attempts = meta.signup_code_attempts ?? 0;
    const expired = !meta.signup_code_expires_at || new Date(meta.signup_code_expires_at).getTime() <= now.getTime();
    if (!meta.signup_code_hash || expired || attempts >= SIGNUP_CODE_MAX_ATTEMPTS) throw invalid();
    if (!/^\d{6}$/.test(input.code) || !signupCodeMatches(user.id, input.code, meta.signup_code_hash)) {
      await db.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, signup_code_attempts: attempts + 1 } });
      throw invalid();
    }
    const cleared: CodeMetadata = { signup_code_hash: null, signup_code_expires_at: null, signup_code_attempts: null };
    const { error } = await db.auth.admin.updateUserById(user.id, { email_confirm: true, app_metadata: { ...user.app_metadata, ...cleared } });
    if (error) throw new Error(`Confirmation du compte échouée : ${error.message}`);
  }

  return signIn(auth, address, input.password);
}

export async function signIn(auth: PasswordAuth, email: string, password: string): Promise<AccountSession> {
  const { data, error } = await auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
  const message = (error as { message?: string } | null)?.message ?? "";
  if (/not confirmed/i.test(message)) throw forbidden("Adresse pas encore vérifiée : saisis le code reçu par email.", "EMAIL_NOT_CONFIRMED");
  if (error || !data.session) throw unauthorized("Email ou mot de passe incorrect.", "LOGIN_FAILED");
  // Projet Supabase sans confirmation obligatoire : on l'exige quand même ici.
  if (!(data.session.user as { email_confirmed_at?: string | null }).email_confirmed_at) throw forbidden("Adresse pas encore vérifiée : saisis le code reçu par email.", "EMAIL_NOT_CONFIRMED");
  return toAccountSession(data.session);
}

export async function refresh(auth: PasswordAuth, refreshToken: string): Promise<AccountSession> {
  const { data, error } = await auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) throw unauthorized("Session expirée. Reconnecte-toi.", "SESSION_EXPIRED");
  return toAccountSession(data.session);
}
