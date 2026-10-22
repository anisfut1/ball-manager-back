import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestServer, readFixture } from "../../test-support/static-server.js";
import { BrowserFbiClient } from "./browser-client.js";
import { FbiError } from "./errors.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFixture(path.join(dirname, "__fixtures__", name));

let browser: Browser;
let server: TestServer;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
  server = new TestServer();
  await server.start();
});

afterAll(async () => {
  await browser.close();
  await server.stop();
});

beforeEach(() => {
  server.setRoute({ path: "/connexion.fbi", contentType: "text/html", body: fixture("login.html") });
  server.setRoute({ path: "/j_security_check", method: "POST", contentType: "text/html", body: fixture("accueil.html") });
  server.setRoute({ path: "/accueil.fbi", contentType: "text/html", body: fixture("accueil.html") });
  // Écran de recherche RÉEL confirmé par capture d'écran du vrai FBI le
  // 2026-09-24 (§ "Dix-huitième déclenchement", docs/FBI.md) — jamais deviné.
  server.setRoute({ path: "/rechercherRencontreSaisieResultat.fbi", contentType: "text/html", body: fixture("rechercher-rencontre.html") });
  // Écran de recherche des dérogations, confirmé par capture d'écran du vrai
  // FBI le 2026-09-25 (URL copiée par le club depuis sa barre d'adresse).
  server.setRoute({ path: "/rechercherDerogation.fbi", contentType: "text/html", body: fixture("rechercher-derogation.html") });
  // Page de détail d'une dérogation — le serveur de test route par CHEMIN
  // seulement (query string ignorée), donc toute ligne cliquée renvoie
  // cette même fixture (voir commentaire dans rechercher-derogation.html).
  server.setRoute({ path: "/afficherDerogation.fbi", contentType: "text/html", body: fixture("afficher-derogation.html") });
  server.setRoute({ path: "/detail.fbi", contentType: "text/html", body: fixture("detail.html") });
  server.setRoute({ path: "/export/2813.zip", contentType: "application/zip", body: Buffer.from("contenu-zip-synthetique") });
  server.setRoute({
    path: "/export/piece-jointe.zip",
    contentType: "application/zip",
    headers: { "content-disposition": 'attachment; filename="emarque.zip"' },
    body: Buffer.from("contenu-zip-piece-jointe"),
  });
  // Beacon fetch() déclenché par la fixture rechercher-rencontre.html au
  // clic sur "Rechercher" — reproduit une vraie requête XHR/fetch pour
  // vérifier que la capture réseau (§ "Vingt-septième déclenchement",
  // docs/FBI.md) fonctionne réellement, pas seulement son repli "aucune
  // requête capturée".
  server.setRoute({ path: "/telemetry-beacon", method: "POST", contentType: "application/json", body: JSON.stringify({ received: true }) });
  // Beacon fetch() déclenché par le lien EM sans href de la rencontre
  // n°5555 (§ "Vingt-huitième déclenchement", docs/FBI.md) — vérifie que
  // tryOpenMatchResult capture aussi le réseau autour de CE clic précis.
  server.setRoute({ path: "/em-click-beacon", method: "POST", contentType: "application/json", body: JSON.stringify({ received: true }) });
});

describe("BrowserFbiClient.login (contre un serveur HTML local synthétique, jamais le vrai FBI)", () => {
  it("détecte dynamiquement le formulaire, se connecte, et détecte le succès par l'absence de champ mot de passe", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });

    const session = await client.login({ username: "club1234", password: "secret" });

    expect(session.page.url()).not.toContain("connexion.fbi");
    await client.closeSession(session);
  });

  it("reprend une session conservée sans renvoyer identifiant et mot de passe, et trace chaque requête (2026-10-06)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const first = await client.login({ username: "club1234", password: "secret" });
    expect(first.reused).toBeFalsy();
    expect(client.lastTrace?.events.some((event) => event.u === "/connexion.fbi" && event.s === 200)).toBe(true);
    const saved = await client.exportSessionState(first);
    await client.detachSession(first);

    const second = await client.login({ username: "club1234", password: "secret" }, { savedState: saved ?? undefined });
    expect(second.reused).toBe(true);
    expect(client.lastTrace?.events.map((event) => event.u)).toEqual(expect.arrayContaining(["/accueil.fbi"]));
    expect(client.lastTrace?.events.some((event) => event.u === "/connexion.fbi")).toBe(false);
    await client.closeSession(second);
  });

  it("session conservée expirée côté FBI : reconnexion normale avec identifiant et mot de passe", async () => {
    server.setRoute({ path: "/accueil.fbi", contentType: "text/html", body: fixture("login.html") });
    try {
      const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
      const session = await client.login({ username: "club1234", password: "secret" }, { savedState: '{"cookies":[],"origins":[]}' }).catch((error: unknown) => error);
      // Reprise refusée (page de connexion) → parcours identifiant/mot de passe, qui passe par connexion.fbi.
      expect(client.lastTrace?.events.some((event) => event.u === "/connexion.fbi")).toBe(true);
      if (!(session instanceof Error)) await client.closeSession(session as Awaited<ReturnType<typeof client.login>>);
    } finally {
      server.setRoute({ path: "/accueil.fbi", contentType: "text/html", body: fixture("accueil.html") });
    }
  });

  it("lève LOGIN_FAILED quand la page d'atterrissage est encore une page de connexion (identifiants invalides)", async () => {
    server.setRoute({ path: "/j_security_check", method: "POST", contentType: "text/html", body: fixture("login.html") });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });

    await expect(client.login({ username: "club1234", password: "mauvais" })).rejects.toMatchObject({ code: "LOGIN_FAILED" });
  });

  it("lève LOGIN_FORM_NOT_RECOGNIZED si la page de connexion ne contient aucun champ mot de passe", async () => {
    server.setRoute({ path: "/connexion.fbi", contentType: "text/html", body: "<html><body>Page inattendue</body></html>" });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });

    await expect(client.login({ username: "x", password: "y" })).rejects.toMatchObject({ code: "LOGIN_FORM_NOT_RECOGNIZED" });
  });

  it("lève LOGIN_PAGE_UNREACHABLE si la page de connexion est injoignable", async () => {
    const client = new BrowserFbiClient({ baseUrl: "http://127.0.0.1:1", browser, navigationSettleMs: 50 });

    await expect(client.login({ username: "x", password: "y" })).rejects.toMatchObject({ code: "LOGIN_PAGE_UNREACHABLE" });
  });

  it("isole chaque session dans son propre contexte navigateur (jamais de cookie partagé entre deux connexions)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });

    const sessionA = await client.login({ username: "club-a", password: "secret" });
    const sessionB = await client.login({ username: "club-b", password: "secret" });

    expect(sessionA.context).not.toBe(sessionB.context);

    await client.closeSession(sessionA);
    await client.closeSession(sessionB);
  });
});

