import { Hono } from "hono";
import type { DbClient } from "../../db/client.js";
import { badRequest, forbidden } from "../../api-error.js";
import { resolvePublicClub, type PublicClub } from "../public/club-resolver.js";
import { licencieFromRequest, type RequestLike } from "../public/credential.js";
import { handleAction,
  handleDelete, handleAvailability, handleContext, handleCreate, handleGet, handleList, handleMessage, handleOfficial, handlePropose, handleSlotCheck, type Ctx } from "./routes.js";
import { hasDerogationRole, loadLicencieActor } from "./service.js";

/**
 * Demandes de dérogation internes depuis l'ESPACE PUBLIC SANS COMPTE —
 * retour du club, 2026-10-01 : « dans la liste des joueurs, comme on a fait
 * pour l'admin, on le fait pour les coachs et coordinateurs ». Le licencié
 * est reconnu par son lien personnel (`?token=` sur CHAQUE requête, comme
 * les Tables de marque publiques) ; ses droits viennent des drapeaux posés
 * depuis /joueurs (`public_coach`, `public_coordinator`, `public_admin`) —
 * voir `loadLicencieActor`.
 *
 * MÊMES handlers que l'espace club (routes.ts) : mêmes règles de créneau,
 * mêmes transitions, même conversation. Aucune écriture FFBB/FBI ni sur
 * `matches`. Client service role (pas de compte ⇒ pas de RLS utilisateur) :
 * c'est ce code qui filtre par `publicClub.id` et par les permissions.
 * Monté à `/v1/public/clubs/:clubSlug/derogation-requests`.
 */
interface PublicEnv {
  Variables: { supabase: DbClient; publicClub: PublicClub };
}

export const publicDerogationRequestsRouter = new Hono<PublicEnv>();
publicDerogationRequestsRouter.use("*", resolvePublicClub<PublicEnv>());

async function publicContext(c: { get: (k: "supabase" | "publicClub") => unknown; req: RequestLike }): Promise<Ctx> {
  const db = c.get("supabase") as DbClient;
  const club = c.get("publicClub") as PublicClub;
  const licencie = await licencieFromRequest(c.req, db, club.id);
  const actor = await loadLicencieActor(db, club.id, licencie.id);
  if (!hasDerogationRole(actor)) throw forbidden("Les demandes de dérogation sont réservées aux coachs et au coordinateur du club.", "DEROGATION_ROLE_REQUIRED");
  const name = licencie.first_name.trim() || licencie.last_name.trim() || "Coach";
  return {
    db,
    actor,
    clubId: club.id,
    timezone: club.timezone,
    membershipId: null,
    identity: async () => ({ name, source: "LICENCIE" as const }),
    authorEmail: async () => ((await db.from("licencies").select("email").eq("id", licencie.id).eq("club_id", club.id).maybeSingle()).data?.email ?? null),
  };
}

const body = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

function matchIdOrThrow(value: string | undefined): string {
  if (!value) throw badRequest("Paramètre matchId manquant.");
  return value;
}

publicDerogationRequestsRouter.get("/context", async (c) => c.json(await handleContext(await publicContext(c))));
// Avant `/:requestId` : chemins fixes d'abord.
publicDerogationRequestsRouter.get("/availability", async (c) => c.json(await handleAvailability(await publicContext(c), matchIdOrThrow(c.req.query("matchId")), c.req.query())));
publicDerogationRequestsRouter.get("/slot-check", async (c) => c.json(await handleSlotCheck(await publicContext(c), matchIdOrThrow(c.req.query("matchId")), c.req.query())));
publicDerogationRequestsRouter.get("/", async (c) => c.json(await handleList(await publicContext(c), c.req.query())));
publicDerogationRequestsRouter.get("/:requestId", async (c) => c.json(await handleGet(await publicContext(c), c.req.param("requestId"))));
publicDerogationRequestsRouter.post("/", async (c) => c.json(await handleCreate(await publicContext(c), await body(c)), 201));
publicDerogationRequestsRouter.post("/:requestId/messages", async (c) => c.json(await handleMessage(await publicContext(c), c.req.param("requestId"), await body(c))));
publicDerogationRequestsRouter.post("/:requestId/actions", async (c) => c.json(await handleAction(await publicContext(c), c.req.param("requestId"), await body(c))));
publicDerogationRequestsRouter.delete("/:requestId", async (c) => c.json(await handleDelete(await publicContext(c), c.req.param("requestId"))));
publicDerogationRequestsRouter.post("/:requestId/proposals", async (c) => c.json(await handlePropose(await publicContext(c), c.req.param("requestId"), await body(c))));
publicDerogationRequestsRouter.post("/:requestId/official", async (c) => c.json(await handleOfficial(await publicContext(c), c.req.param("requestId"), await body(c))));
