/**
 * Recherche de son nom dans l'espace public (retour du club, 2026-10-08 :
 * « la personne met son nom et prénom en entier, peu importe l'ordre ; si
 * je tape "ansi abde meriuam", ça propose Anis »). Remplace l'annuaire
 * complet (risque R-013, docs/migration/11-init-repo-back.md §7 côté ball-manager-web) :
 * prénom ET nom obligatoires, au plus 5 propositions, jamais le nom complet.
 *
 * Fonctions pures, sans base : testées à part (name-search.test.ts).
 */

export const MAX_RESULTS = 5;
/** Ressemblance minimale (Jaro-Winkler) d'un mot tapé avec un mot du prénom / du nom. */
const WORD_MATCH = 0.84;
/** Tout mot tapé doit ressembler au moins à ce point à un mot de la fiche (un mot inventé écarte la fiche). */
const ANY_WORD_MIN = 0.78;

export interface RosterEntry {
  id: string;
  firstName: string;
  lastName: string;
}

export interface NameMatch {
  id: string;
  firstName: string;
  lastInitial: string;
  score: number;
}

/** Minuscules, sans accents ; `-`, `'` et espaces séparent les mots. */
export function words(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[\s\-'’]+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter(Boolean);
}

export type QueryCheck = { ok: true; words: string[] } | { ok: false; code: "QUERY_TOO_SHORT" | "INVALID_QUERY" };

/** Prénom + nom : 2 à 6 mots d'au moins 2 lettres, 80 caractères au plus. */
export function checkQuery(raw: string): QueryCheck {
  if (raw.length > 80) return { ok: false, code: "INVALID_QUERY" };
  const w = words(raw);
  if (w.length > 6) return { ok: false, code: "INVALID_QUERY" };
  const long = w.filter((x) => x.length >= 2);
  if (long.length < 2) return { ok: false, code: "QUERY_TOO_SHORT" };
  return { ok: true, words: long };
}

/** Similarité de Jaro-Winkler (0 à 1), tolère les lettres inversées et les fautes de frappe. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function best(word: string, candidates: string[]): number {
  return candidates.reduce((top, c) => Math.max(top, jaroWinkler(word, c)), 0);
}

/**
 * Fiches qui correspondent : un mot tapé ressemble au prénom, un AUTRE au
 * nom (ordre libre), et aucun mot tapé n'est sans rapport avec la fiche.
 * Classement par ressemblance moyenne ; au plus 5.
 */
export function searchRoster(queryWords: string[], roster: RosterEntry[]): NameMatch[] {
  const results: NameMatch[] = [];
  for (const entry of roster) {
    const first = words(entry.firstName);
    const last = words(entry.lastName);
    if (first.length === 0 || last.length === 0) continue;
    const all = [...first, ...last];

    const perWord = queryWords.map((w) => best(w, all));
    if (perWord.some((s) => s < ANY_WORD_MIN)) continue;

    // Un mot pour le prénom, un autre pour le nom.
    let covered = false;
    for (let i = 0; i < queryWords.length && !covered; i++) {
      if (best(queryWords[i]!, first) < WORD_MATCH) continue;
      for (let j = 0; j < queryWords.length; j++) {
        if (j !== i && best(queryWords[j]!, last) >= WORD_MATCH) {
          covered = true;
          break;
        }
      }
    }
    if (!covered) continue;

    const score = perWord.reduce((s, x) => s + x, 0) / perWord.length;
    results.push({ id: entry.id, firstName: entry.firstName, lastInitial: (entry.lastName.trim()[0] ?? "").toUpperCase(), score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}