describe("BrowserFbiClient.isSessionValid", () => {
  it("retourne false une fois la session considérée expirée (page de connexion renvoyée)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    server.setRoute({ path: "/accueil.fbi", contentType: "text/html", body: fixture("login.html") });
    const valid = await client.isSessionValid(session);

    expect(valid).toBe(false);
    await client.closeSession(session);
  });
});

describe("BrowserFbiClient.findEmarqueDocuments (§ 'Dix-huitième déclenchement', docs/FBI.md : navigation confirmée par capture d'écran du vrai FBI, jamais devinée)", () => {
  it("navigue directement vers l'écran de recherche RÉEL, remplit N° Rencontre (jamais la checkbox « non joué » qui précède ce champ dans le DOM), et clique le lien de la colonne EM pour trouver les documents — régression production 2026-09-24 : § 'Dix-neuvième déclenchement', docs/FBI.md", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const { documents } = await client.findEmarqueDocuments(session, "2813");

    expect(documents).toContainEqual(expect.objectContaining({ fileName: "2813.zip" }));
    expect(documents.some((d) => /feuille/i.test(d.fileName) || d.url.includes("feuille"))).toBe(true);
    expect(documents.some((d) => d.url.includes("autre-lien-sans-rapport"))).toBe(false);

    await client.closeSession(session);
  });

  it("exclut le lien-leurre de téléchargement du LOGICIEL e-Marque, déduplique un même lien répété dans le DOM, et évite toute collision de nom de fichier entre deux documents distincts au libellé identique — régression production 2026-09-24 : rencontre n°1481 RÉELLEMENT réussie, mais avait téléchargé \"Télécharger e-Marque V2.pdf\" (logiciel, pas les données du match) et 3 copies d'un même document sous le nom générique \"e-Marque.pdf\" qui s'écrasaient en Storage (§ 'Vingt-deuxième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const { documents } = await client.findEmarqueDocuments(session, "2813");

    // Le lien-leurre logiciel (fixture detail.html : "Télécharger e-Marque
    // V2" → /logiciel/emarque-v2.pdf) ne doit JAMAIS apparaître.
    expect(documents.some((d) => d.url.includes("emarque-v2.pdf") || /v ?2/i.test(d.fileName))).toBe(false);

    // Les deux liens vers /telechargerDocument.fbi?id=aaa (dupliqués deux
    // fois dans le DOM de la fixture) ne doivent produire qu'UN seul
    // document, jamais deux copies du même.
    const aaaDocs = documents.filter((d) => d.url.includes("id=aaa"));
    expect(aaaDocs).toHaveLength(1);

    // id=aaa et id=bbb partagent le même libellé visible ("e-Marque") mais
    // sont des documents DIFFÉRENTS : leurs noms de fichier dérivés ne
    // doivent jamais entrer en collision (sinon l'un écrase l'autre dans
    // Storage, comme constaté en production).
    const bbbDocs = documents.filter((d) => d.url.includes("id=bbb"));
    expect(bbbDocs).toHaveLength(1);
    expect(aaaDocs[0].fileName).not.toBe(bbbDocs[0].fileName);

    await client.closeSession(session);
  });

  it("renvoie une liste vide (jamais une erreur) quand la rencontre existe dans le tableau de résultats mais que sa colonne EM est vide (pas encore jouée / sans e-Marque)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    // "9999" est présente dans rechercher-rencontre.html (fixture) avec une
    // colonne EM vide : emarqueColumnLinkForMatch ne trouve rien à cliquer,
    // on reste sur la page de résultats — qui mentionne bien "9999" (colonne
    // N°), donc PAS d'EMARQUE_MATCH_PAGE_NOT_REACHED — mais ne contient
    // aucun lien de document, donc une liste vide.
    const { documents, diagnostic } = await client.findEmarqueDocuments(session, "9999");

    expect(documents).toEqual([]);
    // Régression production 2026-09-24 (§ "Vingt-septième déclenchement") :
    // le diagnostic riche est désormais renvoyé à l'appelant (pas juste
    // loggé) pour être persisté dans fbi_jobs.last_error, consultable
    // directement en base sans dépendre des logs Vercel.
    expect(diagnostic).toContain("[info, pas une erreur]");
    expect(diagnostic).toContain("9999");
    await client.closeSession(session);
  });

  it("capture le réseau AUTOUR du clic sur un lien EM sans href (onclick JS) — reproduit le VRAI pattern FBI observé en production (n°1481, <a onclick=\"telechargerMatch(...)\">, aucun href) au lieu du lien classique deviné à tort (§ 'Vingt-huitième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const { documents, diagnostic } = await client.findEmarqueDocuments(session, "5555");

    // findDocumentLinks (page.locator("a[href]")) ne peut rien trouver après
    // ce clic : la fixture reproduit un onclick sans navigation ni lien
    // navigable resté sur la page, comme le vrai telechargerMatch() en
    // production — documents reste vide ICI (cette fixture déclenche un
    // simple fetch() de télémétrie, jamais un vrai téléchargement natif du
    // navigateur — simuler un événement `download` réel dans ce harnais
    // Chromium headless a fait planter Vitest pendant 30s à plusieurs
    // reprises, voir la note ci-dessous et docs/FBI.md § "Vingt-huitième
    // déclenchement"). Le vrai fix — capturer un téléchargement natif comme
    // document (§ "Vingt-neuvième déclenchement") — est validé sur preuve
    // de production (rencontre n°1481) plutôt que par une simulation de
    // téléchargement ici, volontairement.
    expect(documents).toEqual([]);
    expect(diagnostic).toContain('lien EM "" cliqué');
    expect(diagnostic).toContain("requêtes réseau capturées après le clic EM");
    expect(diagnostic).toContain("/em-click-beacon");

    await client.closeSession(session);
  });

  it("lève EMARQUE_MATCH_PAGE_NOT_REACHED (jamais un faux succès) quand la rencontre n'apparaît nulle part dans le tableau de résultats", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    // Aucune ligne "77777" dans rechercher-rencontre.html (fixture) : ni
    // emarqueColumnLinkForMatch ni pageMentionsMatchNumber ne peuvent
    // matcher.
    await expect(client.findEmarqueDocuments(session, "77777")).rejects.toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });

    await client.closeSession(session);
  });

  it("lève EMARQUE_MATCH_PAGE_NOT_REACHED même pour un numéro de rencontre court (\"1\") qui apparaît par hasard comme fragment d'un autre nombre sur la page — régression production 2026-09-24 : un simple .includes(\"1\") matchait n'importe quel nombre contenant 1 (ex: \"2813\"), faisant \"réussir\" la rencontre n°1 alors qu'aucune ligne \"1\" n'existe dans le tableau", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    await expect(client.findEmarqueDocuments(session, "1")).rejects.toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });

    await client.closeSession(session);
  });

  it("inclut une trace de navigation étape par étape ET les liens visibles dans le message d'erreur — diagnostic pour ajuster la navigation sur preuve, jamais à l'aveugle (§ 'Seizième/Dix-septième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const error = await client.findEmarqueDocuments(session, "77777").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });
    expect((error as Error).message).toContain("Trace de navigation");
    expect((error as Error).message).toContain("Liens visibles sur cette page");
    // Régression production 2026-09-24 (§ "Vingt-quatrième déclenchement") :
    // saison/case correctement ajustées, bon bouton cliqué, toujours aucun
    // résultat — le HTML brut du formulaire est désormais inclus pour voir
    // la structure réelle des widgets plutôt que deviner une 5e fois.
    expect((error as Error).message).toContain("HTML du formulaire");
    expect((error as Error).message).toContain('name="idSaison"');
    // Régression production 2026-09-24 (§ "Vingt-cinquième déclenchement") :
    // le premier <form> de la fixture est un DÉCOY (identificationEntete,
    // mêmes 3 champs cachés que le vrai formulaire d'en-tête FBI) — le dump
    // doit venir du VRAI formulaire de recherche, jamais de celui-là.
    expect((error as Error).message).not.toContain("identificationEntete");
    // Régression production 2026-09-24 (§ "Vingt-sixième déclenchement") :
    // le vrai formulaire FBI fait ~43000 caractères (liste de divisions) —
    // le dump plafonné du formulaire entier se coupe AVANT d'atteindre le
    // bouton de recherche/le champ numéro. Un dump ciblé sur leur conteneur
    // doit les inclure malgré la troncature du formulaire complet.
    expect((error as Error).message).toContain("HTML autour du bouton de recherche");
    expect((error as Error).message).toContain('name="numeroRencontre"');
    expect((error as Error).message).toContain("RECHERCHER");
    expect((error as Error).message).toContain("(tronqué"); // preuve que le formulaire complet dépasse bien la limite dans ce test
    // Régression production 2026-09-24 (§ "Vingt-septième déclenchement") :
    // capture réseau du clic sur "Rechercher" — plus jamais deviner depuis
    // le DOM ce que fait réellement le clic. La fixture déclenche un
    // fetch() POST vers /telemetry-beacon au clic (en plus de sa soumission
    // GET classique, jamais interrompue) ; le message doit capturer cette
    // requête (méthode, URL, corps envoyé). Sa navigation immédiate (GET
    // classique non bloquée) fait généralement échouer la lecture du corps
    // de la réponse (course avec la navigation) — comportement attendu, pas
    // une régression : le message le signale ("réponse illisible") plutôt
    // que de planter ou de rester muet.
    expect((error as Error).message).toContain("requêtes réseau capturées");
    expect((error as Error).message).toContain("POST");
    expect((error as Error).message).toContain("/telemetry-beacon");
    expect((error as Error).message).toContain('corps envoyé (24 car.) : {"event":"search_click"}');

    await client.closeSession(session);
  });

  it("inclut le nom du champ ciblé (jamais supposé) ET un dump des champs de formulaire, y compris l'option sélectionnée d'un <select> — diagnostic ajouté après une recherche \"réussie\" sans aucun résultat en production (§ 'Dix-neuvième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const error = await client.findEmarqueDocuments(session, "77777").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });
    const message = (error as Error).message;
    expect(message).toContain('champ "numeroRencontre" rempli');
    expect(message).toContain("Champs de formulaire sur cette page");
    expect(message).toContain('select[name=idSaison]="Saison 2026-2027"');
    // Régression production 2026-09-24 (§ "Vingtième déclenchement") :
    // le dump n'incluait pas les <button>, impossible de vérifier quel
    // bouton searchSubmitControl avait réellement ciblé.
    expect(message).toContain('button[type=submit,name=]="RECHERCHER"');
    expect(message).toContain('bouton "RECHERCHER" cliqué');
    // Et confondait la valeur de soumission fixe d'une checkbox ("true")
    // avec son état coché réel — corrigé pour lire isChecked(). Le dump
    // ci-dessous reflète la page rechargée par le serveur de test
    // STATIQUE (qui ignore les query params, sert toujours le fixture
    // par défaut — checkbox cochée) : preuve que le format "checked"
    // (jamais l'ancien "true" de l'attribut value) est bien utilisé.
    expect(message).toContain('input[type=checkbox,name=rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.nonJoue]="checked"');

    await client.closeSession(session);
  });

  it("décoche la case « non joué » (cochée par défaut) et sélectionne la saison du match AVANT de chercher — régression production 2026-09-24 : ces deux filtres par défaut empêchaient de trouver N'IMPORTE QUEL match déjà joué, quel que soit le numéro (§ 'Dix-neuvième déclenchement', docs/FBI.md)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const error = await client.findEmarqueDocuments(session, "77777", "2025-2026").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });
    const message = (error as Error).message;
    expect(message).toContain('case "non joué" décochée');
    expect(message).toContain('saison "Saison 2025-2026" sélectionnée');
    // Preuve que la sélection a réellement été SOUMISE (pas juste rapportée
    // dans la trace) : l'étape [3] montre l'URL après soumission du
    // formulaire, qui inclut la valeur ("12") de l'option "Saison
    // 2025-2026" choisie. Le dump des champs de formulaire, lui, reflète
    // la page rechargée par le serveur de test STATIQUE (qui ignore les
    // query params et sert toujours le même fixture par défaut) — pas
    // représentatif de la vraie page FBI, qui refléterait la sélection
    // soumise ; on ne peut donc pas s'y fier ici.
    expect(message).toContain("idSaison=12");

    await client.closeSession(session);
  });

  it("sélectionne aussi la division du match AVANT de chercher — constaté en production le 2026-09-30 (job 3f0d54ad, match 312f32c0) : une recherche par numéro seul, sans division sélectionnée ICI, peut renvoyer un tableau de résultats entièrement VIDE, pas juste 'toutes divisions confondues'", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const error = await client.findEmarqueDocuments(session, "77777", null, "Division 42").catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "EMARQUE_MATCH_PAGE_NOT_REACHED" });
    const message = (error as Error).message;
    expect(message).toContain('division "Division 42 - Some Long Descriptive Label For Padding" sélectionnée');
    // Même preuve que pour la saison : l'URL après soumission inclut la
    // valeur ("42") de l'option choisie, donc réellement soumise au serveur.
    expect(message).toContain("idDivision=42");

    await client.closeSession(session);
  });
});

