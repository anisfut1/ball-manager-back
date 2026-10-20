import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest, notFound } from "../../api-error.js";
import { CreateDerogationDtoSchema, RespondToDerogationDtoSchema } from "../../contracts/derogations.js";
import { respondToDerogationForClub } from "../derogations/respond-derogation.js";
import { createDerogationForClub } from "../derogations/create-derogation.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { compareDerogationDateDepot } from "../../integrations/fbi/derogation-row.js";
import { checkDerogationForMatchSync } from "../derogations/check-derogation-sync.js";
import { listMatchesForClub, loadMatchDetails, resolveDerogationStatus } from "./shared.js";

export const matchesRouter = new Hono<AppEnv>();

matchesRouter.use("*", requireAuth);
matchesRouter.use("*", requireClubMembership);

/**
 * GET /v1/clubs/:clubId/matches — filtres et pagination (gap 7 de la
 * demande, voir `contracts/matches.ts#MatchesQueryDtoSchema`). Logique
 * dans `./shared.ts#listMatchesForClub`, réutilisée telle quelle par le
 * routeur public (`public-matches/routes.ts`).
 */
matchesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const result = await listMatchesForClub(c.get("supabase"), club, c.req.query());
  return c.json(result);
});

/** GET /v1/clubs/:clubId/matches/:matchId — voir `./shared.ts#loadMatchDetails`. */
matchesRouter.get("/:matchId", async (c) => {
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const dto = await loadMatchDetails(c.get("supabase"), c.get("club").club, matchId, { includePhotos: true });
  return c.json(dto);
});

/**
 * GET /v1/clubs/:clubId/matches/:matchId/derogation — dernier état CONNU
 * de la dérogation de ce match. Voir la doc détaillée (priorité "En
 * Cours", complétude du détail, `dateDepot`) sur `./shared.ts#resolveDerogationStatus`,
 * réutilisée telle quelle par le routeur public.
 */
matchesRouter.get("/:matchId/derogation", async (c) => {
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const derogation = await resolveDerogationStatus(c.get("supabase"), c.get("club").club, matchId);
  return c.json({ derogation });
});

/**
 * POST /v1/clubs/:clubId/matches/:matchId/derogation/respond — ÉCRIT
 * réellement sur FBI/FFBB (accepter/refuser), demande du club, 2026-09-27 :
 * "je veux le faire via loutil". Résout la MÊME dérogation que le widget
 * `GET .../derogation` ci-dessus vient d'afficher (même sélection —
 * priorité "En Cours", voir sa doc), pour que le bouton de la fiche match
 * agisse bien sur ce que l'admin vient de lire à l'écran. `club_admin`
 * uniquement — jamais exposée au routeur public (lecture seule là-bas).
 */
matchesRouter.post("/:matchId/derogation/respond", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const body = RespondToDerogationDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues[0]?.message ?? "Corps de requête invalide.");

  const { data: rows } = await c
    .get("supabase")
    .from("fbi_derogation_checks")
    .select("id, etat, date_depot, demandeur, motif, date_rencontre_demandee, heure_demandee, adversaire, date_reponse, acceptation, motif_refus, checked_at")
    .eq("club_id", club.id)
    .eq("match_id", matchId)
    .order("checked_at", { ascending: false });

  const hasDetail = (row: { demandeur: string | null; motif: string | null; date_rencontre_demandee: string | null; heure_demandee: string | null; adversaire: string | null; date_reponse: string | null; acceptation: string | null; motif_refus: string | null }): boolean =>
    Boolean(row.demandeur || row.motif || row.date_rencontre_demandee || row.heure_demandee || row.adversaire || row.date_reponse || row.acceptation || row.motif_refus);

  const enCoursRows = (rows ?? []).filter((r) => r.etat === "En Cours");
  const pool = enCoursRows.length > 0 ? enCoursRows : (rows ?? []);
  const detailedRows = pool.filter(hasDetail);
  const candidates = detailedRows.length > 0 ? detailedRows : pool;
  const data = [...candidates].sort((a, b) => compareDerogationDateDepot(b.date_depot, a.date_depot) || b.checked_at.localeCompare(a.checked_at))[0] ?? null;

  if (!data) throw notFound("Aucune dérogation connue pour ce match.");

  const serviceSupabase = createServiceSupabaseClient();
  const result = await respondToDerogationForClub(serviceSupabase, {
    clubId: club.id,
    derogationCheckId: data.id,
    decision: body.data.decision,
    motifRefus: body.data.motifRefus ?? null,
    submittedBy: user.id,
  });

  return c.json(result);
});

/**
 * POST /v1/clubs/:clubId/matches/:matchId/derogation/check — SYNCHRONE
 * depuis 2026-09-28 ("doit y avoir rien en attente" — voir la doc de
 * `checkDerogationForMatchSync` : l'ancien modèle empilait un job
 * `fbi_jobs`, source directe de confusion quand un autre job plus ancien
 * du club se traitait à sa place). `club_admin` uniquement. LECTURE
 * SEULE : consulte l'état FBI de la dérogation, n'en soumet/modifie
 * jamais une (voir docs/FBI.md).
 */
matchesRouter.post("/:matchId/derogation/check", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const serviceSupabase = createServiceSupabaseClient();
  const result = await checkDerogationForMatchSync(serviceSupabase, { clubId: club.id, matchId });

  return c.json(result);
});

/**
 * POST /v1/clubs/:clubId/matches/:matchId/derogation/create — ÉCRIT
 * réellement sur FBI/FFBB : crée une NOUVELLE demande de dérogation pour ce
 * match (demande du club, 2026-09-28 : "sur chaque rencontre faut un bouton
 * 'Créer une dérogation'... on remplit et choisi le motif, et on envoie de
 * la meme facon que pour accpter ou refuser"). `club_admin` uniquement
 * (même verrou que `.../respond`). SYNCHRONE — voir la doc de
 * `createDerogationForClub`.
 */
matchesRouter.post("/:matchId/derogation/create", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const matchId = c.req.param("matchId");
  if (!matchId) throw badRequest("Paramètre de route :matchId manquant.");

  const body = CreateDerogationDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues[0]?.message ?? "Corps de requête invalide.");

  const serviceSupabase = createServiceSupabaseClient();
  const result = await createDerogationForClub(serviceSupabase, {
    clubId: club.id,
    matchId,
    motif: body.data.motif,
    modifierDate: body.data.modifierDate,
    dateDerogation: body.data.dateDerogation ?? null,
    modifierHoraire: body.data.modifierHoraire,
    horaire: body.data.horaire ?? null,
    inverserRencontre: body.data.inverserRencontre,
    inverserEquipe: body.data.inverserEquipe,
    modifierSalle: body.data.modifierSalle,
    clubVenueId: body.data.clubVenueId ?? null,
    submittedBy: user.id,
  });

  return c.json(result);
});
