import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { app } from "./app.js";

const saved = process.env.VERCEL_ENV;

function setVercelEnv(value: string | undefined) {
  if (value === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = value;
}

beforeEach(() => setVercelEnv(undefined));
afterEach(() => setVercelEnv(saved));

describe("/docs (Swagger UI) selon l'environnement (S-11)", () => {
  it("404 au format d'erreur JSON en production", async () => {
    setVercelEnv("production");
    const res = await app.request("/docs");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route introuvable." } });
  });

  it.each(["preview", "development", undefined])("200 quand VERCEL_ENV vaut %s", async (value) => {
    setVercelEnv(value);
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("/openapi.json", () => {
  // Reste PUBLIC en production pour l'instant : ball-manager-app/scripts/generate-api-types.mjs:21
  // télécharge https://club-manager-api-two.vercel.app/openapi.json pour générer ses types.
  // Quand ce script ne dépendra plus de l'URL de production, cacher cette route et inverser ce test.
  it("répond 200 en production (rappel : consommé par l'app mobile)", async () => {
    setVercelEnv("production");
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("paths");
  });

  it("répond 200 en preview", async () => {
    setVercelEnv("preview");
    expect((await app.request("/openapi.json")).status).toBe(200);
  });
});
