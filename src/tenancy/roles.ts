import type { ClubRole } from "../db/types.js";

export type { ClubRole };

/**
 * Copié depuis ball-manager-web src/lib/permissions/roles.ts (module déjà pur, aucun
 * changement de logique). `club_admin` = tous les droits SUR UN CLUB,
 * distinct de `platform_admin` (opérateur de la plateforme, table séparée
 * `platform_admins`) — voir docs/MULTI_TENANCY.md.
 */
export const ROLE_LABELS: Record<ClubRole, string> = {
  club_admin: "Administrateur du club",
  correspondant_club: "Correspondant club",
  responsable_tables: "Responsable tables",
  coach: "Coach",
  joueur: "Joueur",
  parent: "Parent",
};

export function hasRole(roles: readonly ClubRole[], role: ClubRole): boolean {
  return roles.includes(role);
}

export function hasAnyRole(roles: readonly ClubRole[], allowed: readonly ClubRole[]): boolean {
  return allowed.some((role) => roles.includes(role));
}

export function isClubAdmin(roles: readonly ClubRole[]): boolean {
  return hasRole(roles, "club_admin");
}
