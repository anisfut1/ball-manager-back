import { z } from "./zod.js";

/**
 * Comptes utilisateurs de l'espace licencié (web et app iOS) : création,
 * connexion, licenciés suivis, invitations, suppression. Voir docs/ACCOUNTS.md.
 */

const Email = z.string().trim().email("Adresse email invalide.").max(254);
const Password = z.string().min(8, "Le mot de passe doit faire au moins 8 caractères.").max(128);

/** Club d'où vient la personne : les liens des emails ramènent à son espace (`/public/{slug}/compte`), pas au login général. */
export const ClubSlugRef = z.string().trim().regex(/^[a-z0-9-]{1,80}$/, "Club invalide.").optional();
export const SignUpDtoSchema = z.object({ email: Email, password: Password, clubSlug: ClubSlugRef }).strict().openapi("SignUpDto");
export const ResendCodeDtoSchema = z.object({ email: Email, clubSlug: ClubSlugRef }).strict().openapi("ResendCodeDto");
export const VerifySignUpDtoSchema = z
  .object({ email: Email, code: z.string().trim().regex(/^\d{6}$/, "Le code fait 6 chiffres."), password: z.string().min(1).max(128) })
  .strict()
  .openapi("VerifySignUpDto");
export const SignInDtoSchema = z.object({ email: Email, password: z.string().min(1).max(128) }).strict().openapi("SignInDto");
export const RefreshAccountDtoSchema = z.object({ refreshToken: z.string().min(1).max(2048) }).strict().openapi("RefreshAccountDto");

export const AccountSessionDtoSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.string(),
    user: z.object({ id: z.string(), email: z.string().nullable() }),
  })
  .openapi("AccountSessionDto");

export const LinkStatusSchema = z.enum(["active", "pending", "refused"]);

export const AccountPersonDtoSchema = z
  .object({ licencieId: z.string(), firstName: z.string(), lastName: z.string(), teamId: z.string().nullable(), status: LinkStatusSchema })
  .openapi("AccountPersonDto");

export const AccountDtoSchema = z
  .object({
    id: z.string(),
    email: z.string().nullable(),
    /** Licenciés suivis dans CE club (actifs et en attente de validation). */
    people: z.array(AccountPersonDtoSchema),
  })
  .openapi("AccountDto");

/**
 * Rattacher un licencié au compte. Preuve facultative : lien personnel
 * (`personalLinkToken`) ; sinon l'adresse vérifiée du compte, sinon demande
 * à valider par un admin du club.
 */
export const CreateAccountLinkDtoSchema = z
  .object({ licencieId: z.string().uuid(), personalLinkToken: z.string().min(8).max(512).optional() })
  .strict()
  .openapi("CreateAccountLinkDto");

export const AccountLinkResultDtoSchema = z.object({ status: LinkStatusSchema, account: AccountDtoSchema }).openapi("AccountLinkResultDto");

/** Reprise d'une session d'appareil de l'app (avant les comptes) : ses personnes passent sur le compte. */
export const ImportDeviceSessionDtoSchema = z.object({ sessionSecret: z.string().min(20).max(256) }).strict().openapi("ImportDeviceSessionDto");

export const CreateAccountInviteDtoSchema = z.object({ licencieId: z.string().uuid() }).strict().openapi("CreateAccountInviteDto");
export const AccountInviteDtoSchema = z.object({ code: z.string(), url: z.string(), expiresAt: z.string() }).openapi("AccountInviteDto");
export const AcceptAccountInviteDtoSchema = z.object({ code: z.string().min(16).max(64) }).strict().openapi("AcceptAccountInviteDto");

export const AccountPushTokenDtoSchema = z
  .object({ token: z.string().regex(/^[0-9a-fA-F]{64,200}$/, "Jeton APNs invalide."), environment: z.enum(["development", "production"]), appVersion: z.string().trim().max(32).optional() })
  .strict()
  .openapi("AccountPushTokenDto");
export const AccountPushTokenRefDtoSchema = z.object({ token: z.string().regex(/^[0-9a-fA-F]{64,200}$/, "Jeton APNs invalide.") }).strict().openapi("AccountPushTokenRefDto");

export const AdminAccountLinkDtoSchema = z
  .object({
    id: z.string(),
    licencieId: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.string().nullable(),
    status: LinkStatusSchema,
    source: z.enum(["email_match", "personal_link", "device_session", "invite", "admin", "request"]),
    createdAt: z.string(),
  })
  .openapi("AdminAccountLinkDto");

export const AdminAccountLinkListDtoSchema = z.object({ links: z.array(AdminAccountLinkDtoSchema) }).openapi("AdminAccountLinkListDto");
export const RemoveAccountFromClubResultDtoSchema = z.object({ accountDeleted: z.boolean() }).openapi("RemoveAccountFromClubResultDto");

export type AccountDto = z.infer<typeof AccountDtoSchema>;
