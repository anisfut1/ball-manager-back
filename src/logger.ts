/**
 * Logger structuré minimal (voir ball-manager-web src/lib/logger.ts, dont ce module est
 * la copie directe — pas de dépendance Next.js à retirer ici, c'était déjà
 * un module pur). Sortie JSON sur la console, suffisante pour les logs
 * Vercel. Jamais de mot de passe, cookie, jeton, contenu de document ou nom
 * complet de joueur (voir docs/FBI.md §Observabilité).
 */
type LogContext = Record<string, unknown>;

function format(level: "info" | "error", message: string, context?: LogContext) {
  return JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  });
}

export function logInfo(message: string, context?: LogContext): void {
  console.log(format("info", message, context));
}

export function logError(message: string, error?: unknown, context?: LogContext): void {
  const errorDetails =
    error instanceof Error ? { errorMessage: error.message, stack: error.stack } : error ? { error } : {};

  console.error(format("error", message, { ...context, ...errorDetails }));
}
