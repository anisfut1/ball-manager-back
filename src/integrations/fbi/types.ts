/**
 * Types partagés entre les identifiants FBI stockés (credentials-store.ts)
 * et les clients d'automatisation (http-client.ts). Un seul endroit pour
 * cette forme évite deux définitions structurellement identiques qui
 * divergeraient sans qu'aucune erreur de type ne le signale.
 */
export interface FbiCredentialsInput {
  username: string;
  password: string;
}

/** Référence à un document e-Marque découvert chez FBI, pas encore téléchargé. */
export interface EmarqueDocumentRef {
  url: string;
  fileName: string;
}

/**
 * Une ligne du tableau de résultats de `rechercherRencontreSaisieResultat.fbi`
 * (rapprochement calendrier FFBB/FBI, voir docs/FBI.md) — colonnes confirmées
 * en production le 2026-09-24 : Division | N° | Equipe 1 | Equipe 2 | Date de
 * rencontre | Heure | Salle | EM | Score 1 | Forfait 1 (voir
 * `selectors.ts#resultsTableColumns`, déjà utilisé par la découverte de
 * documents e-Marque). Les champs connus sont extraits par LIBELLÉ d'en-tête
 * (jamais une position fixe) ; `raw` conserve TOUTES les colonnes trouvées
 * sur la page, y compris celles non modélisées ici — jamais perdu si FBI
 * ajoute/renomme une colonne.
 */
export interface FbiScheduleRow {
  division: string | null;
  numero: string | null;
  equipe1: string | null;
  equipe2: string | null;
  dateRencontre: string | null;
  heure: string | null;
  salle: string | null;
  em: string | null;
  score1: string | null;
  forfait1: string | null;
  raw: Record<string, string>;
}

/**
 * Champs de la page de DÉTAIL `afficherDerogation.fbi` (sections "Demande
 * de dérogation"/"Réponse de l'adversaire") — demande du club, 2026-09-25 :
 * "il me faut du détail sur le motif... les dates initiales et
 * demandées... comme sur fbi". Les dates/heure INITIALES sont déjà celles
 * de `FbiDerogationRow.dateRencontre`/`.heure` (tableau de résultats) — ces
 * champs-ci ne portent que ce qui n'existe QUE sur la page de détail : la
 * date/heure DEMANDÉE et le motif, plus la réponse de l'adversaire.
 * Confirmés par capture d'écran du VRAI FBI le 2026-09-25 (libellés
 * "Demandeur", "Motif de la demande", "Date rencontre"/"Horaire" dans la
 * section "Demande de dérogation", "Adversaire"/"Date de réponse"/
 * "Acceptation"/"Motif de refus" dans "Réponse de l'adversaire"). `null`
 * quand la page de détail n'a pas pu être ouverte (best effort, voir
 * BrowserFbiClient) — jamais une erreur bloquante.
 */
export interface FbiDerogationDetailFields {
  demandeur: string | null;
  motif: string | null;
  dateRencontreDemandee: string | null;
  heureDemandee: string | null;
  adversaire: string | null;
  dateReponse: string | null;
  acceptation: string | null;
  motifRefus: string | null;
  /**
   * Ce que la dérogation demande de changer (cases du formulaire FBI,
   * ids réels `modifierDate`/`modifierHoraire`/`modifierSalle`/
   * `inverserRencontre`/`inverserEquipe`, salle `nomSalle`) — retour du
   * club, 2026-10-08. `null`/absent : case introuvable sur la page, jamais
   * supposée décochée.
   */
  /** "Date de dépot" lue sur la page de la dérogation (`input#dateDepot`), repli si le tableau ne la donne pas. */
  dateDepotDetail?: string | null;
  modifierDate?: boolean | null;
  modifierHoraire?: boolean | null;
  modifierSalle?: boolean | null;
  salleDemandee?: string | null;
  inverserRencontre?: boolean | null;
  inverserEquipe?: boolean | null;
}

/**
 * Une ligne du tableau de résultats de `rechercherDerogation.fbi` (gestion
 * des dérogations, voir docs/FBI.md — demande du club, 2026-09-25 : "faut
 * qu'on gere les derog depuis l'outil") — colonnes confirmées par capture
 * d'écran du VRAI FBI le 2026-09-25 : Date de dépôt | N° Renc | Division |
 * Domicile | Visiteur | Date rencontre | Heure | Date déro | Etat de la
 * dérogation. `raw` conserve toutes les colonnes trouvées, y compris non
 * modélisées. Étendue de `FbiDerogationDetailFields` (tous `null` tant que
 * la page de détail n'a pas été consultée — voir `normalizeDerogationRow`).
 */
