import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { AddSessionPeopleDtoSchema, AuthCodeDtoSchema, CreateAuthCodeDtoSchema, CreateDeviceSessionDtoSchema, DeviceSessionDtoSchema, ExchangeAuthCodeDtoSchema,
  PutPushTokenDtoSchema, PublicClubListDtoSchema, SessionInfoDtoSchema, WebExchangeDtoSchema } from "./contracts/device-auth.js";
import { z } from "./contracts/zod.js";
import { ClubDtoSchema, TeamDtoSchema, UpdateClubDtoSchema, CreateTeamDtoSchema, UpdateTeamDtoSchema } from "./contracts/clubs.js";
import { MatchListItemDtoSchema, MatchDetailsDtoSchema, MatchesQueryDtoSchema, MatchesPaginationDtoSchema } from "./contracts/matches.js";
import {
  IntegrationStatusDtoSchema,
  FbiIntegrationStatusDtoSchema,
  SyncRunDtoSchema,
  SaveFbiCredentialsDtoSchema,
  SaveFbiCredentialsResponseDtoSchema,
  PatchFbiIntegrationDtoSchema,
  PatchFfbbIntegrationDtoSchema,
} from "./contracts/integrations.js";
import { MatchDocumentDtoSchema } from "./contracts/documents.js";
import {
  DerogationStatusDtoSchema,
  DerogationListItemDtoSchema,
  RespondToDerogationDtoSchema,
  RespondToDerogationResultDtoSchema,
  CreateDerogationDtoSchema,
  CreateDerogationResultDtoSchema,
} from "./contracts/derogations.js";
import { IssueDtoSchema } from "./contracts/issues.js";
import { JobStatusDtoSchema } from "./contracts/jobs.js";
import { PlatformClubDtoSchema, CreateClubDtoSchema, PlatformClubMembersDtoSchema, GrantClubAdminDtoSchema } from "./contracts/platform.js";
import {
  PurgeEmarqueDocumentsResultDtoSchema,
  DeleteOldSeasonsDtoSchema,
  DeleteOldSeasonsResultDtoSchema,
  RetryFailedEmarqueImportsResultDtoSchema,
} from "./contracts/maintenance.js";
import { ClubCapabilitiesSchema, ErrorEnvelopeSchema } from "./contracts/common.js";
import { EmarqueImportDtoSchema, EmarqueImportsQueryDtoSchema } from "./contracts/emarque.js";
import { EmarqueTrackingDtoSchema, EmarqueTrackingRelaunchDtoSchema } from "./contracts/emarque-tracking.js";
import { MeDtoSchema } from "./contracts/me.js";
import {
  LicenciesListDtoSchema,
  LicencieDtoSchema,
  LicencieProfileDtoSchema,
  UpdateLicencieProfileDtoSchema,
  ImportLicenciesDtoSchema,
  CreateLicencieDtoSchema,
  ImportLicenciesResultDtoSchema,
  LicenceSyncResultDtoSchema,
  LicenceImportStatusDtoSchema,
  AutoAssignTeamsResultDtoSchema,
  DeleteLicencieResultDtoSchema,
} from "./contracts/licencies.js";
import {
  TableAssignmentRoleSchema,
  TableSuggestionsQueryDtoSchema,
  TableSuggestionsDtoSchema,
  TableAssignmentsQueryDtoSchema,
  TableAssignmentsListDtoSchema,
  PutTableAssignmentDtoSchema,
  TableAssignmentResultDtoSchema,
  PutRefereeStatusDtoSchema,
  RefereeStatusResultDtoSchema,
} from "./contracts/tables.js";
import {
  PublicClubDtoSchema,
  PublicMeDtoSchema,
  RequestPersonalLinkDtoSchema,
  RequestPersonalLinkResultDtoSchema,
  PublicTableAssignmentsListDtoSchema,
  PublicTableAssignmentsQueryDtoSchema,
  PublicTokenQueryDtoSchema,
  PublicAssignResultDtoSchema,
  PublicAssignTableBodyDtoSchema,
  PublicAccessListDtoSchema,
  PublicAccessResetResultDtoSchema,
  LicencieSearchDtoSchema,
  LicencieSearchResultDtoSchema,
  AccessRequestDtoSchema,
  ClaimRequestListDtoSchema,
} from "./contracts/public-tables.js";
import {
  CreateDerogationRequestDtoSchema,
  DerogationActionDtoSchema,
  DerogationAvailabilityDtoSchema,
  DerogationAvailabilityQueryDtoSchema,
  DerogationContextDtoSchema,
  DerogationRequestDetailDtoSchema,
  DerogationRequestListDtoSchema,
  DerogationRequestListQueryDtoSchema,
  DerogationSlotCheckDtoSchema,
  DerogationSlotCheckQueryDtoSchema,
  PostDerogationMessageDtoSchema,
  ProposeDerogationSlotDtoSchema,
  SubmitOfficialDerogationResultDtoSchema,
} from "./contracts/derogation-requests.js";
import { PublicHomeDtoSchema } from "./contracts/public-home.js";
import { PublicPlayerProfileDtoSchema } from "./contracts/public-players.js";
import { TableLeaderboardDtoSchema } from "./contracts/tables.js";
import { PasswordResetDtoSchema } from "./modules/account/routes.js";
import { ClubMemberListDtoSchema, InviteMemberDtoSchema, SetMemberRolesDtoSchema } from "./contracts/members.js";
import { ClubVenueAdminDtoSchema, ClubVenueListDtoSchema, UpdateClubVenueDtoSchema } from "./contracts/club-venues.js";
import { PoolStandingsListDtoSchema } from "./contracts/standings.js";

/**
 * Spec OpenAPI assemblée à partir des MÊMES schémas zod que les DTO utilisés
 * par les routes (§37/§38 de la demande) — pas une documentation écrite à
 * la main séparément qui pourrait diverger. Les handlers eux-mêmes restent
 * du Hono simple (voir src/modules/**), cette spec sert de contrat lisible
 * et de base pour générer un client frontend.
 */
import {
  ActionCenterDtoSchema,
  ActionCenterRequestDtoSchema,
  CancelTrainingOccurrenceDtoSchema,
  CreateTrainingSeriesDtoSchema,
  PlanningDtoSchema,
  PutTrainingResponseDtoSchema,
  TrainingOccurrenceDetailDtoSchema,
  TrainingOccurrenceDtoSchema,
  TrainingOccurrenceListDtoSchema,
  PutTrainingAttendanceDtoSchema,
  TeamOverviewDtoSchema,
  TrainingResponseResultDtoSchema,
  TrainingSeriesListDtoSchema,
  UpdateTrainingOccurrenceDtoSchema,
  UpdateTrainingSeriesDtoSchema,
} from "./contracts/trainings.js";
import {
  AvailabilityResponseResultDtoSchema,
  ConvocationPreviewDtoSchema,
  ConvocationResponseResultDtoSchema,
  MatchTeamLifeDtoSchema,
  PutAvailabilityResponseDtoSchema,
  PutConvocationDraftDtoSchema,
  PutConvocationResponseDtoSchema,
  LaundryDtoSchema,
  LaundrySuggestionsDtoSchema,
  PutLaundryDtoSchema,
} from "./contracts/convocations.js";
const registry = new OpenAPIRegistry();

registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "Jeton Supabase Auth du frontend (voir docs/AUTH.md).",
});

const bearerAuth = [{ BearerAuth: [] }];

function jsonResponse(description: string, schema: z.ZodTypeAny) {
  return { description, content: { "application/json": { schema } } };
}

const clubIdParam = z.object({ clubId: z.string().openapi({ description: "UUID ou slug du club" }) });
const clubAndMatchIdParams = clubIdParam.extend({ matchId: z.string().uuid() });
const clubAndDerogationIdParams = clubIdParam.extend({ derogationId: z.string().uuid() });
const clubAndJobParams = z.object({ jobId: z.string().uuid() });
const clubAndMatchIssueParams = clubIdParam.extend({ matchId: z.string().uuid() });
const clubAndMatchAndRoleParams = clubAndMatchIdParams.extend({ role: TableAssignmentRoleSchema });
const clubAndLicencieIdParams = clubIdParam.extend({ licencieId: z.string().uuid() });
const clubAndRequestIdParams = clubIdParam.extend({ requestId: z.string().uuid() });

const clubSlugParam = z.object({ clubSlug: z.string().openapi({ description: "Slug du club (flux public sans compte)" }) });
const clubSlugAndLicencieIdParams = clubSlugParam.extend({ licencieId: z.string().uuid() });
const clubSlugAndMatchIdParams = clubSlugParam.extend({ matchId: z.string().uuid() });
const clubSlugAndMatchAndRoleParams = clubSlugAndMatchIdParams.extend({ role: TableAssignmentRoleSchema });

