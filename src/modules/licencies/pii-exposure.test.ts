import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";

/**
 * Données personnelles des licenciés (audit S-1) : date de naissance, e-mail,
 * téléphone, n° de licence et n° FFBB ne sont visibles que par les rôles de
 * gestion du club, le coach de l'équipe du licencié et le licencié lui-même.
 * Les tests passent par la vraie route HTTP et la sérialisation réelle.
 */

let state: FakeClubSupabaseState;
let currentUserId = "user-admin";

vi.mock("../../auth/jwt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/jwt.js")>();
  return { ...actual, verifyAccessToken: vi.fn(async () => ({ id: currentUserId, email: `${currentUserId}@example.test` })) };
});

vi.mock("../../db/client.js", () => ({
  createUserSupabaseClient: () => buildFakeClubSupabase(state),
  createServiceSupabaseClient: () => buildFakeClubSupabase(state),
  createAnonSupabaseClient: () => ({}),
}));

const { app } = await import("../../app.js");

const CLUB_A = {
  id: "aaaaaaaa-0000-0000-0000-000000000000",
  slug: "club-a",
  name: "Club A Basket",
  short_name: null,
  logo_url: null,
  accent_color: null,
  timezone: "Europe/Paris",
  status: "active" as const,
  ffbb_club_id: "AAA0000001",
  ffbb_enabled: true,
  ffbb_next_sync_at: null,
};
const CLUB_B = { ...CLUB_A, id: "bbbbbbbb-0000-0000-0000-000000000000", slug: "club-b", ffbb_club_id: "BBB0000002" };

const TEAM_1 = "11111111-1111-4111-8111-111111111111";
const TEAM_2 = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "l-target";

const SENTINELS = {
  birthDate: "1901-01-01",
  email: "sentinel-pii@example.invalid",
  phone: "+33000000099",
  licenseNumber: "SENTINEL-LIC-0000",
  ffbbLicenceId: "SENTINEL-FFBB-0000",
};

function licencie(overrides: Partial<FakeLicencieRow> = {}): FakeLicencieRow {
  return { id: "l-x", club_id: CLUB_A.id, first_name: "Julie", last_name: "MESTRES", license_number: null, birth_date: null, email: null, phone: null, photo_url: null, active: true, ...overrides };
}

interface Actor {
  label: string;
  userId: string;
  licencieId?: string;
  roles: { role: string; scope_team_id?: string | null }[];
  seesPii: boolean;
}

const ACTORS: Actor[] = [
  { label: "club_admin", userId: "u-admin", roles: [{ role: "club_admin" }], seesPii: true },
  { label: "correspondant_club", userId: "u-corr", roles: [{ role: "correspondant_club" }], seesPii: true },
  { label: "coach de l'équipe du licencié", userId: "u-coach-t1", roles: [{ role: "coach", scope_team_id: TEAM_1 }], seesPii: true },
  { label: "coach à scope_team_id NULL (toutes les équipes)", userId: "u-coach-all", roles: [{ role: "coach", scope_team_id: null }], seesPii: true },
  { label: "le licencié lui-même (joueur)", userId: "u-self", licencieId: TARGET_ID, roles: [{ role: "joueur" }], seesPii: true },
  { label: "parent dont licencie_id pointe sur le licencié", userId: "u-parent-linked", licencieId: TARGET_ID, roles: [{ role: "parent" }], seesPii: true },
  { label: "coach d'une AUTRE équipe", userId: "u-coach-t2", roles: [{ role: "coach", scope_team_id: TEAM_2 }], seesPii: false },
  { label: "joueur d'un autre foyer", userId: "u-other-player", licencieId: "l-other", roles: [{ role: "joueur" }], seesPii: false },
  { label: "parent sans lien", userId: "u-parent-free", roles: [{ role: "parent" }], seesPii: false },
  { label: "responsable_tables seul", userId: "u-tables", roles: [{ role: "responsable_tables" }], seesPii: false },
  { label: "membre sans aucun rôle", userId: "u-norole", roles: [], seesPii: false },
];

function get(path: string) {
  return app.request(`/v1/clubs/${CLUB_A.id}/licencies${path}`, { headers: { authorization: "Bearer test-jwt" } });
}

beforeEach(() => {
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    memberships: [
      ...ACTORS.map((a) => ({ id: `m-${a.userId}`, club_id: CLUB_A.id, user_id: a.userId, status: "active" as const, licencie_id: a.licencieId ?? null })),
      { id: "m-club-b-only", club_id: CLUB_B.id, user_id: "u-club-b-only", status: "active" as const },
    ],
    roles: ACTORS.flatMap((a) => a.roles.map((r) => ({ membership_id: `m-${a.userId}`, ...r }))),
    licencies: [
      licencie({
        id: TARGET_ID,
        first_name: "Camille",
        last_name: "DURAND",
        team_id: TEAM_1,
        photo_url: "https://example.test/photo.webp",
        birth_date: SENTINELS.birthDate,
        email: SENTINELS.email,
        phone: SENTINELS.phone,
        license_number: SENTINELS.licenseNumber,
        ffbb_licence_id: SENTINELS.ffbbLicenceId,
      }),
      licencie({ id: "l-other", first_name: "Autre", last_name: "PERSONNE", email: "autre@example.invalid" }),
    ],
  });
});

describe.each(ACTORS)("$label", (actor) => {
  const expectation = actor.seesPii ? "voit" : "ne voit PAS";

  it(`${expectation} les données personnelles dans la liste`, async () => {
    currentUserId = actor.userId;
    const res = await get("");
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.clone().json());
    const body = (await res.json()) as { licencies: Record<string, unknown>[] };
    const target = body.licencies.find((l) => l.id === TARGET_ID)!;

    expect(target).toMatchObject({ firstName: "Camille", lastName: "DURAND", teamId: TEAM_1, photoUrl: "https://example.test/photo.webp" });
    if (actor.seesPii) {
      for (const sentinel of Object.values(SENTINELS)) expect(raw).toContain(sentinel);
    } else {
      for (const sentinel of Object.values(SENTINELS)) expect(raw).not.toContain(sentinel);
      expect(target).toMatchObject({ birthDate: null, email: null, phone: null, licenseNumber: null, ffbbLicenceId: null });
    }
  });

  it(`${expectation} les données personnelles sur la fiche`, async () => {
    currentUserId = actor.userId;
    const res = await get(`/${TARGET_ID}`);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(await res.clone().json());
    const body = (await res.json()) as { licencie: Record<string, unknown> };

    expect(body.licencie).toMatchObject({ firstName: "Camille", lastName: "DURAND", teamId: TEAM_1, photoUrl: "https://example.test/photo.webp" });
    if (actor.seesPii) {
      for (const sentinel of Object.values(SENTINELS)) expect(raw).toContain(sentinel);
    } else {
      for (const sentinel of Object.values(SENTINELS)) expect(raw).not.toContain(sentinel);
      expect(body.licencie).toMatchObject({ birthDate: null, email: null, phone: null, licenseNumber: null, ffbbLicenceId: null });
    }
  });
});

describe("membre d'un AUTRE club", () => {
  it("reçoit 404 sur la liste et sur la fiche (inchangé)", async () => {
    currentUserId = "u-club-b-only";
    expect((await get("")).status).toBe(404);
    expect((await get(`/${TARGET_ID}`)).status).toBe(404);
  });
});
