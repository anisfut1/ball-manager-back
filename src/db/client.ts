import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "../config/env.js";
import type { Database } from "./types.js";

export type DbClient = SupabaseClient<Database>;

/**
 * Aucune requête vers Supabase (PostgREST ou Auth) n'a jamais eu de délai
 * d'expiration — le `fetch` par défaut de `@supabase/supabase-js` attend
 * indéfiniment. Un simple ralentissement réseau transitoire entre Vercel
 * et Supabase se transformait donc en blocage TOTAL et silencieux de la
 * requête (jusqu'à ce que Vercel tue la Function avec un
 * `504 FUNCTION_INVOCATION_TIMEOUT` générique, sans aucune ligne
 * exploitable dans les logs). Ce fetch injecté échoue vite et clairement
 * à la place, avec un message qui remonte jusqu'au client (voir
 * `ApiUnreachableError` côté ball-manager-web, `src/lib/api/errors.ts`).
 */
const SUPABASE_FETCH_TIMEOUT_MS = 15_000;

function timeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Requête Supabase interrompue après ${timeoutMs}ms sans réponse.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * Client "service role" — bypass TOTAL de la RLS. Réservé aux tâches
 * système : cron internes, jobs, et aux quelques écritures qui doivent
 * volontairement contourner la RLS après une vérification manuelle
 * d'appartenance (ex: fbi_credentials, qui n'a AUCUNE policy pour
 * `authenticated`, voir docs/MULTI_TENANCY.md). Ne JAMAIS l'utiliser pour
 * servir une requête utilisateur sans avoir d'abord vérifié membership/rôle
 * dans le code appelant (voir src/auth/middleware.ts).
 */
export function createServiceSupabaseClient(): DbClient {
  const env = getEnv();
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: timeoutFetch(SUPABASE_FETCH_TIMEOUT_MS) },
  });
}

/**
 * Client "au nom de l'utilisateur" — utilise la clé anonyme mais transmet
 * le JWT Supabase Auth de la requête entrante dans l'en-tête Authorization
 * de CHAQUE requête PostgREST. `auth.uid()` résout donc correctement côté
 * PostgreSQL et la RLS s'applique exactement comme pour le frontend
 * (§11/§12 de la demande : l'API ne doit jamais court-circuiter les
 * protections RLS déjà construites — elle est une façade, pas un
 * contournement).
 */
export function createUserSupabaseClient(accessToken: string): DbClient {
  const env = getEnv();
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` }, fetch: timeoutFetch(SUPABASE_FETCH_TIMEOUT_MS) },
  });
}

/** Client anonyme, sans JWT — utilisé uniquement pour valider un JWT (auth.getUser(token)), jamais pour lire des données métier. */
export function createAnonSupabaseClient(): DbClient {
  const env = getEnv();
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: timeoutFetch(SUPABASE_FETCH_TIMEOUT_MS) },
  });
}
