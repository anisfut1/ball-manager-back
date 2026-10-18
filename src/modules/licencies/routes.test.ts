import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";

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

const removeStoredLicenciePhoto = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../../storage/licencie-photos.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../storage/licencie-photos.js")>();
  return { ...actual, removeStoredLicenciePhoto: (...args: unknown[]) => removeStoredLicenciePhoto(...args) };
});

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

function licencie(overrides: Partial<FakeLicencieRow> = {}): FakeLicencieRow {
  return {
    id: `licencie-${Math.random().toString(36).slice(2)}`,
    club_id: CLUB_A.id,
    first_name: "Julie",
    last_name: "MESTRES",
    license_number: "JN870663",
    birth_date: null,
    email: null,
    phone: null,
    photo_url: null,
    active: true,
    ...overrides,
  };
}

function request(path: string, init: RequestInit = {}) {
  return app.request(`/v1/clubs/${CLUB_A.id}/licencies${path}`, {
    ...init,
    headers: { authorization: "Bearer test-jwt", "content-type": "application/json", ...init.headers },
  });
}

beforeEach(() => {
  removeStoredLicenciePhoto.mockClear();
  currentUserId = "user-admin";
  state = makeFakeClubSupabaseState({
    clubs: [{ ...CLUB_A }, { ...CLUB_B }],
    memberships: [
      { id: "membership-admin", club_id: CLUB_A.id, user_id: "user-admin", status: "active" },
      { id: "membership-player", club_id: CLUB_A.id, user_id: "user-player", status: "active", licencie_id: "licencie-self" },
      { id: "membership-plain", club_id: CLUB_A.id, user_id: "user-plain", status: "active" },
    ],
    roles: [{ membership_id: "membership-admin", role: "club_admin" }],
  });
});

describe("GET /v1/clubs/:clubId/licencies — roster", () => {
  it("liste les licenciés DU CLUB uniquement (jamais ceux d'un autre club), triés par nom", async () => {
    state.licencies = [
      licencie({ id: "l1", last_name: "ZEBRA", first_name: "A" }),
      licencie({ id: "l2", last_name: "ABEL", first_name: "B" }),
      licencie({ id: "l3", club_id: CLUB_B.id, last_name: "AUTRECLUB" }),
    ];

    const res = await request("");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { licencies: { id: string; lastName: string }[] };
    expect(body.licencies.map((l) => l.id)).toEqual(["l2", "l1"]);
    expect(body.licencies.every((l) => l.lastName !== "AUTRECLUB")).toBe(true);
  });
});

describe("GET /v1/clubs/:clubId/licencies/:licencieId — fiche joueur", () => {
  it("404 pour un licencié d'un AUTRE club, jamais une erreur qui en révèle l'existence", async () => {
    state.licencies = [licencie({ id: "l-other-club", club_id: CLUB_B.id })];

    const res = await request("/l-other-club");
    expect(res.status).toBe(404);
  });

  it("404 pour un identifiant inconnu", async () => {
    const res = await request("/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });

  it("club_admin peut tout éditer, même la fiche d'un·e autre licencié·e (isSelf=false)", async () => {
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canEdit: boolean; isSelf: boolean };
    expect(body).toMatchObject({ canEdit: true, isSelf: false });
  });

  it("le licencié lui-même (rattaché via club_memberships.licencie_id) peut éditer SA PROPRE fiche (isSelf=true)", async () => {
    currentUserId = "user-player";
    state.licencies = [licencie({ id: "licencie-self" })];

    const res = await request("/licencie-self");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canEdit: boolean; isSelf: boolean };
    expect(body).toMatchObject({ canEdit: true, isSelf: true });
  });

  it("un membre quelconque (ni admin, ni le licencié lui-même) peut LIRE la fiche mais pas la modifier", async () => {
    currentUserId = "user-plain";
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canEdit: boolean; isSelf: boolean };
    expect(body).toMatchObject({ canEdit: false, isSelf: false });
  });
});

