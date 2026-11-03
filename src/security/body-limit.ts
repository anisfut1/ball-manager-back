import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * Limite de taille des corps de requête (S-12b), avant toute lecture du corps.
 * Plus gros corps JSON légitime : ~0,7 Mo (photo de 512 Ko en base64) ou un
 * import de 2000 lignes de licenciés ; 1 Mio couvre les deux.
 */
export const GLOBAL_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * POST /v1/clubs/:clubId/licencies/import/file : export Excel FBI en multipart,
 * borné à 5 Mio par le handler (MAX_EXPORT_BYTES) + 64 Kio d'enveloppe multipart.
 * Vercel refuse de toute façon les corps de plus de 4,5 Mo avant la fonction.
 */
export const FBI_EXPORT_BODY_LIMIT_BYTES = 5 * 1024 * 1024 + 64 * 1024;

const tooLarge = (c: Parameters<MiddlewareHandler>[0]) =>
  c.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Le corps de la requête est trop volumineux." } }, 413);

const globalLimit = bodyLimit({ maxSize: GLOBAL_BODY_LIMIT_BYTES, onError: tooLarge });
const fbiExportLimit = bodyLimit({ maxSize: FBI_EXPORT_BODY_LIMIT_BYTES, onError: tooLarge });

const FBI_EXPORT_PATH = /^\/v1\/clubs\/[^/]+\/licencies\/import\/file$/;

/** Une seule limite par requête : la plus haute est réservée à la route d'import du fichier FBI. */
export function requestBodyLimit(): MiddlewareHandler {
  return (c, next) => (c.req.method === "POST" && FBI_EXPORT_PATH.test(c.req.path) ? fbiExportLimit(c, next) : globalLimit(c, next));
}
