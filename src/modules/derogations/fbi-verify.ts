import type { SharedFbiSession } from "../../jobs/shared-session.js";
import { isDerogationActionRequired } from "./action-required.js";

/**
 * Envoi FBI incertain (coupure PENDANT l'enregistrement) : l'outil relit FBI
 * lui-même, comme le bouton « Vérifier sur FBI », au lieu de demander à la
 * personne de vérifier (retour du club, 2026-10-22 : « il faut le bouton
 * vérifier sur FBI qui va vérifier, j'ai pas à faire 150 allers-retours »).
 *
 * - `sent` : FBI a bien enregistré → succès ;
 * - `absent` : rien sur FBI → renvoi automatique sans risque de doublon ;
 * - `unknown` : relecture impossible → nouvelle vérification plus tard.
 */
export type FbiVerification = "sent" | "absent" | "unknown";

/** Marge sur l'heure de dépôt FBI (à la minute, heure de Paris). */
const DEPOSIT_SLACK_MS = 5 * 60_000;

/** « JJ/MM/AAAA HH:MM » (heure de Paris) → « AAAAMMJJHHMM » comparable ; null si illisible. */
export function fbiDepositKey(value: string | null | undefined): string | null {
  const match = /(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/.exec(value ?? "");
  if (!match) return null;
  return `${match[3]}${match[2]}${match[1]}${match[4] ?? "00"}${match[5] ?? "00"}`;
}

/** Instant → « AAAAMMJJHHMM » en heure de Paris (même échelle que FBI). */
export function parisKey(instant: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
}

/** Déposée sur FBI depuis `since` (à quelques minutes près) ? Sans heure lisible : même jour ou après. */
export function depositedSince(dateDepot: string | null | undefined, since: Date): boolean {
  const key = fbiDepositKey(dateDepot);
  if (!key) return false;
  const hasTime = /\d{2}:\d{2}/.test(dateDepot ?? "");
  const from = parisKey(new Date(since.getTime() - DEPOSIT_SLACK_MS));
  return hasTime ? key >= from : key.slice(0, 8) >= from.slice(0, 8);
}

/** Création : une dérogation de ce match déposée depuis le début de l'envoi existe-t-elle sur FBI ? */
export async function verifyCreationOnFbi(shared: SharedFbiSession, numero: string, division: string | null, since: Date): Promise<FbiVerification> {
  try {
    const found = await shared.client.fetchDerogationForMatch(shared.session, numero, division);
    if (!found) return "absent";
    return depositedSince(found.dateDepot, since) || depositedSince(found.dateDepotDetail, since) ? "sent" : "absent";
  } catch {
    return "unknown";
  }
}

/** Réponse : la dérogation attend-elle encore la réponse du club sur FBI ? */
export async function verifyResponseOnFbi(
  shared: SharedFbiSession,
  target: { numero: string; division: string | null; idDerogation: string; isHome: boolean | null; demandeur: string | null },
): Promise<FbiVerification> {
  try {
    const found = await shared.client.fetchDerogationForMatch(shared.session, target.numero, target.division);
    if (!found || (found.idDerogation && found.idDerogation !== target.idDerogation)) return "unknown";
    if (!found.etat) return "unknown";
    // Demandeur déjà connu en base quand la relecture du tableau ne le donne pas.
    return isDerogationActionRequired({ etat: found.etat, demandeur: found.demandeur ?? target.demandeur, isHome: target.isHome }) ? "absent" : "sent";
  } catch {
    return "unknown";
  }
}
