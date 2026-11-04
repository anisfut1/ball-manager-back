import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Garde-fou SQL (B1, audit sécurité 2026-11) : les droits d'écriture de `anon`
 * et `TRUNCATE` (que la RLS ne filtre pas) ne doivent plus être accordés.
 * Teste le texte des migrations : aucune base n'est lancée en CI.
 */
const DIR = join(import.meta.dirname, "../../supabase/migrations");
const MIGRATION = "20261104100000_revoke_anon_writes_and_truncate.sql";
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const sql = (name: string) => readFileSync(join(DIR, name), "utf8").replace(/--.*$/gm, "").toLowerCase().replace(/\s+/g, " ");

describe("migration B1 — droits anon / authenticated", () => {
  it("la migration existe", () => expect(files).toContain(MIGRATION));

  const text = files.includes(MIGRATION) ? sql(MIGRATION) : "";

  it("retire à anon toute écriture sur les tables du schéma public", () => {
    expect(text).toContain("revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon");
  });

  it("n'accorde à anon que l'insertion du journal du worker FBI (policy à jeton)", () => {
    const grants = [...text.matchAll(/grant ([^;]+?) to anon\b/g)].map((m) => m[1]);
    expect(grants).toEqual(["insert on public.fbi_probe_events"]);
  });

  it("retire TRUNCATE, REFERENCES et TRIGGER à authenticated", () => {
    expect(text).toContain("revoke truncate, references, trigger on all tables in schema public from authenticated");
  });

  it("couvre aussi les tables futures (droits par défaut)", () => {
    expect(text).toMatch(/alter default privileges for role postgres in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon/);
    expect(text).toMatch(/alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from authenticated/);
  });

  it("aucune migration ultérieure ne rend ces droits", () => {
    const later = files.filter((f) => f > MIGRATION);
    for (const name of later) {
      expect(sql(name), name).not.toMatch(/grant [^;]*\b(truncate|references|trigger|all)\b[^;]* to [^;]*\b(anon|authenticated)\b/);
      expect(sql(name), name).not.toMatch(/grant [^;]*\b(insert|update|delete)\b[^;]* on [^;]*\b to [^;]*\banon\b/);
    }
  });
});
