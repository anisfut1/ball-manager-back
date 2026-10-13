import { z } from "./zod.js";
import { TableAssignmentRoleSchema, TableAssignmentSlotDtoSchema, MatchRefDtoSchema, LicencieRefDtoSchema } from "./tables.js";

/**
 * DTO du flux PUBLIC sans compte des Tables de marque (retour du club,
 * 2026-09-29 : "je vais envoyer le lien à tout le monde et ils se
 * positionneront... l'accès se fera sans création de compte"). Réutilise
 * les schémas du module Tables de marque authentifié plutôt que de les
 * redéfinir (même forme de match/poste des deux côtés).
 */

export const PublicClubDtoSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    logoUrl: z.string().nullable(),
    accentColor: z.string().nullable(),
    timezone: z.string(),
  })
  .openapi("PublicClubDto");

/**
 * `claimed` : `true` si ce nom a déjà été choisi par quelqu'un (jamais QUI
 * — aucune donnée personnelle d'un tiers n'est exposée ici, voir §16 de la
 * demande "Tables de marque" appliqué par analogie à la vie privée).
 */
export const PublicLicencieDtoSchema = z
  .object({
    id: z.string().uuid(),
    firstName: z.string(),
    lastName: z.string(),
    claimed: z.boolean(),
  })
  .openapi("PublicLicencieDto");

export const PublicLicenciesListDtoSchema = z.object({ licencies: z.array(PublicLicencieDtoSchema) }).openapi("PublicLicenciesListDto");

/** Recherche de son nom (prénom + nom, ordre libre) — remplace l'annuaire complet (2026-10-08). */
export const LicencieSearchDtoSchema = z.object({ q: z.string().max(80) }).openapi("LicencieSearchDto");
export const LicencieSearchResultDtoSchema = z
  .object({ licencies: z.array(z.object({ id: z.string().uuid(), firstName: z.string(), lastInitial: z.string() })).max(5) })
  .openapi("LicencieSearchResultDto");

/** « Je ne trouve pas mon nom » : prévient les administrateurs du club. */
export const AccessRequestDtoSchema = z
  .object({
    fullName: z.string().trim().min(3, "Indique ton prénom et ton nom.").max(80),
    email: z.string().trim().email("Adresse email invalide."),
    message: z.string().max(500).optional(),
  })
  .strict()
  .openapi("AccessRequestDto");

/** Page du frontend public vers laquelle le bouton de l'email ramène (le lien porte toujours `?token=`). */
export const PublicLinkTargetSchema = z.enum(["accueil", "matchs", "tables", "derogations"]).openapi("PublicLinkTarget");

/**
 * POST .../licencies/:licencieId/request-link (retour du club, 2026-10-01 :
 * "il va chercher son nom, il va mettre son mail... un bouton qui renvoie
 * vers son lien avec token"). Le lien n'est JAMAIS renvoyé dans la réponse,
 * uniquement envoyé par email. `email` n'est utilisé que si le licencié n'a
 * encore aucune adresse connue — sinon l'email part TOUJOURS à l'adresse
 * déjà enregistrée (le champ saisi est ignoré), ce qui sert aussi de
 * "lien perdu ?".
 */
export const RequestPersonalLinkDtoSchema = z
  .object({
    email: z.string().trim().email("Adresse email invalide.").max(254).nullable().optional(),
    returnTo: PublicLinkTargetSchema.optional(),
  })
  .openapi("RequestPersonalLinkDto");

/** `maskedEmail` (ex: `c***@gmail.com`) : jamais l'adresse complète renvoyée à un visiteur anonyme. */
/**
 * `sent` : lien envoyé à l'adresse déjà connue (`maskedEmail`). `pendingApproval` :
 * fiche sans adresse, la demande attend la validation d'un admin du club (rien n'est envoyé avant).
 */
export const RequestPersonalLinkResultDtoSchema = z
  .object({ sent: z.boolean(), maskedEmail: z.string().nullable(), pendingApproval: z.boolean() })
  .openapi("RequestPersonalLinkResultDto");

