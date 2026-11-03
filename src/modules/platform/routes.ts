import { Hono } from "hono";
import type { AppEnv } from "../../auth/context.js";
import { requireAuth, requirePlatformAdmin } from "../../auth/middleware.js";
import { createServiceSupabaseClient, type DbClient } from "../../db/client.js";
import { badRequest, conflict, notFound } from "../../api-error.js";
import { computeClubCapabilities } from "../../tenancy/club-capabilities.js";
import { logError } from "../../logger.js";
import { GrantClubAdminDtoSchema, type PlatformClubDto } from "../../contracts/platform.js";
import { listMembers } from "../members/routes.js";
import { provisionClubAccount } from "../../auth/account-invites.js";
import { DeleteOldSeasonsDtoSchema } from "../../contracts/maintenance.js";
import { deleteMatchesBeforeCurrentSeason, purgeAllStoredEmarqueDocuments, retryFailedEmarqueImports } from "./maintenance.js";

export const platformRouter = new Hono<AppEnv>();

platformRouter.use("*", requireAuth);
platformRouter.use("*", requirePlatformAdmin);

function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** GET /v1/platform/clubs — indicateurs simples FFBB/FBI/e-Marque par club, réservé platform_admin (§42 de la demande). */
platformRouter.get("/clubs", async (c) => {
  const supabase = createServiceSupabaseClient();

  const [{ data: clubs }, { data: fbiStatuses }] = await Promise.all([
    supabase.from("clubs").select("id, slug, name, ffbb_club_id, status, ffbb_enabled").order("created_at", { ascending: false }),
    supabase.from("fbi_integration_status").select("club_id, configured, last_login_success"),
  ]);

  const fbiByClub = new Map((fbiStatuses ?? []).map((s) => [s.club_id, s]));

  const result: PlatformClubDto[] = (clubs ?? []).map((club) => {
    const fbiStatus = fbiByClub.get(club.id);
    const capabilities = computeClubCapabilities({
      ffbbEnabled: club.ffbb_enabled,
      fbiConfigured: fbiStatus?.configured ?? false,
      fbiConnected: fbiStatus?.last_login_success ?? false,
    });

    return {
      id: club.id,
      slug: club.slug,
      name: club.name,
      ffbbClubId: club.ffbb_club_id,
      status: club.status,
      ...capabilities,
    };
  });

  return c.json({ clubs: result });
});

/**
 * POST /v1/platform/clubs — onboarding d'un nouveau club sans opération SQL
 * manuelle (§42/§43 de la demande). Invite le premier club_admin via
 * `auth.admin.inviteUserByEmail` (jamais depuis le frontend avec service
 * role — c'est précisément pour ça que cette route existe).
 */
