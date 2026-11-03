import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";

/**
 * Lot 2b : les colonnes sensibles de `licencies` ne sont lues qu'avec le client
 * service role, APRÈS la décision d'autorisation. Un espion enregistre chaque
 * requête sur `licencies` avec le client utilisé, les colonnes demandées et
 * les filtres posés.
 */
interface Call {
  client: "user" | "service";
  table: string;
  columns: string | undefined;
  ops: [string, unknown[]][];
}

let state: FakeClubSupabaseState;
let calls: Call[];
let currentUserId = "u-admin";

// Enveloppe récursive : enregistre chaque méthode de chaîne appelée sur la requête.
function recording<T extends object>(target: T, call: Call): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (typeof prop === "string" && prop !== "then") call.ops.push([prop, args]);
        const result = value.apply(obj, args);
        return result && typeof result === "object" && !(result instanceof Promise) ? recording(result, call) : result;
      };
    },
  });
}

function spyClient(client: "user" | "service") {
  const base = buildFakeClubSupabase(state);
  return new Proxy(base, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (prop !== "from") return value;
      return (table: string) => {
        const builder = value.call(obj, table);
        return new Proxy(builder, {
          get(b, p, r) {
            const fn = Reflect.get(b, p, r);
            if (p !== "select" || typeof fn !== "function") return fn;
            return (columns?: string, ...rest: unknown[]) => {
              const call: Call = { client, table, columns, ops: [] };
              calls.push(call);
              return recording(fn.call(b, columns, ...rest), call);
            };
          },
        });
      };
    },
  });
}

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return { ...actual, verifyAccessToken: vi.fn(async () => ({ id: currentUserId, email: `${currentUserId}@example.test` })) };
});
vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => spyClient("user"),
  createServiceSupabaseClient: () => spyClient("service"),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

const CLUB_A = { id: "aaaaaaaa-0000-0000-0000-000000000000", slug: "club-a", name: "Club A", short_name: null, logo_url: null, accent_color: null, timezone: "Europe/Paris", status: "active" as const, ffbb_club_id: "AAA0000001", ffbb_enabled: true, ffbb_next_sync_at: null };
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const SENSITIVE = ["birth_date", "license_number", "email", "phone", "ffbb_licence_id"];

function lic(id: string, teamId: string | null, extra: Partial<FakeLicencieRow> = {}): FakeLicencieRow {
  return { id, club_id: CLUB_A.id, first_name: id, last_name: "NOM", license_number: `LIC-${id}`, birth_date: "1901-01-01", email: `${id}@example.invalid`, phone: "+33000000099", photo_url: null, active: true, team_id: teamId, ffbb_licence_id: `FFBB-${id}`, ...extra };
}

const get = (path: string) => app.request(`/v1/clubs/${CLUB_A.id}/licencies${path}`, { headers: { authorization: "Bearer t" } });
const licenciesCalls = (client: Call["client"]) => calls.filter((c) => c.client === client && c.table === "licencies");
const opsOf = (call: Call, name: string) => call.ops.filter(([n]) => n === name).map(([, args]) => args);

beforeEach(() => {
  calls = [];
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }],
    memberships: [
      { id: "m-admin", club_id: CLUB_A.id, user_id: "u-admin", status: "active" },
      { id: "m-coach-t1", club_id: CLUB_A.id, user_id: "u-coach-t1", status: "active" },
      { id: "m-coach-t2", club_id: CLUB_A.id, user_id: "u-coach-t2", status: "active" },
      { id: "m-player", club_id: CLUB_A.id, user_id: "u-player", status: "active" },
      { id: "m-parent", club_id: CLUB_A.id, user_id: "u-parent", status: "active" },
      { id: "m-tables", club_id: CLUB_A.id, user_id: "u-tables", status: "active" },
      { id: "m-norole", club_id: CLUB_A.id, user_id: "u-norole", status: "active" },
      { id: "m-self", club_id: CLUB_A.id, user_id: "u-self", status: "active", licencie_id: "a1" },
    ],
    roles: [
      { membership_id: "m-admin", role: "club_admin" },
      { membership_id: "m-coach-t1", role: "coach", scope_team_id: T1 },
      { membership_id: "m-coach-t2", role: "coach", scope_team_id: T2 },
      { membership_id: "m-player", role: "joueur" },
      { membership_id: "m-parent", role: "parent" },
      { membership_id: "m-tables", role: "responsable_tables" },
      { membership_id: "m-self", role: "joueur" },
    ],
    // a1, a2 dans T1 ; b1 dans T2 ; other sans équipe.
    licencies: [lic("a1", T1), lic("a2", T1), lic("b1", T2), lic("other", null)],
  });
});

