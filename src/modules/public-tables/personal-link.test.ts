import { describe, expect, it } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";
import { revealOrIssueToken } from "./personal-link.js";
import { hashPublicToken, PERSONAL_LINK_TTL_MS } from "./token.js";

const CLUB = "aaaaaaaa-0000-0000-0000-000000000000";
const LINA = "44444444-4444-4444-8444-000000000001";
const params = { clubId: CLUB, licencieId: LINA, email: null, adminUserId: "admin-1" };

function stateWith(expiresAt: string) {
  const state = makeFakeClubSupabaseState({ clubs: [], teams: [], licencies: [] });
  state.publicTokens = [{ id: "old", club_id: CLUB, licencie_id: LINA, token_hash: "old-hash", email: null, created_at: "2026-11-01T00:00:00Z", revoked_at: null, revoked_by: null, expires_at: expiresAt }];
  return state;
}

describe("revealOrIssueToken — expiration", () => {
  it("un nouveau jeton expire 7 jours après son émission", async () => {
    const state = makeFakeClubSupabaseState({ clubs: [], teams: [], licencies: [] });
    const before = Date.now();
    const { token } = await revealOrIssueToken(buildFakeClubSupabase(state) as never, params);
    const row = state.publicTokens.find((t) => t.token_hash === hashPublicToken(token));
    const at = Date.parse(row?.expires_at ?? "");
    expect(at).toBeGreaterThanOrEqual(before + PERSONAL_LINK_TTL_MS);
    expect(at).toBeLessThanOrEqual(Date.now() + PERSONAL_LINK_TTL_MS);
  });

  it("un jeton échu n'est pas réaffiché : il est révoqué et remplacé", async () => {
    const state = stateWith("2020-01-01T00:00:00Z");
    const { created, token } = await revealOrIssueToken(buildFakeClubSupabase(state) as never, params);
    expect(created).toBe(true);
    expect(state.publicTokens.find((t) => t.id === "old")?.revoked_at).not.toBeNull();
    expect(state.publicTokens.filter((t) => t.revoked_at === null)).toHaveLength(1);
    expect(state.publicTokens.some((t) => t.token_hash === hashPublicToken(token))).toBe(true);
  });
});
