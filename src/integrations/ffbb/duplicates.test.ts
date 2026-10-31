import { describe, expect, it } from "vitest";
import { isExemptMatch, latestPerUniqueKey } from "./duplicates.js";

const m = (ffbbId: string, uniqueKey: string | null, engagement = "e-u11-2") => ({ ffbbId, uniqueKey, ourEngagementFfbbId: engagement });

describe("latestPerUniqueKey (doublons FFBB, U11 2 M, 2026-10-23)", () => {
  it("même rencontre renvoyée deux fois (ancien et nouveau calendrier) : la fiche la plus récente est gardée", () => {
    const old5201 = m("200000014865174", "200000003063875_1_5201");
    const new5201 = m("200000014865652", "200000003063875_1_5201");
    const single = m("200000014865664", "200000003063875_2_5213");
    const { kept, superseded } = latestPerUniqueKey([old5201, new5201, single]);
    expect(kept).toEqual([new5201, single]);
    expect(superseded).toEqual([old5201]);
  });

  it("identifiants comparés comme des nombres, jamais comme du texte", () => {
    const { kept } = latestPerUniqueKey([m("99", "k"), m("100", "k")]);
    expect(kept.map((x) => x.ffbbId)).toEqual(["100"]);
  });

  it("sans clé de rencontre, ou deux équipes du club dans la même rencontre : rien n'est écarté", () => {
    const noKey = [m("1", null), m("2", null)];
    expect(latestPerUniqueKey(noKey).kept).toHaveLength(2);
    const derby = [m("5", "k", "e-u11-1"), m("5", "k", "e-u11-2")];
    expect(latestPerUniqueKey(derby).kept).toHaveLength(2);
  });
});

describe("isExemptMatch (exempts du 22/11, U15 1 M et Seniors F, 2026-10-31)", () => {
  it("adversaire vide ou « Exempt » : pas un match", () => {
    expect(isExemptMatch({ opponentName: "" })).toBe(true);
    expect(isExemptMatch({ opponentName: null })).toBe(true);
    expect(isExemptMatch({ opponentName: "  " })).toBe(true);
    expect(isExemptMatch({ opponentName: "Exempt" })).toBe(true);
    expect(isExemptMatch({ opponentName: "ST GELY BASKETBALL - 1" })).toBe(false);
  });
});
