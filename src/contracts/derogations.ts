import { z } from "./zod.js";

/**
 * Dernier état CONNU (via FBI, `rechercherDerogation.fbi`) de la
 * dérogation d'un match — consultation seule (voir docs/FBI.md : "faut
 * qu'on gere les derog depuis l'outil", phase 1). Toutes les valeurs
 * restent au format BRUT FBI (texte), jamais parsées — le format exact n'a
 * été observé que sur une capture d'écran, pas confirmé pour tous les
 * états.
 *
 * Depuis 2026-09-27 ("je veux le faire via loutil... voici les boutons a
 * utiliser pour accetper ou refuser"), une dérogation "En Cours" PEUT être
 * répondue réellement (accepter/refuser) via
 * `POST .../derogations/:derogationId/respond` — voir `actionRequired` et
 * `respond-derogation.ts`. Écrit réellement sur FBI/FFBB, jamais annulable
 * depuis cet outil ; tout le reste de cette lecture reste consultation
 * seule.
 *
 * `demandeur`/`motif`/`dateRencontreDemandee`/`heureDemandee`/`adversaire`/
 * `dateReponse`/`acceptation`/`motifRefus` viennent de la page de DÉTAIL
 * (`afficherDerogation.fbi`), pas du tableau de résultats — demande du
 * club, 2026-09-25 : "il me faut du détail sur le motif... les dates
 * initiales et demandées... comme sur fbi". `dateRencontre`/`heure`
 * restent les valeurs INITIALES (tableau de résultats), `null` quand la
 * page de détail n'a jamais pu être ouverte (best effort, voir
 * BrowserFbiClient).
 */
export const DerogationStatusDtoSchema = z
  .object({
    /**
     * Identifiant de la ligne `fbi_derogation_checks` correspondante —
     * `null` quand aucune dérogation n'est connue pour ce match (voir
     * `GET .../matches/:matchId/derogation`). Nécessaire pour
     * `POST .../derogations/:derogationId/respond`.
     */
    id: z.string().uuid().nullable(),
    numero: z.string().nullable(),
    etat: z.string().nullable(),
    dateDepot: z.string().nullable(),
    dateDerogation: z.string().nullable(),
    dateRencontre: z.string().nullable(),
    heure: z.string().nullable(),
    domicile: z.string().nullable(),
    visiteur: z.string().nullable(),
    demandeur: z.string().nullable(),
    motif: z.string().nullable(),
    dateRencontreDemandee: z.string().nullable(),
    heureDemandee: z.string().nullable(),
    adversaire: z.string().nullable(),
    dateReponse: z.string().nullable(),
    acceptation: z.string().nullable(),
    motifRefus: z.string().nullable(),
    /**
     * Ce que la dérogation demande de changer, lu sur la page FBI de la
     * dérogation (cases du formulaire, retour du club 2026-10-08 :
     * "intégrer le changement de salle et inversion de rencontre").
     * `null` : pas encore lu, ou case absente de la page — jamais supposé.
     */
    modifierDate: z.boolean().nullable(),
    modifierHoraire: z.boolean().nullable(),
    modifierSalle: z.boolean().nullable(),
    salleDemandee: z.string().nullable(),
    inverserRencontre: z.boolean().nullable(),
    inverserEquipe: z.boolean().nullable(),
    checkedAt: z.string(),
    /**
     * `true` si cette dérogation "En Cours" attend une décision DU CLUB
     * (accepter/refuser), jamais l'inverse (voir
     * `modules/derogations/action-required.ts`) — demande du club,
     * 2026-09-27 : "sur la derog si action besoin de ma part, faut un
     * badge action requise". Toujours `false` si `etat` n'est pas "En
     * Cours", ou si le côté du club sur ce match n'a pas pu être déterminé
     * (jamais deviné vu l'enjeu réel d'une action irréversible).
     */
    actionRequired: z.boolean(),
  })
  .openapi("DerogationStatusDto");

export type DerogationStatusDto = z.infer<typeof DerogationStatusDtoSchema>;

/**
 * L'AUTRE match du club (jamais celui de la dérogation elle-même) dont le
 * créneau (2h, demande du club, 2026-09-26 : "un créneau de match est de
 * 2h") chevauche la date/heure DEMANDÉE par cette dérogation — ex. un
 * match déjà prévu à 15h "prend" le créneau 15h-17h, donc une demande de
 * dérogation pour un AUTRE match à 16h y entre en conflit. `null` si aucun
 * chevauchement détecté (voir `modules/derogations/schedule-conflict.ts`).
 */