const errorResponses = {
  401: jsonResponse("Non authentifié", ErrorEnvelopeSchema),
  403: jsonResponse("Accès refusé", ErrorEnvelopeSchema),
  404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
};
/** Ajouté aux routes qui valident un payload/query (zod) ou une précondition métier (ex: FBI_NOT_CONFIGURED). */
const validationResponses = { 400: jsonResponse("Requête invalide", ErrorEnvelopeSchema), 409: jsonResponse("Conflit métier", ErrorEnvelopeSchema) };

/** Lien personnel réaffiché pour un club_admin (`created` : un nouveau lien vient d'être émis). */
const PersonalLinkDtoSchema = z.object({ link: z.string().url(), created: z.boolean() }).openapi("PersonalLinkDto");

registry.registerPath({
  method: "get",
  path: "/v1/me",
  security: bearerAuth,
  responses: { 200: jsonResponse("Utilisateur courant", MeDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs",
  security: bearerAuth,
  responses: { 200: jsonResponse("Clubs dont l'utilisateur est membre", z.object({ clubs: z.array(ClubDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Détail du club", ClubDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: UpdateClubDtoSchema } } } },
  responses: { 200: jsonResponse("Club mis à jour (branding uniquement)", ClubDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/capabilities",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Capacités du club (FBI facultatif)", ClubCapabilitiesSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/teams",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Équipes du club (y compris sans engagement FFBB, voir docs/TEAMS.md)", z.object({ teams: z.array(TeamDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/teams",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: CreateTeamDtoSchema } } } },
  responses: { 201: jsonResponse("Équipe créée", TeamDtoSchema), ...errorResponses, ...validationResponses },
});

const clubAndTeamParams = clubIdParam.extend({ teamId: z.string().uuid() });

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}/teams/{teamId}",
  security: bearerAuth,
  request: { params: clubAndTeamParams, body: { content: { "application/json": { schema: UpdateTeamDtoSchema } } } },
  responses: { 200: jsonResponse("Équipe mise à jour", TeamDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches",
  security: bearerAuth,
  request: { params: clubIdParam, query: MatchesQueryDtoSchema },
  responses: {
    200: jsonResponse("Matchs du club (filtrés, paginés)", z.object({ matches: z.array(MatchListItemDtoSchema), pagination: MatchesPaginationDtoSchema })),
    ...errorResponses,
    ...validationResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams },
  responses: { 200: jsonResponse("Détail du match", MatchDetailsDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/documents",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams },
  responses: { 200: jsonResponse("Documents e-Marque du match", z.object({ documents: z.array(MatchDocumentDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams },
  responses: {
    200: jsonResponse("Dernier état connu de la dérogation de ce match (null si aucune)", z.object({ derogation: DerogationStatusDtoSchema.nullable() })),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation/check",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams },
  responses: {
    // Synchrone depuis 2026-09-28 (voir checkDerogationForMatchSync) —
    // jamais plus un job fbi_jobs à espérer voir traité par un clic futur.
    200: jsonResponse("Résultat immédiat de la vérification FBI de ce match", z.object({ found: z.boolean() })),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/emarque-imports",
  security: bearerAuth,
  request: { params: clubIdParam, query: EmarqueImportsQueryDtoSchema },
  responses: {
    200: jsonResponse("Imports e-Marque du club (filtrés, paginés)", z.object({ imports: z.array(EmarqueImportDtoSchema), pagination: MatchesPaginationDtoSchema })),
    ...errorResponses,
    ...validationResponses,
  },
});

// Suivi des statistiques e-Marque (retour du club, 2026-10-06 : processus clair, réservé à l'admin du club).
registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/emarque-tracking",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("État de récupération des statistiques de chaque match joué de la saison", EmarqueTrackingDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/emarque-tracking/{matchId}/relaunch",
  security: bearerAuth,
  request: { params: clubIdParam.extend({ matchId: z.string() }) },
  responses: { 202: jsonResponse("Relance enregistrée : essai au prochain passage, puis 7 jours au calendrier fixe", EmarqueTrackingRelaunchDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/integrations",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Statut des intégrations", IntegrationStatusDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: SaveFbiCredentialsDtoSchema } } } },
  responses: { 200: jsonResponse("Identifiants enregistrés (jamais le mot de passe)", SaveFbiCredentialsResponseDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}/integrations/fbi",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: PatchFbiIntegrationDtoSchema } } } },
  responses: {
    200: jsonResponse("Réglages FBI mis à jour", z.object({ fbi: FbiIntegrationStatusDtoSchema })),
    ...errorResponses,
    ...validationResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/test",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    // Réponse toujours synchrone depuis le 2026-09-24 (voir docs/FBI.md) :
    // le repli navigateur (BROWSER_FBI_ENABLED) tourne DANS cette requête,
    // plus de pattern 202+jobId.
    200: jsonResponse("Résultat du test (HttpFbiClient, ou BrowserFbiClient en repli)", z.object({ success: z.boolean(), message: z.string() })),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/process-jobs",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    200: jsonResponse(
      "Lot de jobs FBI du club traité (discover_emarque/test_connection en attente)",
      z.object({ claimed: z.number(), succeeded: z.number(), failed: z.number() }),
    ),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/reconcile-schedule",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    // 200 (job empilé) plutôt que 202+jobId — même modèle qu'un `discover_emarque`
    // enqueue, consommé ensuite par POST .../fbi/process-jobs (ou le cron).
    200: jsonResponse("Job de rapprochement calendrier FFBB/FBI empilé (un seul par club à la fois)", z.object({ queued: z.literal(true) })),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/check-all-derogations",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    // Synchrone depuis 2026-09-28 (voir checkAllDerogationsForClubSync).
    200: jsonResponse(
      "Résultat immédiat de la vérification globale FBI",
      z.object({ derogationsFound: z.number(), matched: z.number(), unmatched: z.number() }),
    ),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/derogations",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Toutes les dérogations connues du club", z.object({ derogations: z.array(DerogationListItemDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogations/{derogationId}/respond",
  security: bearerAuth,
  // ÉCRIT réellement sur FBI/FFBB (accepter/refuser) — demande du club,
  // 2026-09-27 : "je veux le faire via loutil". Synchrone (jamais via
  // fbi_jobs), voir la doc de `respondToDerogationForClub`.
  request: { params: clubAndDerogationIdParams, body: { content: { "application/json": { schema: RespondToDerogationDtoSchema } } } },
  responses: { 200: jsonResponse("Résultat RÉEL renvoyé par FBI (success/error/unknown)", RespondToDerogationResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation/respond",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams, body: { content: { "application/json": { schema: RespondToDerogationDtoSchema } } } },
  responses: { 200: jsonResponse("Résultat RÉEL renvoyé par FBI (success/error/unknown)", RespondToDerogationResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/table-suggestions",
  security: bearerAuth,
  // STRICTEMENT en lecture (§37 de la demande "Tables de marque") — ne crée jamais d'affectation, voir computeTableSuggestions (fonction pure).
  request: { params: clubAndMatchIdParams, query: TableSuggestionsQueryDtoSchema },
  responses: { 200: jsonResponse("Candidats classés (recommandés/disponibles/indisponibles) pour ce rôle sur ce match", TableSuggestionsDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "put",
  path: "/v1/clubs/{clubId}/matches/{matchId}/table-assignments/{role}",
  security: bearerAuth,
  // SEULE route qui transforme une suggestion en affectation réelle — recalcule toujours les conflits au moment de l'écriture (§42), jamais de force/override en V1 (§43).
  request: { params: clubAndMatchAndRoleParams, body: { content: { "application/json": { schema: PutTableAssignmentDtoSchema } } } },
  responses: { 200: jsonResponse("Affectation enregistrée", TableAssignmentResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "delete",
  path: "/v1/clubs/{clubId}/matches/{matchId}/table-assignments/{role}",
  security: bearerAuth,
  request: { params: clubAndMatchAndRoleParams },
  responses: { 200: jsonResponse("Affectation retirée (poste remis à 'À attribuer')", z.object({ removed: z.literal(true) })), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/table-assignments",
  security: bearerAuth,
  // Matchs à DOMICILE uniquement (§4 de la demande "Tables de marque") — un match extérieur n'apparaît jamais dans cette liste.
  request: { params: clubIdParam, query: TableAssignmentsQueryDtoSchema },
  responses: { 200: jsonResponse("Matchs à domicile du club, avec leurs 4 postes (affectés ou 'à attribuer')", TableAssignmentsListDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "put",
  path: "/v1/clubs/{clubId}/matches/{matchId}/referee-status",
  security: bearerAuth,
  // Bascule "pas besoin d'arbitre" (retour du club, 2026-09-28) — n'affecte jamais table_assignments, voir match_referee_overrides.
  request: { params: clubAndMatchIdParams, body: { content: { "application/json": { schema: PutRefereeStatusDtoSchema } } } },
  responses: { 200: jsonResponse("Statut arbitre enregistré", RefereeStatusResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/table-assignments/public-access",
  security: bearerAuth,
  // club_admin uniquement (retour du club, 2026-09-29 : gestion d'accès/identité sans compte) — qui a revendiqué son lien personnel.
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("État des accès publics par licencié (revendiqué ou non)", PublicAccessListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/table-assignments/public-access/{licencieId}/reset",
  security: bearerAuth,
  // Révoque le jeton actif du licencié (lien perdu, etc.) — le nom redevient choisissable, les affectations existantes ne sont jamais touchées.
  request: { params: clubAndLicencieIdParams },
  responses: { 200: jsonResponse("Accès public réinitialisé", PublicAccessResetResultDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/table-assignments/public-access/{licencieId}/link",
  security: bearerAuth,
  // club_admin : réaffiche le lien personnel actif du licencié (ou en émet un s'il n'en a pas) pour le lui envoyer soi-même.
  request: { params: clubAndLicencieIdParams },
  responses: { 200: jsonResponse("Lien personnel du licencié", PersonalLinkDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/table-assignments/public-access/claims",
  security: bearerAuth,
  // club_admin : demandes de lien pour une fiche sans adresse connue (risque R-018) — rien n'est envoyé sans validation.
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Demandes en attente (non expirées)", ClaimRequestListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/table-assignments/public-access/claims/{requestId}/approve",
  security: bearerAuth,
  request: { params: clubAndRequestIdParams },
  responses: {
    200: jsonResponse("Lien envoyé à l'adresse demandée, enregistrée sur la fiche", z.object({ approved: z.literal(true) })),
    409: jsonResponse("Déjà traitée (ALREADY_DECIDED) ou expirée (EXPIRED)", ErrorEnvelopeSchema),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/table-assignments/public-access/claims/{requestId}/reject",
  security: bearerAuth,
  request: { params: clubAndRequestIdParams },
  responses: {
    200: jsonResponse("Demande refusée, rien n'est envoyé", z.object({ rejected: z.literal(true) })),
    409: jsonResponse("Déjà traitée (ALREADY_DECIDED) ou expirée (EXPIRED)", ErrorEnvelopeSchema),
    ...errorResponses,
  },
});

/**
 * Flux PUBLIC sans compte (retour du club, 2026-09-29) — AUCUNE de ces
 * routes ne porte `security: bearerAuth` : il n'y a pas de session
 * Supabase, l'identité vient du `token` (query string), voir
 * modules/public-tables/routes.ts.
 */
registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}",
  request: { params: clubSlugParam },
  responses: { 200: jsonResponse("Infos club minimales (aucune donnée membre/rôle)", PublicClubDtoSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/licencies",
  request: { params: clubSlugParam },
  // Fermée le 2026-10-08 (annuaire complet sans compte, risque R-013) : voir …/licencies/search.
  responses: { 410: jsonResponse("Fermée : utiliser POST …/licencies/search", ErrorEnvelopeSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "post",
  path: "/v1/public/clubs/{clubSlug}/licencies/{licencieId}/request-link",
  // Le jeton n'est JAMAIS dans la réponse : uniquement envoyé par email (Resend) — retour du club, 2026-10-01.
  request: { params: clubSlugAndLicencieIdParams, body: { content: { "application/json": { schema: RequestPersonalLinkDtoSchema } } } },
  responses: {
    200: jsonResponse("Lien personnel envoyé par email à l'adresse connue (adresse masquée)", RequestPersonalLinkResultDtoSchema),
    202: jsonResponse("Fiche sans adresse : demande transmise aux administrateurs, rien n'est envoyé (pendingApproval)", RequestPersonalLinkResultDtoSchema),
    400: jsonResponse("Requête invalide ou email requis (EMAIL_REQUIRED)", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
    409: jsonResponse("Nom déjà choisi sans adresse email connue (ALREADY_CLAIMED)", ErrorEnvelopeSchema),
    429: jsonResponse("Lien envoyé il y a moins d'une minute (LINK_RECENTLY_SENT)", ErrorEnvelopeSchema),
    502: jsonResponse("Envoi refusé par le service d'email (EMAIL_SEND_FAILED)", ErrorEnvelopeSchema),
    503: jsonResponse("Envoi d'email non configuré (EMAIL_NOT_CONFIGURED)", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/derogations",
  // Admin du club ou coordinateur (retour du club, 2026-10-01 / 2026-10-02).
  request: { params: clubSlugParam, query: PublicTokenQueryDtoSchema },
  responses: {
    200: jsonResponse("Dérogations connues du club", z.object({ derogations: z.array(DerogationListItemDtoSchema) })),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    403: jsonResponse("Ni administrateur ni coordinateur du club (CLUB_ADMIN_REQUIRED)", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/public/clubs/{clubSlug}/derogations/{derogationId}/respond",
  // ÉCRIT sur FBI (accepter / refuser) — admin du club ou coordinateur (2026-10-02).
  request: { params: clubSlugParam.extend({ derogationId: z.string() }), query: PublicTokenQueryDtoSchema, body: { content: { "application/json": { schema: RespondToDerogationDtoSchema } } } },
  responses: {
    200: jsonResponse("Résultat de l'envoi à FBI", RespondToDerogationResultDtoSchema),
    400: jsonResponse("Requête invalide", ErrorEnvelopeSchema),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    403: jsonResponse("Ni administrateur ni coordinateur du club (CLUB_ADMIN_REQUIRED)", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/derogation/create",
  // ÉCRIT sur FBI : nouvelle dérogation officielle — admin du club ou coordinateur (2026-10-02).
  request: { params: clubSlugAndMatchIdParams, query: PublicTokenQueryDtoSchema, body: { content: { "application/json": { schema: CreateDerogationDtoSchema } } } },
  responses: {
    200: jsonResponse("Résultat de l'envoi à FBI", CreateDerogationResultDtoSchema),
    400: jsonResponse("Requête invalide", ErrorEnvelopeSchema),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    403: jsonResponse("Ni administrateur ni coordinateur du club (CLUB_ADMIN_REQUIRED)", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/me",
  request: { params: clubSlugParam, query: PublicTokenQueryDtoSchema },
  responses: { 200: jsonResponse("Identité résolue depuis le jeton", PublicMeDtoSchema), 401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/table-assignments",
  request: { params: clubSlugParam, query: PublicTableAssignmentsQueryDtoSchema },
  responses: { 200: jsonResponse("Même contenu que la vue admin, avec `me`", PublicTableAssignmentsListDtoSchema), 401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "put",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/table-assignments/{role}",
  // Sans corps : auto-affectation (ne remplace jamais un·e titulaire différent·e). Avec `licencieId` d'un·e autre : désignation par un coach / admin du club (2026-10-02).
  request: { params: clubSlugAndMatchAndRoleParams, query: PublicTokenQueryDtoSchema, body: { required: false, content: { "application/json": { schema: PublicAssignTableBodyDtoSchema } } } },
  responses: {
    200: jsonResponse("Affectation enregistrée", PublicAssignResultDtoSchema),
    400: jsonResponse("Requête invalide", ErrorEnvelopeSchema),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    403: jsonResponse("Désigner quelqu'un d'autre est réservé aux coachs / admins du club", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
    409: jsonResponse("Conflit métier ou poste déjà occupé par quelqu'un d'autre", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/table-assignments/{role}",
  // Retrait de SA PROPRE affectation — 403 si le poste appartient à quelqu'un d'autre, sauf pour un coach / admin du club (2026-10-02).
  request: { params: clubSlugAndMatchAndRoleParams, query: PublicTokenQueryDtoSchema },
  responses: {
    200: jsonResponse("Affectation retirée", z.object({ removed: z.literal(true) })),
    400: jsonResponse("Requête invalide", ErrorEnvelopeSchema),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    403: jsonResponse("Ce poste appartient à quelqu'un d'autre", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/table-suggestions",
  // Coach / admin du club (2026-10-02) — mêmes suggestions, en lecture seule, que la vue admin.
  request: { params: clubSlugAndMatchIdParams, query: PublicTokenQueryDtoSchema.extend({ role: TableAssignmentRoleSchema }) },
  responses: {
    200: jsonResponse("Candidats classés pour ce poste", TableSuggestionsDtoSchema),
    400: jsonResponse("Requête invalide", ErrorEnvelopeSchema),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    403: jsonResponse("Réservé aux coachs / admins du club", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "put",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/referee-status",
  // « Pas besoin d'arbitre » depuis l'espace public — coach / admin du club (2026-10-02).
  request: { params: clubSlugAndMatchIdParams, query: PublicTokenQueryDtoSchema, body: { content: { "application/json": { schema: PutRefereeStatusDtoSchema } } } },
  responses: {
    200: jsonResponse("Statut arbitre enregistré", RefereeStatusResultDtoSchema),
    400: jsonResponse("Requête invalide", ErrorEnvelopeSchema),
    401: jsonResponse("Jeton invalide ou révoqué", ErrorEnvelopeSchema),
    403: jsonResponse("Réservé aux coachs / admins du club", ErrorEnvelopeSchema),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

/**
 * Vue PUBLIQUE en lecture seule des matchs (retour du club, 2026-09-29 :
 * "je veux une vue publique avec toutes les infos en vue directe... sans
 * compte, en libre service") — jamais de `security` ici, contrairement aux
 * routes `/v1/clubs/{clubId}/matches...` équivalentes ci-dessus : aucune
 * session Supabase requise. Mêmes DTOs de réponse (réutilisés tels quels,
 * voir `modules/matches/shared.ts`), sauf `documents[].downloadUrl` toujours
 * `null` ici (jamais d'URL signée pour un visiteur anonyme) et aucune route
 * d'écriture (dérogation créer/répondre, vérifier sur FBI — `club_admin`
 * uniquement, jamais exposées publiquement).
 */
registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/standings",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Classements FFBB des poules où le club est engagé", PoolStandingsListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/standings",
  // Classements FFBB des poules où le club est engagé — retour du club, 2026-10-01.
  request: { params: clubSlugParam },
  responses: { 200: jsonResponse("Classements FFBB (copiés à chaque synchronisation)", PoolStandingsListDtoSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "post",
  path: "/v1/public/clubs/{clubSlug}/licencies/search",
  // Recherche de son nom (prénom + nom, ordre libre, fautes tolérées) — remplace l'annuaire complet, 2026-10-08.
  request: { params: clubSlugParam, body: { content: { "application/json": { schema: LicencieSearchDtoSchema } } } },
  responses: { 200: jsonResponse("Au plus 5 fiches : prénom et initiale du nom", LicencieSearchResultDtoSchema), 429: jsonResponse("Trop de recherches", ErrorEnvelopeSchema), ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/public/clubs/{clubSlug}/access-requests",
  // « Je ne trouve pas mon nom » : email aux administrateurs du club — 2026-10-08.
  request: { params: clubSlugParam, body: { content: { "application/json": { schema: AccessRequestDtoSchema } } } },
  responses: { 202: jsonResponse("Demande transmise au club", z.object({ sent: z.literal(true) })), 429: jsonResponse("Demande déjà envoyée", ErrorEnvelopeSchema), ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/account/password-reset",
  // Mot de passe oublié — réponse identique que le compte existe ou non (retour du club, 2026-10-08).
  request: { body: { content: { "application/json": { schema: PasswordResetDtoSchema } } } },
  responses: { 200: jsonResponse("Demande prise en compte", z.object({ sent: z.literal(true) })), ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/table-leaderboard",
  // Classement des tables de marque, visible de tous — retour du club, 2026-10-08.
  request: { params: clubSlugParam },
  responses: { 200: jsonResponse("Classement des tables tenues cette saison (ex æquo = même rang)", TableLeaderboardDtoSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/players/{licencieId}",
  // Fiche joueur publique — retour du club, 2026-10-08. Jamais de coordonnées, date de naissance ni numéro de licence.
  request: { params: z.object({ clubSlug: z.string(), licencieId: z.string().uuid() }) },
  responses: { 200: jsonResponse("Fiche joueur publique (saison en cours, matchs publiés uniquement)", PublicPlayerProfileDtoSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/teams",
  request: { params: clubSlugParam },
  responses: { 200: jsonResponse("Équipes du club (pour le filtre de la liste des matchs)", z.object({ teams: z.array(TeamDtoSchema) })), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/matches",
  request: { params: clubSlugParam, query: MatchesQueryDtoSchema },
  responses: {
    200: jsonResponse("Matchs du club (filtrés, paginés) — mêmes filtres que la route authentifiée", z.object({ matches: z.array(MatchListItemDtoSchema), pagination: MatchesPaginationDtoSchema })),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
    ...validationResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}",
  request: { params: clubSlugAndMatchIdParams },
  responses: { 200: jsonResponse("Détail du match (composition, statistiques, officiels, e-Marque)", MatchDetailsDtoSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/documents",
  request: { params: clubSlugAndMatchIdParams },
  responses: {
    200: jsonResponse("Documents e-Marque du match — `downloadUrl` toujours `null` (jamais d'URL signée en public)", z.object({ documents: z.array(MatchDocumentDtoSchema) })),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/matches/{matchId}/derogation",
  request: { params: clubSlugAndMatchIdParams },
  responses: {
    200: jsonResponse("Dernier état connu de la dérogation de ce match (null si aucune)", z.object({ derogation: DerogationStatusDtoSchema.nullable() })),
    404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation/create",
  security: bearerAuth,
  // ÉCRIT réellement sur FBI/FFBB (crée une nouvelle dérogation) — demande
  // du club, 2026-09-28 : "mtn faut en créer une". Synchrone, voir la doc
  // de `createDerogationForClub`.
  request: { params: clubAndMatchIdParams, body: { content: { "application/json": { schema: CreateDerogationDtoSchema } } } },
  responses: { 200: jsonResponse("Résultat RÉEL renvoyé par FBI (success/error/unknown)", CreateDerogationResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/fbi/parse-documents",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: {
    200: jsonResponse(
      "Lot de documents e-Marque téléchargés du club parsés (OCR/PDF, jamais de navigateur)",
      z.object({ candidatesExamined: z.number(), imported: z.number(), errors: z.number() }),
    ),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/integrations/sync-runs",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Historique des synchronisations", z.object({ syncRuns: z.array(SyncRunDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/integrations/ffbb/sync",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Résultat de la synchronisation", z.object({ syncRunId: z.string().uuid(), status: z.string(), stats: z.record(z.string(), z.number()) })), ...errorResponses },
});

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}/integrations/ffbb",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: PatchFfbbIntegrationDtoSchema } } } },
  responses: {
    200: jsonResponse(
      "Intégration FFBB mise à jour (jamais de suppression de l'historique déjà synchronisé)",
      z.object({ clubCode: z.string(), enabled: z.boolean(), nextSyncAt: z.string().nullable() }),
    ),
    ...errorResponses,
    ...validationResponses,
  },
});

const UploadLicenciePhotoDtoSchema = z.object({ contentType: z.enum(["image/webp", "image/jpeg", "image/png"]), data: z.string().min(1) }).openapi("UploadLicenciePhotoDto");
const clubAndLicencieParams = clubIdParam.extend({ licencieId: z.string().uuid() });

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/licencies",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Roster du club", LicenciesListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/licencies/{licencieId}",
  security: bearerAuth,
  request: { params: clubAndLicencieParams },
  responses: { 200: jsonResponse("Fiche joueur : identité, historique des matchs, statistiques par match", LicencieProfileDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}/licencies/{licencieId}/profile",
  security: bearerAuth,
  request: { params: clubAndLicencieParams, body: { content: { "application/json": { schema: UpdateLicencieProfileDtoSchema } } } },
  responses: {
    200: jsonResponse("Profil mis à jour (champs admin, ou contact/photo si le licencié lui-même)", LicencieDtoSchema),
    ...errorResponses,
    ...validationResponses,
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/licencies/{licencieId}/photo",
  security: bearerAuth,
  // Photo déjà compressée par le navigateur (WebP 512 px), en base64 ; 512 Ko max. Admin du club ou le licencié lui-même.
  request: { params: clubAndLicencieParams, body: { content: { "application/json": { schema: UploadLicenciePhotoDtoSchema } } } },
  responses: { 200: jsonResponse("Photo enregistrée, fiche à jour", LicencieDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "delete",
  path: "/v1/clubs/{clubId}/licencies/{licencieId}/photo",
  security: bearerAuth,
  request: { params: clubAndLicencieParams },
  responses: { 200: jsonResponse("Photo retirée", LicencieDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/licencies",
  security: bearerAuth,
  // Ajout manuel (ex. coach non licencié dans ce club), club_admin uniquement.
  request: { params: clubIdParam, body: { content: { "application/json": { schema: CreateLicencieDtoSchema } } } },
  responses: { 201: jsonResponse("Licencié créé", LicencieDtoSchema), ...errorResponses, ...validationResponses, 409: jsonResponse("Numéro de licence déjà utilisé (LICENSE_NUMBER_TAKEN)", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/licencies/import",
  security: bearerAuth,
  // Import en masse depuis un export FBI, club_admin uniquement — voir la
  // doc de la route (routes.ts) pour le dédoublonnage par ffbbLicenceId.
  request: { params: clubIdParam, body: { content: { "application/json": { schema: ImportLicenciesDtoSchema } } } },
  responses: { 200: jsonResponse("Import terminé (total/inserted/skipped)", ImportLicenciesResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/licencies/import/file",
  security: bearerAuth,
  // club_admin : fichier Excel FBI « Rechercher une licence » (filtre Validé) déposé tel quel (multipart, champ `file`). Jamais stocké.
  request: {
    params: clubIdParam,
    body: { content: { "multipart/form-data": { schema: z.object({ file: z.any().openapi({ type: "string", format: "binary" }) }) } } },
  },
  responses: { 200: jsonResponse("Licenciés mis à jour (compteurs)", LicenceSyncResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/licencies/import/fbi",
  security: bearerAuth,
  // club_admin : demande une mise à jour depuis FBI maintenant (job `import_licences`, aussi lancé chaque jour).
  request: { params: clubIdParam },
  responses: {
    202: jsonResponse("Mise à jour demandée", z.object({ jobId: z.string().nullable(), alreadyQueued: z.boolean() })),
    409: jsonResponse("Identifiants FBI non enregistrés (FBI_NOT_CONFIGURED)", ErrorEnvelopeSchema),
    ...errorResponses,
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/licencies/import/status",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Dernière mise à jour des licenciés et demande FBI en cours", LicenceImportStatusDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/licencies/auto-assign-teams",
  security: bearerAuth,
  // Répartition automatique best-effort des licenciés sans équipe,
  // club_admin uniquement — voir auto-assign-teams.ts pour l'algorithme.
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Répartition terminée (total/assigned/skipped)", AutoAssignTeamsResultDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "delete",
  path: "/v1/clubs/{clubId}/licencies/{licencieId}",
  security: bearerAuth,
  // Suppression définitive, club_admin uniquement — voir la doc de
  // DeleteLicencieResultDtoSchema (sûre sans condition, jamais de perte
  // d'historique de match).
  request: { params: clubAndLicencieParams },
  responses: { 200: jsonResponse("Licencié supprimé", DeleteLicencieResultDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/issues",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Anomalies e-Marque à vérifier", z.object({ issues: z.array(IssueDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/issues/{matchId}/resolve",
  security: bearerAuth,
  request: { params: clubAndMatchIssueParams },
  responses: { 200: jsonResponse("Anomalie résolue", z.object({ resolved: z.literal(true) })), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/jobs/{jobId}",
  security: bearerAuth,
  request: { params: clubAndJobParams },
  responses: { 200: jsonResponse("Statut du job", JobStatusDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/platform/clubs",
  security: bearerAuth,
  responses: { 200: jsonResponse("Clubs de la plateforme (platform_admin)", z.object({ clubs: z.array(PlatformClubDtoSchema) })), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform/clubs",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: CreateClubDtoSchema } } } },
  responses: { 201: jsonResponse("Club créé", z.object({ clubId: z.string().uuid(), slug: z.string(), adminInviteError: z.string().nullable() })), ...errorResponses },
});

const platformClubIdParams = z.object({ clubId: z.string().uuid() });

registry.registerPath({
  method: "get",
  path: "/v1/platform/clubs/{clubId}/members",
  security: bearerAuth,
  request: { params: platformClubIdParams },
  responses: { 200: jsonResponse("Membres et rôles du club (platform_admin)", PlatformClubMembersDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform/clubs/{clubId}/admins",
  security: bearerAuth,
  request: { params: platformClubIdParams, body: { content: { "application/json": { schema: GrantClubAdminDtoSchema } } } },
  responses: { 201: jsonResponse("Administrateur nommé (compte invité s'il n'existait pas)", PlatformClubMembersDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "delete",
  path: "/v1/platform/clubs/{clubId}/admins/{membershipId}",
  security: bearerAuth,
  request: { params: z.object({ clubId: z.string().uuid(), membershipId: z.string().uuid() }) },
  responses: { 200: jsonResponse("Rôle administrateur retiré (jamais le dernier)", PlatformClubMembersDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform/maintenance/purge-emarque-documents",
  security: bearerAuth,
  // Retour du club, 2026-09-29 : purge RÉTROACTIVE de tout document e-Marque encore présent en Storage — les nouveaux sont déjà purgés automatiquement après parsing.
  responses: { 200: jsonResponse("Purge terminée (idempotente, jamais destructive pour les stats déjà en base)", PurgeEmarqueDocumentsResultDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform/maintenance/delete-old-seasons",
  security: bearerAuth,
  // IRRÉVERSIBLE — retour du club, 2026-09-29 : "focus saison 2026-2027". `clubId` obligatoire, jamais un défaut "tous les clubs".
  request: { body: { content: { "application/json": { schema: DeleteOldSeasonsDtoSchema } } } },
  responses: { 200: jsonResponse("Matchs des saisons précédentes supprimés (cascade FK sur toutes les données liées)", DeleteOldSeasonsResultDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/platform/maintenance/retry-failed-emarque-imports",
  security: bearerAuth,
  // Retour du club, 2026-09-29 : relance les matchs `error` en réutilisant le fichier déjà téléchargé — jamais `needs_review` (fichier déjà purgé sur le chemin de succès).
  responses: { 200: jsonResponse("Nouvelle tentative terminée (réutilise le fichier déjà en Storage, jamais un nouveau téléchargement FBI)", RetryFailedEmarqueImportsResultDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/health",
  responses: { 200: jsonResponse("État du service", z.object({ status: z.literal("ok") })) },
});

/**
 * DEMANDES DE DÉROGATION INTERNES (coach → coordinateur) — retour du club,
 * 2026-10-01. Aucune de ces routes n'écrit sur FFBB/FBI ni ne modifie un
 * match : workflow interne (demande + statut + conversation).
 */
const DeletedDerogationRequestDtoSchema = z.object({ deleted: z.literal(true), id: z.string().uuid() }).openapi("DeletedDerogationRequestDto");
const clubAndRequestParams = clubIdParam.extend({ requestId: z.string().uuid() });
const unprocessable = { 422: jsonResponse("Règle métier non respectée (ex. MESSAGE_REQUIRED)", ErrorEnvelopeSchema) };

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/derogation-requests/context",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Demandeur, coordinateur configuré, gymnases, matchs éligibles", DerogationContextDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/derogation-requests",
  security: bearerAuth,
  request: { params: clubIdParam, query: DerogationRequestListQueryDtoSchema },
  responses: { 200: jsonResponse("Inbox coordinateur / demandes du coach", DerogationRequestListDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogation-requests",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: CreateDerogationRequestDtoSchema } } } },
  responses: {
    201: jsonResponse("Demande créée (créneau revalidé côté serveur)", DerogationRequestDetailDtoSchema),
    ...errorResponses,
    400: jsonResponse("Requête invalide, créneau hors plage/passé, gymnase requis", ErrorEnvelopeSchema),
    409: jsonResponse("DEROGATION_SLOT_CONFLICT (avec details.conflicts), NO_COORDINATOR, DEROGATION_REQUEST_ALREADY_ACTIVE, MATCH_NOT_UPCOMING", ErrorEnvelopeSchema),
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}",
  security: bearerAuth,
  request: { params: clubAndRequestParams },
  responses: { 200: jsonResponse("Demande, match, propositions, conversation, permissions", DerogationRequestDetailDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}/messages",
  security: bearerAuth,
  request: { params: clubAndRequestParams, body: { content: { "application/json": { schema: PostDerogationMessageDtoSchema } } } },
  responses: { 200: jsonResponse("Message ajouté (demande à jour)", DerogationRequestDetailDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}/actions",
  security: bearerAuth,
  request: { params: clubAndRequestParams, body: { content: { "application/json": { schema: DerogationActionDtoSchema } } } },
  responses: { 200: jsonResponse("Statut mis à jour + événement système", DerogationRequestDetailDtoSchema), ...errorResponses, ...validationResponses, ...unprocessable },
});

registry.registerPath({
  method: "delete",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}",
  security: bearerAuth,
  // Coordinateur / administrateur : supprime une demande TERMINÉE ou ANNULÉE (messages inclus). Jamais la dérogation FBI.
  request: { params: clubAndRequestParams },
  responses: { 200: jsonResponse("Demande supprimée", DeletedDerogationRequestDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}/proposals",
  security: bearerAuth,
  request: { params: clubAndRequestParams, body: { content: { "application/json": { schema: ProposeDerogationSlotDtoSchema } } } },
  responses: { 200: jsonResponse("Nouveau créneau proposé (historique conservé)", DerogationRequestDetailDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation-availability",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams, query: DerogationAvailabilityQueryDtoSchema },
  responses: { 200: jsonResponse("Occupation des gymnases + créneaux candidats (match cible exclu)", DerogationAvailabilityDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/matches/{matchId}/derogation-slot-check",
  security: bearerAuth,
  request: { params: clubAndMatchIdParams, query: DerogationSlotCheckQueryDtoSchema },
  responses: { 200: jsonResponse("Vérification serveur d'une heure personnalisée", DerogationSlotCheckDtoSchema), ...errorResponses, ...validationResponses },
});

/**
 * Identité de l'espace public (src/modules/public/credential.ts) : lien
 * personnel en `?token=` (web historique) OU en-tête `X-Personal-Link-Token`
 * OU session d'appareil (`Authorization: Bearer bmd_…` + `X-BM-As`, apps
 * mobiles). Le paramètre est donc FACULTATIF dans le contrat.
 */
const personalTokenQuery = z.object({
  token: z.string().min(1).optional().openapi({ description: "Lien personnel (web). Facultatif avec l'en-tête X-Personal-Link-Token ou une session d'appareil (Authorization: Bearer bmd_… + X-BM-As)." }),
});

/**
 * Mêmes demandes depuis l'ESPACE PUBLIC sans compte : licencié reconnu par
 * son lien personnel (`?token=` sur chaque requête), rôles posés depuis
 * /joueurs (`public_coach`, `public_coordinator`, `public_admin`).
 */
const publicTokenQuery = personalTokenQuery;
const publicDerogationErrors = {
  400: jsonResponse("Requête invalide / lien manquant", ErrorEnvelopeSchema),
  401: jsonResponse("Lien personnel invalide ou révoqué", ErrorEnvelopeSchema),
  403: jsonResponse("Licencié sans rôle coach/coordinateur (DEROGATION_ROLE_REQUIRED) ou action non autorisée", ErrorEnvelopeSchema),
  404: jsonResponse("Introuvable", ErrorEnvelopeSchema),
};
const publicRequestParams = clubSlugParam.extend({ requestId: z.string().uuid() });

registry.registerPath({ method: "get", path: "/v1/public/clubs/{clubSlug}/derogation-requests/context", request: { params: clubSlugParam, query: publicTokenQuery }, responses: { 200: jsonResponse("Contexte (espace public)", DerogationContextDtoSchema), ...publicDerogationErrors } });
registry.registerPath({ method: "get", path: "/v1/public/clubs/{clubSlug}/derogation-requests", request: { params: clubSlugParam, query: DerogationRequestListQueryDtoSchema.merge(publicTokenQuery) }, responses: { 200: jsonResponse("Demandes visibles (espace public)", DerogationRequestListDtoSchema), ...publicDerogationErrors } });
registry.registerPath({ method: "post", path: "/v1/public/clubs/{clubSlug}/derogation-requests", request: { params: clubSlugParam, query: publicTokenQuery, body: { content: { "application/json": { schema: CreateDerogationRequestDtoSchema } } } }, responses: { 201: jsonResponse("Demande créée (espace public)", DerogationRequestDetailDtoSchema), ...publicDerogationErrors, 409: jsonResponse("Conflit de créneau, demande déjà active, aucun coordinateur", ErrorEnvelopeSchema) } });
registry.registerPath({ method: "get", path: "/v1/public/clubs/{clubSlug}/derogation-requests/availability", request: { params: clubSlugParam, query: DerogationAvailabilityQueryDtoSchema.merge(publicTokenQuery).extend({ matchId: z.string().uuid() }) }, responses: { 200: jsonResponse("Occupation des gymnases (espace public)", DerogationAvailabilityDtoSchema), ...publicDerogationErrors } });
registry.registerPath({ method: "get", path: "/v1/public/clubs/{clubSlug}/derogation-requests/slot-check", request: { params: clubSlugParam, query: DerogationSlotCheckQueryDtoSchema.merge(publicTokenQuery).extend({ matchId: z.string().uuid() }) }, responses: { 200: jsonResponse("Vérification d'une heure (espace public)", DerogationSlotCheckDtoSchema), ...publicDerogationErrors } });
registry.registerPath({ method: "get", path: "/v1/public/clubs/{clubSlug}/derogation-requests/{requestId}", request: { params: publicRequestParams, query: publicTokenQuery }, responses: { 200: jsonResponse("Demande + conversation (espace public)", DerogationRequestDetailDtoSchema), ...publicDerogationErrors } });
registry.registerPath({ method: "post", path: "/v1/public/clubs/{clubSlug}/derogation-requests/{requestId}/messages", request: { params: publicRequestParams, query: publicTokenQuery, body: { content: { "application/json": { schema: PostDerogationMessageDtoSchema } } } }, responses: { 200: jsonResponse("Message ajouté", DerogationRequestDetailDtoSchema), ...publicDerogationErrors } });
registry.registerPath({ method: "post", path: "/v1/public/clubs/{clubSlug}/derogation-requests/{requestId}/actions", request: { params: publicRequestParams, query: publicTokenQuery, body: { content: { "application/json": { schema: DerogationActionDtoSchema } } } }, responses: { 200: jsonResponse("Statut mis à jour", DerogationRequestDetailDtoSchema), ...publicDerogationErrors, ...unprocessable } });
registry.registerPath({ method: "delete", path: "/v1/public/clubs/{clubSlug}/derogation-requests/{requestId}", request: { params: publicRequestParams, query: publicTokenQuery }, responses: { 200: jsonResponse("Demande supprimée (espace public)", DeletedDerogationRequestDtoSchema), ...publicDerogationErrors } });
registry.registerPath({ method: "post", path: "/v1/public/clubs/{clubSlug}/derogation-requests/{requestId}/proposals", request: { params: publicRequestParams, query: publicTokenQuery, body: { content: { "application/json": { schema: ProposeDerogationSlotDtoSchema } } } }, responses: { 200: jsonResponse("Nouveau créneau proposé", DerogationRequestDetailDtoSchema), ...publicDerogationErrors } });

registry.registerPath({
  method: "get",
  path: "/v1/public/clubs/{clubSlug}/home",
  // Accueil personnel (lien personnel) : équipes jouées/coachées, agenda, résultats, tables de marque.
  request: { params: clubSlugParam, query: personalTokenQuery },
  responses: { 200: jsonResponse("Accueil personnel", PublicHomeDtoSchema), 400: jsonResponse("Lien manquant", ErrorEnvelopeSchema), 401: jsonResponse("Lien invalide ou révoqué", ErrorEnvelopeSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/derogation-requests/{requestId}/official",
  security: bearerAuth,
  // Coordinateur, demande « En cours » : crée la dérogation OFFICIELLE sur FBI (même process que .../matches/:id/derogation/create).
  request: { params: clubAndRequestParams, body: { content: { "application/json": { schema: CreateDerogationDtoSchema } } } },
  responses: { 200: jsonResponse("Résultat FBI réel + demande à jour", SubmitOfficialDerogationResultDtoSchema), ...errorResponses, ...validationResponses },
});
registry.registerPath({
  method: "post",
  path: "/v1/public/clubs/{clubSlug}/derogation-requests/{requestId}/official",
  request: { params: publicRequestParams, query: publicTokenQuery, body: { content: { "application/json": { schema: CreateDerogationDtoSchema } } } },
  responses: { 200: jsonResponse("Résultat FBI réel + demande à jour", SubmitOfficialDerogationResultDtoSchema), ...publicDerogationErrors },
});

/** Membres & rôles (club_admin) — désignation des coachs et du coordinateur. */
const clubAndMembershipParams = clubIdParam.extend({ membershipId: z.string().uuid() });

registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/members",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Membres du club et leurs rôles", ClubMemberListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "post",
  path: "/v1/clubs/{clubId}/members",
  security: bearerAuth,
  request: { params: clubIdParam, body: { content: { "application/json": { schema: InviteMemberDtoSchema } } } },
  responses: { 201: jsonResponse("Membre invité/rattaché", ClubMemberListDtoSchema), ...errorResponses, ...validationResponses },
});

registry.registerPath({
  method: "put",
  path: "/v1/clubs/{clubId}/members/{membershipId}/roles",
  security: bearerAuth,
  request: { params: clubAndMembershipParams, body: { content: { "application/json": { schema: SetMemberRolesDtoSchema } } } },
  responses: { 200: jsonResponse("Rôles remplacés", ClubMemberListDtoSchema), ...errorResponses, ...validationResponses },
});

/** Gymnases du club (planning des demandes de dérogation). */
registry.registerPath({
  method: "get",
  path: "/v1/clubs/{clubId}/venues",
  security: bearerAuth,
  request: { params: clubIdParam },
  responses: { 200: jsonResponse("Gymnases du club", ClubVenueListDtoSchema), ...errorResponses },
});

registry.registerPath({
  method: "patch",
  path: "/v1/clubs/{clubId}/venues/{venueId}",
  security: bearerAuth,
  request: { params: clubIdParam.extend({ venueId: z.string().uuid() }), body: { content: { "application/json": { schema: UpdateClubVenueDtoSchema } } } },
  responses: { 200: jsonResponse("Gymnase mis à jour", z.object({ venue: ClubVenueAdminDtoSchema })), ...errorResponses, ...validationResponses },
});


/**
 * Vie d'équipe — entraînements (Lot 1, voir docs/TEAM_LIFE.md). Espace
 * club (comptes) sous /clubs/{clubId}/team-life, espace public (lien
 * personnel) sous /public/clubs/{clubSlug}/team-life.
 */
const teamIdParams = clubIdParam.extend({ teamId: z.string().uuid() });
const seriesParams = clubIdParam.extend({ seriesId: z.string().uuid() });
const occurrenceParams = clubIdParam.extend({ occurrenceId: z.string().uuid() });
const rangeQuery = z.object({ from: z.string().optional(), to: z.string().optional(), teamId: z.string().uuid().optional(), kind: z.enum(["MATCH", "TRAINING"]).optional() });
const pubToken = personalTokenQuery;
const pubTeamParams = clubSlugParam.extend({ teamId: z.string().uuid() });
const pubSeriesParams = clubSlugParam.extend({ seriesId: z.string().uuid() });
const pubOccurrenceParams = clubSlugParam.extend({ occurrenceId: z.string().uuid() });
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } } });

for (const space of ["club", "public"] as const) {
  const base = space === "club" ? "/v1/clubs/{clubId}/team-life" : "/v1/public/clubs/{clubSlug}/team-life";
  const security = space === "club" ? bearerAuth : undefined;
  const auth = space === "club" ? {} : { query: pubToken };
  const P = <A, B>(clubParams: A, publicParams: B) => (space === "club" ? clubParams : publicParams);
  registry.registerPath({ method: "get", path: `${base}/teams/{teamId}/training-series`, security, request: { params: P(teamIdParams, pubTeamParams), ...auth }, responses: { 200: jsonResponse("Créneaux d'entraînement en cours de l'équipe", TrainingSeriesListDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "post", path: `${base}/teams/{teamId}/training-series`, security, request: { params: P(teamIdParams, pubTeamParams), ...auth, body: jsonBody(CreateTrainingSeriesDtoSchema) }, responses: { 201: jsonResponse("Créneaux créés, séances générées", TrainingSeriesListDtoSchema), ...errorResponses, ...validationResponses } });
  registry.registerPath({ method: "patch", path: `${base}/training-series/{seriesId}`, security, request: { params: P(seriesParams, pubSeriesParams), ...auth, body: jsonBody(UpdateTrainingSeriesDtoSchema) }, responses: { 200: jsonResponse("Créneau modifié à partir d'une date (passé inchangé)", TrainingSeriesListDtoSchema), ...errorResponses, ...validationResponses } });
  registry.registerPath({ method: "delete", path: `${base}/training-series/{seriesId}`, security, request: { params: P(seriesParams, pubSeriesParams), query: space === "club" ? z.object({ from: z.string().optional() }) : pubToken.extend({ from: z.string().optional() }) }, responses: { 200: jsonResponse("Créneau arrêté à partir d'une date (séances avec réponses annulées)", TrainingSeriesListDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "get", path: `${base}/trainings/{occurrenceId}`, security, request: { params: P(occurrenceParams, pubOccurrenceParams), ...auth }, responses: { 200: jsonResponse("Séance + réponses nominatives (coach / admin)", TrainingOccurrenceDetailDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "patch", path: `${base}/trainings/{occurrenceId}`, security, request: { params: P(occurrenceParams, pubOccurrenceParams), ...auth, body: jsonBody(UpdateTrainingOccurrenceDtoSchema) }, responses: { 200: jsonResponse("Séance modifiée (cette séance uniquement)", TrainingOccurrenceDtoSchema), ...errorResponses, ...validationResponses } });
  registry.registerPath({ method: "post", path: `${base}/trainings/{occurrenceId}/cancel`, security, request: { params: P(occurrenceParams, pubOccurrenceParams), ...auth, body: jsonBody(CancelTrainingOccurrenceDtoSchema) }, responses: { 200: jsonResponse("Séance annulée (reste visible)", TrainingOccurrenceDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "post", path: `${base}/trainings/{occurrenceId}/restore`, security, request: { params: P(occurrenceParams, pubOccurrenceParams), ...auth }, responses: { 200: jsonResponse("Séance rétablie", TrainingOccurrenceDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "put", path: `${base}/trainings/{occurrenceId}/attendance/{licencieId}`, security, request: { params: (space === "club" ? occurrenceParams : pubOccurrenceParams).extend({ licencieId: z.string().uuid() }), ...auth, body: jsonBody(PutTrainingAttendanceDtoSchema) }, responses: { 200: jsonResponse("Présence réelle relevée (présent / retard / absent)", z.object({ occurrenceId: z.string(), licencieId: z.string(), status: z.string() })), ...errorResponses, ...validationResponses } });
}

// Lot 2 : disponibilités et convocation d'un match (coach / admin), dans les deux espaces.
const tlMatchParams = clubIdParam.extend({ matchId: z.string().uuid() });
const pubTlMatchParams = clubSlugParam.extend({ matchId: z.string().uuid() });
for (const space of ["club", "public"] as const) {
  const base = space === "club" ? "/v1/clubs/{clubId}/team-life" : "/v1/public/clubs/{clubSlug}/team-life";
  const security = space === "club" ? bearerAuth : undefined;
  const auth = space === "club" ? {} : { query: pubToken };
  const params = space === "club" ? tlMatchParams : pubTlMatchParams;
  registry.registerPath({ method: "get", path: `${base}/matches/{matchId}`, security, request: { params, ...auth }, responses: { 200: jsonResponse("Disponibilités et convocation du match (coach / admin)", MatchTeamLifeDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "post", path: `${base}/matches/{matchId}/availability/open`, security, request: { params, ...auth }, responses: { 200: jsonResponse("Disponibilités demandées (aucune convocation créée)", MatchTeamLifeDtoSchema), ...errorResponses, ...validationResponses } });
  registry.registerPath({ method: "post", path: `${base}/matches/{matchId}/remind`, security, request: { params, ...auth }, responses: { 200: jsonResponse("Relance des sans réponse (affichée sur la Home des familles concernées)", MatchTeamLifeDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "put", path: `${base}/matches/{matchId}/convocation/draft`, security, request: { params, ...auth, body: jsonBody(PutConvocationDraftDtoSchema) }, responses: { 200: jsonResponse("Brouillon enregistré (jamais visible des familles)", MatchTeamLifeDtoSchema), ...errorResponses, ...validationResponses } });
  registry.registerPath({ method: "post", path: `${base}/matches/{matchId}/convocation/preview`, security, request: { params, ...auth }, responses: { 200: jsonResponse("Aperçu : ce que recevront un parent et un joueur", ConvocationPreviewDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "post", path: `${base}/matches/{matchId}/convocation/send`, security, request: { params, ...auth }, responses: { 200: jsonResponse("Convocation envoyée (ou mise à jour envoyée)", MatchTeamLifeDtoSchema), ...errorResponses, ...validationResponses } });
}
// App iOS : sessions d'appareil et codes d'autorisation PKCE (docs/MOBILE_AUTH.md).
{
  const base = "/v1/public/clubs/{clubSlug}/auth";
  const deviceBearer = [{ BearerAuth: [] }];
  registry.registerPath({ method: "get", path: "/v1/public/clubs", responses: { 200: jsonResponse("Clubs actifs (nom, slug, logo) — choix du club dans l'app", PublicClubListDtoSchema) } });
  registry.registerPath({ method: "post", path: `${base}/device-sessions`, request: { params: clubSlugParam, body: jsonBody(CreateDeviceSessionDtoSchema) }, responses: { 201: jsonResponse("Session d'appareil (secret affiché une seule fois)", DeviceSessionDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "get", path: `${base}/session`, security: deviceBearer, request: { params: clubSlugParam }, responses: { 200: jsonResponse("Personnes de la session d'appareil", SessionInfoDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "delete", path: `${base}/session`, security: deviceBearer, request: { params: clubSlugParam }, responses: { 204: { description: "Session révoquée" }, ...errorResponses } });
  registry.registerPath({ method: "post", path: `${base}/session/people`, security: deviceBearer, request: { params: clubSlugParam, body: jsonBody(AddSessionPeopleDtoSchema) }, responses: { 200: jsonResponse("Personne ajoutée à l'appareil", SessionInfoDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "delete", path: `${base}/session/people/{licencieId}`, security: deviceBearer, request: { params: clubSlugParam.extend({ licencieId: z.string().uuid() }) }, responses: { 204: { description: "Personne retirée de l'appareil" }, ...errorResponses } });
  registry.registerPath({ method: "put", path: `${base}/session/push-token`, security: deviceBearer, request: { params: clubSlugParam, body: jsonBody(PutPushTokenDtoSchema) }, responses: { 204: { description: "Jeton APNs enregistré pour cette session" }, ...errorResponses, ...validationResponses } });
  registry.registerPath({ method: "delete", path: `${base}/session/push-token`, security: deviceBearer, request: { params: clubSlugParam }, responses: { 204: { description: "Plus de notifications de ce club sur cet appareil" }, ...errorResponses } });
  registry.registerPath({ method: "post", path: `${base}/codes`, request: { params: clubSlugParam, body: jsonBody(CreateAuthCodeDtoSchema) }, responses: { 201: jsonResponse("Code d'autorisation (5 min, usage unique, lié au PKCE)", AuthCodeDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "post", path: `${base}/token`, request: { params: clubSlugParam, body: jsonBody(ExchangeAuthCodeDtoSchema) }, responses: { 201: jsonResponse("Session d'appareil (ios)", DeviceSessionDtoSchema), 200: jsonResponse("Liens personnels pour la session web (web, lien de connexion)", WebExchangeDtoSchema), ...errorResponses } });
}
// Lot 4 : page Équipe.
registry.registerPath({ method: "get", path: "/v1/clubs/{clubId}/team-life/teams/{teamId}/overview", security: bearerAuth, request: { params: teamIdParams }, responses: { 200: jsonResponse("Vue d'ensemble de l'équipe (prochain match, entraînement, effectif)", TeamOverviewDtoSchema), ...errorResponses } });
registry.registerPath({ method: "get", path: "/v1/public/clubs/{clubSlug}/team-life/teams/{teamId}/overview", request: { params: pubTeamParams, query: pubToken }, responses: { 200: jsonResponse("Vue d'ensemble (joueurs de l'équipe, coach / admin)", TeamOverviewDtoSchema), ...errorResponses } });
// Lot 3 : lavage des maillots.
for (const space of ["club", "public"] as const) {
  const base = space === "club" ? "/v1/clubs/{clubId}/team-life" : "/v1/public/clubs/{clubSlug}/team-life";
  const security = space === "club" ? bearerAuth : undefined;
  const auth = space === "club" ? {} : { query: pubToken };
  const params = space === "club" ? tlMatchParams : pubTlMatchParams;
  registry.registerPath({ method: "get", path: `${base}/matches/{matchId}/laundry/suggestions`, security, request: { params, ...auth }, responses: { 200: jsonResponse("Suggestions (lecture seule, aucune affectation créée)", LaundrySuggestionsDtoSchema), ...errorResponses } });
  registry.registerPath({ method: "put", path: `${base}/matches/{matchId}/laundry`, security, request: { params, ...auth, body: jsonBody(PutLaundryDtoSchema) }, responses: { 200: jsonResponse("Lavage attribué par le coach", LaundryDtoSchema), ...errorResponses, ...validationResponses } });
  registry.registerPath({ method: "delete", path: `${base}/matches/{matchId}/laundry`, security, request: { params, ...auth }, responses: { 200: jsonResponse("Affectation retirée", LaundryDtoSchema), ...errorResponses } });
}
registry.registerPath({ method: "post", path: "/v1/public/clubs/{clubSlug}/team-life/matches/{matchId}/laundry/seen", request: { params: pubTlMatchParams, query: pubToken }, responses: { 200: jsonResponse("« J'ai vu » (licencié désigné)", z.object({ matchId: z.string(), seenAt: z.string() })), ...errorResponses } });
registry.registerPath({ method: "put", path: "/v1/public/clubs/{clubSlug}/team-life/matches/{matchId}/availability/response", request: { params: pubTlMatchParams, query: pubToken, body: jsonBody(PutAvailabilityResponseDtoSchema) }, responses: { 200: jsonResponse("Disponibilité du licencié du lien", AvailabilityResponseResultDtoSchema), ...errorResponses, ...validationResponses } });
registry.registerPath({ method: "put", path: "/v1/public/clubs/{clubSlug}/team-life/matches/{matchId}/convocation/response", request: { params: pubTlMatchParams, query: pubToken, body: jsonBody(PutConvocationResponseDtoSchema) }, responses: { 200: jsonResponse("Confirmation / refus du convoqué du lien", ConvocationResponseResultDtoSchema), ...errorResponses, ...validationResponses } });

registry.registerPath({ method: "get", path: "/v1/clubs/{clubId}/team-life/trainings", security: bearerAuth, request: { params: clubIdParam, query: rangeQuery.omit({ kind: true }) }, responses: { 200: jsonResponse("Séances de la période (compteurs pour qui gère l'équipe)", TrainingOccurrenceListDtoSchema), ...errorResponses, ...validationResponses } });
registry.registerPath({ method: "get", path: "/v1/clubs/{clubId}/team-life/planning", security: bearerAuth, request: { params: clubIdParam, query: rangeQuery }, responses: { 200: jsonResponse("Planning : matchs FFBB + entraînements", PlanningDtoSchema), ...errorResponses, ...validationResponses } });
registry.registerPath({ method: "get", path: "/v1/public/clubs/{clubSlug}/team-life/teams/{teamId}/trainings", request: { params: pubTeamParams, query: pubToken.extend({ from: z.string().optional(), to: z.string().optional() }) }, responses: { 200: jsonResponse("Séances d'une équipe gérée par le lien (compteurs de réponses)", TrainingOccurrenceListDtoSchema), ...errorResponses, ...validationResponses } });
registry.registerPath({ method: "put", path: "/v1/public/clubs/{clubSlug}/team-life/trainings/{occurrenceId}/response", request: { params: pubOccurrenceParams, query: pubToken, body: jsonBody(PutTrainingResponseDtoSchema) }, responses: { 200: jsonResponse("Réponse enregistrée pour le licencié du lien", TrainingResponseResultDtoSchema), 403: jsonResponse("Pas dans cette équipe (NOT_IN_TEAM)", ErrorEnvelopeSchema), 409: jsonResponse("Séance annulée ou terminée", ErrorEnvelopeSchema), 401: jsonResponse("Lien invalide", ErrorEnvelopeSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) } });
registry.registerPath({ method: "post", path: "/v1/public/clubs/{clubSlug}/team-life/action-center", request: { params: clubSlugParam, body: jsonBody(ActionCenterRequestDtoSchema) }, responses: { 200: jsonResponse("Home « À faire » (liens de l'appareil fusionnés)", ActionCenterDtoSchema), 400: jsonResponse("Requête invalide", ErrorEnvelopeSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) } });
registry.registerPath({ method: "post", path: "/v1/public/clubs/{clubSlug}/team-life/planning", request: { params: clubSlugParam, query: z.object({ from: z.string().optional(), to: z.string().optional() }), body: jsonBody(ActionCenterRequestDtoSchema) }, responses: { 200: jsonResponse("Planning des équipes de l'appareil", PlanningDtoSchema), 400: jsonResponse("Requête invalide", ErrorEnvelopeSchema), 404: jsonResponse("Introuvable", ErrorEnvelopeSchema) } });

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "ball-manager-back",
      version: "0.2.0",
      description: "Backend REST du SaaS multi-clubs (FFBB/FBI/e-Marque). Voir docs/API.md.",
    },
    servers: [{ url: "/", description: "Ce déploiement" }],
  });
}
