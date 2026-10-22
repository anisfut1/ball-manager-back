import type { DbClient } from "../../db/client.js";
import { ApiError, badRequest, conflict, notFound } from "../../api-error.js";
import { getFbiCredentials } from "../../integrations/fbi/credentials-store.js";
import { FbiError } from "../../integrations/fbi/errors.js";
import { logError, logInfo } from "../../logger.js";
import type { SharedFbiSession } from "../../jobs/shared-session.js";
import { verifyCreationOnFbi } from "./fbi-verify.js";
import { assertNoActiveFbiJob } from "./fbi-session-lock.js";
import { localWorkerHoldsFbi, runOnLocalWorker, withVercelFbiSession } from "./fbi-write-routing.js";

export interface CreateDerogationParams {
  clubId: string;
  matchId: string;
  motif: string;
  modifierDate: boolean;
  dateDerogation: string | null;
  modifierHoraire: boolean;
  horaire: string | null;
  inverserRencontre: boolean;
  inverserEquipe: boolean;
  submittedBy: string | null;
  /** Changement de salle : gymnase du club choisi (`club_venues`), son nom est cherché sur FBI. */
  modifierSalle?: boolean;
  clubVenueId?: string | null;
  /** Nom du gymnase, résolu côté serveur (jamais fourni par le client). */
  salle?: string | null;
}

export interface CreateDerogationResult {
  outcome: "success" | "error" | "unknown";
  message: string | null;
  /** FBI injoignable AVANT l'enregistrement : rien n'a été envoyé, on peut réessayer sans risque de doublon. */
  notSent?: boolean;
  /** Envoi incertain et FBI illisible : à revérifier sur FBI (puis renvoyer si rien n'a été enregistré). */
  verifyLater?: boolean;
}

export const VERIFY_LATER_MESSAGE =
  "Envoi incertain et FBI momentanément illisible : Ball Manager vérifie lui-même sur FBI et renverra la demande automatiquement si rien n'a été enregistré — inutile de la renvoyer.";

export const QUEUED_FOR_LOCAL_WORKER_MESSAGE =
  "FBI ne répond pas au serveur (adresse bloquée par FBI). La demande est mise en attente : elle partira automatiquement dès que le poste du club se connectera à FBI — inutile de la renvoyer.";

/** Demande interne à l'origine de l'envoi : la conversation en garde la trace. */
export interface OfficialConversation {
  requestId: string;
  authorUserId: string | null;
  authorLicencieId: string | null;
  authorMembershipId: string | null;
  authorName: string;
  authorRoleLabel: string | null;
}

interface CreateTarget {
  numero: string;
  division: string | null;
}

async function loadCreateTarget(supabase: DbClient, clubId: string, matchId: string): Promise<CreateTarget> {
  const { data: match, error: matchError } = await supabase.from("matches").select("id, numero, competition_id").eq("id", matchId).eq("club_id", clubId).maybeSingle();
  if (matchError) throw new Error(`Lecture du match échouée : ${matchError.message}`);
  if (!match || !match.numero) throw notFound("Match introuvable ou sans numéro de rencontre connu.");
  let division: string | null = null;
  if (match.competition_id) {
    const { data: competition } = await supabase.from("competitions").select("code").eq("id", match.competition_id).maybeSingle();
    division = competition?.code ?? null;
  }
  return { numero: match.numero, division };
}

/**
 * ÉCRIT réellement sur FBI/FFBB — traite `POST .../matches/:matchId/derogation/create`
 * (demande du club, 2026-09-28 : "on a vu comment accepter ou refuser une
 * dérog, mtn faut en créer une... (sur chaque rencontre faut un bouton
 * "Créer une dérogation")... on remplit et choisi le motif, et on envoie de
 * la meme facon que pour accpter ou refuser"). SYNCHRONE (même raisonnement
 * que `respondToDerogationForClub` : une action volontaire, ponctuelle, où
 * l'admin attend une confirmation immédiate).
 *
 * "on cherche la rencontre concernée" est fait ICI, côté serveur, à partir
 * du `matchId` déjà connu (numéro + division FFBB) — jamais une recherche
 * manuelle côté UI : `BrowserFbiClient.createDerogation` recherche la ligne
 * "A Créer" correspondante sur FBI lui-même (voir sa doc).
 *
 * Journalise CHAQUE tentative dans `fbi_derogation_creations` (succès,
 * erreur, ou état indéterminé) avant de retourner — action réelle et
 * engageante envers un tiers (l'adversaire, l'organisme dirigeant), jamais
 * silencieuse même en cas d'échec, même principe que
 * `fbi_derogation_responses`.
 */
