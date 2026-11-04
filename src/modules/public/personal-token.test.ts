import { describe, expect, it } from "vitest";
import { ApiError } from "../../api-error.js";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";
import { hashPublicToken, isPersonalLinkExpired, PERSONAL_LINK_TTL_MS } from "../public-tables/token.js";
import { licencieFromToken } from "./personal-token.js";

/** Expiration à 7 jours des liens personnels (lot 5b). Données fictives. */
const CLUB = "aaaaaaaa-0000-0000-0000-000000000000";
const LINA = "44444444-4444-4444-8444-000000000001";
const NOW = new Date("2026-11-10T08:00:00.000Z");

function setup(expiresAt: string | undefined) {
  const state = makeFakeClubSupabaseState({
    clubs: [],
    teams: [],
    licencies: [{ id: LINA, club_id: CLUB, first_name: "Lina", last_name: "MARTIN", team_id: null, active: true } as FakeLicencieRow],
  });
  state.publicTokens = [{ id: "t1", club_id: CLUB, licencie_id: LINA, token_hash: hashPublicToken("secret-token"), email: null, created_at: "2026-11-01T00:00:00Z", revoked_at: null, revoked_by: null, ...(expiresAt ? { expires_at: expiresAt } : {}) }];
  return buildFakeClubSupabase(state) as unknown as Parameters<typeof licencieFromToken>[0];
}

describe("isPersonalLinkExpired", () => {
  it("vaut 7 jours", () => expect(PERSONAL_LINK_TTL_MS).toBe(604_800_000));
  it("n'est pas expiré avant l'échéance", () => expect(isPersonalLinkExpired("2026-11-10T08:00:00.001Z", NOW)).toBe(false));
  it("est expiré exactement à l'échéance", () => expect(isPersonalLinkExpired("2026-11-10T08:00:00.000Z", NOW)).toBe(true));
  it("est expiré après l'échéance", () => expect(isPersonalLinkExpired("2026-11-09T00:00:00Z", NOW)).toBe(true));
  it("échoue côté fermé sur une date absente ou illisible", () => {
    expect(isPersonalLinkExpired(null, NOW)).toBe(true);
    expect(isPersonalLinkExpired(undefined, NOW)).toBe(true);
    expect(isPersonalLinkExpired("pas-une-date", NOW)).toBe(true);
  });
});

describe("licencieFromToken — expiration", () => {
  it("accepte un lien non expiré", async () => {
    const lic = await licencieFromToken(setup("2999-01-01T00:00:00Z"), CLUB, "secret-token");
    expect(lic.id).toBe(LINA);
  });

  it("refuse un lien expiré avec PERSONAL_LINK_EXPIRED (401)", async () => {
    const err = await licencieFromToken(setup("2020-01-01T00:00:00Z"), CLUB, "secret-token").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "PERSONAL_LINK_EXPIRED" });
  });

  it("un jeton inconnu reste un 401 générique, jamais EXPIRED", async () => {
    const err = await licencieFromToken(setup("2999-01-01T00:00:00Z"), CLUB, "autre-jeton").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: "UNAUTHORIZED" });
  });
});
