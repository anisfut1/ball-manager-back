import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSyncFfbb } = vi.hoisted(() => ({ mockSyncFfbb: vi.fn() }));
vi.mock("./sync", () => ({ syncFfbb: mockSyncFfbb }));

import { syncAllDueClubs } from "./scheduler.js";

interface FakeClubRow {
  id: string;
  ffbb_club_id: string;
}

interface FakeState {
  dueClubs: FakeClubRow[];
  locksHeld: Set<string>;
  acquireCalls: string[];
  releaseCalls: string[];
  nextSyncUpdates: string[];
  nextSyncAt?: Record<string, string>;
}

function buildFakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      if (table === "clubs") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                or: () => ({
                  limit: () => Promise.resolve({ data: state.dueClubs, error: null }),
                }),
              }),
            }),
          }),
          update: (patch: { ffbb_next_sync_at: string }) => ({
            eq: (_col: string, id: string) => {
              state.nextSyncUpdates.push(id);
              state.nextSyncAt = { ...state.nextSyncAt, [id]: patch.ffbb_next_sync_at };
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      throw new Error(`Table inattendue : ${table}`);
    },
    rpc(fn: string, args: { p_club_id: string; p_integration: string }) {
      if (fn === "try_acquire_sync_lock") {
        state.acquireCalls.push(args.p_club_id);
        const key = `${args.p_club_id}:${args.p_integration}`;
        if (state.locksHeld.has(key)) return Promise.resolve({ data: false, error: null });
        state.locksHeld.add(key);
        return Promise.resolve({ data: true, error: null });
      }
      if (fn === "release_sync_lock") {
        state.releaseCalls.push(args.p_club_id);
        state.locksHeld.delete(`${args.p_club_id}:${args.p_integration}`);
        return Promise.resolve({ data: null, error: null });
      }
      throw new Error(`RPC inattendue : ${fn}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncAllDueClubs", () => {
  it("synchronise chaque club dû indépendamment, avec son propre verrou", async () => {
    mockSyncFfbb.mockResolvedValue({ syncRunId: "run-1", status: "success", stats: {} });
    const state: FakeState = {
      dueClubs: [
        { id: "club-a", ffbb_club_id: "AAA0000001" },
        { id: "club-b", ffbb_club_id: "BBB0000002" },
      ],
      locksHeld: new Set(),
      acquireCalls: [],
      releaseCalls: [],
      nextSyncUpdates: [],
    };
    const supabase = buildFakeSupabase(state);

    const result = await syncAllDueClubs(supabase, {} as never);

    expect(result).toEqual({ clubsDue: 2, clubsSynced: 2, clubsSkippedLocked: 0, clubsFailed: 0 });
    expect(mockSyncFfbb).toHaveBeenNthCalledWith(1, supabase, {}, { id: "club-a", ffbbClubId: "AAA0000001" });
    expect(mockSyncFfbb).toHaveBeenNthCalledWith(2, supabase, {}, { id: "club-b", ffbbClubId: "BBB0000002" });
    expect(state.nextSyncUpdates.sort()).toEqual(["club-a", "club-b"]);
  });

  it("continue avec les autres clubs si un club échoue (pas d'effet domino)", async () => {
    mockSyncFfbb.mockResolvedValueOnce({ syncRunId: "run-1", status: "error", stats: {} }).mockResolvedValueOnce({ syncRunId: "run-2", status: "success", stats: {} });

    const state: FakeState = {
      dueClubs: [
        { id: "club-a", ffbb_club_id: "AAA0000001" },
        { id: "club-b", ffbb_club_id: "BBB0000002" },
      ],
      locksHeld: new Set(),
      acquireCalls: [],
      releaseCalls: [],
      nextSyncUpdates: [],
    };
    const supabase = buildFakeSupabase(state);

    const result = await syncAllDueClubs(supabase, {} as never);

    expect(result).toEqual({ clubsDue: 2, clubsSynced: 1, clubsSkippedLocked: 0, clubsFailed: 1 });
    // Le verrou du club en échec est bien libéré (pas de fuite de verrou).
    expect(state.releaseCalls.sort()).toEqual(["club-a", "club-b"]);
  });

  it("espace la tentative suivante quand l'API FFBB refuse l'accès (403)", async () => {
    mockSyncFfbb
      .mockResolvedValueOnce({ syncRunId: "run-1", status: "error", stats: {}, blocked: true })
      .mockResolvedValueOnce({ syncRunId: "run-2", status: "error", stats: {} });
    const state: FakeState = {
      dueClubs: [
        { id: "club-a", ffbb_club_id: "AAA0000001" },
        { id: "club-b", ffbb_club_id: "BBB0000002" },
      ],
      locksHeld: new Set(),
      acquireCalls: [],
      releaseCalls: [],
      nextSyncUpdates: [],
    };
    const before = Date.now();

    await syncAllDueClubs(buildFakeSupabase(state), {} as never);

    const delayMinutes = (id: string) => (Date.parse(state.nextSyncAt![id]!) - before) / 60_000;
    expect(delayMinutes("club-a")).toBeGreaterThanOrEqual(359);
    expect(delayMinutes("club-b")).toBeLessThan(16);
  });

  it("ignore un club déjà verrouillé (déclenchement manuel admin en cours) sans toucher aux autres", async () => {
    mockSyncFfbb.mockResolvedValue({ syncRunId: "run-1", status: "success", stats: {} });
    const state: FakeState = {
      dueClubs: [
        { id: "club-a", ffbb_club_id: "AAA0000001" },
        { id: "club-b", ffbb_club_id: "BBB0000002" },
      ],
      locksHeld: new Set(["club-a:ffbb"]),
      acquireCalls: [],
      releaseCalls: [],
      nextSyncUpdates: [],
    };
    const supabase = buildFakeSupabase(state);

    const result = await syncAllDueClubs(supabase, {} as never);

    expect(result.clubsSkippedLocked).toBe(1);
    expect(result.clubsSynced).toBe(1);
    expect(mockSyncFfbb).toHaveBeenCalledTimes(1);
    expect(mockSyncFfbb).toHaveBeenCalledWith(supabase, {}, { id: "club-b", ffbbClubId: "BBB0000002" });
  });

  it("ne synchronise aucun club si aucun n'est dû", async () => {
    const state: FakeState = { dueClubs: [], locksHeld: new Set(), acquireCalls: [], releaseCalls: [], nextSyncUpdates: [] };
    const supabase = buildFakeSupabase(state);

    const result = await syncAllDueClubs(supabase, {} as never);

    expect(result).toEqual({ clubsDue: 0, clubsSynced: 0, clubsSkippedLocked: 0, clubsFailed: 0 });
    expect(mockSyncFfbb).not.toHaveBeenCalled();
  });
});
