import { createAnonSupabaseClient } from "../db/client.js";
import { unauthorized } from "../api-error.js";

export interface AuthUser {
  id: string;
  email: string | null;
  /** Adresse vérifiée (code reçu par email) : seule une adresse vérifiée peut prouver un lien avec une fiche. */
  emailConfirmed?: boolean;
}

const BEARER_PREFIX = "Bearer ";

/** Extrait le JWT de l'en-tête `Authorization: Bearer <jwt>` — jamais un autre format. */
export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader?.startsWith(BEARER_PREFIX)) {
    throw unauthorized("En-tête Authorization manquant ou invalide (attendu: Bearer <jwt>).");
  }
  return authorizationHeader.slice(BEARER_PREFIX.length).trim();
}

/**
 * Valide le JWT Supabase Auth du frontend en appelant l'API Auth de
 * Supabase (`auth.getUser(token)`) — pas une vérification de signature
 * locale : ça garantit qu'un jeton révoqué/expiré est bien rejeté sans que
 * ce backend ait besoin de connaître ou faire tourner la logique de
 * rotation de clés de Supabase Auth (voir docs/AUTH.md).
 */
export async function verifyAccessToken(token: string): Promise<AuthUser> {
  const supabase = createAnonSupabaseClient();
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    throw unauthorized("Jeton invalide ou expiré.");
  }

  return { id: data.user.id, email: data.user.email ?? null, emailConfirmed: Boolean(data.user.email_confirmed_at) };
}