describe("BrowserFbiClient.findEmarqueDocuments — recherche directe (retour du club, 2026-10-02 : matchs sans stats)", () => {
  const emRow = (division: string, numero: string, em: string) => [
    "",
    `<div class='alignGauche' title='${division}'>${division}</div>`,
    `<div style='text-align: right'>${numero}</div>`,
    "A",
    "B",
    "<div>27/09/2026</div>",
    "<div>13:00</div>",
    "SALLE",
    em,
    "68",
    "",
    "75",
    "",
    "",
  ];
  const emLink = (token: string, id: string) => `<div><a class="emarquepictureafter emarqueV2${id}" onclick="telechargerMatch('${token}','${id}' )"></a></div>`;

  beforeEach(() => {
    server.setRoute({ method: "POST", path: "/rechercherRencontreSaisieResultat.fbi", action: "controleRecherche", contentType: "text/html", body: "<table><tbody></tbody></table>" });
    server.setRoute({
      path: "/rechercherRencontreSaisieResultat.fbi",
      action: "executeRecherche",
      contentType: "application/json",
      body: JSON.stringify({
        iTotalRecords: 3,
        aaData: [emRow("BU11MN2", "6", emLink("AAA%3D%3D", "1")), emRow("BU15MN1", "6", emLink("BBB%2F%3D", "2")), emRow("BU18MN2", "6", "<div></div>")],
      }),
    });
  });

  it("trouve le jeton EM de la BONNE division et renvoie l'URL de téléchargement directe — sans dépendre du clic sur l'icône", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const { documents, diagnostic } = await client.findEmarqueDocuments(session, "6", "2026-2027", "BU15MN1");

    expect(diagnostic).toBeNull();
    expect(documents).toEqual([{ url: `${server.baseUrl}/telechargerFeuilleMatchEmarque.fbi?action=emV2&plugin=true&idRenc=BBB%2F%3D`, fileName: "emarque_BU15MN1_6_2.zip" }]);
    // 2026-10-06 : l'écran de recherche n'est plus ouvert (son chargement expirait via le proxy).
    expect(session.page.url()).not.toContain("rechercherRencontreSaisieResultat");
    await client.closeSession(session);
  });

  it("passe par le fetch du navigateur : fonctionne même quand la pile réseau Node (context.request) est injoignable (ETIMEDOUT constaté en production)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });
    const realRequest = session.context.request;
    const brokenRequest = () => Promise.reject(new Error("apiRequestContext.post: connect ETIMEDOUT (test)"));
    Object.defineProperty(session.context, "request", { value: { post: brokenRequest, get: brokenRequest }, configurable: true });

    try {
      const { documents, diagnostic } = await client.findEmarqueDocuments(session, "6", "2026-2027", "BU15MN1");

      expect(diagnostic).toBeNull();
      expect(documents).toEqual([{ url: `${server.baseUrl}/telechargerFeuilleMatchEmarque.fbi?action=emV2&plugin=true&idRenc=BBB%2F%3D`, fileName: "emarque_BU15MN1_6_2.zip" }]);
    } finally {
      Object.defineProperty(session.context, "request", { value: realRequest, configurable: true });
      await client.closeSession(session);
    }
  });

  it("ligne trouvée sans lien EM : liste vide et diagnostic « pas une erreur » (nouvelle tentative plus tard)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 100 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const { documents, diagnostic } = await client.findEmarqueDocuments(session, "6", "2026-2027", "BU18MN2");

    expect(documents).toEqual([]);
    expect(diagnostic).toContain("[info, pas une erreur]");
    expect(diagnostic).toContain("BU18MN2");
    await client.closeSession(session);
  });
});

