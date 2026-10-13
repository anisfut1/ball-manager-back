import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest } from "../../api-error.js";
import { RespondToDerogationDtoSchema } from "../../contracts/derogations.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { loadClubDerogations } from "./list.js";
import { respondToDerogationForClub } from "./respond-derogation.js";

export const derogationsRouter = new Hono<AppEnv>();

derogationsRouter.use("*", requireAuth);
derogationsRouter.use("*", requireClubMembership);

/**
 * GET /v1/clubs/:clubId/derogations — TOUTES les dérogations connues du
 * club (dernier état par match), enrichies du numéro/adversaire/date/
 * catégorie/équipe du club du match FFBB correspondant — pour la page
 * "Vérifier toutes les dérogations" (demande du club, voir docs/FBI.md : "je veux un bouton
 * global qui check toutes les demandes, pas match par match"). Silencieux
 * (liste vide) pour un club sans FBI configuré, ou n'ayant jamais lancé de
 * vérification — jamais une erreur.
 *
 * `club_admin` uniquement : c'est aussi ce que la policy RLS
 * `fbi_derogation_checks_select_club_admin` autorise déjà en lecture (voir
 * migration 20260925130000) — un simple membre obtiendrait de toute façon
 * une liste vide via `c.get("supabase")` (client scopé utilisateur, jamais
 * la clé service ici), donc autoriser la route à tout membre serait
 * silencieusement trompeur. Cohérent avec /admin/derogations côté ball-manager-web,
 * déjà réservée aux club_admin.
 */
derogationsRouter.get("/", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const derogations = await loadClubDerogations(c.get("supabase"), club.id);
  return c.json({ derogations });
});

/**
 * POST /v1/clubs/:clubId/derogations/:derogationId/respond — ÉCRIT
 * réellement sur FBI/FFBB (accepter/refuser), demande du club, 2026-09-27 :
 * "je veux le faire via loutil". `club_admin` uniquement (même verrou que
 * la lecture ci-dessus et que `.../matches/:matchId/derogation/check`).
 * SYNCHRONE — voir la doc de `respondToDerogationForClub` pour pourquoi
 * (jamais via `fbi_jobs`, contrairement à `check_derogation`).
 */
derogationsRouter.post("/:derogationId/respond", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const user = c.get("user");
  const derogationId = c.req.param("derogationId");
  if (!derogationId) throw badRequest("Paramètre de route :derogationId manquant.");

  const body = RespondToDerogationDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues[0]?.message ?? "Corps de requête invalide.");

  const serviceSupabase = createServiceSupabaseClient();
  const result = await respondToDerogationForClub(serviceSupabase, {
    clubId: club.id,
    derogationCheckId: derogationId,
    decision: body.data.decision,
    motifRefus: body.data.motifRefus ?? null,
    submittedBy: user.id,
  });

  return c.json(result);
});

