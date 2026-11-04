import type { Locator, Page } from "playwright-core";
import type { FbiDerogationDetailFields } from "./types.js";

/**
 * Détection FBI centralisée (§16 du brief FBI) : AUCUN sélecteur fragile
 * type `div:nth-child(4) > span:nth-child(2)`. Tout ici se base sur des
 * attributs stables (type, name, href), du texte visible, ou des libellés —
 * la même philosophie que ./http-client.ts (détection dynamique du
 * formulaire de login via cheerio), transposée à Playwright.
 *
 * Le markup RÉEL de FBI au-delà de l'écran de connexion n'a pas pu être
 * observé depuis cet environnement (réseau *.ffbb.com bloqué, voir
 * docs/FBI_AUTHENTICATED_SPIKE.md) : la découverte de documents ci-dessous
 * est donc volontairement générique (texte/extension de fichier) plutôt que
 * câblée sur une page précise — elle est conçue pour survivre à un
 * changement mineur de mise en page FBI, et testée contre des fixtures HTML
 * synthétiques plausibles (voir les tests de browser-client).
 */

/** Un input password visible est la preuve la plus fiable qu'on est sur (ou retombé sur) l'écran de connexion — jamais un simple code HTTP 200 (§15 du brief FBI). */
export async function looksLikeLoginPage(page: Page): Promise<boolean> {
  return (await page.locator('input[type="password"]').count()) > 0;
}

export function passwordInput(page: Page): Locator {
  return page.locator('input[type="password"]').first();
}

/** Premier champ texte/email/sans-type DANS LE MÊME FORMULAIRE que le mot de passe — jamais un nom de champ deviné à l'avance. */
export function usernameInput(page: Page): Locator {
  const form = passwordInput(page).locator("xpath=ancestor::form[1]");
  return form.locator('input[type="text"], input[type="email"], input:not([type])').first();
}

export function loginForm(page: Page): Locator {
  return passwordInput(page).locator("xpath=ancestor::form[1]");
}

/** Bouton de soumission du formulaire de login : type=submit d'abord, sinon un bouton dont le texte visible évoque la connexion. */
export function submitControl(page: Page): Locator {
  const form = loginForm(page);
  const typed = form.locator('button[type="submit"], input[type="submit"]');
  return typed;
}

const LOGIN_BUTTON_TEXT_PATTERN = /connexion|se connecter|connecter|valider/i;

export function submitButtonByText(page: Page): Locator {
  return loginForm(page).getByRole("button", { name: LOGIN_BUTTON_TEXT_PATTERN });
}

/** Une page authentifiée doit prouver un élément stable de post-login (jamais juste "pas de mot de passe visible" — §15). */
export function logoutLink(page: Page): Locator {
  return page.locator('a[href*="deconnexion"], a[href*="logout"]');
}

export interface DiscoveredDocumentLink {
  href: string;
  label: string;
}

const DOCUMENT_EXTENSION_PATTERN = /\.(zip|pdf)(\?|$)/i;
const DOCUMENT_LABEL_PATTERN = /feuille de match|résumé|resume|e-?marque|export|position.*tir|shot/i;

/**
 * Liens permanents vers le LOGICIEL e-Marque (pas des données DE CE match) —
 * confirmés en production à deux reprises indépendantes : une première fois
 * sur l'accueil FBI (menu "e-Marque" → ffbb.com/e-marque-v2, § "Quinzième/
 * Seizième déclenchement", docs/FBI.md), une seconde fois le 2026-09-24 sur
 * LA PAGE DE DÉTAIL atteinte après clic sur le lien EM lui-même, pour la
 * rencontre n°1481 réellement "réussie" (§ "Vingt-deuxième déclenchement") :
 * un document `T_l_charger_e-Marque_V2.pdf` ("Télécharger e-Marque V2.pdf")
 * téléchargé et inséré comme si c'était un document DE CE match, alors que
 * c'est un lien permanent (présent sur toute page offrant des téléchargements
 * e-Marque) vers le logiciel/l'installateur. `DOCUMENT_LABEL_PATTERN`
 * (générique "e-?marque") le matche à tort sans cette exclusion explicite.
 */
const SOFTWARE_DOWNLOAD_PATTERN = /e-?marque[\s_-]*v ?2|mini ?basket|logiciel|installer/i;

/**
 * Cherche des liens plausibles vers des documents e-Marque sur la page
 * courante (résultat d'une recherche de rencontre) : soit l'URL se termine
 * par une extension de document connue, soit le texte visible du lien
 * évoque un document e-Marque connu (§19 du brief FBI). Ne devine jamais un
 * chemin — ne renvoie que des liens RÉELLEMENT présents sur la page.
 */
export async function findDocumentLinks(page: Page): Promise<DiscoveredDocumentLink[]> {
  const anchors = page.locator("a[href]");
  const count = await anchors.count();
  const found: DiscoveredDocumentLink[] = [];
  const seenHrefs = new Set<string>();

  for (let i = 0; i < count; i += 1) {
    const anchor = anchors.nth(i);
    const href = await anchor.getAttribute("href");
    if (!href) continue;

    const text = ((await anchor.textContent()) ?? "").trim();
    if (SOFTWARE_DOWNLOAD_PATTERN.test(text) || SOFTWARE_DOWNLOAD_PATTERN.test(href)) continue;
    if (!(DOCUMENT_EXTENSION_PATTERN.test(href) || DOCUMENT_LABEL_PATTERN.test(text))) continue;

    /**
     * Déduplique par href — constaté en production le 2026-09-24 (rencontre
     * n°1481, § "Vingt-deuxième déclenchement") : le même lien de document
     * apparaissait 3 FOIS dans le DOM (probablement une mise en page
     * dupliquant certains éléments — déjà observé pour le menu global, voir
     * `listVisibleLinks` plus haut), produisant 3 entrées "e-Marque.pdf" qui
     * s'écrasaient mutuellement en Storage (même chemin dérivé d'un nom de
     * fichier générique).
     */
    if (seenHrefs.has(href)) continue;
    seenHrefs.add(href);

    found.push({ href, label: text || href });
  }

  return found;
}

