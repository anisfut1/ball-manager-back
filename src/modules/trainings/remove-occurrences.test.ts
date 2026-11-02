import { describe, expect, it } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState } from "../../test-support/fake-club-supabase.js";
import { removeOccurrences, type TrainingCtx } from "./service.js";

const CLUB_A = "aaaaaaaa-0000-0000-0000-000000000000";
const CLUB_B = "bbbbbbbb-0000-0000-0000-000000000000";

function occurrence(id: string, clubId: string) {
  return { id, club_id: clubId, team_id: "t1", series_id: null, series_date: null, starts_at: "2099-01-01T10:00:00Z", ends_at: "2099-01-01T11:30:00Z", club_venue_id: null, location_label: null, status: "scheduled", cancel_reason: null, is_modified: false };
}

describe("removeOccurrences — borné au club", () => {
  it("n'annule jamais une séance d'un AUTRE club, même si son id est passé par erreur", async () => {
    const state = makeFakeClubSupabaseState({
      trainingOccurrences: [occurrence("occ-a", CLUB_A), occurrence("occ-b", CLUB_B)],
      // Une réponse du club A rattachée aux deux ids force le chemin « annuler » (et non « supprimer »).
      trainingResponses: [
        { club_id: CLUB_A, occurrence_id: "occ-a", licencie_id: "l1", response: "present" },
        { club_id: CLUB_A, occurrence_id: "occ-b", licencie_id: "l1", response: "present" },
      ],
    });
    const ctx = { db: buildFakeClubSupabase(state), clubId: CLUB_A, timezone: "Europe/Paris", actor: { isAdmin: true, coachTeamIds: "ALL", userId: "u", licencieId: null } } as unknown as TrainingCtx;

    await removeOccurrences(ctx, [occurrence("occ-a", CLUB_A), occurrence("occ-b", CLUB_B)] as never, "Créneau modifié");

    const status = (id: string) => state.trainingOccurrences.find((o) => o.id === id)?.status;
    expect(status("occ-a")).toBe("cancelled");
    expect(status("occ-b")).toBe("scheduled");
  });
});
