/**
 * Fonctions pures : normalisation FFBB -> ligne DB, et détection des
 * changements. Séparées de tout accès réseau/DB pour rester testables
 * unitairement (voir ARCHITECTURE.md §9 et le brief "tests FFBB : mapping,
 * diff, idempotence").
 */
import type { NormalizedMatch } from "./types.js";
import type { Database } from "../../db/types.js";

type MatchRow = Database["public"]["Tables"]["matches"]["Row"];
type MatchInsert = Database["public"]["Tables"]["matches"]["Insert"];

/** Champs FFBB dont un changement doit être historisé (ARCHITECTURE.md §9). */
export const TRACKED_MATCH_FIELDS = [
  "match_datetime",
  "venue_raw_label",
  "opponent_name",
  "score_home",
  "score_away",
  "status",
] as const;

export type TrackedMatchField = (typeof TRACKED_MATCH_FIELDS)[number];

export interface MatchMappingContext {
  clubId: string;
  teamId: string | null;
  competitionId: string | null;
  poolId: string | null;
  venueId: string | null;
}

/**
 * `matches.venue_raw_label` est la SEULE information de salle exposée par
 * l'API aujourd'hui (voir `contracts/matches.ts` : `venueLabel`, pas de
 * champ adresse séparé) — combine nom et adresse plutôt que de perdre
 * l'adresse (stockée séparément dans `venues.address`, mais pas encore
 * exposée par l'API) faute d'un DTO dédié.
 */
function formatVenueLabel(name: string | null | undefined, address: string | null | undefined): string | null {
  const parts = [name, address].filter((part): part is string => Boolean(part && part.trim().length > 0));
  return parts.length > 0 ? parts.join(" — ") : null;
}

/** Convertit un match normalisé FFBB en ligne prête pour upsert dans `matches`. */
export function mapNormalizedMatchToRow(match: NormalizedMatch, context: MatchMappingContext): MatchInsert {
  return {
    club_id: context.clubId,
    ffbb_match_id: match.ffbbId,
    ffbb_unique_key: match.uniqueKey,
    ffbb_gs_id: match.gsId,
    numero: match.numero,
    journee: match.numeroJournee,
    team_id: context.teamId,
    competition_id: context.competitionId,
    pool_id: context.poolId,
    is_home: match.isHome,
    opponent_name: match.opponentName,
    opponent_ffbb_organisme_id: match.opponentOrganismeFfbbId,
    opponent_logo_url: match.opponentLogoUrl,
    venue_id: context.venueId,
    venue_raw_label: formatVenueLabel(match.venue?.name, match.venue?.address),
    match_datetime: match.matchDateTime,
    score_home: match.scoreHome,
    score_away: match.scoreAway,
    status: match.status,
    raw_ffbb_payload: match.raw,
    ffbb_last_seen_at: new Date().toISOString(),
  };
}

export interface FieldDiff {
  field: TrackedMatchField;
  oldValue: string | null;
  newValue: string | null;
}

function toComparableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Postgres relit `match_datetime` en "2026-04-19T09:00:00+00:00", le mapping
 * FFBB l'écrit en "2026-04-19T09:00:00.000Z" : même instant, chaînes
 * différentes. Comparé en ISO normalisé, sinon chaque synchro voyait tous les
 * matchs "déplacés" (historique gonflé et notifications "Match modifié" à tort).
 */
function toComparableValue(field: TrackedMatchField, value: unknown): string | null {
  const text = toComparableString(value);
  if (field !== "match_datetime" || text === null) return text;
  const time = new Date(text).getTime();
  return Number.isNaN(time) ? text : new Date(time).toISOString();
}

/**
 * Compare une ligne existante (ou `null` si le match est nouveau) aux
 * nouvelles valeurs FFBB. Ne retourne que les champs suivis qui ont
 * réellement changé (jamais de diff sur un match nouvellement créé : ce
 * n'est pas un "changement", voir ARCHITECTURE.md §9).
 */
export function diffTrackedFields(existing: MatchRow | null, incoming: MatchInsert): FieldDiff[] {
  if (!existing) return [];

  const diffs: FieldDiff[] = [];

  for (const field of TRACKED_MATCH_FIELDS) {
    const oldValue = toComparableValue(field, existing[field]);
    const newValue = toComparableValue(field, incoming[field]);

    if (oldValue !== newValue) {
      diffs.push({ field, oldValue, newValue });
    }
  }

  return diffs;
}

/**
 * Un match qui vient de passer à "played" doit être proposé au pipeline
 * e-Marque, quel que soit domicile/extérieur (voir ARCHITECTURE.md §9 :
 * on ne sait pas encore avec certitude si seul le club recevant a accès au
 * document via FBI — mieux vaut tenter pour les deux).
 */
export function shouldRequestEmarque(existingStatus: MatchRow["status"] | undefined, incomingStatus: MatchInsert["status"]): boolean {
  return incomingStatus === "played" && existingStatus !== "played";
}
