import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page } from "playwright-core";
import { FbiError } from "./errors.js";
import * as selectors from "./selectors.js";
import { normalizeScheduleRow } from "./schedule-row.js";
import { normalizeDerogationRow, compareDerogationDateDepot } from "./derogation-row.js";
import type { DerogationCreationRequest, DerogationResponseDecision, DerogationResponseOutcome, FbiDerogationDetailFields, FbiDerogationRow, FbiScheduleRow } from "./types.js";
import { logInfo } from "../../logger.js";
import { emarqueDownloadUrl, executeSearchQuery, parseSearchResponse, pickRow, searchFormFields } from "./emarque-search.js";
import { fbiProxySettings, probeFbiProxy } from "./browser-launcher.js";

/**
 * Délais maximum des requêtes vers FBI (2026-10-06) : un `fetch` lancé
 * depuis la page n'a AUCUN délai par défaut — quand FBI ne répondait pas,
 * il attendait jusqu'à la coupure Vercel (300 s), laissant le job « en
 * cours » et le club bloqué. Chaque appel échoue désormais proprement.
 */
const FBI_IN_PAGE_REQUEST_TIMEOUT_MS = 30_000;
const FBI_IN_PAGE_DOWNLOAD_TIMEOUT_MS = 40_000;
const FBI_NAVIGATION_DOWNLOAD_TIMEOUT_MS = 30_000;
const FBI_NODE_REQUEST_TIMEOUT_MS = 20_000;
const SKIPPED_RESOURCE_TYPES = new Set(["image", "font", "media"]);
/**
 * Session « légère » (récupération e-Marque, 2026-10-07) : une fois la page
 * d'accueil atteinte, ses scripts, styles et XHR ne sont plus chargés. Trace
 * du 07/10 06:25 : 4 XHR de l'accueil (≈ 2 s chacune) occupaient les
 * connexions du navigateur et retardaient la recherche de 4 s — FBI coupe
 * l'adresse ≈ 8 s après la connexion. Nos propres requêtes (type `fetch`)
 * passent toujours.
 */
const SKIPPED_AFTER_LOGIN_TYPES = new Set(["script", "stylesheet", "xhr"]);

/**
 * Identité du navigateur auprès de FBI (2026-10-06). Par défaut, Chrome sans
 * écran s'annonce « HeadlessChrome » (User-Agent et Sec-CH-UA), en anglais,
 * sous Linux : constaté que FBI coupe alors l'accès de l'adresse utilisée
 * (Vercel, puis le VPS du proxy — qui répondait en 0,4 s juste avant). Même
 * identité qu'un Chrome de bureau ordinaire, cohérente avec la version réelle
 * du moteur ; même principe que `FBI_REQUEST_HEADERS` (http-client.ts).
 */
export function fbiBrowserIdentity(browserVersion: string) {
  const major = /^(\d+)/.exec(browserVersion)?.[1] ?? "141";
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      "sec-ch-ua": `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not?A_Brand";v="24"`,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  };
}

/**
 * BrowserFbiClient — automatisation Playwright de FBI, utilisée UNIQUEMENT
 * par les routes `/internal/*` (jamais par une route `/v1/*` servant une
 * requête utilisateur, voir docs/FBI.md). C'est la stratégie DE SECOURS
 * pour tout ce que `HttpFbiClient` (./http-client.ts) ne peut pas faire en
 * HTTP direct — aujourd'hui : la découverte et le téléchargement des
 * documents e-Marque, dont l'endpoint HTTP n'a jamais pu être confirmé
 * (§58 du brief FBI original : ne jamais inventer une route, utiliser le
 * navigateur comme chemin fonctionnel à la place).
 *
 * Adaptation Vercel (voir docs/FBI.md pour l'analyse complète) : le
 * `Browser` est fourni par l'appelant — voir
 * `browser-launcher.ts#launchServerlessBrowser` (playwright-core +
 * @sparticuz/chromium, gardé derrière `BROWSER_FBI_ENABLED`), lancé et
 * fermé PAR INVOCATION de Vercel Function (pas de processus long-running
 * comme l'ancien worker Railway — cette classe elle-même est inchangée,
 * seul le lanceur de Browser change).
 *
 * §13 du brief FBI original : CHAQUE session appartient à un seul club_id.
 * Ce client crée un nouveau `BrowserContext` isolé (équivalent d'une
 * fenêtre de navigation privée) à CHAQUE `login()`, jamais partagé entre
 * deux clubs même s'ils utilisaient le même Browser sous-jacent — cookies,
 * storage et cache ne traversent jamais un `BrowserContext`.
 *
 * Statut : le login (détection dynamique du formulaire, mêmes heuristiques
 * que HttpFbiClient) est PREPARED — jamais exécuté contre le vrai FBI
 * depuis cet environnement (réseau *.ffbb.com bloqué). Les tests
 * (browser-client.test.ts) valident ce client contre des pages HTML
 * locales synthétiques (Chromium réel), pas contre le vrai FBI. La
 * navigation post-login (recherche de rencontre, découverte de documents)
 * est conçue de façon générique/défensive (voir selectors.ts) faute
 * d'avoir pu observer le markup réel.
 */

export interface BrowserFbiSession {
  context: BrowserContext;
  page: Page;
  /** `true` quand une session FBI conservée a été réutilisée (aucune connexion identifiant/mot de passe). */
  reused?: boolean;
}

/** Une requête du navigateur vers FBI, sans paramètres d'URL, corps ni cookie. */
export interface FbiTraceEvent {
  /** Millisecondes depuis le début de la session. */
  t: number;
  m: string;
  /** Hôte (si autre que FBI) + chemin, sans `;jsessionid` ni paramètres. */
  u: string;
  r: string;
  /** Statut HTTP, ou erreur réseau, ou "ignoré" (image/police bloquée volontairement). */
  s: number | string;
  d: number | null;
}

export interface FbiSessionTrace {
  startedAt: string;
  events: FbiTraceEvent[];
  dropped: number;
  /**
   * Signature du serveur/pare-feu devant FBI (2026-10-06) : NOMS des cookies
   * posés (jamais leur valeur) et en-têtes d'infrastructure des pages FBI
   * (server, via, x-*). Chaque pare-feu anti-robots a la sienne.
   */
  fingerprint: { cookieNames: string[]; headers: Record<string, string> };
}

const FINGERPRINT_HEADER = /^(server|via|x-.*|cf-.*|akamai-.*|set-cookie)$/i;

const MAX_TRACE_EVENTS = 400;

/**
 * Passe(s) de recherche de dérogations — historique de la découverte
 * (docs/FBI.md pour le détail complet, § "Retour à une seule passe TT") :
 * un round précédent avait introduit une passe PAR ÉTAT (`EC`, `ACCEPT`,
 * `ORGCREACC`, `ORGCREREF`), en réaction à des dossiers "En Cours" puis
 * "Acceptée par les deux associations sportives" absents des résultats
 * sous "Tous les états (sauf à créer)" (`TT`). **Le club a corrigé cette
 * hypothèse** ("si si il prend tout en compte le tous les états, c juste
 * que ya 5 pages à prendre en compte", 2026-09-27) : `TT` couvre bien
 * TOUS les états réels — la cause était une PAGINATION incomplète
 * (`collectAllDerogationsWithDetail` ne traversait pas toutes les pages,
 * voir sa doc). Revenu à une seule passe `TT`, jamais une par état —
 * inutilement lent (jusqu'à 4x plus de connexions/recherches) et fondé
 * sur une fausse piste. Partagée par `fetchDerogationForMatch` (une seule
 * rencontre) et `fetchAllDerogations` (tout le club) ; la structure en
 * tableau (même à un seul élément) est conservée pour que le diagnostic
 * par passe (`DerogationPassDiagnostic`) reste réutilisable si un besoin
 * similaire se représentait, prouvé sur preuve la prochaine fois.
 */
const DEROGATION_ETAT_PASSES = ["tousLesEtats"] as const;
type DerogationEtatPass = (typeof DEROGATION_ETAT_PASSES)[number];

export interface BrowserFbiClientOptions {
  baseUrl: string;
  browser: Browser;
  /** Rythme humain (pauses, saisie caractère par caractère, souris) — voir `humanPause`. */
  humanPacing?: boolean;
  /** Après la connexion, plus aucun script/style/XHR de FBI — voir `SKIPPED_AFTER_LOGIN_TYPES`. */
  lightSession?: boolean;
  /** Délai après une action de navigation, avant de considérer la page stabilisée (ms). Les apps Java legacy type FBI n'utilisent pas toujours des transitions détectables par networkidle. */
  navigationSettleMs?: number;
  /**
   * Budget de temps (ms) alloué à `fetchAllDerogations` pour le détail
   * PAR LIGNE (demandeur/motif/dates demandées/réponse adversaire) —
   * cinquième revirement (voir docs/FBI.md, § "Le détail redevient
   * nécessaire") : "on récupère plus le demandeur le motif, l'heure la
   * date etc" (constat club, 2026-09-27) après le quatrième revirement qui
   * avait retiré tout détail par ligne du lot pour éviter le timeout
   * Vercel de 300s. Le détail reste indispensable à l'affichage
   * (`DerogationsList.tsx` côté ball-manager-web) — mais 80+ nouveaux onglets
   * séquentiels dépassaient largement 300s. Maintenant que
   * `tryMaximizeResultsPageLength` ramène tout sur UNE SEULE page (plus de
   * 5 clics "Suivant" à ~2-6s chacun), le budget restant pour le détail
   * est bien plus large — mais reste borné explicitement : dès que ce
   * budget est dépassé, les lignes restantes gardent leurs champs de
   * détail à `null` (comme avant ce round) plutôt que de risquer un
   * timeout dur. Défaut 220s sur les 300s Vercel — 80s de marge pour le
   * lancement du navigateur, le login, la recherche elle-même et l'écriture
   * en base (voir `processCheckAllDerogationsJob`), jamais mesurés depuis
   * cet environnement (réseau FBI bloqué), donc volontairement généreux.
   */
  derogationDetailBudgetMs?: number;
  /**
   * Pause entre deux pages de détail de dérogation (2026-10-07 : ~85 pages
   * de détail ouvertes d'affilée depuis le worker local, puis FBI n'a plus
   * répondu à cette adresse). 0 par défaut (tests) ; le worker local la fixe.
   */
  derogationDetailPauseMs?: number;
}

/**
 * Résultat de `tryMaximizeResultsPageLength` — jamais deviné au-delà de ce
 * que Playwright a RÉELLEMENT observé sur la page courante. Persisté dans
 * `DerogationPassDiagnostic` pour confirmer, depuis la base, si le
 * contrôle "Afficher X entrées" existe VRAIMENT sur le vrai FBI (jamais
 * confirmé par du HTML réel, contrairement à `nextPageControl` — voir
 * docs/FBI.md, "Toujours 51 après le round treize/quatorze") : si
 * `found: false` en production, la maximisation de page n'a jamais pu
 * s'appliquer, et `collectAllDerogationPages` retombe systématiquement
 * sur la pagination "Suivant" (connue instable, doublons/pertes de
 * lignes) — jamais un problème d'état/de timing dans ce cas.
 */
export interface LengthSelectDiagnostic {
  /** Un `<select>` dont le `name`/`id` finit par `_length` a été trouvé sur la page. */
  found: boolean;
  /** `id` RÉEL de ce `<select>`, tel que lu sur la page — jamais supposé. `null` si `found` est `false`. */
  selectId: string | null;
  /** Valeurs RÉELLES de ses `<option>`, dans l'ordre du DOM — permet de vérifier si "-1"/"Tous" existe vraiment, ou si la plus grande valeur numérique reste insuffisante. */
  optionValues: string[];
  /** Valeur EFFECTIVEMENT sélectionnée (celle choisie comme "la plus grande") — `null` si `found` est `false` ou si la sélection a échoué. */
  appliedValue: string | null;
}

export interface DerogationPassDiagnostic {
  pass: DerogationEtatPass;
  /** Valeur RÉELLEMENT active sur le `<select>` "Etat de la dérogation" juste avant le clic sur RECHERCHER — jamais supposée, toujours relue après la tentative de sélection. */
  selectedEtatValueAtSubmit: string | null;
  /** Nombre de lignes brutes lues dans le tableau (AVANT filtrage de la ligne fantôme DataTables), toutes pages confondues. */
  rawRowCount: number;
  /** Nombre de lignes conservées après filtrage de la ligne fantôme DataTables ET déduplication par numéro (voir `fetchAllDerogations`). */
  keptRowCount: number;
  /** Nombre de pages RÉELLEMENT parcourues (itérations de `collectAllResultPages` avant l'arrêt) — confirme si la pagination avance vraiment ou relit la même page. */
  pageCount: number;
  /** Voir `LengthSelectDiagnostic` — confirme si `tryMaximizeResultsPageLength` a pu s'appliquer, ou si `collectAllDerogationPages` est systématiquement retombé sur la pagination "Suivant" instable. */
  lengthSelect: LengthSelectDiagnostic;
  /** Titre de la page au moment de la toute première lecture du tableau — confirme qu'on est bien sur l'écran de résultats des dérogations, jamais deviné. */
  pageTitleAtFirstRead: string;
  /** Jusqu'aux 3 premières lignes BRUTES lues (dictionnaire en-tête→cellule complet, AVANT tout filtrage), toutes colonnes confondues — voir sa doc dans `collectAllDerogationPages` : permet de voir le VRAI contenu d'une exécution anormale (ex : rawRowCount très bas) sans deviner. */
  rawRowSample: Record<string, string>[];
  /** Valeur du champ "Numéro de rencontre" AVANT qu'il ne soit vidé explicitement (voir `fetchAllDerogations`) — non-vide confirme que FBI retient une valeur soumise précédemment côté serveur, jamais réinitialisée par un simple nouveau login. `null` si le champ n'a pas pu être lu. */
  numeroValueBeforeClear: string | null;
  /** `selectors.derogationResultsContainer(page)` a été trouvé sur la page (voir `resolveDerogationScope`) — `false` signifie que les lectures sont retombées sur `page` entière (comportement d'avant le vingtième round), risquant de lire un tableau SANS RAPPORT ailleurs sur la page si le vrai tableau n'a pas encore de lignes. */
  derogationContainerFound: boolean;
  /** Tableaux présents sur la page après la recherche (voir `describeTables`). */
  tables?: Array<{ id: string; className: string; headers: string[]; bodyRows: number }>;
}

export interface FetchAllDerogationsOptions {
  /** Faux = détail déjà connu et dérogation inchangée : la page de détail n'est pas rouverte. Défaut : toujours vrai. */
  needsDetail?: (row: FbiDerogationRow) => boolean;
  onDetailProgress?: (done: number, total: number) => void;
}

export interface DerogationDetailStats {
  toFetch: number;
  fetched: number;
  failed: number;
  skippedUnchanged: number;
  stoppedEarly: "budget" | "fbi_ne_repond_plus" | null;
  /** Forme de la première page de détail lue (voir `selectors.derogationDetailShape`). */
  pageShape?: selectors.DerogationDetailShape | null;
}

export class BrowserFbiClient {
  private readonly baseUrl: string;
  private readonly browser: Browser;
  private readonly navigationSettleMs: number;
  private readonly derogationDetailBudgetMs: number;
  private readonly derogationDetailPauseMs: number;

  /**
   * Diagnostic de la DERNIÈRE `fetchAllDerogations` — jamais fait partie
   * du contrat `FbiAutomationClient` (§ "ya le statut en cours qui est pas
   * pris en compte", docs/FBI.md, 2026-09-26/27) : le club fournit la
   * preuve directe de 9 dérogations RÉELLEMENT "En Cours" sur le vrai FBI,
   * alors que la passe "EC" n'en ramène AUCUNE — ce champ confirme, sans
   * deviner un troisième correctif, si l'option "En Cours" est
   * RÉELLEMENT sélectionnée au moment du clic sur RECHERCHER et combien de
   * lignes brutes cette recherche a effectivement trouvées. Lu par
   * `processCheckAllDerogationsJob` juste après `fetchAllDerogations`,
   * jamais par un appelant `FbiAutomationClient` générique.
   */
  private lastDerogationPassDiagnostics: DerogationPassDiagnostic[] = [];
  private lastDerogationDetailStats: DerogationDetailStats | null = null;

  /**
   * Trace de la DERNIÈRE session ouverte par `login` (2026-10-06, diagnostic
   * des coupures FBI) — chaque requête, sa durée et son issue. Lue par le job
   * puis enregistrée dans `fbi_session_traces`.
   */
  lastTrace: FbiSessionTrace | null = null;

  /**
   * Rythme humain (2026-10-06) : un pare-feu devant FBI coupe l'adresse d'une
   * session qui enchaîne connexion, pages et téléchargement en quelques
   * secondes sans aucune interaction. Pauses de quelques secondes, saisie
   * caractère par caractère, mouvements de souris. Désactivé dans les tests.
   */
  private readonly humanPacing: boolean;

  private async humanPause(page: Page, minMs: number, maxMs: number): Promise<void> {
    if (!this.humanPacing) return;
    await page.mouse.move(200 + Math.random() * 800, 150 + Math.random() * 450, { steps: 6 + Math.floor(Math.random() * 6) }).catch(() => undefined);
    await page.waitForTimeout(minMs + Math.random() * (maxMs - minMs));
  }

  /** Voir `SKIPPED_AFTER_LOGIN_TYPES`. */
  private readonly lightSession: boolean;

  /** Saison FBI (libellé + identifiant) lue pendant la dernière recherche — mise en cache par l'appelant. */
  lastSeasonOption: { label: string; value: string } | null = null;

  constructor(options: BrowserFbiClientOptions) {
    this.humanPacing = options.humanPacing ?? false;
    this.lightSession = options.lightSession ?? false;
    this.baseUrl = options.baseUrl;
    this.browser = options.browser;
    this.navigationSettleMs = options.navigationSettleMs ?? 500;
    this.derogationDetailBudgetMs = options.derogationDetailBudgetMs ?? 220_000;
    this.derogationDetailPauseMs = options.derogationDetailPauseMs ?? 0;
  }

  getLastDerogationPassDiagnostics(): readonly DerogationPassDiagnostic[] {
    return this.lastDerogationPassDiagnostics;
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForTimeout(this.navigationSettleMs);
  }

