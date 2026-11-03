import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../db/types.js";
import type { EMarqueMatchData } from "../types.js";
import { persistEmarqueMatchData } from "./persist-emarque-match.js";

const SENTINEL_LICENSE = "SENTINEL-LIC-LOG";
const DB_ERROR = { message: "boom", code: "XX000" };

/** Chaîne PostgREST permissive : tout enchaînement se résout en `result`. */
function chain(result: unknown): unknown {
  const handler: ProxyHandler<() => void> = {
    get: (_target, prop) => (prop === "then" ? (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve) : () => proxy),
  };
  const proxy: unknown = new Proxy(() => undefined, handler);
  return proxy;
}

// `licencies` échoue en lecture comme en écriture ; le reste se passe bien.
const supabase = {
  from(table: string) {
    if (table === "licencies") return chain({ data: null, error: DB_ERROR });
    if (table === "emarque_imports") return chain({ data: { id: "import-1" }, error: null });
    if (table === "matches") return chain({ data: { is_home: true, team_id: null }, error: null });
    return chain({ data: [], error: null });
  },
} as unknown as SupabaseClient<Database>;

const data: EMarqueMatchData = {
  match: {
    rencontreNumero: "2813", competitionLabel: null, pouleLabel: null, date: null, heure: null, lieu: null,
    homeTeamName: null, awayTeamName: null, homeClubCode: null, awayClubCode: null, scoreHome: 1, scoreAway: 0, scoreByPeriod: [],
  },
  players: [{ teamSide: "home", jerseyNumber: "4", lastName: "Test", firstName: "Joueur", licenseNumber: SENTINEL_LICENSE, isCaptain: false, isStarter: true, confidence: 1 }],
  coaches: [],
  officials: [],
  tableOfficials: [],
  playerStats: [],
  shotData: { experimental: true, documentPresent: false },
  quality: { warnings: [], overallConfidence: null },
};

afterEach(() => vi.restoreAllMocks());

describe("persistEmarqueMatchData — journaux", () => {
  it("n'écrit jamais le n° de licence quand la recherche ou l'auto-provisionnement échoue", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await persistEmarqueMatchData(supabase, { matchId: "match-1", clubId: "club-1", fileHash: "a".repeat(64), sourceFileName: null, storagePath: null, parserVersion: "test", data }).catch(() => undefined);

    const logged = consoleError.mock.calls.map((call) => String(call[0]));
    // Garde contre un faux positif : les deux chemins ont bien journalisé.
    expect(logged.some((line) => line.includes("Recherche licencié par numéro de licence échouée"))).toBe(true);
    expect(logged.some((line) => line.includes("Auto-provisionnement d'un licencié depuis e-Marque échoué"))).toBe(true);
    expect(logged.join("\n")).not.toContain(SENTINEL_LICENSE);
  });
});
