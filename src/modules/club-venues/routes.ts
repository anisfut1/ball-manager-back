import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requireClubMembership, requireClubRole } from "../../auth/middleware.js";
import { badRequest, notFound } from "../../api-error.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { CreateVenueClosureDtoSchema, UpdateClubVenueDtoSchema } from "../../contracts/club-venues.js";
import { localDateKey } from "../../util/timezone.js";
import { CLOSURE_COLUMNS, withConflicts, type ClosureRow } from "./closures.js";

/**
 * Gymnases du club (`club_venues`, planning des demandes de dérogation).
 * Lecture : tout membre. Modification (nom affiché, actif, ordre) :
 * `club_admin`. Les gymnases sont créés à partir des salles FFBB des matchs
 * à domicile (migration + synchronisation) — jamais un nom deviné.
 */
export const clubVenuesRouter = new Hono<AppEnv>();
clubVenuesRouter.use("*", requireAuth);
clubVenuesRouter.use("*", requireClubMembership);

const COLUMNS = "id, name, address, active, sort_order";

clubVenuesRouter.get("/", async (c) => {
  const { club } = c.get("club");
  const { data, error } = await createServiceSupabaseClient().from("club_venues").select(COLUMNS).eq("club_id", club.id).order("sort_order").order("name");
  if (error) throw new Error(`Lecture des gymnases échouée : ${error.message}`);
  return c.json({ venues: (data ?? []).map((v) => ({ id: v.id, name: v.name, address: v.address, active: v.active, sortOrder: v.sort_order })) });
});

clubVenuesRouter.patch("/:venueId", requireClubRole("club_admin"), async (c) => {
  const body = UpdateClubVenueDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const { club } = c.get("club");
  const patch: { name?: string; active?: boolean; sort_order?: number; updated_at: string } = { updated_at: new Date().toISOString() };
  if (body.data.name !== undefined) patch.name = body.data.name;
  if (body.data.active !== undefined) patch.active = body.data.active;
  if (body.data.sortOrder !== undefined) patch.sort_order = body.data.sortOrder;

  const { data, error } = await createServiceSupabaseClient().from("club_venues").update(patch).eq("id", c.req.param("venueId")).eq("club_id", club.id).select(COLUMNS).maybeSingle();
  if (error) throw new Error(`Mise à jour du gymnase échouée : ${error.message}`);
  if (!data) throw notFound("Gymnase introuvable.");
  return c.json({ venue: { id: data.id, name: data.name, address: data.address, active: data.active, sortOrder: data.sort_order } });
});

/**
 * Indisponibilités des gymnases (demande du club, 2026-10-22) : lecture par
 * tout membre (à venir et en cours), ajout et suppression par `club_admin`.
 * Chaque indisponibilité revient avec ses conflits (matchs à domicile et
 * séances d'entraînement prévus dans ce gymnase pendant la période).
 */
clubVenuesRouter.get("/closures", async (c) => {
  const { club } = c.get("club");
  const db = createServiceSupabaseClient();
  const { data, error } = await db.from("club_venue_closures").select(CLOSURE_COLUMNS).eq("club_id", club.id).gte("end_date", localDateKey(new Date(), club.timezone)).order("start_date").order("created_at");
  if (error) throw new Error(`Lecture des indisponibilités échouée : ${error.message}`);
  return c.json({ closures: await withConflicts(db, club.id, club.timezone, (data ?? []) as ClosureRow[]) });
});

clubVenuesRouter.post("/closures", requireClubRole("club_admin"), async (c) => {
  const body = CreateVenueClosureDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const { club } = c.get("club");
  const { clubVenueId, startDate, endDate, period, reason } = body.data;
  if (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`) > 366 * 86_400_000) throw badRequest("Une indisponibilité couvre au plus un an.");
  const db = createServiceSupabaseClient();
  const { data: venue } = await db.from("club_venues").select("id").eq("id", clubVenueId).eq("club_id", club.id).maybeSingle();
  if (!venue) throw notFound("Gymnase introuvable.");
  const user = c.get("user") as { id: string } | undefined;
  const { data, error } = await db
    .from("club_venue_closures")
    .insert({ club_id: club.id, club_venue_id: clubVenueId, start_date: startDate, end_date: endDate, period, reason: reason || null, created_by: user?.id ?? null })
    .select(CLOSURE_COLUMNS)
    .single();
  if (error) throw new Error(`Ajout de l'indisponibilité échoué : ${error.message}`);
  const [closure] = await withConflicts(db, club.id, club.timezone, [data as ClosureRow]);
  return c.json({ closure }, 201);
});

clubVenuesRouter.delete("/closures/:closureId", requireClubRole("club_admin"), async (c) => {
  const { club } = c.get("club");
  const db = createServiceSupabaseClient();
  const closureId = c.req.param("closureId");
  const { data } = await db.from("club_venue_closures").select("id").eq("id", closureId).eq("club_id", club.id).maybeSingle();
  if (!data) throw notFound("Indisponibilité introuvable.");
  const { error } = await db.from("club_venue_closures").delete().eq("id", closureId).eq("club_id", club.id);
  if (error) throw new Error(`Suppression de l'indisponibilité échouée : ${error.message}`);
  return c.json({ deleted: true });
});
