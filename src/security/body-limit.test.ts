import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { app } from "../app.js";
import { MAX_EXPORT_BYTES } from "../modules/licencies/fbi-licence-export.js";
import { MAX_LICENCIE_PHOTO_BYTES } from "../storage/licencie-photos.js";
import { FBI_EXPORT_BODY_LIMIT_BYTES, GLOBAL_BODY_LIMIT_BYTES, requestBodyLimit } from "./body-limit.js";

const ORIGIN = "http://localhost:3000";
const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body });

describe("limites de taille des corps (S-12b) — middleware seul, avec espion", () => {
  function miniApp() {
    const handler = vi.fn((c: { json: (b: unknown) => Response }) => c.json({ ok: true }));
    const mini = new Hono();
    mini.use("*", requestBodyLimit());
    mini.post("*", handler as never);
    return { mini, handler };
  }

  it("un corps juste sous la limite globale passe", async () => {
    const { mini, handler } = miniApp();
    const res = await mini.request("/v1/x", { method: "POST", body: "a".repeat(GLOBAL_BODY_LIMIT_BYTES) });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("un corps juste au-dessus : 413 au format d'erreur JSON, handler jamais appelé", async () => {
    const { mini, handler } = miniApp();
    const res = await mini.request("/v1/x", { method: "POST", body: "a".repeat(GLOBAL_BODY_LIMIT_BYTES + 1) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: "PAYLOAD_TOO_LARGE", message: expect.any(String) } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("Content-Length annoncé trop grand : 413 sans lire le corps", async () => {
    const { mini, handler } = miniApp();
    const res = await mini.request("/v1/x", { method: "POST", headers: { "content-length": String(GLOBAL_BODY_LIMIT_BYTES + 1) }, body: "petit" });
    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("l'import du fichier FBI a sa propre limite, plus haute (juste sous : passe, juste au-dessus : 413)", async () => {
    const { mini, handler } = miniApp();
    const path = "/v1/clubs/c1/licencies/import/file";
    const over = await mini.request(path, { method: "POST", body: new Uint8Array(FBI_EXPORT_BODY_LIMIT_BYTES + 1) });
    expect(over.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
    const under = await mini.request(path, { method: "POST", body: new Uint8Array(FBI_EXPORT_BODY_LIMIT_BYTES) });
    expect(under.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("la limite plus haute ne s'applique qu'à cette route et à cette méthode", async () => {
    const { mini } = miniApp();
    const big = new Uint8Array(GLOBAL_BODY_LIMIT_BYTES + 1);
    expect((await mini.request("/v1/clubs/c1/licencies/import", { method: "POST", body: big })).status).toBe(413);
    expect((await mini.request("/v1/clubs/c1/licencies/import/file/autre", { method: "POST", body: big })).status).toBe(413);
  });

  it("tout le corps accepté tient sous la limite de Vercel (4,5 Mo) : sinon Vercel coupe avant la fonction, erreur opaque (B6)", () => {
    const VERCEL_BODY_LIMIT_BYTES = 4_500_000; // lecture la plus stricte de « 4,5 Mo »
    expect(FBI_EXPORT_BODY_LIMIT_BYTES).toBeLessThan(VERCEL_BODY_LIMIT_BYTES);
    expect(MAX_EXPORT_BYTES).toBe(4 * 1024 * 1024);
  });

  it("la limite du fichier FBI couvre le plafond du handler (4 Mio) plus l'enveloppe multipart", () => {
    expect(FBI_EXPORT_BODY_LIMIT_BYTES).toBeGreaterThan(MAX_EXPORT_BYTES);
    expect(FBI_EXPORT_BODY_LIMIT_BYTES - MAX_EXPORT_BYTES).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("limites de taille des corps (S-12b) — application complète", () => {
  it("413 depuis une origine autorisée : Access-Control-Allow-Origin et en-têtes de sécurité présents", async () => {
    const res = await post("/v1/account/password-reset", "a".repeat(GLOBAL_BODY_LIMIT_BYTES + 1));
    expect(res.status).toBe(413);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ error: { code: "PAYLOAD_TOO_LARGE", message: expect.any(String) } });
  });

  it("un corps juste sous la limite atteint la route (réponse inchangée : 400 de validation)", async () => {
    const res = await post("/v1/account/password-reset", "a".repeat(GLOBAL_BODY_LIMIT_BYTES));
    expect(res.status).toBe(400);
  });

  it("le téléversement de photo à 512 Ko décodés n'est pas bloqué (arrive à l'authentification)", async () => {
    const data = Buffer.alloc(MAX_LICENCIE_PHOTO_BYTES, 1).toString("base64");
    const body = JSON.stringify({ contentType: "image/webp", data });
    expect(body.length).toBeLessThan(GLOBAL_BODY_LIMIT_BYTES);
    const res = await post("/v1/clubs/c1/licencies/l1/photo", body);
    expect(res.status).toBe(401);
  });

  it("l'import du fichier FBI : juste sous sa limite arrive à l'authentification, au-dessus : 413", async () => {
    const path = "/v1/clubs/c1/licencies/import/file";
    expect((await post(path, new Uint8Array(FBI_EXPORT_BODY_LIMIT_BYTES), { "content-type": "multipart/form-data; boundary=x" })).status).toBe(401);
    expect((await post(path, new Uint8Array(FBI_EXPORT_BODY_LIMIT_BYTES + 1), { "content-type": "multipart/form-data; boundary=x" })).status).toBe(413);
  });

  it("les requêtes sans corps ne sont pas touchées", async () => {
    expect((await app.request("/health")).status).toBe(200);
  });
});
