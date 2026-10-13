import type { DbClient } from "../../db/client.js";
import { links } from "../../links/links.js";
import { appBaseUrl } from "../../auth/account-invites.js";
import { buildDerogationRequestEmail, buildFbiDerogationDigestEmail, type ClubBranding } from "../../email/account-emails.js";
import { isEmailConfigured, sendEmail } from "../../email/resend.js";
import { logError } from "../../logger.js";

/**
 * Emails aux coordinateurs des dérogations (retour du club, 2026-10-08 :
 * « un système de mail au coordinateur, et un lien qui mène à la
 * dérogation. Pareil si c'est un coach qui fait une demande »).
 *
 * Destinataires : les licenciés coordinateurs désignés depuis /joueurs
 * (email de leur fiche) ; à défaut, les licenciés administrateurs. Le lien
 * mène TOUJOURS à l'espace public Dérogations (retour du club, 2026-10-09 :
 * « faut renvoyer vers le public, ils ont leur compte avec le mail
 * renseigné, juste token… dans le public dérog ils ont les accès pour tout
 * gérer »). Jamais de jeton personnel dans ces emails : l'appareil déjà
 * reconnu ouvre directement, sinon « retrouve ton nom » renvoie le lien.
 *
 * Un envoi raté est journalisé, jamais remonté : il ne doit jamais faire
 * échouer la demande du coach ni la vérification FBI.
 */

interface Recipient {
  email: string;
}

interface ClubInfo extends ClubBranding {
  id: string;
  slug: string;
}

async function loadClub(db: DbClient, clubId: string): Promise<ClubInfo | null> {
  const { data } = await db.from("clubs").select("id, slug, name, logo_url, accent_color").eq("id", clubId).maybeSingle();
  if (!data) return null;
  return { id: data.id, slug: data.slug, name: data.name, logoUrl: data.logo_url ?? null, accentColor: data.accent_color ?? null };
}

async function licencieEmails(db: DbClient, clubId: string, flag: "public_coordinator" | "public_admin"): Promise<string[]> {
  const { data } = await db.from("licencies").select("email").eq("club_id", clubId).eq("active", true).eq(flag, true);
  return (data ?? []).map((l) => l.email?.trim()).filter((e): e is string => Boolean(e));
}

/** Licenciés coordinateurs avec email ; à défaut, licenciés administrateurs. Une adresse = un seul email. */
export async function derogationRecipients(db: DbClient, clubId: string): Promise<Recipient[]> {
  const unique = (emails: string[]): Recipient[] => [...new Map(emails.map((email) => [email.toLowerCase(), { email }])).values()];
  const coordinators = unique(await licencieEmails(db, clubId, "public_coordinator"));
  return coordinators.length > 0 ? coordinators : unique(await licencieEmails(db, clubId, "public_admin"));
}

async function sendAll(recipients: Recipient[], build: (r: Recipient) => { subject: string; html: string; text: string }, context: Record<string, unknown>): Promise<number> {
  if (!isEmailConfigured() || recipients.length === 0) return 0;
  const results = await Promise.all(
    recipients.map((r) =>
      sendEmail({ to: r.email, fromName: "Ball Manager", ...build(r) })
        .then(() => 1)
        .catch((error: unknown) => {
          logError("Email de dérogation non envoyé", error, context);
          return 0;
        }),
    ),
  );
  return results.reduce<number>((sum, n) => sum + n, 0);
}

/** Nouvelle demande d'un coach (ou nouveau créneau reproposé) → coordinateurs, lien vers la demande. */
export async function notifyDerogationRequest(
  db: DbClient,
  input: { clubId: string; requestId: string; kind: "created" | "reproposed"; requesterName: string; matchLabel: string; slotLabel: string; comment: string | null; excludeEmails?: string[] },
): Promise<number> {
  try {
    const club = await loadClub(db, input.clubId);
    if (!club) return 0;
    const exclude = new Set((input.excludeEmails ?? []).map((e) => e.toLowerCase()));
    const recipients = (await derogationRecipients(db, input.clubId)).filter((r) => !exclude.has(r.email.toLowerCase()));
    const base = appBaseUrl();
    return await sendAll(
      recipients,
      (r) =>
        buildDerogationRequestEmail({
          club,
          kind: input.kind,
          requesterName: input.requesterName,
          matchLabel: input.matchLabel,
          slotLabel: input.slotLabel,
          comment: input.comment,
          link: links(base).derogation(club.slug, input.requestId),
        }),
      { clubId: input.clubId, requestId: input.requestId },
    );
  } catch (error) {
    logError("Notification de demande de dérogation en erreur", error, { clubId: input.clubId, requestId: input.requestId });
    return 0;
  }
}

export interface FbiDerogationEvent {
  /** `incoming` : le club adverse attend notre réponse ; `outcome` : réponse reçue sur une dérogation suivie. */
  kind: "incoming" | "outcome";
  /** Clé de dédoublonnage (une dérogation FBI, ou dérogation + nouvel état). */
  refKey: string;
  line: string;
}

/**
 * Événements FBI de la vérification du jour → UN email récapitulatif par
 * coordinateur. Chaque événement n'est notifié qu'une fois
 * (`derogation_notifications`, unique par club/type/clé), même si la
 * vérification repasse plusieurs fois.
 */
export async function notifyFbiDerogationEvents(db: DbClient, clubId: string, events: FbiDerogationEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  try {
    const fresh: FbiDerogationEvent[] = [];
    for (const event of events) {
      const { error } = await db.from("derogation_notifications").insert({ club_id: clubId, kind: `fbi_${event.kind}`, ref_key: event.refKey });
      if (!error) fresh.push(event);
      else if (error.code !== "23505") logError("Trace de notification de dérogation non enregistrée", error, { clubId });
    }
    if (fresh.length === 0) return 0;

    const club = await loadClub(db, clubId);
    if (!club) return 0;
    const recipients = await derogationRecipients(db, clubId);
    const base = appBaseUrl();
    const incoming = fresh.filter((e) => e.kind === "incoming").map((e) => e.line);
    const outcomes = fresh.filter((e) => e.kind === "outcome").map((e) => e.line);
    return await sendAll(
      recipients,
      () => buildFbiDerogationDigestEmail({ club, incoming, outcomes, link: links(base).derogations(club.slug) }),
      { clubId },
    );
  } catch (error) {
    logError("Notification des dérogations FBI en erreur", error, { clubId });
    return 0;
  }
}
