/**
 * Logger structuré minimal (voir ball-manager-web src/lib/logger.ts, dont ce module est
 * la copie directe — pas de dépendance Next.js à retirer ici, c'était déjà
 * un module pur). Sortie JSON sur la console, suffisante pour les logs
 * Vercel. Jamais de mot de passe, cookie, jeton, contenu de document ou nom
 * complet de joueur (voir docs/FBI.md §Observabilité).
 *
 * Les messages d'erreur d'origine (Supabase, fournisseurs, bibliothèques)
 * peuvent contenir une adresse e-mail ou un jeton : tout ce qui est écrit
 * passe par `redactSensitive` avant d'atteindre la console.
 */
type LogContext = Record<string, unknown>;

const REDACTIONS: readonly [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\b(token|secret|password|passwd|apikey|api_key)(=|:\s*)[^\s&"',;]+/gi, "$1$2[redacted]"],
];

const MAX_DEPTH = 6;

/** Masque adresses e-mail, JWT, jetons Bearer et valeurs `token=` / `secret=` / `password=` d'un texte. */
export function redactSensitive(text: string): string {
  return REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function sanitize(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactSensitive(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (value instanceof Error) return { name: value.name, message: redactSensitive(value.message), stack: value.stack ? redactSensitive(value.stack) : undefined };
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, depth + 1, seen)]));
}

function format(level: "info" | "error", message: string, context?: LogContext) {
  return JSON.stringify({
    level,
    message: redactSensitive(message),
    timestamp: new Date().toISOString(),
    ...(sanitize(context ?? {}) as LogContext),
  });
}

export function logInfo(message: string, context?: LogContext): void {
  console.log(format("info", message, context));
}

export function logError(message: string, error?: unknown, context?: LogContext): void {
  const errorDetails = error instanceof Error ? { errorMessage: error.message, stack: error.stack } : error ? { error } : {};

  console.error(format("error", message, { ...context, ...errorDetails }));
}
