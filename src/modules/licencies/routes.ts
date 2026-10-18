import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership } from "../../auth/middleware.js";
import { createServiceSupabaseClient, type DbClient } from "../../db/client.js";
import { badRequest, conflict, forbidden, notFound } from "../../api-error.js";
import { isClubAdmin } from "../../tenancy/roles.js";
import {
  CreateLicencieDtoSchema,
  UpdateLicencieProfileDtoSchema,
  ImportLicenciesDtoSchema,
  type LicencieDto,
  type LicencieMatchDto,
  type LicencieProfileDto,
  type LicenciesListDto,
  type ImportLicenciesResultDto,
  type AutoAssignTeamsResultDto,
  type DeleteLicencieResultDto,
  type LicenceImportStatusDto,
  type LicenceSyncResultDto,
} from "../../contracts/licencies.js";
import { LicenceExportError, MAX_EXPORT_BYTES, parseFbiLicenceExport } from "./fbi-licence-export.js";
import { recordLicenceImportRun, syncLicenciesFromFbi } from "./sync-from-fbi.js";
import { rejectedFieldsFor, resolveLicencieEditPermission } from "./profile-fields.js";
import { requireClubRole } from "../../auth/middleware.js";
import { autoAssignTeamsForClub } from "./auto-assign-teams.js";
import { LICENCIE_PHOTO_TYPES, MAX_LICENCIE_PHOTO_BYTES, removeStoredLicenciePhoto, storedPhotoPath, uploadLicenciePhoto, type LicenciePhotoType } from "../../storage/licencie-photos.js";
import { logError } from "../../logger.js";

export const licenciesRouter = new Hono<AppEnv>();

licenciesRouter.use("*", requireAuth);
licenciesRouter.use("*", requireClubMembership);

const LICENCIE_COLUMNS = "id, club_id, first_name, last_name, license_number, birth_date, email, phone, photo_url, team_id, active, ffbb_licence_id, category_label, sexe, public_admin, public_coach, public_coordinator, coached_team_ids";

interface LicencieRow {
  id: string;
  club_id: string;
  first_name: string;
  last_name: string;
  license_number: string | null;
  birth_date: string | null;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
  team_id: string | null;
  active: boolean;
  ffbb_licence_id: string | null;
  category_label: string | null;
  sexe: "M" | "F" | null;
  public_admin: boolean;
  public_coach: boolean;
  public_coordinator: boolean;
  coached_team_ids: string[] | null;
}

/** Équipes coachées : dédoublonnées, toutes du MÊME club (sinon 400). */
async function validateClubTeamIds(db: DbClient, clubId: string, teamIds: readonly string[]): Promise<string[]> {
  const unique = [...new Set(teamIds)];
  if (unique.length === 0) return [];
  const { data } = await db.from("teams").select("id").eq("club_id", clubId).in("id", unique);
  if ((data ?? []).length !== unique.length) throw badRequest("Une des équipes coachées n'appartient pas à ce club.");
  return unique;
}

function mapLicencieRow(row: LicencieRow): LicencieDto {
  return {
    id: row.id,
    clubId: row.club_id,
    firstName: row.first_name,
    lastName: row.last_name,
    licenseNumber: row.license_number,
    birthDate: row.birth_date,
    email: row.email,
    phone: row.phone,
    photoUrl: row.photo_url,
    teamId: row.team_id,
    active: row.active,
    ffbbLicenceId: row.ffbb_licence_id,
    categoryLabel: row.category_label,
    sexe: row.sexe,
    publicAdmin: row.public_admin === true,
    publicCoach: row.public_coach === true,
    publicCoordinator: row.public_coordinator === true,
    coachedTeamIds: row.coached_team_ids ?? [],
  };
}

/**
 * `club_memberships.licencie_id` de L'APPELANT COURANT sur CE club — jamais
 * `profiles.licencie_id` (devenu obsolète depuis le passage multi-tenant, le
 * rattachement est désormais PAR CLUB, voir supabase/migrations/
 * 20260921100020_club_memberships.sql). `null` si l'appelant n'est
 * rattaché à aucun licencié (compte admin/coach sans fiche joueur propre).
 */
