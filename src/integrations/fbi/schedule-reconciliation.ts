import type { FbiScheduleDiscrepancyKind, MatchStatus } from "../../db/types.js";
import { zonedWallTimeToUtc } from "../../util/timezone.js";
import type { FbiScheduleRow } from "./types.js";

/**
 * Rapprochement calendrier FFBB/FBI (demande du club, voir docs/FBI.md) :
 * "FBI est l'info réelle. si ya une info sur fbi pour la même rencontre
 * différente de ffbb, c'est une anomalie. si un match est sur fbi, et pas
 * sur ffbb, c'est à alerter aussi."
 *
 * Revirement du 2026-09-27 : le club a explicitement demandé que FBI
 * l'EMPORTE désormais sur FFBB en cas d'écart ("FBI doit emporter sur FFBB
 * car les vraies infos proviennent de FBI") — pour date/heure ET salle
 * UNIQUEMENT (les deux seuls champs comparés ici, voir plus bas ; le club
 * a confirmé cette portée explicitement). Cette fonction reste PURE (aucune
 * IO) : elle calcule la `correction` à appliquer pour chaque `mismatch`
 * détecté, mais c'est `process-reconcile-schedule.ts` qui écrit
 * effectivement dans `matches`. `missing_in_ffbb`/`missing_in_fbi` restent
 * de simples anomalies à traiter manuellement — FBI n'a pas assez
 * d'information (logo, équipe, engagement FFBB...) pour créer/compléter un
 * match tout seul.
 *
 * Portée v1 volontairement limitée à ce qui peut être comparé de façon
 * FIABLE sans avoir pu observer le format réel d'un match déjà joué sur
 * FBI (voir "Ce qui n'est pas fait" dans docs/FBI.md) :
 * - présence (missing_in_ffbb / missing_in_fbi) — la demande explicite du
 *   club, jamais ambiguë ;
 * - date/heure (mismatch) — c'est précisément la valeur ajoutée citée par
 *   le club ("les modifs en avance") : FBI montre un changement de date/
 *   heure AVANT que la resynchro FFBB (qui tourne périodiquement) ne le
 *   reflète ;
 * - salle (mismatch) — comparaison VOLONTAIREMENT tolérante (voir
 *   `venuesLikelyMatch`) : le format exact du texte FBI n'a jamais été
 *   confirmé par une capture d'écran réelle, et `matches.venue_raw_label`
 *   combine nom ET adresse FFBB (`"Nom — Adresse"`) alors que FBI n'affiche
 *   vraisemblablement que le nom — une égalité stricte produirait une
 *   anomalie sur QUASIMENT chaque rencontre.
 * Score/forfait ne sont PAS comparés ici : le format réel d'un "Score 1"/
 * "Forfait 1" FBI pour un match joué n'a jamais été observé (les captures
 * fournies ne montrent que des rencontres à venir, colonnes vides), et la
 * colonne Forfait est une case à cocher (jamais un texte —
 * `selectors.resultsTableGenericRows` ne lit que du texte de cellule, donc
 * toujours vide pour cette colonne pour l'instant).
 */

export interface OurMatchForReconciliation {
  id: string;
  competitionCode: string | null;
  numero: string | null;
  matchDatetime: string | null;
  venueRawLabel: string | null;
  status: MatchStatus;
}

/**
 * Valeur à écrire dans `matches` pour appliquer la correction FBI —
 * UNIQUEMENT pour `kind: "mismatch"` ; toujours `null` pour une anomalie de
 * présence (`missing_in_ffbb`/`missing_in_fbi`), où FBI seul ne suffit pas
 * à créer/compléter une ligne `matches`.
 */
export type ScheduleDiscrepancyCorrection = { matchDatetime: string } | { venueRawLabel: string } | null;

export interface ScheduleDiscrepancyInput {
  matchId: string | null;
  divisionCode: string | null;
  numero: string | null;
  kind: FbiScheduleDiscrepancyKind;
  fieldName: string | null;
  ffbbValue: string | null;
  fbiValue: string | null;
  fbiOpponentName: string | null;
  correction: ScheduleDiscrepancyCorrection;
}

/** Clé de rapprochement FFBB/FBI : `competitions.code` + `matches.numero` = "Division" + "N°" FBI (voir docs/FBI.md). */
function reconciliationKey(division: string | null, numero: string | null): string | null {
  if (!division || !numero) return null;
  return `${division.trim().toUpperCase()}::${numero.trim().toUpperCase()}`;
}

/** Une rencontre "Exempt" (bye/tour sans adversaire — visible sur la capture fournie par le club, ex: "BU11FN23 n°5") n'a jamais de ligne `matches` correspondante côté FFBB : ce n'est pas une anomalie. */
function isByeRow(row: FbiScheduleRow): boolean {
  const isExempt = (v: string | null) => v?.trim().toLowerCase() === "exempt";
  return isExempt(row.equipe1) || isExempt(row.equipe2);
}

