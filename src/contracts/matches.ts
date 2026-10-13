import { z } from "./zod.js";
import { QualityWarningDtoSchema, SanitizedErrorDtoSchema } from "./emarque.js";

const DEFAULT_MATCHES_LIMIT = 50;
const MAX_MATCHES_LIMIT = 200;

/**
 * GET /v1/clubs/:clubId/matches — filtres et pagination (gap 7/§10-§12 de
 * la demande). `period` couvre le besoin produit réel ("ce week-end/à
 * venir/passés") en utilisant le fuseau horaire DU CLUB (voir
 * src/util/timezone.ts) — le frontend n'a plus besoin de connaître ce
 * fuseau. `from`/`to` restent disponibles pour une plage explicite ; les
 * deux mécanismes sont mutuellement exclusifs (voir la route). Aucun
 * champ redondant (`played`/`upcoming` séparés de `status`/`period`) —
 * contrat volontairement minimal (§10 : "définis un contrat propre").
 */
export const MatchesQueryDtoSchema = z
  .object({
    period: z.enum(["weekend", "upcoming", "past"]).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    teamId: z.string().uuid().optional(),
    /** Domicile/extérieur DU CLUB tenant (jamais de l'adversaire), voir §10 de la demande. */
    homeAway: z.enum(["home", "away"]).optional(),
    status: z.enum(["scheduled", "played", "postponed", "cancelled", "forfeit"]).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_MATCHES_LIMIT).default(DEFAULT_MATCHES_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .openapi("MatchesQueryDto");

export type MatchesQueryDto = z.infer<typeof MatchesQueryDtoSchema>;

export const MatchesPaginationDtoSchema = z
  .object({
    limit: z.number(),
    offset: z.number(),
    total: z.number(),
  })
  .openapi("MatchesPaginationDto");

export const MatchListItemDtoSchema = z
  .object({
    id: z.string().uuid(),
    numero: z.string().nullable(),
    journee: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    isHome: z.boolean().nullable(),
    teamName: z.string().nullable(),
    /**
     * Compétition FFBB du match (`competitions.name`) et sa catégorie
     * (`competitions.category_label`, ex. "U9") — retour du club, 2026-10-01 :
     * "sur des matchs extérieur, on sait pas c quelle équipe qui joue". Certains
     * matchs (plateaux U9, brassages) n'ont pas d'équipe du club rattachée
     * (`team_id` null) : la compétition reste la seule donnée FFBB fiable pour
     * savoir de quelle catégorie il s'agit. `null` si aucune compétition liée.
     */
    competitionName: z.string().nullable(),
    categoryLabel: z.string().nullable(),
    opponentName: z.string().nullable(),
    /**
     * URL construite ({FFBB_API_BASE_URL}assets/{id}) — pas encore confirmé
     * accessible sans authentification depuis un navigateur (voir
     * docs/FFBB.md côté ball-manager-back). Peut nécessiter un proxy/cache
     * d'images côté frontend si l'affichage direct échoue.
     */
    opponentLogoUrl: z.string().nullable(),
    venueLabel: z.string().nullable(),
    scoreHome: z.number().nullable(),
    scoreAway: z.number().nullable(),
    status: z.enum(["scheduled", "played", "postponed", "cancelled", "forfeit"]),
    emarqueStatus: z.string(),
    /**
     * État CONNU le plus pertinent d'une dérogation FBI pour ce match, pour
     * un badge coloré (demande du club, 2026-09-26 : "faut matcher les
     * derog au calendrier, pour avoir un badge derog en cours sur les
     * matchs concernés" ; 2026-09-27 : "faut faire par couleur. acceptée =
     * vert en cours = orange refusée = rouge"). Jamais "A Créer" (état de
     * bruit sans vraie demande, voir docs/FBI.md côté ball-manager-back) —
     * `null` dans ce cas comme en l'absence de toute dérogation connue.
     * Une rencontre peut avoir PLUSIEURS dérogations distinctes (§ "82 vs
     * 51") : priorité à "en_cours" (dossier actionnable) sur "acceptee"/
     * "refusee" (déjà tranchés).
     */
    derogationStatus: z.enum(["en_cours", "acceptee", "refusee"]).nullable(),
  })
  .openapi("MatchListItemDto");

export type MatchListItemDto = z.infer<typeof MatchListItemDtoSchema>;

export const PlayerMatchStatsDtoSchema = z
  .object({
    participantId: z.string().uuid(),
    teamSide: z.enum(["home", "away"]),
    jerseyNumber: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    /** Vers la fiche joueur (`GET /v1/clubs/:clubId/licencies/:licencieId`, voir docs/LICENCIES.md) — `null` si ce participant n'a pas encore de licencié rattaché. */
    licencieId: z.string().uuid().nullable(),
    /**
     * Photo de la fiche joueur (retour du club, 2026-10-08 : stats en cartes
     * avec photo), aussi côté public depuis la fiche joueur publique (même
     * jour : « nom, prénom, photo... »). `null` sans photo renseignée.
     */
    photoUrl: z.string().nullable(),
    secondsPlayed: z.number().nullable(),
    points: z.number().nullable(),
    threePointsMade: z.number().nullable(),
    twoPointsInteriorMade: z.number().nullable(),
    twoPointsExteriorMade: z.number().nullable(),
    freeThrowsMade: z.number().nullable(),
    foulsCommitted: z.number().nullable(),
  })
  .openapi("PlayerMatchStatsDto");

export type PlayerMatchStatsDto = z.infer<typeof PlayerMatchStatsDtoSchema>;

export const MatchParticipantDtoSchema = z
  .object({
    id: z.string().uuid(),
    teamSide: z.enum(["home", "away"]),
    jerseyNumber: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    isCaptain: z.boolean(),
    isStarter: z.boolean().nullable(),
    licencieId: z.string().uuid().nullable(),
  })
  .openapi("MatchParticipantDto");

export const MatchCoachDtoSchema = z
  .object({
    teamSide: z.enum(["home", "away"]),
    role: z.enum(["principal", "adjoint"]),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    licencieId: z.string().uuid().nullable(),
  })
  .openapi("MatchCoachDto");

export const MatchOfficialDtoSchema = z
  .object({
    role: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    licencieId: z.string().uuid().nullable(),
  })
  .openapi("MatchOfficialDto");

export const EmarqueSummaryDtoSchema = z
  .object({
    status: z.string(),
    source: z.string().nullable(),
    lastRetrievedAt: z.string().nullable(),
    /** @deprecated Conservé pour compatibilité (§16 de la demande) — préférer `qualityWarnings.length`. */
    qualityWarningCount: z.number().nullable(),
    /** Import e-Marque le plus récent de ce match (gap 5 de la demande) — `null` si aucun import n'a encore été tenté. */
    parserVersion: z.string().nullable(),
    discoveredAt: z.string().nullable(),
    importedAt: z.string().nullable(),
    qualityWarnings: z.array(QualityWarningDtoSchema),
    lastError: SanitizedErrorDtoSchema.nullable(),
  })
  .openapi("EmarqueSummaryDto");

export const MatchDetailsDtoSchema = z
  .object({
    id: z.string().uuid(),
    numero: z.string().nullable(),
    journee: z.string().nullable(),
    matchDatetime: z.string().nullable(),
    isHome: z.boolean().nullable(),
    teamName: z.string().nullable(),
    /**
     * Compétition FFBB du match (`competitions.name`) et sa catégorie
     * (`competitions.category_label`, ex. "U9") — retour du club, 2026-10-01 :
     * "sur des matchs extérieur, on sait pas c quelle équipe qui joue". Certains
     * matchs (plateaux U9, brassages) n'ont pas d'équipe du club rattachée
     * (`team_id` null) : la compétition reste la seule donnée FFBB fiable pour
     * savoir de quelle catégorie il s'agit. `null` si aucune compétition liée.
     */
    competitionName: z.string().nullable(),
    categoryLabel: z.string().nullable(),
    opponentName: z.string().nullable(),
    opponentLogoUrl: z.string().nullable(),
    venueLabel: z.string().nullable(),
    scoreHome: z.number().nullable(),
    scoreAway: z.number().nullable(),
    status: z.enum(["scheduled", "played", "postponed", "cancelled", "forfeit"]),
    emarque: EmarqueSummaryDtoSchema,
    participants: z.array(MatchParticipantDtoSchema),
    coaches: z.array(MatchCoachDtoSchema),
    officials: z.array(MatchOfficialDtoSchema),
    tableOfficials: z.array(MatchOfficialDtoSchema),
    stats: z.array(PlayerMatchStatsDtoSchema),
  })
  .openapi("MatchDetailsDto");

export type MatchDetailsDto = z.infer<typeof MatchDetailsDtoSchema>;