describe("BrowserFbiClient.fetchScheduleRows (rapprochement calendrier FFBB/FBI, voir docs/FBI.md)", () => {
  it("lit le tableau de résultats confirmé (même fixture que findEmarqueDocuments) par libellé d'en-tête, sur les deux passes 'non joué'", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const rows = await client.fetchScheduleRows(session);

    // La fixture ne réagit pas à l'état de la case "non joué" (serveur de
    // test statique) : les 3 lignes du tableau sont donc récupérées à
    // CHAQUE passe — 6 au total. Vérifie surtout que le contenu de chaque
    // ligne est correctement extrait par libellé de colonne, pas la
    // déduplication entre passes (non applicable ici, voir docs/FBI.md).
    expect(rows).toHaveLength(6);

    const match2813 = rows.find((r) => r.numero === "2813");
    expect(match2813).toMatchObject({
      division: "RM3",
      equipe1: "SC Sète",
      equipe2: "Thuir",
      dateRencontre: "27/09/2025",
      heure: "21:00",
      salle: "Gymnase",
      em: "DCBLRCA7",
      score1: "69",
    });

    await client.closeSession(session);
  });
});

describe("BrowserFbiClient.fetchDerogationForMatch (gestion des dérogations, voir docs/FBI.md)", () => {
  it("réinitialise 'Etat de la dérogation' sur 'Tous les états (sauf à créer)' PAR ATTRIBUT NAME (jamais en cherchant le <select> comme enfant du <label> — le vrai FBI place le label APRÈS le select, comme frère, pas autour)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    await client.fetchDerogationForMatch(session, "1");

    // La recherche est AJAX sur le vrai FBI (jamais de navigation) : l'état
    // réellement sélectionné au moment de la recherche se lit directement
    // sur le <select>, pas dans l'URL (qui ne change jamais).
    expect(await session.page.locator('select[name*="etat" i]').inputValue()).toBe("TT");
    await client.closeSession(session);
  });

  it("trouve la dérogation d'un match par numéro de rencontre ET division — le numéro seul n'est PAS unique au club (§ '82 vs 51', docs/FBI.md, 2026-09-27) : la fixture a deux rencontres n°1 (BU13FN23 et BU13MN2), désambiguïsées par division", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogation = await client.fetchDerogationForMatch(session, "1", "BU13FN23");

    expect(derogation).toMatchObject({
      numero: "1",
      division: "BU13FN23",
      domicile: "SPORT CLUB DE SETE BASKET - 1",
      visiteur: "CASTELNAU BASKET - 2",
      dateRencontre: "26/09/2026",
      heure: "15:30",
      etat: "Acceptée par l'organisme dirigeant",
    });

    await client.closeSession(session);
  });

  it("sans division connue, garde la dérogation la plus RÉCENTE (date de dépôt) parmi celles qui partagent le même numéro — jamais une ligne arbitraire", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    // Pas de division passée : les DEUX rencontres n°1 (BU13FN23, dépôt
    // 19/08 ; BU13MN2, dépôt 21/09) matchent — la plus récente (BU13MN2)
    // doit être retenue.
    const derogation = await client.fetchDerogationForMatch(session, "1");

    expect(derogation).toMatchObject({ numero: "1", division: "BU13MN2", etat: "Refusée" });

    await client.closeSession(session);
  });

  it("avec la division BU13MN2, trouve l'AUTRE rencontre n°1 (jamais celle de BU13FN23)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogation = await client.fetchDerogationForMatch(session, "1", "BU13MN2");

    expect(derogation).toMatchObject({
      numero: "1",
      division: "BU13MN2",
      domicile: "SPORT CLUB DE SETE BASKET - 2",
      visiteur: "PALAVAS BASKET CLUB - 1",
      etat: "Refusée",
    });

    await client.closeSession(session);
  });

  it("ouvre le détail de la ligne trouvée et ramène motif/dates demandées/réponse adversaire ('il me faut du détail... comme sur fbi')", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogation = await client.fetchDerogationForMatch(session, "1");

    expect(derogation).toMatchObject({
      demandeur: "Domicile",
      motif: "Gymnase indisponible ce jour-là",
      dateRencontreDemandee: "03/10/2026",
      heureDemandee: "20:00",
      adversaire: "CASTELNAU BASKET",
      dateReponse: null,
      acceptation: null,
      motifRefus: null,
    });
    // Le détail est lu dans un ONGLET SÉPARÉ (extraction directe du `href`
    // réel de la ligne, jamais un clic) — la page principale ne quitte
    // jamais rechercherDerogation.fbi, contrairement à l'ancien mécanisme
    // clic + page.goBack() (perdait le tableau AJAX pour la ligne suivante).
    expect(session.page.url()).toContain("rechercherDerogation.fbi");

    await client.closeSession(session);
  });

  it("renvoie null quand aucune dérogation n'existe pour ce numéro (cas normal, pas une erreur) — traverse aussi la ligne fantôme DataTables 'Aucune donnée disponible' sans planter ni la confondre avec une vraie dérogation", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogation = await client.fetchDerogationForMatch(session, "9999");

    expect(derogation).toBeNull();
    await client.closeSession(session);
  });

});

