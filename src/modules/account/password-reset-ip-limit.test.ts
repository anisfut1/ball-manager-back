import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let users: { id: string; email: string; last_sign_in_at: string | null }[] = [];
let links: { type: string; email: string }[] = [];

const fakeDb = {
  auth: {
    admin: {
      listUsers: async () => ({ data: { users }, error: null }),
      generateLink: async ({ type, email }: { type: string; email: string }) => {
        links.push({ type, email });
        return { data: { user: users.find((u) => u.email === email) ?? { id: "new", email }, properties: { hashed_token: `hash-${type}`, verification_type: type } }, error: null };
      },
    },
  },
};

vi.mock("../../db/client.js", () => ({
  createServiceSupabaseClient: () => fakeDb,
  createUserSupabaseClient: () => fakeDb,
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");
const { resetEnvCacheForTests } = await import("../../config/env.js");
const { resetRateLimits } = await import("../../security/rate-limit.js");

function reset(email: string, ip: string) {
  return app.request("/v1/account/password-reset", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T10:00:00Z"));
  process.env.RESEND_API_KEY = "re_test_not_real";
  process.env.PUBLIC_APP_URL = "https://www.app.test";
  resetEnvCacheForTests();
  resetRateLimits();
  users = [{ id: "u1", email: "lea@club.test", last_sign_in_at: "2026-10-01T10:00:00Z" }];
  links = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "e" }), { status: 200 })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.PUBLIC_APP_URL;
  resetEnvCacheForTests();
});

describe("POST /v1/account/password-reset — limite par IP (S-7)", () => {
  it("6 adresses différentes depuis une même IP : la 6e reçoit 429 RATE_LIMITED avec Retry-After", async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await reset(`cible${i}@club.test`, "203.0.113.7");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: true });
    }
    const res = await reset("cible6@club.test", "203.0.113.7");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: "RATE_LIMITED", message: expect.any(String) } });
    expect(Number(res.headers.get("retry-after"))).toBe(900);
  });

  it("Retry-After diminue avec le temps écoulé", async () => {
    for (let i = 1; i <= 5; i++) await reset(`cible${i}@club.test`, "203.0.113.7");
    vi.advanceTimersByTime(5 * 60_000);
    const res = await reset("cible6@club.test", "203.0.113.7");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBe(600);
  });

  it("deux IP différentes ne se gênent pas", async () => {
    for (let i = 1; i <= 5; i++) await reset(`cible${i}@club.test`, "203.0.113.7");
    expect((await reset("cible6@club.test", "203.0.113.7")).status).toBe(429);
    expect((await reset("cible6@club.test", "198.51.100.9")).status).toBe(200);
  });

  it("la limite par adresse (1/min) fonctionne toujours", async () => {
    await reset("lea@club.test", "203.0.113.7");
    await reset("lea@club.test", "198.51.100.9");
    expect(links).toEqual([{ type: "recovery", email: "lea@club.test" }]);
  });

  it("réponse identique pour une adresse qui existe et une qui n'existe pas, y compris à la limite", async () => {
    const known = await reset("lea@club.test", "203.0.113.1");
    const unknown = await reset("inconnu@club.test", "203.0.113.2");
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());

    for (let i = 1; i <= 4; i++) await reset(`x${i}@club.test`, "203.0.113.3");
    await reset("lea@club.test", "203.0.113.3"); // 5e : 200
    const limitedKnown = await reset("lea@club.test", "203.0.113.3");
    for (let i = 1; i <= 5; i++) await reset(`y${i}@club.test`, "203.0.113.4");
    const limitedUnknown = await reset("inconnu@club.test", "203.0.113.4");
    expect(limitedKnown.status).toBe(429);
    expect(limitedUnknown.status).toBe(429);
    expect(await limitedKnown.json()).toEqual(await limitedUnknown.json());
  });

  it("la limite se lève après 15 minutes", async () => {
    for (let i = 1; i <= 5; i++) await reset(`cible${i}@club.test`, "203.0.113.7");
    expect((await reset("cible6@club.test", "203.0.113.7")).status).toBe(429);
    vi.advanceTimersByTime(15 * 60_000);
    expect((await reset("cible6@club.test", "203.0.113.7")).status).toBe(200);
  });

  it("une adresse invalide (400) ne consomme pas la limite de l'IP", async () => {
    for (let i = 0; i < 10; i++) expect((await reset("pas-un-email", "203.0.113.7")).status).toBe(400);
    expect((await reset("ok@club.test", "203.0.113.7")).status).toBe(200);
  });

  it("429 et 404 depuis une origine autorisée portent Access-Control-Allow-Origin (sinon le navigateur masque l'erreur)", async () => {
    const origin = "http://localhost:3000";
    for (let i = 1; i <= 5; i++) await reset(`cible${i}@club.test`, "203.0.113.7");
    const limited = await app.request("/v1/account/password-reset", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", origin },
      body: JSON.stringify({ email: "cible6@club.test" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("access-control-allow-origin")).toBe(origin);
    expect(limited.headers.get("x-content-type-options")).toBe("nosniff");

    const missing = await app.request("/nexiste-pas", { headers: { origin } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(origin);
  });
});
