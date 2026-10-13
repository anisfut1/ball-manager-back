/**
 * Erreur HTTP typée, traduite par le middleware d'erreur central
 * (src/app.ts) en réponse JSON uniforme `{ error: { code, message } }`
 * (voir docs/API.md). Ne jamais laisser fuiter une stack trace en
 * production — voir le handler d'erreur.
 *
 * `ApiErrorKind` fixe le statut HTTP (petit ensemble fermé). `code` (dans
 * la réponse JSON) peut en revanche être un identifiant métier plus précis
 * — ex: `conflict("...", "FBI_NOT_CONFIGURED")` — toujours à statut 409,
 * mais distinguable côté frontend d'un autre conflit. Sans code explicite,
 * `code` retombe sur le nom du statut générique (comportement inchangé).
 */
export type ApiErrorKind = "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT" | "UNPROCESSABLE" | "TOO_MANY_REQUESTS" | "INTERNAL_ERROR" | "BAD_GATEWAY" | "SERVICE_UNAVAILABLE";

const STATUS_BY_KIND: Record<ApiErrorKind, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Détails structurés optionnels (ex. créneaux en conflit), renvoyés tels quels dans `error.details`. */
  readonly details?: unknown;

  constructor(kind: ApiErrorKind, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code ?? kind;
    this.status = STATUS_BY_KIND[kind];
    this.details = details;
  }
}

export function unauthorized(message = "Authentification requise.", code?: string): ApiError {
  return new ApiError("UNAUTHORIZED", message, code);
}

export function forbidden(message = "Accès refusé.", code?: string): ApiError {
  return new ApiError("FORBIDDEN", message, code);
}

export function notFound(message = "Ressource introuvable."): ApiError {
  return new ApiError("NOT_FOUND", message);
}

export function badRequest(message: string, code?: string, details?: unknown): ApiError {
  return new ApiError("BAD_REQUEST", message, code, details);
}

export function conflict(message: string, code?: string, details?: unknown): ApiError {
  return new ApiError("CONFLICT", message, code, details);
}

/** Requête bien formée mais refusée par une règle métier (ex. message obligatoire). */
export function unprocessable(message: string, code?: string): ApiError {
  return new ApiError("UNPROCESSABLE", message, code);
}

export function tooManyRequests(message: string, code?: string): ApiError {
  return new ApiError("TOO_MANY_REQUESTS", message, code);
}

/** Un service tiers (ex: Resend) a refusé ou échoué — jamais la faute de l'appelant. */
export function badGateway(message: string, code?: string): ApiError {
  return new ApiError("BAD_GATEWAY", message, code);
}

/** Fonctionnalité non configurée sur ce déploiement (ex: clé Resend absente). */
export function serviceUnavailable(message: string, code?: string): ApiError {
  return new ApiError("SERVICE_UNAVAILABLE", message, code);
}
