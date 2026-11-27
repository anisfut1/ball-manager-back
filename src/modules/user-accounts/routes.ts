import { Hono, type Context } from "hono";
import type { DbClient } from "../../db/client.js";
import type { AppEnv } from "../../auth/context.js";
import type { AuthUser } from "../../auth/jwt.js";
import { badRequest, tooManyRequests, unauthorized } from "../../api-error.js";
import { requireAnyClubRole, requireAuth, requireClubMembership } from "../../auth/middleware.js";
import { createServiceSupabaseClient } from "../../db/client.js";
import { resolvePublicClub, type PublicClub } from "../public/club-resolver.js";
import { accountFromRequest } from "../public/credential.js";
import { clientIp, hitRateLimit } from "../../security/rate-limit.js";
import { parse } from "../trainings/routes.js";
import { appLinks } from "../../links/links.js";
import { registerAccountPushToken, removeAccountPushToken, sendAccountTestPush } from "../push/service.js";
import {
  AcceptAccountInviteDtoSchema,
  AccountPushTokenDtoSchema,
  AccountPushTokenRefDtoSchema,
  CreateAccountInviteDtoSchema,
  CreateAccountLinkDtoSchema,
  ImportDeviceSessionDtoSchema,
  LinkStatusSchema,
  type AccountDto,
} from "../../contracts/accounts.js";
import { acceptInvite, accountPeople, createInvite, decideLink, deleteAccount, deleteClubLink, linkFromDeviceSession, listClubLinks, removeLink, requestLink } from "./service.js";

/**
 * `/v1/public/clubs/{clubSlug}/account/…` — le compte connecté
 * (`Authorization: Bearer <JWT>`) dans un club : licenciés suivis,
 * rattachements, invitations, notifications, suppression. Voir docs/ACCOUNTS.md.
 */
interface Env {
  Variables: { supabase: DbClient; publicClub: PublicClub };
}

export const publicAccountRouter = new Hono<Env>();
publicAccountRouter.use("*", resolvePublicClub<Env>());

const NO_STORE = { "Cache-Control": "no-store" };

function limit(c: Context<Env>, bucket: string, max: number, windowMs = 60_000): void {
  if (!hitRateLimit(`account:${bucket}:${clientIp(c.req.header("x-forwarded-for"))}`, max, windowMs)) throw tooManyRequests("Trop de tentatives. Réessaie dans un moment.", "RATE_LIMITED");
}

async function requireAccount(c: Context<Env>): Promise<AuthUser> {
  const account = await accountFromRequest(c.req);
  if (!account) throw unauthorized("Connexion requise.", "ACCOUNT_REQUIRED");
  return account;
}

async function accountDto(db: DbClient, clubId: string, user: AuthUser): Promise<AccountDto> {
  return { id: user.id, email: user.email, people: await accountPeople(db, clubId, user.id) };
}

/** GET …/account — le compte et les licenciés qu'il suit dans ce club. */
publicAccountRouter.get("/", async (c) => {
  const user = await requireAccount(c);
  return c.json(await accountDto(c.get("supabase"), c.get("publicClub").id, user), 200, NO_STORE);
});

/** POST …/account/links — « c'est moi / c'est mon enfant » après la recherche du nom. */
publicAccountRouter.post("/links", async (c) => {
  limit(c, "links", 10);
  const user = await requireAccount(c);
  const body = await parse(CreateAccountLinkDtoSchema, c);
  const db = c.get("supabase");
  const clubId = c.get("publicClub").id;
  const status = await requestLink(db, clubId, user, body);
  return c.json({ status, account: await accountDto(db, clubId, user) }, 201, NO_STORE);
});

/** POST …/account/links/device-session — reprise des personnes d'une session d'appareil de l'app (avant les comptes). */
publicAccountRouter.post("/links/device-session", async (c) => {
  limit(c, "links-session", 10);
  const user = await requireAccount(c);
  const body = await parse(ImportDeviceSessionDtoSchema, c);
  const db = c.get("supabase");
  const clubId = c.get("publicClub").id;
  await linkFromDeviceSession(db, clubId, user, body.sessionSecret);
  return c.json(await accountDto(db, clubId, user), 200, NO_STORE);
});

/** DELETE …/account/links/{licencieId} — ne plus suivre ce licencié. */
publicAccountRouter.delete("/links/:licencieId", async (c) => {
  const user = await requireAccount(c);
  await removeLink(c.get("supabase"), c.get("publicClub").id, user.id, c.req.param("licencieId"));
  return c.body(null, 204);
});

