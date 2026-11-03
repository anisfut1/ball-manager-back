import { boundMap } from "../../security/bounded-map.js";

/** Une demande par adresse et par minute, par instance (anti-rafale, sans dépendance externe). */
export const RESET_COOLDOWN_MS = 60_000;
/** Plafond dur de la mémoire : expirées d'abord, puis les plus anciennes. */
export const MAX_RESET_COOLDOWN_ENTRIES = 10_000;

const lastResetAt = new Map<string, number>();

/** `true` si une demande pour cette adresse est autorisée maintenant (et la compte). */
export function claimResetSlot(email: string, now = Date.now()): boolean {
  const last = lastResetAt.get(email);
  if (last !== undefined && now - last < RESET_COOLDOWN_MS) return false;
  lastResetAt.delete(email);
  boundMap(lastResetAt, MAX_RESET_COOLDOWN_ENTRIES, (at) => now - at >= RESET_COOLDOWN_MS);
  lastResetAt.set(email, now);
  return true;
}

/** Pour les tests. */
export function resetCooldownSize(): number {
  return lastResetAt.size;
}

/** Pour les tests. */
export function clearResetCooldown(): void {
  lastResetAt.clear();
}
