/**
 * Erreurs et statuts FBI partagés entre `HttpFbiClient` (./http-client.ts)
 * et `BrowserFbiClient` (./browser-client.ts) — les deux vivent dans ce
 * même backend (contrairement à l'ancien split app/worker de ball-manager-web), donc un
 * seul module d'erreurs, plus de duplication nécessaire.
 */

export type FbiErrorCode =
  | "LOGIN_PAGE_UNREACHABLE"
  | "LOGIN_FORM_NOT_RECOGNIZED"
  | "LOGIN_FAILED"
  | "SESSION_EXPIRED"
  | "EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED"
  | "EMARQUE_MATCH_PAGE_NOT_REACHED"
  | "SCHEDULE_SEARCH_ENDPOINT_NOT_CONFIRMED"
  | "SCHEDULE_SEARCH_SCREEN_NOT_REACHED"
  | "DEROGATION_SEARCH_ENDPOINT_NOT_CONFIRMED"
  | "REQUEST_FAILED"
  | "NAVIGATION_FAILED";

export class FbiError extends Error {
  constructor(
    message: string,
    readonly code: FbiErrorCode,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FbiError";
  }
}

/**
 * Statut de connexion FBI (§15 du brief FBI) : un simple HTTP 200 ne prouve
 * rien pour une appli Java legacy qui peut très bien renvoyer 200 sur sa
 * propre page de connexion en cas d'échec — la vraie preuve est l'ABSENCE du
 * formulaire de connexion sur la page d'atterrissage (voir
 * `looksLikeLoginPage` dans http-client.ts / browser-client.ts).
 */
export type FbiLoginStatus = "CONNECTED" | "INVALID_CREDENTIALS" | "FBI_UNAVAILABLE" | "AUTH_FLOW_CHANGED" | "UNKNOWN_ERROR";

/**
 * Traduit une tentative de connexion (succès ou `FbiError`) vers le statut
 * exploitable par l'UI et par la logique de retry du worker :
 * - INVALID_CREDENTIALS ne doit JAMAIS être auto-retried (mot de passe faux
 *   ne devient pas vrai en réessayant) ;
 * - FBI_UNAVAILABLE justifie un retry avec backoff (panne transitoire) ;
 * - AUTH_FLOW_CHANGED justifie de créer un `FBI_AUTOMATION_CHANGED` (§44).
 */
export function classifyFbiLoginStatus(error: unknown): FbiLoginStatus {
  if (!error) return "CONNECTED";
  if (!(error instanceof FbiError)) return "UNKNOWN_ERROR";

  switch (error.code) {
    case "LOGIN_FAILED":
      return "INVALID_CREDENTIALS";
    case "LOGIN_PAGE_UNREACHABLE":
    case "REQUEST_FAILED":
    case "NAVIGATION_FAILED":
      return "FBI_UNAVAILABLE";
    case "LOGIN_FORM_NOT_RECOGNIZED":
      return "AUTH_FLOW_CHANGED";
    default:
      return "UNKNOWN_ERROR";
  }
}
