import { createHash } from "node:crypto";
import { boundMap } from "./bounded-map.js";

/**
 * Limiteur de débit en mémoire, par instance (fenêtre fixe). Suffisant
 * contre les rafales d'un même visiteur ; pas un plafond global entre
 * instances Vercel (voir docs : constat A-6). Les clés sont hachées : aucune
 * IP ni adresse n'est conservée en clair.
 */
const buckets = new Map<string, { start: number; count: number; windowMs: number }>();

/** Plafond dur : au-delà, les entrées expirées partent d'abord, puis les plus anciennes même actives. */
export const MAX_RATE_LIMIT_BUCKETS = 10_000;

/** Compte une tentative. `retryAfterSeconds` : secondes avant la levée de la limite (0 si la tentative passe). */
export function checkRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
  const id = createHash("sha256").update(key).digest("base64url");
  const bucket = buckets.get(id);
  if (!bucket || now - bucket.start >= windowMs) {
    buckets.delete(id);
    boundMap(buckets, MAX_RATE_LIMIT_BUCKETS, (b) => now - b.start >= b.windowMs);
    buckets.set(id, { start: now, count: 1, windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (bucket.count >= limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.start + windowMs - now) / 1000)) };
  bucket.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function hitRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  return checkRateLimit(key, limit, windowMs, now).allowed;
}

/** Pour les tests : nombre d'entrées en mémoire. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}

/** Pour les tests. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** IP du visiteur derrière le proxy Vercel (premier élément de x-forwarded-for). */
export function clientIp(header: string | undefined): string {
  return header?.split(",")[0]?.trim() || "unknown";
}
