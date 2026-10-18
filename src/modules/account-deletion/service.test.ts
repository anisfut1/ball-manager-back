import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildFakeClubSupabase, makeFakeClubSupabaseState, type FakeClubSupabaseState, type FakeLicencieRow } from "../../test-support/fake-club-supabase.js";

const logError = vi.fn();
vi.mock("../../logger.js", () => ({ logError: (...args: unknown[]) => logError(...args), logInfo: vi.fn() }));

const { deleteLicencieAccess } = await import("./service.js");

/** Suppression de l'accès d'un licencié — valeurs sentinelles fictives uniquement. */
const CLUB = "aaaaaaaa-0000-0000-0000-000000000000";
const OTHER_CLUB = "bbbbbbbb-0000-0000-0000-000000000000";
const CIBLE = "cible-id";
const TEMOIN = "temoin-id";
const FRERE = "frere-id";
const AUTRE = "autre-club-id";
const photo = (club: string, id: string) => `https://x.supabase.co/storage/v1/object/public/licencie-photos/${club}/${id}/p.webp`;

function lic(id: string, club: string, who: string, extra: Partial<FakeLicencieRow> = {}): FakeLicencieRow {
  return { id, club_id: club, first_name: who, last_name: "Sentinelle", license_number: `LIC-${who}`, birth_date: null, email: `sentinelle-${who.toLowerCase()}@example.invalid`, phone: who === "Cible" ? "+33600000001" : "+33600000002", photo_url: photo(club, id), active: true, public_coach: true, public_admin: true, public_coordinator: true, ...extra };
}

/** Pour chaque personne : un lien actif + un lien révoqué, deux sessions (une chacune), un jeton push, une demande de réclamation. */
function seedAccess(state: FakeClubSupabaseState, id: string, club: string, who: string) {
  const email = `sentinelle-${who}@example.invalid`;
  state.publicTokens.push(
    { id: `tok-${id}-1`, club_id: club, licencie_id: id, token_hash: `h1-${id}`, email, created_at: "2026-10-01T00:00:00Z", revoked_at: null, revoked_by: null },
    { id: `tok-${id}-0`, club_id: club, licencie_id: id, token_hash: `h0-${id}`, email, created_at: "2026-09-01T00:00:00Z", revoked_at: "2026-10-01T00:00:00Z", revoked_by: null },
  );
  for (const n of [1, 2]) {
    state.deviceSessions.push({ id: `sess-${id}-${n}`, club_id: club, secret_hash: `s-${id}-${n}`, platform: "ios", device_label: `iPhone de ${who}`, expires_at: "2027-01-01T00:00:00Z", revoked_at: null });
    state.deviceSessionGrants.push({ session_id: `sess-${id}-${n}`, club_id: club, licencie_id: id, token_id: `tok-${id}-1` });
  }
  state.devicePushTokens.push({ id: `push-${id}`, session_id: `sess-${id}-1`, club_id: club, token: `apns-${who}`, environment: "production", revoked_at: null });
  state.claimRequests.push({ id: `claim-${id}`, club_id: club, licencie_id: id, requested_email: email, status: "pending" });
}

const everything = (s: FakeClubSupabaseState) => JSON.stringify({ l: s.licencies, t: s.publicTokens, c: s.claimRequests, s: s.deviceSessions, g: s.deviceSessionGrants, p: s.devicePushTokens });
const ofPerson = (s: FakeClubSupabaseState, id: string) =>
  JSON.stringify({
    l: s.licencies.filter((x) => x.id === id),
    t: s.publicTokens.filter((x) => x.licencie_id === id),
    c: s.claimRequests.filter((x) => x.licencie_id === id),
    g: s.deviceSessionGrants.filter((x) => x.licencie_id === id),
    s: s.deviceSessions.filter((x) => String(x.id).includes(id)),
    p: s.devicePushTokens.filter((x) => String(x.session_id).includes(id)),
  });

let state: FakeClubSupabaseState;
let db: ReturnType<typeof buildFakeClubSupabase>;

beforeEach(() => {
  logError.mockClear();
  state = makeFakeClubSupabaseState({ licencies: [lic(CIBLE, CLUB, "Cible"), lic(TEMOIN, CLUB, "Temoin"), lic(AUTRE, OTHER_CLUB, "Autre")] });
  seedAccess(state, CIBLE, CLUB, "cible");
  seedAccess(state, TEMOIN, CLUB, "temoin");
  seedAccess(state, AUTRE, OTHER_CLUB, "autre");
  db = buildFakeClubSupabase(state);
});