/** Demande de lien en attente (fiche sans adresse), vue par les admins du club. */
export const ClaimRequestDtoSchema = z
  .object({
    id: z.string().uuid(),
    licencie: z.object({ id: z.string().uuid(), firstName: z.string(), lastName: z.string() }),
    requestedEmail: z.string().nullable(),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .openapi("ClaimRequestDto");
export const ClaimRequestListDtoSchema = z.object({ requests: z.array(ClaimRequestDtoSchema) }).openapi("ClaimRequestListDto");

/** `isClubAdmin` : le licencié est rattaché à un compte club_admin actif de CE club — seul cas où la vue publique des dérogations s'ouvre. */
export const PublicMeDtoSchema = z
  .object({
    licencie: LicencieRefDtoSchema,
    isClubAdmin: z.boolean(),
    /** Demandes de dérogation internes : coach (`licencies.public_coach`) / coordinateur (`public_coordinator`), posés depuis /joueurs. */
    derogationRequests: z.object({ canCreate: z.boolean(), canManage: z.boolean() }),
    /**
     * Tables de marque (retour du club, 2026-10-02) : un coach ou un admin
     * du club désigne / retire n'importe qui, comme l'admin connecté.
     */
    tables: z.object({ canManage: z.boolean() }),
  })
  .openapi("PublicMeDto");

export const PublicTableAssignmentsForMatchDtoSchema = z
  .object({
    match: MatchRefDtoSchema,
    assignments: z.object({
      scorer: TableAssignmentSlotDtoSchema.nullable(),
      timekeeper: TableAssignmentSlotDtoSchema.nullable(),
      clubDelegate: TableAssignmentSlotDtoSchema.nullable(),
      referee: TableAssignmentSlotDtoSchema.nullable(),
    }),
    refereeNotNeeded: z.boolean(),
    hasConflict: z.boolean(),
  })
  .openapi("PublicTableAssignmentsForMatchDto");

/** `me` permet au frontend de savoir "quel poste m'appartient" sans jamais faire confiance à une comparaison côté client seule (le retrait/l'affectation restent revalidés côté serveur à chaque écriture). */
export const PublicTableAssignmentsListDtoSchema = z
  .object({
    me: LicencieRefDtoSchema,
    matches: z.array(PublicTableAssignmentsForMatchDtoSchema),
  })
  .openapi("PublicTableAssignmentsListDto");

export const PublicTableAssignmentsQueryDtoSchema = z
  .object({
    /** Lien personnel (web). Facultatif avec une session d'appareil (`Authorization: Bearer bmd_…`) ou l'en-tête `X-Personal-Link-Token`. */
    token: z.string().min(1, "token manquant.").optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .openapi("PublicTableAssignmentsQueryDto");

/** Lien personnel (web). Facultatif avec une session d'appareil (`Authorization: Bearer bmd_…`) ou l'en-tête `X-Personal-Link-Token`. */
export const PublicTokenQueryDtoSchema = z.object({ token: z.string().min(1, "token manquant.").optional() }).openapi("PublicTokenQueryDto");

export const PublicAssignRoleQueryDtoSchema = PublicTokenQueryDtoSchema.extend({ role: TableAssignmentRoleSchema });

/**
 * Corps OPTIONNEL du PUT public : sans `licencieId` (ou avec le sien) =
 * auto-positionnement ; avec un autre `licencieId` = désignation, réservée
 * aux coachs / admins du club (`tables.canManage`).
 */
export const PublicAssignTableBodyDtoSchema = z
  .object({
    licencieId: z.string().min(1).optional(),
    /**
     * Se positionner quand même alors que son équipe joue sur ce créneau
     * (retour du club, 2026-10-08 : "il se peut qu'il ne joue pas le match
     * et fasse la table"). Ne lève QUE le conflit MATCH_CONFLICT, jamais
     * une autre table au même moment ni un autre poste du même match.
     */
    ignoreMatchConflict: z.boolean().optional(),
  })
  .openapi("PublicAssignTableBodyDto");

/** Réutilise le même DTO de résultat que le flux admin (`{ assignment }}`) — même forme des deux côtés. */
export const PublicAssignResultDtoSchema = z.object({ assignment: TableAssignmentSlotDtoSchema }).openapi("PublicAssignResultDto");

/**
 * Gestion admin des accès publics — `GET .../table-assignments/public-access`
 * (liste, pour voir qui a déjà revendiqué son nom) et
 * `POST .../public-access/:licencieId/reset` (retour du club : "sauf si
 * admin remet à reset son profil").
 */
export const PublicAccessEntryDtoSchema = z
  .object({
    licencie: LicencieRefDtoSchema,
    claimed: z.boolean(),
    email: z.string().nullable(),
    claimedAt: z.string().nullable(),
  })
  .openapi("PublicAccessEntryDto");

export const PublicAccessListDtoSchema = z.object({ entries: z.array(PublicAccessEntryDtoSchema) }).openapi("PublicAccessListDto");

export const PublicAccessResetResultDtoSchema = z.object({ reset: z.literal(true) }).openapi("PublicAccessResetResultDto");
