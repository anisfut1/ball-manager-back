import { z } from "zod";

/**
 * Variables d'environnement — un seul schéma (pas de séparation
 * public/serveur : ce backend n'a pas de bundle navigateur, tout tourne
 * côté Vercel Function). Voir .env.example.
 */
const envSchema = z.object({
  SUPABASE_URL: z.string().url({ message: "SUPABASE_URL doit être une URL valide (ex: https://xxxx.supabase.co)" }),
  SUPABASE_ANON_KEY: z.string().min(1, { message: "SUPABASE_ANON_KEY est requis" }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, { message: "SUPABASE_SERVICE_ROLE_KEY est requis" }),
  FBI_CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .min(1, { message: "FBI_CREDENTIALS_ENCRYPTION_KEY est requis pour chiffrer les identifiants FBI" })
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "FBI_CREDENTIALS_ENCRYPTION_KEY doit être 32 octets encodés en base64 (clé AES-256)",
    }),
  CRON_SECRET: z.string().min(16, { message: "CRON_SECRET est requis (au moins 16 caractères) pour protéger /internal/*" }),
  FRONTEND_ORIGINS: z.string().min(1, { message: "FRONTEND_ORIGINS est requis (liste d'origines séparées par des virgules)" }),
  BROWSER_FBI_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  FBI_BASE_URL: z.string().url().optional().default("https://extranet.ffbb.com/fbi"),
  // Proxy à adresse IP FIXE pour tout le trafic navigateur vers FBI
  // (http://utilisateur:motdepasse@hote:port). Optionnel : sans lui, sortie
  // directe depuis les IP Vercel. Voir docs/FBI.md « Proxy à IP fixe ».
  FBI_PROXY_URL: z.string().url().optional(),
  // Envoi des liens personnels par email (voir src/email/resend.ts). Optionnels :
  // sans clé, la demande de lien répond 503 explicitement, le reste de l'API
  // fonctionne normalement.
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().min(1).optional(),
  // Adresse de réponse (boîte réellement lue) — un email sans réponse possible est moins bien classé.
  RESEND_REPLY_TO: z.string().email().optional(),
  // URL publique du frontend ball-manager-web utilisée dans les liens envoyés par email
  // quand l'origine de la requête n'est pas exploitable (voir public-tables).
  PUBLIC_APP_URL: z.string().url().optional(),
  // App iOS / sécurité des liens (docs/MOBILE_AUTH.md) : « 1 » = les emails de
  // lien personnel portent un code de connexion à usage unique (48 h) au lieu
  // du jeton permanent. Absent = comportement actuel inchangé.
  AUTH_LINK_CODES: z.enum(["0", "1"]).optional(),
  // Notifications push iOS (APNs direct, clé .p8 « Apple Push Notifications
  // service »). Toutes absentes = push désactivé : rien n'est mis en file.
  APNS_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
  APNS_KEY_ID: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional().default("fr.ballmanager.app"),
  // Contenu PEM de la clé .p8 (les retours à la ligne peuvent être écrits « \n »).
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Partial<Record<string, string | undefined>> = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(
      `Variables d'environnement invalides ou manquantes.\n${details}\n` +
        "Vérifie ton fichier .env (voir .env.example). Ne jamais commiter ces clés.",
    );
  }

  return result.data;
}

let cached: Env | null = null;

/** Chargé paresseusement : évite de faire planter un import (ex: en test) avant que l'environnement soit prêt. */
export function getEnv(): Env {
  if (!cached) cached = parseEnv();
  return cached;
}

/** Réservé aux tests : force un rechargement avec un nouvel environnement simulé. */
export function resetEnvCacheForTests(): void {
  cached = null;
}
