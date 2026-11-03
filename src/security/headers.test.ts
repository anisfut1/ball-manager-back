import { describe, expect, it } from "vitest";
import { app } from "../app.js";

const ORIGIN = "http://localhost:3000"; // FRONTEND_ORIGINS dans vitest.setup.ts

function expectApiHeaders(res: Response) {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("strict-transport-security")).toContain("max-age=");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(res.headers.has("x-powered-by")).toBe(false);
}

describe("en-têtes de sécurité (S-12a)", () => {
  it("GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expectApiHeaders(res);
  });

  it("GET /openapi.json (réponse JSON)", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    expectApiHeaders(res);
  });

  it("réponse d'erreur 401 d'une route authentifiée", async () => {
    const res = await app.request("/v1/me");
    expect(res.status).toBe(401);
    expectApiHeaders(res);
  });

  it("réponse d'erreur 404", async () => {
    const res = await app.request("/nexiste-pas");
    expect(res.status).toBe(404);
    expectApiHeaders(res);
  });

  it("les en-têtes CORS d'une requête normale depuis une origine autorisée sont conservés", async () => {
    const res = await app.request("/health", { headers: { origin: ORIGIN } });
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expectApiHeaders(res);
  });

  it("préflight OPTIONS depuis une origine autorisée : en-têtes CORS inchangés", async () => {
    const res = await app.request("/v1/me", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type,Authorization,X-Personal-Link-Token,X-BM-As");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,PATCH,DELETE");
  });

  it("origine non autorisée : toujours aucun Access-Control-Allow-Origin", async () => {
    const res = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("/docs a sa propre CSP (scripts et styles de Swagger UI), les autres routes gardent la CSP stricte", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("default-src *");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
