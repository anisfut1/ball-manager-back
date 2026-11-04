import { describe, expect, it } from "vitest";
import type { LicencieDto } from "../../contracts/licencies.js";
import { buildLicencieViewer, canViewSensitive, redactLicencieForViewer, type LicencieViewer } from "./redact.js";

const T1 = "t1";
const T2 = "t2";
const T3 = "t3";

function dto(overrides: Partial<LicencieDto> = {}): LicencieDto {
  return {
    id: "l1",
    clubId: "c1",
    firstName: "Camille",
    lastName: "DURAND",
    licenseNumber: "SENTINEL-LIC-0000",
    birthDate: "1901-01-01",
    email: "sentinel-pii@example.invalid",
    phone: "+33000000099",
    photoUrl: "https://example.test/p.webp",
    teamId: T3,
    active: true,
    ffbbLicenceId: "SENTINEL-FFBB-0000",
    categoryLabel: "U13",
    sexe: "F",
    publicAdmin: true,
    publicCoach: true,
    publicCoordinator: true,
    coachedTeamIds: [T1],
    ...overrides,
  };
}

const viewer = (overrides: Partial<LicencieViewer> = {}): LicencieViewer => ({ privileged: false, coachTeamIds: new Set(), ownLicencieId: null, ...overrides });
const SENSITIVE = ["birthDate", "email", "phone", "licenseNumber", "ffbbLicenceId"] as const;

function expectRedacted(out: LicencieDto, original: LicencieDto) {
  for (const key of SENSITIVE) expect(out[key]).toBeNull();
  // Signal explicite pour les clients : « masqué » ≠ « non renseigné » (W4).
  expect(out.sensitiveHidden).toBe(true);
  const { birthDate: _b, email: _e, phone: _p, licenseNumber: _l, ffbbLicenceId: _f, sensitiveHidden: _s, ...rest } = out;
  const { birthDate: _b2, email: _e2, phone: _p2, licenseNumber: _l2, ffbbLicenceId: _f2, ...restOriginal } = original;
  expect(rest).toEqual(restOriginal);
}

describe("redactLicencieForViewer", () => {
  it("acteur sans aucun rôle : champs sensibles à null, le reste intact (dont les drapeaux publics)", () => {
    const original = dto();
    expectRedacted(redactLicencieForViewer(original, buildLicencieViewer([], { coachTeamIds: new Set(), licencieId: null })), original);
  });

  it("ne modifie pas l'objet d'origine", () => {
    const original = dto();
    redactLicencieForViewer(original, viewer());
    expect(original.email).toBe("sentinel-pii@example.invalid");
  });

  it("club_admin et correspondant_club : tout, sur n'importe quelle équipe", () => {
    for (const role of ["club_admin", "correspondant_club"] as const) {
      const original = dto({ teamId: null });
      expect(redactLicencieForViewer(original, buildLicencieViewer([role], { coachTeamIds: new Set(), licencieId: null }))).toEqual(original);
    }
  });

  it("joueur, parent et responsable_tables seuls : rien", () => {
    for (const role of ["joueur", "parent", "responsable_tables"] as const) {
      const original = dto();
      expectRedacted(redactLicencieForViewer(original, buildLicencieViewer([role], { coachTeamIds: new Set(), licencieId: null })), original);
    }
  });

  it("acteur à plusieurs rôles (parent + coach de l'équipe) : voit grâce au rôle coach", () => {
    const original = dto({ teamId: T1 });
    const v = buildLicencieViewer(["parent", "coach"], { coachTeamIds: new Set([T1]), licencieId: null });
    expect(redactLicencieForViewer(original, v)).toEqual(original);
  });

  it("acteur parent + coach d'une autre équipe : ne voit pas", () => {
    const original = dto({ teamId: T3 });
    const v = buildLicencieViewer(["parent", "coach"], { coachTeamIds: new Set([T1]), licencieId: null });
    expectRedacted(redactLicencieForViewer(original, v), original);
  });

  it("coach de deux équipes, licencié cible dans une troisième : ne voit pas", () => {
    const original = dto({ teamId: T3 });
    expectRedacted(redactLicencieForViewer(original, viewer({ coachTeamIds: new Set([T1, T2]) })), original);
  });

  it("coach de deux équipes : voit un licencié de chacune des deux", () => {
    const v = viewer({ coachTeamIds: new Set([T1, T2]) });
    for (const teamId of [T1, T2]) {
      const original = dto({ teamId });
      expect(redactLicencieForViewer(original, v)).toEqual(original);
    }
  });

  it("coach sans portée (ALL) : voit toutes les équipes, mais pas un licencié sans équipe", () => {
    const v = viewer({ coachTeamIds: "ALL" });
    expect(canViewSensitive(dto({ teamId: T3 }), v)).toBe(true);
    expect(canViewSensitive(dto({ teamId: null }), v)).toBe(false);
  });

  it("le licencié lui-même voit sa fiche, y compris sans équipe et sans autre rôle", () => {
    const original = dto({ teamId: null });
    expect(redactLicencieForViewer(original, viewer({ ownLicencieId: original.id }))).toEqual(original);
  });

  it("un parent rattaché à UN licencié (licencie_id) voit cette fiche, pas celle d'un autre", () => {
    const v = viewer({ ownLicencieId: "l1" });
    expect(canViewSensitive(dto({ id: "l1" }), v)).toBe(true);
    expect(canViewSensitive(dto({ id: "l2" }), v)).toBe(false);
  });

  it("club_admin qui est aussi parent d'un autre licencié : voit tout", () => {
    const v = buildLicencieViewer(["club_admin", "parent"], { coachTeamIds: new Set(), licencieId: "l-enfant" });
    expect(canViewSensitive(dto({ id: "l-quelconque" }), v)).toBe(true);
  });

  it("champ sensible déjà null en base : reste null, sans erreur", () => {
    const original = dto({ email: null, phone: null, birthDate: null });
    const out = redactLicencieForViewer(original, viewer());
    expectRedacted(out, original);
  });
});

describe("sensitiveHidden — masqué ≠ non renseigné (W4)", () => {
  it("absent quand le viewer voit la fiche en entier (privilégié, soi-même, coach de l'équipe)", () => {
    const own = dto({ teamId: null });
    expect(redactLicencieForViewer(own, viewer({ ownLicencieId: own.id }))).not.toHaveProperty("sensitiveHidden");
    expect(redactLicencieForViewer(dto(), viewer({ privileged: true }))).not.toHaveProperty("sensitiveHidden");
    expect(redactLicencieForViewer(dto(), viewer({ coachTeamIds: new Set([T3]) }))).not.toHaveProperty("sensitiveHidden");
  });

  it("présent et vrai quand la fiche est masquée, même si la valeur d'origine était déjà null (licence réellement absente)", () => {
    const noLicence = dto({ licenseNumber: null });
    expect(redactLicencieForViewer(noLicence, viewer())).toMatchObject({ licenseNumber: null, sensitiveHidden: true });
  });

  it("un numéro réellement absent reste distinguable : visible + null, sans drapeau", () => {
    const noLicence = dto({ licenseNumber: null, teamId: null });
    const out = redactLicencieForViewer(noLicence, viewer({ privileged: true }));
    expect(out.licenseNumber).toBeNull();
    expect(out).not.toHaveProperty("sensitiveHidden");
  });
});