async function getOwnLicencieId(supabase: DbClient, clubId: string, userId: string): Promise<string | null> {
  const { data } = await supabase.from("club_memberships").select("licencie_id").eq("club_id", clubId).eq("user_id", userId).eq("status", "active").maybeSingle();
  return data?.licencie_id ?? null;
}

/** GET /v1/clubs/:clubId/licencies — roster du club (tri alphabétique). RLS : tout membre actif du club (voir migration 20260925090000). */
licenciesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const supabase = c.get("supabase");

  const { data, error } = await supabase.from("licencies").select(LICENCIE_COLUMNS).eq("club_id", club.id).order("last_name").order("first_name");

  if (error) throw new Error(`Lecture des licenciés échouée : ${error.message}`);

  const licencies: LicencieDto[] = (data ?? []).map(mapLicencieRow);
  return c.json({ licencies } satisfies LicenciesListDto);
});

/**
 * GET /v1/clubs/:clubId/licencies/:licencieId — la "fiche joueur" (demande
 * du club) : identité + historique des matchs + statistiques par match.
 *
 * Deux requêtes séparées plutôt qu'un double embed PostgREST
 * (`match_participants` → `matches` PUIS `match_participants` → `player_
 * match_stats`) — même philosophie que `modules/matches/routes.ts#GET
 * /:matchId` : un embed enfant→parent (`match_participants.select("...,
 * matches(...)")`) est un pattern déjà éprouvé dans ce backend, jamais un
 * double embed simultané non testé contre le vrai schéma.
 */
licenciesRouter.get("/:licencieId", async (c) => {
  const { club, roles } = c.get("club");
  const user = c.get("user");
  const supabase = c.get("supabase");
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");

  const { data: licencieRow } = await supabase.from("licencies").select(LICENCIE_COLUMNS).eq("id", licencieId).eq("club_id", club.id).maybeSingle();
  if (!licencieRow) throw notFound("Licencié introuvable.");

  const ownLicencieId = await getOwnLicencieId(supabase, club.id, user.id);
  const isSelf = ownLicencieId === licencieId;
  const { canEdit } = resolveLicencieEditPermission(isClubAdmin(roles), isSelf);

  const { data: participantRows } = await supabase
    .from("match_participants")
    .select("id, match_id, jersey_number, is_captain, is_starter, matches(numero, match_datetime, is_home, opponent_name, score_home, score_away, status)")
    .eq("club_id", club.id)
    .eq("licencie_id", licencieId);

  const participantIds = (participantRows ?? []).map((row) => row.id);
  const { data: statsRows } = participantIds.length
    ? await supabase
        .from("player_match_stats")
        .select("participant_id, seconds_played, points, three_points_made, two_points_interior_made, two_points_exterior_made, free_throws_made, fouls_committed")
        .in("participant_id", participantIds)
    : { data: [] as never[] };

  const statsByParticipantId = new Map((statsRows ?? []).map((row) => [row.participant_id, row]));

  const matches: LicencieMatchDto[] = (participantRows ?? [])
    .flatMap((row) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const match = (row as any).matches;
      if (!match) return [];

      const stats = statsByParticipantId.get(row.id);

      return [
        {
          matchId: row.match_id,
          numero: match.numero,
          matchDatetime: match.match_datetime,
          isHome: match.is_home,
          opponentName: match.opponent_name,
          scoreHome: match.score_home,
          scoreAway: match.score_away,
          status: match.status,
          jerseyNumber: row.jersey_number,
          isCaptain: row.is_captain,
          isStarter: row.is_starter,
          stats: stats
            ? {
                secondsPlayed: stats.seconds_played,
                points: stats.points,
                threePointsMade: stats.three_points_made,
                twoPointsInteriorMade: stats.two_points_interior_made,
                twoPointsExteriorMade: stats.two_points_exterior_made,
                freeThrowsMade: stats.free_throws_made,
                foulsCommitted: stats.fouls_committed,
              }
            : null,
        },
      ];
    })
    .sort((a, b) => (b.matchDatetime ?? "").localeCompare(a.matchDatetime ?? ""));

  const dto: LicencieProfileDto = {
    licencie: mapLicencieRow(licencieRow),
    canEdit,
    isSelf,
    matches,
  };

  return c.json(dto);
});