describe("BrowserFbiClient.fetchAllDerogations ('je veux un bouton global qui check toutes les demandes, pas match par match', voir docs/FBI.md)", () => {
  it("recherche à numéro VIDE et renvoie toutes les dérogations du club en une seule connexion, en EXCLUANT les rencontres 'A Créer' (régression du bug constaté en production : toutes les lignes ressortaient 'A Créer')", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogations = await client.fetchAllDerogations(session);

    // La fixture contient 5 rencontres : "1"/"9578" (Acceptée par
    // l'organisme dirigeant), "9820" (En Cours), "16" (Acceptée par les
    // deux associations sportives) et "2659" (A Créer) — les quatre
    // premières doivent ressortir sous "Tous les états", jamais "2659".
    expect(derogations.map((d) => d.numero).sort()).toEqual(["1", "1", "16", "9578", "9820"]);
    expect(derogations.every((d) => d.etat !== "A Créer")).toBe(true);
    expect(await session.page.locator('select[name*="etat" i]').inputValue()).toBe("TT");

    await client.closeSession(session);
  });

  it("vide EXPLICITEMENT 'Numéro de rencontre' avant de soumettre — dix-huitième round (2026-09-27, docs/FBI.md § 'Rencontre 23 uniquement') : constaté en production, une exécution n'a ramené QUE la rencontre '23' (deux jobs check_derogation pour ce numéro avaient tourné la veille) — le VRAI FBI retient la dernière valeur soumise CÔTÉ SERVEUR, jamais réinitialisée par un simple nouveau login/page fraîchement chargée (la fixture reproduit ça : le champ démarre à \"23\", jamais vide, voir son commentaire)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogations = await client.fetchAllDerogations(session);

    // Doit ramener TOUTES les rencontres, jamais seulement "23" (qui
    // n'existe même pas dans cette fixture — le champ, vidé
    // explicitement, doit renvoyer TOUS les résultats).
    expect(derogations.map((d) => d.numero).sort()).toEqual(["1", "1", "16", "9578", "9820"]);

    const diagnostics = client.getLastDerogationPassDiagnostics();
    // Preuve que le champ N'ÉTAIT PAS vide avant d'être vidé explicitement.
    expect(diagnostics[0].numeroValueBeforeClear).toBe("23");

    await client.closeSession(session);
  });

  it("traverse TOUTES les pages de façon fiable malgré un AJAX FBI réel LENT — jamais de lecture prématurée confondant 'pas encore rafraîchi' avec 'dernière page atteinte' (régression production 2026-09-27 : pageCount variait de 1 à 5 D'UNE EXÉCUTION À L'AUTRE pour le même jeu de données réel, voir docs/FBI.md § 'Toujours 51...')", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogations = await client.fetchAllDerogations(session);

    // Les 5 rencontres non-"A Créer" doivent toutes ressortir (dont les
    // DEUX rencontres n°1, division différente) — réparties sur les 3
    // pages (PAGE_SIZE=2, voir la fixture), chacune atteinte après un
    // délai artificiel de 150ms simulant un vrai AJAX FBI lent.
    expect(derogations.map((d) => d.numero).sort()).toEqual(["1", "1", "16", "9578", "9820"]);

    const diagnostics = client.getLastDerogationPassDiagnostics();
    expect(diagnostics).toHaveLength(1);
    // pageCount: 3 — la pagination "Suivant" traverse RÉELLEMENT les 3
    // pages, malgré le délai artificiel, sans doublon ni ligne perdue
    // (rawRowCount === keptRowCount).
    expect(diagnostics[0]).toMatchObject({ pass: "tousLesEtats", rawRowCount: 5, keptRowCount: 5, pageCount: 3 });
    // Diagnostic dédié (§ "Toujours 51 après le round treize/quatorze",
    // docs/FBI.md) : confirme qu'AUCUN contrôle "Afficher X entrées"
    // n'existe sur cette page — fidèle à ce que le vrai FBI a confirmé en
    // production (`found: false`), la pagination "Suivant" est donc le
    // SEUL mécanisme exercé par ce test.
    expect(diagnostics[0].lengthSelect).toMatchObject({ found: false, selectId: null, appliedValue: null });

    await client.closeSession(session);
  });

  it("ramène le détail par ligne (motif/dates demandées/demandeur) pour CHAQUE dérogation — cinquième revirement (régression production 2026-09-27 : \"on récupère plus le demandeur le motif, l'heure la date etc\" après le round précédent qui avait retiré tout détail du lot) : ouvre un nouvel onglet PAR LIGNE, refermé aussitôt après lecture, jamais laissé ouvert sur la page principale", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogations = await client.fetchAllDerogations(session);

    expect(derogations).toHaveLength(5);
    for (const derogation of derogations) {
      // Le serveur de test route par CHEMIN seul (query string ignorée,
      // voir setRoute plus haut) — chaque ligne ramène donc le MÊME détail
      // fixe (fixture afficher-derogation.html), suffisant pour prouver
      // que le détail est bien lu (jamais resté à `null` comme au round
      // précédent).
      expect(derogation.motif).toBe("Gymnase indisponible ce jour-là");
      expect(derogation.demandeur).toBe("Domicile");
      expect(derogation.dateRencontreDemandee).toBe("03/10/2026");
      expect(derogation.heureDemandee).toBe("20:00");
    }
    // Jamais quitté rechercherDerogation.fbi sur la page PRINCIPALE — le
    // détail de chaque ligne est lu dans un onglet SÉPARÉ, refermé
    // aussitôt après (voir fetchDerogationDetailByHref), jamais laissé
    // ouvert une fois toutes les lignes traitées.
    expect(session.page.url()).toContain("rechercherDerogation.fbi");
    expect(session.context.pages()).toHaveLength(1);

    await client.closeSession(session);
  });

  it("respecte derogationDetailBudgetMs — une fois le budget de détail dépassé, les lignes restantes gardent leurs champs de détail à null plutôt que de risquer un dépassement du timeout Vercel de 300s (\"ca doit pas bloquer\", demande du club) ; le tableau de résultats (numéro/état/dates) reste lui INCHANGÉ, jamais amputé", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50, derogationDetailBudgetMs: 0 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogations = await client.fetchAllDerogations(session);

    expect(derogations.map((d) => d.numero).sort()).toEqual(["1", "1", "16", "9578", "9820"]);
    for (const derogation of derogations) {
      expect(derogation.motif).toBeNull();
      expect(derogation.demandeur).toBeNull();
    }
    // Budget épuisé dès le départ : aucun onglet de détail ne doit même
    // avoir été ouvert.
    expect(session.context.pages()).toHaveLength(1);

    await client.closeSession(session);
  });

  it("ne rouvre jamais le détail d'une dérogation déjà connue et inchangée (needsDetail) — 2026-10-07, ~85 pages de détail d'affilée puis plus de réponse FBI", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogations = await client.fetchAllDerogations(session, { needsDetail: () => false });

    // Toutes les dérogations restent lues (tableau), seul le détail est sauté.
    expect(derogations.map((d) => d.numero).sort()).toEqual(["1", "1", "16", "9578", "9820"]);
    for (const derogation of derogations) expect(derogation.motif).toBeNull();
    expect(client.getLastDerogationDetailStats()).toMatchObject({ toFetch: 0, fetched: 0, skippedUnchanged: 5, stoppedEarly: null });

    await client.closeSession(session);
  });

  it("lit le détail dans UN SEUL onglet réutilisé, avec une pause entre deux pages, et rend compte de la progression", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50, derogationDetailPauseMs: 20 });
    const session = await client.login({ username: "club1234", password: "secret" });
    const progress: string[] = [];

    const derogations = await client.fetchAllDerogations(session, { onDetailProgress: (done, total) => progress.push(`${done}/${total}`) });

    expect(derogations.every((d) => d.motif === "Gymnase indisponible ce jour-là")).toBe(true);
    const stats = client.getLastDerogationDetailStats()!;
    expect(stats.fetched).toBe(stats.toFetch);
    expect(progress.at(-1)).toBe(`${stats.toFetch}/${stats.toFetch}`);
    expect(session.context.pages()).toHaveLength(1);

    await client.closeSession(session);
  });

  it("lit les cases de la page de CONSULTATION par leur name (ids générés par FBI, relevé réel du 2026-10-08)", async () => {
    const box = (field: string, checked: boolean, id = `afficherDerogation_derogationForm_derogationDemandeBean_${field}`) =>
      `<input type="checkbox" name="derogationForm.derogationDemandeBean.${field}" id="${id}" value="true" disabled="disabled"${checked ? ' checked="checked"' : ""} />`;
    server.setRoute({
      path: "/afficherDerogation.fbi",
      contentType: "text/html",
      body: `<html><body><form id="afficherDerogation">
        <input type="text" id="demandeurLibelle" value="Domicile" disabled="disabled" />
        <input type="text" id="dateDepot" value="21/09/2026 13:49" disabled="disabled" />
        ${box("modifierDate", false)}${box("modifierHoraire", true)}${box("modifierSalle", false, "modifierSalle")}${box("inverserRencontre", false)}${box("inverserEquipe", false)}
        <input type="text" id="horaireHour" value="17:30" disabled="disabled" />
        <textarea id="motif" readonly="readonly">Organisation journée. Merci</textarea>
      </form></body></html>`,
    });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const [first] = await client.fetchAllDerogations(session);

    expect(first).toMatchObject({ modifierDate: false, modifierHoraire: true, modifierSalle: false, inverserRencontre: false, inverserEquipe: false, heureDemandee: "17:30", dateDepotDetail: "21/09/2026 13:49" });
    expect(client.getLastDerogationDetailStats()?.pageShape?.checkboxes.map((c) => c.name)).toContain("derogationForm.derogationDemandeBean.modifierHoraire");

    await client.closeSession(session);
  });

  it("s'arrête après 3 pages de détail sans réponse exploitable au lieu d'insister — le tableau reste intégralement lu", async () => {
    server.setRoute({ path: "/afficherDerogation.fbi", contentType: "text/html", body: "<html><body>Service indisponible</body></html>" });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const derogations = await client.fetchAllDerogations(session);

    expect(derogations).toHaveLength(5);
    expect(client.getLastDerogationDetailStats()).toMatchObject({ failed: 3, fetched: 0, stoppedEarly: "fbi_ne_repond_plus" });

    await client.closeSession(session);
  });
});