/**
 * Diagnostic — liste les liens RÉELLEMENT visibles sur la page courante
 * (texte + href, plafonné), pour l'inclure dans le message d'une
 * `EMARQUE_MATCH_PAGE_NOT_REACHED` (`browser-client.ts`). Constaté en
 * production le 2026-09-24 : la navigation reste bloquée sur "FBI -
 * Accueil" pour TOUT numéro de rencontre testé (§ "Quinzième
 * déclenchement" côté docs/FBI.md), y compris pour des numéros assez
 * spécifiques pour exclure une coïncidence de texte — ce qui pointe vers
 * `tryNavigateToSearchScreen` (le tout premier clic, `getByRole("link",
 * { name: /rencontre|compétition|calendrier/i })`) qui ne trouve rien
 * sur le VRAI accueil FBI, jamais observable depuis cet environnement.
 * Ce dump doit révéler, au prochain échec, les libellés RÉELS des liens
 * de navigation présents — plutôt que d'ajuster le regex à l'aveugle une
 * quatrième fois.
 */
export async function listVisibleLinks(page: Page, limit = 25): Promise<{ text: string; href: string }[]> {
  const anchors = page.locator("a[href]");
  const count = Math.min(await anchors.count(), limit);
  const links: { text: string; href: string }[] = [];

  for (let i = 0; i < count; i += 1) {
    const anchor = anchors.nth(i);
    const href = (await anchor.getAttribute("href").catch(() => null)) ?? "";
    const text = ((await anchor.textContent().catch(() => "")) ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (text || href) links.push({ text, href });
  }

  return links;
}

export interface FormFieldSnapshot {
  tag: string;
  type?: string;
  name: string;
  value: string;
  selectedLabel?: string;
}

/**
 * Diagnostic — dump de TOUS les champs de formulaire visibles sur la page
 * courante (input/select/textarea), avec pour un `<select>` le LIBELLÉ de
 * l'option actuellement sélectionnée. Constaté en production le
 * 2026-09-24 (§ "Dix-neuvième déclenchement", docs/FBI.md) : après avoir
 * corrigé le faux positif de la checkbox "non joué", remplir et soumettre
 * le champ numéro de rencontre n'a produit AUCUNE ligne de résultat — ni
 * lien e-Marque, ni la moindre trace de tableau dans les liens visibles
 * de la page. Hypothèse à vérifier sur preuve, pas à deviner : un
 * formulaire FBI de ce type a très probablement d'autres champs
 * obligatoires (saison, compétition, poule...) qui filtrent la recherche
 * EN PLUS du numéro — si l'un d'eux a une valeur par défaut qui ne
 * correspond pas au match recherché (ex : la saison en cours plutôt que
 * la saison du match), la recherche ne peut jamais aboutir, quel que soit
 * le champ numéro ciblé. Ce dump révélera, au prochain échec, l'état
 * RÉEL de chaque champ du formulaire.
 */
export async function listFormFields(page: Page, limit = 40): Promise<FormFieldSnapshot[]> {
  /**
   * Constaté en production le 2026-09-24 (§ "Vingtième déclenchement",
   * docs/FBI.md) : ce dump n'incluait pas les `<button>` du formulaire —
   * impossible donc de vérifier, sur une recherche restée sans résultat
   * malgré une saison/case correctement ajustées, si `searchSubmitControl`
   * a bien ciblé le VRAI bouton "RECHERCHER" plutôt qu'un autre bouton du
   * même formulaire (réinitialiser, etc.). Les boutons sont maintenant
   * inclus, avec leur texte visible comme "valeur".
   */
  const fields = page.locator("form input, form select, form textarea, form button");
  const count = Math.min(await fields.count().catch(() => 0), limit);
  const snapshots: FormFieldSnapshot[] = [];

  for (let i = 0; i < count; i += 1) {
    const field = fields.nth(i);
    const tag = (await field.evaluate((node) => node.tagName.toLowerCase()).catch(() => "?")) as string;
    const type = (await field.getAttribute("type").catch(() => null)) ?? undefined;
    const name = (await field.getAttribute("name").catch(() => null)) ?? "";

    if (tag === "select") {
      const value = (await field.inputValue().catch(() => "")) ?? "";
      const selectedLabel = (await field.locator("option:checked").first().textContent().catch(() => null))?.trim();
      snapshots.push({ tag, name, value, selectedLabel });
      continue;
    }

    if (tag === "button") {
      const value = ((await field.textContent().catch(() => "")) ?? "").trim().replace(/\s+/g, " ");
      snapshots.push({ tag, type, name, value });
      continue;
    }

    /**
     * Le `value` d'une checkbox/radio est sa valeur de SOUMISSION (ex :
     * "true"), FIXE dans le markup — indépendante de son état coché ou
     * non. La confondre avec l'état coché a induit en erreur au
     * déclenchement précédent (dump montrant `nonJoue]="true"`, lu à tort
     * comme "cochée" alors que ça ne prouvait rien). L'état RÉEL est lu
     * via `isChecked()`.
     */
    if (type === "checkbox" || type === "radio") {
      const checked = await field.isChecked().catch(() => false);
      snapshots.push({ tag, type, name, value: checked ? "checked" : "unchecked" });
      continue;
    }

    const value = (await field.getAttribute("value").catch(() => null)) ?? "";
    snapshots.push({ tag, type, name, value });
  }

  return snapshots;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Le numéro de rencontre comme nombre ISOLÉ (bordures non-chiffres des
 * deux côtés), jamais un fragment d'un nombre plus grand — même principe
 * que `pageMentionsMatchNumber`, réutilisé par `tryOpenMatchResult`
 * (`browser-client.ts`) : `getByText(matchNumber, { exact: false })` est
 * un test de sous-chaîne, qui pour un numéro court ("1") clique le
 * premier élément contenant "1" n'importe où sur la page (pagination,
 * footer...) plutôt que le vrai résultat de recherche — même régression
 * que celle documentée plus bas, constatée le 2026-09-24 pour la
 * rencontre n°1 malgré le premier correctif de `pageMentionsMatchNumber`.
 */
export function matchNumberAsIsolatedText(matchNumber: string): RegExp {
  return new RegExp(`(?<!\\d)${escapeRegExp(matchNumber)}(?!\\d)`);
}

/**
 * Preuve qu'on est bien sur (ou a atteint) la page de LA rencontre
 * demandée, jamais retombé sur une page générique (accueil, aide) après un
 * échec silencieux des étapes "best effort" de navigation — constaté en
 * production le 2026-09-24 : `findDocumentLinks` remontait systématiquement
 * les MÊMES documents génériques ("Télécharger e-Marque V2.pdf",
 * "Télécharger e-Marque MiniBasket.pdf" — des liens de téléchargement du
 * LOGICIEL e-Marque, pas des documents de match) pour des dizaines de
 * numéros de rencontre différents : preuve que la navigation vers la page
 * de résultat spécifique n'aboutissait jamais, et que `findDocumentLinks`
 * scannait alors une page d'accueil/aide contenant ces liens permanents
 * (`DOCUMENT_EXTENSION_PATTERN` matche N'IMPORTE QUEL lien .pdf/.zip sur la
 * page, quelle qu'elle soit — pas seulement les liens pertinents).
 *
 * FAUX POSITIF constaté le même jour pour la rencontre n°1 : un simple
 * `.includes()` matche "1" n'importe où sur n'importe quelle page (une
 * date, un numéro de version, une pagination...) — la rencontre n°1
 * "réussissait" alors qu'on était encore sur la page d'accueil, avec les
 * mêmes documents génériques que la rencontre n°1481 (elle, correctement
 * détectée en échec — "1481" est assez spécifique pour ne jamais
 * apparaître par hasard). Recherche maintenant le numéro comme un nombre
 * ISOLÉ (bordures non-chiffres des deux côtés), jamais comme fragment
 * d'un nombre plus grand — imparfait pour un numéro à 1-2 chiffres
 * (un vrai faux positif reste possible), mais nettement plus fiable
 * qu'un simple `.includes()`.
 */
export async function pageMentionsMatchNumber(page: Page, matchNumber: string): Promise<boolean> {
  const bodyText = (await page.locator("body").textContent()) ?? "";
  return matchNumberAsIsolatedText(matchNumber).test(bodyText);
}

/**
 * Champ de recherche par numéro de rencontre : basé sur un attribut
 * name/placeholder évocateur, jamais une position.
 *
 * Constaté en production le 2026-09-24 (§ "Dix-neuvième déclenchement",
 * docs/FBI.md) : le vrai formulaire `rechercherRencontreSaisieResultat.fbi`
 * contient AUSSI une checkbox "non joué" dont le `name` est
 * `rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.nonJoue`
 * — elle matche le motif `name*="rencontre"` tout autant qu'un vrai champ
 * texte. Playwright résout une liste de sélecteurs CSS séparés par des
 * virgules dans l'ORDRE DU DOM (comme `querySelectorAll`), jamais dans
 * l'ordre d'écriture des alternatives : comme cette checkbox apparaît
 * AVANT le vrai champ numéro dans le markup, `.first()` la sélectionnait
 * à tort, et `.fill()` plantait ("Input of type checkbox cannot be
 * filled"). Exclure explicitement les types non-texte (checkbox, radio,
 * hidden, submit, button) élimine CE faux positif précis, mais ne suffit
 * pas en général : un simple `page.locator("a, b, c").first()` reste
 * résolu par ORDRE DU DOM, jamais par l'ordre d'écriture de `a`/`b`/`c` —
 * si une AUTRE checkbox/champ texte non pertinent matchant `rencontre`
 * (ex : un champ "date de rencontre") précède le vrai champ "numero"
 * dans le markup, le même bug reviendrait sous une autre forme. Résout
 * donc chaque alternative dans l'ordre de PRIORITÉ écrit ci-dessous
 * (renvoie la première dont au moins un élément existe), jamais toutes
 * fusionnées dans un seul sélecteur CSS.
 */
export async function matchNumberSearchInput(page: Page): Promise<Locator | null> {
  const nonTextTypes = ':not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="submit"]):not([type="button"])';
  const candidates = [
    `input[name*="numero" i]${nonTextTypes}`,
    `input[name*="rencontre" i]${nonTextTypes}`,
    `input[placeholder*="numéro" i]${nonTextTypes}`,
    `input[placeholder*="rencontre" i]${nonTextTypes}`,
  ];

  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) > 0) return locator;
  }

  return null;
}

