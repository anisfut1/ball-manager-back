import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";

const SENTINEL_EMAIL = "sentinel-log@example.invalid";
const NEW_CLUB_ID = "bbbbbbbb-0000-0000-0000-000000000000";

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return { ...actual, verifyAccessToken: vi.fn(async () => ({ id: "platform", email: "platform@example.test" })) };
});

// Création du club réussie, mais l'invitation échoue (lecture du club en erreur).
function fakeDb() {
  const base = buildFakeClubSupabase(makeFakeClubSupabaseState({ isPlatformAdmin: true }));
  const originalFrom = base.from.bind(base) as (table: string) => unknown;
  return Object.assign(base, {
    from: (table: string) => {
      if (table !== "clubs") return originalFrom(table);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (_column: string, value: string) => {
          selectedById = value === NEW_CLUB_ID;
          return chain;
        },
        insert: () => ({ select: () => ({ single: async () => ({ data: { id: NEW_CLUB_ID, slug: "nouveau" }, error: null }) }) }),
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => (selectedById ? { data: null, error: { message: "boom" } } : { data: null, error: null }),
      };
      let selectedById = false;
      return chain;
    },
  });
}

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => fakeDb(),
  createServiceSupabaseClient: () => fakeDb(),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /v1/platform/clubs — journaux", () => {
  it("n'écrit jamais l'e-mail du premier admin dans les journaux quand l'invitation échoue", async () => {
    const res = await app.request("/v1/platform/clubs", {
      method: "POST",
      headers: { authorization: "Bearer test-jwt", "content-type": "application/json" },
      body: JSON.stringify({ name: "Nouveau", ffbbClubId: "N1", adminEmail: SENTINEL_EMAIL }),
    });

    expect(res.status).toBe(201);
    expect((await res.json()).adminInviteError).toContain("invitation de l'admin a échoué");

    // Garde contre un faux positif : l'échec a bien été journalisé.
    const logged = JSON.stringify([...consoleError.mock.calls, ...consoleLog.mock.calls]);
    expect(logged).toContain("Invitation du premier admin de club échouée");
    expect(logged).not.toContain(SENTINEL_EMAIL);
    expect(logged).not.toContain("sentinel-log");
  });
});