function fbiOpponentLabel(row: FbiScheduleRow): string | null {
  const parts = [row.equipe1, row.equipe2].filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(" – ") : null;
}

/** "11:00" ou "11h00" -> "11:00". `null` si le format n'est pas reconnu (jamais une comparaison hasardeuse). */
function normalizeFbiHeure(heure: string | null): string | null {
  if (!heure) return null;
  const match = /^(\d{1,2})[:h](\d{2})/.exec(heure.trim());
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

/** "26/09/2026" -> { year: 2026, month: 9, day: 26 }, `null` si le format n'est pas reconnu. */
function parseFrenchDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  return { day: Number(match[1]), month: Number(match[2]), year: Number(match[3]) };
}

/**
 * Compare deux libellés de salle en tolérant les différences de FORMAT
 * (jamais de contenu confirmé) : `matches.venue_raw_label` combine nom ET
 * adresse FFBB (`"Nom — Adresse"`), FBI n'affiche vraisemblablement que le
 * nom, et la casse peut différer ("GYMNASE X" vs "Gymnase X"). Une
 * correspondance PARTIELLE (l'un contient l'autre, une fois normalisé)
 * suffit à considérer que c'est la MÊME salle — seule une salle FBI qui
 * n'apparaît nulle part dans notre libellé est traitée comme un vrai
 * changement de salle.
 *
 * Normalise aussi les espaces INSÉCABLES (U+00A0) en espace normal —
 * constaté en production le 2026-09-28 : le texte de cellule scrapé du
 * tableau FBI (`resultsTableGenericRows`) utilise `&nbsp;` entre les mots
 * (mots séparés par \u00A0 côté FBI), jamais un espace ASCII normal comme
 * le libellé FFBB — sans cette normalisation, `.includes()` échouait sur
 * QUASIMENT chaque salle réellement identique, produisant un faux
 * `mismatch` à chaque rapprochement.
 */
const NON_BREAKING_SPACE = String.fromCharCode(160);

function normalizeVenueText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(NON_BREAKING_SPACE)
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * FBI tronque les noms de salle trop longs dans son tableau de résultats,
 * en ajoutant "..." littéral (jamais une troncature CSS invisible) —
 * constaté en production le 2026-09-28 : "GYMNASE MAURICE C..." pour
 * "GYMNASE MAURICE CLAVEL — 22 rue Maurice Clavel". Sans ce garde-fou,
 * cette version tronquée ne matchait JAMAIS notre libellé complet (ni
 * `includes` ni l'inverse — un préfixe n'est contenu dans rien), créant un
 * faux `mismatch` de salle ; pire, la correction appliquée ÉCRASAIT alors
 * notre libellé complet et correct par ce texte tronqué et inutilisable
 * (`processReconcileScheduleJob` écrit `correction.venueRawLabel` tel
 * quel dans `matches.venue_raw_label`) — reproduit et corrigé en base pour
 * ~20 rencontres du club pilote ce même jour.
 */
const FBI_TRUNCATION_SUFFIX = "...";

function isTruncatedFbiSalle(fbiSalle: string): boolean {
  return fbiSalle.trim().endsWith(FBI_TRUNCATION_SUFFIX);
}

function venuesLikelyMatch(ourVenueRawLabel: string, fbiSalle: string): boolean {
  const a = normalizeVenueText(ourVenueRawLabel);
  if (!a) return false;

  if (isTruncatedFbiSalle(fbiSalle)) {
    const prefix = normalizeVenueText(fbiSalle.trim().slice(0, -FBI_TRUNCATION_SUFFIX.length));
    return prefix.length > 0 && a.startsWith(prefix);
  }

  const b = normalizeVenueText(fbiSalle);
  if (!b) return false;
  return a.includes(b) || b.includes(a);
}

/** Date/heure de notre match, dans le même format que les colonnes FBI ("26/09/2026" / "11:00"), en fuseau Europe/Paris — jamais une comparaison UTC brute contre un affichage FBI qui est forcément en heure locale. */
function ourDateTimeParts(matchDatetime: string | null): { date: string; time: string } | null {
  if (!matchDatetime) return null;
  const parsed = new Date(matchDatetime);
  if (Number.isNaN(parsed.getTime())) return null;

  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(parsed);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  return { date: `${get("day")}/${get("month")}/${get("year")}`, time: `${get("hour")}:${get("minute")}` };
}

/** "26/09/2026 11:00" (heure de Paris) : le format de `ffbb_value`/`fbi_value` d'un écart de date/heure. */
export function formatParisDateTime(matchDatetime: string): string | null {
  const parts = ourDateTimeParts(matchDatetime);
  return parts ? `${parts.date} ${parts.time}` : null;
}

