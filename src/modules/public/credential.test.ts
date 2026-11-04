import { describe, expect, it } from "vitest";
import { personalTokenFrom, type RequestLike } from "./credential.js";

/** Le lien personnel ne voyage plus qu'en en-tête : jamais dans l'URL (journaux, Referer, historique). */
function req(opts: { header?: string; query?: string }): RequestLike {
  return { header: (name) => (name.toLowerCase() === "x-personal-link-token" ? opts.header : undefined), query: (name) => (name === "token" ? opts.query : undefined) };
}

describe("personalTokenFrom", () => {
  it("lit l'en-tête X-Personal-Link-Token", () => {
    expect(personalTokenFrom(req({ header: "abc123456" }))).toBe("abc123456");
  });

  it("ignore ?token= (l'ancien transport est retiré)", () => {
    expect(personalTokenFrom(req({ query: "abc123456" }))).toBeNull();
  });

  it("l'en-tête prime, et un ?token= différent n'est jamais pris", () => {
    expect(personalTokenFrom(req({ header: "from-header", query: "from-query" }))).toBe("from-header");
  });

  it("rien : null", () => {
    expect(personalTokenFrom(req({}))).toBeNull();
  });

  it("en-tête vide : null (jamais un repli sur l'URL)", () => {
    expect(personalTokenFrom(req({ header: "", query: "from-query" }))).toBeNull();
  });
});