describe("deleteLicencieAccess", () => {
  it("supprime tout l'accès de la cible, garde sa fiche sportive, laisse le témoin strictement inchangé", async () => {
    const temoinAvant = ofPerson(state, TEMOIN);
    const autreAvant = ofPerson(state, AUTRE);

    await deleteLicencieAccess(db, CLUB, [CIBLE]);

    expect(state.deleteLicencieAccessCalls).toEqual([{ p_club_id: CLUB, p_licencie_ids: [CIBLE] }]);
    expect(everything(state)).not.toContain("sentinelle-cible");
    expect(everything(state)).not.toContain("+33600000001");
    expect(state.publicTokens.filter((t) => t.licencie_id === CIBLE)).toEqual([]);
    expect(state.deviceSessions.filter((s) => String(s.id).includes(CIBLE))).toEqual([]);
    expect(state.deviceSessionGrants.filter((g) => g.licencie_id === CIBLE)).toEqual([]);
    expect(state.devicePushTokens.filter((p) => String(p.session_id).includes(CIBLE))).toEqual([]);
    expect(state.claimRequests.filter((c) => c.licencie_id === CIBLE)).toEqual([]);

    const cible = state.licencies.find((l) => l.id === CIBLE)!;
    expect(cible).toMatchObject({ first_name: "Cible", last_name: "Sentinelle", license_number: "LIC-Cible", email: null, phone: null, photo_url: null, public_admin: false, public_coach: false, public_coordinator: false });

    expect(ofPerson(state, TEMOIN)).toBe(temoinAvant);
    expect(ofPerson(state, AUTRE)).toBe(autreAvant);
    expect(state.storageRemovals).toEqual([{ bucket: "licencie-photos", paths: [`${CLUB}/${CIBLE}/p.webp`] }]);
  });

  it("session partagée : l'autre enfant garde son droit, sa session et son jeton push", async () => {
    state.deviceSessionGrants.push({ session_id: `sess-${CIBLE}-1`, club_id: CLUB, licencie_id: FRERE, token_id: `tok-${FRERE}-1` });
    state.licencies.push(lic(FRERE, CLUB, "Frere"));

    await deleteLicencieAccess(db, CLUB, [CIBLE]);

    expect(state.deviceSessions.some((s) => s.id === `sess-${CIBLE}-1`)).toBe(true);
    expect(state.deviceSessionGrants.filter((g) => g.session_id === `sess-${CIBLE}-1`).map((g) => g.licencie_id)).toEqual([FRERE]);
    expect(state.devicePushTokens.some((p) => p.session_id === `sess-${CIBLE}-1`)).toBe(true);
    expect(state.deviceSessions.some((s) => s.id === `sess-${CIBLE}-2`)).toBe(false);
  });

  it("un identifiant d'un autre club ne touche rien", async () => {
    const avant = everything(state);
    await deleteLicencieAccess(db, CLUB, [AUTRE]);
    expect(everything(state)).toBe(avant);
    expect(state.storageRemovals).toEqual([]);
  });

  it("erreur de la transaction : rien n'est modifié, aucune photo supprimée, l'erreur remonte", async () => {
    const avant = everything(state);
    state.deleteLicencieAccessFailure = "boom sur la dernière opération";

    await expect(deleteLicencieAccess(db, CLUB, [CIBLE])).rejects.toThrow(/boom/);

    expect(everything(state)).toBe(avant);
    expect(state.storageRemovals).toEqual([]);
  });

  it("échec du stockage : journalisé avec le chemin, sans exception, base déjà nettoyée", async () => {
    state.storageRemoveError = "bucket indisponible";

    await expect(deleteLicencieAccess(db, CLUB, [CIBLE])).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![2]).toEqual({ clubId: CLUB, path: `${CLUB}/${CIBLE}/p.webp` });
    expect(state.publicTokens.some((t) => t.licencie_id === CIBLE)).toBe(false);
    expect(state.licencies.find((l) => l.id === CIBLE)!.photo_url).toBeNull();
  });

  it("liste vide : aucun appel", async () => {
    await deleteLicencieAccess(db, CLUB, []);
    expect(state.deleteLicencieAccessCalls).toEqual([]);
  });
});
