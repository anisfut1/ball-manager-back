import { describe, expect, it, vi } from "vitest";
import type { SharedFbiSession } from "../../jobs/shared-session.js";
import { depositedSince, fbiDepositKey, verifyCreationOnFbi, verifyResponseOnFbi } from "./fbi-verify.js";

const shared = (fetch: () => Promise<unknown>) => ({ client: { fetchDerogationForMatch: vi.fn(fetch) }, session: {} }) as unknown as SharedFbiSession;
// 22/10/2026 18:10 heure de Paris = 16:10 UTC.
const SENT_AT = new Date("2026-10-22T16:10:00Z");

describe("vérification automatique sur FBI d'un envoi incertain (2026-10-22)", () => {
  it("dates de dépôt FBI comparées en heure de Paris, à quelques minutes près", () => {
    expect(fbiDepositKey("22/10/2026 18:12")).toBe("202610221812");
    expect(depositedSince("22/10/2026 18:12", SENT_AT)).toBe(true);
    expect(depositedSince("22/10/2026 18:07", SENT_AT)).toBe(true); // marge de 5 min
    expect(depositedSince("22/10/2026 09:48", SENT_AT)).toBe(false); // dérogation plus ancienne du même match
    expect(depositedSince("22/10/2026", SENT_AT)).toBe(true); // sans heure : même jour
    expect(depositedSince(null, SENT_AT)).toBe(false);
  });

  it("création : déposée depuis l'envoi → envoyée ; aucune ou plus ancienne → absente (renvoi sans doublon) ; FBI illisible → à revoir", async () => {
    expect(await verifyCreationOnFbi(shared(async () => ({ dateDepot: "22/10/2026 18:11" })), "5018", "DMU11", SENT_AT)).toBe("sent");
    expect(await verifyCreationOnFbi(shared(async () => null), "5018", "DMU11", SENT_AT)).toBe("absent");
    expect(await verifyCreationOnFbi(shared(async () => ({ dateDepot: "20/10/2026 10:00" })), "5018", "DMU11", SENT_AT)).toBe("absent");
    expect(await verifyCreationOnFbi(shared(async () => Promise.reject(new Error("timeout"))), "5018", "DMU11", SENT_AT)).toBe("unknown");
  });

  it("réponse : plus « En Cours » → passée ; toujours en attente du club → absente ; autre dérogation ou illisible → à revoir", async () => {
    const target = { numero: "9538", division: "DM2", idDerogation: "id-1", isHome: true, demandeur: "Visiteur" };
    expect(await verifyResponseOnFbi(shared(async () => ({ idDerogation: "id-1", etat: "Acceptée par les deux associations sportives" })), target)).toBe("sent");
    expect(await verifyResponseOnFbi(shared(async () => ({ idDerogation: "id-1", etat: "En Cours", demandeur: "Visiteur" })), target)).toBe("absent");
    expect(await verifyResponseOnFbi(shared(async () => ({ idDerogation: "id-2", etat: "En Cours" })), target)).toBe("unknown");
    expect(await verifyResponseOnFbi(shared(async () => Promise.reject(new Error("timeout"))), target)).toBe("unknown");
  });
});
