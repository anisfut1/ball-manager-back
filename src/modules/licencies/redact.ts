import type { LicencieDto } from "../../contracts/licencies.js";
import type { ClubRole } from "../../db/types.js";
import { hasAnyRole } from "../../tenancy/roles.js";

/**
 * Champs d'identité ou de contact qu'un membre ordinaire du club ne doit pas
 * lire (audit S-1, mineurs inclus). Les autres champs restent visibles : la
 * forme de la réponse ne change pas, seule la valeur passe à `null`.
 */
export const SENSITIVE_LICENCIE_FIELDS = ["birthDate", "email", "phone", "licenseNumber", "ffbbLicenceId"] as const satisfies readonly (keyof LicencieDto)[];

/** Rôles qui voient tous les licenciés du club. */
export const LICENCIE_PRIVILEGED_ROLES: readonly ClubRole[] = ["club_admin", "correspondant_club"];

/** Qui regarde : calculé une fois par requête, jamais par licencié. */
export interface LicencieViewer {
  /** `club_admin` ou `correspondant_club` : tout le club. */
  privileged: boolean;
  /** Équipes dont le viewer est coach : `"ALL"` si un rôle `coach` n'a pas de portée (même règle que `actorFromAccount`). */
  coachTeamIds: "ALL" | ReadonlySet<string>;
  /** Licencié pointé par `club_memberships.licencie_id`, `null` si le compte n'est rattaché à personne. */
  ownLicencieId: string | null;
}

/** Assemble le viewer à partir des rôles du club et de l'acteur déjà chargé (`actorFromAccount`). */
export function buildLicencieViewer(roles: readonly ClubRole[], actor: { coachTeamIds: "ALL" | ReadonlySet<string>; licencieId: string | null }): LicencieViewer {
  return { privileged: hasAnyRole(roles, LICENCIE_PRIVILEGED_ROLES), coachTeamIds: actor.coachTeamIds, ownLicencieId: actor.licencieId };
}

/** Un licencié sans équipe n'appartient à aucune portée de coach : seuls les privilégiés et lui-même le voient en entier. */
export function canViewSensitive(licencie: Pick<LicencieDto, "id" | "teamId">, viewer: LicencieViewer): boolean {
  if (viewer.privileged) return true;
  if (viewer.ownLicencieId !== null && viewer.ownLicencieId === licencie.id) return true;
  if (licencie.teamId === null) return false;
  return viewer.coachTeamIds === "ALL" || viewer.coachTeamIds.has(licencie.teamId);
}

/** Fiche telle que ce viewer a le droit de la lire : champs sensibles à `null` sinon. */
export function redactLicencieForViewer(licencie: LicencieDto, viewer: LicencieViewer): LicencieDto {
  if (canViewSensitive(licencie, viewer)) return licencie;
  return { ...licencie, birthDate: null, email: null, phone: null, licenseNumber: null, ffbbLicenceId: null };
}