describe("BrowserFbiClient.respondToDerogation (ÉCRIT réellement sur FBI — demande du club, 2026-09-27 : \"je veux le faire via loutil\")", () => {
  // Forme DÉCODÉE (jamais `%3D%3D` littéral) : `respondToDerogation` re-encode
  // lui-même via `URLSearchParams.set`, même contrat que `parseIdDerogation`
  // (browser-client.ts) qui décode déjà via `.searchParams.get`.
  const REPONSE_ATTENDUE_ID = "BvBUvSPeq6Ta6wZoQpDvSg==";

  beforeEach(() => {
    // Cas où le club DOIT répondre (demandeur = l'adversaire) — distinct de
    // afficher-derogation.html (déjà servie par défaut), voir la doc de la
    // fixture pour le détail réel fourni par le club (rencontre 9538).
    server.setRoute({ path: "/afficherDerogation.fbi", contentType: "text/html", body: fixture("afficher-derogation-reponse-attendue.html") });
  });

  it("accepte : sélectionne 'O', clique Enregistrer, détecte le succès par la navigation vers rechercherDerogation.fbi (retourArriere())", async () => {
    server.setRoute({ path: "/enregistrerDerogation.fbi", method: "POST", contentType: "text/plain", body: "" });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const result = await client.respondToDerogation(session, REPONSE_ATTENDUE_ID, "accepted", null);

    expect(result).toEqual({ outcome: "success" });
    expect(session.page.url()).toContain("rechercherDerogation.fbi");
    await client.closeSession(session);
  });

  it("refuse : remplit le motif de refus, sélectionne 'N', même détection de succès", async () => {
    server.setRoute({ path: "/enregistrerDerogation.fbi", method: "POST", contentType: "text/plain", body: "" });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const result = await client.respondToDerogation(session, REPONSE_ATTENDUE_ID, "refused", "Gymnase indisponible ce jour-là.");

    expect(result).toEqual({ outcome: "success" });
    await client.closeSession(session);
  });

  it(
    "remonte le VRAI message d'erreur FBI (jamais un texte générique deviné) quand la page reste sur place et affiche <ul class=\"errorMessage\">",
    async () => {
      server.setRoute({
        path: "/enregistrerDerogation.fbi",
        method: "POST",
        contentType: "text/html",
        body: '<ul class="errorMessage"><li>Le motif de refus est obligatoire.</li></ul>',
      });
      const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
      const session = await client.login({ username: "club1234", password: "secret" });

      const result = await client.respondToDerogation(session, REPONSE_ATTENDUE_ID, "refused", "x");

      expect(result).toMatchObject({ outcome: "error", message: expect.stringContaining("Le motif de refus est obligatoire.") });
      await client.closeSession(session);
    },
    // Aucune navigation dans ce cas (pas d'erreur "attendue" à ce niveau) :
    // le test attend RÉELLEMENT les 45s de `waitForURL` (browser-client.ts,
    // bump 20s→45s le 2026-09-28, rencontre 9538 — voir sa doc) avant de
    // retomber sur la détection d'erreur — au-delà du testTimeout par défaut.
    60_000,
  );

  it("renvoie 'unknown' (jamais 'success' sans preuve) quand le champ de décision est introuvable — ex. la dérogation n'attend plus de réponse du club", async () => {
    // Réutilise le cas "club demandeur" (affichage lecture seule, pas de
    // <select> de décision) — même situation réelle qu'une dérogation déjà
    // répondue, ou dont le club est lui-même le demandeur.
    server.setRoute({ path: "/afficherDerogation.fbi", contentType: "text/html", body: fixture("afficher-derogation.html") });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const result = await client.respondToDerogation(session, "1k+JhfgiN4lc", "accepted", null);

    expect(result.outcome).toBe("unknown");
    await client.closeSession(session);
  });
});