  /**
   * Attend que le tableau de résultats de dérogations se STABILISE avant de
   * le lire — § "ya le statut en cours qui est pas pris en compte",
   * docs/FBI.md (2026-09-26/27) : le diagnostic ajouté au round précédent a
   * confirmé que l'option "En Cours" est bien RÉELLEMENT sélectionnée au
   * moment du clic (`selectedEtatValueAtSubmit: "EC"`), éliminant
   * l'hypothèse d'un échec de sélection — mais UNE exécution a ensuite
   * ramené `rawRowCount: 4` pour LES DEUX passes (au lieu des ~20 connus
   * pour "TT"), bien plus vite que les exécutions précédentes (~38s contre
   * ~90-100s) : signe que la lecture du tableau intervenait AVANT que
   * l'appel AJAX déclenché par `rechercherDerogationAjax()`
   * (`postAjax("rechercherDerogation.fbi?action=controleRecherche", ...)`)
   * ait fini de peupler `#getTableauDerogation` — `page.waitForLoadState
   * ("networkidle")` peut se résoudre dès que la RÉPONSE réseau est reçue,
   * AVANT que `remplirDiv()` (callback) ait fini d'injecter et que
   * DataTables ait fini de (re)dessiner le tableau, un délai variable
   * selon la charge du serveur FBI.
   *
   * Best effort : compare deux lectures successives du tableau (même
   * principe que la détection de fin de pagination dans
   * `collectAllResultPages`) — s'arrête dès que le contenu ne
   * change plus (signe que le rendu est terminé), ou après `maxAttempts`
   * tentatives (recherche réellement vide, ou rendu anormalement lent —
   * ne bloque jamais indéfiniment le job).
   */
  private async waitForStableDerogationTable(page: Page, maxAttempts = 6, intervalMs = this.navigationSettleMs): Promise<void> {
    let previousSignature: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const rows = await selectors.resultsTableGenericRows(page).catch(() => null);
      const signature = JSON.stringify(rows);
      if (signature === previousSignature) return;
      previousSignature = signature;
      await page.waitForTimeout(intervalMs);
    }
  }

  private attachTrace(context: BrowserContext): FbiSessionTrace {
    const trace: FbiSessionTrace = { startedAt: new Date().toISOString(), events: [], dropped: 0, fingerprint: { cookieNames: [], headers: {} } };
    const noteHeaders = (headers: Record<string, string>) => {
      for (const [name, value] of Object.entries(headers)) {
        if (!FINGERPRINT_HEADER.test(name)) continue;
        if (name.toLowerCase() === "set-cookie") {
          for (const line of value.split("\n")) {
            const cookieName = line.split("=")[0]?.trim();
            if (cookieName && !trace.fingerprint.cookieNames.includes(cookieName)) trace.fingerprint.cookieNames.push(cookieName);
          }
        } else if (!(name in trace.fingerprint.headers)) {
          trace.fingerprint.headers[name] = value.slice(0, 120);
        }
      }
    };
    const origin = Date.now();
    const started = new Map<object, number>();
    const fbiHost = new URL(this.baseUrl).host;
    const describe = (url: string) => {
      try {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/;jsessionid=[^/?#]*/i, "");
        return parsed.host === fbiHost ? path : `${parsed.host}${path}`;
      } catch {
        return "(url illisible)";
      }
    };
    const push = (event: FbiTraceEvent) => {
      if (trace.events.length < MAX_TRACE_EVENTS) trace.events.push(event);
      else trace.dropped += 1;
    };
    context.on("request", (request) => started.set(request, Date.now()));
    context.on("requestfinished", (request) => {
      const begin = started.get(request);
      void request
        .response()
        .then(async (response) => {
          push({ t: (begin ?? Date.now()) - origin, m: request.method(), u: describe(request.url()), r: request.resourceType(), s: response?.status() ?? "sans réponse", d: begin ? Date.now() - begin : null });
          if (response && new URL(request.url()).host === fbiHost) noteHeaders(await response.allHeaders().catch(() => ({})));
        })
        .catch(() => undefined);
    });
    context.on("requestfailed", (request) => {
      const begin = started.get(request);
      const skipped = SKIPPED_RESOURCE_TYPES.has(request.resourceType());
      push({ t: (begin ?? Date.now()) - origin, m: request.method(), u: describe(request.url()), r: request.resourceType(), s: skipped ? "ignoré" : (request.failure()?.errorText ?? "échec"), d: begin ? Date.now() - begin : null });
    });
    return trace;
  }

  /**
   * Connexion FBI. `savedState` (cookies d'une session précédente, voir
   * `fbi_saved_sessions`) : si la session est encore valide côté FBI, elle est
   * reprise sans renvoyer identifiant et mot de passe — une connexion par
   * jour au lieu d'une par passage (2026-10-06 : coupures FBI).
   */
  async login(
    credentials: { username: string; password: string },
    options: { savedState?: string; allowCredentialLogin?: boolean; onCredentialLogin?: () => Promise<void> } = {},
  ): Promise<BrowserFbiSession> {
    if (options.savedState) {
      const proxy = fbiProxySettings();
      let storageState: BrowserContextOptions["storageState"];
      try {
        storageState = JSON.parse(options.savedState) as BrowserContextOptions["storageState"];
      } catch {
        storageState = undefined;
      }
      if (storageState) {
        const context = await this.browser.newContext({ ...fbiBrowserIdentity(this.browser.version()), ...(proxy ? { proxy } : {}), storageState });
        this.lastTrace = this.attachTrace(context);
        await context.route("**/*", (route) => (SKIPPED_RESOURCE_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue()));
        const page = await context.newPage();
        const resumed = await page
          .goto(`${this.baseUrl}/accueil.fbi`, { waitUntil: "domcontentloaded", timeout: 25_000 })
          .then(async () => !(await selectors.looksLikeLoginPage(page)))
          .catch(() => false);
        if (resumed) {
          await this.humanPause(page, 2000, 4000);
          return { context, page, reused: true };
        }
        await context.close();
      }
    }
    if (options.allowCredentialLogin === false) {
      throw new FbiError("Session FBI conservée expirée ; nouvelle connexion avec identifiants pas encore autorisée (plafond de connexions).", "SESSION_EXPIRED");
    }
    await options.onCredentialLogin?.();
    return this.loginWithCredentials(credentials);
  }

  private async loginWithCredentials(credentials: { username: string; password: string }): Promise<BrowserFbiSession> {
    // Contexte isolé PAR APPEL : jamais de cookie/session partagée entre deux
    // clubs, même s'ils réutilisent ce même Browser.
    // Proxy à IP fixe (`FBI_PROXY_URL`) aussi au niveau du contexte : couvre
    // `context.request` (requêtes hors page) en plus des pages.
    const proxy = fbiProxySettings();
    const context = await this.browser.newContext({ ...fbiBrowserIdentity(this.browser.version()), ...(proxy ? { proxy } : {}) });
    this.lastTrace = this.attachTrace(context);
    // Moins de connexions vers FBI (2026-10-06 : FBI coupe au-delà d'un
    // certain volume) : images, polices et médias ne servent à rien ici.
    // Les feuilles de style restent chargées (visibilité des éléments).
    let landed = false;
    await context.route("**/*", (route) => {
      const request = route.request();
      const type = request.resourceType();
      if (type === "document" && /\/accueil\.fbi/.test(request.url())) landed = true;
      const skip = SKIPPED_RESOURCE_TYPES.has(type) || (this.lightSession && landed && SKIPPED_AFTER_LOGIN_TYPES.has(type));
      return skip ? route.abort() : route.continue();
    });
    const page = await context.newPage();

    try {
      /**
       * Retry réseau (§ 2026-09-30, job 3f0d54ad) : même raisonnement que
       * `tryNavigateToSearchScreen` — un `net::ERR_CONNECTION_TIMED_OUT`
       * (blip TCP Vercel→FFBB, pas une panne FBI ni un souci de compte,
       * confirmé par une connexion manuelle réussie au même moment) peut
       * survenir sur N'IMPORTE QUELLE navigation vers FFBB, pas seulement
       * le téléchargement — la toute PREMIÈRE navigation d'un job
       * (connexion.fbi) n'avait jusqu'ici aucun retry, faisant échouer le
       * job entier pour un blip d'une poignée de secondes.
       */
      let lastNetworkError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await page.goto(`${this.baseUrl}/connexion.fbi`, { waitUntil: "domcontentloaded", timeout: 25_000 });
          lastNetworkError = undefined;
          break;
        } catch (error) {
          lastNetworkError = error;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
      if (lastNetworkError) throw lastNetworkError;
    } catch (error) {
      await context.close();
      // Cause technique gardée dans le message (délai dépassé, connexion
      // refusée…) : sans elle, impossible de distinguer une panne FBI d'un
      // blocage des adresses Vercel (2026-10-06). Jamais d'identifiant ici.
      const cause = error instanceof Error ? error.message.split("\n")[0].slice(0, 160) : String(error).slice(0, 160);
      // Proxy configuré : sonde depuis cette machine pour savoir où ça bloque
      // (proxy injoignable, ou proxy joignable mais FBI ne lui répond pas).
      const proxyProbe = fbiProxySettings() ? ` ; sonde du proxy : ${await probeFbiProxy().catch(() => "impossible")}` : "";
      throw new FbiError(`Page de connexion FBI injoignable (${cause})${proxyProbe}`, "LOGIN_PAGE_UNREACHABLE", error);
    }

    if (!(await selectors.looksLikeLoginPage(page))) {
      await context.close();
      throw new FbiError("Formulaire de connexion FBI non reconnu (aucun champ mot de passe trouvé)", "LOGIN_FORM_NOT_RECOGNIZED");
    }

    try {
      if (this.humanPacing) {
        await this.humanPause(page, 1500, 3000);
        await selectors.usernameInput(page).click();
        await selectors.usernameInput(page).pressSequentially(credentials.username, { delay: 60 + Math.random() * 60 });
        await this.humanPause(page, 300, 800);
        await selectors.passwordInput(page).click();
        await selectors.passwordInput(page).pressSequentially(credentials.password, { delay: 60 + Math.random() * 60 });
        await this.humanPause(page, 500, 1200);
      } else {
        await selectors.usernameInput(page).fill(credentials.username);
        await selectors.passwordInput(page).fill(credentials.password);
      }

      const submit = selectors.submitControl(page);
      if ((await submit.count()) > 0) {
        await submit.first().click();
      } else {
        await selectors.submitButtonByText(page).click();
      }

      await this.settle(page);
    } catch (error) {
      await context.close();
      throw new FbiError("Échec de la soumission du formulaire de connexion FBI", "NAVIGATION_FAILED", error);
    }

    if (await selectors.looksLikeLoginPage(page)) {
      await context.close();
      throw new FbiError("Connexion FBI refusée (identifiants incorrects, ou formulaire modifié)", "LOGIN_FAILED");
    }

    await this.humanPause(page, 2500, 4500);
    return { context, page };
  }

  async isSessionValid(session: BrowserFbiSession): Promise<boolean> {
    try {
      await session.page.goto(`${this.baseUrl}/accueil.fbi`, { waitUntil: "domcontentloaded" });
    } catch {
      return false;
    }
    return !(await selectors.looksLikeLoginPage(session.page));
  }

  /**
   * Recherche générique et défensive (voir la note de statut en tête de
   * fichier) : tente de rejoindre un écran de recherche de rencontre, y
   * saisit le numéro, puis scanne la page de résultat pour des liens de
   * documents connus. Chaque étape échoue silencieusement (best effort)
   * plutôt que de planter — `documents: []` déclenche un retry planifié
   * ("document pas encore trouvé" n'est pas une erreur).
   *
   * `season` (format "2025-2026", voir `resolveSeasonLabel` côté appelant)
   * est OPTIONNEL mais fortement recommandé : voir `tryPrepareSearchFilters`.
   *
   * `division` (§ "82 vs 51", docs/FBI.md, 2026-09-27 — même désambiguïsation
   * que `fetchDerogationForMatch`, jamais appliquée ICI avant le retour du
   * club du 2026-09-30, "tu confonds les matchs") : un numéro de rencontre
   * n'est PAS unique au club — confirmé en base le 2026-09-30, un même club
   * pouvant avoir 4 matchs de catégories différentes portant le numéro "6"
   * la même saison. Sans ce filtre, la première ligne du tableau de
   * résultats partageant ce numéro était acceptée, quelle que soit sa
   * catégorie/poule — les stats et licences d'UN AUTRE match (autre
   * catégorie, même club) s'attachaient alors silencieusement au mauvais
   * match. `null` (compétition inconnue) reste un repli best-effort, jamais
   * un échec du job.
   *
   * `diagnostic` (§ "Vingt-septième déclenchement", docs/FBI.md) : rempli
   * UNIQUEMENT quand `documents` est vide, avec la même trace/dump riche
   * qu'un échec dur — l'appelant (`process-discover-emarque.ts`) le
   * persiste dans `fbi_jobs.last_error` (même colonne que pour un VRAI
   * échec) pour qu'il soit consultable directement en base sans dépendre
   * des logs Vercel (que seul un humain avec accès au dashboard peut lire
   * et coller manuellement — un aller-retour coûteux répété à chaque
   * itération de correctif).
   */
  async findEmarqueDocuments(
    session: BrowserFbiSession,
    matchNumber: string,
    season: string | null = null,
    division: string | null = null,
    seasonIdHint: string | null = null,
  ): Promise<{ documents: { url: string; fileName: string }[]; diagnostic: string | null }> {
    const { page } = session;

    const trace: string[] = [];

    // Recherche DIRECTE d'abord (retour du club, 2026-10-02) — voir
    // `emarque-search.ts`. Depuis le 2026-10-06, sans même OUVRIR l'écran de
    // recherche : son chargement complet (scripts, styles) expirait à travers
    // le proxy alors qu'un seul de ses éléments sert (la liste des saisons),
    // lu par `readSeasonOptions`. Le parcours historique reste le secours.
    await this.humanPause(page, 1500, 3000);
    let navigation = "écran de recherche non ouvert (recherche directe)";
    let direct = await this.tryDirectEmarqueSearch(session, matchNumber, season, division, seasonIdHint);
    if (direct.kind === "unavailable") {
      const firstAttempt = direct.note;
      navigation = `${await this.tryNavigateToSearchScreen(page)} (recherche directe sans l'écran : ${firstAttempt})`;
      direct = await this.tryDirectEmarqueSearch(session, matchNumber, season, division);
    }
    if (direct.kind === "document") return { documents: [direct.document], diagnostic: null };
    if (direct.kind === "no_emarque") {
      return { documents: [], diagnostic: `[info, pas une erreur] Rencontre ${matchNumber} trouvée sur FBI mais sans e-Marque téléchargeable pour l'instant (colonne EM vide). ${direct.note}` };
    }

    // Repli : parcours historique à la souris (jamais retiré — filet de sécurité si FBI change ses requêtes).
    trace.push(`${navigation} ; recherche directe : ${direct.note}`);
    trace.push(await this.tryPrepareSearchFilters(page, season, division));
    trace.push(await this.trySearchByMatchNumber(page, matchNumber));
    const openResult = await this.tryOpenMatchResult(page, matchNumber, division);
    trace.push(openResult.trace);

    /**
     * Constaté en production le 2026-09-24 : les trois étapes ci-dessus
     * sont volontairement "best effort" (elles avalent leurs erreurs) —
     * si AUCUNE n'aboutit, `findDocumentLinks` scannait silencieusement la
     * page où on était déjà (souvent la page d'accueil post-login), dont
     * les liens permanents de téléchargement du LOGICIEL e-Marque
     * matchent `DOCUMENT_EXTENSION_PATTERN` (n'importe quel .pdf/.zip) —
     * remontés à tort comme documents DE CE MATCH, pour chaque match,
     * identiques à chaque fois. Ne JAMAIS faire confiance à
     * `findDocumentLinks` sans avoir d'abord vérifié qu'on est bien sur
     * une page qui mentionne CE numéro de rencontre.
     */
    /**
     * Préférer une correspondance EXACTE de cellule "N°" (si un tableau de
     * résultats est présent sur la page courante) à la recherche floue de
     * `pageMentionsMatchNumber` — régression production 2026-09-24 pour la
     * rencontre n°1 : l'en-tête de colonne "Score 1" contient un "1" isolé
     * qui déclenchait un faux positif sur `pageMentionsMatchNumber` alors
     * qu'aucune ligne "1" n'existe dans le tableau (voir
     * `selectors.matchNumberInResultsTable`). Le texte de page libre reste
     * le seul recours sur une page SANS tableau (ex : page de détail après
     * clic sur le lien EM).
     */
    const tableMatch = await selectors.matchNumberInResultsTable(page, matchNumber, division);
    const pageConfirmsMatch = tableMatch !== null ? tableMatch : await selectors.pageMentionsMatchNumber(page, matchNumber);
    if (!pageConfirmsMatch) {
      const title = await page.title().catch(() => "?");
      /**
       * Diagnostic riche (§ "Seizième déclenchement", docs/FBI.md) : les
       * 25 premiers liens visibles se sont révélés être le menu global du
       * site ffbb.com (Fédération, Compétitions, Boutique...), pas la
       * navigation spécifique FBI — insuffisant pour savoir à QUELLE étape
       * (1/2/3 ci-dessus) la navigation décroche. `trace` répond
       * précisément à ça : ce que chaque étape a trouvé/cliqué, et vers
       * quelle URL, AVANT que la vérification finale échoue.
       */
      const links = await selectors.listVisibleLinks(page, 60);
      const linksSummary = links.length > 0 ? links.map((l) => `"${l.text}" → ${l.href}`).join(" | ") : "(aucun lien trouvé sur la page)";

      /**
       * Diagnostic riche (§ "Dix-neuvième déclenchement", docs/FBI.md) :
       * après correction du faux positif de checkbox, une recherche
       * "réussie" (champ rempli, formulaire soumis) n'a produit AUCUNE
       * ligne de résultat pour un match réellement joué (n°2813, preuve
       * visuelle du code EM). Hypothèse à vérifier sur preuve : un champ
       * de formulaire obligatoire non renseigné (ex : une saison qui
       * défaute sur la saison EN COURS plutôt que celle du match
       * recherché) empêcherait la recherche d'aboutir quel que soit le
       * champ numéro ciblé. Ce dump révèle l'état RÉEL de tous les
       * champs (y compris les `<select>` et leur option sélectionnée) au
       * moment de l'échec.
       */
      const formFields = await selectors.listFormFields(page, 40);
      const formFieldsSummary =
        formFields.length > 0
          ? formFields.map((f) => (f.tag === "select" ? `select[name=${f.name}]="${f.selectedLabel ?? f.value}"` : `${f.tag}[type=${f.type ?? "?"},name=${f.name}]="${f.value}"`)).join(" | ")
          : "(aucun champ de formulaire trouvé sur la page)";

      /**
       * Diagnostic riche (§ "Vingt-quatrième déclenchement", docs/FBI.md) :
       * saison/case correctement ajustées, bon bouton cliqué, mais toujours
       * aucun résultat — le HTML brut du formulaire révélera la structure
       * exacte des widgets JS (`<select>` + `<button>` jumeau observés)
       * nécessaire pour interagir avec eux comme un vrai utilisateur.
       */
      const formHtml = await selectors.formHtmlSnippet(page);

      /**
       * Diagnostic riche (§ "Vingt-sixième déclenchement", docs/FBI.md) :
       * le vrai formulaire fait ~43000 caractères (le sélecteur Division
       * seul liste des centaines d'options) — `formHtml` (plafonné à 4000)
       * se coupe systématiquement avant d'atteindre le bouton "Rechercher"
       * ou le champ numéro, pourtant les éléments les plus pertinents ici.
       */
      const searchControlsHtml = await selectors.searchControlsHtmlSnippet(page);

      throw new FbiError(
        `Page de résultat introuvable pour la rencontre ${matchNumber} : ni la recherche ni l'ouverture du résultat n'ont abouti (page actuelle : "${title}", ${page.url()}). ` +
          `Trace de navigation : [1] ${trace[0]} — [2] ${trace[1]} — [3] ${trace[2]} — [4] ${trace[3]}. ` +
          `Champs de formulaire sur cette page : ${formFieldsSummary}. ` +
          `Liens visibles sur cette page : ${linksSummary}. ` +
          `HTML autour du bouton de recherche : ${searchControlsHtml}. ` +
          `HTML du formulaire : ${formHtml}`,
        "EMARQUE_MATCH_PAGE_NOT_REACHED",
      );
    }

    const links = await selectors.findDocumentLinks(page);

    /**
     * Constaté en production le 2026-09-24 (rencontre n°1481, § "Vingt-
     * neuvième déclenchement", docs/FBI.md) : le lien de la colonne EM
     * déclenche un téléchargement natif du navigateur (voir
     * `tryOpenMatchResult`) plutôt qu'un `<a href>` classique — DONC
     * jamais trouvé par `findDocumentLinks` (qui ne scanne que des
     * `href`). L'URL capturée par l'événement `download` de Playwright
     * EST une vraie URL FBI réutilisable (ex :
     * `.../telechargerFeuilleMatchEmarque.fbi?action=emV2&plugin=true&idRenc=<token>`),
     * jamais un `blob:` temporaire — elle est ajoutée ici aux documents
     * "trouvés par lien" exactement comme n'importe quel autre document,
     * pour repasser par le même pipeline `downloadDocument()`/Storage
     * (`process-discover-emarque.ts`) sans traitement spécial. Dédupliquée
     * par URL au cas où le même document apparaîtrait aussi comme lien
     * classique.
     */
    const documents = links.map((link) => ({
      url: new URL(link.href, page.url()).toString(),
      fileName: this.fileNameFromLabelOrUrl(link),
    }));
    if (openResult.discoveredDocument && !documents.some((d) => d.url === openResult.discoveredDocument!.url)) {
      documents.push(openResult.discoveredDocument);
    }

    /**
     * Constaté en production le 2026-09-24 (rencontre n°2813, § "Vingt-
     * troisième déclenchement", docs/FBI.md) : `documents.length === 0`
     * (page confirmée pour CE match, mais aucun lien de document retenu
     * après filtrage) déclenche un simple retry planifié côté appelant
     * (`process-discover-emarque.ts`), SANS AUCUN diagnostic — contrairement
     * au chemin d'échec dur (`EMARQUE_MATCH_PAGE_NOT_REACHED`) qui embarque
     * trace/champs/liens dans son message. Un match confirmé via capture
     * d'écran comme ayant un vrai document (2813, code EM "DCBLRCA7") qui
     * ressort à zéro mérite la même preuve — sinon c'est encore un cycle de
     * correctif à l'aveugle sur le prochain échec identique.
     */
    let diagnostic: string | null = null;
    if (documents.length === 0) {
      const title = await page.title().catch(() => "?");
      const visibleLinks = await selectors.listVisibleLinks(page, 60);
      const linksSummary = visibleLinks.length > 0 ? visibleLinks.map((l) => `"${l.text}" → ${l.href}`).join(" | ") : "(aucun lien trouvé sur la page)";
      const formFields = await selectors.listFormFields(page, 40);
      const formFieldsSummary =
        formFields.length > 0
          ? formFields.map((f) => (f.tag === "select" ? `select[name=${f.name}]="${f.selectedLabel ?? f.value}"` : `${f.tag}[type=${f.type ?? "?"},name=${f.name}]="${f.value}"`)).join(" | ")
          : "(aucun champ de formulaire trouvé sur la page)";
      const formHtml = await selectors.formHtmlSnippet(page);
      const searchControlsHtml = await selectors.searchControlsHtmlSnippet(page);

      diagnostic =
        `[info, pas une erreur] Page confirmée pour la rencontre ${matchNumber} (page actuelle : "${title}", ${page.url()}) mais aucun document retenu après filtrage. ` +
        `Trace de navigation : [1] ${trace[0]} — [2] ${trace[1]} — [3] ${trace[2]} — [4] ${trace[3]}. ` +
        `Champs de formulaire sur cette page : ${formFieldsSummary}. ` +
        `Liens visibles sur cette page : ${linksSummary}. ` +
        `HTML autour du bouton de recherche : ${searchControlsHtml}. ` +
        `HTML du formulaire : ${formHtml}`;

      logInfo(`Job discover_emarque : page confirmée pour la rencontre ${matchNumber} mais aucun document retenu après filtrage`, {
        matchNumber,
        title,
        url: page.url(),
        trace,
        visibleLinks: linksSummary,
        formFields: formFieldsSummary,
        searchControlsHtml,
        formHtml,
      });
    }

    return { documents, diagnostic };
  }

  /**
   * Recherche e-Marque sans piloter le formulaire (voir `emarque-search.ts`) :
   * mêmes requêtes que le navigateur, même session. `unavailable` (forme de
   * page/réponse inattendue) et `not_found` laissent l'appelant retomber sur
   * le parcours à la souris — jamais un échec du job à ce stade.
   */
  /**
   * Saisons du formulaire de recherche : sur la page si elle est déjà
   * ouverte, sinon en lisant SEULEMENT le HTML de l'écran (une requête depuis
   * la page, même session, aucune ressource annexe) — même état côté serveur
   * qu'une ouverture complète, en une fraction du temps.
   */
  private async readSeasonOptions(page: Page): Promise<Array<{ value: string; label: string; selected: boolean }>> {
    const onPage = await page
      .locator('select[name$="idSaison"] option')
      .evaluateAll((options) => options.map((o) => ({ value: (o as HTMLOptionElement).value, label: (o.textContent ?? "").trim(), selected: (o as HTMLOptionElement).selected })))
      .catch(() => []);
    if (onPage.length > 0) return onPage;

    return page
      .evaluate(
        async ({ url, timeoutMs }) => {
          try {
            const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(timeoutMs) });
            if (!response.ok) return [];
            const doc = new DOMParser().parseFromString(await response.text(), "text/html");
            return Array.from(doc.querySelectorAll('select[name$="idSaison"] option')).map((o) => ({
              value: (o as HTMLOptionElement).value,
              label: (o.textContent ?? "").trim(),
              selected: (o as HTMLOptionElement).hasAttribute("selected"),
            }));
          } catch {
            return [];
          }
        },
        { url: `${this.baseUrl}/rechercherRencontreSaisieResultat.fbi`, timeoutMs: FBI_IN_PAGE_REQUEST_TIMEOUT_MS },
      )
      .catch(() => []);
  }

  private async tryDirectEmarqueSearch(
    session: BrowserFbiSession,
    matchNumber: string,
    season: string | null,
    division: string | null,
    seasonIdHint: string | null = null,
  ): Promise<
    | { kind: "document"; document: { url: string; fileName: string }; note: string }
    | { kind: "no_emarque" | "not_found" | "unavailable"; note: string }
  > {
    const { page, context } = session;
    try {
      // Identifiant de saison déjà connu (mis en cache) : pas besoin de relire l'écran de recherche (≈ 1,7 s).
      const seasonOptions = seasonIdHint && season ? [{ value: seasonIdHint, label: season, selected: true }] : await this.readSeasonOptions(page);
      const seasonOption = (season ? seasonOptions.find((o) => o.label.includes(season)) : undefined) ?? seasonOptions.find((o) => o.selected && o.value);
      if (seasonOption?.value && !seasonIdHint) this.lastSeasonOption = { label: season ?? seasonOption.label, value: seasonOption.value };
      if (!seasonOption?.value) return { kind: "unavailable", note: `saison "${season ?? "?"}" introuvable dans le formulaire (${seasonOptions.length} options)` };

      const criteria = { seasonId: seasonOption.value, matchNumber };
      const searchUrl = `${this.baseUrl}/rechercherRencontreSaisieResultat.fbi`;
      const headers = { "X-Requested-With": "XMLHttpRequest", Referer: searchUrl };

      // Requêtes envoyées DEPUIS LA PAGE (fetch du navigateur, exactement
      // comme le JavaScript du site) : constaté en production le 2026-10-02
      // (rencontres n°5 et n°6) que la même requête via `context.request`
      // (pile réseau Node) échouait en "connect ETIMEDOUT" alors que le
      // navigateur, au même instant, chargeait les pages FBI sans souci.
      // `context.request` reste le repli si l'évaluation dans la page échoue.
      const form = searchFormFields(criteria);
      const query = executeSearchQuery(criteria);
      let body: string;
      const inPage = await page
        .evaluate(
          async ({ searchUrl, form, query, timeoutMs }) => {
            const describe = async (step: string, response: Response) => `${step} HTTP ${response.status} (${(await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160)})`;
            try {
              const controlResponse = await fetch(`${searchUrl}?action=controleRecherche`, {
                method: "POST",
                headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
                body: new URLSearchParams(form).toString(),
                credentials: "include",
                signal: AbortSignal.timeout(timeoutMs),
              });
              if (!controlResponse.ok) return { error: await describe("controleRecherche", controlResponse) };
              const executeResponse = await fetch(`${searchUrl}?${query}`, { headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "include", signal: AbortSignal.timeout(timeoutMs) });
              if (!executeResponse.ok) return { error: await describe("executeRecherche", executeResponse) };
              return { body: await executeResponse.text() };
            } catch (error) {
              return { error: `fetch : ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` };
            }
          },
          { searchUrl, form, query, timeoutMs: FBI_IN_PAGE_REQUEST_TIMEOUT_MS },
        )
        .catch((error: unknown) => ({ error: `évaluation dans la page impossible (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` }));

      if ("body" in inPage && typeof inPage.body === "string") {
        body = inPage.body;
      } else {
        const browserError = `navigateur : ${inPage.error}`;
        try {
          const control = await context.request.post(`${searchUrl}?action=controleRecherche`, { form, headers, timeout: FBI_NODE_REQUEST_TIMEOUT_MS });
          if (!control.ok()) return { kind: "unavailable", note: `${browserError} ; Node : controleRecherche HTTP ${control.status()}` };
          const execute = await context.request.get(`${searchUrl}?${query}`, { headers, timeout: FBI_NODE_REQUEST_TIMEOUT_MS });
          if (!execute.ok()) return { kind: "unavailable", note: `${browserError} ; Node : executeRecherche HTTP ${execute.status()}` };
          body = await execute.text();
        } catch (error) {
          return { kind: "unavailable", note: `${browserError} ; Node : ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
        }
      }

      let rows;
      try {
        rows = parseSearchResponse(body);
      } catch (error) {
        return { kind: "unavailable", note: `réponse executeRecherche illisible (${error instanceof Error ? error.message : String(error)}) : ${body.slice(0, 300)}` };
      }

      const summary = rows.map((r) => `${r.division}#${r.matchNumber}${r.emarqueToken ? "(EM)" : ""}`).join(", ") || "aucune ligne";
      const row = pickRow(rows, matchNumber, division);
      if (!row) return { kind: "not_found", note: `saison "${seasonOption.label}", aucune ligne n°${matchNumber}${division ? ` en ${division}` : ""} (lignes : ${summary})` };
      if (!row.emarqueToken) return { kind: "no_emarque", note: `ligne ${row.division} n°${row.matchNumber} sans lien EM (lignes : ${summary})` };
      if (!row.emarqueV2) return { kind: "unavailable", note: `lien EM non V2 pour ${row.division} n°${row.matchNumber} — repli sur le clic` };

      return {
        kind: "document",
        document: { url: emarqueDownloadUrl(this.baseUrl, row.emarqueToken), fileName: `emarque_${row.division}_${row.matchNumber}_${row.fbiMatchId ?? "x"}.zip` },
        note: `ligne ${row.division} n°${row.matchNumber} trouvée (recherche directe)`,
      };
    } catch (error) {
      return { kind: "unavailable", note: `recherche directe impossible : ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * Constaté en production le 2026-09-24 (rencontre n°1481, § "Vingt-deuxième
   * déclenchement", docs/FBI.md) : le nom de fichier RÉEL est utilisé quand
   * l'URL se termine par une extension connue, sinon un nom dérivé du
   * libellé visible du lien (repli générique). Deux liens DIFFÉRENTS avec le
   * même libellé visible (ex : "e-Marque") produisaient alors le MÊME nom de
   * fichier — donc le MÊME `storagePath` (dérivé du nom de fichier, voir
   * `emarqueStoragePath`), et s'écrasaient silencieusement l'un l'autre dans
   * Storage tout en laissant plusieurs lignes `match_documents` DISTINCTES
   * pointant vers ce chemin unique désormais incohérent avec leur `sha256`
   * d'origine. Un court hash de l'URL (jamais visible à l'utilisateur, juste
   * de quoi distinguer deux documents homonymes) élimine cette collision.
   */
  private fileNameFromLabelOrUrl(link: { href: string; label: string }): string {
    const fromUrl = link.href.split("/").pop();
    if (fromUrl && /\.(zip|pdf)$/i.test(fromUrl)) return fromUrl;

    const slug = link.label.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 60) || "document";
    const shortHash = createHash("sha1").update(link.href).digest("hex").slice(0, 8);
    return `${slug}_${shortHash}.pdf`;
  }

  /** Chaque étape "best effort" renvoie une trace lisible (jamais d'exception) — voir le diagnostic de `findEmarqueDocuments`. */
  private async tryNavigateToSearchScreen(page: Page): Promise<string> {
    /**
     * Constaté en production le 2026-09-24 (capture d'écran du VRAI FBI
     * fournie par le club, § "Dix-huitième déclenchement", docs/FBI.md) :
     * l'écran de recherche de rencontre est
     * `{baseUrl}/rechercherRencontreSaisieResultat.fbi` — une URL CONFIRMÉE,
     * jamais devinée. Navigation directe plutôt que de deviner un lien à
     * cliquer sur l'accueil (l'ancienne approche cliquait à tort le menu
     * global ffbb.com, voir plus haut). Repli sur l'ancien clic de lien
     * (même origine uniquement) si la navigation directe échoue — au cas
     * où cette URL ne serait pas valide pour tous les contextes/rôles FBI.
     */
    const targetUrl = `${this.baseUrl}/rechercherRencontreSaisieResultat.fbi`;
    try {
      /**
       * Retry réseau (§ 2026-09-30, job 3f0d54ad/match 312f32c0, 6ᵉ
       * tentative) : `net::ERR_CONNECTION_TIMED_OUT` observé ici en
       * production — un timeout TCP, pas une lenteur applicative, même
       * signature que le blip déjà corrigé côté téléchargement
       * (`downloadDocument`, région Vercel Paris + retry réseau) — mais
       * cette navigation-ci n'avait encore aucun retry. Le club a confirmé
       * pouvoir se connecter à FBI manuellement au même moment, écartant
       * un souci FBI/compte : un blip réseau ponctuel Vercel→FFBB reste
       * l'explication la plus probable. 3 tentatives rapprochées, jamais
       * sur une vraie réponse HTTP (seulement sur une exception réseau de
       * `page.goto`), même principe que `downloadDocument`.
       */
      let lastNetworkError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
          lastNetworkError = undefined;
          break;
        } catch (error) {
          lastNetworkError = error;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
      if (lastNetworkError) throw lastNetworkError;

      await this.settle(page);
      return `navigation directe vers ${targetUrl} réussie, url → ${page.url()}`;
    } catch (error) {
      const gotoError = error instanceof Error ? error.message : String(error);

      const candidates = await page.getByRole("link", { name: /rencontre|compétition|calendrier/i }).all();
      const pageOrigin = new URL(page.url()).origin;

      for (const candidate of candidates) {
        const href = await candidate.getAttribute("href").catch(() => null);
        if (!href) continue;

        let isSameOrigin: boolean;
        try {
          isSameOrigin = new URL(href, page.url()).origin === pageOrigin;
        } catch {
          continue;
        }
        if (!isSameOrigin) continue;

        const text = (await candidate.textContent().catch(() => null))?.trim() ?? "?";
        try {
          await candidate.click();
          await this.settle(page);
          return `navigation directe échouée (${gotoError}), repli sur le lien "${text}" (même origine) cliqué, url → ${page.url()}`;
        } catch (clickError) {
          return `navigation directe échouée (${gotoError}), repli sur le lien "${text}" trouvé mais le clic a échoué : ${clickError instanceof Error ? clickError.message : String(clickError)}`;
        }
      }

      return `navigation directe vers ${targetUrl} échouée (${gotoError}), et aucun lien de repli (même origine) trouvé`;
    }
  }

  /**
   * Ajuste les filtres du formulaire de recherche AVANT de chercher le
   * numéro de rencontre — confirmé en production le 2026-09-24 (§
   * "Dix-neuvième déclenchement", docs/FBI.md, dump complet des champs de
   * formulaire) : une recherche par numéro seul, sur un match réellement
   * joué (n°2813/1481/4516, preuve visuelle du code EM pour 2813), n'a
   * renvoyé AUCUNE ligne de résultat — parce que DEUX filtres par défaut
   * de la page l'en empêchaient :
   *
   * 1. La checkbox "non joué" (résultat pas encore saisi) est COCHÉE par
   *    défaut — cette page sert à SAISIR des résultats, donc elle filtre
   *    naturellement aux matchs dont le résultat n'est pas encore
   *    homologué, jamais ceux déjà joués (précisément ceux qui ont un
   *    document e-Marque). Toujours décochée : on ne cherche jamais un
   *    match "non joué" ici.
   * 2. Le sélecteur de saison défaute sur la saison EN COURS. Un match
   *    d'une saison passée n'apparaît jamais tant que ce sélecteur n'est
   *    pas ajusté — `season` (calculé par l'appelant depuis
   *    `match.match_datetime` via `resolveSeasonLabel`) est utilisé pour
   *    choisir l'option dont le LIBELLÉ contient cette saison (jamais une
   *    valeur de `<option>` devinée).
   * 3. Constaté en production le 2026-09-30 (job 3f0d54ad, match 312f32c0,
   *    "Page de résultat introuvable") : une recherche par numéro SEUL,
   *    sans division sélectionnée ICI, peut renvoyer un tableau de
   *    résultats ENTIÈREMENT VIDE (zéro ligne, quelle que soit la
   *    division) — voir `selectors.divisionSelect`. `division` (le CODE
   *    de compétition, ex "BU15MN1") est donc AUSSI utilisé pour choisir
   *    l'option de la division dont le libellé le CONTIENT, même principe
   *    que la saison. `null` (compétition inconnue) laisse ce filtre non
   *    appliqué — repli best-effort, jamais un échec.
   */
  private async tryPrepareSearchFilters(page: Page, season: string | null, division: string | null = null): Promise<string> {
    const notes: string[] = [];

    try {
      const nonJoue = selectors.nonJoueCheckbox(page);
      if ((await nonJoue.count().catch(() => 0)) > 0 && (await nonJoue.isChecked().catch(() => false))) {
        await nonJoue.uncheck();
        notes.push('case "non joué" décochée');
      }
    } catch (error) {
      notes.push(`case "non joué" trouvée mais impossible à décocher : ${error instanceof Error ? error.message : String(error)}`);
    }

    if (season) {
      try {
        const select = selectors.seasonSelect(page);
        const selectCount = await select.count().catch(() => 0);
        if (selectCount === 0) {
          notes.push("aucun sélecteur de saison trouvé");
        } else {
          const options = select.locator("option");
          const optionCount = await options.count().catch(() => 0);
          let matchedLabel: string | null = null;

          for (let i = 0; i < optionCount; i += 1) {
            const label = (await options.nth(i).textContent().catch(() => null))?.trim() ?? "";
            if (!label.includes(season)) continue;

            const value = await options.nth(i).getAttribute("value").catch(() => null);
            // `force: true` : le VRAI select FBI est enveloppé par un widget
            // "bootstrap-select" (`<div class="dropdown bootstrap-select ...">`,
            // confirmé par le dump de formulaire capturé en production le
            // 2026-09-30) qui cache le `<select>` natif (display:none) derrière
            // un faux bouton/menu déroulant — Playwright refuse d'interagir
            // avec un élément non visible sans ce flag, même si la valeur se
            // soumet correctement une fois forcée (c'est le `<select>` natif,
            // pas le widget visuel, qui compte pour la soumission du formulaire).
            await select.selectOption(value !== null ? { value } : { label }, { force: true });
            matchedLabel = label;
            break;
          }

          notes.push(matchedLabel ? `saison "${matchedLabel}" sélectionnée` : `aucune option de saison ne contient "${season}"`);
        }
      } catch (error) {
        notes.push(`sélecteur de saison trouvé mais la sélection a échoué : ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (division) {
      try {
        const select = selectors.divisionSelect(page);
        const selectCount = await select.count().catch(() => 0);
        if (selectCount === 0) {
          notes.push("aucun sélecteur de division trouvé");
        } else {
          const options = select.locator("option");
          const optionCount = await options.count().catch(() => 0);
          let matchedLabel: string | null = null;

          for (let i = 0; i < optionCount; i += 1) {
            const label = (await options.nth(i).textContent().catch(() => null))?.trim() ?? "";
            if (!label.includes(division)) continue;

            const value = await options.nth(i).getAttribute("value").catch(() => null);
            // `force: true` : voir le commentaire équivalent sur la saison
            // ci-dessus — le vrai select "division" FBI est lui aussi caché
            // derrière un widget bootstrap-select.
            await select.selectOption(value !== null ? { value } : { label }, { force: true });
            matchedLabel = label;
            break;
          }

          notes.push(matchedLabel ? `division "${matchedLabel}" sélectionnée` : `aucune option de division ne contient "${division}"`);
        }
      } catch (error) {
        notes.push(`sélecteur de division trouvé mais la sélection a échoué : ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.settle(page);
    return notes.length > 0 ? notes.join(" ; ") : "aucun filtre à ajuster (case non joué déjà décochée, pas de saison/division fournie)";
  }

  private async trySearchByMatchNumber(page: Page, matchNumber: string): Promise<string> {
    const input = await selectors.matchNumberSearchInput(page);
    if (!input) return "aucun champ de recherche par numéro trouvé (name/placeholder évocateur)";

    /**
     * Diagnostic (§ "Dix-neuvième déclenchement", docs/FBI.md) : le nom
     * réel du champ ciblé, pour confirmer sur le prochain succès/échec
     * que c'est bien le bon champ (jamais une checkbox ou un autre champ
     * homonyme) — plutôt que de le supposer.
     */
    const inputName = (await input.getAttribute("name").catch(() => null)) ?? "?";

    const urlBefore = page.url();

    /**
     * Capture réseau (§ "Vingt-septième déclenchement", docs/FBI.md) :
     * après plusieurs cycles à deviner depuis le DOM (saison/case/bouton
     * tous confirmés corrects, toujours aucun résultat), la seule preuve
     * définitive de ce que fait RÉELLEMENT le clic sur "Rechercher" est la
     * requête HTTP elle-même — jamais une hypothèse sur le DOM. Capture
     * toute requête XHR/fetch/POST survenant après le clic : son URL, le
     * corps envoyé (révèle si saison/numéro sont bien transmis au serveur),
     * et un extrait de la réponse (révèle si le serveur renvoie déjà les
     * bonnes lignes — auquel cas le problème serait côté rendu client,
     * jamais côté recherche — ou rien du tout).
     */
    const capturedRequests: string[] = [];
    const onResponse = async (response: import("playwright-core").Response): Promise<void> => {
      try {
        const req = response.request();
        if (req.resourceType() !== "xhr" && req.resourceType() !== "fetch" && req.method() !== "POST") return;
        const postData = req.postData();
        const bodySnippet = await response.text().catch(() => null);
        capturedRequests.push(
          `${req.method()} ${response.url()} → HTTP ${response.status()}` +
            (postData ? ` | corps envoyé (${postData.length} car.) : ${postData.slice(0, 800)}` : " | aucun corps envoyé") +
            (bodySnippet ? ` | réponse (${bodySnippet.length} car.) : ${bodySnippet.slice(0, 2000)}` : " | réponse illisible"),
        );
      } catch {
        // Best effort — jamais interrompre le flux principal pour un souci de capture diagnostique.
      }
    };
    page.on("response", onResponse);

    try {
      await input.fill(matchNumber);

      /**
       * Attente EXPLICITE de la vraie requête DataTables (§ 2026-09-30,
       * job 3f0d54ad/match 312f32c0, multiples tentatives à code
       * STRICTEMENT identique tantôt réussies tantôt échouées avec "aucune
       * ligne trouvée") : le tableau de résultats est peuplé en deux temps
       * — une réponse STATIQUE vide au clic "Rechercher" (juste la
       * structure HTML), suivie d'un appel AJAX SÉPARÉ DataTables
       * (`...action=executeRecherche&...`) qui apporte les VRAIES lignes
       * (`aaData`). `this.settle(page)` + `networkidle` (ci-dessous) ne
       * garantissent PAS que CET appel précis a eu le temps de se
       * terminer ET d'être rendu dans le DOM avant que
       * `tryOpenMatchResult` ne lise le tableau — d'où l'instabilité
       * observée (parfois la course est gagnée, parfois perdue). Armé
       * AVANT le clic (jamais après, pour ne pas rater une réponse trop
       * rapide) plutôt qu'un simple délai — best-effort : `null` si non
       * détecté, `trySearchByMatchNumber` continue quand même (repli sur
       * l'ancien comportement settle/networkidle).
       */
      const dataTablesResponsePromise = page
        .waitForResponse((response) => response.url().includes("action=executeRecherche"), { timeout: 8000 })
        .catch(() => null);

      /**
       * Constaté en production le 2026-09-24 (capture d'écran du VRAI FBI) :
       * un bouton "RECHERCHER" explicite valide le formulaire — `press
       * ("Enter")` seul ne suffit pas toujours à soumettre un formulaire
       * non natif (JS intercepté). Bouton en priorité, Entrée en repli.
       * Le texte du bouton réellement cliqué est ajouté à la trace (§
       * "Vingtième déclenchement", docs/FBI.md) : le dump des champs de
       * formulaire n'incluait pas les boutons, impossible de vérifier que
       * `searchSubmitControl` visait le bon.
       */
      const submit = selectors.searchSubmitControl(page).first();
      const submitCount = await submit.count().catch(() => 0);
      const submitText = submitCount > 0 ? ((await submit.textContent().catch(() => null))?.trim() ?? "?") : null;
      if (submitCount > 0) {
        await submit.click();
      } else {
        await input.press("Enter");
      }

      const dataTablesResponse = await dataTablesResponsePromise;

      /**
       * Attente réseau EN PLUS du délai fixe (§ "Vingtième déclenchement",
       * docs/FBI.md) : les noms de champs réels
       * (`identificationForm.identificationBean...`,
       * `rechercheRencontreSaisieResultatForm...`) évoquent une appli Java
       * legacy (JSF), où un bouton peut soumettre en AJAX (XHR patchant le
       * DOM en place, sans navigation ni changement d'URL) plutôt qu'en
       * rechargement de page classique — un délai fixe de 500ms pourrait
       * ne pas suffire à un aller-retour serveur réel en production.
       * Best-effort : `networkidle` peut ne jamais être atteint sur une
       * page avec du polling, d'où le timeout court et le `catch`.
       */
      await this.settle(page);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      /**
       * Si la réponse DataTables est arrivée APRÈS `networkidle` (elle
       * peut très bien suivre une pause réseau de 500ms puis reprendre),
       * laisse un court instant supplémentaire au rendu DOM de se faire
       * avant que `tryOpenMatchResult` ne lise le tableau.
       */
      if (dataTablesResponse) await this.settle(page);

      const urlAfter = page.url();
      const submitNote = submitText ? ` (bouton "${submitText}" cliqué)` : " (aucun bouton trouvé, Entrée pressée)";
      const networkNote =
        capturedRequests.length > 0
          ? ` — requêtes réseau capturées : ${capturedRequests.join(" || ")}`
          : " — aucune requête XHR/fetch/POST capturée après le clic (soumission peut-être purement côté client, ou non déclenchée)";
      return (
        (urlAfter === urlBefore
          ? `champ "${inputName}" rempli ("${matchNumber}") et recherche soumise${submitNote}, mais l'URL n'a pas changé (${urlAfter})`
          : `champ "${inputName}" rempli et recherche soumise${submitNote}, url → ${urlAfter}`) + networkNote
      );
    } catch (error) {
      return `champ de recherche "${inputName}" trouvé mais le remplissage/la soumission a échoué : ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      page.off("response", onResponse);
    }
  }

  private async tryOpenMatchResult(page: Page, matchNumber: string, division: string | null = null): Promise<{ trace: string; discoveredDocument: { url: string; fileName: string } | null }> {
    /**
     * Constaté en production le 2026-09-24 (capture d'écran du VRAI FBI
     * fournie par le club) : le tableau de résultats a une colonne "EM"
     * dédiée — un code cliquable ("DCBLRCA7"...) ou une icône "FDM" pour
     * une rencontre déjà jouée avec un e-Marque disponible, VIDE sinon.
     * `selectors.emarqueColumnLinkForMatch` localise CE lien précisément
     * (par libellé de colonne, jamais une position devinée) plutôt que le
     * générique "premier élément contenant ce numéro" d'avant (qui pouvait
     * cliquer n'importe quoi sur la ligne, jamais spécifiquement la
     * colonne e-Marque).
     */
    const emLink = await selectors.emarqueColumnLinkForMatch(page, matchNumber, division).catch(() => null);
    if (!emLink) {
      return {
        trace: `pas de lien e-Marque trouvé pour la rencontre "${matchNumber}" (colonne EM absente, ligne introuvable, ou colonne EM vide — match pas encore joué)`,
        discoveredDocument: null,
      };
    }

    const text = (await emLink.textContent().catch(() => null))?.trim() ?? "?";
    const urlBefore = page.url();

    /**
     * Constaté en production le 2026-09-24 (rencontre n°1481, § "Vingt-
     * huitième déclenchement", docs/FBI.md) : la capture réseau du clic sur
     * "Rechercher" (déclenchement précédent) a révélé que FBI utilise
     * DataTables (appel AJAX `action=executeRecherche`, réponse JSON
     * `aaData`) — et que le lien de la colonne EM n'est PAS un `<a href>`
     * classique mais `<a onclick="telechargerMatch('<token>','<idMatch>')">`
     * (aucun `href`). Le clic a bien lieu (trace confirmée), mais sans
     * changement d'URL ni lien de document détectable sur la page —
     * `telechargerMatch()` déclenche probablement un téléchargement natif
     * du navigateur (nom de fonction explicite), une popup, ou un appel
     * réseau qu'on ne capturait pas encore À CETTE étape précise (seule
     * `trySearchByMatchNumber` capturait le réseau jusqu'ici). Capture
     * maintenant aussi les événements `download`/`popup`, en plus du
     * réseau, autour de CE clic précis.
     */
    const capturedRequests: string[] = [];
    const onResponse = async (response: import("playwright-core").Response): Promise<void> => {
      try {
        const req = response.request();
        if (req.resourceType() !== "xhr" && req.resourceType() !== "fetch" && req.method() !== "POST") return;
        const postData = req.postData();
        const bodySnippet = await response.text().catch(() => null);
        capturedRequests.push(
          `${req.method()} ${response.url()} → HTTP ${response.status()}` +
            (postData ? ` | corps envoyé (${postData.length} car.) : ${postData.slice(0, 500)}` : " | aucun corps envoyé") +
            (bodySnippet ? ` | réponse (${bodySnippet.length} car.) : ${bodySnippet.slice(0, 1000)}` : " | réponse illisible"),
        );
      } catch {
        // Best effort.
      }
    };
    page.on("response", onResponse);

    /**
     * Diagnostic (§ 2026-09-30, job 3f0d54ad, match 312f32c0) : deux
     * fenêtres élargies (recherche par division, capture download/popup
     * 3s→10s) ont toutes deux échoué à faire apparaître le moindre
     * téléchargement/popup/XHR après le clic EM — le clic "réussit"
     * (aucune exception Playwright) mais `telechargerMatch()` ne produit
     * RIEN d'observable. Capture maintenant aussi les erreurs JS
     * (`pageerror`, ex: fonction non définie) et les messages console
     * autour de CE clic précis — jamais fait jusqu'ici, alors que le
     * "clic silencieux" est exactement la signature d'un gestionnaire
     * `onclick` qui lève une exception JS avalée par le navigateur.
     */
    const consoleMessages: string[] = [];
    const onConsole = (message: import("playwright-core").ConsoleMessage): void => {
      if (message.type() === "error" || message.type() === "warning") consoleMessages.push(`[${message.type()}] ${message.text()}`);
    };
    const pageErrors: string[] = [];
    const onPageError = (error: Error): void => {
      pageErrors.push(error.message);
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);

    /**
     * 10s (pas 3s) : revu à la hausse après un échec constaté en
     * production le 2026-09-30 (job 3f0d54ad, match 312f32c0) — le clic EM
     * a bien eu lieu (aucune erreur), mais ni téléchargement, ni popup, ni
     * requête XHR/fetch/POST n'a été capturé dans la fenêtre de 3s
     * d'alors. La trace de CE run montrait une activité réseau de fond
     * significative (widget tiers "Lemon Learning" embarqué sur FBI,
     * plusieurs appels `api.lemonlearning.com`/`player.lemonlearning.com`
     * juste avant le clic) qui a pu retarder l'exécution JS de
     * `telechargerMatch()` au-delà de 3s — et `page.waitForLoadState(
     * "networkidle", { timeout: 5000 })`, exécuté AVANT ce Promise.all,
     * peut lui-même consommer une bonne partie de ces 5s si ce widget
     * continue de faire du bruit réseau en tâche de fond, laissant encore
     * moins de marge réelle aux 3s d'alors. Manquer un téléchargement réel
     * coûte un job ENTIER (replanification + nouvelle connexion FBI
     * complète) — un délai plus généreux ici est largement rentable face à
     * ce coût, contrairement au raisonnement initial ("3s pas 8+").
     */
    const downloadPromise = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
    const popupPromise = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);

    try {
      /**
       * Timeout explicite et court (jamais les 30s par défaut de
       * Playwright) : constaté en écrivant les tests de ce correctif — un
       * élément sans dimensions visibles réelles (icône dépendant d'un CSS
       * absent) fait attendre `.click()` l'intégralité de son délai
       * d'actionabilité par défaut avant d'échouer, consommant un tiers du
       * budget d'un job entier pour un clic qui n'aboutira jamais.
       */
      await emLink.click({ timeout: 10000 });
      await this.settle(page);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

      const [download, popup] = await Promise.all([downloadPromise, popupPromise]);

      /**
       * Constaté en production le 2026-09-24 (rencontre n°1481, § "Vingt-
       * neuvième déclenchement", docs/FBI.md) : `download.url()` est une
       * VRAIE URL FBI ré-appelable via `context.request.get()` (mêmes
       * cookies de session, voir `downloadDocument()`), jamais un `blob:`
       * temporaire — le fichier réellement téléchargé par Playwright
       * lui-même (dans `/tmp` de @sparticuz/chromium) ne sert à rien ici
       * et est supprimé (best effort) pour ne pas polluer ce répertoire
       * éphémère entre deux clics EM d'une même invocation.
       */
      const discoveredDocument = download ? { url: download.url(), fileName: download.suggestedFilename() } : null;
      if (download) await download.delete().catch(() => {});

      const downloadNote = download ? ` — téléchargement natif déclenché : url=${download.url()}, nom suggéré="${download.suggestedFilename()}"` : "";
      const popupNote = popup ? ` — popup/nouvel onglet ouvert : url=${popup.url()}` : "";
      const networkNote =
        capturedRequests.length > 0
          ? ` — requêtes réseau capturées après le clic EM : ${capturedRequests.join(" || ")}`
          : " — aucune requête XHR/fetch/POST capturée après le clic EM";
      const pageErrorNote = pageErrors.length > 0 ? ` — erreurs JS après le clic EM : ${pageErrors.join(" || ")}` : "";
      const consoleNote = consoleMessages.length > 0 ? ` — messages console après le clic EM : ${consoleMessages.join(" || ")}` : "";

      const urlAfter = page.url();
      return {
        trace:
          (urlAfter === urlBefore ? `lien EM "${text}" cliqué, mais l'URL n'a pas changé (${urlAfter})` : `lien EM "${text}" cliqué, url → ${urlAfter}`) +
          downloadNote +
          popupNote +
          networkNote +
          pageErrorNote +
          consoleNote,
        discoveredDocument,
      };
    } catch (error) {
      return {
        trace: `lien EM "${text}" trouvé mais le clic a échoué : ${error instanceof Error ? error.message : String(error)}`,
        discoveredDocument: null,
      };
    } finally {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("response", onResponse);
    }
  }

  /**
   * Récupère TOUTES les rencontres du club listées par FBI (rapprochement
   * calendrier FFBB/FBI, voir docs/FBI.md) — pas une rencontre ciblée comme
   * `findEmarqueDocuments`. DEUX passes obligatoires : la case "non joué"
   * (cochée par défaut, voir `selectors.nonJoueCheckbox`) filtre à un SEUL
   * des deux états à la fois — cochée pour les rencontres à venir/résultat
   * pas encore saisi (confirmé le 2026-09-25 : le club a montré un listing
   * de rencontres FUTURES, scores tous vides, case cochée par défaut),
   * décochée pour les rencontres déjà jouées. Sans les deux passes, la
   * moitié du calendrier du club serait invisible au rapprochement.
   *
   * Recherche à NUMÉRO VIDE (jamais rempli, contrairement à
   * `trySearchByMatchNumber`) : renvoie alors TOUTES les rencontres du club
   * connecté, toutes divisions confondues — confirmé par la capture d'écran
   * fournie par le club (colonnes Division/N°/Equipe 1/Equipe 2/Date de
   * rencontre/Heure/Salle/EM/Score 1/Forfait 1, pagination "Précédent 1 2 3
   * 4 5 6 Suivant").
   */
  async fetchScheduleRows(session: BrowserFbiSession): Promise<FbiScheduleRow[]> {
    const { page } = session;
    const rawRows: Record<string, string>[] = [];

    for (const nonJoueChecked of [true, false]) {
      await this.trySetNonJoueAndSearch(page, nonJoueChecked);
      rawRows.push(...(await this.collectAllResultPages(page)).rows);
    }

    return rawRows.map(normalizeScheduleRow);
  }

  /**
   * Rejoint l'écran de recherche (état frais, sans filtre numéro ni
   * pagination résiduelle d'une passe précédente), règle la case "non
   * joué" sur l'état demandé, puis soumet une recherche à numéro vide.
   */
  private async trySetNonJoueAndSearch(page: Page, nonJoueChecked: boolean): Promise<void> {
    await this.tryNavigateToSearchScreen(page);

    try {
      const nonJoue = selectors.nonJoueCheckbox(page);
      if ((await nonJoue.count().catch(() => 0)) > 0) {
        const isChecked = await nonJoue.isChecked().catch(() => nonJoueChecked);
        if (isChecked !== nonJoueChecked) {
          if (nonJoueChecked) await nonJoue.check();
          else await nonJoue.uncheck();
        }
      }
    } catch {
      // Best effort — une case introuvable/impossible à régler ne doit
      // jamais empêcher la tentative de recherche (elle renverra alors la
      // page par défaut, mieux que rien).
    }

    try {
      const submit = selectors.searchSubmitControl(page).first();
      if ((await submit.count().catch(() => 0)) > 0) {
        await submit.click();
      }
      await this.settle(page);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    } catch {
      // Best effort — voir collectAllResultPages, qui renvoie []  si la
      // page courante n'a pas la forme d'un tableau de résultats.
    }
  }

  /**
   * Choisit la plus grande longueur de page disponible (ou "Tous"/`-1`)
   * sur le contrôle "Afficher X entrées" de DataTables (voir
   * `selectors.resultsLengthSelect`) — best effort, jamais bloquant.
   *
   * Constaté en production le 2026-09-27 (§ "Toujours incomplet malgré 5
   * pages", docs/FBI.md) : la pagination "Suivant" traverse bien 5 pages
   * RÉELLES (`pageCount: 5`), mais `rawRowCount` (97) très supérieur à
   * `keptRowCount` après dédoublonnage (51) — signe d'une pagination
   * "offset" côté serveur qui re-fenêtre/re-trie le jeu de résultats à
   * chaque page (tri non parfaitement déterministe), faisant apparaître
   * certaines lignes plusieurs fois et probablement en sauter d'autres.
   * Afficher TOUT en une seule page contourne entièrement cette
   * instabilité — plutôt qu'un onzième correctif sur la mécanique de clic
   * "Suivant" elle-même.
   */
  private async tryMaximizeResultsPageLength(page: Page): Promise<LengthSelectDiagnostic> {
    const diagnostic: LengthSelectDiagnostic = { found: false, selectId: null, optionValues: [], appliedValue: null };

    try {
      const lengthSelect = selectors.resultsLengthSelect(page);
      if ((await lengthSelect.count().catch(() => 0)) === 0) return diagnostic;

      diagnostic.found = true;
      diagnostic.selectId = await lengthSelect.getAttribute("id").catch(() => null);

      const options = lengthSelect.locator("option");
      const optionCount = await options.count().catch(() => 0);
      let bestValue: string | null = null;
      let bestRank = -Infinity;

      for (let i = 0; i < optionCount; i += 1) {
        const value = await options.nth(i).getAttribute("value").catch(() => null);
        if (value === null) continue;
        diagnostic.optionValues.push(value);
        const numeric = Number(value);
        // -1 est la convention DataTables pour "Tous" — toujours le plus grand.
        const rank = numeric === -1 ? Number.POSITIVE_INFINITY : numeric;
        if (Number.isNaN(rank)) continue;
        if (rank > bestRank) {
          bestRank = rank;
          bestValue = value;
        }
      }

      if (bestValue !== null) {
        await lengthSelect.selectOption({ value: bestValue }).catch(() => {});
        await this.settle(page);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        await this.waitForStableDerogationTable(page);
        diagnostic.appliedValue = bestValue;
      }
    } catch {
      // Best effort — voir la note ci-dessus.
    }

    return diagnostic;
  }

  /**
   * Parcourt toutes les pages du tableau de résultats courant ("Suivant",
   * voir `selectors.nextPageControl`), en s'arrêtant dès qu'un clic ne
   * change plus le contenu de la page (dernière page, contrôle inerte) —
   * jamais un nombre de pages supposé à l'avance, et jamais de boucle
   * infinie (`MAX_PAGES` en filet de sécurité). Tente d'abord d'afficher
   * TOUTES les lignes sur une seule page (voir
   * `tryMaximizeResultsPageLength`) — la pagination "Suivant" ci-dessous
   * ne sert alors que de repli si ce contrôle est absent/inefficace.
   */
  private async collectAllResultPages(page: Page): Promise<{ rows: Record<string, string>[]; pageCount: number }> {
    await this.tryMaximizeResultsPageLength(page);

    const MAX_PAGES = 50;
    const collected: Record<string, string>[] = [];
    let previousSignature: string | null = null;
    let pageCount = 0;

    for (let i = 0; i < MAX_PAGES; i += 1) {
      const rows = await selectors.resultsTableGenericRows(page).catch(() => null);
      const signature = JSON.stringify(rows);
      if (signature === previousSignature) break;
      previousSignature = signature;
      pageCount += 1;
      if (rows) collected.push(...rows);

      const next = selectors.nextPageControl(page).first();
      if ((await next.count().catch(() => 0)) === 0) break;
      /**
       * Constaté en écrivant les tests de `tryMaximizeResultsPageLength`
       * (2026-09-27) : une fois "Tous" sélectionné, DataTables MASQUE ses
       * contrôles de pagination (`.dataTables_paginate { display: none }`,
       * voir la fixture) — mais le `<a>` "Suivant" reste PRÉSENT dans le
       * DOM (juste invisible), donc `count()` ET `isEnabled()` restent
       * vrais. `.click()` sur un élément cliqué mais invisible attend que
       * Playwright le juge "actionnable" (visible ET stable ET activé) —
       * il ne le devient JAMAIS ici, bloquant chaque test pendant les 30s
       * du timeout d'actionabilité par défaut de Playwright (exactement le
       * symptôme observé : 3 tests `fetchAllDerogations` en échec à
       * 30000ms). Vérifier explicitement la VISIBILITÉ avant de cliquer,
       * jamais juste présence + activé.
       */
      if (!(await next.isVisible().catch(() => false))) break;
      if (!(await next.isEnabled().catch(() => false))) break;

      try {
        await next.click();
        await this.settle(page);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        // Même correctif que `collectAllDerogationsWithDetail` (voir
        // docs/FBI.md, § "La vraie cause : <a> sans href...") : attend que
        // le tableau se stabilise après CHAQUE clic "Suivant", jamais un
        // délai fixe supposé suffisant — cette méthode partage le même
        // `nextPageControl`/la même mécanique AJAX DataTables.
        await this.waitForStableDerogationTable(page);
      } catch {
        break;
      }
    }

    return { rows: collected, pageCount };
  }

  /**
   * Même mécanique de pagination que `collectAllResultPages`, mais pour
   * `fetchAllDerogations` : enrichit CHAQUE ligne de son détail (demandeur/
   * motif/dates demandées/réponse adversaire) AVANT de passer à la page
   * suivante — cinquième revirement (voir docs/FBI.md, § "Le détail
   * redevient nécessaire") : "on récupère plus le demandeur le motif,
   * l'heure la date etc" (constat club, 2026-09-27), régression directe du
   * quatrième revirement qui avait retiré tout détail par ligne du lot
   * pour éviter le timeout Vercel de 300s (`fetchScheduleRows`-like, sans
   * détail). Le détail reste indispensable à l'affichage — mais 80+
   * nouveaux onglets séquentiels dépassaient largement 300s à l'époque, EN
   * PLUS d'une pagination qui tournait alors en rond (voir `pageCount`).
   *
   * Maintenant que `tryMaximizeResultsPageLength` ramène (best effort)
   * tout sur UNE SEULE page — plus de 5 clics "Suivant" à plusieurs
   * secondes chacun avant même de commencer le détail —, le détail par
   * ligne redevient praticable dans le budget restant. Reste borné
   * explicitement par `detailDeadlineAt` (voir `derogationDetailBudgetMs`) :
   * dès qu'il est dépassé, les lignes restantes (de CETTE page ET des
   * pages suivantes, si `tryMaximizeResultsPageLength` a échoué) gardent
   * leurs champs de détail à `null` plutôt que de risquer un dépassement
   * dur du timeout Vercel — jamais une ligne perdue pour autant, juste son
   * détail (le tableau de résultats reste la source de vérité minimale,
   * même principe que `fetchDerogationDetailForRow`).
   *
   * Détail lu par INDEX DOM (`fetchDerogationDetailForRow`), jamais par
   * index dans le tableau normalisé/filtré — la ligne fantôme DataTables
   * ("Aucune donnée disponible...") ET les lignes "A Créer" comptent
   * quand même dans l'index DOM de la page courante.
   *
   * Href/idDerogation collectés PENDANT la pagination (lecture DOM rapide,
   * jamais de navigation), le détail lui-même récupéré dans une PASSE
   * SÉPARÉE une fois toutes les pages parcourues — demande du club,
   * 2026-09-27 : "la ligne en cours devrait aussi avoir son détail". Avant
   * ce correctif, le détail était fetché ligne par ligne DANS L'ORDRE DU
   * TABLEAU FBI ; si `detailDeadlineAt` était atteint en cours de route, les
   * lignes restantes perdaient leur détail au hasard de leur position dans
   * le tableau — constaté en production sur la rencontre n°15 : sa ligne
   * "En Cours" (la plus actionable, un dossier encore ouvert) n'avait
   * jamais eu son détail, pendant qu'une autre ligne déjà tranchée
   * ("Acceptée par l'organisme dirigeant") l'avait. La passe séparée
   * trie désormais les hrefs par PRIORITÉ avant de consommer le budget :
   * "En Cours" (dossier actionnable) d'abord, le reste ensuite — si le
   * budget doit sacrifier des lignes, ce sont les moins actionables qui
   * perdent leur détail en premier, jamais un tirage dépendant de l'ordre
   * FBI. `fetchDerogationDetailByHref` ouvre un onglet indépendant pour
   * chaque détail (jamais de dépendance à l'état de navigation de `page`),
   * ce qui rend cette séparation sûre.
   */
  private async collectAllDerogationPages(
    page: Page,
    scope: Page | Locator,
    detailDeadlineAt: number,
    options: FetchAllDerogationsOptions = {},
  ): Promise<{
    rows: FbiDerogationRow[];
    pageCount: number;
    rawRowCount: number;
    lengthSelect: LengthSelectDiagnostic;
    rawRowSample: Record<string, string>[];
    pageTitleAtFirstRead: string;
  }> {
    const lengthSelect = await this.tryMaximizeResultsPageLength(page);

    const MAX_PAGES = 50;
    const baseRows: { row: FbiDerogationRow; href: string | null }[] = [];
    let pageCount = 0;
    let rawRowCount = 0;

    let currentRows = await selectors.resultsTableGenericRows(scope).catch(() => null);
    let currentSignature = JSON.stringify(currentRows);
    /**
     * Échantillon des toutes premières lignes BRUTES lues (avant tout
     * filtrage/normalisation), persisté dans `passDiagnostics[0]` —
     * constaté en production le 2026-09-27 : une exécution a ramené
     * `rawRowCount: 3, keptRowCount: 0` (bien moins que les 51-97 connus,
     * ET aucune ligne gardée du tout) sans qu'on sache si ces 3 lignes
     * sont la ligne fantôme DataTables ("Aucune donnée disponible..."),
     * un tableau d'une AUTRE page (navigation dérivée), ou autre chose —
     * jamais deviné une seizième fois sans preuve directe du CONTENU réel.
     */
    const rawRowSample = (currentRows ?? []).slice(0, 3);
    const pageTitleAtFirstRead = await page.title().catch(() => "?");

    for (let i = 0; i < MAX_PAGES; i += 1) {
      pageCount += 1;

      if (currentRows) {
        rawRowCount += currentRows.length;

        for (let domIndex = 0; domIndex < currentRows.length; domIndex += 1) {
          const normalizedRow = normalizeDerogationRow(currentRows[domIndex]);
          // Ligne fantôme DataTables ("Aucune donnée disponible dans le
          // tableau") — jamais de détail à aller chercher pour elle.
          if (normalizedRow.numero === null) continue;

          // `href` lu UNE SEULE fois, réutilisé pour `idDerogation` (clé
          // stable de la ligne, § "82 vs 51" docs/FBI.md) ET pour le détail
          // — jamais deux requêtes DOM séparées pour la même information.
          const href = await this.derogationRowDetailHref(scope, domIndex);
          const idDerogation = href ? this.parseIdDerogation(href, page.url()) : null;
          const rowWithId: FbiDerogationRow = { ...normalizedRow, idDerogation };
          baseRows.push({ row: rowWithId, href });
        }
      }

      const next = selectors.nextPageControl(page).first();
      if ((await next.count().catch(() => 0)) === 0) break;
      if (!(await next.isVisible().catch(() => false))) break;
      if (!(await next.isEnabled().catch(() => false))) break;

      try {
        await next.click();
        await this.settle(page);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      } catch {
        break;
      }

      const advanced = await this.waitForDerogationTableRefresh(scope, currentSignature);
      if (advanced === null) break; // Dernière page RÉELLEMENT atteinte — voir sa doc.
      currentRows = advanced;
      currentSignature = JSON.stringify(advanced);
    }

    // "En Cours" (dossier réellement actionnable) traité en premier — voir
    // la doc de cette méthode. `stable` : `Array.prototype.sort` est stable
    // depuis longtemps en V8/Node, l'ordre FBI d'origine est préservé au
    // sein d'un même niveau de priorité.
    const detailPriority = (row: FbiDerogationRow): number => (row.etat === "En Cours" ? 0 : 1);
    const orderedForDetail = [...baseRows].sort((a, b) => detailPriority(a.row) - detailPriority(b.row));

    /**
     * Détail lu UNIQUEMENT pour les dérogations nouvelles ou modifiées
     * (`options.needsDetail`, décidé par l'appelant à partir de ce qui est
     * déjà en base) — un club qui démarre de zéro les lit toutes, un club
     * déjà à jour ne rouvre que ce qui a bougé. Un seul onglet réutilisé,
     * une pause entre deux pages, et arrêt immédiat si FBI cesse de
     * répondre (2026-10-07 : ~85 onglets d'affilée, puis plus aucune
     * réponse de FBI à cette adresse) — jamais d'insistance.
     */
    const needsDetail = options.needsDetail ?? (() => true);
    const toFetch = orderedForDetail.filter(({ row, href }) => href && needsDetail(row));
    const uniqueHrefs = Array.from(new Set(toFetch.map(({ href }) => href!)));
    const detailByHref = new Map<string, FbiDerogationDetailFields | null>();
    let detailPage: Page | null = null;
    let consecutiveFailures = 0;
    this.lastDerogationDetailStats = { toFetch: uniqueHrefs.length, fetched: 0, failed: 0, skippedUnchanged: baseRows.length - toFetch.length, stoppedEarly: null };
    try {
      for (const [index, href] of uniqueHrefs.entries()) {
        if (Date.now() >= detailDeadlineAt) {
          this.lastDerogationDetailStats.stoppedEarly = "budget";
          break;
        }
        if (index > 0 && this.derogationDetailPauseMs > 0) await new Promise((resolve) => setTimeout(resolve, this.derogationDetailPauseMs));
        detailPage ??= await page.context().newPage();
        const detail = await this.readDerogationDetail(detailPage, page.url(), href);
        detailByHref.set(href, detail);
        if (detail && !this.lastDerogationDetailStats.pageShape) {
          this.lastDerogationDetailStats.pageShape = await selectors.derogationDetailShape(detailPage).catch(() => null);
        }
        if (detail) {
          this.lastDerogationDetailStats.fetched += 1;
          consecutiveFailures = 0;
        } else {
          this.lastDerogationDetailStats.failed += 1;
          consecutiveFailures += 1;
        }
        options.onDetailProgress?.(index + 1, uniqueHrefs.length);
        if (consecutiveFailures >= 3) {
          this.lastDerogationDetailStats.stoppedEarly = "fbi_ne_repond_plus";
          break;
        }
      }
    } finally {
      if (detailPage) await detailPage.close().catch(() => {});
    }

    const collected = baseRows.map(({ row, href }) => {
      const detail = href ? (detailByHref.get(href) ?? null) : null;
      return detail ? { ...row, ...detail } : row;
    });

    return { rows: collected, pageCount, rawRowCount, lengthSelect, rawRowSample, pageTitleAtFirstRead };
  }

  /**
   * Attend que le tableau change RÉELLEMENT de contenu après une action
   * (clic "Suivant" OU soumission d'une recherche) — jamais juste "cette
   * lecture diffère de la lecture d'AVANT l'action", qui confond deux
   * causes très différentes : un résultat VRAIMENT inchangé (dernière
   * page, ou — jamais rencontré en pratique, une vraie recherche vide
   * inclut toujours la ligne fantôme "Aucune donnée disponible", donc
   * TOUJOURS un contenu différent de l'écran pré-recherche) et un AJAX
   * simplement LENT côté vrai FBI (le tableau affiche encore l'ANCIEN
   * état au moment de la lecture, pas encore rafraîchi).
   *
   * Constaté en production le 2026-09-27 (§ "Toujours 51...", docs/FBI.md) :
   * `passDiagnostics[0].pageCount` variait de 1 à 5 D'UNE EXÉCUTION À
   * L'AUTRE pour EXACTEMENT le même club/jeu de dérogations réel après un
   * clic "Suivant" — signe que l'ancienne détection (`collectAllDerogationPages`
   * lisait une fois, comparait à la lecture de l'itération PRÉCÉDENTE,
   * s'arrêtait dès qu'elles étaient égales) s'arrêtait parfois AVANT que
   * l'AJAX ait fini de rafraîchir le tableau.
   *
   * **Même bug retrouvé à la soumission INITIALE** (§ "Rencontre 23
   * uniquement, round suivant", docs/FBI.md, 2026-09-27) : une fois le
   * champ "Numéro de rencontre" vidé explicitement (round précédent), la
   * recherche "tous les numéros" est nécessairement plus LENTE côté
   * serveur qu'une recherche filtrée sur UN SEUL numéro (davantage de
   * lignes à préparer) — `waitForStableDerogationTable` (comparaison
   * naïve, sans référence à l'état PRÉ-soumission) a alors pu se
   * "stabiliser" sur l'écran encore VIDE (avant tout résultat), donnant
   * `rawRowCount: 0` alors que la recherche était censée tout ramener.
   * Utilisée maintenant aussi pour la soumission initiale
   * (`fetchAllDerogations`/`fetchDerogationForMatch`), pas seulement la
   * pagination.
   *
   * Repolle jusqu'à `maxAttempts` fois une lecture qui diffère de
   * `previousSignature` (l'état d'AVANT l'action) ET qui se STABILISE
   * (deux lectures consécutives identiques) — renvoie ces lignes dès
   * qu'elles le sont. `null` uniquement si le contenu n'a JAMAIS changé
   * après `maxAttempts` tentatives (dernière page réellement atteinte, ou
   * AJAX qui n'a jamais répondu) — l'appelant reste libre de continuer
   * avec l'état lu par ailleurs plutôt que de planter, best effort.
   */
  private async waitForDerogationTableRefresh(
    scope: Page | Locator,
    previousSignature: string | null,
    maxAttempts = 15,
    intervalMs = this.navigationSettleMs,
  ): Promise<Record<string, string>[] | null> {
    let lastSignature: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const rows = await selectors.resultsTableGenericRows(scope).catch(() => null);
      const signature = JSON.stringify(rows);

      if (signature !== previousSignature && signature === lastSignature) {
        return rows;
      }

      lastSignature = signature;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return null;
  }

  /**
   * Résout le VRAI conteneur des résultats de dérogations — voir
   * `selectors.derogationResultsContainer` (§ "jen ai que 8", docs/FBI.md,
   * 2026-09-27) : `id="rechercherDerogationAjax"`/`"..._wrapper"`,
   * déduit de l'`aria-controls` confirmé réel du bouton "Suivant", jamais
   * `getTableauDerogation` (une supposition antérieure jamais confirmée).
   *
   * Repli sur `page` ENTIÈRE (comportement d'avant ce round) si ce
   * conteneur n'est trouvé nulle part — jamais un échec dur, mais
   * `derogationContainerFound: false` dans le diagnostic signale alors
   * que cette hypothèse d'id doit être reconfirmée sur preuve plutôt que
   * de continuer à deviner un vingt-et-unième correctif.
   */
  /** `resolveDerogationScope` répété jusqu'à ce que le conteneur apparaisse (même borne que `waitForDerogationTableRefresh`), repli sur la page entière sinon. */
  private async waitForDerogationScope(page: Page): Promise<{ scope: Page | Locator; found: boolean }> {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const resolved = await this.resolveDerogationScope(page);
      if (resolved.found) return resolved;
      await new Promise((resolve) => setTimeout(resolve, this.navigationSettleMs));
    }
    return this.resolveDerogationScope(page);
  }

  /**
   * Description des tableaux présents sur la page (id, classe, en-têtes,
   * nombre de lignes) — preuve directe de CE qui a été lu quand la lecture
   * échoue, jamais une hypothèse de plus. Uniquement des libellés de
   * colonnes et des compteurs, aucune donnée de ligne.
   */
  private async describeTables(page: Page): Promise<Array<{ id: string; className: string; headers: string[]; bodyRows: number }>> {
    const tables = page.locator("table");
    const count = Math.min(await tables.count().catch(() => 0), 8);
    const described: Array<{ id: string; className: string; headers: string[]; bodyRows: number }> = [];
    for (let i = 0; i < count; i += 1) {
      const table = tables.nth(i);
      described.push({
        id: (await table.getAttribute("id").catch(() => null)) ?? "",
        className: ((await table.getAttribute("class").catch(() => null)) ?? "").slice(0, 80),
        headers: (await table.locator("th").allTextContents().catch(() => [])).map((t) => t.trim().slice(0, 40)).slice(0, 16),
        bodyRows: await table.locator("tbody tr").count().catch(() => 0),
      });
    }
    return described;
  }

  private async resolveDerogationScope(page: Page): Promise<{ scope: Page | Locator; found: boolean }> {
    const container = selectors.derogationResultsContainer(page);
    const found = (await container.count().catch(() => 0)) > 0;
    return { scope: found ? container : page, found };
  }

  /**
   * Consulte l'état de la dérogation d'UN match, par numéro de rencontre —
   * URL confirmée par capture d'écran du VRAI FBI le 2026-09-25 (le club a
   * copié l'URL depuis sa barre d'adresse) : `rechercherDerogation.fbi`
   * pour la recherche, `afficherDerogation.fbi?idDerogation=0&idRencontre=<jeton>`
   * pour le détail d'une dérogation précise (jeton opaque, RENVOYÉ par la
   * page de résultats — jamais construit ici, voir §Ce qui n'est pas fait).
   *
   * "faudra utiliser la recherche par numéro de rencontre, car on l'a déjà
   * et c'est bcp + simple" (demande du club) — recherche donc DIRECTEMENT
   * par numéro. LECTURE SEULE : cette méthode ne fait QUE consulter
   * (jamais soumettre/modifier une dérogation) — mais clique désormais
   * dans le détail de la ligne trouvée pour en ramener le motif, la
   * date/heure demandées et la réponse de l'adversaire (demande du club,
   * 2026-09-25 : "il me faut du détail sur le motif... les dates
   * initiales et demandées... comme sur fbi", voir `fetchDerogationDetailForRow`).
   *
   * `division` (§ "82 vs 51", docs/FBI.md, 2026-09-27, capture d'écran du
   * club) désambiguïse un numéro de rencontre qui n'est PAS unique au
   * club : le même numéro peut exister dans PLUSIEURS divisions
   * distinctes (ex: "23" en BU11FN23 ET en BU11MN2). `null`/omis : compare
   * seulement le numéro, comme avant (repli best-effort si la division du
   * match appelant est inconnue) — risque alors une rencontre confondue
   * avec une autre division partageant le même numéro, jamais un plantage.
   *
   * Une même rencontre (numéro + division) peut ELLE-MÊME avoir plusieurs
   * dérogations distinctes (dates de dépôt différentes, jusqu'à 8 pour une
   * seule rencontre côté club) — garde alors la plus RÉCENTE
   * (`compareDerogationDateDepot`), jamais une ligne arbitraire.
   *
   * Boucle sur `DEROGATION_ETAT_PASSES` (une seule passe "TT" depuis le
   * retour à une seule passe, voir sa doc) — la structure en boucle est
   * conservée pour rester symétrique avec `fetchAllDerogations`.
   */
  async fetchDerogationForMatch(session: BrowserFbiSession, matchNumber: string, division: string | null = null): Promise<FbiDerogationRow | null> {
    const { page } = session;

    for (const pass of DEROGATION_ETAT_PASSES) {
      await this.navigateToDerogationSearchScreen(page);

      const numeroInput = await selectors.matchNumberSearchInput(page);
      if (!numeroInput) {
        throw new FbiError(
          `Champ "Numéro de rencontre" introuvable sur l'écran de recherche des dérogations (${this.baseUrl}/rechercherDerogation.fbi).`,
          "NAVIGATION_FAILED",
        );
      }

      const { scope } = await this.resolveDerogationScope(page);
      const preSubmitSignature = JSON.stringify(await selectors.resultsTableGenericRows(scope).catch(() => null));

      try {
        await numeroInput.fill(matchNumber);
        const submit = selectors.searchSubmitControl(page).first();
        if ((await submit.count().catch(() => 0)) > 0) await submit.click();
        else await numeroInput.press("Enter");
        await this.settle(page);
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        await this.waitForDerogationTableRefresh(scope, preSubmitSignature);
      } catch (error) {
        throw new FbiError(
          `Recherche de dérogation échouée pour la rencontre ${matchNumber} (état ${pass}) : ${error instanceof Error ? error.message : String(error)}`,
          "NAVIGATION_FAILED",
          error,
        );
      }

      const rows = await selectors.resultsTableGenericRows(scope);
      if (!rows || rows.length === 0) continue;

      const normalized = rows.map(normalizeDerogationRow);
      // Comparaison EXACTE du numéro (ET de la division si connue) —
      // jamais la première ligne supposée correcte (même prudence que
      // `matchNumberInResultsTable` côté découverte e-Marque : une
      // recherche mal filtrée pourrait renvoyer d'autres rencontres).
      const matchIndices = normalized.reduce<number[]>((acc, row, index) => {
        if (row.numero === matchNumber && (division === null || row.division === division)) acc.push(index);
        return acc;
      }, []);
      if (matchIndices.length === 0) continue;

      // Priorité à "En Cours" (dossier réellement actionnable) sur tout
      // état déjà tranché, MÊME avec un `dateDepot` plus ancien — demande
      // du club, 2026-09-27 : "si ya accepté + en cours, c'est le en cours
      // qui prend le dessus" (même règle que le badge de la liste des
      // matchs et `GET .../matches/:matchId/derogation`). `dateDepot` ne
      // départage plus qu'ENTRE deux lignes de même "niveau" (deux "En
      // Cours", ou aucune des deux).
      const bestIndex = matchIndices.reduce((best, current) => {
        const bestEnCours = normalized[best].etat === "En Cours";
        const currentEnCours = normalized[current].etat === "En Cours";
        if (currentEnCours !== bestEnCours) return currentEnCours ? current : best;
        return compareDerogationDateDepot(normalized[current].dateDepot, normalized[best].dateDepot) >= 0 ? current : best;
      });

      const href = await this.derogationRowDetailHref(scope, bestIndex);
      const idDerogation = href ? this.parseIdDerogation(href, page.url()) : null;
      const rowWithId: FbiDerogationRow = { ...normalized[bestIndex], idDerogation };
      const detail = href ? await this.fetchDerogationDetailByHref(page, href).catch(() => null) : null;
      return detail ? { ...rowWithId, ...detail } : rowWithId;
    }

    return null;
  }

  /**
   * "je veux un bouton global qui check toutes les demandes, pas match par
   * match" (demande du club, 2026-09-25) — recherche à NUMÉRO VIDE (jamais
   * rempli, contrairement à `fetchDerogationForMatch`) : renvoie alors
   * TOUTES les dérogations du club connecté. UNE SEULE connexion FBI pour
   * tout le club, jamais une boucle de connexions par match (déjà à
   * l'origine d'un blocage anti-bot par le passé pour `discover_emarque`,
   * voir ProcessFbiJobsButton.tsx côté ball-manager-web).
   *
   * **PAS de détail par ligne ici** (motif/dates demandées/réponse
   * adversaire) — quatrième revirement (voir docs/FBI.md, "La vraie
   * pagination" et "Timeout Vercel") : une fois `nextPageControl`
   * corrigé, la pagination traverse enfin RÉELLEMENT les ~5 pages
   * (80+ dérogations, confirmées par le club) — mais `collectAllDerogationsWithDetail`
   * ouvre un second onglet PAR LIGNE pour son détail, et 80+ onglets
   * séquentiels dépassent largement les 300s de timeout d'une Vercel
   * Function ("Fais le de la meme facon quon a vérifié tous les matchs
   * prévus fbi pour comparer a ffbb, ca doit pas bloquer", demande du
   * club) — `fetchScheduleRows` (rapprochement calendrier FFBB/FBI) ne
   * fait QUE lire le tableau, jamais de détail par ligne, et n'a jamais eu
   * ce problème même sur un calendrier de plusieurs centaines de
   * rencontres.
   *
   * **Le détail redevient nécessaire — cinquième revirement** (voir
   * docs/FBI.md) : "on récupère plus le demandeur le motif, l'heure la
   * date etc" (constat club, 2026-09-27) — `DerogationsList.tsx` (ball-manager-web)
   * affiche ces champs pour CHAQUE dérogation, jamais seulement au clic
   * "Vérifier sur FBI" d'un match précis. Les retirer du lot a réglé le
   * timeout mais cassé l'affichage pour toutes les lignes d'un coup — un
   * échange inacceptable. `collectAllDerogationPages` (générique,
   * pagination + détail par ligne, borné par `derogationDetailBudgetMs`)
   * remplace `collectAllResultPages` ici : maintenant que
   * `tryMaximizeResultsPageLength` ramène tout sur UNE SEULE page (plus de
   * 5 clics "Suivant" qui, EUX, causaient l'essentiel du dépassement de
   * 300s), le détail par ligne redevient praticable dans le budget
   * restant — jamais un nombre de lignes supposé à l'avance, voir sa doc
   * pour le détail du compromis.
   */
  async fetchAllDerogations(session: BrowserFbiSession, options: FetchAllDerogationsOptions = {}): Promise<FbiDerogationRow[]> {
    const { page } = session;
    this.lastDerogationPassDiagnostics = [];

    await this.navigateToDerogationSearchScreen(page);

    const selectedEtatValueAtSubmit = await page
      .locator('select[name*="etat" i]')
      .first()
      .inputValue()
      .catch(() => null);

    /**
     * Vide EXPLICITEMENT "Numéro de rencontre" avant de soumettre — dix-
     * huitième round (2026-09-27, docs/FBI.md § "Toujours 51..." →
     * "Rencontre 23 uniquement") : une exécution a ramené `matched: 8,
     * rawRowCount: 11` — TOUTES pour la rencontre "23" (2 divisions),
     * alors que le champ n'est JAMAIS rempli par cette méthode (recherche
     * "à numéro VIDE", voir sa doc). Preuve corrélée en base : deux jobs
     * `check_derogation` pour CETTE MÊME rencontre "23" (2026-09-25,
     * `fetchDerogationForMatch` REMPLIT le champ) — signe que le VRAI FBI
     * retient la dernière valeur soumise pour ce compte CÔTÉ SERVEUR,
     * jamais réinitialisée par un nouveau login/BrowserContext (jamais
     * supposé avant ce round : `fetchAllDerogations` comptait sur un champ
     * "vide par défaut" après navigation, qui ne l'est PAS toujours en
     * pratique). Ne JAMAIS dépendre d'un état ambiant supposé quand on
     * peut l'imposer explicitement — vidé ici avant CHAQUE soumission,
     * quelle que soit sa valeur de départ.
     */
    const numeroInput = await selectors.matchNumberSearchInput(page);
    const numeroValueBeforeClear = numeroInput ? await numeroInput.inputValue().catch(() => null) : null;
    if (numeroInput) await numeroInput.fill("").catch(() => {});

    /**
     * Résolu AVANT la soumission — vingtième round (2026-09-27, docs/FBI.md
     * § "jen ai que 8") : `page.locator("table ...")` (utilisé partout
     * jusqu'ici) matche N'IMPORTE QUEL `<table>` de TOUTE la page, jamais
     * scopé au VRAI tableau de résultats — cause confirmée d'une lecture
     * de "3 lignes" ne correspondant à AUCUNE colonne attendue (un
     * tableau SANS RAPPORT ailleurs sur la page, lu tant que le vrai
     * tableau de résultats n'avait pas encore de lignes). Voir
     * `resolveDerogationScope`/`selectors.derogationResultsContainer`.
     */
    const { scope: preSubmitScope } = await this.resolveDerogationScope(page);

    // État du tableau AVANT la soumission — voir `waitForDerogationTableRefresh` :
    // une recherche "tous les numéros" est nécessairement plus LENTE côté
    // serveur qu'une recherche filtrée sur un seul numéro, la comparaison
    // doit donc attendre un changement RÉEL, jamais juste une stabilisation
    // qui pourrait se figer sur cet état PRÉ-soumission.
    const preSubmitSignature = JSON.stringify(await selectors.resultsTableGenericRows(preSubmitScope).catch(() => null));

    try {
      const submit = selectors.searchSubmitControl(page).first();
      if ((await submit.count().catch(() => 0)) > 0) await submit.click();
      await this.settle(page);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await this.waitForDerogationTableRefresh(preSubmitScope, preSubmitSignature);
    } catch (error) {
      throw new FbiError(
        `Recherche de toutes les dérogations du club échouée : ${error instanceof Error ? error.message : String(error)}`,
        "NAVIGATION_FAILED",
        error,
      );
    }

    /**
     * Conteneur des résultats résolu APRÈS la soumission (2026-10-07) : le
     * tableau DataTables `#rechercherDerogationAjax` n'existe qu'une fois
     * les résultats chargés — résolu avant, il n'était jamais trouvé
     * (`derogationContainerFound: false` à CHAQUE exécution connue) et la
     * lecture retombait sur la page entière. Constaté ce jour depuis le
     * worker local : 3 lignes lues, toutes vides (`rawRowSample: [{}, {},
     * {}]`), 0 dérogation alors que 84 sont connues.
     */
    const { scope, found: derogationContainerFound } = await this.waitForDerogationScope(page);
    const tableDiagnostic = await this.describeTables(page);

    const detailDeadlineAt = Date.now() + this.derogationDetailBudgetMs;
    const { rows: normalized, pageCount, rawRowCount, lengthSelect, rawRowSample, pageTitleAtFirstRead } = await this.collectAllDerogationPages(page, scope, detailDeadlineAt, options);
    // `collectAllDerogationPages` filtre déjà la ligne fantôme DataTables
    // ("Aucune donnée disponible dans le tableau", voir docs/FBI.md) —
    // une VRAIE dérogation a toujours un numéro de rencontre, jamais `null`.

    /**
     * Dédoublonnage — CINQUIÈME correction de cette clé (§ "82 vs 51",
     * docs/FBI.md, 2026-09-27, preuve directe par export Excel du club) :
     * `numero` n'identifie NI une dérogation unique (une même rencontre
     * peut légitimement en avoir plusieurs — jusqu'à 8 pour la rencontre
     * n°23 côté club, dates de dépôt différentes) NI même une rencontre
     * unique au club (le même numéro existe dans plusieurs divisions
     * distinctes, ex: "23" en BU11FN23 ET en BU11MN2). Dédoublonner par
     * `numero` écrasait donc à tort de VRAIES dérogations différentes —
     * cause racine du blocage à 51 alors que le club en attend 82.
     *
     * `idDerogation` (jeton du lien de détail, voir son type) est LA clé
     * stable d'une VRAIE dérogation FBI — ne sert plus qu'à absorber les
     * VRAIS doublons de lecture (une page relue deux fois, voir `pageCount`
     * ci-dessous), jamais des dérogations réellement distinctes. Une ligne
     * sans `idDerogation` (lien introuvable, best effort) n'est JAMAIS
     * déduite avec une autre — gardée telle quelle plutôt que risquer de
     * perdre une VRAIE dérogation sous une clé de repli approximative.
     */
    const deduped = new Map<string, FbiDerogationRow>();
    const kept: FbiDerogationRow[] = [];
    for (const row of normalized) {
      if (!row.idDerogation) {
        kept.push(row);
        continue;
      }
      const existing = deduped.get(row.idDerogation);
      if (!existing || (!existing.demandeur && row.demandeur)) deduped.set(row.idDerogation, row);
    }
    kept.push(...deduped.values());
    const result = kept;

    this.lastDerogationPassDiagnostics.push({
      pass: "tousLesEtats",
      selectedEtatValueAtSubmit,
      rawRowCount,
      keptRowCount: result.length,
      pageCount,
      lengthSelect,
      pageTitleAtFirstRead,
      rawRowSample,
      numeroValueBeforeClear,
      derogationContainerFound,
      tables: tableDiagnostic,
    });

    return result;
  }

  /**
   * Extrait le jeton `idDerogation` du `href` de détail d'une ligne — voir
   * `FbiDerogationRow.idDerogation` (types.ts). `href` est souvent
   * RELATIF (`afficherDerogation.fbi?idDerogation=...`), d'où `baseUrl`
   * (toujours `page.url()` chez les appelants) pour le résoudre en URL
   * absolue avant de lire ses paramètres — jamais un `split("=")` fragile
   * sur la chaîne brute (le jeton peut lui-même contenir des caractères
   * encodés, ex: `%2B`).
   */
  private parseIdDerogation(href: string, baseUrl: string): string | null {
    try {
      return new URL(href, baseUrl).searchParams.get("idDerogation");
    } catch {
      return null;
    }
  }

  /**
   * `href` du lien de détail (`afficherDerogation.fbi?idDerogation=...`)
   * porté par CHAQUE cellule de donnée de la ligne — confirmé par le HTML
   * source réel d'une ligne fourni par le club le 2026-09-25. La 1ère
   * colonne est une checkbox (jamais un lien, voir la fixture), d'où
   * `a[href]` cherché sur la ligne entière plutôt qu'une cellule précise —
   * n'importe quelle cellule de donnée porte le même `href`.
   */
  private async derogationRowDetailHref(scope: Page | Locator, rowIndex: number): Promise<string | null> {
    const row = scope.locator("table tbody tr").nth(rowIndex);
    if ((await row.count().catch(() => 0)) === 0) return null;

    const link = row.locator('a[href*="afficherDerogation"]').first();
    if ((await link.count().catch(() => 0)) === 0) return null;

    return await link.getAttribute("href").catch(() => null);
  }

  /**
   * Ouvre `href` dans un NOUVEL onglet du même `BrowserContext` (mêmes
   * cookies de session, aucune reconnexion) — jamais la page principale —
   * lit son détail, puis ferme l'onglet. Best effort intégral : la page
   * principale (son URL, son tableau, sa pagination) n'est JAMAIS touchée
   * par cette méthode, qu'elle réussisse ou échoue.
   */
  /** Lit le détail d'une dérogation dans l'onglet de détail RÉUTILISÉ (voir `collectAllDerogationPages`), délai court : jamais d'attente prolongée sur un FBI muet. */
  private async readDerogationDetail(detailPage: Page, baseUrl: string, href: string): Promise<FbiDerogationDetailFields | null> {
    try {
      await detailPage.goto(new URL(href, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await this.settle(detailPage);
      return await selectors.derogationDetailFields(detailPage).catch(() => null);
    } catch {
      return null;
    }
  }

  getLastDerogationDetailStats(): DerogationDetailStats | null {
    return this.lastDerogationDetailStats;
  }

  private async fetchDerogationDetailByHref(page: Page, href: string): Promise<FbiDerogationDetailFields | null> {
    let detailPage: Page | null = null;
    try {
      const absoluteUrl = new URL(href, page.url()).toString();
      detailPage = await page.context().newPage();
      await detailPage.goto(absoluteUrl, { waitUntil: "domcontentloaded" });
      await this.settle(detailPage);
      return await selectors.derogationDetailFields(detailPage).catch(() => null);
    } catch {
      return null;
    } finally {
      if (detailPage) await detailPage.close().catch(() => {});
    }
  }

  /**
   * ÉCRIT réellement sur FBI — soumet Accepter/Refuser pour une dérogation
   * "En Cours" attendant la réponse du club (voir `action-required.ts`).
   * "voici les boutons a utiliser pour accetper ou refuser" (demande du
   * club, 2026-09-27, HTML source réel de `afficherDerogation.fbi` fourni
   * pour la rencontre 9538) : le champ réel n'est PAS `input#acceptation`
   * (ça, c'est l'affichage EN LECTURE SEULE utilisé côté demandeur, déjà
   * lu par `selectors.derogationDetailFields`) mais un
   * `<select name="derogationForm.derogationReponseAdversaireBean.acceptation">`
   * ("P"=NC / "N"=Refusée / "O"=Acceptée), avec
   * `<textarea name="....motifRefus">` ACTIVABLE (jamais `readonly` ici,
   * contrairement à l'affichage) pour le motif de refus. Ciblé par `name`
   * exact, jamais par un id générique — les deux formes (lecture seule vs
   * réponse attendue) coexistent potentiellement sur des pages structurées
   * autrement selon l'état réel côté FBI.
   *
   * Le clic "Enregistrer" (`enregistrerDerogationAjax()`, JS réel de la
   * page) sérialise le formulaire et POST en AJAX vers
   * `enregistrerDerogation.fbi` ; en cas de succès la page NAVIGUE vers
   * `rechercherDerogation.fbi` (`retourArriere()`) — jamais un simple
   * changement de DOM sur place. Détecté ici par un changement d'URL après
   * le clic, jamais deviné : en l'absence de navigation ET d'erreur
   * visible dans le délai imparti, retourne `unknown` (jamais `success`
   * sans preuve, vu l'enjeu réel d'une soumission FFBB non annulable
   * depuis cet outil).
   */
  async respondToDerogation(
    session: BrowserFbiSession,
    idDerogation: string,
    decision: DerogationResponseDecision,
    motifRefus: string | null,
  ): Promise<DerogationResponseOutcome> {
    const { page } = session;

    const url = new URL("afficherDerogation.fbi", `${this.baseUrl}/`);
    url.searchParams.set("idDerogation", idDerogation);

    try {
      await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
      await this.settle(page);
    } catch (error) {
      throw new FbiError(`Page de dérogation FBI injoignable pour idDerogation=${idDerogation}.`, "NAVIGATION_FAILED", error);
    }

    const marker = page.locator("input#demandeurLibelle");
    if ((await marker.count().catch(() => 0)) === 0) {
      return { outcome: "unknown", message: "Page de détail FBI introuvable ou de forme inattendue pour cette dérogation (idDerogation peut-être périmé)." };
    }

    const acceptationSelect = page.locator('select[name="derogationForm.derogationReponseAdversaireBean.acceptation"]').first();
    if ((await acceptationSelect.count().catch(() => 0)) === 0) {
      return {
        outcome: "unknown",
        message: "Champ de décision introuvable sur la page FBI — cette dérogation n'attend peut-être plus de réponse du club (déjà répondue, ou c'est le club qui est demandeur).",
      };
    }

    try {
      await acceptationSelect.selectOption({ value: decision === "accepted" ? "O" : "N" });

      if (decision === "refused") {
        const motifField = page.locator('textarea[name="derogationForm.derogationReponseAdversaireBean.motifRefus"]').first();
        if ((await motifField.count().catch(() => 0)) === 0) {
          return { outcome: "unknown", message: "Champ motif de refus introuvable sur la page FBI." };
        }
        await motifField.fill(motifRefus ?? "");
      }
    } catch (error) {
      return { outcome: "unknown", message: `Impossible de renseigner la décision sur le formulaire FBI : ${error instanceof Error ? error.message : String(error)}` };
    }

    const saveButton = page.locator("button.boutonEnregistrer").first();
    if ((await saveButton.count().catch(() => 0)) === 0) {
      return { outcome: "unknown", message: "Bouton d'enregistrement introuvable sur la page FBI." };
    }

    const beforeUrl = page.url();
    try {
      await saveButton.click();
    } catch (error) {
      return { outcome: "unknown", message: `Le clic sur "Enregistrer" a échoué : ${error instanceof Error ? error.message : String(error)}` };
    }

    // 45s (pas 20s) — constaté en production le 2026-09-28 (rencontre 9538) :
    // l'enregistrement avait RÉELLEMENT réussi sur FBI (confirmé par le club
    // en consultant FBI directement), mais renvoyé `outcome: "unknown"` —
    // `enregistrerDerogationAjax()` (POST + navigation `retourArriere()`) a
    // dû dépasser 20s ce jour-là, jamais une preuve que la navigation
    // n'arrive pas, juste qu'elle peut être plus lente que prévu.
    const navigatedAway = await page
      .waitForURL((candidate) => candidate.toString() !== beforeUrl, { timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    if (navigatedAway) return { outcome: "success" };

    // Pas de navigation : `enregistrerDerogationAjax()` (JS réel de la
    // page) appelle `afficherErreur(request)` sur échec, dont le contenu
    // contient littéralement `<ul class="errorMessage">` (vérifié dans le
    // check JS du bouton "précédente/suivante" de la même page) — cherché
    // ici dans le DOM après le clic, jamais un texte d'erreur deviné.
    const errorLocator = page.locator("ul.errorMessage").first();
    if ((await errorLocator.count().catch(() => 0)) > 0) {
      const text = (await errorLocator.innerText().catch(() => "")).trim();
      return { outcome: "error", message: text.length > 0 ? text : "FBI a rejeté l'enregistrement (message d'erreur vide)." };
    }

    return { outcome: "unknown", message: "Aucune confirmation ni erreur détectée après l'enregistrement — à vérifier manuellement sur FBI avant de réessayer." };
  }

  /**
   * ÉCRIT réellement sur FBI — crée une NOUVELLE demande de dérogation pour
   * une rencontre "A Créer" (aucune dérogation active pour l'instant), voir
   * `DerogationCreationRequest` (types.ts) pour le détail des champs
   * supportés et ceux volontairement NON supportés (salle, pièce jointe —
   * leur mécanique réelle n'a jamais été observée, jamais deviné un
   * sélecteur sans preuve directe).
   *
   * "on cherche la rencontre concernée" (demande du club, 2026-09-28) :
   * recherche d'abord la ligne "A Créer" de cette rencontre sur
   * `rechercherDerogation.fbi` (état forcé sur "CREER", voir
   * `navigateToDerogationSearchScreen`) — même désambiguïsation par
   * `division` que `fetchDerogationForMatch`, même raison (un numéro de
   * rencontre n'est pas unique au club). `null` si aucune ligne "A Créer"
   * ne correspond (une dérogation existe peut-être déjà pour ce match, ou
   * le numéro/la division ne correspond à rien) : l'appelant
   * (`create-derogation.ts`) décide comment le signaler, jamais un
   * `outcome` fabriqué ici pour un cas qui n'a même pas atteint le
   * formulaire réel.
   *
   * Navigue ENSUITE vers le `href` de cette ligne (jamais une URL de
   * création construite à la main — voir la doc de l'interface) : FBI y
   * affiche directement le formulaire de création (`input#creation`
   * value="true", HTML source réel fourni par le club le 2026-09-28 pour
   * la rencontre 16/BU18MN1). Mêmes champs RÉELS que ce HTML (jamais
   * devinés) : `#modifierDate` → `#afficherDerogation_derogationForm_derogationDemandeBean_dateDerogation`,
   * `#modifierHoraire` → `#horaireHour`, `#inverserRencontre`/
   * `#inverserEquipe` (mutuellement exclusives côté JS réel de la page —
   * revalidé côté serveur AVANT cet appel par `create-derogation.ts`,
   * jamais supposé côté client seul), `#motif`. Même bouton
   * d'enregistrement et même détection de résultat (navigation loin de la
   * page = succès, `ul.errorMessage` = erreur, ni l'un ni l'autre dans le
   * délai imparti = `unknown`) que `respondToDerogation` — voir sa doc
   * pour le raisonnement complet (45s, jamais un succès supposé sans
   * preuve).
   */
  async createDerogation(
    session: BrowserFbiSession,
    matchNumber: string,
    division: string | null,
    request: DerogationCreationRequest,
  ): Promise<DerogationResponseOutcome | null> {
    const { page } = session;

    await this.navigateToDerogationSearchScreen(page, "creer");

    const numeroInput = await selectors.matchNumberSearchInput(page);
    if (!numeroInput) {
      throw new FbiError(
        `Champ "Numéro de rencontre" introuvable sur l'écran de recherche des dérogations (${this.baseUrl}/rechercherDerogation.fbi).`,
        "NAVIGATION_FAILED",
      );
    }

    const { scope } = await this.resolveDerogationScope(page);
    const preSubmitSignature = JSON.stringify(await selectors.resultsTableGenericRows(scope).catch(() => null));

    try {
      await numeroInput.fill(matchNumber);
      const submit = selectors.searchSubmitControl(page).first();
      if ((await submit.count().catch(() => 0)) > 0) await submit.click();
      else await numeroInput.press("Enter");
      await this.settle(page);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      await this.waitForDerogationTableRefresh(scope, preSubmitSignature);
    } catch (error) {
      throw new FbiError(
        `Recherche de la rencontre à créer échouée pour ${matchNumber} : ${error instanceof Error ? error.message : String(error)}`,
        "NAVIGATION_FAILED",
        error,
      );
    }

    const rows = await selectors.resultsTableGenericRows(scope);
    if (!rows || rows.length === 0) return null;

    const normalized = rows.map(normalizeDerogationRow);
    const matchIndex = normalized.findIndex((row) => row.numero === matchNumber && (division === null || row.division === division));
    if (matchIndex === -1) return null;

    const href = await this.derogationRowDetailHref(scope, matchIndex);
    if (!href) {
      return { outcome: "unknown", message: "Lien vers le formulaire de création introuvable sur la ligne « A Créer » de cette rencontre." };
    }

    try {
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: "domcontentloaded" });
      await this.settle(page);
    } catch (error) {
      throw new FbiError(`Formulaire de création de dérogation FBI injoignable pour la rencontre ${matchNumber}.`, "NAVIGATION_FAILED", error);
    }

    const creationMarker = page.locator("input#creation");
    if ((await creationMarker.count().catch(() => 0)) === 0 || (await creationMarker.getAttribute("value").catch(() => null)) !== "true") {
      return { outcome: "unknown", message: "Page de création de dérogation FBI introuvable ou de forme inattendue pour cette rencontre." };
    }

    try {
      if (request.modifierDate) {
        await page.locator("#modifierDate").check();
        await page.locator("#afficherDerogation_derogationForm_derogationDemandeBean_dateDerogation").fill(request.dateDerogation ?? "");
      }

      if (request.modifierHoraire) {
        await page.locator("#modifierHoraire").check();
        await page.locator("#horaireHour").fill(request.horaire ?? "");
      }

      if (request.inverserRencontre) await page.locator("#inverserRencontre").check();
      if (request.inverserEquipe) await page.locator("#inverserEquipe").check();

      await page.locator("#motif").fill(request.motif);
    } catch (error) {
      return { outcome: "unknown", message: `Impossible de renseigner le formulaire de création FBI : ${error instanceof Error ? error.message : String(error)}` };
    }

    const saveButton = page.locator("button.boutonEnregistrer").first();
    if ((await saveButton.count().catch(() => 0)) === 0) {
      return { outcome: "unknown", message: "Bouton d'enregistrement introuvable sur le formulaire de création FBI." };
    }

    const beforeUrl = page.url();
    try {
      await saveButton.click();
    } catch (error) {
      return { outcome: "unknown", message: `Le clic sur "Enregistrer" a échoué : ${error instanceof Error ? error.message : String(error)}` };
    }

    // 45s — même raisonnement que `respondToDerogation` (constaté en
    // production le 2026-09-28) : `enregistrerDerogationAjax()` peut
    // dépasser 20s, jamais une preuve que la navigation n'arrive pas.
    const navigatedAway = await page
      .waitForURL((candidate) => candidate.toString() !== beforeUrl, { timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    if (navigatedAway) return { outcome: "success" };

    const errorLocator = page.locator("ul.errorMessage").first();
    if ((await errorLocator.count().catch(() => 0)) > 0) {
      const text = (await errorLocator.innerText().catch(() => "")).trim();
      return { outcome: "error", message: text.length > 0 ? text : "FBI a rejeté la création de la dérogation (message d'erreur vide)." };
    }

    return { outcome: "unknown", message: "Aucune confirmation ni erreur détectée après l'enregistrement — à vérifier manuellement sur FBI avant de réessayer." };
  }

  /**
   * Rejoint l'écran de recherche des dérogations et règle "Etat de la
   * dérogation" sur `etat` — `"tousLesEtats"` (défaut, PAR LIBELLÉ, voir
   * ci-dessous, jamais par position — un précédent correctif sélectionnait
   * à tort le premier `<option>`, "A Créer" dans la vraie liste, ce qui
   * aurait masqué toutes les vraies demandes en cours) pour
   * `fetchDerogationForMatch`/`fetchAllDerogations` (voir la doc de
   * `DEROGATION_ETAT_PASSES`, § "Retour à une seule passe TT"), ou
   * `"creer"` (PAR VALEUR EXACTE, `value="CREER"`, confirmée réelle — voir
   * ci-dessous) pour `createDerogation` (demande du club, 2026-09-28 : "on
   * a vu comment accepter ou refuser une dérog, mtn faut en créer une" —
   * une rencontre sans dérogation active n'existe QUE sous cet état). Best
   * effort, jamais bloquant.
   */
  private async navigateToDerogationSearchScreen(page: Page, etat: "tousLesEtats" | "creer" = "tousLesEtats"): Promise<void> {
    const targetUrl = `${this.baseUrl}/rechercherDerogation.fbi`;

    try {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await this.settle(page);
    } catch (error) {
      throw new FbiError(`Écran de recherche des dérogations injoignable : ${targetUrl}`, "NAVIGATION_FAILED", error);
    }

    /**
     * Confirmé par capture d'écran ET par le HTML source réel de
     * `rechercherDerogation.fbi` fourni par le club le 2026-09-25 : les 6
     * options réelles sont "A Créer" (value="CREER") | "En Cours"
     * (value="EC") | "Acceptée par les deux associations sportives"
     * (value="ACCEPT") | "Acceptée par l'organisme dirigeant"
     * (value="ORGCREACC") | "Refusée" (value="ORGCREREF") | "Tous les
     * états (sauf à créer)" (value="TT", `selected="selected"` par défaut).
     *
     * **Bug corrigé le 2026-09-25 (deuxième round, HTML réel fourni par le
     * club après un premier test en production qui ne renvoyait QUE des
     * lignes "A Créer")** : le sélecteur `<select>` est trouvé par
     * attribut `name` (`*="etat" i`, même principe que `nonJoueCheckbox`
     * ci-dessus), JAMAIS en le cherchant comme ENFANT d'un `<label>` — le
     * vrai balisage FBI (MDB/bootstrap-select) place le `<label>` APRÈS le
     * `<select>`, comme FRÈRE, jamais autour de lui :
     * `<select name="...etatDerogation">...</select><label>Etat de la
     * dérogation</label>`. L'ancienne recherche `label:has-text(...) >
     * select` ne trouvait donc RIEN sur le vrai site (0 correspondance,
     * `count() === 0`) — le bloc entier était silencieusement ignoré
     * (best effort), laissant le filtre à son état de fait au moment du
     * chargement de page, jamais explicitement forcé sur "Tous les
     * états". Recherché par le LIBELLÉ visible de l'option ("tous les
     * états") pour `"tousLesEtats"`, jamais par position — un tout premier
     * correctif (avant celui-ci) sélectionnait à tort le PREMIER
     * `<option>` ("A Créer" dans la vraie liste), ce qui aurait restreint
     * chaque recherche à cet unique état au lieu de toutes les VRAIES
     * demandes en cours ("A Créer" désigne une rencontre sans dérogation
     * active, pas une demande — l'exclure est le comportement voulu pour
     * "vérifier toutes les demandes", jamais un oubli). `"creer"` cherche
     * au contraire PRÉCISÉMENT cet état, par sa valeur RÉELLE confirmée
     * (`value="CREER"`, jamais devinée) — jamais par libellé (un libellé
     * `"A Créer"` matcherait aussi de façon inattendue une variante future
     * du texte, la valeur d'option reste le contrat stable).
     */
    try {
      const etatSelect = page.locator('select[name*="etat" i]').first();
      if ((await etatSelect.count().catch(() => 0)) === 0) return;

      if (etat === "creer") {
        await etatSelect.selectOption({ value: "CREER" }).catch(() => {});
        return;
      }

      const labelPattern = /tous les [ée]tats/i;
      const options = etatSelect.locator("option");
      const optionCount = await options.count().catch(() => 0);

      for (let i = 0; i < optionCount; i += 1) {
        const label = ((await options.nth(i).textContent().catch(() => "")) ?? "").trim();
        if (!labelPattern.test(label)) continue;

        const value = await options.nth(i).getAttribute("value").catch(() => null);
        await etatSelect.selectOption(value !== null ? { value } : { label }).catch(() => {});
        break;
      }
    } catch {
      // Best effort — voir la note ci-dessus.
    }
  }

  /**
   * "utiliser correctement `page.waitForEvent('download')` OU ÉQUIVALENT".
   * Un `BrowserContext` Playwright expose un `APIRequestContext`
   * (`context.request`) qui réutilise AUTOMATIQUEMENT les cookies de la
   * session authentifiée pour une requête vers la même origine —
   * équivalent robuste et plus simple qu'un clic + interception
   * d'événement pour un lien de téléchargement direct, sans jamais passer
   * par le système de fichiers utilisateur (le seul stockage temporaire
   * touché par ce module est celui de @sparticuz/chromium dans `/tmp`,
   * voir browser-launcher.ts).
   */
  /**
   * Jusqu'à 3 tentatives, UNIQUEMENT sur une erreur réseau (`connect
   * ETIMEDOUT`/`ECONNRESET`...) — jamais sur une vraie réponse HTTP
   * (`!response.ok()`, ex : 404/403), qu'un retry ne corrigerait jamais.
   * Retour du club, 2026-09-30 : plusieurs `connect ETIMEDOUT` consécutifs
   * vers `extranet.ffbb.com` depuis cette fonction Vercel (voir aussi
   * `vercel.json` — région fixée sur Paris pour rapprocher le trajet réseau
   * du serveur FFBB) — un blip isolé de quelques secondes ne doit pas
   * coûter tout un cycle de replanification `discover_emarque` (plusieurs
   * minutes de backoff) quand une nouvelle tentative immédiate suffit
   * souvent.
   */
  async downloadDocument(session: BrowserFbiSession, url: string): Promise<Buffer> {
    await this.humanPause(session.page, 1500, 3000);
    // D'abord DEPUIS LA PAGE (fetch du navigateur, même session) — constaté
    // en production le 2026-10-02 (rencontre n°1) : `context.request` (pile
    // réseau Node) échouait en "connect ETIMEDOUT" 3 fois de suite alors
    // que le navigateur venait de se connecter et de trouver le document.
    // Une vraie réponse HTTP en erreur reste une erreur ; seul un échec
    // réseau du navigateur fait retomber sur `context.request` ci-dessous.
    const inPage = await session.page
      .evaluate(async ({ documentUrl, timeoutMs }) => {
        try {
          const response = await fetch(documentUrl, { credentials: "include", signal: AbortSignal.timeout(timeoutMs) });
          if (!response.ok) return { status: response.status, base64: null, error: null };
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          }
          return { status: response.status, base64: btoa(binary), error: null };
        } catch (error) {
          return { status: null, base64: null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
        }
      }, { documentUrl: url, timeoutMs: FBI_IN_PAGE_DOWNLOAD_TIMEOUT_MS })
      .catch((error: unknown) => ({ status: null, base64: null, error: `évaluation dans la page impossible (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` }));

    if (inPage.base64 != null) return Buffer.from(inPage.base64, "base64");
    if (inPage.status != null) throw new FbiError(`Téléchargement FBI : réponse HTTP ${inPage.status} (${url})`, "REQUEST_FAILED");

    // Deuxième essai, toujours côté navigateur : un VRAI téléchargement par
    // navigation (comme un clic humain), dans un onglet séparé — suit aussi
    // une éventuelle redirection vers un autre domaine, qu'un `fetch` de la
    // page refuserait (CORS).
    const viaNavigation = await this.downloadViaNavigation(session, url).catch((error: unknown) => (error instanceof Error ? error.message.split("\n")[0] : String(error)));
    if (Buffer.isBuffer(viaNavigation)) return viaNavigation;
    const browserError = `navigateur : fetch ${inPage.error} / navigation ${viaNavigation}`;

    const maxAttempts = 2;
    let lastNetworkError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await session.context.request.get(url, { timeout: FBI_NODE_REQUEST_TIMEOUT_MS });
      } catch (error) {
        lastNetworkError = error;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          continue;
        }
        throw new FbiError(
          `Téléchargement FBI : échec réseau (${browserError} ; Node après ${maxAttempts} tentatives : ${error instanceof Error ? error.message.split("\n")[0] : String(error)}) (${url})`,
          "REQUEST_FAILED",
          error,
        );
      }

      if (!response.ok()) {
        throw new FbiError(`Téléchargement FBI : réponse HTTP ${response.status()} (${url})`, "REQUEST_FAILED");
      }

      return response.body();
    }

    // Jamais atteint (la dernière itération lève toujours) — TypeScript ne le sait pas.
    throw new FbiError(`Téléchargement FBI : échec réseau après ${maxAttempts} tentatives (${url})`, "REQUEST_FAILED", lastNetworkError);
  }

  private async downloadViaNavigation(session: BrowserFbiSession, url: string): Promise<Buffer> {
    const tab = await session.context.newPage();
    try {
      const downloadPromise = tab.waitForEvent("download", { timeout: FBI_NAVIGATION_DOWNLOAD_TIMEOUT_MS }).catch(() => null);
      const response = await tab.goto(url, { timeout: FBI_NAVIGATION_DOWNLOAD_TIMEOUT_MS }).catch(() => null);
      if (response) {
        if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
        return await response.body();
      }
      const download = await downloadPromise;
      if (!download) throw new Error("aucun téléchargement déclenché");
      const failure = await download.failure();
      if (failure) throw new Error(`téléchargement interrompu (${failure})`);
      const filePath = await download.path();
      return await readFile(filePath);
    } finally {
      await tab.close().catch(() => {});
    }
  }

  /**
   * Déconnexion RÉELLE côté serveur FBI avant de fermer le contexte
   * Playwright local — jamais fait jusqu'ici (§ 2026-09-30, investigation
   * du match 312f32c0/job 3f0d54ad) : `closeSession` se contentait de
   * `context.close()`, qui ferme le navigateur LOCAL mais ne révoque
   * jamais la session serveur FBI (cookie JSESSIONID toujours valide côté
   * FBI jusqu'à son expiration naturelle). Chaque job (`discover_emarque`,
   * `reconcile_schedule`, `check_all_derogations`, `test_connection`) se
   * reconnecte à chaque fois — plusieurs dizaines de connexions par jour
   * pour ce club, JAMAIS refermées côté serveur. Sur une appli legacy
   * (JSF/Struts, noms de champs `identificationForm.identificationBean...`)
   * une accumulation de sessions actives pour le MÊME compte est un
   * terrain connu pour des comportements dégradés/incohérents (état
   * DataTables corrompu par un thread serveur concurrent, limite de
   * sessions actives, etc.) — cohérent avec l'instabilité constatée ce
   * jour même sur CE match (résultats de recherche tantôt trouvés tantôt
   * vides, clic EM tantôt capté tantôt silencieux, sans changement de
   * code entre deux essais identiques). Navigation directe (même
   * principe que `tryNavigateToSearchScreen`) plutôt que de chercher un
   * lien "Déconnexion" à cliquer — best-effort strict : jamais bloquer la
   * fermeture du contexte local si la déconnexion serveur échoue.
   */
  /**
   * Export Excel des licences VALIDÉES du club (retour du club, 2026-10-08 :
   * « tu as le chemin pour récupérer les licences, filtre Validé, ensuite
   * avec l'excel téléchargé ça s'exploite »). Écran « Gestion des licences »
   * (`rechercherLicence.fbi`, page fournie par le club) : liste
   * `#statutValidationComite` sur « Validé » (`1`), bouton RECHERCHER
   * (`rechercherLicenceAjax()`), puis le bouton Excel du tableau de
   * résultats (`.boutonExcelNew`, `exportExcel()`) — le fichier est récupéré
   * par l'événement de téléchargement du navigateur, sans deviner l'URL
   * d'export. Lecture seule : aucune donnée modifiée côté FBI.
   */
  async downloadValidatedLicencesExport(session: BrowserFbiSession): Promise<{ buffer: Buffer; fileName: string }> {
    const { page } = session;
    await this.humanPause(page, 1200, 2500);
    // 3 essais rapprochés sur une erreur réseau ou un délai dépassé (même principe que `tryNavigateToSearchScreen`), jamais sur une vraie réponse HTTP.
    let response: Awaited<ReturnType<Page["goto"]>> = null;
    for (let attempt = 1; ; attempt += 1) {
      try {
        response = await page.goto(`${this.baseUrl}/rechercherLicence.fbi`, { waitUntil: "domcontentloaded", timeout: 45_000 });
        break;
      } catch (error) {
        if (attempt >= 3) throw new FbiError(`Écran « Gestion des licences » injoignable après ${attempt} essais (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`, "NAVIGATION_FAILED", error);
        await page.waitForTimeout(3000 * attempt);
      }
    }
    if (response && !response.ok()) throw new FbiError(`Écran « Gestion des licences » : réponse HTTP ${response.status()}.`, "NAVIGATION_FAILED");
    if (await selectors.looksLikeLoginPage(page)) throw new FbiError("Session FBI expirée : page d'identification affichée.", "SESSION_EXPIRED");
    if ((await page.locator("#statutValidationComite").count()) === 0 || (await page.locator("#rechercher").count()) === 0) {
      throw new FbiError("Écran « Gestion des licences » non reconnu (filtre Validation ou bouton RECHERCHER introuvable).", "NAVIGATION_FAILED");
    }
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await this.humanPause(page, 800, 1800);

    // Liste native masquée par bootstrap-select : on règle la valeur puis on rafraîchit l'affichage du plugin.
    const applied = await page.evaluate(() => {
      const select = document.getElementById("statutValidationComite") as HTMLSelectElement | null;
      if (!select) return null;
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      const jq = (window as unknown as { jQuery?: (el: Element) => { selectpicker?: (action: string) => void } }).jQuery;
      try {
        jq?.(select).selectpicker?.("refresh");
      } catch {
        // Affichage seulement : la valeur envoyée vient de la liste native.
      }
      return select.value;
    });
    if (applied !== "1") throw new FbiError("Impossible de choisir « Validé » dans le filtre Validation.", "NAVIGATION_FAILED");

    const searchDone = page.waitForResponse((r) => r.url().includes("rechercherLicence.fbi") && r.request().method() === "POST", { timeout: 90_000 }).catch(() => null);
    await page.locator("#rechercher").click();
    if (!(await searchDone)) throw new FbiError("La recherche des licences validées n'a pas répondu à temps.", "REQUEST_FAILED");
    await page.locator("#tableauResultats").waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await this.settle(page);
    await this.humanPause(page, 1500, 3000);

    const downloadPromise = page.waitForEvent("download", { timeout: 120_000 }).catch(() => null);
    const excelButton = page.locator("#tableauResultats .boutonExcelNew, #rechercherLicence .boutonExcelNew").first();
    if ((await excelButton.count()) > 0 && (await excelButton.isVisible().catch(() => false))) await excelButton.click();
    else await page.evaluate(() => (window as unknown as { exportExcel?: () => unknown }).exportExcel?.());
    const download = await downloadPromise;
    if (!download) throw new FbiError("L'export Excel des licences n'a déclenché aucun téléchargement.", "REQUEST_FAILED");
    const failure = await download.failure();
    if (failure) throw new FbiError(`Téléchargement de l'export des licences interrompu (${failure}).`, "REQUEST_FAILED");
    const buffer = await readFile(await download.path());
    await download.delete().catch(() => undefined);
    return { buffer, fileName: download.suggestedFilename() };
  }

  /** Cookies de la session, pour la reprendre au passage suivant (chiffrés avant stockage). */
  async exportSessionState(session: BrowserFbiSession): Promise<string | null> {
    return session.context
      .storageState()
      .then((state) => JSON.stringify({ cookies: state.cookies, origins: [] }))
      .catch(() => null);
  }

  /** Ferme le navigateur local SANS déconnexion côté FBI : la session sera reprise au passage suivant. */
  async detachSession(session: BrowserFbiSession): Promise<void> {
    await session.context.close().catch(() => undefined);
  }

  async closeSession(session: BrowserFbiSession): Promise<void> {
    try {
      await session.page.goto(`${this.baseUrl}/deconnexion.fbi`, { waitUntil: "domcontentloaded", timeout: 10000 });
    } catch {
      // Best effort — la fermeture du contexte local ci-dessous reste la priorité.
    }
    await session.context.close();
  }
}
