import type { DbClient } from "../../db/client.js";
import { logError } from "../../logger.js";
import { apnsConfig, createApnsSender, type PushEnvironment, type PushSender } from "./apns.js";

/**
 * Notifications push : jetons d'appareil, file d'envoi (`notification_outbox`)
 * et envoi. Voir ball-manager-web/docs/IOS_PUSH.md.
 *
 * Destinataires = des LICENCIÉS. Les appareils sont résolus au moment de
 * l'envoi : session d'appareil active, droit encore adossé à un lien
 * personnel valide, jeton push non révoqué. Déconnexion, lien réinitialisé
 * ou session expirée => plus de notification, sans autre nettoyage.
 */

export type NotificationKind =
  | "CONVOCATION_NEW"
  | "CONVOCATION_UPDATED"
  | "RESPONSE_REMINDER"
  | "AVAILABILITY_REQUEST"
  | "MATCH_CHANGED"
  | "MATCH_CANCELLED"
  | "TRAINING_CHANGED"
  | "TRAINING_CANCELLED"
  | "DEROGATION_UPDATED";

export const OUTBOX_MAX_ATTEMPTS = 5;
/** Une notification qui n'a pas pu partir en 24 h n'a plus d'intérêt (convocation déjà vue sur le site…). */
export const OUTBOX_EXPIRY_MS = 24 * 3_600_000;
const SENDING_LEASE_MS = 10 * 60_000;

// ─── Expéditeur (remplaçable en test) ───────────────────────────────────────

let senderFactory: () => PushSender | null = () => {
  const config = apnsConfig();
  return config ? createApnsSender(config) : null;
};

/** Réservé aux tests : expéditeur simulé (ou `null` = push désactivé). */
export function setPushSenderFactoryForTests(factory: () => PushSender | null): void {
  senderFactory = factory;
}

// ─── Jetons d'appareil ──────────────────────────────────────────────────────

export const APNS_TOKEN = /^[0-9a-f]{64,200}$/i;

export async function registerPushToken(
  db: DbClient,
  session: { id: string; clubId: string },
  input: { token: string; environment: PushEnvironment; appVersion?: string | null },
  now: Date = new Date(),
): Promise<void> {
  const at = now.toISOString();
  await db.from("device_push_tokens").upsert(
    {
      session_id: session.id,
      club_id: session.clubId,
      token: input.token.toLowerCase(),
      platform: "ios",
      environment: input.environment,
      app_version: input.appVersion?.slice(0, 32) ?? null,
      last_seen_at: at,
      revoked_at: null,
      revoked_reason: null,
    },
    { onConflict: "session_id" },
  );
}

export async function removePushToken(db: DbClient, sessionId: string, reason = "user", now: Date = new Date()): Promise<void> {
  await db.from("device_push_tokens").update({ revoked_at: now.toISOString(), revoked_reason: reason }).eq("session_id", sessionId).is("revoked_at", null);
}

export interface PushTarget {
  token: string;
  environment: PushEnvironment;
}

/** Appareils joignables pour ces licenciés de CE club (un appareil = une fois, même avec deux enfants). */
export async function pushTargets(db: DbClient, clubId: string, licencieIds: readonly string[], now: Date = new Date()): Promise<PushTarget[]> {
  if (licencieIds.length === 0) return [];
  const { data: grantRows } = await db.from("device_session_grants").select("session_id, token_id").eq("club_id", clubId).in("licencie_id", [...licencieIds]);
  const grants = (grantRows ?? []) as { session_id: string; token_id: string }[];
  if (grants.length === 0) return [];

  const { data: liveTokens } = await db.from("licencie_public_tokens").select("id").eq("club_id", clubId).in("id", [...new Set(grants.map((g) => g.token_id))]).is("revoked_at", null);
  const live = new Set(((liveTokens ?? []) as { id: string }[]).map((t) => t.id));
  const sessionIds = [...new Set(grants.filter((g) => live.has(g.token_id)).map((g) => g.session_id))];
  if (sessionIds.length === 0) return [];

  const { data: sessionRows } = await db.from("device_sessions").select("id, expires_at, revoked_at").eq("club_id", clubId).in("id", sessionIds).is("revoked_at", null);
  const active = ((sessionRows ?? []) as { id: string; expires_at: string }[]).filter((s) => new Date(s.expires_at).getTime() > now.getTime()).map((s) => s.id);
  if (active.length === 0) return [];

  const { data: tokenRows } = await db.from("device_push_tokens").select("token, environment").eq("club_id", clubId).in("session_id", active).is("revoked_at", null);
  const byToken = new Map<string, PushTarget>();
  for (const t of (tokenRows ?? []) as { token: string; environment: PushEnvironment }[]) byToken.set(t.token, { token: t.token, environment: t.environment });
  return [...byToken.values()];
}

// ─── File d'envoi ───────────────────────────────────────────────────────────

export interface NotificationInput {
  clubId: string;
  kind: NotificationKind;
  /** Idempotence : la même clé n'est mise en file qu'une fois (ex. `convocation:<id>:r3`). */
  dedupeKey: string;
  licencieIds: readonly string[];
  title: string;
  body: string;
  /** Chemin relatif, construit avec `paths.*` (src/links/links.ts) à partir du slug du club. */
  path: (clubSlug: string) => string;
}

