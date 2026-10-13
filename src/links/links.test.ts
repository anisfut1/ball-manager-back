import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "../config/env.js";
import { appLinks, linkBaseUrl, links, paths } from "./links.js";

describe("BallManagerLinkService", () => {
  afterEach(() => {
    delete process.env.PUBLIC_APP_URL;
    resetEnvCacheForTests();
  });

  it("une ressource = un chemin /public/{slug}/… (web, Universal Links, push)", () => {
    const l = links("https://www.ball-manager.fr/");
    expect(l.match("sc-sete-basket", "m 1")).toBe("https://www.ball-manager.fr/public/sc-sete-basket/matchs/m%201");
    expect(l.convocation("sc-sete-basket", "m1")).toBe("https://www.ball-manager.fr/public/sc-sete-basket/matchs/m1#convocation");
    expect(l.derogation("sc-sete-basket", "r1")).toBe("https://www.ball-manager.fr/public/sc-sete-basket/derogations/r1");
    expect(l.training("sc-sete-basket", { id: "o1", teamId: "t1" }, "coach")).toBe("https://www.ball-manager.fr/public/sc-sete-basket/entrainements?equipe=t1&seance=o1");
    expect(l.training("sc-sete-basket", { id: "o1", teamId: "t1" }, "family")).toBe("https://www.ball-manager.fr/public/sc-sete-basket/accueil#seance-o1");
    expect(l.loginCode("sc-sete-basket", "abc")).toBe("https://www.ball-manager.fr/public/sc-sete-basket/connexion/code/abc");
    expect(paths.match("sc-sete-basket", "m1")).toBe("/public/sc-sete-basket/matchs/m1");
  });

  it("le lien personnel historique garde exactement son format (liens déjà envoyés)", () => {
    expect(links("https://www.ball-manager.fr").personalLink("sc-sete-basket", "accueil", "a+b")).toBe("https://www.ball-manager.fr/public/sc-sete-basket/accueil?token=a%2Bb");
  });

  it("base : PUBLIC_APP_URL d'abord, sinon une origine autorisée, jamais une origine arbitraire", () => {
    expect(linkBaseUrl("https://evil.example")).toBe("http://localhost:3000");
    expect(linkBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    process.env.PUBLIC_APP_URL = "https://www.ball-manager.fr/";
    resetEnvCacheForTests();
    expect(appLinks("http://localhost:3000").clubHome("x")).toBe("https://www.ball-manager.fr/public/x/accueil");
  });
});
