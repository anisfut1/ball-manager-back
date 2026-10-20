import { z } from "./zod.js";

const FfbbIntegrationStatusDtoSchema = z.object({
  enabled: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: z.string().nullable(),
});

/**
 * §13/§14 de la demande : le `username` FBI configuré N'EST PAS un secret
 * équivalent au mot de passe — un club_admin doit pouvoir savoir quel
 * compte est configuré (gap 8). JAMAIS `password`, `password_ciphertext`,
 * `password_iv`, ni `password_auth_tag` dans ce DTO (voir
 * `integrations/fbi/credentials-store.ts#getFbiUsername`, qui ne sélectionne
 * que la colonne `username`).
 */
/**
 * Retour du club, 2026-09-29 : "il me faut un truc pour savoir quand ya un
 * truc en cours" — une seule session FBI active à la fois par club (voir
 * `claim_next_fbi_job(_for_club)`, migration 20260924140000) bloquait
 * silencieusement "Traiter les jobs FBI en attente" ("rien en attente")
 * sans jamais dire QU'un autre job tournait déjà. `type`/`startedAt`
 * reflètent le job `claimed`/`running` le plus récent pour ce club, mais
 * SEULEMENT s'il est encore dans la fenêtre de fraîcheur de 10 minutes du
 * garde-fou ci-dessus — un job plus vieux a forcément été tué par un
 * timeout/crash, jamais affiché comme "en cours" (ce serait mentir).
 */
export const FbiActiveJobDtoSchema = z
  .object({
    type: z.enum(["test_connection", "discover_emarque", "reconcile_schedule", "check_derogation", "check_all_derogations", "import_licences", "create_derogation", "respond_derogation"]),
    startedAt: z.string(),
  })
  .openapi("FbiActiveJobDto");

export const FbiIntegrationStatusDtoSchema = z
  .object({
    configured: z.boolean(),
    username: z.string().nullable(),
    connected: z.boolean(),
    lastLoginAt: z.string().nullable(),
    autoImportEmarque: z.boolean(),
    lastError: z.string().nullable(),
    activeJob: FbiActiveJobDtoSchema.nullable(),
  })
  .openapi("FbiIntegrationStatusDto");

export const IntegrationStatusDtoSchema = z
  .object({
    ffbb: FfbbIntegrationStatusDtoSchema,
    fbi: FbiIntegrationStatusDtoSchema,
  })
  .openapi("IntegrationStatusDto");

export type IntegrationStatusDto = z.infer<typeof IntegrationStatusDtoSchema>;
export type FbiIntegrationStatusDto = z.infer<typeof FbiIntegrationStatusDtoSchema>;
export type FbiActiveJobDto = z.infer<typeof FbiActiveJobDtoSchema>;

export const SaveFbiCredentialsDtoSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1).optional(),
  })
  .openapi("SaveFbiCredentialsDto");

/** Réponse de POST /v1/clubs/:clubId/integrations/fbi (§14 de la demande) : jamais le mot de passe, jamais le ciphertext. */
export const SaveFbiCredentialsResponseDtoSchema = z
  .object({
    saved: z.literal(true),
    fbi: FbiIntegrationStatusDtoSchema,
  })
  .openapi("SaveFbiCredentialsResponseDto");

/**
 * PATCH /v1/clubs/:clubId/integrations/fbi (gap 4 de la demande) — active/
 * désactive l'intégration FBI ou l'auto-import e-Marque SANS jamais
 * redemander username/password (déjà enregistrés, voir
 * `POST .../integrations/fbi`). `enabled=false` n'efface aucun identifiant,
 * ne fait que masquer la fonctionnalité (cohérent avec `getClubCapabilities`,
 * voir docs/FBI.md) — pour changer les identifiants eux-mêmes, voir
 * `POST .../integrations/fbi`.
 */
export const PatchFbiIntegrationDtoSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoImportEmarque: z.boolean().optional(),
  })
  .openapi("PatchFbiIntegrationDto");

export type PatchFbiIntegrationDto = z.infer<typeof PatchFbiIntegrationDtoSchema>;

const FFBB_CLUB_CODE_PATTERN = /^[A-Za-z0-9]{4,20}$/;

/**
 * PATCH /v1/clubs/:clubId/integrations/ffbb (gap 2 de la demande) — change
 * la SOURCE FFBB du club, jamais via `PATCH /v1/clubs/:clubId` (branding).
 * Sensible : un mauvais code change silencieusement quel club FFBB
 * alimente le calendrier — voir la route pour la validation de format et
 * `next_sync_at`.
 *
 * Format non strictement documenté par la FFBB (voir docs/FFBB.md — jamais
 * observé en direct depuis cet environnement) : validation volontairement
 * générale (alphanumérique, 4 à 20 caractères) plutôt qu'un format exact
 * deviné à partir du seul exemple connu ("OCC0034008").
 */
export const PatchFfbbIntegrationDtoSchema = z
  .object({
    clubCode: z
      .string()
      .trim()
      .regex(FFBB_CLUB_CODE_PATTERN, "Code club FFBB invalide (attendu : lettres/chiffres, 4 à 20 caractères).")
      .transform((value) => value.toUpperCase())
      .optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("PatchFfbbIntegrationDto");

export type PatchFfbbIntegrationDto = z.infer<typeof PatchFfbbIntegrationDtoSchema>;

export const SyncRunDtoSchema = z
  .object({
    id: z.string().uuid(),
    provider: z.enum(["ffbb", "fbi"]),
    status: z.enum(["running", "success", "partial", "error"]),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    errorLog: z.string().nullable(),
  })
  .openapi("SyncRunDto");

export type SyncRunDto = z.infer<typeof SyncRunDtoSchema>;
