import { Hono, type Context } from "hono";
import { z } from "../../contracts/zod.js";
import { badRequest } from "../../api-error.js";
import { createAnonSupabaseClient, createServiceSupabaseClient } from "../../db/client.js";
import type { PasswordAuth } from "../device-auth/admin-session.js";
import { parse } from "../trainings/routes.js";
import { ClubSlugRef, RefreshAccountDtoSchema, ResendCodeDtoSchema, SignInDtoSchema, SignUpDtoSchema, VerifySignUpDtoSchema } from "../../contracts/accounts.js";
import { refresh, resendSignUpCode, signIn, startSignUp, verifySignUp } from "../user-accounts/auth.js";
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

export const PasswordResetDtoSchema = z.object({ email: z.string().trim().email("Adresse email invalide."), clubSlug: ClubSlugRef }).strict().openapi("PasswordResetDto");

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
      await sendPasswordReset(createServiceSupabaseClient(), email, body.data.clubSlug);
    } catch (error) {
      // Jamais l'adresse dans les journaux (dépôt public, voir docs/SECURITY.md).
      logError("Envoi du lien de réinitialisation échoué", error, {});
    }
  }
  return c.json({ sent: true as const });
});

// ─── Comptes de l'espace licencié (docs/ACCOUNTS.md) ────────────────────────

const passwordAuth = (): PasswordAuth => createAnonSupabaseClient().auth as unknown as PasswordAuth;
const NO_STORE = { "Cache-Control": "no-store" };

function ipLimited(c: Context, bucket: string, max: number, windowMs: number): Response | null {
  const ipLimit = checkRateLimit(`${bucket}:${clientIp(c.req.header("x-forwarded-for"))}`, max, windowMs);
  if (ipLimit.allowed) return null;
  c.header("Retry-After", String(ipLimit.retryAfterSeconds));
  return c.json({ error: { code: "RATE_LIMITED", message: "Trop de demandes d'affilée. Réessaie plus tard." } }, 429);
}

/** POST /v1/account/sign-up — crée le compte (ou reprend une création inachevée) et envoie un code. Même réponse si l'adresse a déjà un compte. */
accountRouter.post("/sign-up", async (c) => {
  const limited = ipLimited(c, "sign-up", 10, 15 * 60_000);
  if (limited) return limited;
  const body = await parse(SignUpDtoSchema, c);
  if (claimResetSlot(`sign-up:${body.email.toLowerCase()}`)) await startSignUp(createServiceSupabaseClient(), body.email, body.password, new Date(), body.clubSlug);
  return c.json({ sent: true as const }, 202, NO_STORE);
});

/** POST /v1/account/sign-up/resend — renvoie un code (même réponse dans tous les cas). */
accountRouter.post("/sign-up/resend", async (c) => {
  const limited = ipLimited(c, "sign-up-resend", 5, 15 * 60_000);
  if (limited) return limited;
  const body = await parse(ResendCodeDtoSchema, c);
  if (claimResetSlot(`sign-up:${body.email.toLowerCase()}`)) {
    try {
      await resendSignUpCode(createServiceSupabaseClient(), body.email, new Date(), body.clubSlug);
    } catch (error) {
      logError("Renvoi du code de création de compte échoué", error, {});
    }
  }
  return c.json({ sent: true as const }, 202, NO_STORE);
});

/** POST /v1/account/sign-up/verify — vérifie le code et ouvre la session. */
accountRouter.post("/sign-up/verify", async (c) => {
  const limited = ipLimited(c, "sign-up-verify", 20, 15 * 60_000);
  if (limited) return limited;
  const body = await parse(VerifySignUpDtoSchema, c);
  return c.json(await verifySignUp(createServiceSupabaseClient(), passwordAuth(), body), 200, NO_STORE);
});

/** POST /v1/account/sign-in — email + mot de passe. */
accountRouter.post("/sign-in", async (c) => {
  const limited = ipLimited(c, "sign-in", 20, 15 * 60_000);
  if (limited) return limited;
  const body = await parse(SignInDtoSchema, c);
  return c.json(await signIn(passwordAuth(), body.email, body.password), 200, NO_STORE);
});

/** POST /v1/account/refresh — nouveau jeton d'accès. */
accountRouter.post("/refresh", async (c) => {
  const limited = ipLimited(c, "refresh", 60, 60_000);
  if (limited) return limited;
  const body = await parse(RefreshAccountDtoSchema, c);
  return c.json(await refresh(passwordAuth(), body.refreshToken), 200, NO_STORE);
});