/**
 * Bouton "RECHERCHER" de validation d'un formulaire de recherche : type
 * submit d'abord, sinon un bouton dont le texte visible évoque une
 * recherche — même logique que `submitControl`/`submitButtonByText` pour
 * le formulaire de login. Un simple `input.press("Enter")` ne suffit pas
 * toujours à soumettre un formulaire non natif (JS intercepté).
 */
export function searchSubmitControl(page: Page): Locator {
  return page.locator('button[type="submit"], input[type="submit"]').or(page.getByRole("button", { name: /recherch/i }));
}

/**
 * Index des colonnes "N°" et "EM" du tableau de résultats — lu depuis les
 * EN-TÊTES du tableau à chaque appel, jamais une position `nth-child`
 * câblée en dur. Partagé par `emarqueColumnLinkForMatch` et
 * `matchNumberInResultsTable`. `null` quand la page courante n'a pas cette
 * forme (pas la bonne page).
 */
async function resultsTableColumns(page: Page): Promise<{ numeroColIndex: number; emColIndex: number; divisionColIndex: number } | null> {
  const headerCells = page.locator("table th, table thead td");
  const headerTexts = await headerCells.allTextContents().catch(() => []);
  const trimmedHeaders = headerTexts.map((t) => t.trim());

  const numeroColIndex = trimmedHeaders.findIndex((t) => t === "N°" || /^n°?\s*rencontre$/i.test(t));
  const emColIndex = trimmedHeaders.findIndex((t) => t === "EM");
  if (numeroColIndex === -1 || emColIndex === -1) return null;

  // "Division" (§ "82 vs 51", docs/FBI.md, 2026-09-27 — même bug que
  // rechercherDerogation.fbi, jamais corrigé ici avant le retour du club du
  // 2026-09-30 : "tu confonds les matchs") : `N°` n'est PAS unique au club,
  // le même numéro existe dans plusieurs divisions/catégories. `-1` (colonne
  // absente) laisse `emarqueColumnLinkForMatch`/`matchNumberInResultsTable`
  // ignorer ce filtre plutôt que d'échouer — même repli best-effort que
  // `fetchDerogationForMatch`.
  const divisionColIndex = trimmedHeaders.findIndex((t) => t === "Division");

  return { numeroColIndex, emColIndex, divisionColIndex };
}