export async function createDerogationForClub(supabase: DbClient, input: CreateDerogationParams, options: { conversation?: OfficialConversation } = {}): Promise<CreateDerogationResult> {
  const { clubId, matchId } = input;
  const target = await loadCreateTarget(supabase, clubId, matchId);
  const params: CreateDerogationParams = { ...input, salle: input.modifierSalle ? await loadVenueName(supabase, clubId, input.clubVenueId ?? null) : null };

  const credentials = await getFbiCredentials(supabase, clubId);
  if (!credentials) throw conflict("Configure d'abord un identifiant/mot de passe FBI avant de créer une dérogation.", "FBI_NOT_CONFIGURED");

  // Poste du club connecté à FBI : c'est lui qui envoie, dans sa session (voir `localWorkerHoldsFbi`).
  if (await localWorkerHoldsFbi(supabase)) {
    return runOnLocalWorker(supabase, { clubId, matchId, type: "create_derogation", payload: { params, conversation: options.conversation ?? null } });
  }

  await assertNoActiveFbiJob(supabase, clubId);
  const sendStartedAt = new Date();
  let result: CreateDerogationResult;
  try {
    result = await withVercelFbiSession(supabase, clubId, "Création d'une dérogation", { matchId }, (shared) => createDerogationInSession(supabase, shared, params, target, { since: sendStartedAt }));
  } catch (error) {
    // Connexion FBI impossible depuis Vercel : rien n'a été envoyé non plus.
    if (!(error instanceof ApiError && error.message.startsWith("Connexion FBI impossible"))) throw error;
    result = { outcome: "unknown", message: error.message, notSent: true };
  }

  // FBI bloque l'adresse de Vercel (2026-10-21, ERR_CONNECTION_TIMED_OUT) :
  // la demande attend le poste du club au lieu d'échouer.
  // Envoi incertain et FBI illisible : revérifié sur FBI avant tout renvoi (jamais de doublon).
  if (result.notSent || result.verifyLater) {
    await queueForLocalWorker(supabase, { clubId, matchId, params, conversation: options.conversation ?? null, verifyFirst: result.verifyLater === true, since: sendStartedAt });
    if (options.conversation) await noteQueuedForLocalWorker(supabase, clubId, options.conversation);
    return { outcome: "unknown", message: result.verifyLater ? VERIFY_LATER_MESSAGE : QUEUED_FOR_LOCAL_WORKER_MESSAGE };
  }
  if (options.conversation) await noteOfficialResult(supabase, clubId, options.conversation, result, false);
  return result;
}

/** Envoi mis en file pour le poste du club (jamais en double pour un même match). */
async function queueForLocalWorker(
  supabase: DbClient,
  job: { clubId: string; matchId: string; params: CreateDerogationParams; conversation: OfficialConversation | null; verifyFirst?: boolean; since?: Date },
): Promise<void> {
  const { data: pending } = await supabase
    .from("fbi_jobs")
    .select("id")
    .eq("club_id", job.clubId)
    .eq("match_id", job.matchId)
    .eq("type", "create_derogation")
    .in("status", ["pending", "claimed", "running"])
    .limit(1)
    .maybeSingle();
  if (pending) return;
  const { error } = await supabase.from("fbi_jobs").insert({ club_id: job.clubId, match_id: job.matchId, type: "create_derogation", payload: { params: job.params, conversation: job.conversation, verifyFirst: job.verifyFirst ?? false, since: (job.since ?? new Date()).toISOString() }, max_attempts: 1 });
  if (error) throw new Error(`Mise en attente de l'envoi FBI échouée : ${error.message}`);
}