/**
 * PATCH /v1/clubs/:clubId/licencies/:licencieId/profile — demande du club
 * ("agrémenter en admin avec photo, infos persos... ou bien le joueur
 * direct s'il a un compte associé à son profil"). Toujours écrit via le
 * rôle service : la RLS actuelle ("licencies_all_club_admin") ne couvre
 * QUE le club_admin, jamais un licencié éditant SA PROPRE fiche — ajouter
 * une policy RLS self-service distincte par CHAMP serait fragile
 * (PostgreSQL ne compare pas nativement OLD/NEW par colonne dans une
 * policy `WITH CHECK`, voir docs/LICENCIES.md) ; la restriction de champs
 * est donc entièrement appliquée ICI, avant toute écriture, jamais
 * silencieusement — un champ hors de la population autorisée pour cet
 * appelant est REJETÉ (400), jamais ignoré.
 */
licenciesRouter.patch("/:licencieId/profile", async (c) => {
  const { club, roles } = c.get("club");
  const user = c.get("user");
  const supabase = c.get("supabase");
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");

  const body = await c.req.json().catch(() => ({}));
  const parsed = UpdateLicencieProfileDtoSchema.safeParse(body);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((issue) => issue.message).join(" "));

  const ownLicencieId = await getOwnLicencieId(supabase, club.id, user.id);
  const isSelf = ownLicencieId === licencieId;
  const { canEdit, allowedFields } = resolveLicencieEditPermission(isClubAdmin(roles), isSelf);

  if (!canEdit) throw forbidden("Vous ne pouvez pas modifier ce profil.");

  const rejectedFields = rejectedFieldsFor(parsed.data, allowedFields);
  if (rejectedFields.length > 0) {
    throw badRequest(`Champ(s) non autorisé(s) pour cet appelant : ${rejectedFields.join(", ")}.`);
  }

  const serviceSupabase = createServiceSupabaseClient();

  const { data: existing } = await serviceSupabase.from("licencies").select(LICENCIE_COLUMNS).eq("id", licencieId).eq("club_id", club.id).maybeSingle();
  if (!existing) throw notFound("Licencié introuvable.");

  // Une équipe fournie doit appartenir à CE club — sinon un club_admin
  // pourrait (même par erreur) rattacher un licencié à l'équipe d'un AUTRE
  // club, jamais vérifié par la RLS (teams_all_club_admin) qui ne regarde
  // que club_id de la ligne teams écrite, pas d'une référence externe.
  if (parsed.data.teamId) {
    const { data: team } = await serviceSupabase.from("teams").select("id").eq("id", parsed.data.teamId).eq("club_id", club.id).maybeSingle();
    if (!team) throw badRequest("teamId ne correspond à aucune équipe de ce club.");
  }

  const patch: Partial<{
    photo_url: string | null;
    email: string | null;
    phone: string | null;
    first_name: string;
    last_name: string;
    birth_date: string | null;
    license_number: string | null;
    team_id: string | null;
    active: boolean;
    public_admin: boolean;
    public_coach: boolean;
    public_coordinator: boolean;
    coached_team_ids: string[];
  }> = {};
  if (parsed.data.photoUrl !== undefined) patch.photo_url = parsed.data.photoUrl;
  if (parsed.data.email !== undefined) patch.email = parsed.data.email;
  if (parsed.data.phone !== undefined) patch.phone = parsed.data.phone;
  if (parsed.data.firstName !== undefined) patch.first_name = parsed.data.firstName;
  if (parsed.data.lastName !== undefined) patch.last_name = parsed.data.lastName;
  if (parsed.data.birthDate !== undefined) patch.birth_date = parsed.data.birthDate;
  if (parsed.data.licenseNumber !== undefined) patch.license_number = parsed.data.licenseNumber;
  if (parsed.data.teamId !== undefined) patch.team_id = parsed.data.teamId;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  if (parsed.data.publicAdmin !== undefined) patch.public_admin = parsed.data.publicAdmin;
  if (parsed.data.publicCoach !== undefined) patch.public_coach = parsed.data.publicCoach;
  if (parsed.data.publicCoordinator !== undefined) patch.public_coordinator = parsed.data.publicCoordinator;
  if (parsed.data.coachedTeamIds !== undefined) patch.coached_team_ids = await validateClubTeamIds(serviceSupabase, club.id, parsed.data.coachedTeamIds);

  if (Object.keys(patch).length === 0) return c.json(mapLicencieRow(existing));

  const { data, error } = await serviceSupabase.from("licencies").update(patch).eq("id", licencieId).select(LICENCIE_COLUMNS).single();
  if (error) throw new Error(`Mise à jour du profil du licencié échouée : ${error.message}`);

  return c.json(mapLicencieRow(data));
});