describe("BrowserFbiClient.createDerogation (ÉCRIT réellement sur FBI — création, demande du club 2026-09-28 : \"mtn faut en créer une\")", () => {
  beforeEach(() => {
    server.setRoute({ path: "/afficherDerogation.fbi", contentType: "text/html", body: fixture("afficher-derogation-creation.html") });
  });

  it("recherche la rencontre à l'état 'A Créer' (jamais 'tousLesEtats', qui l'exclut), remplit le motif/la date, clique Enregistrer, détecte le succès par la navigation vers rechercherDerogation.fbi", async () => {
    server.setRoute({ path: "/enregistrerDerogation.fbi", method: "POST", contentType: "text/plain", body: "" });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    // "2659" (division "PRF") est la SEULE ligne "A Créer" de la fixture
    // rechercher-derogation.html — voir sa doc.
    const result = await client.createDerogation(session, "2659", "PRF", {
      motif: "Indisponibilité du gymnase.",
      modifierDate: true,
      dateDerogation: "07/11/2026",
      modifierHoraire: false,
      horaire: null,
      inverserRencontre: false,
      inverserEquipe: false,
    });

    expect(result).toEqual({ outcome: "success" });
    expect(session.page.url()).toContain("rechercherDerogation.fbi");
    await client.closeSession(session);
  });

  it("salle : cherche le gymnase par son nom dans la fenêtre FBI, choisit la bonne ligne, puis enregistre (relevé réel du 2026-10-20)", async () => {
    server.setRoute({ path: "/enregistrerDerogation.fbi", method: "POST", contentType: "text/plain", body: "" });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });
    const result = await client.createDerogation(session, "2659", "PRF", {
      motif: "Match au Lido.",
      modifierDate: false,
      dateDerogation: null,
      modifierHoraire: false,
      horaire: null,
      inverserRencontre: false,
      inverserEquipe: false,
      modifierSalle: true,
      salle: "COMPLEXE SPORTIF DU LIDO",
    });
    expect(result).toEqual({ outcome: "success" });
    await client.closeSession(session);
  });

  it("salle inconnue sur FBI : rien n'est enregistré, message explicite", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });
    const result = await client.createDerogation(session, "2659", "PRF", {
      motif: "Match ailleurs.",
      modifierDate: false,
      dateDerogation: null,
      modifierHoraire: false,
      horaire: null,
      inverserRencontre: false,
      inverserEquipe: false,
      modifierSalle: true,
      salle: "PALAIS DES SPORTS",
    });
    expect(result).toMatchObject({ outcome: "unknown", message: expect.stringContaining("salle « PALAIS DES SPORTS » introuvable sur FBI") });
    expect(session.page.url()).toContain("afficherDerogation.fbi");
    await client.closeSession(session);
  });

  it("aucune ligne 'A Créer' pour ce numéro (tableau vide) : dérogation déjà existante, rien n'est envoyé", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const result = await client.createDerogation(session, "999999", null, {
      motif: "Motif.",
      modifierDate: false,
      dateDerogation: null,
      modifierHoraire: false,
      horaire: null,
      inverserRencontre: false,
      inverserEquipe: false,
    });

    expect(result).toMatchObject({ outcome: "error", message: expect.stringContaining("une dérogation existe déjà pour ce match") });
    await client.closeSession(session);
  });

  it("renvoie null quand le numéro correspond mais pas la division (désambiguïsation, même principe que fetchDerogationForMatch)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const result = await client.createDerogation(session, "2659", "AUTRE_DIVISION", {
      motif: "Motif.",
      modifierDate: false,
      dateDerogation: null,
      modifierHoraire: false,
      horaire: null,
      inverserRencontre: false,
      inverserEquipe: false,
    });

    // Jamais un numéro seul : la ligne d'une autre division n'est pas prise, FBI dit ce qu'il a renvoyé.
    expect(result).toMatchObject({ outcome: "error", message: expect.stringContaining("FBI a renvoyé : 2659 (PRF)") });
    await client.closeSession(session);
  });

  it(
    "remonte le VRAI message d'erreur FBI quand la page reste sur place et affiche <ul class=\"errorMessage\">",
    async () => {
      server.setRoute({
        path: "/enregistrerDerogation.fbi",
        method: "POST",
        contentType: "text/html",
        body: '<ul class="errorMessage"><li>Le motif est obligatoire.</li></ul>',
      });
      const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
      const session = await client.login({ username: "club1234", password: "secret" });

      const result = await client.createDerogation(session, "2659", "PRF", {
        motif: "",
        modifierDate: false,
        dateDerogation: null,
        modifierHoraire: false,
        horaire: null,
        inverserRencontre: false,
        inverserEquipe: false,
      });

      expect(result).toMatchObject({ outcome: "error", message: expect.stringContaining("Le motif est obligatoire.") });
      await client.closeSession(session);
    },
    // Même raison que respondToDerogation : attend RÉELLEMENT les 45s de
    // `waitForURL` avant de retomber sur la détection d'erreur.
    60_000,
  );
});

