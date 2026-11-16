import { describe, expect, it } from "vitest";
import { TOO_MANY_ATTEMPTS } from "./browser-client.js";

describe("TOO_MANY_ATTEMPTS (connexion FBI refusée au premier envoi, 2026-11-16)", () => {
  it("reconnaît le message de FBI, quelle que soit la casse", () => {
    expect(TOO_MANY_ATTEMPTS.test("Trop de tentatives de connexion, veuillez réessayer")).toBe(true);
    expect(TOO_MANY_ATTEMPTS.test("TROP DE TENTATIVE")).toBe(true);
  });
  it("jamais sur un simple refus d'identifiants", () => {
    expect(TOO_MANY_ATTEMPTS.test("Identifiant ou mot de passe incorrect")).toBe(false);
  });
});