export interface FbiDerogationRow extends FbiDerogationDetailFields {
  numero: string | null;
  division: string | null;
  domicile: string | null;
  visiteur: string | null;
  dateRencontre: string | null;
  heure: string | null;
  dateDepot: string | null;
  dateDerogation: string | null;
  etat: string | null;
  /**
   * Jeton `idDerogation` porté par le lien de détail de CETTE ligne
   * (`afficherDerogation.fbi?idDerogation=<jeton>&idRencontre=0`) — LA clé
   * stable d'une VRAIE dérogation FBI, jamais `numero` (§ "82 vs 51",
   * docs/FBI.md, 2026-09-27) : le numéro de rencontre n'identifie ni une
   * dérogation UNIQUE (une même rencontre peut en avoir plusieurs, dates de
   * dépôt différentes) ni même une rencontre unique au club (le même
   * numéro existe dans plusieurs divisions distinctes, capture d'écran du
   * club). `null` uniquement si le lien de la ligne n'a pas pu être lu
   * (best effort, voir `collectAllDerogationPages`) — ne doit jamais
   * arriver sur le vrai FBI (CHAQUE cellule de donnée porte ce lien).
   */
  idDerogation: string | null;
  raw: Record<string, string>;
}

/**
 * Contrat commun à `HttpFbiClient` (ce dossier, HTTP direct — cookie jar,
 * pas de navigateur) et `BrowserFbiClient` (./browser-client.ts, Playwright).
 * Le reste de l'application (jobs, actions serveur) programme contre cette
 * interface : il ne sait jamais laquelle des deux implémentations est
 * réellement active (§ "Architecture" du brief FBI).
 *
 * `TSession` est opaque pour l'appelant — chaque implémentation choisit sa
 * propre forme (cookie jar pour HTTP, contexte navigateur pour Playwright).
 */
export interface FbiAutomationClient<TSession> {
  login(credentials: FbiCredentialsInput): Promise<TSession>;
  isSessionValid(session: TSession): Promise<boolean>;
  findEmarqueDocuments(session: TSession, matchNumber: string, division?: string | null): Promise<EmarqueDocumentRef[]>;
  downloadDocument(session: TSession, url: string): Promise<Buffer>;
  /**
   * Récupère TOUTES les rencontres du club listées par FBI (calendrier
   * complet, toutes divisions confondues — voir `rechercherRencontreSaisieResultat.fbi`,
   * rapprochement calendrier FFBB/FBI, docs/FBI.md), pas une seule rencontre
   * ciblée comme `findEmarqueDocuments`. Gère elle-même la pagination
   * ("Précédent 1 2 3 … Suivant", confirmé en production le 2026-09-25).
   */
  fetchScheduleRows(session: TSession): Promise<FbiScheduleRow[]>;
  /**
   * Consulte l'état de la dérogation d'UN match précis, par numéro de
   * rencontre (voir `rechercherDerogation.fbi`) — "faudra utiliser la
   * recherche par numéro de rencontre, car on l'a déjà et c'est bcp +
   * simple" (demande du club). `null` quand aucune dérogation n'existe
   * pour ce match — jamais une erreur (cas normal, la majorité des
   * matchs n'ont aucune dérogation en cours).
   *
   * `division` (§ "82 vs 51", docs/FBI.md, 2026-09-27) désambiguïse un
   * numéro de rencontre qui n'est PAS unique au club (le même numéro peut
   * exister dans plusieurs divisions distinctes) — `null`/omis reste un
   * repli best-effort (numéro seul), jamais une erreur.
   */
  fetchDerogationForMatch(session: TSession, matchNumber: string, division?: string | null): Promise<FbiDerogationRow | null>;
  /**
   * Récupère TOUTES les dérogations du club en UNE recherche non filtrée
   * (numéro vide) — "je veux un bouton global qui check toutes les
   * demandes, pas match par match" (demande du club, 2026-09-25). Une
   * seule connexion FBI pour tout le club, comme `fetchScheduleRows` —
   * jamais une boucle de connexions par match (déjà à l'origine d'un
   * blocage anti-bot par le passé, voir ProcessFbiJobsButton.tsx côté
   * ball-manager-web). Gère elle-même la pagination.
   */
  fetchAllDerogations(session: TSession): Promise<FbiDerogationRow[]>;
  /**
   * ÉCRIT réellement sur FBI (contrairement à tout le reste de cette
   * interface) — soumet la réponse du club à une dérogation "En Cours"
   * pour laquelle c'est à LUI de décider (voir
   * `modules/derogations/action-required.ts`) : accepte ou refuse la
   * date/heure/salle proposée par l'adversaire. "je veux le faire via
   * loutil" (demande du club, 2026-09-27) — action réelle, engageante
   * auprès de la FFBB, jamais annulable depuis cet outil une fois
   * confirmée par FBI. `motifRefus` ignoré si `decision === "accepted"`.
   */
  respondToDerogation(session: TSession, idDerogation: string, decision: DerogationResponseDecision, motifRefus: string | null): Promise<DerogationResponseOutcome>;
  /**
   * ÉCRIT réellement sur FBI — crée une NOUVELLE demande de dérogation pour
   * une rencontre qui n'en a encore aucune ("A Créer" côté FBI), demande du
   * club, 2026-09-28 : "on a vu comment accepter ou refuser une dérog, mtn
   * faut en créer une". Recherche d'abord la rencontre par numéro (+
   * division si connue) parmi les rencontres à l'état "A Créer" — même
   * principe que `fetchDerogationForMatch`, jamais une URL de création
   * construite à la main (l'`idRencontre` réel n'est JAMAIS le numéro de
   * rencontre, voir `createDerogation` côté BrowserFbiClient). `null` si
   * aucune rencontre "A Créer" ne correspond (une dérogation existe peut-
   * être déjà pour ce match, ou le numéro/la division ne correspond à
   * rien) — jamais une erreur, l'appelant décide comment le signaler.
   */
  createDerogation(session: TSession, matchNumber: string, division: string | null, request: DerogationCreationRequest): Promise<DerogationResponseOutcome | null>;
}