export const ScheduleConflictDtoSchema = z
  .object({
    matchId: z.string().uuid(),
    numero: z.string().nullable(),
    opponentName: z.string().nullable(),
    matchDatetime: z.string(),
    /**
     * Nom de L'ÉQUIPE DU CLUB engagée sur le match EN CONFLIT (`teams.name`)
     * — demande du club, 2026-09-27 : "sur le bandeau rouge faut dire aussi
     * c le match de quelle equipe en conflit" (le club a plusieurs équipes,
     * un numéro de rencontre seul ne dit pas laquelle).
     */
    teamName: z.string().nullable(),
  })
  .openapi("ScheduleConflictDto");

export type ScheduleConflictDto = z.infer<typeof ScheduleConflictDtoSchema>;

/**
 * Une ligne de `GET /v1/clubs/:clubId/derogations` — TOUTES les
 * dérogations connues du club en une fois (demande du club : "je veux un
 * bouton global qui check toutes les demandes, pas match par match"),
 * `DerogationStatusDto` enrichi du match FFBB correspondant pour pouvoir
 * lier vers sa fiche.
 */
export const DerogationListItemDtoSchema = DerogationStatusDtoSchema.extend({
  /**
   * Identifiant de CETTE ligne `fbi_derogation_checks` — jamais `matchId`
   * comme clé (§ "82 vs 51", docs/FBI.md, 2026-09-27) : une rencontre peut
   * légitimement avoir PLUSIEURS dérogations distinctes, `matchId` seul ne
   * les distingue pas. Non-nullable ici (contrairement au `id` hérité de
   * `DerogationStatusDtoSchema`) : une ligne de cette liste vient TOUJOURS
   * d'une vraie ligne `fbi_derogation_checks`.
   */
  id: z.string().uuid(),
  matchId: z.string().uuid(),
  opponentName: z.string().nullable(),
  matchDatetime: z.string().nullable(),
  /**
   * Catégorie FFBB lisible du match concerné (`competitions.category_label`,
   * ex. "U13", "Seniors") — demande du club, 2026-09-26 : "jaimerais quon
   * rajoute la catégorie concernée sur les derog". Distincte du code de
   * division FBI brut (`competitions.code`, ex. "BU13FN23") utilisé en
   * interne pour désambiguïser les numéros de rencontre.
   */
  categoryLabel: z.string().nullable(),
  /**
   * Nom de L'ÉQUIPE DU CLUB engagée sur ce match (`teams.name`, ex.
   * "Seniors 1 M", "Seniors 2", "U13 1") — demande du club, 2026-09-26 :
   * "faut préciser quelle équipe, seniors ya 4 equipes SM1 SM2 SM3 SF,
   * pareil sur dautres catégories" : `categoryLabel` seul ("Seniors") ne
   * distingue pas les 4 équipes seniors du club entre elles, `teamName` si.
   */
  teamName: z.string().nullable(),
  scheduleConflict: ScheduleConflictDtoSchema.nullable(),
}).openapi("DerogationListItemDto");

export type DerogationListItemDto = z.infer<typeof DerogationListItemDtoSchema>;

/**
 * Corps de `POST .../derogations/:derogationId/respond` — ÉCRIT réellement
 * sur FBI/FFBB (demande du club, 2026-09-27 : "je veux le faire via
 * loutil"). `motifRefus` obligatoire et non vide quand `decision ===
 * "refused"` ("Si jamais on refuse, laisser un champ pour remplir le
 * motif") ; ignoré/absent sinon.
 */
export const RespondToDerogationDtoSchema = z
  .object({
    decision: z.enum(["accepted", "refused"]),
    motifRefus: z.string().trim().min(1).nullable().optional(),
  })
  .refine((body) => body.decision !== "refused" || Boolean(body.motifRefus && body.motifRefus.length > 0), {
    message: "Un motif de refus est obligatoire pour refuser une dérogation.",
    path: ["motifRefus"],
  })
  .openapi("RespondToDerogationDto");

export type RespondToDerogationDto = z.infer<typeof RespondToDerogationDtoSchema>;

/**
 * Résultat RÉEL d'une soumission à FBI — `outcome: "unknown"` n'est jamais
 * traité comme un succès côté appelant (voir `BrowserFbiClient.respondToDerogation`) :
 * l'admin doit alors vérifier manuellement sur FBI avant de réessayer,
 * jamais recliquer à l'aveugle.
 */
