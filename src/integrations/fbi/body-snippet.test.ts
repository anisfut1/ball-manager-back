import { describe, expect, it } from "vitest";
import { readBodyWithin } from "./body-snippet.js";

describe("readBodyWithin", () => {
  it("renvoie le texte quand la lecture aboutit", async () => {
    expect(await readBodyWithin(() => Promise.resolve("corps"), 50)).toBe("corps");
  });

  it("renvoie null quand la lecture échoue (page naviguée)", async () => {
    expect(await readBodyWithin(() => Promise.reject(new Error("Target closed")), 50)).toBeNull();
  });

  it("renvoie null quand la lecture ne se termine JAMAIS (navigation en cours), sans bloquer", async () => {
    const started = Date.now();
    expect(await readBodyWithin(() => new Promise<string>(() => {}), 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("traite un corps vide comme absent", async () => {
    expect(await readBodyWithin(() => Promise.resolve(""), 50)).toBeNull();
  });

  it("ne laisse pas de minuterie pendante quand la lecture aboutit", async () => {
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    await readBodyWithin(() => Promise.resolve("ok"), 60_000);
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBeLessThanOrEqual(before);
  });
});
