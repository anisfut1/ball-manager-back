import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";
import { resultsTableGenericRows } from "./selectors.js";

/**
 * Régression B3 (blocages intermittents de fetchAllDerogations sur Chromium 156) : lire le tableau cellule
 * par cellule avec `locator.textContent()` ATTEND jusqu'à 30 s une cellule qui disparaît quand l'AJAX
 * rafraîchit le tableau entre le `count()` et la lecture. La lecture doit être un instantané unique.
 */
const HANG = new Promise<string | null>(() => {});

function fakeScope(opts: { headers: string[]; grid: string[][]; cellReadsHang?: boolean }): Page {
  const rows = {
    count: async () => opts.grid.length,
    // Instantané atomique : un seul aller-retour, sans attente automatique.
    evaluateAll: async () => opts.grid,
    // Ancienne lecture cellule par cellule : bloquerait comme sur le runner.
    nth: (r: number) => ({
      locator: () => ({
        count: async () => opts.grid[r]?.length ?? 0,
        nth: (c: number) => ({ textContent: () => (opts.cellReadsHang ? HANG : Promise.resolve(opts.grid[r]?.[c] ?? null)) }),
      }),
    }),
  };
  const headerCells = { allTextContents: async () => opts.headers };
  return { locator: (selector: string) => (selector.includes("th") ? headerCells : rows) } as unknown as Page;
}

const withDeadline = <T>(promise: Promise<T>, ms = 1000): Promise<T | "TIMEOUT"> => Promise.race([promise, new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), ms))]);

describe("resultsTableGenericRows", () => {
  it("associe chaque cellule à son en-tête, en-têtes et cellules nettoyés", async () => {
    const scope = fakeScope({ headers: [" N° ", "Équipe", "Statut"], grid: [[" 12 ", "U15 F", " En attente "], ["13", "U13 M", "Accepté"]] });
    expect(await resultsTableGenericRows(scope)).toEqual([
      { "N°": "12", Équipe: "U15 F", Statut: "En attente" },
      { "N°": "13", Équipe: "U13 M", Statut: "Accepté" },
    ]);
  });

  it("ignore les colonnes sans en-tête et les cellules au-delà des en-têtes", async () => {
    const scope = fakeScope({ headers: ["A", "", "C"], grid: [["a1", "b1", "c1", "d1"]] });
    expect(await resultsTableGenericRows(scope)).toEqual([{ A: "a1", C: "c1" }]);
  });

  it("une ligne sans cellule est ignorée", async () => {
    const scope = fakeScope({ headers: ["A"], grid: [[], ["x"]] });
    expect(await resultsTableGenericRows(scope)).toEqual([{ A: "x" }]);
  });

  it("une ligne plus courte que les en-têtes ne lit que ses cellules", async () => {
    const scope = fakeScope({ headers: ["A", "B", "C"], grid: [["a1", "b1"]] });
    expect(await resultsTableGenericRows(scope)).toEqual([{ A: "a1", B: "b1" }]);
  });

  it("null quand la page n'a pas de tableau (aucun en-tête, ou en-têtes vides)", async () => {
    expect(await resultsTableGenericRows(fakeScope({ headers: [], grid: [] }))).toBeNull();
    expect(await resultsTableGenericRows(fakeScope({ headers: ["", " "], grid: [["x"]] }))).toBeNull();
  });

  it("tableau sans ligne : liste vide, pas null", async () => {
    expect(await resultsTableGenericRows(fakeScope({ headers: ["A"], grid: [] }))).toEqual([]);
  });

  it("ne dépend jamais d'une lecture cellule par cellule : une cellule qui ne répond plus ne bloque rien", async () => {
    const scope = fakeScope({ headers: ["A", "B"], grid: [["a1", "b1"], ["a2", "b2"]], cellReadsHang: true });
    expect(await withDeadline(resultsTableGenericRows(scope))).toEqual([
      { A: "a1", B: "b1" },
      { A: "a2", B: "b2" },
    ]);
  });
});
