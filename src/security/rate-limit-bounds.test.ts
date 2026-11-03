import { beforeEach, describe, expect, it } from "vitest";
import { boundMap } from "./bounded-map.js";
import { checkRateLimit, hitRateLimit, MAX_RATE_LIMIT_BUCKETS, rateLimitBucketCount, resetRateLimits } from "./rate-limit.js";
import { claimResetSlot, clearResetCooldown, MAX_RESET_COOLDOWN_ENTRIES, resetCooldownSize } from "../modules/account/reset-cooldown.js";

describe("checkRateLimit", () => {
  beforeEach(resetRateLimits);

  it("renvoie les secondes restantes avant la levée", () => {
    const t0 = 1_000_000;
    expect(checkRateLimit("k", 1, 60_000, t0)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(checkRateLimit("k", 1, 60_000, t0 + 20_000)).toEqual({ allowed: false, retryAfterSeconds: 40 });
    expect(checkRateLimit("k", 1, 60_000, t0 + 60_000).allowed).toBe(true);
  });

  it("hitRateLimit garde son comportement booléen", () => {
    expect(hitRateLimit("k", 2, 60_000, 0)).toBe(true);
    expect(hitRateLimit("k", 2, 60_000, 1)).toBe(true);
    expect(hitRateLimit("k", 2, 60_000, 2)).toBe(false);
  });
});

describe("plafond de la mémoire du limiteur", () => {
  beforeEach(resetRateLimits);

  it("reste borné, même avec des entrées toutes actives : les plus anciennes partent d'abord", () => {
    const now = 5_000_000;
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS + 50; i++) hitRateLimit(`actif-${i}`, 1, 3_600_000, now + i);
    expect(rateLimitBucketCount()).toBeLessThanOrEqual(MAX_RATE_LIMIT_BUCKETS);
    // la plus ancienne a été évincée (sa limite repart à zéro), la plus récente est conservée
    expect(hitRateLimit("actif-0", 1, 3_600_000, now + 100_000)).toBe(true);
    expect(hitRateLimit(`actif-${MAX_RATE_LIMIT_BUCKETS + 49}`, 1, 3_600_000, now + 100_000)).toBe(false);
  });

  it("les entrées expirées partent avant les entrées actives", () => {
    const now = 9_000_000;
    for (let i = 0; i < MAX_RATE_LIMIT_BUCKETS - 1; i++) hitRateLimit(`vieux-${i}`, 1, 1_000, now);
    hitRateLimit("actif", 1, 3_600_000, now);
    hitRateLimit("nouveau", 1, 3_600_000, now + 10_000); // les « vieux-* » ont expiré
    expect(rateLimitBucketCount()).toBeLessThan(10);
    expect(hitRateLimit("actif", 1, 3_600_000, now + 10_001)).toBe(false); // l'entrée active est conservée
  });
});

describe("plafond du délai de réinitialisation par adresse", () => {
  beforeEach(clearResetCooldown);

  it("1 demande par minute et par adresse", () => {
    expect(claimResetSlot("a@x.test", 0)).toBe(true);
    expect(claimResetSlot("a@x.test", 59_999)).toBe(false);
    expect(claimResetSlot("a@x.test", 60_000)).toBe(true);
  });

  it("purge les expirées puis reste borné", () => {
    for (let i = 0; i < MAX_RESET_COOLDOWN_ENTRIES; i++) claimResetSlot(`vieux-${i}@x.test`, 0);
    expect(resetCooldownSize()).toBe(MAX_RESET_COOLDOWN_ENTRIES);
    claimResetSlot("nouveau@x.test", 120_000); // tout le reste a expiré
    expect(resetCooldownSize()).toBe(1);

    clearResetCooldown();
    for (let i = 0; i < MAX_RESET_COOLDOWN_ENTRIES + 50; i++) claimResetSlot(`actif-${i}@x.test`, 1_000_000 + i);
    expect(resetCooldownSize()).toBeLessThanOrEqual(MAX_RESET_COOLDOWN_ENTRIES);
    expect(claimResetSlot("actif-0@x.test", 1_000_000 + 60)).toBe(true); // évincée
    expect(claimResetSlot(`actif-${MAX_RESET_COOLDOWN_ENTRIES + 49}@x.test`, 1_000_000 + 60)).toBe(false); // conservée
  });
});

describe("boundMap", () => {
  it("ne fait rien sous le plafond", () => {
    const m = new Map([["a", 1]]);
    boundMap(m, 5, () => true);
    expect(m.size).toBe(1);
  });
});
