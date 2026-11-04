import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logError, logInfo, redactSensitive } from "./logger.js";

/** Les messages d'erreur d'origine (Supabase, fournisseurs) peuvent contenir une adresse ou un jeton : ils ne doivent jamais atteindre les logs. */
describe("redactSensitive", () => {
  it("masque les adresses e-mail", () => {
    expect(redactSensitive('duplicate key value (email)=(lina.martin@example.test) already exists')).toBe("duplicate key value (email)=([email]) already exists");
  });

  it("masque plusieurs adresses, majuscules et sous-adresses comprises", () => {
    expect(redactSensitive("a+tag@Example.COM puis b@c.fr")).toBe("[email] puis [email]");
  });

  it("masque les jetons Bearer et les JWT", () => {
    expect(redactSensitive("Authorization: Bearer abc.DEF-123_xyz~+/=")).toBe("Authorization: Bearer [redacted]");
    expect(redactSensitive("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl fin")).toBe("jwt [redacted] fin");
  });

  it("masque token= / secret= / password= dans une URL ou une requête", () => {
    expect(redactSensitive("GET /me?token=abcDEF123_-&x=1")).toBe("GET /me?token=[redacted]&x=1");
    expect(redactSensitive("password=hunter2 secret: s3cr3t")).toBe("password=[redacted] secret: [redacted]");
  });

  it("laisse intact un texte sans donnée sensible", () => {
    expect(redactSensitive("Création du lien personnel échouée : timeout")).toBe("Création du lien personnel échouée : timeout");
  });
});

describe("logError / logInfo", () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void out.push(line));
    vi.spyOn(console, "log").mockImplementation((line: string) => void out.push(line));
  });
  afterEach(() => vi.restoreAllMocks());

  it("nettoie le message d'une Error, sa stack et le message de tête", () => {
    logError("échec pour lina@example.test", new Error("conflit sur lina@example.test"));
    const line = JSON.parse(out[0]!) as { message: string; errorMessage: string; stack: string };
    expect(line.message).toBe("échec pour [email]");
    expect(line.errorMessage).toBe("conflit sur [email]");
    expect(line.stack).not.toContain("lina@example.test");
  });

  it("nettoie une erreur non-Error (chaîne ou objet)", () => {
    logError("x", "boom lina@example.test");
    logError("y", { message: "refus pour lina@example.test", code: 23505 });
    expect(out.join("\n")).not.toContain("lina@example.test");
    expect(JSON.parse(out[1]!)).toMatchObject({ error: { code: 23505 } });
  });

  it("nettoie aussi le contexte et logInfo", () => {
    logError("x", undefined, { detail: "lina@example.test", licenceId: 42 });
    logInfo("envoi à lina@example.test", { to: "lina@example.test" });
    expect(out.join("\n")).not.toContain("lina@example.test");
    expect(JSON.parse(out[0]!)).toMatchObject({ licenceId: 42 });
  });

  it("garde level, timestamp et structure", () => {
    logError("ok");
    expect(JSON.parse(out[0]!)).toMatchObject({ level: "error", message: "ok" });
  });

  it("ne plante pas sur une erreur circulaire", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(() => logError("x", loop)).not.toThrow();
    expect(out).toHaveLength(1);
  });
});
