/**
 * Définition UNIQUE d'un créneau de match et de la règle de chevauchement —
 * source de vérité partagée par les Tables de marque (`modules/tables`), les
 * dérogations officielles FBI (`modules/derogations/schedule-conflict.ts`) et
 * les demandes de dérogation internes (`modules/derogation-requests`).
 * Retour du club, 2026-10-01 : "je ne veux PAS recréer une deuxième logique
 * de calendrier... garder une seule source de vérité pour ces règles".
 *
 * Fonctions PURES, aucune dépendance à `Date.now()`.
 */

/** Un match occupe 120 minutes : 15:00 → [15:00 ; 17:00). */
export const DEFAULT_MATCH_DURATION_MINUTES = 120;

/** Pas des heures de départ proposées (demandes de dérogation) : 13:00, 13:30, 14:00… (demi-heures, retour du club 2026-10-22). */
export const DEFAULT_SLOT_STEP_MINUTES = 30;

export interface TimeWindow {
  start: Date;
  end: Date;
}

/**
 * Fenêtre horaire d'un match : `[matchDatetime ; matchDatetime + durationMinutes)`.
 * `travelBufferMinutes` ÉTEND la fenêtre des DEUX côtés (point d'extension
 * des Tables de marque, 0 par défaut).
 */
export function computeMatchWindow(matchDatetime: Date, durationMinutes: number = DEFAULT_MATCH_DURATION_MINUTES, travelBufferMinutes = 0): TimeWindow {
  const bufferMs = travelBufferMinutes * 60_000;
  return {
    start: new Date(matchDatetime.getTime() - bufferMs),
    end: new Date(matchDatetime.getTime() + durationMinutes * 60_000 + bufferMs),
  };
}

/**
 * Règle de chevauchement centrale : `aStart < bEnd ET bStart < aEnd`.
 * STRICTE : 15:00→17:00 et 17:00→19:00 se touchent sans se chevaucher
 * (compatibles) ; 15:00→17:00 et 16:00→18:00 se chevauchent (conflit).
 */
export function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Raccourci : deux matchs (créneaux de durée standard) se chevauchent-ils ? */
export function matchSlotsOverlap(aStart: Date, bStart: Date, durationMinutes: number = DEFAULT_MATCH_DURATION_MINUTES): boolean {
  const a = computeMatchWindow(aStart, durationMinutes);
  const b = computeMatchWindow(bStart, durationMinutes);
  return intervalsOverlap(a.start, a.end, b.start, b.end);
}