/**
 * POST /v1/clubs/:clubId/licencies/:licencieId/photo — photo de la fiche,
 * DÉJÀ compressée par le navigateur (WebP 512 px), envoyée en base64
 * (retour du club, 2026-10-08). Mêmes droits que `photoUrl` du PATCH
 * profil (admin du club, ou le joueur lui-même). Remplace et supprime
 * l'ancienne photo stockée ; une URL externe saisie à la main n'est jamais
 * supprimée du web, seulement remplacée sur la fiche.
 */
licenciesRouter.post("/:licencieId/photo", async (c) => {
  const { club, licencie, serviceSupabase } = await photoEditContext(c);
  const body = (await c.req.json().catch(() => null)) as { contentType?: unknown; data?: unknown } | null;
  const contentType = body?.contentType;
  if (typeof contentType !== "string" || !(contentType in LICENCIE_PHOTO_TYPES)) throw badRequest("Format de photo non pris en charge (WebP, JPEG ou PNG).");
  if (typeof body?.data !== "string" || body.data.length === 0) throw badRequest("Photo manquante.");
  const content = Buffer.from(body.data, "base64");
  if (content.length === 0) throw badRequest("Photo illisible.");
  if (content.length > MAX_LICENCIE_PHOTO_BYTES) throw badRequest("Photo trop lourde (512 Ko maximum après compression).");

  const url = await uploadLicenciePhoto(serviceSupabase, club.id, licencie.id, content, contentType as LicenciePhotoType);
  const { data, error } = await serviceSupabase.from("licencies").update({ photo_url: url }).eq("id", licencie.id).eq("club_id", club.id).select(LICENCIE_COLUMNS).single();
  if (error) throw new Error(`Mise à jour de la photo échouée : ${error.message}`);
  await removeStoredLicenciePhoto(serviceSupabase, licencie.photo_url, club.id).catch(() => undefined);
  return c.json(mapLicencieRow(data));
});

/** DELETE /v1/clubs/:clubId/licencies/:licencieId/photo — retire la photo de la fiche (et le fichier stocké s'il vient de nous). */
licenciesRouter.delete("/:licencieId/photo", async (c) => {
  const { club, licencie, serviceSupabase } = await photoEditContext(c);
  const { data, error } = await serviceSupabase.from("licencies").update({ photo_url: null }).eq("id", licencie.id).eq("club_id", club.id).select(LICENCIE_COLUMNS).single();
  if (error) throw new Error(`Suppression de la photo échouée : ${error.message}`);
  await removeStoredLicenciePhoto(serviceSupabase, licencie.photo_url, club.id).catch(() => undefined);
  return c.json(mapLicencieRow(data));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function photoEditContext(c: any) {
  const { club, roles } = c.get("club");
  const user = c.get("user");
  const supabase = c.get("supabase");
  const licencieId = c.req.param("licencieId") as string | undefined;
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");
  const ownLicencieId = await getOwnLicencieId(supabase, club.id, user.id);
  const { canEdit, allowedFields } = resolveLicencieEditPermission(isClubAdmin(roles), ownLicencieId === licencieId);
  if (!canEdit || !(allowedFields as readonly string[]).includes("photoUrl")) throw forbidden("Vous ne pouvez pas modifier la photo de ce profil.");
  const serviceSupabase = createServiceSupabaseClient();
  const { data: licencie } = await serviceSupabase.from("licencies").select("id, photo_url").eq("id", licencieId).eq("club_id", club.id).maybeSingle();
  if (!licencie) throw notFound("Licencié introuvable.");
  return { club, licencie, serviceSupabase };
}

/**
 * POST /v1/clubs/:clubId/licencies — ajout MANUEL d'une personne
 * (club_admin), ex. un coach non licencié dans ce club (retour du club,
 * 2026-10-01). Sans `ffbb_licence_id` : jamais touchée ni dédoublonnée par
 * les imports FFBB. Un numéro de licence déjà utilisé dans le club → 409.
 */
licenciesRouter.post("/", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const body = CreateLicencieDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues[0]?.message ?? "Corps de requête invalide.");
  const input = body.data;

  const serviceSupabase = createServiceSupabaseClient();
  if (input.teamId) {
    const { data: team } = await serviceSupabase.from("teams").select("id").eq("id", input.teamId).eq("club_id", club.id).maybeSingle();
    if (!team) throw badRequest("teamId ne correspond à aucune équipe de ce club.");
  }

  const { data, error } = await serviceSupabase
    .from("licencies")
    .insert({
      club_id: club.id,
      first_name: input.firstName,
      last_name: input.lastName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      license_number: input.licenseNumber ?? null,
      team_id: input.teamId ?? null,
      ffbb_licence_id: null,
      active: true,
      public_admin: input.publicAdmin ?? false,
      public_coach: input.publicCoach ?? false,
      public_coordinator: input.publicCoordinator ?? false,
      coached_team_ids: input.coachedTeamIds ? await validateClubTeamIds(serviceSupabase, club.id, input.coachedTeamIds) : [],
    })
    .select(LICENCIE_COLUMNS)
    .single();
  if (error?.code === "23505") throw conflict("Ce numéro de licence est déjà utilisé par un licencié du club.", "LICENSE_NUMBER_TAKEN");
  if (error || !data) throw new Error(`Création du licencié échouée : ${error?.message}`);

  return c.json(mapLicencieRow(data as LicencieRow), 201);
});