/** POST …/account/invites — lien d'invitation (7 jours, usage unique) pour un proche du licencié. */
publicAccountRouter.post("/invites", async (c) => {
  limit(c, "invites", 20, 3_600_000);
  const user = await requireAccount(c);
  const body = await parse(CreateAccountInviteDtoSchema, c);
  const club = c.get("publicClub");
  const invite = await createInvite(c.get("supabase"), club.id, user.id, body.licencieId);
  return c.json({ ...invite, url: appLinks().accountInvite(club.slug, invite.code) }, 201, NO_STORE);
});

/** POST …/account/invites/accept — accepter une invitation reçue d'un proche. */
publicAccountRouter.post("/invites/accept", async (c) => {
  limit(c, "invites-accept", 10);
  const user = await requireAccount(c);
  const body = await parse(AcceptAccountInviteDtoSchema, c);
  const db = c.get("supabase");
  const clubId = c.get("publicClub").id;
  await acceptInvite(db, clubId, user, body.code);
  return c.json(await accountDto(db, clubId, user), 200, NO_STORE);
});

/** PUT …/account/push-token — jeton APNs de cet iPhone pour ce compte (demandé après la connexion). */
publicAccountRouter.put("/push-token", async (c) => {
  limit(c, "push", 20);
  const user = await requireAccount(c);
  const body = await parse(AccountPushTokenDtoSchema, c);
  await registerAccountPushToken(c.get("supabase"), { userId: user.id, clubId: c.get("publicClub").id }, body);
  return c.body(null, 204);
});

/** POST …/account/push-token/remove — déconnexion de cet iPhone (ses notifications cessent). */
publicAccountRouter.post("/push-token/remove", async (c) => {
  const user = await requireAccount(c);
  const body = await parse(AccountPushTokenRefDtoSchema, c);
  await removeAccountPushToken(c.get("supabase"), { userId: user.id, clubId: c.get("publicClub").id }, body.token);
  return c.body(null, 204);
});

/** POST …/account/push-test — notification de test vers CET iPhone seulement. */
publicAccountRouter.post("/push-test", async (c) => {
  limit(c, "push-test", 10);
  const user = await requireAccount(c);
  const body = await parse(AccountPushTokenRefDtoSchema, c);
  return c.json(await sendAccountTestPush(c.get("supabase"), { userId: user.id, clubId: c.get("publicClub").id }, body.token), 200, NO_STORE);
});

/**
 * DELETE …/account — suppression du compte (guideline Apple 5.1.1(v)) : le
 * compte, ses rattachements et ses jetons push. Les fiches sportives restent
 * au club, et les autres comptes de la famille ne sont pas touchés.
 */
publicAccountRouter.delete("/", async (c) => {
  limit(c, "delete", 5);
  const user = await requireAccount(c);
  await deleteAccount(c.get("supabase"), c.get("publicClub").id, user.id);
  return c.body(null, 204);
});

/**
 * `/v1/clubs/{clubId}/account-links` — administration : la file « Demandes
 * de rattachement » et les comptes liés à une fiche.
 */
export const accountLinksAdminRouter = new Hono<AppEnv>();
accountLinksAdminRouter.use("*", requireAuth, requireClubMembership, requireAnyClubRole(["club_admin", "correspondant_club"]));

accountLinksAdminRouter.get("/", async (c) => {
  const rawStatus = c.req.query("status");
  const status = rawStatus ? LinkStatusSchema.safeParse(rawStatus) : null;
  if (status && !status.success) throw badRequest("Statut invalide.");
  const links = await listClubLinks(createServiceSupabaseClient(), c.get("club").club.id, { status: status?.data, licencieId: c.req.query("licencieId") || undefined });
  return c.json({ links }, 200, NO_STORE);
});

accountLinksAdminRouter.post("/:linkId/accept", async (c) => {
  await decideLink(createServiceSupabaseClient(), c.get("club").club.id, c.req.param("linkId"), "active", c.get("user").id);
  return c.body(null, 204);
});

accountLinksAdminRouter.post("/:linkId/refuse", async (c) => {
  await decideLink(createServiceSupabaseClient(), c.get("club").club.id, c.req.param("linkId"), "refused", c.get("user").id);
  return c.body(null, 204);
});

accountLinksAdminRouter.delete("/:linkId", async (c) => {
  await deleteClubLink(createServiceSupabaseClient(), c.get("club").club.id, c.req.param("linkId"));
  return c.body(null, 204);
});