interface OutboxRow {
  id: string;
  club_id: string;
  kind: NotificationKind;
  dedupe_key: string;
  licencie_ids: string[];
  title: string;
  body: string;
  path: string;
  status: string;
  attempts: number;
  created_at: string;
}

const OUTBOX_COLUMNS = "id, club_id, kind, dedupe_key, licencie_ids, title, body, path, status, attempts, created_at";

/**
 * Met une notification en file puis tente l'envoi tout de suite (le cron
 * `/internal/cron/push` reprend ce qui a échoué). Ne fait JAMAIS échouer
 * l'action qui l'appelle (convocation, annulation…) : erreurs journalisées.
 * Push non configuré (pas de clé APNs) : rien n'est écrit.
 */
export async function notify(db: DbClient, input: NotificationInput): Promise<void> {
  try {
    const ids = [...new Set(input.licencieIds)];
    if (ids.length === 0) return;
    const sender = senderFactory();
    if (!sender) return;
    try {
      const { data: club } = await db.from("clubs").select("id, slug").eq("id", input.clubId).maybeSingle();
      if (!club) return;
      const { data } = await db
        .from("notification_outbox")
        .upsert(
          { club_id: input.clubId, kind: input.kind, dedupe_key: input.dedupeKey.slice(0, 200), licencie_ids: ids, title: input.title, body: input.body, path: input.path(club.slug as string), status: "pending", attempts: 0 },
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        )
        .select(OUTBOX_COLUMNS);
      for (const row of (data ?? []) as OutboxRow[]) {
        if (row.status === "pending" && row.attempts === 0) await deliver(db, sender, row);
      }
    } finally {
      sender.close();
    }
  } catch (error) {
    logError("Notification push non mise en file", error);
  }
}

async function claim(db: DbClient, row: OutboxRow, now: Date): Promise<boolean> {
  const { data } = await db
    .from("notification_outbox")
    .update({ status: "sending", next_attempt_at: new Date(now.getTime() + SENDING_LEASE_MS).toISOString() })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  return Boolean(data);
}

/**
 * Envoie UNE notification (après l'avoir réservée : jamais deux envois
 * concurrents). Au moins un appareil atteint => envoyée (pas de renvoi, qui
 * doublerait chez les autres). Aucun atteint pour une raison passagère =>
 * nouvel essai plus tard (1, 2, 4, 8 min), jusqu'à 5 essais.
 */
async function deliver(db: DbClient, sender: PushSender, row: OutboxRow, now: Date = new Date()): Promise<"sent" | "retry" | "failed" | "skipped"> {
  if (!(await claim(db, row, now))) return "skipped";
  const targets = await pushTargets(db, row.club_id, row.licencie_ids, now);
  let delivered = 0;
  let transient: string | null = null;
  for (const target of targets) {
    const result = await sender.send(target.token, target.environment, { title: row.title, body: row.body, path: row.path, threadId: row.kind, collapseId: row.dedupe_key });
    if (result.ok) delivered += 1;
    else if (result.permanent) await db.from("device_push_tokens").update({ revoked_at: now.toISOString(), revoked_reason: result.reason.slice(0, 64) }).eq("token", target.token).is("revoked_at", null);
    else transient = result.reason.slice(0, 200);
  }
  const attempts = row.attempts + 1;
  if (delivered > 0 || !transient) {
    await db.from("notification_outbox").update({ status: "sent", attempts, devices_sent: delivered, sent_at: now.toISOString(), last_error: transient }).eq("id", row.id);
    return "sent";
  }
  if (attempts >= OUTBOX_MAX_ATTEMPTS) {
    await db.from("notification_outbox").update({ status: "failed", attempts, last_error: transient }).eq("id", row.id);
    return "failed";
  }
  await db
    .from("notification_outbox")
    .update({ status: "pending", attempts, last_error: transient, next_attempt_at: new Date(now.getTime() + 2 ** (attempts - 1) * 60_000).toISOString() })
    .eq("id", row.id);
  return "retry";
}

/** `/internal/cron/push` : reprend les envois dus, libère les réservations abandonnées, expire les trop anciens. */
export async function processOutbox(db: DbClient, options: { now?: Date; limit?: number } = {}) {
  const now = options.now ?? new Date();
  const sender = senderFactory();
  if (!sender) return { enabled: false, sent: 0, retried: 0, failed: 0, expired: 0 };
  const counts = { enabled: true, sent: 0, retried: 0, failed: 0, expired: 0 };
  try {
    // Réservation abandonnée (fonction interrompue) : remise en file.
    await db.from("notification_outbox").update({ status: "pending" }).eq("status", "sending").lt("next_attempt_at", now.toISOString());

    const { data } = await db.from("notification_outbox").select(OUTBOX_COLUMNS).eq("status", "pending").lte("next_attempt_at", now.toISOString()).order("next_attempt_at", { ascending: true }).limit(options.limit ?? 50);
    for (const row of (data ?? []) as OutboxRow[]) {
      if (now.getTime() - new Date(row.created_at).getTime() > OUTBOX_EXPIRY_MS) {
        await db.from("notification_outbox").update({ status: "expired" }).eq("id", row.id).eq("status", "pending");
        counts.expired += 1;
        continue;
      }
      const outcome = await deliver(db, sender, row, now);
      if (outcome === "sent") counts.sent += 1;
      else if (outcome === "retry") counts.retried += 1;
      else if (outcome === "failed") counts.failed += 1;
    }
  } finally {
    sender.close();
  }
  return counts;
}
