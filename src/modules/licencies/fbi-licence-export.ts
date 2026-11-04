import JSZip from "jszip";

/**
 * Lecture de l'export Excel FBI « Gestion des licences »
 * (rechercherLicence.fbi, filtre « Validation : Validé », bouton Excel) —
 * retour du club, 2026-10-08 : « avec l'excel téléchargé, ça s'exploite ».
 *
 * En-têtes RÉELS du fichier fourni par le club (ligne 1) : N° national,
 * Numéro, Nom, Prénom, Né(e) le, Groupement, Licence, Catégorie,
 * Qualification, Sexe, Surc., Fonctions. Cellules en texte (inlineStr) ;
 * les nombres/dates Excel natifs et les chaînes partagées sont aussi lus,
 * au cas où FBI changerait de générateur.
 *
 * Fonction pure (aucune base) : testée à part, utilisée par le job FBI et
 * par le dépôt manuel du fichier.
 */

export interface FbiLicenceRow {
  /** « N° national » : identifiant FFBB stable de la personne (clé de rapprochement). */
  ffbbLicenceId: string;
  /** « Numéro » (ex. VT123456), peut changer d'une saison à l'autre. */
  licenseNumber: string | null;
  firstName: string;
  lastName: string;
  /** AAAA-MM-JJ. */
  birthDate: string | null;
  categoryLabel: string | null;
  sexe: "M" | "F" | null;
}

export interface FbiLicenceExport {
  rows: FbiLicenceRow[];
  /** Lignes ignorées (N° national, nom ou prénom manquant). */
  skippedLines: number;
}

export class LicenceExportError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_AN_XLSX" | "NOT_A_LICENCE_EXPORT" | "EMPTY_EXPORT",
  ) {
    super(message);
    this.name = "LicenceExportError";
  }
}

/** Fichier plus gros que ça : ce n'est pas un export de club (190 licences ≈ 18 Ko). */
export const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

type Column = "ffbbLicenceId" | "licenseNumber" | "lastName" | "firstName" | "birthDate" | "categoryLabel" | "sexe";

/** Libellés acceptés par colonne, comparés sans accents ni casse ni ponctuation. */
const HEADERS: Record<Column, string[]> = {
  ffbbLicenceId: ["n national", "no national", "numero national"],
  licenseNumber: ["numero", "n licence", "numero licence"],
  lastName: ["nom"],
  firstName: ["prenom"],
  birthDate: ["ne e le", "nee le", "ne le", "date de naissance"],
  categoryLabel: ["categorie"],
  sexe: ["sexe"],
};

function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[°º]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** Texte d'un nœud `<si>` / `<is>` (plusieurs `<t>` possibles en texte enrichi). */
function richText(xml: string): string {
  return decodeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1] ?? "").join(""));
}

/** « AB » → 27 (base 26, A = 1). */
function columnIndex(ref: string): number {
  let index = 0;
  for (const char of ref) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** Date Excel (jours depuis le 30/12/1899) → AAAA-MM-JJ. */
function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function toIsoDate(raw: string, numeric: boolean): string | null {
  const value = raw.trim();
  if (!value) return null;
  const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (fr) {
    const [, d, m, y] = fr;
    const iso = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
    const check = new Date(`${iso}T00:00:00Z`);
    return !Number.isNaN(check.getTime()) && check.toISOString().startsWith(iso) ? iso : null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (numeric && /^\d+(\.\d+)?$/.test(value)) return excelSerialToIso(Number(value));
  return null;
}

interface Cell {
  value: string;
  numeric: boolean;
}

/** Lignes de la première feuille, cellules indexées par colonne. */
function readSheetRows(sheetXml: string, sharedStrings: string[]): Cell[][] {
  const rows: Cell[][] = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Cell[] = [];
    for (const cellMatch of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? "";
      const inner = cellMatch[2] ?? "";
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = "";
      if (type === "inlineStr") value = richText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
      else if (type === "s") value = sharedStrings[Number(raw)] ?? "";
      else if (raw !== undefined) value = decodeXml(raw);
      const index = ref ? columnIndex(ref) : cells.length;
      cells[index] = { value: value.trim(), numeric: type === "n" && raw !== undefined };
    }
    rows.push(cells);
  }
  return rows;
}

async function firstSheetXml(zip: JSZip): Promise<string | null> {
  // Feuille déclarée en premier dans le classeur (sheet1.xml dans l'export FBI).
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  const firstRelId = workbook ? /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1] : undefined;
  if (firstRelId && rels) {
    const target = new RegExp(`<Relationship\\b[^>]*Id="${firstRelId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstRelId}"`).exec(rels)?.[1];
    if (target) {
      const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
      const xml = await zip.file(path)?.async("string");
      if (xml) return xml;
    }
  }
  const fallback = Object.keys(zip.files).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  return fallback ? ((await zip.file(fallback)?.async("string")) ?? null) : null;
}

