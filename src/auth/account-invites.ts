import type { User } from "@supabase/supabase-js";
import { linkBaseUrl, links } from "../links/links.js";
import type { DbClient } from "../db/client.js";
import type { ClubRole } from "../db/types.js";
import { sendEmail } from "../email/resend.js";
import { buildAccessGrantedEmail, buildInviteEmail, buildPasswordResetEmail, type ClubBranding } from "../email/account-emails.js";
import { PLATFORM_NAME } from "../email/layout.js";

/**
 * Création de compte et emails d'accès, de A à Z par la plateforme (retour du
 * club, 2026-10-08) : plus jamais `inviteUserByEmail` (email Supabase brut,
 * lien vers un domaine tiers, aucune page pour choisir son mot de passe).
 *
 * `auth.admin.generateLink` crée le lien SANS envoyer d'email ; on n'en garde
 * que le `hashed_token`, envoyé dans NOTRE email vers `/bienvenue` du
 * frontend, qui le vérifie (`verifyOtp`) seulement quand la personne valide
 * son mot de passe — un antivirus de messagerie qui « ouvre » le lien ne le
 * consomme donc pas.
 */

/** Rôle principal, en minuscules, pour une phrase « en tant que … ». */
const ROLE_PHRASE: Record<ClubRole, string> = {
  club_admin: "administrateur",
  correspondant_club: "coordinateur",
  responsable_tables: "responsable des tables",
  coach: "coach",
  joueur: "joueur",
  parent: "parent",
};
const ROLE_PRIORITY: ClubRole[] = ["club_admin", "correspondant_club", "responsable_tables", "coach", "joueur", "parent"];

export function rolePhrase(roles: readonly ClubRole[]): string {
  const main = ROLE_PRIORITY.find((r) => roles.includes(r)) ?? "joueur";
  return ROLE_PHRASE[main];
}

/** URL publique du frontend (liens des emails) — `PUBLIC_APP_URL`, sinon la première origine https autorisée. */
export function appBaseUrl(): string {
  return linkBaseUrl();
}

/** Recherche par email sur toutes les pages (listUsers n'en renvoie qu'une par défaut). */
export async function findUserByEmail(db: DbClient, email: string): Promise<User | null> {
  const target = email.toLowerCase();
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Recherche de l'utilisateur échouée : ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === target);
    if (found) return found;
    if (data.users.length < 1000) return null;
  }
  return null;
}

function welcomeLink(hashedToken: string, type: string, next: string): string {
  const params = new URLSearchParams({ token_hash: hashedToken, type, next });
  return links(appBaseUrl()).accountWelcome(params);
}

/**
 * Donne accès à un club à une adresse email : crée le compte s'il n'existe
 * pas (email « Créer mon mot de passe »), sinon prévient la personne de son
 * nouvel accès. Un compte jamais utilisé (invitation restée sans suite)
 * reçoit une nouvelle invitation, pas un « connecte-toi ». L'email part via
 * `sendEmail()`, à appeler APRÈS l'enregistrement du rattachement au club :
 * jamais un email annonçant un accès qui n'existe pas encore.
 */
export async function provisionClubAccount(
  db: DbClient,
  input: { email: string; club: ClubBranding & { slug: string }; roles: readonly ClubRole[] },
): Promise<{ userId: string; emailKind: "invite" | "access_granted"; sendEmail: () => Promise<void> }> {
  const email = input.email.toLowerCase();
  const next = `/c/${input.club.slug}/dashboard`;
  const roleLabel = rolePhrase(input.roles);
  const existing = await findUserByEmail(db, email);

  if (existing && existing.last_sign_in_at) {
    const message = buildAccessGrantedEmail({ club: input.club, roleLabel, link: links(appBaseUrl()).absolute(next) });
    return { userId: existing.id, emailKind: "access_granted", sendEmail: async () => void (await sendEmail({ to: email, fromName: PLATFORM_NAME, ...message })) };
  }

  // Nouveau compte : invitation ; compte existant jamais utilisé : lien de connexion à usage unique.
  const { data, error } = existing
    ? await db.auth.admin.generateLink({ type: "magiclink", email })
    : await db.auth.admin.generateLink({ type: "invite", email });
  if (error || !data.user || !data.properties?.hashed_token) throw new Error(`Création du lien d'accès échouée : ${error?.message ?? "réponse incomplète"}`);

  const message = buildInviteEmail({ club: input.club, roleLabel, link: welcomeLink(data.properties.hashed_token, data.properties.verification_type ?? (existing ? "magiclink" : "invite"), next) });
  return { userId: data.user.id, emailKind: "invite", sendEmail: async () => void (await sendEmail({ to: email, fromName: PLATFORM_NAME, ...message })) };
}

/** Mot de passe oublié : n'envoie rien (et ne le dit pas) si l'adresse n'a pas de compte. */
export async function sendPasswordReset(db: DbClient, email: string): Promise<void> {
  const user = await findUserByEmail(db, email);
  if (!user) return;
  const { data, error } = await db.auth.admin.generateLink({ type: "recovery", email: email.toLowerCase() });
  if (error || !data.properties?.hashed_token) throw new Error(`Création du lien de réinitialisation échouée : ${error?.message ?? "réponse incomplète"}`);
  const message = buildPasswordResetEmail({ link: welcomeLink(data.properties.hashed_token, data.properties.verification_type ?? "recovery", "/") });
  await sendEmail({ to: email.toLowerCase(), fromName: PLATFORM_NAME, ...message });
}