/**
 * Localise, DANS la ligne du tableau de résultats correspondant à CE
 * numéro de rencontre, le lien/bouton de la colonne "EM" (e-Marque) —
 * confirmé en production le 2026-09-24 par une capture d'écran du VRAI
 * FBI (page `rechercherRencontreSaisieResultat.fbi`) : le tableau de
 * résultats a des colonnes `Division | N° | Equipe 1 | Equipe 2 | Date
 * de rencontre | Heure | Salle | EM | Score...`, où la colonne "EM"
 * contient un CODE cliquable (ex: "DCBLRCA7") ou une icône "FDM" pour
 * une rencontre déjà jouée avec un e-Marque disponible — VIDE sinon
 * (rencontre pas encore jouée, ou sans e-Marque).
 *
 * Renvoie `null` — jamais une erreur — quand le tableau n'a pas cette
 * forme (pas la bonne page), quand aucune ligne ne correspond à CE
 * numéro, ou quand la colonne "EM" de la ligne trouvée est vide (match
 * pas encore joué/sans e-Marque — cas légitime, pas un échec).
 */
export async function emarqueColumnLinkForMatch(page: Page, matchNumber: string, division: string | null = null): Promise<Locator | null> {
  const columns = await resultsTableColumns(page);
  if (!columns) return null;

  const rows = page.locator("table tbody tr");
  const rowCount = await rows.count().catch(() => 0);

  for (let i = 0; i < rowCount; i += 1) {
    const row = rows.nth(i);
    const cells = row.locator("td");
    const numeroText = (await cells.nth(columns.numeroColIndex).textContent().catch(() => null))?.trim();
    if (numeroText !== matchNumber) continue;

    // `division` (§ "82 vs 51", docs/FBI.md, 2026-09-27) : même désambiguïsation
    // que `fetchDerogationForMatch` — `N°` seul n'est PAS unique au club (retour
    // du club, 2026-09-30 : stats d'un match U11 attachées à un match U15
    // partageant le même numéro). `null`/colonne absente : repli best-effort,
    // jamais un échec.
    if (division !== null && columns.divisionColIndex !== -1) {
      const divisionText = (await cells.nth(columns.divisionColIndex).textContent().catch(() => null))?.trim();
      if (divisionText !== division) continue;
    }

    const emCell = cells.nth(columns.emColIndex);
    const emLink = emCell.locator("a, button").first();
    if ((await emLink.count().catch(() => 0)) > 0) return emLink;

    return null; // Ligne trouvée, mais colonne EM vide — match pas encore joué/sans e-Marque.
  }

  return null;
}

/**
 * Preuve qu'une ligne du tableau de résultats correspond EXACTEMENT (jamais
 * une sous-chaîne) à ce numéro de rencontre — `null` quand la page courante
 * n'a pas la forme d'un tableau de résultats (colonnes "N°"/"EM"
 * introuvables), auquel cas l'appelant doit se rabattre sur
 * `pageMentionsMatchNumber` (page de détail après clic sur le lien EM, sans
 * tableau).
 *
 * Régression production 2026-09-24 pour la rencontre n°1 : rester sur la
 * page de résultats (colonne EM vide/ligne introuvable) puis vérifier avec
 * `pageMentionsMatchNumber` sur le texte ENTIER de la page faisait un faux
 * positif — l'en-tête de colonne "Score 1" contient elle-même un "1" isolé
 * (précédé d'un espace, suivi d'un saut de ligne), non lié au numéro de
 * rencontre recherché. Une comparaison EXACTE sur la cellule "N°" de chaque
 * ligne (déjà utilisée par `emarqueColumnLinkForMatch`) n'a pas ce problème :
 * "1" ne correspond jamais exactement à une cellule contenant "2813" ou
 * "9999".
 */
