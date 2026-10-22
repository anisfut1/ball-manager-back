import { z } from "./zod.js";

/**
 * Authentification de l'app iOS (sessions d'appareil dérivées du lien
 * personnel, codes d'autorisation PKCE). Voir docs/MOBILE_AUTH.md.
 */

const Tokens = z.array(z.string().min(8).max(512)).min(1).max(8);
const Platform = z.enum(["ios", "web"]);
const Meta = {
  appVersion: z.string().trim().max(32).optional(),
  deviceLabel: z.string().trim().max(64).optional(),
};

export const SessionPersonDtoSchema = z
  .object({ licencieId: z.string(), firstName: z.string(), lastName: z.string(), teamId: z.string().nullable() })
  .openapi("SessionPersonDto");

/** Amorçage depuis un lien personnel (Universal Link reçu par l'app) : le jeton n'est PAS gardé par l'app. */
export const CreateDeviceSessionDtoSchema = z.object({ tokens: Tokens, platform: z.literal("ios"), ...Meta }).openapi("CreateDeviceSessionDto");

export const DeviceSessionDtoSchema = z
  .object({
    /** Secret à ranger dans le Keychain ; affiché UNE seule fois. */
    sessionSecret: z.string(),
    expiresAt: z.string(),
    people: z.array(SessionPersonDtoSchema),
    /** Destination à ouvrir après connexion (chemin interne `/public/…`), si connue. */
    redirectPath: z.string().nullable(),
  })
  .openapi("DeviceSessionDto");

export const SessionInfoDtoSchema = z
  .object({ platform: Platform, people: z.array(SessionPersonDtoSchema) })
  .openapi("SessionInfoDto");

export const AddSessionPeopleDtoSchema = z.object({ tokens: Tokens }).openapi("AddSessionPeopleDto");

/** Connexion depuis Safari (ASWebAuthenticationSession) : la page web, déjà identifiée, émet un code lié au challenge PKCE de l'app. */
export const CreateAuthCodeDtoSchema = z
  .object({
    tokens: Tokens,
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "code_challenge S256 invalide."),
    codeChallengeMethod: z.literal("S256"),
    redirectPath: z.string().max(300).optional(),
  })
  .openapi("CreateAuthCodeDto");

export const AuthCodeDtoSchema = z.object({ code: z.string(), expiresAt: z.string() }).openapi("AuthCodeDto");

/** Échange d'un code : `ios` → session d'appareil ; `web` (lien de connexion par email) → liens personnels pour la session web existante. */
export const ExchangeAuthCodeDtoSchema = z
  .object({ code: z.string().min(20).max(128), codeVerifier: z.string().min(43).max(128).optional(), platform: Platform, ...Meta })
  .openapi("ExchangeAuthCodeDto");

export const WebExchangeDtoSchema = z.object({ tokens: z.array(z.string()), redirectPath: z.string().nullable() }).openapi("WebExchangeDto");

export const PublicClubListDtoSchema = z
  .object({ clubs: z.array(z.object({ slug: z.string(), name: z.string(), logoUrl: z.string().nullable() })) })
  .openapi("PublicClubListDto");

/** Jeton APNs de cet iPhone, rattaché à la session d'appareil (un club = une session). */
export const PutPushTokenDtoSchema = z
  .object({
    token: z.string().regex(/^[0-9a-fA-F]{64,200}$/, "Jeton APNs invalide."),
    environment: z.enum(["development", "production"]),
    appVersion: z.string().trim().max(32).optional(),
  })
  .openapi("PutPushTokenDto");

/** Résultat de « Envoyer une notification de test » (cet iPhone seulement). */
export const PushTestResultDtoSchema = z
  .object({
    status: z.enum(["sent", "not_configured", "no_token", "failed"]),
    reason: z.string().nullable(),
  })
  .openapi("PushTestResultDto");

/**
 * Administration du club dans l'app (2026-10-22) : connexion avec le COMPTE
 * du site (email + mot de passe), réservée aux comptes `club_admin` du club.
 * La session renvoyée sert aux routes `/v1/clubs/{clubId}/…` (Bearer), comme
 * sur le site — jamais aux routes publiques.
 */
export const CreateAdminSessionDtoSchema = z
  .object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) })
  .strict()
  .openapi("CreateAdminSessionDto");

export const RefreshAdminSessionDtoSchema = z.object({ refreshToken: z.string().min(8).max(2048) }).strict().openapi("RefreshAdminSessionDto");

export const AdminSessionDtoSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    /** Expiration du jeton d'accès (ISO) : l'app rafraîchit avant. */
    expiresAt: z.string(),
    clubId: z.string().uuid(),
    email: z.string().nullable(),
  })
  .openapi("AdminSessionDto");
