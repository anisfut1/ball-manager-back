import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets de l'authentification d'appareil (module PUR, testé).
 *
 * - Secret de session : `bmd_` + 32 octets aléatoires (base64url). Haute
 *   entropie, jamais dérivé d'une donnée devinable. Seul son SHA-256 est en base.
 * - Code d'autorisation : 32 octets aléatoires (base64url), usage unique, court.
 * - PKCE (RFC 7636) : seule la méthode S256 est acceptée (jamais `plain`).
 */
export const DEVICE_SESSION_PREFIX = "bmd_";

export function generateSessionSecret(): string {
  return `${DEVICE_SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function generateAuthCode(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function looksLikeSessionSecret(value: string | undefined | null): value is string {
  return typeof value === "string" && value.startsWith(DEVICE_SESSION_PREFIX) && /^bmd_[A-Za-z0-9_-]{40,64}$/.test(value);
}

/** `code_verifier` RFC 7636 : 43 à 128 caractères non réservés. */
export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return typeof verifier === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/** `code_challenge` S256 : base64url du SHA-256 (43 caractères). */
export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Comparaison en temps constant du challenge recalculé et du challenge enregistré. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  const a = Buffer.from(s256Challenge(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