describe("lecture des colonnes sensibles — client service role seulement après autorisation", () => {
  // Acteurs sans aucun droit sur ces licenciés (a1, a2, b1) : aucune requête service role ne doit partir.
  const NO_RIGHTS = ["u-player", "u-parent", "u-tables", "u-norole"];

  it.each(NO_RIGHTS)("%s : aucune requête service role sur licencies (liste et fiche)", async (userId) => {
    currentUserId = userId;
    expect((await get("")).status).toBe(200);
    expect((await get("/a1")).status).toBe(200);
    expect(licenciesCalls("service")).toHaveLength(0);
  });

  it("coach d'une équipe sans licencié sur la fiche demandée : aucune requête service role", async () => {
    currentUserId = "u-coach-t2";
    expect((await get("/a1")).status).toBe(200);
    expect(licenciesCalls("service")).toHaveLength(0);
  });

  it("le client utilisateur ne demande JAMAIS une colonne sensible (liste, fiche, tous acteurs)", async () => {
    for (const userId of ["u-admin", "u-coach-t1", "u-self", ...NO_RIGHTS]) {
      currentUserId = userId;
      await get("");
      await get("/a1");
    }
    const userReads = licenciesCalls("user");
    expect(userReads.length).toBeGreaterThan(0);
    for (const call of userReads) {
      const columns = (call.columns ?? "").split(",").map((c) => c.trim());
      expect(columns, `colonnes demandées : ${call.columns}`).not.toContain("*");
      for (const sensitive of SENSITIVE) expect(columns).not.toContain(sensitive);
    }
  });

  it("club_admin : une seule requête service role pour toute la liste, bornée au club", async () => {
    currentUserId = "u-admin";
    await get("");
    const reads = licenciesCalls("service");
    expect(reads).toHaveLength(1);
    expect(reads[0]!.columns).toBe("id, birth_date, license_number, email, phone, ffbb_licence_id");
    expect(opsOf(reads[0]!, "eq")).toContainEqual(["club_id", CLUB_A.id]);
  });

  it("coach de T1 : une seule requête service role, bornée au club ET aux seuls identifiants autorisés", async () => {
    currentUserId = "u-coach-t1";
    const body = (await (await get("")).json()) as { licencies: { id: string; email: string | null }[] };
    const reads = licenciesCalls("service");
    expect(reads).toHaveLength(1);
    expect(opsOf(reads[0]!, "eq")).toContainEqual(["club_id", CLUB_A.id]);
    const [, ids] = opsOf(reads[0]!, "in")[0]!;
    expect([...(ids as string[])].sort()).toEqual(["a1", "a2"]);
    // Résultat inchangé par rapport au lot 2a.
    expect(Object.fromEntries(body.licencies.map((l) => [l.id, l.email !== null]))).toEqual({ a1: true, a2: true, b1: false, other: false });
  });

  it("le licencié lui-même : une requête service role pour sa seule fiche", async () => {
    currentUserId = "u-self";
    await get("/a1");
    const reads = licenciesCalls("service");
    expect(reads).toHaveLength(1);
    expect(opsOf(reads[0]!, "in")[0]![1]).toEqual(["a1"]);
  });

  it("au-delà de 150 licenciés autorisés, les identifiants sont répartis par lots (jamais un par licencié)", async () => {
    state.licencies = Array.from({ length: 320 }, (_, i) => lic(`x${i}`, T1));
    currentUserId = "u-coach-t1";
    await get("");
    const reads = licenciesCalls("service");
    expect(reads).toHaveLength(3);
    expect(reads.flatMap((r) => opsOf(r, "in")[0]![1] as string[])).toHaveLength(320);
  });
});
