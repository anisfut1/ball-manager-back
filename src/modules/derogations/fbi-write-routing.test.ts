import { describe, expect, it } from "vitest";
import type { DbClient } from "../../db/client.js";
import { claimNextFbiWriteJob, finishFbiWriteJob, LOCAL_WORKER_PENDING_MESSAGE, runOnLocalWorker } from "./fbi-write-routing.js";

type Row = Record<string, unknown>;

/** Table `fbi_jobs` en mémoire : juste les filtres utilisés par le routage. */
function fakeJobsDb(rows: Row[] = []) {
  let next = 1;
  function query(source: () => Row[], apply?: (row: Row) => void) {
    const filters: ((row: Row) => boolean)[] = [];
    const run = () => {
      const hit = source().filter((row) => filters.every((f) => f(row)));
      if (apply) hit.forEach(apply);
      return hit;
    };
    const chain = {
      select: () => chain,
      eq: (col: string, value: unknown) => (filters.push((r) => r[col] === value), chain),
      in: (col: string, values: unknown[]) => (filters.push((r) => values.includes(r[col])), chain),
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: run(), error: null }),
    };
    return chain;
  }
  const db = {
    from: () => ({
      select: () => query(() => rows),
      insert: (payload: Row) => {
        const row = { id: `job-${next++}`, status: "pending", attempt_count: 0, created_at: new Date().toISOString(), ...payload };
        rows.push(row);
        return query(() => [row]);
      },
      update: (patch: Row) => query(() => rows, (row) => Object.assign(row, patch)),
    }),
  };
  return { db: db as unknown as DbClient, rows };
}

const JOB = { clubId: "club-a", matchId: "match-1", type: "create_derogation" as const, payload: { params: { clubId: "club-a" } } };

describe("écriture FBI confiée au poste du club", () => {
  it("met l'envoi en file (jamais rejoué) et renvoie le résultat du poste", async () => {
    const { db, rows } = fakeJobsDb();
    const pending = runOnLocalWorker(db, JOB, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "create_derogation", max_attempts: 1, status: "pending" });

    const claimed = await claimNextFbiWriteJob(db, "club-a", "local#mac");
    expect(claimed).toMatchObject({ id: rows[0].id, status: "claimed", claimed_by: "local#mac" });
    expect(await claimNextFbiWriteJob(db, "club-a", "local#mac")).toBeNull();

    await finishFbiWriteJob(db, String(rows[0].id), { outcome: "success", message: null });
    await expect(pending).resolves.toEqual({ outcome: "success", message: null });
  });

  it("refuse un second envoi pour le même match tant que le premier est en file", async () => {
    const { db } = fakeJobsDb([{ id: "job-0", club_id: "club-a", match_id: "match-1", type: "create_derogation", status: "pending" }]);
    await expect(runOnLocalWorker(db, JOB, 10)).rejects.toMatchObject({ code: "FBI_WRITE_PENDING" });
  });

  it("poste occupé au-delà de l'attente : résultat inconnu, l'envoi reste en file", async () => {
    const { db, rows } = fakeJobsDb();
    await expect(runOnLocalWorker(db, JOB, 10)).resolves.toEqual({ outcome: "unknown", message: LOCAL_WORKER_PENDING_MESSAGE });
    expect(rows[0]).toMatchObject({ status: "pending" });
  });

  it("échec inattendu côté poste : message d'erreur renvoyé", async () => {
    const { db, rows } = fakeJobsDb();
    const pending = runOnLocalWorker(db, JOB, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await finishFbiWriteJob(db, String(rows[0].id), { failed: "Navigateur fermé." });
    await expect(pending).resolves.toEqual({ outcome: "error", message: "Navigateur fermé." });
  });
});