describe("PATCH /v1/clubs/:clubId/licencies/:licencieId/profile — permissions", () => {
  it("club_admin peut modifier l'identité complète (nom, licence, statut actif...)", async () => {
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1/profile", { method: "PATCH", body: JSON.stringify({ lastName: "NOUVEAU-NOM", active: false }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lastName: string; active: boolean };
    expect(body).toMatchObject({ lastName: "NOUVEAU-NOM", active: false });
  });

  it("le licencié lui-même peut modifier sa photo/son contact", async () => {
    currentUserId = "user-player";
    state.licencies = [licencie({ id: "licencie-self" })];

    const res = await request("/licencie-self/profile", { method: "PATCH", body: JSON.stringify({ photoUrl: "https://example.com/moi.jpg" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { photoUrl: string };
    expect(body.photoUrl).toBe("https://example.com/moi.jpg");
  });

  it("le licencié lui-même NE PEUT JAMAIS modifier son propre nom ou numéro de licence (400, jamais un rejet silencieux)", async () => {
    currentUserId = "user-player";
    state.licencies = [licencie({ id: "licencie-self" })];

    const res = await request("/licencie-self/profile", { method: "PATCH", body: JSON.stringify({ lastName: "TRICHE" }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/lastName/);
  });

  it("un membre qui n'est ni admin ni le licencié lui-même reçoit 403, jamais 200", async () => {
    currentUserId = "user-plain";
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1/profile", { method: "PATCH", body: JSON.stringify({ photoUrl: "https://example.com/x.jpg" }) });
    expect(res.status).toBe(403);
  });

  const TEAM_A_ID = "11111111-1111-4111-8111-111111111111";
  const TEAM_B_ID = "22222222-2222-4222-8222-222222222222";

  it("club_admin peut rattacher un licencié à une équipe DE SON CLUB (demande du club, docs/TEAMS.md)", async () => {
    state.licencies = [licencie({ id: "l1" })];
    state.teams = [{ id: TEAM_A_ID, club_id: CLUB_A.id, name: "U11 1", active: true }];

    const res = await request("/l1/profile", { method: "PATCH", body: JSON.stringify({ teamId: TEAM_A_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.teamId).toBe(TEAM_A_ID);
  });

  it("rejette un teamId appartenant à un AUTRE club (400, jamais un rattachement cross-tenant silencieux)", async () => {
    state.licencies = [licencie({ id: "l1" })];
    state.teams = [{ id: TEAM_B_ID, club_id: CLUB_B.id, name: "Équipe B", active: true }];

    const res = await request("/l1/profile", { method: "PATCH", body: JSON.stringify({ teamId: TEAM_B_ID }) });
    expect(res.status).toBe(400);
    expect(state.licencies.find((l) => l.id === "l1")?.team_id).toBeUndefined();
  });
});

describe("POST /v1/clubs/:clubId/licencies/import (club_admin) — import en masse depuis un export FBI", () => {
  const validRow = { ffbbLicenceId: "200000002740760", licenseNumber: "JH775373", firstName: "Abdelaziz", lastName: "SGHIR", birthDate: "1977-08-14", categoryLabel: "Seniors", sexe: "M" as const };

  it("insère les nouveaux licenciés (dédoublonnage par ffbbLicenceId) et renvoie total/inserted/skipped", async () => {
    state.licencies = [];

    const res = await request("/import", { method: "POST", body: JSON.stringify({ licencies: [validRow] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 1, inserted: 1, skipped: 0 });
    expect(state.licencies).toHaveLength(1);
    expect(state.licencies[0]).toMatchObject({ club_id: CLUB_A.id, first_name: "Abdelaziz", last_name: "SGHIR", ffbb_licence_id: "200000002740760", category_label: "Seniors", sexe: "M" });
  });

  it("ignore un licencié DÉJÀ connu par ffbbLicenceId (jamais un doublon, jamais une erreur)", async () => {
    state.licencies = [licencie({ id: "l1", ffbb_licence_id: "200000002740760" })];

    const res = await request("/import", { method: "POST", body: JSON.stringify({ licencies: [validRow] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 1, inserted: 0, skipped: 1 });
    expect(state.licencies).toHaveLength(1);
  });

  it("dédoublonne aussi DEUX lignes identiques DANS LE MÊME import (jamais un doublon créé par le batch lui-même)", async () => {
    state.licencies = [];

    const res = await request("/import", { method: "POST", body: JSON.stringify({ licencies: [validRow, { ...validRow, firstName: "Doublon" }] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 2, inserted: 1, skipped: 1 });
    expect(state.licencies).toHaveLength(1);
  });

  it("un import n'écrase JAMAIS teamId/active d'un licencié existant (jamais mis à jour, seulement ignoré)", async () => {
    state.licencies = [licencie({ id: "l1", ffbb_licence_id: "200000002740760", team_id: "team-x", active: false })];

    await request("/import", { method: "POST", body: JSON.stringify({ licencies: [validRow] }) });
    expect(state.licencies[0]).toMatchObject({ team_id: "team-x", active: false });
  });

  it("400 quand ffbbLicenceId est manquant (validation zod, jamais atteint la base)", async () => {
    state.licencies = [];
    const res = await request("/import", { method: "POST", body: JSON.stringify({ licencies: [{ ...validRow, ffbbLicenceId: "" }] }) });
    expect(res.status).toBe(400);
    expect(state.licencies).toHaveLength(0);
  });

  it("refuse (403) à un membre non club_admin", async () => {
    currentUserId = "user-plain";
    state.licencies = [];

    const res = await request("/import", { method: "POST", body: JSON.stringify({ licencies: [validRow] }) });
    expect(res.status).toBe(403);
    expect(state.licencies).toHaveLength(0);
  });
});

describe("POST /v1/clubs/:clubId/licencies/auto-assign-teams (club_admin) — répartition automatique best-effort", () => {
  it("affecte les licenciés sans équipe selon leur catégorie/sexe, ignore ceux déjà affectés, renvoie total/assigned/skipped", async () => {
    state.teams = [
      { id: "team-u11-m", club_id: CLUB_A.id, name: "U11 1", category: "U11", sexe: "M", numero_equipe: "1", active: true },
      { id: "team-se-f", club_id: CLUB_A.id, name: "Seniors 1", category: "SE", sexe: "F", numero_equipe: "1", active: true },
    ];
    state.licencies = [
      licencie({ id: "l1", category_label: "U11", sexe: "M", team_id: null }),
      licencie({ id: "l2", category_label: "Seniors", sexe: "F", team_id: null }),
      // Déjà affecté — jamais réécrit par ce best-effort.
      licencie({ id: "l3", category_label: "U11", sexe: "M", team_id: "team-existing" }),
      // Catégorie inconnue (trop jeune, aucune équipe correspondante) — compté en skipped.
      licencie({ id: "l4", category_label: "U5", sexe: "M", team_id: null }),
    ];

    const res = await request("/auto-assign-teams", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 3, assigned: 2, skipped: 1 });
    expect(state.licencies.find((l) => l.id === "l1")?.team_id).toBe("team-u11-m");
    expect(state.licencies.find((l) => l.id === "l2")?.team_id).toBe("team-se-f");
    expect(state.licencies.find((l) => l.id === "l3")?.team_id).toBe("team-existing");
    expect(state.licencies.find((l) => l.id === "l4")?.team_id).toBeNull();
  });

  it("refuse (403) à un membre non club_admin", async () => {
    currentUserId = "user-plain";
    state.licencies = [licencie({ id: "l1", category_label: "U11", sexe: "M", team_id: null })];

    const res = await request("/auto-assign-teams", { method: "POST" });
    expect(res.status).toBe(403);
    expect(state.licencies[0].team_id).toBeNull();
  });
});

describe("DELETE /v1/clubs/:clubId/licencies/:licencieId (club_admin) — suppression définitive", () => {
  it("supprime le licencié et renvoie { deleted: true }", async () => {
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(state.licencies.find((l) => l.id === "l1")).toBeUndefined();
  });

  it("supprime aussi la photo du stockage (URL lue AVANT la suppression en base)", async () => {
    const photoUrl = `https://x.supabase.co/storage/v1/object/public/licencie-photos/${CLUB_A.id}/l1/abc.webp`;
    state.licencies = [licencie({ id: "l1", photo_url: photoUrl })];

    const res = await request("/l1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(state.licencies.find((l) => l.id === "l1")).toBeUndefined();
    expect(removeStoredLicenciePhoto).toHaveBeenCalledTimes(1);
    expect(removeStoredLicenciePhoto.mock.calls[0]!.slice(1)).toEqual([photoUrl, CLUB_A.id]);
  });

  it("un échec du stockage ne fait pas échouer la suppression", async () => {
    state.licencies = [licencie({ id: "l1", photo_url: `https://x.supabase.co/storage/v1/object/public/licencie-photos/${CLUB_A.id}/l1/abc.webp` })];
    removeStoredLicenciePhoto.mockRejectedValueOnce(new Error("storage down"));

    const res = await request("/l1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  it("404 pour un licencié d'un AUTRE club, jamais une suppression cross-tenant silencieuse", async () => {
    state.licencies = [licencie({ id: "l-other-club", club_id: CLUB_B.id })];

    const res = await request("/l-other-club", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(state.licencies).toHaveLength(1);
  });

  it("404 pour un licencié inexistant", async () => {
    state.licencies = [];
    const res = await request("/inexistant", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("refuse (403) à un membre non club_admin, jamais une suppression silencieuse", async () => {
    currentUserId = "user-plain";
    state.licencies = [licencie({ id: "l1" })];

    const res = await request("/l1", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(state.licencies).toHaveLength(1);
  });

  it("refuse (403) au licencié lui-même (identité admin-contrôlée, même verrou que PATCH .../profile)", async () => {
    currentUserId = "user-player";
    state.licencies = [licencie({ id: "licencie-self" })];

    const res = await request("/licencie-self", { method: "DELETE" });
    expect(res.status).toBe(403);
    expect(state.licencies).toHaveLength(1);
  });
});

describe("POST /v1/clubs/:clubId/licencies (club_admin) — ajout manuel (coach non licencié dans ce club)", () => {
  const post = (body: unknown) => request("", { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer test-jwt", "content-type": "application/json" } });

  it("crée la personne avec ses rôles, sans donnée FFBB", async () => {
    state.licencies = [];
    const res = await post({ firstName: "Karim", lastName: "Benali", email: "karim@example.test", publicCoach: true });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; firstName: string; publicCoach: boolean; publicCoordinator: boolean; ffbbLicenceId: string | null; licenseNumber: string | null; active: boolean };
    expect(created).toMatchObject({ firstName: "Karim", publicCoach: true, publicCoordinator: false, ffbbLicenceId: null, licenseNumber: null, active: true });
    expect(state.licencies).toHaveLength(1);
    expect(state.licencies[0]).toMatchObject({ club_id: CLUB_A.id, last_name: "Benali", email: "karim@example.test", public_coach: true });
  });

  it("400 sans nom, équipe d'un autre club refusée", async () => {
    expect((await post({ firstName: "Karim" })).status).toBe(400);
    expect((await post({ firstName: "Karim", lastName: "B", teamId: "99999999-9999-4999-8999-999999999999" })).status).toBe(400);
  });

  it("refuse (403) à un membre non club_admin", async () => {
    currentUserId = "user-plain";
    state.licencies = [];
    expect((await post({ firstName: "Karim", lastName: "Benali" })).status).toBe(403);
    expect(state.licencies).toHaveLength(0);
  });
});

describe("équipes coachées (accueil coach de l'espace public)", () => {
  const T1 = "11111111-1111-4111-8111-000000000001";
  const T_B = "11111111-1111-4111-8111-0000000000bb";
  const patch = (id: string, body: unknown) => request(`/${id}/profile`, { method: "PATCH", body: JSON.stringify(body) });

  it("club_admin pose les équipes coachées (dédoublonnées) ; une équipe d'un autre club est refusée", async () => {
    state.teams = [
      { id: T1, club_id: CLUB_A.id, name: "U15", sexe: "F", active: true },
      { id: T_B, club_id: CLUB_B.id, name: "U15", sexe: "F", active: true },
    ];
    state.licencies = [licencie({ id: "l1" })];
    const ok = await patch("l1", { publicCoach: true, coachedTeamIds: [T1, T1] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { coachedTeamIds: string[] }).coachedTeamIds).toEqual([T1]);
    expect((await patch("l1", { coachedTeamIds: [T_B] })).status).toBe(400);
  });
});
