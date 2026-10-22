import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../db/client.js";
import type { SharedFbiSession } from "../../jobs/shared-session.js";
import { FbiError } from "../../integrations/fbi/errors.js";
import { createDerogationInSession, VERIFY_LATER_MESSAGE } from "./create-derogation.js";

const PARAMS = { clubId: "club-a", matchId: "m1", motif: "Coach indisponible", modifierDate: false, dateDerogation: null, modifierHoraire: true, horaire: "12:00", inverserRencontre: false, inverserEquipe: false, submittedBy: null };

describe("createDerogationInSession", () => {
  it("erreur FBI inattendue : message réel renvoyé (jamais une erreur interne muette) et tentative tracée", async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const db = { from: vi.fn(() => ({ insert })) } as unknown as DbClient;
    const shared = { client: { createDerogation: vi.fn(() => Promise.reject(new Error("Écran de recherche des dérogations injoignable"))) }, session: {} } as unknown as SharedFbiSession;

    const result = await createDerogationInSession(db, shared, PARAMS, { numero: "5018", division: null });

    // Envoi incertain et FBI illisible : l'outil revérifiera lui-même (jamais « vérifie sur FBI » à la personne).
    expect(result).toEqual({ outcome: "unknown", message: VERIFY_LATER_MESSAGE, verifyLater: true });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ match_id: "m1", outcome: "unknown", fbi_message: "Envoi FBI interrompu : Écran de recherche des dérogations injoignable." }));
  });

  it("envoi incertain relu sur FBI : dérogation déposée depuis l'envoi → succès ; aucune → renvoi automatique (rien n'a été envoyé)", async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const db = { from: vi.fn(() => ({ insert })) } as unknown as DbClient;
    const since = new Date("2026-10-22T16:10:00Z");
    const fbiWith = (found: unknown) =>
      ({ client: { createDerogation: vi.fn(() => Promise.reject(new Error("Timeout 30000ms exceeded"))), fetchDerogationForMatch: vi.fn(async () => found) }, session: {} }) as unknown as SharedFbiSession;

    expect(await createDerogationInSession(db, fbiWith({ dateDepot: "22/10/2026 18:11" }), PARAMS, { numero: "5018", division: "DMU11" }, { since })).toEqual({ outcome: "success", message: null });
    expect(insert).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "success" }));
    expect(await createDerogationInSession(db, fbiWith(null), PARAMS, { numero: "5018", division: "DMU11" }, { since })).toMatchObject({ outcome: "unknown", notSent: true });
  });

  it("FBI injoignable avant l'enregistrement : marqué « rien n'a été envoyé » (mise en attente possible)", async () => {
    const db = { from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ error: null })) })) } as unknown as DbClient;
    const shared = { client: { createDerogation: vi.fn(() => Promise.reject(new FbiError("Formulaire injoignable (net::ERR_CONNECTION_TIMED_OUT)", "NAVIGATION_FAILED"))) }, session: {} } as unknown as SharedFbiSession;
    const result = await createDerogationInSession(db, shared, PARAMS, { numero: "5018", division: "DMU11" });
    expect(result).toMatchObject({ outcome: "unknown", notSent: true });
    expect(result.message).toContain("rien n'a été envoyé");
  });
});
