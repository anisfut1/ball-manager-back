import { describe, expect, it } from "vitest";
import { pickCreationRow } from "./browser-client.js";

describe("pickCreationRow (ligne « A Créer » de la rencontre)", () => {
  it("division écrite autrement par FBI (poule, espaces) : retrouvée", () => {
    expect(pickCreationRow([{ numero: "5018", division: "DM U11 - Poule A" }], "5018", "DMU11")).toBe(0);
    expect(pickCreationRow([{ numero: "5018", division: "DMU11" }], "5018", "DMU11")).toBe(0);
  });
  it("même numéro dans une autre division : jamais pris", () => {
    expect(pickCreationRow([{ numero: "5018", division: "PRF" }], "5018", "DMU11")).toBe(-1);
    expect(pickCreationRow([{ numero: "5018", division: "PRF" }, { numero: "5018", division: "DMU11A" }], "5018", "DMU11")).toBe(1);
  });
  it("division inconnue : le numéro suffit ; numéro absent : -1", () => {
    expect(pickCreationRow([{ numero: "12", division: "X" }, { numero: "5018", division: "Y" }], "5018", null)).toBe(1);
    expect(pickCreationRow([{ numero: "12", division: "X" }], "5018", "DMU11")).toBe(-1);
  });
});