export async function parseFbiLicenceExport(buffer: Uint8Array): Promise<FbiLicenceExport> {
  if (buffer.byteLength > MAX_EXPORT_BYTES) throw new LicenceExportError("Fichier trop volumineux pour un export de licences FBI.", "NOT_A_LICENCE_EXPORT");

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new LicenceExportError("Ce fichier n'est pas un fichier Excel (.xlsx). Télécharge l'export depuis FBI avec le bouton Excel.", "NOT_AN_XLSX");
  }

  const sheetXml = await firstSheetXml(zip);
  if (!sheetXml) throw new LicenceExportError("Ce fichier Excel ne contient aucune feuille lisible.", "NOT_AN_XLSX");

  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const sharedStrings = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => richText(m[1] ?? "")) : [];

  const sheetRows = readSheetRows(sheetXml, sharedStrings);
  const headerRowIndex = sheetRows.findIndex((cells) => cells.some((c) => c && normalizeHeader(c.value) === "nom"));
  if (headerRowIndex < 0) throw notALicenceExport(["N° national", "Nom", "Prénom"]);

  const headerCells = sheetRows[headerRowIndex]!.map((c) => (c ? normalizeHeader(c.value) : ""));
  const index = Object.fromEntries((Object.keys(HEADERS) as Column[]).map((key) => [key, headerCells.findIndex((h) => HEADERS[key].includes(h))])) as Record<Column, number>;
  const missing = [index.ffbbLicenceId < 0 && "N° national", index.lastName < 0 && "Nom", index.firstName < 0 && "Prénom"].filter((x): x is string => Boolean(x));
  if (missing.length > 0) throw notALicenceExport(missing);

  const rows: FbiLicenceRow[] = [];
  let skippedLines = 0;
  for (const cells of sheetRows.slice(headerRowIndex + 1)) {
    const get = (key: Column): Cell | undefined => (index[key] >= 0 ? cells[index[key]] : undefined);
    if (!cells.some((c) => c && c.value)) continue; // ligne vide

    const idCell = get("ffbbLicenceId");
    // « N° national » numérique dans Excel : « 200000002740760 » sans décimale ni notation scientifique.
    const ffbbLicenceId = idCell ? (idCell.numeric && /^\d+(\.0+)?$/.test(idCell.value) ? idCell.value.replace(/\.0+$/, "") : idCell.value) : "";
    const lastName = get("lastName")?.value ?? "";
    const firstName = get("firstName")?.value ?? "";
    if (!ffbbLicenceId || !lastName || !firstName) {
      skippedLines += 1;
      continue;
    }

    const birth = get("birthDate");
    const sexe = (get("sexe")?.value ?? "").toUpperCase();
    rows.push({
      ffbbLicenceId,
      licenseNumber: get("licenseNumber")?.value || null,
      firstName,
      lastName,
      birthDate: birth ? toIsoDate(birth.value, birth.numeric) : null,
      categoryLabel: get("categoryLabel")?.value || null,
      sexe: sexe === "M" || sexe === "F" ? sexe : null,
    });
  }

  if (rows.length === 0) throw new LicenceExportError("Aucune licence dans ce fichier. Vérifie que la recherche FBI a bien renvoyé des résultats avant d'exporter.", "EMPTY_EXPORT");
  return { rows, skippedLines };
}

function notALicenceExport(missing: string[]): LicenceExportError {
  return new LicenceExportError(
    `Ce fichier ne ressemble pas à l'export « Rechercher une licence » de FBI (colonne${missing.length > 1 ? "s" : ""} manquante${missing.length > 1 ? "s" : ""} : ${missing.join(", ")}).`,
    "NOT_A_LICENCE_EXPORT",
  );
}
