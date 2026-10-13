import { describe, expect, it } from "vitest";
import { claimNextJob, claimNextJobForClub } from "./claim.js";
import type { FbiJobRow } from "../db/types.js";

function makeFakeSupabase(response: { data: FbiJobRow | null; error: { message: string } | null }) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  return {
    calls,
    rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return Promise.resolve(response);
    },
  };
}

const A_JOB: FbiJobRow = {
  id: "job-1",
  club_id: "club-1",
  match_id: "match-1",
  type: "discover_emarque",
  status: "claimed",
  attempt_count: 1,
  max_attempts: 6,
  scheduled_at: "2026-01-01T00:00:00.000Z",
  claimed_at: "2026-01-01T00:00:00.000Z",
  claimed_by: "worker-1#0",
  started_at: null,
  finished_at: null,
  last_error: null,
  result: null,
  created_at: "2026-01-01T00:00:00.000Z",
  window_start: null,
};

/**
 * Ce que renvoie RÉELLEMENT PostgREST pour `claim_next_fbi_job(_for_club)`
 * quand rien n'est disponible — jamais un `null` JSON bare, confirmé en
 * production le 2026-09-24 (voir le commentaire d'`isPhantomRow` dans
 * claim.ts). Une fonction PL/pgSQL `returns public.fbi_jobs` (composite,
 * pas `SETOF`) renvoie toujours exactement une "ligne", même quand cette
 * ligne est NULL — PostgREST la sérialise en objet aux champs tous `null`.
 */
const PHANTOM_ROW = {
  id: null,
  club_id: null,
  match_id: null,
  type: null,
  status: null,
  attempt_count: null,
  max_attempts: null,
  scheduled_at: null,
  claimed_at: null,
  claimed_by: null,
  started_at: null,
  finished_at: null,
  last_error: null,
  result: null,
  created_at: null,
};

describe("claimNextJob", () => {
  it("appelle claim_next_fbi_job avec l'identifiant du worker et renvoie le job réclamé", async () => {
    const supabase = makeFakeSupabase({ data: A_JOB, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const job = await claimNextJob(supabase as any, "worker-1#0");

    expect(job).toEqual(A_JOB);
    expect(supabase.calls).toEqual([{ fn: "claim_next_fbi_job", args: { p_worker_id: "worker-1#0" } }]);
  });

  it("renvoie null quand la file est vide (data: null, cas jamais observé en pratique mais couvert par sécurité)", async () => {
    const supabase = makeFakeSupabase({ data: null, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await claimNextJob(supabase as any, "worker-1#0")).toBeNull();
  });

  it("renvoie null (jamais la ligne fantôme) quand PostgREST renvoie un objet aux champs tous null — régression 2026-09-24", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = makeFakeSupabase({ data: PHANTOM_ROW as any, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await claimNextJob(supabase as any, "worker-1#0")).toBeNull();
  });

  it("propage une erreur explicite si le RPC échoue", async () => {
    const supabase = makeFakeSupabase({ data: null, error: { message: "connexion DB perdue" } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(claimNextJob(supabase as any, "worker-1#0")).rejects.toThrow(/connexion DB perdue/);
  });
});

describe("claimNextJobForClub", () => {
  it("appelle claim_next_fbi_job_for_club avec le club et l'identifiant du worker, et renvoie le job réclamé", async () => {
    const supabase = makeFakeSupabase({ data: A_JOB, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const job = await claimNextJobForClub(supabase as any, "club-1", "admin-app#club-1#0");

    expect(job).toEqual(A_JOB);
    expect(supabase.calls).toEqual([{ fn: "claim_next_fbi_job_for_club", args: { p_club_id: "club-1", p_worker_id: "admin-app#club-1#0" } }]);
  });

  it("renvoie null quand ce club n'a aucun job en attente (data: null, cas jamais observé en pratique mais couvert par sécurité)", async () => {
    const supabase = makeFakeSupabase({ data: null, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await claimNextJobForClub(supabase as any, "club-1", "admin-app#club-1#0")).toBeNull();
  });

  it("renvoie null (jamais la ligne fantôme) quand PostgREST renvoie un objet aux champs tous null — régression 2026-09-24 : la boucle auto de ball-manager-web ne s'arrêtait jamais toute seule sans ce garde-fou", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = makeFakeSupabase({ data: PHANTOM_ROW as any, error: null });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await claimNextJobForClub(supabase as any, "club-1", "admin-app#club-1#0")).toBeNull();
  });

  it("propage une erreur explicite si le RPC échoue", async () => {
    const supabase = makeFakeSupabase({ data: null, error: { message: "connexion DB perdue" } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(claimNextJobForClub(supabase as any, "club-1", "admin-app#club-1#0")).rejects.toThrow(/connexion DB perdue/);
  });
});