export async function matchNumberInResultsTable(page: Page, matchNumber: string, division: string | null = null): Promise<boolean | null> {
  const columns = await resultsTableColumns(page);
  if (!columns) return null;

  const rows = page.locator("table tbody tr");
  const rowCount = await rows.count().catch(() => 0);

  for (let i = 0; i < rowCount; i += 1) {
    const cells = rows.nth(i).locator("td");
    const numeroText = (await cells.nth(columns.numeroColIndex).textContent().catch(() => null))?.trim();
    if (numeroText !== matchNumber) continue;

    // Même désambiguïsation par division que `emarqueColumnLinkForMatch` — voir sa doc.
    if (division !== null && columns.divisionColIndex !== -1) {
      const divisionText = (await cells.nth(columns.divisionColIndex).textContent().catch(() => null))?.trim();
      if (divisionText !== division) continue;
    }

    return true;
  }

  return false;
}

/**
 * Lit TOUT le tableau de résultats de la page courante de façon générique :
 * une ligne par `<tr>` du corps, chaque cellule indexée par le LIBELLÉ de
 * sa colonne d'en-tête (jamais une position fixe) — voir `FbiScheduleRow`
 * (types.ts), qui construit ses champs connus à partir de ce dictionnaire
 * tout en conservant les colonnes non modélisées dans `raw`. `null` quand
 * la page courante n'a pas la forme d'un tableau de résultats (pas d'en-tête
 * exploitable) — jamais un tableau vide silencieusement pris pour "zéro
 * rencontre".
 *
 * `scope` (§ "jen ai que 8", docs/FBI.md, 2026-09-27) — `page` elle-même
 * (comportement HISTORIQUE, toujours utilisé par `fetchScheduleRows`) ou
 * un `Locator` plus étroit : passer `page` fait matcher `page.locator
 * ("table ...")` N'IMPORTE QUEL `<table>` de TOUTE la page, y compris des
 * tableaux SANS RAPPORT (menu, mise en page) si le vrai tableau de
 * résultats n'a pas encore de lignes au moment de la lecture — cause
 * confirmée d'un résultat incohérent (3 lignes, aucune ne correspondant
 * aux colonnes attendues) en production sur `rechercherDerogation.fbi`.
 * Les appelants dérogations passent `selectors.derogationResultsContainer(page)`
 * pour scoper la lecture au VRAI conteneur des résultats, jamais toute la
 * page.
 */
export async function resultsTableGenericRows(scope: Page | Locator): Promise<Record<string, string>[] | null> {
  const headerCells = scope.locator("table th, table thead td");
  const headerTexts = (await headerCells.allTextContents().catch(() => [])).map((t) => t.trim());
  if (headerTexts.length === 0 || headerTexts.every((t) => t === "")) return null;

  // Instantané UNIQUE de toutes les cellules (un seul aller-retour, sans attente automatique de Playwright).
  // Lire cellule par cellule avec `locator.textContent()` attendait jusqu'à 30 s une cellule disparue quand
  // l'AJAX de FBI rafraîchissait le tableau entre le `count()` et la lecture (blocages intermittents de
  // fetchAllDerogations sur Chromium 156 en CI, B3). `evaluateAll` sur zéro ligne renvoie [] sans attendre.
  const grid = await scope
    .locator("table tbody tr")
    .evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? "")))
    .catch(() => [] as string[][]);

  const results: Record<string, string>[] = [];
  for (const cells of grid) {
    if (cells.length === 0) continue;

    const record: Record<string, string> = {};
    for (let col = 0; col < Math.min(cells.length, headerTexts.length); col += 1) {
      const header = headerTexts[col];
      if (!header) continue;
      record[header] = (cells[col] ?? "").trim();
    }
    results.push(record);
  }

  return results;
}

/**
 * Contrôle "page suivante" de la pagination du tableau de résultats —
 * confirmé en production le 2026-09-25 (capture d'écran du VRAI FBI,
 * fournie par le club) : liens numérotés "Précédent 1 2 3 … Suivant" en
 * pied de tableau.
 *
 * **Bug corrigé le 2026-09-27 (dixième round dérogations, HTML source réel
 * du bouton fourni par le club après un rapport "il y a + de 80
 * dérogations" alors que la recherche n'en ramenait jamais que ~20-23,
 * TOUJOURS la même quantité peu importe la date/l'heure — signe d'un
 * problème structurel, pas d'un aléa de timing)** : le VRAI bouton est
 * `<a class="paginate_button next" ...>Suivant</a>` — SANS attribut
 * `href`. Un `<a>` sans `href` n'a AUCUN rôle ARIA "link" implicite (règle
 * HTML/ARIA : le rôle "link" d'un `<a>` dépend de la présence de `href`) —
 * `page.getByRole("link", ...)` ne pouvait donc JAMAIS le trouver
 * (`count() === 0`), quelle que soit la page. Le rôle "button" ne
 * matchait pas non plus (pas de `role="button"` ni de `<button>` réel).
 * `collectAllDerogationsWithDetail`/`collectAllResultPages`
 * s'arrêtaient alors systématiquement après la 1ère page, croyant qu'il
 * n'y en avait qu'une — jamais un problème de lecture prématurée du
 * tableau (déjà traité par ailleurs), un problème de SÉLECTEUR pur.
 *
 * Cherché maintenant PAR CLASSE CSS `paginate_button` (convention
 * DataTables CONFIRMÉE par ce HTML réel, jamais devinée par analogie
 * cette fois) EN PRIORITÉ, avec un repli par texte visible ("Suivant")
 * au cas où une autre page FBI utiliserait un vrai lien/bouton
 * accessible. `null`/absent quand pas de pagination (un seul écran de
 * résultats) ; désactivé sur la dernière page via la classe `disabled`
 * sur CE MÊME élément (jamais un `<li>` ancêtre deviné — voir l'appelant,
 * qui vérifie `isEnabled()` ET l'absence de cette classe avant de
 * cliquer).
 */