/**
 * POST /v1/clubs/:clubId/licencies/import — import en masse depuis un
 * export FBI (demande du club, 2026-09-28 : "Voici la liste des
 * licenciés, ajoute les tous stp, a lavenir yen aura dautres, faudra
 * ignorer les doublons dans les exports"). `club_admin` uniquement (même
 * verrou que la modification d'un profil — créer des licenciés est un
 * geste admin, jamais un membre quelconque).
 *
 * Dédoublonnage PAR `ffbb_licence_id` ("N° national", contrainte unique
 * `club_id, ffbb_licence_id` — migration `20260928020000`) : une ligne de
 * l'export déjà connue pour ce club est IGNORÉE (jamais mise à jour ici —
 * un club_admin ayant depuis corrigé un nom/une date à la main ne doit
 * jamais se faire écraser silencieusement par le prochain import), jamais
 * une erreur. `team_id`/`active`/`photo_url`/`email`/`phone` ne sont
 * JAMAIS touchés par un import — un import ne fait qu'AJOUTER de nouvelles
 * personnes, l'affectation à une équipe reste un geste manuel exclusif de
 * club_admin (voir la fonctionnalité glisser-déposer, `PATCH .../profile`).
 *
 * Deux requêtes (lire les `ffbb_licence_id` déjà connus, puis insérer le
 * reste) plutôt qu'un `upsert` — permet de renvoyer un compte EXACT
 * `inserted`/`skipped` à l'admin (confirmation visible de ce qui a
 * réellement été ajouté), l'`upsert` seul ne le distinguerait pas. La
 * contrainte unique posée par la migration reste le filet de sécurité en
 * cas de course (import concurrent) — un conflit résiduel à l'insertion
 * fait échouer la requête plutôt que de créer un doublon silencieux.
 */
