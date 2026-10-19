/**
 * Conflits de planning (demande du club, 2026-09-25 puis 2026-10-19 :
 * « surtout les matchs sur même créneau même salle ») :
 *
 * - **Salle** : deux rencontres À DOMICILE dans la même salle dont les
 *   créneaux se chevauchent (début à moins de `MATCH_SLOT_MINUTES` l'un de
 *   l'autre, pas seulement à l'horaire exact : 11h et 12h à Clavel ne
 *   tiennent pas non plus). Seules les rencontres à domicile occupent une
 *   salle DU CLUB. Salle comparée sur `venueId` quand les deux en ont un
 *   (identité résolue par la synchro FFBB), sinon sur `venueRawLabel`
 *   normalisé.
 * - **Équipe** : une même équipe programmée deux fois le même jour (heure de
 *   Paris), domicile ou extérieur — typiquement après une dérogation.
 */

/** Durée d'occupation de la salle retenue pour un match (échauffement compris). */
export const MATCH_SLOT_MINUTES = 90;

export interface VenueConflictCandidate {
  id: string;
  numero: string | null;
  opponentName: string | null;
  matchDatetime: string;
  venueId: string | null;
  venueRawLabel: string | null;
}

export interface VenueConflictResult {
  matchId: string;
  conflictingMatchIds: string[];
  conflictingLabel: string;
}

function venueKey(m: VenueConflictCandidate): string | null {
  if (m.venueId) return `id:${m.venueId}`;
  if (m.venueRawLabel && m.venueRawLabel.trim()) return `label:${m.venueRawLabel.trim().toUpperCase()}`;
  return null;
}

function label(m: { numero: string | null; opponentName: string | null; matchDatetime: string }): string {
  const time = new Date(m.matchDatetime).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
  return `n°${m.numero ?? "?"} vs ${m.opponentName ?? "?"} à ${time}`;
}

/**
 * Même rencontre présente deux fois côté FFBB (deux identifiants FFBB, même
 * numéro, même adversaire, même horaire — constaté en U11-2 le 2026-10-19) :
 * un doublon de données, jamais un conflit de planning.
 */
function isSameFixture(a: { numero: string | null; opponentName: string | null; matchDatetime: string }, b: typeof a): boolean {
  return a.numero !== null && a.numero === b.numero && a.opponentName === b.opponentName && new Date(a.matchDatetime).getTime() === new Date(b.matchDatetime).getTime();
}

/** Pour chaque élément, les autres éléments avec lesquels il est en conflit (relation symétrique). */
function pairConflicts<T extends { id: string; numero: string | null; opponentName: string | null; matchDatetime: string }>(
  items: readonly T[],
  inConflict: (a: T, b: T) => boolean,
): VenueConflictResult[] {
  const results: VenueConflictResult[] = [];
  for (const match of items) {
    const others = items.filter((other) => other.id !== match.id && !isSameFixture(match, other) && inConflict(match, other));
    if (others.length === 0) continue;
    results.push({ matchId: match.id, conflictingMatchIds: others.map((o) => o.id), conflictingLabel: others.map(label).join(", ") });
  }
  return results;
}

/**
 * Fonction PURE : `candidates` déjà filtrés par l'appelant (à domicile,
 * saison en cours, date/heure connue — voir modules/issues/routes.ts).
 */
export function detectVenueConflicts(candidates: VenueConflictCandidate[]): VenueConflictResult[] {
  const slotMs = MATCH_SLOT_MINUTES * 60_000;
  return pairConflicts(
    candidates.filter((c) => venueKey(c) !== null),
    (a, b) => venueKey(a) === venueKey(b) && Math.abs(new Date(a.matchDatetime).getTime() - new Date(b.matchDatetime).getTime()) < slotMs,
  );
}

export interface TeamConflictCandidate {
  id: string;
  numero: string | null;
  opponentName: string | null;
  matchDatetime: string;
  teamId: string | null;
}

function parisDay(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" });
}

/** Fonction PURE : même équipe, deux rencontres le même jour (heure de Paris). */
export function detectTeamConflicts(candidates: TeamConflictCandidate[]): VenueConflictResult[] {
  return pairConflicts(
    candidates.filter((c) => c.teamId),
    (a, b) => a.teamId === b.teamId && parisDay(a.matchDatetime) === parisDay(b.matchDatetime),
  );
}
