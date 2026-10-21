import { describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../db/client.js";
import type { SharedFbiSession } from "../../jobs/shared-session.js";
import { FbiError } from "../../integrations/fbi/errors.js";
import { createDerogationInSession } from "./create-derogation.js";

const PARAMS = { clubId: "club-a", matchId: "m1", motif: "Coach indisponible", modifierDate: false, dateDerogation: null, modifierHoraire: true, horaire: "12:00", inverserRencontre: false, inverserEquipe: false, submittedBy: null };

describe("createDerogationInSession", () => {
  it("erreur FBI inattendue : message réel renvoyé (jamais une erreur interne muette) et tentative tracée", async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const db = { from: vi.fn(() => ({ insert })) } as unknown as DbClient;
    const shared = { client: { createDerogation: vi.fn(() => Promise.reject(new Error("Écran de recherche des dérogations injoignable"))) }, session: {} } as unknown as SharedFbiSession;

    const result = await createDerogationInSession(db, shared, PARAMS, { numero: "5018", division: null });

    expect(result).toEqual({ outcome: "unknown", message: "Envoi FBI interrompu : Écran de recherche des dérogations injoignable. Vérifie sur FBI avant de réessayer.", notSent: false });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ match_id: "m1", outcome: "unknown" }));
  });

  it("FBI injoignable avant l'enregistrement : marqué « rien n'a été envoyé » (mise en attente possible)", async () => {
    const db = { from: vi.fn(() => ({ insert: vi.fn(() => Promise.resolve({ error: null })) })) } as unknown as DbClient;
    const shared = { client: { createDerogation: vi.fn(() => Promise.reject(new FbiError("Formulaire injoignable (net::ERR_CONNECTION_TIMED_OUT)", "NAVIGATION_FAILED"))) }, session: {} } as unknown as SharedFbiSession;
    const result = await createDerogationInSession(db, shared, PARAMS, { numero: "5018", division: "DMU11" });
    expect(result).toMatchObject({ outcome: "unknown", notSent: true });
    expect(result.message).toContain("rien n'a été envoyé");
  });
});