licenciesRouter.post("/import", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");

  const body = ImportLicenciesDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues[0]?.message ?? "Corps de requête invalide.");

  const serviceSupabase = createServiceSupabaseClient();

  const incomingIds = [...new Set(body.data.licencies.map((row) => row.ffbbLicenceId))];
  const { data: existingRows, error: existingError } = await serviceSupabase
    .from("licencies")
    .select("ffbb_licence_id")
    .eq("club_id", club.id)
    .in("ffbb_licence_id", incomingIds);
  if (existingError) throw new Error(`Lecture des licenciés existants échouée : ${existingError.message}`);

  const existingIds = new Set((existingRows ?? []).map((row) => row.ffbb_licence_id));
  const seenInBatch = new Set<string>();
  const toInsert: {
    club_id: string;
    first_name: string;
    last_name: string;
    license_number: string | null;
    birth_date: string | null;
    ffbb_licence_id: string;
    category_label: string | null;
    sexe: "M" | "F" | null;
  }[] = [];

  for (const row of body.data.licencies) {
    if (existingIds.has(row.ffbbLicenceId) || seenInBatch.has(row.ffbbLicenceId)) continue;
    seenInBatch.add(row.ffbbLicenceId);
    toInsert.push({
      club_id: club.id,
      first_name: row.firstName,
      last_name: row.lastName,
      license_number: row.licenseNumber ?? null,
      birth_date: row.birthDate ?? null,
      ffbb_licence_id: row.ffbbLicenceId,
      category_label: row.categoryLabel ?? null,
      sexe: row.sexe ?? null,
    });
  }

  if (toInsert.length > 0) {
    const { error: insertError } = await serviceSupabase.from("licencies").insert(toInsert);
    if (insertError) throw new Error(`Import des licenciés échoué : ${insertError.message}`);
  }

  const result: ImportLicenciesResultDto = {
    total: body.data.licencies.length,
    inserted: toInsert.length,
    skipped: body.data.licencies.length - toInsert.length,
  };
  return c.json(result);
});

/**
 * POST /v1/clubs/:clubId/licencies/import/file — l'admin dépose le fichier
 * Excel téléchargé depuis FBI (« Gestion des licences », filtre Validé,
 * bouton Excel), tel quel : aucun copier-coller, aucune colonne à préparer
 * (retour du club, 2026-10-08 : « faut que tout soit pour les nuls »). Même
 * traitement que la mise à jour automatique (`syncLicenciesFromFbi`). Le
 * fichier n'est jamais stocké.
 */
licenciesRouter.post("/import/file", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");

  const body = await c.req.parseBody().catch(() => null);
  const file = body?.file;
  if (!file || typeof file === "string") throw badRequest("Ajoute le fichier Excel téléchargé depuis FBI.", "FILE_REQUIRED");
  if (file.size > MAX_EXPORT_BYTES) throw badRequest("Fichier trop volumineux pour un export de licences FBI.", "NOT_A_LICENCE_EXPORT");

  let parsed;
  try {
    parsed = await parseFbiLicenceExport(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    if (error instanceof LicenceExportError) throw badRequest(error.message, error.code);
    throw error;
  }

  const serviceSupabase = createServiceSupabaseClient();
  const result = await syncLicenciesFromFbi(serviceSupabase, club.id, parsed.rows);
  await recordLicenceImportRun(serviceSupabase, club.id, "file", result, user.id);
  return c.json(result satisfies LicenceSyncResultDto);
});

/**
 * POST /v1/clubs/:clubId/licencies/import/fbi — « Mettre à jour depuis FBI
 * maintenant » : empile un job `import_licences` (un seul à la fois par
 * club), traité dans la session FBI du club. Le même job part aussi tout
 * seul une fois par jour (`enqueueFbiVerificationJobsForClub`).
 */
licenciesRouter.post("/import/fbi", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();

  const { data: status } = await serviceSupabase.from("fbi_integration_status").select("configured").eq("club_id", club.id).maybeSingle();
  if (!status?.configured) throw conflict("Enregistre d'abord les identifiants FBI du club (Intégrations → FBI), ou dépose le fichier Excel.", "FBI_NOT_CONFIGURED");

  const { data: active } = await serviceSupabase.from("fbi_jobs").select("id").eq("club_id", club.id).eq("type", "import_licences").in("status", ["pending", "claimed", "running"]).limit(1);
  if (active?.[0]) return c.json({ jobId: active[0].id, alreadyQueued: true }, 202);

  const { data: job, error } = await serviceSupabase.from("fbi_jobs").insert({ club_id: club.id, type: "import_licences" }).select("id").single();
  if (error?.code === "23505") {
    const { data: again } = await serviceSupabase.from("fbi_jobs").select("id").eq("club_id", club.id).eq("type", "import_licences").in("status", ["pending", "claimed", "running"]).limit(1);
    return c.json({ jobId: again?.[0]?.id ?? null, alreadyQueued: true }, 202);
  }
  if (error || !job) throw new Error(`Demande de mise à jour FBI échouée : ${error?.message}`);
  return c.json({ jobId: job.id, alreadyQueued: false }, 202);
});

