import { Hono } from "hono";
import { z } from "../../contracts/zod.js";
import { badRequest } from "../../api-error.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { sendPasswordReset } from "../../auth/account-invites.js";
import { logError } from "../../logger.js";
import { checkRateLimit, clientIp } from "../../security/rate-limit.js";
import { claimResetSlot } from "./reset-cooldown.js";

/**
 * Compte sans session (retour du club, 2026-10-08 : « une expérience claire
 * de A à Z ») : mot de passe oublié. La réponse est TOUJOURS la même, que
 * l'adresse ait un compte ou non — jamais un moyen de savoir qui est inscrit.
 */
export const accountRouter = new Hono();

export const PasswordResetDtoSchema = z.object({ email: z.string().trim().email("Adresse email invalide.") }).strict().openapi("PasswordResetDto");

/** Cinq demandes par IP et par fenêtre de 15 minutes, quelles que soient les adresses visées (S-7). */
const RESET_IP_LIMIT = 5;
const RESET_IP_WINDOW_MS = 15 * 60_000;

/** POST /v1/account/password-reset — envoie (si le compte existe) un email « Choisir un nouveau mot de passe ». */
accountRouter.post("/password-reset", async (c) => {
  const body = PasswordResetDtoSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) throw badRequest(body.error.issues.map((i) => i.message).join(" "));
  const email = body.data.email.toLowerCase();

  const ipLimit = checkRateLimit(`password-reset:${clientIp(c.req.header("x-forwarded-for"))}`, RESET_IP_LIMIT, RESET_IP_WINDOW_MS);
  if (!ipLimit.allowed) {
    c.header("Retry-After", String(ipLimit.retryAfterSeconds));
    return c.json({ error: { code: "RATE_LIMITED", message: "Trop de demandes d'affilée. Réessaie plus tard." } }, 429);
  }

  if (claimResetSlot(email)) {
    try {
      await sendPasswordReset(createServiceSupabaseClient(), email);
    } catch (error) {
      // Jamais l'adresse dans les journaux (dépôt public, voir docs/SECURITY.md).
      logError("Envoi du lien de réinitialisation échoué", error, {});
    }
  }
  return c.json({ sent: true as const });
});
