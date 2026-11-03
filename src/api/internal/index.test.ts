import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const timingSafeEqualSpy = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

const processOutbox = vi.fn(async () => ({ enabled: false }));

vi.mock("../../db/client.js", () => ({
  createServiceSupabaseClient: () => ({}),
  createUserSupabaseClient: () => ({}),
  createAnonSupabaseClient: () => ({}),
}));
vi.mock("../../modules/push/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/push/service.js")>();
  return { ...actual, processOutbox: (...args: unknown[]) => (processOutbox as (...a: unknown[]) => unknown)(...args) };
});

const { app } = await import("../../app.js");
const { resetEnvCacheForTests } = await import("../../config/env.js");

const SECRET = "test-cron-secret-not-real-0000";
const originalSecret = process.env.CRON_SECRET;

function call(authorization?: string) {
  return app.request("/internal/cron/push", { headers: authorization === undefined ? {} : { authorization } });
}

async function expectRefused(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Route interne protégée par CRON_SECRET." } });
  expect(processOutbox).not.toHaveBeenCalled();
}

beforeEach(() => {
  processOutbox.mockClear();
  process.env.CRON_SECRET = SECRET;
  resetEnvCacheForTests();
});

afterEach(() => {
  process.env.CRON_SECRET = originalSecret;
  resetEnvCacheForTests();
  vi.restoreAllMocks();
});

describe("/internal/* — protection par CRON_SECRET", () => {
  it("accepte le bon secret", async () => {
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(processOutbox).toHaveBeenCalledTimes(1);
  });

  it("compare via timingSafeEqual sur des condensés de longueur fixe, même si les longueurs diffèrent", async () => {
    timingSafeEqualSpy.mockClear();
    await call(`Bearer ${SECRET}x`);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
    const [a, b] = timingSafeEqualSpy.mock.calls[0] as [Buffer, Buffer];
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
  });

  it("refuse un secret faux de même longueur", async () => {
    await expectRefused(await call(`Bearer ${"x".repeat(SECRET.length)}`));
  });

  it("refuse un secret de longueur différente (plus court, plus long)", async () => {
    await expectRefused(await call(`Bearer ${SECRET.slice(0, -1)}`));
    await expectRefused(await call(`Bearer ${SECRET}x`));
  });

  it("refuse l'absence d'en-tête, un en-tête vide ou sans schéma Bearer", async () => {
    await expectRefused(await call());
    await expectRefused(await call(""));
    await expectRefused(await call("Bearer "));
    await expectRefused(await call(SECRET));
  });

  it("ne donne aucun accès quand CRON_SECRET n'est pas défini côté serveur", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.CRON_SECRET;
    resetEnvCacheForTests();
    for (const header of [`Bearer ${SECRET}`, "Bearer ", "Bearer undefined", undefined]) {
      const response = await call(header);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(processOutbox).not.toHaveBeenCalled();
  });
});