export function nextPageControl(page: Page): Locator {
  return page
    .locator('a.paginate_button.next, button.paginate_button.next, a.paginate_button.next, [class*="paginate_button"][class*="next" i]')
    .or(page.getByRole("link", { name: /^suivant$/i }))
    .or(page.getByRole("button", { name: /^suivant$/i }));
}

/**
 * Sélecteur "Afficher X entrées" (contrôle de longueur de page) de
 * DataTables — l'`id` réel du bouton "Suivant" confirmé par le club le
 * 2026-09-27 (`id="rechercherDerogationAjax_next"`) suit la convention
 * DataTables `<idTable>_next`/`<idTable>_previous`/`<idTable>_length`/
 * `<idTable>_filter`/`<idTable>_info` — CODÉE EN DUR dans la librairie
 * DataTables elle-même (jamais personnalisée par FBI), donc un `<select
 * name="rechercherDerogationAjax_length">` existe très probablement à
 * côté, jamais une supposition par analogie hasardeuse cette fois.
 *
 * Constaté en production le 2026-09-27 (§ "Toujours incomplet malgré 5
 * pages", docs/FBI.md) : `pageCount` confirme bien 5 pages RÉELLEMENT
 * lues, mais `rawRowCount` (97) très supérieur à `keptRowCount` après
 * dédoublonnage (51) — signe d'une pagination cliquée "Suivant" côté
 * serveur qui RE-TRIE/RE-FENÊTRE le jeu de résultats à chaque page
 * (instabilité classique de la pagination "offset" côté serveur d'un tri
 * non parfaitement déterministe), faisant apparaître certaines lignes
 * plusieurs fois et probablement en sauter d'autres. Choisir la plus
 * grande longueur de page disponible (ou "Tous"/`-1`) affiche TOUT en une
 * seule page, contournant entièrement l'instabilité de la pagination —
 * voir `BrowserFbiClient` (browser-client.ts), qui l'essaie en best
 * effort avant de recourir à `nextPageControl`.
 */
export function resultsLengthSelect(page: Page): Locator {
  return page.locator('select[name$="_length" i], select[id$="_length" i], select[name*="_length" i]').first();
}

/**
 * Conteneur RÉEL du tableau de résultats des dérogations —
 * `rechercherDerogation.fbi`. DataTables enveloppe TOUJOURS son tableau
 * dans un `<div id="<idTable>_wrapper">` (même famille de convention CODÉE
 * EN DUR dans la librairie que `<idTable>_next`/`_previous`/`_length`,
 * déjà confirmée réelle sur le bouton "Suivant" le 2026-09-27) : le
 * `aria-controls="rechercherDerogationAjax"` de ce bouton (HTML source
 * réel fourni par le club) révèle que le VRAI id de la table est
 * `rechercherDerogationAjax` — jamais `getTableauDerogation`, une
 * supposition antérieure jamais confirmée par du HTML réel.
 *
 * Scoper les lectures à ce conteneur (au lieu de "n'importe quel `<table>`
 * de la page", voir `resultsTableGenericRows`) corrige une lecture
 * incohérente constatée en production (§ "jen ai que 8", docs/FBI.md,
 * 2026-09-27) : 3 lignes ne correspondant à AUCUNE colonne attendue,
 * signe que `page.locator("table ...")` lisait un tableau SANS RAPPORT
 * ailleurs sur la page tant que le vrai tableau de résultats n'avait pas
 * encore de lignes.
 *
 * Repli sur `#rechercherDerogationAjax` seul (sans le wrapper, jamais
 * confirmé aussi précisément que l'id de la table) si le wrapper n'existe
 * pas — jamais un échec dur si aucun des deux n'est trouvé, l'appelant
 * retombe alors sur `page` entière (comportement d'avant ce correctif).
 */
export function derogationResultsContainer(page: Page): Locator {
  return page.locator("#rechercherDerogationAjax_wrapper, #rechercherDerogationAjax").first();
}

/**
 * Checkbox "non joué" (résultat pas encore saisi) du formulaire de
 * recherche — confirmé en production le 2026-09-24 (§ "Dix-neuvième
 * déclenchement", docs/FBI.md, dump complet des champs) : COCHÉE par
 * défaut sur `rechercherRencontreSaisieResultat.fbi`, name
 * `...rechercherRencontreSaisieResultatBean.nonJoue`. Cette page sert à
 * SAISIR des résultats, donc elle filtre naturellement aux rencontres
 * dont le résultat n'est pas encore saisi — jamais les matchs déjà
 * homologués, précisément ceux qui ont un document e-Marque disponible.
 * Doit être décochée avant toute recherche visant un match déjà joué.
 */
export function nonJoueCheckbox(page: Page): Locator {
  return page.locator('input[type="checkbox"][name*="nonJoue" i]').first();
}

/**
 * Sélecteur de saison du formulaire de recherche — confirmé en
 * production le 2026-09-24 : `select` dont le `name` contient "saison"
 * (`...rechercherRencontreSaisieResultatBean.idSaison`), défaute sur la
 * saison EN COURS. Un match d'une saison passée n'apparaît jamais dans
 * les résultats tant que ce sélecteur n'est pas ajusté sur SA saison.
 */