async function noteQueuedForLocalWorker(supabase: DbClient, clubId: string, conversation: OfficialConversation): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from("derogation_messages").insert({
    club_id: clubId,
    request_id: conversation.requestId,
    author_user_id: conversation.authorUserId,
    author_licencie_id: conversation.authorLicencieId,
    author_membership_id: conversation.authorMembershipId,
    author_display_name: conversation.authorName,
    author_role_label: conversation.authorRoleLabel,
    body: "Envoi officiel en attente : FBI ne répond pas au serveur, la demande partira automatiquement dès que le poste du club se connectera à FBI.",
    message_type: "SYSTEM",
    event: "OFFICIAL_QUEUED",
  });
  await supabase.from("derogation_requests").update({ updated_at: now, last_message_at: now }).eq("id", conversation.requestId);
}

/** Nom du gymnase choisi, limité aux gymnases de CE club. */
async function loadVenueName(supabase: DbClient, clubId: string, clubVenueId: string | null): Promise<string> {
  if (!clubVenueId) throw badRequest("Choisis la salle quand « Modifier la salle » est coché.");
  const { data, error } = await supabase.from("club_venues").select("name").eq("id", clubVenueId).eq("club_id", clubId).maybeSingle();
  if (error) throw new Error(`Lecture de la salle échouée : ${error.message}`);
  if (!data?.name) throw notFound("Salle introuvable pour ce club.");
  return data.name;
}

/**
 * L'écriture elle-même, dans une session FBI déjà ouverte : celle du worker
 * du poste du club, ou celle ouverte par Vercel le temps de l'envoi.
 */
export async function createDerogationInSession(
  supabase: DbClient,
  shared: SharedFbiSession,
  params: CreateDerogationParams,
  target?: CreateTarget,
  options: { since?: Date } = {},
): Promise<CreateDerogationResult> {
  const since = options.since ?? new Date();
  const result = await createDerogationInSessionUnverified(supabase, shared, params, target);
  // Envoi incertain (coupure PENDANT l'enregistrement) : relu sur FBI tout de suite, jamais laissé à la personne.
  return result.outcome === "unknown" && !result.notSent ? settleUncertainCreation(supabase, shared, params, target, since) : result;
}

/**
 * Envoi repris plus tard (job en file) : quand le premier essai était
 * incertain, FBI est relu AVANT de renvoyer — jamais de doublon.
 */
export async function createDerogationWithVerification(
  supabase: DbClient,
  shared: SharedFbiSession,
  params: CreateDerogationParams,
  options: { since: Date; verifyFirst: boolean },
): Promise<CreateDerogationResult> {
  if (options.verifyFirst) {
    const target = await loadCreateTarget(supabase, params.clubId, params.matchId);
    const verification = await verifyCreationOnFbi(shared, target.numero, target.division, options.since);
    if (verification === "sent") return recordVerifiedCreation(supabase, params);
    if (verification === "unknown") return { outcome: "unknown", message: VERIFY_LATER_MESSAGE, verifyLater: true };
    return createDerogationInSession(supabase, shared, params, target, { since: options.since });
  }
  return createDerogationInSession(supabase, shared, params, undefined, { since: options.since });
}

async function settleUncertainCreation(supabase: DbClient, shared: SharedFbiSession, params: CreateDerogationParams, target: CreateTarget | undefined, since: Date): Promise<CreateDerogationResult> {
  const resolved = target ?? (await loadCreateTarget(supabase, params.clubId, params.matchId).catch(() => null));
  const verification = resolved ? await verifyCreationOnFbi(shared, resolved.numero, resolved.division, since) : "unknown";
  logInfo("Création d'une dérogation FBI : envoi incertain, relu sur FBI", { clubId: params.clubId, matchId: params.matchId, verification });
  if (verification === "sent") return recordVerifiedCreation(supabase, params);
  if (verification === "absent") {
    return { outcome: "unknown", message: "Envoi interrompu ; vérifié sur FBI : rien n'a été enregistré. La demande est renvoyée automatiquement.", notSent: true };
  }
  return { outcome: "unknown", message: VERIFY_LATER_MESSAGE, verifyLater: true };
}