export type DerogationResponseDecision = "accepted" | "refused";

/**
 * Corps du formulaire RÉEL de création d'une dérogation
 * (`afficherDerogation.fbi?idDerogation=0&idRencontre=<jeton>`, HTML source
 * réel fourni par le club le 2026-09-28 pour la rencontre 16/BU18MN1) —
 * demande du club : "on a vu comment accepter ou refuser une dérog, mtn
 * faut en créer une... on remplit et choisi le motif, et on envoie de la
 * meme facon que pour accpter ou refuser".
 *
 * Champs confirmés par ce HTML réel : cases `modifierDate`/`modifierHoraire`
 * (chacune affiche son champ associé via `afficherComposant()`, JS réel de
 * la page) et `inverserRencontre`/`inverserEquipe` (mutuellement exclusives
 * CÔTÉ FBI, son propre JS décoche l'une quand l'autre est cochée). La
 * modification de SALLE (case `modifierSalle`, recherche via une MODALE
 * `rechercherModaleSalle()`) N'EST PAS supportée ici — sa mécanique réelle
 * (contenu de la modale, chargé en AJAX) n'a jamais été observée, jamais
 * deviné un sélecteur sans preuve directe (voir AGENTS.md/docs/FBI.md).
 *
 * `dateDerogation` au format FBI réel `"DD/MM/YYYY"` (voir
 * `rencontreDateRencontre` sur la même page), `horaire` au format
 * `"HH:mm"` (voir `rencontreHeure`) — jamais reformatés ici, la validation
 * de forme vit dans `contracts/derogations.ts` (zod), cette interface ne
 * fait que porter des chaînes déjà valides.
 */
export interface DerogationCreationRequest {
  motif: string;
  modifierDate: boolean;
  dateDerogation: string | null;
  modifierHoraire: boolean;
  horaire: string | null;
  inverserRencontre: boolean;
  inverserEquipe: boolean;
}

/**
 * Résultat d'une soumission réelle à FBI (`respondToDerogation`) :
 * - `success` : FBI a confirmé l'enregistrement (navigation loin de la page
 *   de détail après le clic "Enregistrer", même comportement que
 *   `retourArriere()` observé dans le VRAI HTML fourni par le club).
 * - `error` : FBI a explicitement refusé (message d'erreur RÉEL affiché
 *   par la page, jamais un message générique deviné).
 * - `unknown` : ni confirmation ni erreur détectée dans le délai imparti
 *   (page/formulaire absent, champ introuvable, timeout) — traité comme un
 *   ÉCHEC côté appelant (jamais supposé réussi sans preuve), avec un
 *   message expliquant ce qui a été constaté, pour vérification manuelle
 *   sur FBI.
 */
export type DerogationResponseOutcome = { outcome: "success" } | { outcome: "error"; message: string } | { outcome: "unknown"; message: string };
