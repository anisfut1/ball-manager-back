import { createServiceSupabaseClient, type DbClient } from "../../db/client.js";
import { canViewSensitive, type LicencieViewer } from "./redact.js";

/**
 * Lecture d'une fiche en deux temps (audit S-1, lot 2b) :
 *  1. colonnes PUBLIQUES avec le client lié à l'utilisateur (la RLS filtre les lignes) ;
 *  2. colonnes SENSIBLES avec le client service role, UNIQUEMENT pour les
 *     licenciés que `canViewSensitive` autorise — jamais avant la décision.
 * Le droit de lecture direct des colonnes sensibles est retiré à
 * `authenticated` (migration 20261023090000) : seul ce back les lit.
 * Fonctionne avant comme après la migration.
 */
export const LICENCIE_PUBLIC_COLUMNS =
  "id, club_id, first_name, last_name, photo_url, team_id, active, category_label, sexe, public_admin, public_coach, public_coordinator, coached_team_ids";
export const LICENCIE_SENSITIVE_COLUMNS = "id, birth_date, license_number, email, phone, ffbb_licence_id";

export interface PublicLicencieRow {
  id: string;
  club_id: string;
  first_name: string;
  last_name: string;
  photo_url: string | null;
  team_id: string | null;
  active: boolean;
  category_label: string | null;
  sexe: "M" | "F" | null;
  public_admin: boolean;
  public_coach: boolean;
  public_coordinator: boolean;
  coached_team_ids: string[] | null;
}

export interface SensitiveLicencieFields {
  birth_date: string | null;
  license_number: string | null;
  email: string | null;
  phone: string | null;
  ffbb_licence_id: string | null;
}

const NO_SENSITIVE: SensitiveLicencieFields = { birth_date: null, license_number: null, email: null, phone: null, ffbb_licence_id: null };

/** Ne garde que les colonnes publiques, même si le client renvoie davantage. */
export function pickPublicFields(row: PublicLicencieRow): PublicLicencieRow {
  return {
    id: row.id,
    club_id: row.club_id,
    first_name: row.first_name,
    last_name: row.last_name,
    photo_url: row.photo_url,
    team_id: row.team_id,
    active: row.active,
    category_label: row.category_label,
    sexe: row.sexe,
    public_admin: row.public_admin,
    public_coach: row.public_coach,
    public_coordinator: row.public_coordinator,
    coached_team_ids: row.coached_team_ids,
  };
}

/** Plafond d'identifiants par requête : garde l'URL PostgREST sous les limites usuelles (~6 Ko). */
const IDS_PER_QUERY = 150;

/**
 * Colonnes sensibles des seuls licenciés que ce viewer peut lire. Une requête
 * service role (par lot de 150 identifiants au plus, jamais une par licencié),
 * toujours bornée au club. Un viewer privilégié lit tout le club en une requête.
 * Aucun licencié autorisé : aucune requête, le client service role n'est même pas créé.
 */
export async function loadSensitiveFields(
  clubId: string,
  rows: readonly Pick<PublicLicencieRow, "id" | "team_id">[],
  viewer: LicencieViewer,
  serviceClient: () => DbClient = createServiceSupabaseClient,
): Promise<Map<string, SensitiveLicencieFields>> {
  const allowed = rows.filter((row) => canViewSensitive({ id: row.id, teamId: row.team_id }, viewer)).map((row) => row.id);
  const result = new Map<string, SensitiveLicencieFields>();
  if (allowed.length === 0) return result;

  const service = serviceClient();
  const queries =
    viewer.privileged
      ? [service.from("licencies").select(LICENCIE_SENSITIVE_COLUMNS).eq("club_id", clubId)]
      : Array.from({ length: Math.ceil(allowed.length / IDS_PER_QUERY) }, (_, i) =>
          service
            .from("licencies")
            .select(LICENCIE_SENSITIVE_COLUMNS)
            .eq("club_id", clubId)
            .in("id", allowed.slice(i * IDS_PER_QUERY, (i + 1) * IDS_PER_QUERY)),
        );

  const allowedSet = new Set(allowed);
  for (const { data, error } of await Promise.all(queries)) {
    if (error) throw new Error(`Lecture des données personnelles échouée : ${error.message}`);
    for (const row of (data ?? []) as (SensitiveLicencieFields & { id: string })[]) {
      if (!allowedSet.has(row.id)) continue;
      result.set(row.id, { birth_date: row.birth_date, license_number: row.license_number, email: row.email, phone: row.phone, ffbb_licence_id: row.ffbb_licence_id });
    }
  }
  return result;
}

export function sensitiveOrNull(map: ReadonlyMap<string, SensitiveLicencieFields>, id: string): SensitiveLicencieFields {
  return map.get(id) ?? NO_SENSITIVE;
}
