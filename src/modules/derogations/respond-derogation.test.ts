import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../db/client.js";
import type { SharedFbiSession } from "../../jobs/shared-session.js";
import { FbiError } from "../../integrations/fbi/errors.js";
import { respondToDerogationInSession } from "./respond-derogation.js";
import { VERIFY_LATER_MESSAGE } from "./create-derogation.js";

const PARAMS = { clubId: "club-a", derogationCheckId: "check-1", decision: "accepted" as const, motifRefus: null, submittedBy: null };
const TARGET = { check: { fbi_row_key: "row-1" }, match: { id: "m1", numero: "9315" }, division: null, idDerogation: "id-fbi" } as never;
const db = { from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ error: null })) })) } as unknown as DbClient;
const sharedFailing = (error: Error) => ({ client: { respondToDerogation: vi.fn(() => Promise.reject(error)) }, session: {} }) as unknown as SharedFbiSession;

describe("respondToDerogationInSession", () => {
  it("FBI injoignable avant l'envoi : « rien n'a été envoyé » (mise en attente du poste du club possible, 2026-10-22)", async () => {
    const result = await respondToDerogationInSession(db, sharedFailing(new FbiError("Écran de recherche des dérogations injoignable", "NAVIGATION_FAILED")), PARAMS, TARGET);
    expect(result).toMatchObject({ outcome: "unknown", notSent: true });
    expect(result.message).toContain("rien n'a été envoyé");
  });

  it("autre erreur : état incertain relu sur FBI — réponse passée → succès ; toujours en attente → renvoi ; illisible → revérifiée plus tard", async () => {
    const fbi = (found: unknown) =>
      ({ client: { respondToDerogation: vi.fn(() => Promise.reject(new Error("Timeout 30000ms exceeded"))), fetchDerogationForMatch: vi.fn(async () => found) }, session: {} }) as unknown as SharedFbiSession;
    const target = { check: { fbi_row_key: "row-1", demandeur: "Visiteur" }, match: { id: "m1", numero: "9538", is_home: true }, division: "DM2", idDerogation: "id-fbi" } as never;
    expect(await respondToDerogationInSession(db, fbi({ idDerogation: "id-fbi", etat: "Acceptée par les deux associations sportives" }), PARAMS, target)).toEqual({ outcome: "success", message: null });
    expect(await respondToDerogationInSession(db, fbi({ idDerogation: "id-fbi", etat: "En Cours" }), PARAMS, target)).toMatchObject({ outcome: "unknown", notSent: true });
    expect(await respondToDerogationInSession(db, sharedFailing(new Error("Bouton Accepter introuvable")), PARAMS, target)).toEqual({ outcome: "unknown", message: VERIFY_LATER_MESSAGE, verifyLater: true });
  });
});
