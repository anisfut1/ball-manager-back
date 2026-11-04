/**
 * Valeurs d'environnement factices pour que src/config/env.ts (validé au
 * premier `getEnv()`) puisse être chargé en test sans dépendre d'un vrai
 * projet Supabase. Aucune valeur réelle ici.
 */
process.env.SUPABASE_URL ??= "https://test-project.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.CRON_SECRET ??= "test-cron-secret-not-real-0000";
// 32 octets factices encodés en base64 (clé AES-256 de test uniquement).
process.env.FBI_CREDENTIALS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.FRONTEND_ORIGINS ??= "http://localhost:3000";

// DIAGNOSTIC TEMPORAIRE (branche diag/browser-hang, ne pas fusionner) : trace des appels Playwright en CI
// pour localiser les blocages intermittents de fetchAllDerogations.
if (process.env.CI) process.env.DEBUG ??= "pw:api";