describe("BrowserFbiClient.downloadDocument", () => {
  it("télécharge le contenu via le contexte authentifié, sans passer par le système de fichiers", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    const buffer = await client.downloadDocument(session, `${server.baseUrl}/export/2813.zip`);

    expect(buffer.toString("utf8")).toBe("contenu-zip-synthetique");
    await client.closeSession(session);
  });

  it("passe par le fetch du navigateur : fonctionne même quand la pile réseau Node (context.request) est injoignable (ETIMEDOUT constaté en production)", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });
    const realRequest = session.context.request;
    const brokenRequest = () => Promise.reject(new Error("apiRequestContext.get: connect ETIMEDOUT (test)"));
    Object.defineProperty(session.context, "request", { value: { post: brokenRequest, get: brokenRequest }, configurable: true });

    try {
      const buffer = await client.downloadDocument(session, `${server.baseUrl}/export/2813.zip`);
      expect(buffer.toString("utf8")).toBe("contenu-zip-synthetique");
    } finally {
      Object.defineProperty(session.context, "request", { value: realRequest, configurable: true });
      await client.closeSession(session);
    }
  });

  it("retombe sur un vrai téléchargement par navigation quand le fetch de la page ET la pile réseau Node échouent", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });
    await session.page.evaluate(() => {
      window.fetch = () => Promise.reject(new TypeError("Failed to fetch (test)"));
    });
    const realRequest = session.context.request;
    const brokenRequest = () => Promise.reject(new Error("apiRequestContext.get: connect ETIMEDOUT (test)"));
    Object.defineProperty(session.context, "request", { value: { post: brokenRequest, get: brokenRequest }, configurable: true });

    try {
      const buffer = await client.downloadDocument(session, `${server.baseUrl}/export/piece-jointe.zip`);
      expect(buffer.toString("utf8")).toBe("contenu-zip-piece-jointe");
    } finally {
      Object.defineProperty(session.context, "request", { value: realRequest, configurable: true });
      await client.closeSession(session);
    }
  });

  it("lève REQUEST_FAILED sur une réponse HTTP en erreur", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });

    await expect(client.downloadDocument(session, `${server.baseUrl}/export/inexistant.zip`)).rejects.toMatchObject({ code: "REQUEST_FAILED" } satisfies Partial<FbiError>);
    await client.closeSession(session);
  });
});

describe("BrowserFbiClient.downloadValidatedLicencesExport — « Gestion des licences », filtre Validé, bouton Excel", () => {
  beforeEach(() => {
    server.setRoute({ path: "/rechercherLicence.fbi", contentType: "text/html", body: fixture("rechercher-licence.html") });
    server.setRoute({ path: "/rechercherLicence.fbi", method: "POST", action: "controleRecherche", contentType: "text/html", body: "<table></table>" });
    server.setRoute({
      path: "/exportLicence.fbi",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      headers: { "content-disposition": 'attachment; filename="rechercherLicence.xlsx"' },
      body: Buffer.from("contenu-xlsx-synthetique"),
    });
  });

  it("choisit « Validé », lance la recherche, puis récupère le fichier du bouton Excel", async () => {
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });
    try {
      const { buffer, fileName } = await client.downloadValidatedLicencesExport(session);
      expect(buffer.toString("utf8")).toBe("contenu-xlsx-synthetique");
      expect(fileName).toBe("rechercherLicence.xlsx");
    } finally {
      await client.closeSession(session);
    }
  });

  it("écran non reconnu : erreur claire, aucun téléchargement", async () => {
    server.setRoute({ path: "/rechercherLicence.fbi", contentType: "text/html", body: "<html><body><p>Maintenance</p></body></html>" });
    const client = new BrowserFbiClient({ baseUrl: server.baseUrl, browser, navigationSettleMs: 50 });
    const session = await client.login({ username: "club1234", password: "secret" });
    try {
      await expect(client.downloadValidatedLicencesExport(session)).rejects.toMatchObject({ code: "NAVIGATION_FAILED" });
    } finally {
      await client.closeSession(session);
    }
  });
});