export function seasonSelect(page: Page): Locator {
  return page.locator('select[name*="saison" i]').first();
}

/**
 * Sélecteur de division/poule du formulaire de recherche — `select` dont
 * le `name` contient "division" (`...rechercherRencontreSaisieResultatBean.idDivision`).
 * Vide par défaut ("Division"), ses options portent un LIBELLÉ du type
 * "0034 - Plateaux - BU15MN1" (jamais une valeur devinable, un ID interne
 * FFBB opaque type "200000002899671") et une valeur (`value`) VIDE laisse
 * le filtre non appliqué côté serveur.
 *
 * Constaté en production le 2026-09-30 (job 3f0d54ad, match 312f32c0) :
 * laisser ce filtre VIDE en misant uniquement sur la comparaison de la
 * colonne "Division" du tableau de RÉSULTATS (voir `resultsTableColumns`)
 * ne suffit pas — une recherche par numéro seul, sans division sélectionnée
 * ICI dans le FORMULAIRE, peut renvoyer un tableau de résultats
 * COMPLÈTEMENT VIDE (aucune ligne, quelle que soit sa division) plutôt que
 * "toutes les divisions confondues" comme on pourrait le supposer — la
 * page semble nécessiter une division explicite pour retourner quoi que ce
 * soit de fiable. Sélectionner la division ICI, en amont, est donc requis
 * en plus du filtre en aval sur le tableau de résultats.
 */
export function divisionSelect(page: Page): Locator {
  return page.locator('select[name*="division" i]').first();
}

/**
 * Diagnostic — dump du HTML BRUT du formulaire de RECHERCHE (jamais "le
 * premier `<form>` de la page"), plafonné.
 *
 * Constaté en production le 2026-09-24 (§ "Vingt-cinquième déclenchement",
 * docs/FBI.md) : `page.locator("form").first()` (version initiale de cette
 * fonction) renvoyait `<form id="identificationEntete" ...>` — un MINUSCULE
 * formulaire d'en-tête (juste 3 champs cachés d'identification) qui précède
 * le vrai formulaire de recherche dans le DOM. `listFormFields` (qui lit
 * DANS TOUS les formulaires de la page, jamais juste le premier) montrait
 * bien les vrais champs de recherche — d'où l'incohérence entre un dump de
 * champs pertinent et un dump HTML complètement à côté de la plaque.
 *
 * Ancré maintenant sur `seasonSelect` (un champ connu du VRAI formulaire de
 * recherche) puis remonté à SON `<form>` ancêtre — même principe que
 * `loginForm` (`passwordInput(page).locator("xpath=ancestor::form[1]")`)
 * plus haut dans ce fichier, jamais une position DOM devinée.
 */
export async function formHtmlSnippet(page: Page, maxLength = 4000): Promise<string> {
  const anchor = seasonSelect(page);
  const anchorFound = (await anchor.count().catch(() => 0)) > 0;
  const form = anchorFound ? anchor.locator("xpath=ancestor::form[1]") : page.locator("form").first();

  if ((await form.count().catch(() => 0)) === 0) return "(aucun <form> trouvé sur la page)";

  const html = await form.evaluate((node) => node.outerHTML).catch(() => null);
  if (!html) return "(HTML du formulaire illisible)";

  return html.length > maxLength ? `${html.slice(0, maxLength)}… (tronqué, ${html.length} caractères au total)` : html;
}

/**
 * Diagnostic — dump du HTML BRUT autour du bouton "Rechercher" et du champ
 * numéro de rencontre spécifiquement, jamais le formulaire entier.
 *
 * Constaté en production le 2026-09-24 (§ "Vingt-sixième déclenchement",
 * docs/FBI.md) : le vrai formulaire de recherche fait ~43000 caractères
 * (le sélecteur "Division" seul liste des centaines d'`<option>`) —
 * `formHtmlSnippet` (plafonné à 4000 caractères) se coupe systématiquement
 * bien avant d'atteindre le bouton "Rechercher" ou le champ numéro,
 * pourtant les deux éléments les plus pertinents pour comprendre pourquoi
 * la recherche ne renvoie jamais de résultat. Cible directement leur
 * conteneur ancêtre le plus proche (jamais tout le formulaire).
 */
export async function searchControlsHtmlSnippet(page: Page, maxLength = 3000): Promise<string> {
  const button = searchSubmitControl(page).first();
  if ((await button.count().catch(() => 0)) === 0) return "(bouton de recherche introuvable)";

  const container = button.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' row ')][1]");
  const target = (await container.count().catch(() => 0)) > 0 ? container : button;

  const html = await target.evaluate((node) => node.outerHTML).catch(() => null);
  if (!html) return "(HTML du bouton de recherche illisible)";

  return html.length > maxLength ? `${html.slice(0, maxLength)}… (tronqué, ${html.length} caractères au total)` : html;
}

