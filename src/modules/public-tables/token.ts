import { randomBytes, createHash } from "node:crypto";

/**
 * Jeton personnel sans compte (retour du club, 2026-09-29). Haute entropie
 * (32 octets aléatoires), jamais un identifiant devinable — c'est LA seule
 * preuve d'identité de ce flux, il doit résister au brute-force.
 */
export function generatePublicToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Jamais le jeton en clair en base (voir migration) — seul le hash est comparé/stocké. */
export function hashPublicToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Durée de vie d'un lien personnel : 7 jours (décision 2026-11-04). Au-delà, le licencié en redemande un. */
export const PERSONAL_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Code d'erreur renvoyé au web et à l'app pour afficher « Lien expiré, demandez-en un nouveau ». */
export const PERSONAL_LINK_EXPIRED_CODE = "PERSONAL_LINK_EXPIRED";

/**
 * Un lien est expiré à partir de `expires_at` (borne incluse). Date absente ou
 * illisible = expiré : on échoue toujours du côté fermé.
 */
export function isPersonalLinkExpired(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) || at <= now.getTime();
}
