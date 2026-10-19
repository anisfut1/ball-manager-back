import { describe, expect, it } from "vitest";
import { activeLeaseUntil } from "./local-lease.js";

describe("activeLeaseUntil", () => {
  const now = new Date("2026-10-19T12:00:00Z");

  it("renvoie la fin du bail tant qu'il court (le worker local a la main)", () => {
    expect(activeLeaseUntil("2026-10-19T12:20:00Z", now)).toEqual(new Date("2026-10-19T12:20:00Z"));
  });

  it("rend la main à Vercel quand le bail est expiré, vide, absent ou illisible", () => {
    expect(activeLeaseUntil("2026-10-19T11:59:00Z", now)).toBeNull();
    expect(activeLeaseUntil("", now)).toBeNull();
    expect(activeLeaseUntil(null, now)).toBeNull();
    expect(activeLeaseUntil(undefined, now)).toBeNull();
    expect(activeLeaseUntil("pas une date", now)).toBeNull();
  });
});
