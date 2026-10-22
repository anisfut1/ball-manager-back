import { describe, expect, it } from "vitest";
import { requestsSettledByFbi, settledMessage, type FbiDerogationRow } from "./fbi-settle.js";

const request = { id: "req-1", matchId: "match-5018", createdAt: "2026-10-21T08:10:30.477Z" };
const accepted: FbiDerogationRow = { matchId: "match-5018", etat: "Acceptée par les deux associations sportives", dateDepot: "22/10/2026 09:48", heureDemandee: "12:00", dateRencontreDemandee: null };

describe("requestsSettledByFbi", () => {
  it("ferme la demande quand une dérogation acceptée a été déposée après elle (match 5018, déposée à la main sur FBI)", () => {
    expect(requestsSettledByFbi([request], [accepted])).toEqual([{ request, derogation: accepted }]);
  });

  it("ignore une dérogation en cours, refusée ou d'un autre match", () => {
    const rows: FbiDerogationRow[] = [
      { ...accepted, etat: "En Cours" },
      { ...accepted, etat: "Refusée par l'organisme dirigeant" },
      { ...accepted, matchId: "autre" },
    ];
    expect(requestsSettledByFbi([request], rows)).toEqual([]);
  });

  it("ignore une dérogation acceptée déposée avant la demande", () => {
    expect(requestsSettledByFbi([request], [{ ...accepted, dateDepot: "20/10/2026 18:00" }])).toEqual([]);
  });

  it("accepte une dérogation déposée le jour même de la demande", () => {
    expect(requestsSettledByFbi([request], [{ ...accepted, dateDepot: "21/10/2026 07:00" }])).toHaveLength(1);
  });

  it("message lisible dans la conversation", () => {
    expect(settledMessage(accepted)).toBe("Dérogation trouvée sur FBI (déposée le 22/10/2026 09:48, demandé : 12:00) — Acceptée par les deux associations sportives. Demande marquée comme traitée.");
  });
});