export const RespondToDerogationResultDtoSchema = z
  .object({
    outcome: z.enum(["success", "error", "unknown"]),
    message: z.string().nullable(),
  })
  .openapi("RespondToDerogationResultDto");

export type RespondToDerogationResultDto = z.infer<typeof RespondToDerogationResultDtoSchema>;

/**
 * Corps de `POST .../matches/:matchId/derogation/create` — ÉCRIT réellement
 * sur FBI/FFBB (demande du club, 2026-09-28 : "on a vu comment accepter ou
 * refuser une dérog, mtn faut en créer une... on remplit et choisi le
 * motif, et on envoie de la meme facon que pour accpter ou refuser").
 *
 * Reflète UNIQUEMENT les champs RÉELS confirmés par le HTML source du
 * formulaire de création fourni par le club le 2026-09-28 (rencontre 16,
 * Plateau BU18MN1) que ce backend sait remplir — voir
 * `DerogationCreationRequest` (integrations/fbi/types.ts). La modification
 * de SALLE (case "modifierSalle", recherche via une modale FBI dont la
 * mécanique réelle n'a jamais été observée) n'est volontairement PAS
 * exposée ici — jamais un sélecteur deviné sans preuve directe.
 *
 * `dateDerogation`/`horaire` obligatoires et au format FBI réel quand la
 * case correspondante est cochée (`modifierDate`/`modifierHoraire`), jamais
 * quand elle ne l'est pas. `inverserRencontre`/`inverserEquipe` mutuellement
 * exclusives (même règle que le JS réel de la page FBI, revalidée ici
 * côté serveur). Au moins une case doit être cochée — une dérogation sans
 * aucune modification demandée n'a pas de sens.
 */
export const CreateDerogationDtoSchema = z
  .object({
    motif: z.string().trim().min(1, "Le motif de la demande est obligatoire."),
    modifierDate: z.boolean(),
    dateDerogation: z
      .string()
      .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Date invalide (JJ/MM/AAAA attendu).")
      .nullable()
      .optional(),
    modifierHoraire: z.boolean(),
    horaire: z
      .string()
      .regex(/^\d{2}:\d{2}$/, "Horaire invalide (HH:MM attendu).")
      .nullable()
      .optional(),
    inverserRencontre: z.boolean(),
    inverserEquipe: z.boolean(),
    /** Changer de salle (2026-10-20) : un des gymnases du club, retrouvé sur FBI par son nom. */
    modifierSalle: z.boolean().optional().default(false),
    clubVenueId: z.string().uuid().nullable().optional(),
  })
  .refine((body) => !body.modifierSalle || Boolean(body.clubVenueId), {
    message: "Choisis la salle quand « Modifier la salle » est coché.",
    path: ["clubVenueId"],
  })
  .refine((body) => !body.modifierDate || Boolean(body.dateDerogation), {
    message: "La date de dérogation est obligatoire quand « Modifier la date » est coché.",
    path: ["dateDerogation"],
  })
  .refine((body) => !body.modifierHoraire || Boolean(body.horaire), {
    message: "L'horaire est obligatoire quand « Modifier l'horaire » est coché.",
    path: ["horaire"],
  })
  .refine((body) => !(body.inverserRencontre && body.inverserEquipe), {
    message: "« Inverser la rencontre » et « Inverser seulement les équipes » sont mutuellement exclusives.",
    path: ["inverserEquipe"],
  })
  .refine((body) => body.modifierDate || body.modifierHoraire || body.modifierSalle || body.inverserRencontre || body.inverserEquipe, {
    message: "Coche au moins une modification (date, horaire, salle ou inversion) pour créer une dérogation.",
    path: ["modifierDate"],
  })
  .openapi("CreateDerogationDto");

export type CreateDerogationDto = z.infer<typeof CreateDerogationDtoSchema>;

/**
 * Résultat RÉEL d'une création — même contrat que
 * `RespondToDerogationResultDtoSchema` (`outcome: "unknown"` jamais traité
 * comme un succès côté appelant).
 */
export const CreateDerogationResultDtoSchema = z
  .object({
    outcome: z.enum(["success", "error", "unknown"]),
    message: z.string().nullable(),
  })
  .openapi("CreateDerogationResultDto");

export type CreateDerogationResultDto = z.infer<typeof CreateDerogationResultDtoSchema>;
