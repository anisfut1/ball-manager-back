import type { DbClient } from "../db/client.js";
import type { ClubRole, ClubStatus } from "../db/types.js";
import { notFound } from "../api-error.js";

/**
 * Adapté depuis ball-manager-web src/lib/tenancy/club-context.ts : même logique de
 * résolution "quel club, avec quels droits", mais sans couplage Next.js
 * (plus de `notFound()`/`redirect()` — on lève `ApiError`, géré par le
 * middleware d'erreur central). Le `supabase` passé ici doit TOUJOURS être
 * le client "au nom de l'utilisateur" (voir src/db/client.ts) : c'est LA
 * RLS qui garantit qu'un non-membre n'obtient aucune ligne, ce module n'en
 * est qu'une lecture pratique.
 */

export interface ClubSummary {
  id: string;
  slug: string;
  name: string;
  shortName: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  timezone: string;
  status: ClubStatus;
  ffbbClubId: string;
  ffbbEnabled: boolean;
  ffbbNextSyncAt: string | null;
}

export interface ClubContext {
  club: ClubSummary;
  membershipId: string;
  roles: ClubRole[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapClubRow(row: {
  id: string;
  slug: string;
  name: string;
  short_name: string | null;
  logo_url: string | null;
  accent_color: string | null;
  timezone: string;
  status: ClubStatus;
  ffbb_club_id: string;
  ffbb_enabled: boolean;
  ffbb_next_sync_at: string | null;
}): ClubSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    shortName: row.short_name,
    logoUrl: row.logo_url,
    accentColor: row.accent_color,
    timezone: row.timezone,
    ffbbClubId: row.ffbb_club_id,
    ffbbEnabled: row.ffbb_enabled,
    ffbbNextSyncAt: row.ffbb_next_sync_at,
    status: row.status,
  };
}

/**
 * Résout le contexte club pour un identifiant de route (UUID ou slug — le
 * frontend peut utiliser l'un ou l'autre, voir docs/API.md) et un
 * utilisateur donné. Renvoie `null` aussi bien si le club n'existe pas QUE
 * si l'utilisateur n'en est pas membre actif : l'appelant ne doit jamais
 * pouvoir distinguer les deux cas (jamais révéler l'existence d'un club à
 * un non-membre).
 */
export async function getClubContext(supabase: DbClient, clubIdOrSlug: string, userId: string): Promise<ClubContext | null> {
  const query = supabase.from("clubs").select("id, slug, name, short_name, logo_url, accent_color, timezone, status, ffbb_club_id, ffbb_enabled, ffbb_next_sync_at");
  const { data: club, error: clubError } = UUID_PATTERN.test(clubIdOrSlug)
    ? await query.eq("id", clubIdOrSlug).maybeSingle()
    : await query.eq("slug", clubIdOrSlug).maybeSingle();

  if (clubError || !club) return null;

  const { data: membership, error: membershipError } = await supabase
    .from("club_memberships")
    .select("id")
    .eq("club_id", club.id)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (membershipError || !membership) return null;

  const { data: roleRows, error: rolesError } = await supabase.from("membership_roles").select("role").eq("membership_id", membership.id);

  if (rolesError) {
    throw new Error(`Impossible de charger les rôles du membership : ${rolesError.message}`);
  }

  return {
    club: mapClubRow(club),
    membershipId: membership.id,
    roles: (roleRows ?? []).map((r) => r.role),
  };
}

/** Variante stricte : 404 si le club n'existe pas ou n'a pas cet utilisateur pour membre actif. */
export async function requireClubContext(supabase: DbClient, clubIdOrSlug: string, userId: string): Promise<ClubContext> {
  const context = await getClubContext(supabase, clubIdOrSlug, userId);
  if (!context) throw notFound("Club introuvable.");
  return context;
}
