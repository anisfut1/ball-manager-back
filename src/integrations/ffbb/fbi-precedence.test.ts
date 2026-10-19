import { describe, expect, it } from "vitest";
import { applyFbiPrecedence } from "./fbi-precedence.js";

const base = { club_id: "club-1", ffbb_match_id: "m-1" };
// 19/10/2026 15:00 à Paris = 13:00 UTC ; FBI a corrigé à 17:00 (15:00 UTC).
const ffbbDatetime = "2026-10-19T13:00:00.000Z";
const fbiDatetime = "2026-10-19T15:00:00+00:00";

describe("applyFbiPrecedence", () => {
  it("garde l'heure FBI tant que FFBB renvoie l'heure que FBI a corrigée", () => {
    const row = applyFbiPrecedence({ ...base, match_datetime: ffbbDatetime }, { match_datetime: fbiDatetime, venue_raw_label: null }, [
      { field: "match_datetime", ffbbValueReplaced: "19/10/2026 15:00" },
    ]);
    expect(row.match_datetime).toBe(fbiDatetime);
  });

  it("prend la nouvelle heure FFBB si FFBB a changé depuis la correction FBI", () => {
    const row = applyFbiPrecedence({ ...base, match_datetime: "2026-10-26T13:00:00.000Z" }, { match_datetime: fbiDatetime, venue_raw_label: null }, [
      { field: "match_datetime", ffbbValueReplaced: "19/10/2026 15:00" },
    ]);
    expect(row.match_datetime).toBe("2026-10-26T13:00:00.000Z");
  });

  it("garde la salle FBI tant que FFBB renvoie la salle corrigée", () => {
    const row = applyFbiPrecedence({ ...base, venue_raw_label: "GYMNASE A — 1 rue" }, { match_datetime: null, venue_raw_label: "SALLE B" }, [
      { field: "venue_raw_label", ffbbValueReplaced: "GYMNASE A — 1 rue" },
    ]);
    expect(row.venue_raw_label).toBe("SALLE B");
  });

  it("ne touche à rien sans correction FBI ou pour un match nouveau", () => {
    const incoming = { ...base, match_datetime: ffbbDatetime, venue_raw_label: "GYMNASE A" };
    expect(applyFbiPrecedence(incoming, { match_datetime: fbiDatetime, venue_raw_label: "SALLE B" }, [])).toEqual(incoming);
    expect(applyFbiPrecedence(incoming, null, [{ field: "venue_raw_label", ffbbValueReplaced: "GYMNASE A" }])).toEqual(incoming);
  });
});