/**
 * Fonction PURE (aucune IO) : compare le listing FBI d'un club (les DEUX
 * passes "non joué" coché/décoché, voir `BrowserFbiClient.fetchScheduleRows`)
 * à ses rencontres FFBB déjà synchronisées, et produit la liste des
 * anomalies détectées. `ourMatches` doit couvrir TOUTES les rencontres du
 * club pour cette saison (pas seulement une page) — une rencontre absente
 * de `ourMatches` mais présente côté FFBB produirait un faux
 * `missing_in_ffbb`.
 */
export function reconcileFbiSchedule(fbiRows: FbiScheduleRow[], ourMatches: OurMatchForReconciliation[]): ScheduleDiscrepancyInput[] {
  const discrepancies: ScheduleDiscrepancyInput[] = [];

  const fbiByKey = new Map<string, FbiScheduleRow>();
  for (const row of fbiRows) {
    if (isByeRow(row)) continue;
    const key = reconciliationKey(row.division, row.numero);
    if (key) fbiByKey.set(key, row);
  }

  const ourByKey = new Map<string, OurMatchForReconciliation>();
  for (const match of ourMatches) {
    const key = reconciliationKey(match.competitionCode, match.numero);
    if (key) ourByKey.set(key, match);
  }

  for (const [key, fbiRow] of fbiByKey) {
    const ourMatch = ourByKey.get(key);

    if (!ourMatch) {
      discrepancies.push({
        matchId: null,
        divisionCode: fbiRow.division,
        numero: fbiRow.numero,
        kind: "missing_in_ffbb",
        fieldName: null,
        ffbbValue: null,
        fbiValue: fbiOpponentLabel(fbiRow),
        fbiOpponentName: fbiOpponentLabel(fbiRow),
        correction: null,
      });
      continue;
    }

    const fbiDate = fbiRow.dateRencontre;
    const fbiTime = normalizeFbiHeure(fbiRow.heure);
    const ourDateTime = ourDateTimeParts(ourMatch.matchDatetime);

    if (fbiDate && fbiTime && ourDateTime && (fbiDate !== ourDateTime.date || fbiTime !== ourDateTime.time)) {
      const dateParts = parseFrenchDateParts(fbiDate);
      const timeParts = /^(\d{2}):(\d{2})$/.exec(fbiTime);
      const correction: ScheduleDiscrepancyCorrection =
        dateParts && timeParts
          ? { matchDatetime: zonedWallTimeToUtc(dateParts.year, dateParts.month, dateParts.day, Number(timeParts[1]), Number(timeParts[2]), 0, "Europe/Paris").toISOString() }
          : null;

      discrepancies.push({
        matchId: ourMatch.id,
        divisionCode: fbiRow.division,
        numero: fbiRow.numero,
        kind: "mismatch",
        fieldName: "match_datetime",
        ffbbValue: `${ourDateTime.date} ${ourDateTime.time}`,
        fbiValue: `${fbiDate} ${fbiTime}`,
        fbiOpponentName: fbiOpponentLabel(fbiRow),
        correction,
      });
    }

    const fbiSalle = fbiRow.salle?.trim() || null;
    const ourVenue = ourMatch.venueRawLabel?.trim() || null;

    if (fbiSalle && ourVenue && !venuesLikelyMatch(ourVenue, fbiSalle)) {
      discrepancies.push({
        matchId: ourMatch.id,
        divisionCode: fbiRow.division,
        numero: fbiRow.numero,
        kind: "mismatch",
        fieldName: "venue_raw_label",
        ffbbValue: ourVenue,
        fbiValue: fbiSalle,
        fbiOpponentName: fbiOpponentLabel(fbiRow),
        // Une salle FBI tronquée ("GYMNASE MAURICE C...") ne doit JAMAIS
        // écraser notre libellé complet, même dans le cas — rare — où elle
        // ne matche aucun de nos libellés connus (préfixe réellement
        // ambigu, ex. "HALLE DES SPORTS ..." qui correspond à 3 salles
        // différentes) : l'anomalie reste visible (kind: "mismatch",
        // fbiValue tronqué) pour vérification manuelle, mais `correction:
        // null` empêche `processReconcileScheduleJob` de l'appliquer (voir
        // son garde `!discrepancy.correction`).
        correction: isTruncatedFbiSalle(fbiSalle) ? null : { venueRawLabel: fbiSalle },
      });
    }
  }

  for (const [key, ourMatch] of ourByKey) {
    if (fbiByKey.has(key)) continue;
    // Une rencontre ANNULÉE côté FFBB n'a normalement jamais existé côté
    // FBI non plus — son absence est attendue, jamais une anomalie.
    if (ourMatch.status === "cancelled") continue;

    discrepancies.push({
      matchId: ourMatch.id,
      divisionCode: ourMatch.competitionCode,
      numero: ourMatch.numero,
      kind: "missing_in_fbi",
      fieldName: null,
      ffbbValue: null,
      fbiValue: null,
      fbiOpponentName: null,
      correction: null,
    });
  }

  return discrepancies;
}