platformRouter.post("/clubs", async (c) => {
  const body = await c.req.json<{ name?: string; ffbbClubId?: string; slug?: string; timezone?: string; adminEmail?: string }>().catch(() => ({}) as { name?: string; ffbbClubId?: string; slug?: string; timezone?: string; adminEmail?: string });

  const name = (body.name ?? "").trim();
  const ffbbClubId = (body.ffbbClubId ?? "").trim();
  const timezone = (body.timezone ?? "Europe/Paris").trim() || "Europe/Paris";
  const adminEmail = (body.adminEmail ?? "").trim();

  if (!name || !ffbbClubId) throw badRequest("Le nom et le code FFBB sont requis.");

  const slug = slugify(body.slug || name);
  if (!slug) throw badRequest("Impossible de générer un slug à partir de ce nom.");

  const supabase = createServiceSupabaseClient();

  const { data: existingSlug } = await supabase.from("clubs").select("id").eq("slug", slug).maybeSingle();
  if (existingSlug) throw badRequest(`Le slug "${slug}" est déjà utilisé par un autre club.`);

  const { data: club, error: clubError } = await supabase.from("clubs").insert({ name, slug, ffbb_club_id: ffbbClubId, timezone }).select("id, slug").single();

  if (clubError || !club) {
    logError("Création de club échouée", clubError, { slug });
    throw badRequest("Création du club impossible (code FFBB déjà utilisé ?).");
  }

  let adminInviteError: string | null = null;
  if (adminEmail) {
    try {
      await inviteFirstClubAdmin(supabase, club.id, adminEmail);
    } catch (error) {
      logError("Invitation du premier admin de club échouée", error, { clubId: club.id });
      adminInviteError = "Club créé, mais l'invitation de l'admin a échoué (à refaire manuellement).";
    }
  }

  return c.json({ clubId: club.id, slug: club.slug, adminInviteError }, 201);
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadClubOrThrow(supabase: DbClient, clubId: string | undefined): Promise<{ id: string; slug: string; name: string }> {
  if (!clubId || !UUID.test(clubId)) throw notFound("Club introuvable.");
  const { data } = await supabase.from("clubs").select("id, slug, name").eq("id", clubId).maybeSingle();
  if (!data) throw notFound("Club introuvable.");
  return { id: data.id, slug: data.slug, name: data.name };
}

/**
 * GET /v1/platform/clubs/:clubId/members — membres et rôles d'un club, vus
 * par l'opérateur de la plateforme (retour du club, 2026-10-08 : « dans
 * l'espace clubs, il faut que je voie les admins, qui je mets en admin »).
 * Même lecture que `GET /v1/clubs/:clubId/members`, sans exiger d'être
 * membre du club.
 */
platformRouter.get("/clubs/:clubId/members", async (c) => {
  const supabase = createServiceSupabaseClient();
  const club = await loadClubOrThrow(supabase, c.req.param("clubId"));
  return c.json({ club, members: await listMembers(supabase, club.id, c.get("user").id) });
});

/** POST /v1/platform/clubs/:clubId/admins — nomme administrateur du club (invite le compte s'il n'existe pas, garde ses autres rôles). */
platformRouter.post("/clubs/:clubId/admins", async (c) => {
  const body = GrantClubAdminDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const supabase = createServiceSupabaseClient();
  const club = await loadClubOrThrow(supabase, c.req.param("clubId"));
  await inviteFirstClubAdmin(supabase, club.id, body.data.email.toLowerCase());
  return c.json({ club, members: await listMembers(supabase, club.id, c.get("user").id) }, 201);
});

/**
 * DELETE /v1/platform/clubs/:clubId/admins/:membershipId — retire le rôle
 * administrateur (les autres rôles et l'accès au club restent). Jamais le
 * dernier administrateur actif : le club ne doit pas se retrouver sans
 * personne pour le gérer.
 */
platformRouter.delete("/clubs/:clubId/admins/:membershipId", async (c) => {
  const supabase = createServiceSupabaseClient();
  const club = await loadClubOrThrow(supabase, c.req.param("clubId"));
  const membershipId = c.req.param("membershipId");

  const { data: memberships } = await supabase.from("club_memberships").select("id, status").eq("club_id", club.id);
  const target = (memberships ?? []).find((m) => m.id === membershipId);
  if (!target) throw notFound("Membre introuvable.");

  const activeIds = (memberships ?? []).filter((m) => m.status === "active").map((m) => m.id);
  const { data: adminRows } = activeIds.length
    ? await supabase.from("membership_roles").select("membership_id").eq("role", "club_admin").in("membership_id", activeIds)
    : { data: [] as { membership_id: string }[] };
  const adminIds = new Set((adminRows ?? []).map((r) => r.membership_id));
  if (adminIds.has(target.id) && adminIds.size <= 1) {
    throw conflict("C'est le dernier administrateur de ce club : nommes-en un autre avant de retirer celui-ci.", "LAST_CLUB_ADMIN");
  }

  const { error } = await supabase.from("membership_roles").delete().eq("membership_id", target.id).eq("role", "club_admin");
  if (error) throw new Error(`Retrait du rôle administrateur échoué : ${error.message}`);
  return c.json({ club, members: await listMembers(supabase, club.id, c.get("user").id) });
});

/**
 * POST /v1/platform/maintenance/purge-emarque-documents — retour du club,
 * 2026-09-29 : "je veux juste l'interpréter, récupérer les stats et
 * ensuite pas la stocker", appliqué RÉTROACTIVEMENT à tout document
 * encore présent en Storage (les nouveaux sont déjà purgés automatiquement
 * après parsing, voir `jobs/parse-downloaded-documents.ts`). Idempotente,
 * jamais destructive pour les stats déjà en base — voir
 * `modules/platform/maintenance.ts`.
 */
platformRouter.post("/maintenance/purge-emarque-documents", async (c) => {
  const supabase = createServiceSupabaseClient();
  const result = await purgeAllStoredEmarqueDocuments(supabase);
  return c.json(result);
});

/**
 * POST /v1/platform/maintenance/delete-old-seasons — retour du club,
 * 2026-09-29 : "tout les matchs des saisons précédentes, faut les
 * supprimer j'en ai pas besoin, focus saison 2026-2027". IRRÉVERSIBLE —
 * `clubId` obligatoire dans le corps (jamais un défaut "tous les clubs",
 * voir `modules/platform/maintenance.ts`). La confirmation utilisateur
 * (double clic, saisie du nom du club...) est de la responsabilité de
 * l'UI appelante, jamais de cette route seule.
 */
platformRouter.post("/maintenance/delete-old-seasons", async (c) => {
  const body = DeleteOldSeasonsDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((issue) => issue.message).join(" "));

  const supabase = createServiceSupabaseClient();
  const result = await deleteMatchesBeforeCurrentSeason(supabase, body.data.clubId);
  return c.json(result);
});

/**
 * POST /v1/platform/maintenance/retry-failed-emarque-imports — retour du
 * club, 2026-09-29 : "faut que ce soit fait sur tous les matchs, sans bug,
 * sans interruption". Relance le parsing des matchs restés `error` en
 * réutilisant le fichier déjà téléchargé (jamais un nouveau login FBI) —
 * voir `modules/platform/maintenance.ts`. Sans effet sur `needs_review`
 * (fichier déjà purgé sur le chemin de succès, hors périmètre ici).
 */
platformRouter.post("/maintenance/retry-failed-emarque-imports", async (c) => {
  const supabase = createServiceSupabaseClient();
  const result = await retryFailedEmarqueImports(supabase);
  return c.json(result);
});

async function inviteFirstClubAdmin(supabase: DbClient, clubId: string, email: string): Promise<void> {
  const { data: club, error: clubError } = await supabase.from("clubs").select("id, slug, name, logo_url, accent_color").eq("id", clubId).single();
  if (clubError || !club) throw new Error(`Lecture du club échouée : ${clubError?.message}`);

  const account = await provisionClubAccount(supabase, {
    email,
    club: { slug: club.slug, name: club.name, logoUrl: club.logo_url ?? null, accentColor: club.accent_color ?? null },
    roles: ["club_admin"],
  });

  const { data: membership, error: membershipError } = await supabase
    .from("club_memberships")
    .upsert({ club_id: clubId, user_id: account.userId, status: "active" }, { onConflict: "club_id,user_id" })
    .select("id")
    .single();

  if (membershipError || !membership) {
    throw new Error(`Création du membership échouée : ${membershipError?.message}`);
  }

  const { error: roleError } = await supabase
    .from("membership_roles")
    .upsert({ membership_id: membership.id, role: "club_admin" }, { onConflict: "membership_id,role,scope_key" });

  if (roleError) {
    throw new Error(`Attribution du rôle club_admin échouée : ${roleError.message}`);
  }

  try {
    await account.sendEmail();
  } catch {
    throw badRequest("Administrateur nommé, mais l'email n'a pas pu partir. Réessaie dans quelques minutes pour le renvoyer.", "EMAIL_SEND_FAILED");
  }
}