/** FBI relu : la dérogation est bien enregistrée — tracée comme un succès. */
async function recordVerifiedCreation(supabase: DbClient, params: CreateDerogationParams): Promise<CreateDerogationResult> {
  await supabase
    .from("fbi_derogation_creations")
    .insert({
      club_id: params.clubId,
      match_id: params.matchId,
      motif: params.motif,
      modifier_date: params.modifierDate,
      date_derogation: params.dateDerogation,
      modifier_horaire: params.modifierHoraire,
      horaire: params.horaire,
      inverser_rencontre: params.inverserRencontre,
      inverser_equipe: params.inverserEquipe,
      submitted_by: params.submittedBy,
      outcome: "success",
      fbi_message: "Envoi incertain, vérifié sur FBI : dérogation bien enregistrée.",
    })
    .then(
      () => undefined,
      () => undefined,
    );
  return { outcome: "success", message: null };
}

async function createDerogationInSessionUnverified(supabase: DbClient, shared: SharedFbiSession, params: CreateDerogationParams, target?: CreateTarget): Promise<CreateDerogationResult> {
  try {
    return await createDerogationInSessionOrThrow(supabase, shared, params, target);
  } catch (error) {
    // Erreur FBI inattendue (page injoignable, délai dépassé…) : jamais une
    // « erreur interne » muette (constaté le 2026-10-21, match 5018) — le
    // message réel est journalisé, tracé et renvoyé à la personne.
    if (error instanceof ApiError) throw error;
    const detail = error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : String(error);
    // Page de recherche ou formulaire injoignable : toujours AVANT le clic sur « Enregistrer ».
    const notSent = error instanceof FbiError && error.code === "NAVIGATION_FAILED";
    const message = notSent ? `Envoi FBI interrompu avant l'enregistrement (rien n'a été envoyé) : ${detail}` : `Envoi FBI interrompu : ${detail}.`;
    logError("Création d'une dérogation FBI : erreur inattendue", error, { clubId: params.clubId, matchId: params.matchId });
    await supabase
      .from("fbi_derogation_creations")
      .insert({
        club_id: params.clubId,
        match_id: params.matchId,
        motif: params.motif,
        modifier_date: params.modifierDate,
        date_derogation: params.dateDerogation,
        modifier_horaire: params.modifierHoraire,
        horaire: params.horaire,
        inverser_rencontre: params.inverserRencontre,
        inverser_equipe: params.inverserEquipe,
        submitted_by: params.submittedBy,
        outcome: "unknown",
        fbi_message: message,
      })
      .then(
        () => undefined,
        () => undefined,
      );
    return { outcome: "unknown", message, notSent };
  }
}