/**
 * Lit les champs de détail d'une dérogation (`afficherDerogation.fbi`) —
 * confirmés par le HTML SOURCE réel de DEUX dérogations différentes,
 * fourni par le club le 2026-09-25 (jamais une capture d'écran seule
 * cette fois) : les champs sont des `<input disabled>`/`<textarea
 * readonly>` classiques, chacun avec un `id` STABLE identique sur les
 * deux exemples (`demandeurLibelle`, `motif`, `dateDerogation` — le
 * "Date rencontre" DEMANDÉ, dans "Demande de dérogation" —, `horaireHour`,
 * `adversaire`, `reponseAdversaireDate`, `acceptation` [affiche en fait
 * `acceptationLibelle`], `motifRefus`).
 *
 * ⚠️ La toute première version de ce lecteur (avant d'avoir ce HTML)
 * lisait le texte visible de la page via `innerText()`, en supposant à
 * tort un layout "libellé au-dessus de la valeur" tiré d'une CAPTURE
 * D'ÉCRAN — ça ne pouvait structurellement pas marcher : `innerText()` ne
 * contient JAMAIS la `value` d'un `<input>`/`<textarea>`, uniquement le
 * texte "en dur" du DOM. D'où motif/dates demandées systématiquement
 * vides en production. Corrigé en lisant directement `.inputValue()` de
 * chaque champ par son `id` confirmé.
 *
 * `input#dateDerogation` (jamais juste `#dateDerogation`) : le vrai HTML
 * a un `id="dateDerogation"` en DOUBLE — une fois sur le `<div>`
 * englobant, une fois sur le vrai `<input>` à l'intérieur (HTML invalide
 * mais bien réel) — un sélecteur `#dateDerogation` seul retomberait sur
 * le `<div>` (premier du document) et `.inputValue()` y échouerait.
 *
 * `null` quand la page courante n'a pas la forme attendue (`#demandeurLibelle`
 * absent), jamais un objet à champs vides silencieusement pris pour "rien
 * à lire" (même discipline que `resultsTableGenericRows`).
 */
export async function derogationDetailFields(page: Page): Promise<FbiDerogationDetailFields | null> {
  const marker = page.locator("input#demandeurLibelle");
  if ((await marker.count().catch(() => 0)) === 0) return null;

  const readValue = async (selector: string): Promise<string | null> => {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) return null;
    const value = await locator.inputValue().catch(() => null);
    return value && value.trim().length > 0 ? value.trim() : null;
  };

  return {
    demandeur: await readValue("input#demandeurLibelle"),
    motif: await readValue("textarea#motif"),
    dateRencontreDemandee: await readValue("input#dateDerogation"),
    heureDemandee: await readValue("input#horaireHour"),
    adversaire: await readValue("input#adversaire"),
    dateReponse: await readValue("input#reponseAdversaireDate"),
    acceptation: await readValue("input#acceptation"),
    motifRefus: await readValue("textarea#motifRefus"),
    dateDepotDetail: await readValue("input#dateDepot"),
    modifierDate: await readChecked(page, "modifierDate"),
    modifierHoraire: await readChecked(page, "modifierHoraire"),
    modifierSalle: await readChecked(page, "modifierSalle"),
    salleDemandee: await readValue('input#nomSalle, input[name$=".libelleSalle"], input[id$="_libelleSalle"], input[id$="_nomSalle"]'),
    inverserRencontre: await readChecked(page, "inverserRencontre"),
    inverserEquipe: await readChecked(page, "inverserEquipe"),
  };
}

/** État d'une case du formulaire de dérogation (id réel), `null` si la case n'existe pas sur la page. */
async function readChecked(page: Page, field: string): Promise<boolean | null> {
  // Page de CONSULTATION (relevé réel du 2026-10-08) : ids générés par FBI
  // ("afficherDerogation_derogationForm_derogationDemandeBean_<champ>"),
  // seul "modifierSalle" garde un id court — le `name` du champ
  // ("derogationForm.derogationDemandeBean.<champ>") est commun aux pages.
  const box = page.locator(`input[type="checkbox"][name$=".${field}"], input[type="checkbox"]#${field}, input[type="checkbox"][id$="_${field}"]`).first();
  if ((await box.count().catch(() => 0)) === 0) return null;
  return await box.isChecked().catch(() => null);
}

/**
 * Forme réelle de la page de détail (preuve, 2026-10-08) : cases à cocher
 * présentes (id + état) et présence du champ salle — jamais de valeur
 * saisie, uniquement des identifiants de champs et des booléens.
 */
export async function derogationDetailShape(page: Page): Promise<DerogationDetailShape> {
  const boxes = page.locator('input[type="checkbox"]');
  const count = Math.min(await boxes.count().catch(() => 0), 20);
  const checkboxes: DerogationDetailShape["checkboxes"] = [];
  for (let i = 0; i < count; i += 1) {
    const box = boxes.nth(i);
    checkboxes.push({
      id: ((await box.getAttribute("id").catch(() => null)) ?? "").slice(0, 120),
      name: ((await box.getAttribute("name").catch(() => null)) ?? "").slice(0, 120),
      checked: await box.isChecked().catch(() => false),
    });
  }
  // Champs dont l'id ou le name évoque la salle : identifiants + présence d'une valeur (jamais la valeur).
  const salleInputs = page.locator('input[id*="alle"], input[name*="alle"], select[id*="alle"], select[name*="alle"]');
  const salleCount = Math.min(await salleInputs.count().catch(() => 0), 10);
  const salleFields: DerogationDetailShape["salleFields"] = [];
  for (let i = 0; i < salleCount; i += 1) {
    const field = salleInputs.nth(i);
    salleFields.push({
      id: ((await field.getAttribute("id").catch(() => null)) ?? "").slice(0, 120),
      name: ((await field.getAttribute("name").catch(() => null)) ?? "").slice(0, 120),
      hasValue: Boolean((await field.inputValue().catch(() => "")).trim()),
    });
  }
  return { checkboxes, salleFields, hasNomSalle: (await page.locator("input#nomSalle").count().catch(() => 0)) > 0 };
}

export interface DerogationDetailShape {
  checkboxes: Array<{ id: string; name: string; checked: boolean }>;
  salleFields: Array<{ id: string; name: string; hasValue: boolean }>;
  hasNomSalle: boolean;
}