/** GET /v1/clubs/:clubId/licencies/import/status — dernière mise à jour et demande FBI en cours, pour l'écran Joueurs. */
licenciesRouter.get("/import/status", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const serviceSupabase = createServiceSupabaseClient();

  const [{ data: status }, { data: runs }, { data: jobs }] = await Promise.all([
    serviceSupabase.from("fbi_integration_status").select("configured").eq("club_id", club.id).maybeSingle(),
    serviceSupabase.from("licence_import_runs").select("source, created_at, total, inserted, updated, reactivated, unchanged, not_in_export").eq("club_id", club.id).order("created_at", { ascending: false }).limit(1),
    serviceSupabase.from("fbi_jobs").select("id, status, created_at, finished_at, last_error, attempt_count, scheduled_at").eq("club_id", club.id).eq("type", "import_licences").order("created_at", { ascending: false }).limit(1),
  ]);

  const run = runs?.[0];
  const job = jobs?.[0];
  const dto: LicenceImportStatusDto = {
    fbiConfigured: Boolean(status?.configured),
    lastRun: run
      ? { source: run.source, at: run.created_at, total: run.total, inserted: run.inserted, updated: run.updated, reactivated: run.reactivated, unchanged: run.unchanged, notInExport: run.not_in_export }
      : null,
    job: job
      ? {
          id: job.id,
          status: job.status,
          createdAt: job.created_at,
          finishedAt: job.finished_at,
          error: job.status === "succeeded" ? null : job.last_error,
          attempts: job.attempt_count ?? 0,
          nextAttemptAt: job.status === "pending" ? job.scheduled_at : null,
        }
      : null,
  };
  return c.json(dto);
});

/**
 * POST /v1/clubs/:clubId/licencies/auto-assign-teams — répartition
 * automatique best-effort des licenciés SANS équipe (demande du club,
 * 2026-09-28 : "ils sont tous sans équipe, alors qu'on a une info pour
 * commencer déjà a les mettre dans les équipes, si ya 2 equipes pour 1
 * catégorie, met tous dans 1 seule pour linstant"). `club_admin`
 * uniquement — même verrou que l'import et que `teamId` en écriture via
 * `PATCH .../profile`. Voir `auto-assign-teams.ts` pour l'algorithme
 * (jamais un identifiant d'équipe deviné, toujours dérivé des catégories
 * réelles) — reste un point de DÉPART modifiable ensuite par glisser-
 * déposer, jamais une vérité définitive.
 */
licenciesRouter.post("/auto-assign-teams", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");

  const serviceSupabase = createServiceSupabaseClient();
  const result: AutoAssignTeamsResultDto = await autoAssignTeamsForClub(serviceSupabase, { clubId: club.id });

  return c.json(result);
});

/**
 * DELETE /v1/clubs/:clubId/licencies/:licencieId — supprime définitivement
 * la fiche d'un licencié (demande du club, 2026-09-28 : "faut aussi un
 * bouton pour supprimer un licencié"). `club_admin` uniquement — même
 * verrou que le reste de l'écriture sur `licencies`. Sûr sans condition
 * (voir `DeleteLicencieResultDtoSchema` pour le détail : toutes les
 * références sont `on delete set null`, l'historique de match n'est
 * jamais perdu).
 */
licenciesRouter.delete("/:licencieId", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const licencieId = c.req.param("licencieId");
  if (!licencieId) throw badRequest("Paramètre de route :licencieId manquant.");

  const serviceSupabase = createServiceSupabaseClient();

  const { data: existing } = await serviceSupabase.from("licencies").select("id, photo_url").eq("id", licencieId).eq("club_id", club.id).maybeSingle();
  if (!existing) throw notFound("Licencié introuvable.");

  const { error } = await serviceSupabase.from("licencies").delete().eq("id", licencieId).eq("club_id", club.id);
  if (error) throw new Error(`Suppression du licencié échouée : ${error.message}`);
  await removeStoredLicenciePhoto(serviceSupabase, existing.photo_url, club.id).catch((storageError: unknown) =>
    logError("Photo de licencié non supprimée du stockage", storageError, { clubId: club.id, path: storedPhotoPath(existing.photo_url, club.id) }),
  );

  const result: DeleteLicencieResultDto = { deleted: true };
  return c.json(result);
});