async function createDerogationInSessionOrThrow(supabase: DbClient, shared: SharedFbiSession, params: CreateDerogationParams, target?: CreateTarget): Promise<CreateDerogationResult> {
  const { clubId, matchId, motif, modifierDate, dateDerogation, modifierHoraire, horaire, inverserRencontre, inverserEquipe, submittedBy } = params;
  const { client, session } = shared;
  const { numero, division } = target ?? (await loadCreateTarget(supabase, clubId, matchId));

  const result = await client.createDerogation(session, numero, division, {
    motif,
    modifierDate,
    dateDerogation,
    modifierHoraire,
    horaire,
    inverserRencontre,
    inverserEquipe,
    modifierSalle: params.modifierSalle ?? false,
    salle: params.salle ?? null,
  });

  if (result === null) {
    const message = "Aucune rencontre « à créer » trouvée sur FBI pour ce match (une dérogation existe peut-être déjà, ou le numéro/la division ne correspond à rien).";
    await supabase.from("fbi_derogation_creations").insert({
      club_id: clubId,
      match_id: matchId,
      motif,
      modifier_date: modifierDate,
      date_derogation: dateDerogation,
      modifier_horaire: modifierHoraire,
      horaire,
      inverser_rencontre: inverserRencontre,
      inverser_equipe: inverserEquipe,
      submitted_by: submittedBy,
      outcome: "error",
      fbi_message: message,
    });
    logInfo("Création d'une dérogation FBI : aucune rencontre 'à créer' trouvée", { clubId, matchId });
    return { outcome: "error", message };
  }

  await supabase.from("fbi_derogation_creations").insert({
    club_id: clubId,
    match_id: matchId,
    motif,
    modifier_date: modifierDate,
    date_derogation: dateDerogation,
    modifier_horaire: modifierHoraire,
    horaire,
    inverser_rencontre: inverserRencontre,
    inverser_equipe: inverserEquipe,
    submitted_by: submittedBy,
    outcome: result.outcome,
    fbi_message: result.outcome === "success" ? null : result.message,
  });

  logInfo("Création d'une dérogation FBI", { clubId, matchId, outcome: result.outcome });

  if (result.outcome === "success") {
    // Rafraîchit IMMÉDIATEMENT l'état connu depuis FBI (jamais deviné) —
    // même session déjà authentifiée, même logique d'upsert que
    // `respondToDerogationForClub`/`processCheckDerogationJob`.
    try {
      const refreshed = await client.fetchDerogationForMatch(session, numero, division);
      if (refreshed) {
        const now = new Date().toISOString();
        const fbiRowKey = refreshed.idDerogation ?? `${clubId}:${matchId}:${now}`;
        await supabase.from("fbi_derogation_checks").upsert(
          {
            club_id: clubId,
            match_id: matchId,
            fbi_row_key: fbiRowKey,
            id_derogation: refreshed.idDerogation,
            numero: refreshed.numero,
            etat: refreshed.etat,
            date_depot: refreshed.dateDepot,
            date_derogation: refreshed.dateDerogation,
            date_rencontre: refreshed.dateRencontre,
            heure: refreshed.heure,
            domicile: refreshed.domicile,
            visiteur: refreshed.visiteur,
            demandeur: refreshed.demandeur,
            motif: refreshed.motif,
            date_rencontre_demandee: refreshed.dateRencontreDemandee,
            heure_demandee: refreshed.heureDemandee,
            adversaire: refreshed.adversaire,
            date_reponse: refreshed.dateReponse,
            acceptation: refreshed.acceptation,
            motif_refus: refreshed.motifRefus,
            checked_at: now,
            updated_at: now,
          },
          { onConflict: "club_id,fbi_row_key" },
        );
      }
    } catch (error) {
      // Best effort : la création a bien été enregistrée sur FBI (résultat
      // déjà journalisé ci-dessus) — un échec de ce simple rafraîchissement
      // ne doit jamais faire paraître la soumission elle-même en échec.
      logError("Création d'une dérogation FBI : rafraîchissement post-soumission échoué", error, { clubId, matchId });
    }
  }
  return { outcome: result.outcome, message: result.outcome === "success" ? null : result.message };
}

/**
 * Trace dans la conversation de la demande interne : envoi réussi (les deux
 * chemins) ; échec seulement quand le poste du club l'a traité (depuis
 * Vercel, l'erreur est affichée directement à la personne).
 */
export async function noteOfficialResult(supabase: DbClient, clubId: string, conversation: OfficialConversation, result: CreateDerogationResult, viaLocalWorker: boolean): Promise<void> {
  if (result.outcome !== "success" && !viaLocalWorker) return;
  const body =
    result.outcome === "success"
      ? `${conversation.authorName} a envoyé la demande de dérogation officielle à la FFBB (FBI).`
      : `L'envoi de la dérogation officielle à FBI n'a pas abouti${result.message ? ` : ${result.message}` : "."}`;
  const now = new Date().toISOString();
  const { error } = await supabase.from("derogation_messages").insert({
    club_id: clubId,
    request_id: conversation.requestId,
    author_user_id: conversation.authorUserId,
    author_licencie_id: conversation.authorLicencieId,
    author_membership_id: conversation.authorMembershipId,
    author_display_name: conversation.authorName,
    author_role_label: conversation.authorRoleLabel,
    body,
    message_type: "SYSTEM",
    event: result.outcome === "success" ? "OFFICIAL_SUBMITTED" : "OFFICIAL_FAILED",
  });
  if (error) throw new Error(`Écriture du message échouée : ${error.message}`);
  await supabase.from("derogation_requests").update({ updated_at: now, last_message_at: now }).eq("id", conversation.requestId);
}
