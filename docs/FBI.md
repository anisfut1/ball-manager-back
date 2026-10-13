# FBI — enrichissement optionnel

FBI (mode `FBI_ENHANCED`) ajoute, par-dessus le calendrier FFBB déjà
fonctionnel : feuille de match, composition, OTM, statistiques, documents
e-Marque. **FBI ne devient jamais le calendrier principal** et n'est
**jamais requis** pour qu'un club fonctionne — voir `tenancy/club-capabilities.ts`
et le pattern explicitement demandé :

```ts
if (!fbiCredentials) {
  // utiliser uniquement FFBBPublicProvider, ignorer les jobs FBI/e-Marque
  // — jamais "application inutilisable"
}
```

## Deux stratégies derrière une interface commune

| | `HttpFbiClient` (`integrations/fbi/http-client.ts`) | `BrowserFbiClient` (`integrations/fbi/browser-client.ts`) |
|---|---|---|
| Mécanisme | `fetch` + cookie jar (`SimpleCookieJar`) | Chromium headless (Playwright) |
| Rôle | **Stratégie PRINCIPALE** — login, cookie de session (JSESSIONID), GET, POST de lecture, téléchargement | **Stratégie DE SECOURS** — utilisée uniquement là où HTTP direct est confirmé insuffisant |
| Login | PREPARED — détection dynamique du formulaire (cheerio), jamais de nom de champ deviné | PREPARED — mêmes heuristiques (voir `selectors.ts`), transposées en Playwright |
| Découverte e-Marque | Échoue explicitement (`EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED`) — aucun endpoint HTTP confirmé, jamais inventé | Voie fonctionnelle — navigue et scanne la page comme le ferait un humain |
| Où | N'importe quelle route `/v1/*` ou `/internal/*` (léger, rapide) | Uniquement `/internal/*` (jamais un chemin utilisateur) |

`isFbiRequestAllowed`/`classifyFbiAction` (`action-classification.ts`)
classent chaque action FBI en READ_ONLY/WRITE/UNKNOWN à partir du nom
d'action extrait de l'URL — une action UNKNOWN n'est jamais auto-appelée,
et FBI reste strictement en lecture dans les deux clients.

## Login — jamais un simple code 200

Un HTTP 200 ne prouve rien pour une appli Java legacy qui peut très bien
renvoyer 200 sur sa propre page de connexion en cas d'échec. La preuve
utilisée est l'ABSENCE d'un champ `input[type=password]` sur la page
d'atterrissage (`looksLikeLoginPage`). `classifyFbiLoginStatus`
(`errors.ts`) traduit en `CONNECTED` / `INVALID_CREDENTIALS` (jamais
retenté) / `FBI_UNAVAILABLE` (retry avec backoff) / `AUTH_FLOW_CHANGED`
(structure de page changée, surfacé via `fbi_integration_status.last_error`)
/ `UNKNOWN_ERROR`.

## BrowserFbiClient sur Vercel — analyse réelle, pas une hypothèse

Avant d'implémenter quoi que ce soit, les contraintes Vercel actuelles
(2026) ont été vérifiées explicitement plutôt que supposées :

| Contrainte | Valeur constatée | Source |
|---|---|---|
| Durée max d'une Function | Sans Fluid Compute (legacy) : Pro 300s. **Avec Fluid Compute (activé par défaut désormais)** : Pro 800s, extensible à 1800s (bêta) | docs Vercel (functions/limitations, functions/configuring-functions/duration) |
| Mémoire | Fluid Compute : 2GB/1vCPU par défaut, jusqu'à 4GB/2vCPU en option Performance | docs Vercel (functions/configuring-functions/memory) |
| Taille de bundle par fonction | 250MB décompressé (pas 50MB, chiffre souvent confondu avec la taille compressée) — `@sparticuz/chromium` fait ~130MB décompressé, tient largement dedans | vercel.com/kb/guide/troubleshooting-function-250mb-limit |
| `/tmp` | Disponible, éphémère, non partagé entre invocations — taille exacte non confirmée depuis une page officielle directement lue dans cette session (souvent citée à 512MB, non garanti ici) | non confirmé à 100% — voir limitation ci-dessous |
| Runtime requis | Node.js (Edge runtime EXCLU : ne peut pas exécuter de binaire natif ni spawn de process) | docs Vercel (functions/runtimes/node-js) |
| `@sparticuz/chromium` | Activement maintenu (v153.x), mais son propre README ne mentionne **jamais Vercel** comme plateforme supportée (seulement AWS Lambda, Netlify) | github.com/Sparticuz/chromium |
| Retours communautaires | Plusieurs rapports de succès `@sparticuz/chromium` + `playwright-core`/`puppeteer-core` sur Vercel, MAIS aussi des erreurs récurrentes de bibliothèques partagées manquantes (`libnspr4.so`, `libnss3.so`) sur le runtime Node 22.x de Vercel, et au moins un rapport de Fluid Compute cassant une configuration Playwright qui fonctionnait auparavant | community.vercel.com (threads cités dans la recherche), dev.to |

**Conclusion retenue** : techniquement viable sur un plan Vercel Pro avec
Fluid Compute pour un usage occasionnel (pas de scraping haute fréquence),
mais **non officiellement supporté** ni par Vercel ni par
`@sparticuz/chromium`. C'est du "ça marche, avec des pièges documentés par
la communauté", pas une garantie de production. D'où le garde-fou
`BROWSER_FBI_ENABLED` (défaut `false`) : la capability reste explicitement
opt-in, jamais activée silencieusement.

### Ce qui est implémenté

- `integrations/fbi/browser-launcher.ts#launchServerlessBrowser()` —
  lance `playwright-core` + `@sparticuz/chromium` (jamais le paquet
  `playwright` complet, qui embarque un Chromium desktop bien plus lourd)
  UNIQUEMENT si `BROWSER_FBI_ENABLED=true`, sinon lève
  `BrowserFbiUnavailableError` immédiatement — jamais une tentative
  silencieuse.
- `integrations/fbi/browser-client.ts` (`BrowserFbiClient`) — identique en
  substance à ce qui aurait tourné sur un worker séparé : un
  `BrowserContext` Playwright ISOLÉ par connexion (jamais de cookie
  partagé entre deux clubs), sélecteurs centralisés et robustes (jamais de
  position, voir `selectors.ts`), téléchargement via
  `context.request.get()` (réutilise les cookies de la session
  authentifiée, jamais un `page.waitForEvent('download')` qui toucherait
  un fichier temporaire — le seul stockage temporaire réel du binaire
  Chromium lui-même, extrait par `@sparticuz/chromium` dans `/tmp`).
- `src/jobs/process-discover-emarque.ts` / `process-test-connection.ts` —
  lancent le navigateur, l'utilisent, le ferment systématiquement (`finally`)
  À CHAQUE invocation de Vercel Function — jamais de processus long-running
  partagé entre requêtes (§24 de la demande : uniquement `/tmp`, puis
  suppression — ici, rien n'est même écrit ailleurs que par le binaire
  Chromium lui-même).
- Route : `GET /internal/cron/fbi-jobs`, protégée par `CRON_SECRET`, jamais
  un chemin utilisateur. Flux : `claimNextJob` → `getFbiCredentials` →
  `BrowserFbiClient` → login → découverte/téléchargement → Storage →
  `match_documents` → job terminé.

### Supporté / préparé / non testé live / impossible

- **Supporté** : `HttpFbiClient` (login, cookie jar, GET/POST lecture,
  téléchargement) — chemin HTTP, aucune dépendance Vercel spécifique.
- **Préparé, non testé live** : `BrowserFbiClient` complet (login,
  découverte, téléchargement) — testé uniquement contre des pages HTML
  locales synthétiques avec un vrai Chromium (voir
  `integrations/fbi/browser-client.test.ts`), jamais contre le vrai FBI
  (réseau `*.ffbb.com` bloqué dans tous les environnements où ce code a
  été écrit) NI contre un vrai déploiement Vercel avec
  `@sparticuz/chromium` (jamais déployé depuis cette session).
- **Non confirmé** : la taille exacte de `/tmp` sur les runtimes Vercel
  actuels, et la stabilité de `@sparticuz/chromium` face à un changement
  futur de runtime Node côté Vercel (les rapports communautaires
  documentent des ruptures passées).
- **Impossible aujourd'hui** : rien n'a été jugé impossible — l'exploration
  sérieuse demandée avant de conclure a été faite (voir tableau ci-dessus)
  et n'a pas éliminé l'approche. Si un déploiement réel révèle
  l'incompatibilité (ex : `libnspr4.so` manquant sur le runtime effectif),
  la marche à suivre reste : garder `BrowserFbiClient` dans le code comme
  secours expérimental, désactiver `BROWSER_FBI_ENABLED`, continuer avec
  `HttpFbiClient` seul, sans jamais casser FFBB ni le reste du produit —
  jamais Railway/Render/Fly.io.

## Identifiants

AES-256-GCM, AAD = `club_id` (`security/crypto.ts`) — un ciphertext déplacé
vers un autre club ne se déchiffre jamais. `fbi_credentials` n'a AUCUNE
policy RLS `authenticated` : lu/écrit uniquement via le client service
role, après vérification du rôle `club_admin` par la RLS (voir
`docs/AUTH.md`).

`POST /v1/clubs/:clubId/integrations/fbi` enregistre `username` +
`password` (chiffré) — le mot de passe n'est jamais renvoyé en réponse.

## API frontend (gaps 4 et 8 résolus)

`GET /v1/clubs/:clubId/integrations` expose le `username` FBI configuré
**en clair** (jamais masqué) pour `club_admin`/`platform_admin` — utile
pour que l'admin sache quel compte est configuré sans devoir le
redemander — mais jamais `password`/ciphertext/IV/auth tag :

```json
{ "fbi": { "configured": true, "username": "club-a-fbi", "status": "connected", "autoImportEmarque": true, "lastSuccessfulLoginAt": "2026-09-01T10:00:00.000Z" } }
```

Activer/désactiver l'intégration ou l'auto-import sans jamais redemander
username/password :

```
PATCH /v1/clubs/:clubId/integrations/fbi
{ "enabled"?: boolean, "autoImportEmarque"?: boolean }
```

`club_admin` uniquement. `enabled: false` est toujours permis (même sans
identifiants). Activer (`enabled: true` ou `autoImportEmarque: true`) sans
identifiants déjà enregistrés renvoie `409 FBI_NOT_CONFIGURED` — jamais un
409 générique, le frontend peut distinguer ce cas et rediriger vers le
formulaire d'identifiants.

## Test de connexion

`POST /v1/clubs/:clubId/integrations/fbi/test` teste réellement
`HttpFbiClient` (chemin synchrone, rapide). Si l'échec est
`LOGIN_FORM_NOT_RECOGNIZED` ou `LOGIN_FAILED` ET que
`BROWSER_FBI_ENABLED=true`, un login navigateur (`attemptBrowserFbiLogin`,
`BrowserFbiClient`) est tenté DANS LA MÊME REQUÊTE (2026-09-24 — voir
"Huitième déclenchement" plus bas ; jusque-là un job `test_connection`
était empilé et son id renvoyé en `202` pour suivi via
`GET /v1/jobs/:jobId`, retiré).

**Premier test réel, identifiants corrects côté club, échoue avec
`LOGIN_FAILED` ("identifiant ou mot de passe incorrect").** Comme pour
FFBB (voir docs/FFBB.md), ce chemin n'avait jamais été exécuté contre le
vrai FBI depuis aucun environnement de développement — un `LOGIN_FAILED`
avec de vrais identifiants est donc a priori un mauvais diagnostic du
code (mauvais champ détecté, redirection non suivie, page intermédiaire
non anticipée), pas forcément un mauvais mot de passe.

**Diagnostic ajouté** (`http-client.ts`, `login()`) : chaque `FbiError`
(`LOGIN_FORM_NOT_RECOGNIZED`, `LOGIN_FAILED`) embarque désormais dans son
message les champs de formulaire réellement détectés (action, nom du
champ identifiant, nom du champ mot de passe), le statut HTTP de la
réponse de soumission, et un extrait borné (500 caractères, aplati) de la
page HTML concernée — jamais le mot de passe, un cookie ou un jeton.
Nécessaire car `logError` (`logger.ts`) ne capture que
`error.message`/`.stack`, jamais `.cause` : c'est le seul moyen pour ce
détail de survivre jusqu'aux logs Vercel (`vercel logs ... --json | grep
"fbi/test"`), même méthode que `directus-client.ts` côté FFBB. Corrigé au
passage : une réponse de soumission ni redirigée ni 2xx (ex. 403
applicatif) était silencieusement traitée comme un succès potentiel
(`landingHtml` vide → `looksLikeLoginPage("")` → `false`) — lève
maintenant `LOGIN_FAILED` explicitement. Couvert par 2 nouveaux tests
(`http-client.test.ts`).

**Prochaine étape** : relancer "Tester la connexion" depuis
`/admin/intégrations/fbi`, puis lire le message complet dans les logs
Vercel de ball-manager-back pour voir exactement quel formulaire/champ a
été détecté et pourquoi le site l'a refusé — jamais deviner un nouveau
nom de champ sans ce retour, comme pour FFBB.

**Deuxième déclenchement réel : cause trouvée grâce au diagnostic
ci-dessus.** Le formulaire est correctement détecté (`action=
https://extranet.ffbb.com/fbi/identification.fbi;jsessionid=...`, champs
`identificationForm.identificationBean.identifiant`/`...mdp` — noms
typiques d'un bean Struts, cohérents), et la soumission répond `HTTP 200`
**directement, sans redirection**. Le bug était dans notre propre code,
pas côté FBI : quand la soumission ne redirige pas, `login()` faisait un
SECOND appel GET vers CETTE MÊME URL d'action pour lire "la page
d'atterrissage" — hors contexte du POST, sans session encore établie côté
serveur pour cette requête. Pour une appli Java classique qui rend le
résultat directement dans la réponse du POST (au lieu de rediriger après
un login réussi), ce second GET renvoie le formulaire de connexion vierge
de départ, **quels que soient les identifiants**, un ou de mauvais — CE
GET, jamais notre POST, était la cause du `LOGIN_FAILED` systématique.

**Corrigé** (`http-client.ts`) : quand la soumission répond `200` sans
`Location`, `login()` lit maintenant le corps de LA RÉPONSE DE SOUMISSION
ELLE-MÊME (`submitResponse.text()`) au lieu de relancer un GET séparé — un
second GET n'est fait QUE quand le serveur redirige réellement (3xx +
`Location`), pour suivre cette redirection. Couvert par 2 nouveaux tests
(`http-client.test.ts`) : succès en 200 direct (vérifie qu'aucun second
appel réseau n'est fait vers la même URL), et échec en 200 direct avec le
formulaire de connexion dans le corps de LA RÉPONSE DE SOUMISSION
elle-même. **Non encore reconfirmé en direct** après ce correctif — à
valider au prochain "Tester la connexion".

**Troisième déclenchement réel : correctif confirmé actif, mais toujours
`LOGIN_FAILED`.** Le titre de la page d'atterrissage est bien `FBI -
Identification` cette fois (preuve que c'est désormais le corps RÉEL de
la réponse au POST, plus un second GET parasite) — mais le diagnostic
n'affichait que les 500 premiers caractères du `<head>` brut (balises
`<meta>`/`<link>` de mise en page, quasi identiques sur TOUTE page FBI,
succès ou échec) : aucune valeur diagnostique, le vrai contenu (message
d'erreur, ou à l'inverse le nom du club si connecté) est dans `<body>`,
jamais atteint dans les 500 premiers caractères de balisage brut.

**Corrigé** (`http-client.ts`) : `visibleBodyText()` remplace
`truncateHtml()` — extrait le texte VISIBLE de `<body>` (balises
retirées via cheerio, déjà utilisé pour le parsing) plutôt que le
balisage brut, avant troncature à 500 caractères. Couvert par un nouveau
test qui vérifie qu'un message d'erreur placé dans le corps ressort bien
dans le diagnostic, et que le `<head>` (ex: `fonts.googleapis.com`) n'y
apparaît plus.

**Quatrième déclenchement réel : le correctif ci-dessus tombait sur du
JavaScript inline, pas du texte lisible.** `.text()` de cheerio inclut le
contenu textuel des `<script>`/`<style>` (jamais visible dans un
navigateur, mais bien du texte du point de vue du DOM) — les 500 premiers
caractères capturés n'étaient que du JS (`$(document).ready(...)`,
gestion de `#loginList`/`#loginEntete`/`#utilisateurId` via
`connexionEntete('identificationEntete')`). **Piste ouverte, non
confirmée** : ces noms (liste de comptes, "entête" à choisir) suggèrent
que FBI présente une étape de SÉLECTION DE COMPTE/ENTITÉ après un login
par ailleurs réussi (cas d'un identifiant associé à plusieurs structures)
— auquel cas `LOGIN_FAILED` serait un faux négatif : `looksLikeLoginPage`
trouve un `input[type=password]` sur cette page intermédiaire (peut-être
un formulaire de re-confirmation) alors que les identifiants étaient
corrects. À confirmer par le prochain texte visible, script exclu.

**Corrigé** (`http-client.ts`) : `visibleBodyText()` retire désormais
`<script>`/`<style>` (`$("script, style").remove()`) avant d'extraire le
texte — jamais de code JS/CSS à la place du texte réellement visible.
Couvert par un nouveau test (page avec message d'erreur ET `<script>`
volumineux, vérifie que seul le message ressort).

**Cinquième déclenchement réel : le texte visible confirme un vrai
message FBI, texte français lisible.** Diagnostic complet obtenu :
*"FBI 2026-2027 [...] Identifiant ou e-mail Mot de passe **Vos
identifiants ne sont pas corrects** CONNEXION Mot de passe oublié ?
[...]"*. La piste "sélection de compte" (déclenchement précédent) est
écartée : c'est bien le message de refus standard FBI, retourné
directement dans le corps du POST (confirmé par le diagnostic
maintenant fiable de bout en bout). Le club confirme avoir re-saisi et
réenregistré le mot de passe juste avant ce test — donc soit les
identifiants sont réellement incorrects côté FBI, soit notre POST omet
encore quelque chose que le navigateur envoie.

**Piste retenue** : le bouton de soumission n'était jusqu'ici PAS inclus
dans le POST — seuls les champs `hidden`/texte/mot de passe l'étaient.
Beaucoup d'applis Java (Struts/JSF, cohérent avec les noms de champs
`identificationForm.identificationBean.*` déjà observés) exigent le
couple nom/valeur du bouton cliqué (ex: `method:connexion=Connexion`)
dans le corps du POST pour router vers la bonne action côté serveur —
sans lui, le serveur peut traiter la requête comme incomplète et
retomber sur le message de refus générique, quels que soient les
identifiants envoyés.

**Corrigé** (`http-client.ts`) : `parseLoginForm` détecte maintenant
aussi `button[type="submit"]`/`input[type="submit"]` dans le formulaire
et, s'il porte un `name`, son couple nom/valeur est ajouté au corps du
POST (et au diagnostic, pour voir si aucun bouton nommé n'est trouvé).
Couvert par un nouveau test.

**Sixième déclenchement réel : le bouton n'était pas la cause — aucun
bouton nommé sur ce formulaire** (diagnostic : `bouton de soumission=
aucun trouvé`), le correctif est un no-op ici (harmless, mais pas la
solution). Le club confirme via une question directe que ces mêmes
identifiants fonctionnent en se connectant à la main sur
`extranet.ffbb.com/fbi`, écartant un vrai mot de passe incorrect ou une
erreur de chiffrement côté ball-manager-back (le round-trip AES-256-GCM
est testé unitairement — unicode, chaîne vide, isolation par AAD — et
toute incohérence de clé/AAD lèverait `DecryptionError`, une erreur
distincte, jamais un `LOGIN_FAILED` silencieux ; la longueur du
ciphertext en base est cohérente avec un mot de passe normal).

**Piste retenue** : la page affiche explicitement *"Votre navigateur
n'est pas recommandé pour utiliser FBI. Nous vous recommandons Google
Chrome"* — preuve d'une détection de navigateur côté serveur. Aucune de
nos requêtes n'envoyait de `User-Agent` (le `fetch` de Node/undici n'en
envoie pas un qui ressemble à un vrai navigateur) : cohérent avec une
protection anti-bot basique et silencieuse (rejet de connexion sans le
révéler explicitement), fréquente sur ce type d'appli legacy.

**Corrigé** (`http-client.ts`) : `FBI_REQUEST_HEADERS` (User-Agent
Chrome/Windows réaliste + `Accept-Language: fr-FR`) appliqué à TOUTE
requête vers FBI (login, landing, `isSessionValid`,
`downloadDocument`) — pas seulement le login, une incohérence de
user-agent au fil d'une session étant elle-même un signal de détection
courant. Couvert par un nouveau test qui vérifie qu'un User-Agent
contenant "Chrome" est envoyé sur les 3 requêtes d'un login réussi.

**Septième déclenchement réel : `LOGIN_FAILED` persiste, identique au
mot près, MALGRÉ le User-Agent de navigateur.** Le bandeau "navigateur
non recommandé" reste affiché même avec un User-Agent Chrome — affaiblit
la piste "détection par User-Agent seul" : soit le bandeau est statique
(toujours affiché, pas une vraie détection), soit la détection va plus
loin qu'un simple en-tête (empreinte TLS/JA3, exécution JS, fingerprinting
navigateur) — rien qu'un `fetch()` Node ne peut reproduire. Round-trip de
chiffrement écarté indépendamment (voir plus haut). Avec des identifiants
confirmés deux fois par le club (login manuel réussi), l'explication la
plus probable devient une protection anti-bot qu'un client HTTP direct ne
peut structurellement pas franchir.

**Corrigé** (`routes.ts`) : le repli vers `BrowserFbiClient` (job
`test_connection`, `BROWSER_FBI_ENABLED=true`) se déclenchait
uniquement sur `LOGIN_FORM_NOT_RECOGNIZED` — jamais sur `LOGIN_FAILED`,
alors que c'est exactement le code d'erreur rencontré ici. Élargi aux
deux codes : un vrai Chromium a une empreinte de navigateur qu'un
`fetch` ne peut pas imiter, donc plus susceptible de franchir cette
protection si c'en est une ; un `LOGIN_FAILED` du navigateur reste
possible (vraiment mauvais identifiants), mais devient alors un signal
nettement plus fiable que celui du client HTTP seul. **Nécessite
`BROWSER_FBI_ENABLED=true` en production** (variable d'environnement
Vercel côté ball-manager-back) pour se déclencher — à vérifier/activer
avant de retester. Pas de nouveau test route-level ajouté (la route
`/fbi/test` n'a aucune couverture existante nécessitant de mocker
`HttpFbiClient`/`fbi_jobs` — lift disproportionné pour ce correctif
d'une ligne, urgence du diagnostic en direct).

**Sixième déclenchement réel : succès, via le job navigateur.** Après
avoir déclenché manuellement `/internal/cron/fbi-jobs` depuis le
dashboard Vercel (le cron ne tourne qu'une fois par jour, voir
vercel.json), le job navigateur confirme `loginStatus: "CONNECTED"` — le
club a bien les bons identifiants, HTTP direct était structurellement
bloqué (protection anti-bot). `fbi_integration_status.last_login_success`
passe à `true`.

**Septième correctif : `last_error` restait affiché malgré le succès.**
Les deux chemins de succès (`routes.ts` synchrone, `process-test-
connection.ts` asynchrone) ne réinitialisaient jamais `last_error` —
`/admin/intégrations` aurait affiché "Connecté ✅" à côté du message
d'erreur HTTP périmé. Corrigé : `last_error: null` explicite sur les
deux chemins de succès. Nettoyage ponctuel en production (SQL direct)
de la ligne déjà incohérente pour le club pilote.

**Huitième déclenchement — retour du club : "je ne veux pas que ça
marche avec le bouton Vercel, je veux que tout passe par l'appli".**
Juste après confirmation du succès, devoir déclencher manuellement le
cron depuis le dashboard Vercel à chaque test (et pour chaque futur
`discover_emarque` en attente, même limitation) est exactement ce que
le pattern job+cron devait éviter pour une action interactive — un
admin qui clique "Tester la connexion" attend un résultat immédiat.

**Corrigé** : `attemptBrowserFbiLogin` (nouveau module
`integrations/fbi/browser-login-attempt.ts`, factorisé depuis
`process-test-connection.ts`) est appelé DIRECTEMENT et de façon
SYNCHRONE par `POST .../fbi/test` — plus de job `fbi_jobs` créé pour ce
type d'appel, plus de `202`/`jobId`, plus besoin du cron. Vérifié :
`maxDuration: 300` (vercel.json) laisse largement la place pour un
login navigateur (`launchServerlessBrowser` + `BrowserFbiClient.login`),
qui prend quelques secondes en pratique (voir déclenchements
précédents). `TestFbiConnectionButton.tsx` (ball-manager-web) n'a nécessité AUCUN
changement : il gérait déjà les deux cas (`result.jobId` → polling,
sinon → résultat direct), donc le cas direct fonctionne immédiatement.

`processTestConnectionJob`/le traitement `test_connection` du cron
`/internal/cron/fbi-jobs` restent en place (refactorés pour réutiliser
`attemptBrowserFbiLogin`) — plus rien ne crée ce type de job aujourd'hui,
mais rien n'empêche un futur appelant (retry différé en arrière-plan) de
le faire plutôt que d'utiliser le chemin synchrone. La synchronisation
FFBB (`POST .../ffbb/sync`, bouton "Relancer maintenant") était déjà
entièrement synchrone, sans dépendance à un job/cron — aucun changement
nécessaire là. Couvert par 2 nouveaux tests route-level (`BROWSER_FBI_
ENABLED=true` + `resetEnvCacheForTests()`, mock de
`attemptBrowserFbiLogin`) : succès navigateur sans `jobId` dans la
réponse, échec navigateur enregistré comme `last_error`.

**Neuvième déclenchement — "et maintenant que FBI est connecté, ça me
sert à quoi ? ça ne change rien alors que ça doit tout récupérer".**
Question légitime : `POST .../fbi/test` (huitième déclenchement)
prouve seulement que les identifiants FBI sont valides. La récupération
RÉELLE des documents e-Marque (feuilles de match, compositions,
statistiques) est un traitement séparé — les jobs `discover_emarque`
(un par match, voir `process-discover-emarque.ts`), qui utilisent
TOUJOURS `BrowserFbiClient` (jamais `HttpFbiClient` : `findEmarqueDocuments`
n'a aucune implémentation HTTP directe, voir plus haut). Constaté en
production le 2026-09-24 : 8 jobs `discover_emarque` (+ 2 `test_connection`,
créés avant le huitième correctif) en attente depuis plus d'une journée,
`claimed_at: null` — parce que ces jobs dépendent du même
`/internal/cron/fbi-jobs` qui ne tourne qu'une fois par jour, la seule
façon de les faire avancer plus tôt étant, jusqu'ici, le déclenchement
manuel du dashboard Vercel — exactement ce que le club a demandé
d'éviter au déclenchement précédent, mais qui ne concernait alors que le
test de connexion, pas la file `discover_emarque`.

**Corrigé** : nouvelle route `POST .../fbi/process-jobs`
(`club_admin`), traitant DANS LA REQUÊTE un petit lot (`CLUB_JOB_BATCH_SIZE
= 3`, même taille que le cron) des jobs FBI en attente **de ce club
uniquement**. Nouvelle fonction SQL `claim_next_fbi_job_for_club(p_club_id,
p_worker_id)` (migration `20260924100000_fbi_jobs_claim_for_club.sql`),
copie de `claim_next_fbi_job` avec un filtre `club_id = p_club_id` en
plus — nécessaire car `claim_next_fbi_job` réclame GLOBALEMENT (n'importe
quel club) : l'exposer tel quel depuis une route `/v1/clubs/:clubId/*`
aurait traité les jobs d'un AUTRE club à l'insu de l'appelant. Même
politique d'accès que l'original (`revoke all ... from public, anon,
authenticated` — service role uniquement, depuis le code serveur, après
que `requireClubRole("club_admin")` a vérifié le rôle).

La logique de réclamation+dispatch (réclamer jusqu'à `batchSize` jobs,
`import()` dynamique de `processTestConnectionJob`/`processDiscoverEmarqueJob`
selon `job.type`, comptage `claimed/succeeded/failed`) était dupliquée
dans `/internal/cron/fbi-jobs` : factorisée dans `jobs/process-batch.ts`
(`processJobBatch`), réutilisée par le cron (avec `claimNextJob`, global)
et par la nouvelle route (avec `claimNextJobForClub(clubId)`, scopée).

Côté ball-manager-web : `ProcessFbiJobsButton.tsx`, nouvelle carte "Documents
e-Marque en attente" sur `/admin/intégrations/fbi` (visible dès que FBI
est configuré), expliquant explicitement que "Connecté" ne récupère rien
tout seul. Réponse `{ claimed, succeeded, failed }` affichée directement
(jamais de polling — un lot de 3 jobs traite en pratique en quelques
secondes à quelques dizaines de secondes selon le nombre de documents,
largement sous `maxDuration: 300`).

À noter : un lot de 3 ne vide pas forcément la file d'un coup si plus de
3 jobs sont en attente — l'admin reclique, ou attend la prochaine passe
du cron quotidien qui continuera à réclamer globalement (les deux
mécanismes cohabitent sans conflit, `FOR UPDATE SKIP LOCKED` empêchant
toute réclamation en double).

**Dixième déclenchement — "on a récupéré quoi là, je veux check en
front, sauf qu'on a juste les matchs à venir et pas les passés".** Deux
diagnostics distincts, tous deux constatés en production le 2026-09-24 :

1. **Timeout client trop court.** `POST .../fbi/process-jobs` réussissait
   bien côté serveur (logs : job réclamé, Chromium lancé, documents
   téléchargés — ~28s pour UN SEUL job) mais ball-manager-web affichait "Traitement
   impossible" : le client HTTP (`src/lib/api/client.ts`) avait un
   timeout fixe de 20s, systématiquement dépassé par un lot de jobs
   navigateur. Corrigé côté ball-manager-web : `timeoutMs` configurable par appel
   (`ApiRequestInit`), `processFbiJobs` passe désormais 280s (sous
   `maxDuration: 300`).

2. **Téléchargé ≠ affichable, et le calendrier de la saison en cours est
   vide.** Deux causes cumulées expliquaient l'absence totale de contenu
   visible :
   - Le pipeline e-Marque a DEUX étapes séparées (commentaire déjà présent
     dans `parse-downloaded-documents.ts`) : `discover_emarque`
     (Playwright, télécharge) puis le PARSING (OCR/PDF,
     `parseDownloadedEmarqueDocuments`, jusqu'ici UNIQUEMENT via
     `/internal/cron/emarque-parse`, une fois par jour). Un document
     `emarque_status: downloaded` ne devient `imported` (composition/
     stats/officiels persistés, donc affichables) qu'après cette seconde
     étape — jamais automatique en dehors du cron. Constaté : 14
     documents `downloaded`, `0` ligne dans `emarque_imports`.
   - `currentSeasonStart()` (ball-manager-web, `/matchs` et `/admin/sync`) filtre par
     défaut sur la saison en cours (1er août → ...). La saison 2026-2027
     vient de commencer (aucun match encore joué dessus : `0` match
     `played` depuis le 1er août 2026) — les 97 matchs déjà joués de la
     saison précédente (2025-2026, tous encore `emarque_status: pending`
     faute d'avoir été enqueués avant que FBI soit connecté) sont donc
     invisibles sur `/matchs`, quel que soit leur statut e-Marque. La
     fiche détail (`/matchs/[id]`) n'a elle AUCUN filtre de saison — un
     match hors saison en cours reste consultable par lien direct, juste
     absent de la liste.

   **Corrigé** : nouvelle route `POST .../fbi/parse-documents`
   (`club_admin`), même principe que `process-jobs` mais pour l'étape
   PARSING — `parseDownloadedEmarqueDocuments` accepte désormais
   `{ clubId, limit }` (filtre + plafond de lot, `CLUB_PARSE_BATCH_SIZE =
   10` : pas de navigateur ici, un OCR/PDF coûte nettement moins cher
   qu'un login+scrape FBI, d'où un lot plus grand). Le cron
   (`/internal/cron/emarque-parse`) continue d'appeler la fonction SANS
   options (tout traiter, tous clubs). Côté ball-manager-web : `ParseFbiDocumentsButton.tsx`,
   deuxième bouton dans la même carte "Documents e-Marque en attente",
   étiquetée en deux étapes numérotées (1. Télécharger / 2. Traiter).

   Le filtre de saison, lui, N'A PAS été changé — comportement voulu
   (§ "Vue 'Ce week-end' + filtres" du commentaire de `/matchs/page.tsx` :
   éviter de charger l'historique complet à chaque visite). Pour vérifier
   le rendu d'une feuille de match réelle dès maintenant : ouvrir
   directement `/c/<slug>/matchs/<matchId>` d'un match de la saison
   2025-2026 déjà `imported` (pas besoin d'attendre un match de la
   nouvelle saison).

   **Débit constaté** : 416 jobs `discover_emarque` `pending` pour le
   club pilote (créés d'un coup par `/internal/cron/fbi-enqueue` une fois
   FBI connecté, couvrant tout l'historique de matchs joués jamais
   synchronisé) — à raison de `CLUB_JOB_BATCH_SIZE = 3` par appel, vider
   cette file aurait demandé des dizaines de clics manuels. Voir "Onzième
   déclenchement" plus bas : `ProcessFbiJobsButton`/`ParseFbiDocumentsButton`
   relancent désormais l'appel automatiquement tant qu'il reste des
   candidats, plus besoin de recliquer.

**Onzième déclenchement — "on a récupéré quoi là" (suite) : les
documents téléchargés n'étaient PAS de vrais documents e-Marque.**
En creusant pourquoi `parse-documents` répondait systématiquement "rien
à parser" malgré des dizaines de documents `downloaded`, inspection
directe de `match_documents` en base : tous les documents partagent EXACTEMENT
les mêmes noms de fichier ("e-Marque.pdf", "Télécharger_e-Marque_V2.pdf",
"Télécharger_e-Marque_MiniBasket.pdf"), pour des dizaines de numéros de
rencontre DIFFÉRENTS, tous classés `type: "other"` (jamais `emarque_zip`).
Ces noms sont ceux des liens de téléchargement du LOGICIEL e-Marque
(l'appli de saisie desktop), pas des documents d'UN match — un contenu
permanent, identique sur n'importe quelle page FBI.

**Cause racine** : `findEmarqueDocuments` (`browser-client.ts`) enchaîne
trois étapes de navigation volontairement "best effort" (`tryNavigate
ToSearchScreen`/`trySearchByMatchNumber`/`tryOpenMatchResult`, chacune
avale ses propres erreurs — conçu ainsi faute d'avoir pu observer le vrai
markup FBI, voir plus haut) puis scanne la page COURANTE, quelle qu'elle
soit, via `findDocumentLinks` — dont `DOCUMENT_EXTENSION_PATTERN` matche
N'IMPORTE QUEL lien `.pdf`/`.zip` sur la page, indépendamment du texte.
Si les trois étapes échouent silencieusement (sélecteurs qui ne
correspondent pas au vrai FBI), on reste sur la page où on était déjà
(probablement l'accueil post-login) — et ses liens permanents
"Télécharger e-Marque" matchent l'extension `.pdf`, remontés à tort comme
documents DE LA rencontre demandée. Le job se marquait alors "réussi" à
chaque fois : succès silencieux sur des données fausses, pire qu'un échec
visible.

**Corrigé** : `findEmarqueDocuments` vérifie maintenant explicitement
(`selectors.pageMentionsMatchNumber`) que la page atteinte mentionne bien
le numéro de rencontre demandé AVANT de faire confiance à
`findDocumentLinks` — sinon elle lève `EMARQUE_MATCH_PAGE_NOT_REACHED`
(diagnostic : titre + URL de la page réellement atteinte, exploitable
depuis les logs Vercel exactement comme pour le diagnostic de login
plus haut dans ce document). Le job passe alors en erreur/replanifié
(`emarque_status: error`, `last_error` renseigné) plutôt qu'en faux
succès. Les sélecteurs de navigation réels (pourquoi les trois étapes
échouent) restent À DÉTERMINER — cette correction ne les répare pas,
elle empêche seulement l'échec de navigation de produire des données
fausses. Prochaine étape si le problème persiste après ce correctif :
récupérer le diagnostic (titre/URL de la page réellement atteinte) depuis
les logs Vercel d'un prochain job en échec, pour ajuster les sélecteurs
de `tryNavigateToSearchScreen`/`trySearchByMatchNumber`/`tryOpenMatchResult`
sur le VRAI markup FBI (même méthode que pour le formulaire de login).

**Nettoyage** : les documents déjà téléchargés à tort (type `other`,
noms génériques) n'ont pas été supprimés en base à ce stade — ils sont
inertes (jamais matchés par `parseDownloadedEmarqueDocuments`, qui ne
regarde que `type = emarque_zip`), donc sans risque immédiat, mais
polluent `match_documents`. Nettoyage différé, pas demandé.

**Incident — la boucle auto (§10 de la demande, ball-manager-web) a fait échouer ~190
connexions FBI en quelques minutes.** Livré sans aucun garde-fou de
rythme : `ProcessFbiJobsButton` rappelait `POST .../fbi/process-jobs` en
boucle immédiatement après chaque réponse, sans pause. Constaté en
production quelques minutes après déploiement : `fbi_integration_status.
last_error` passe de "Connecté ✅" à "Formulaire de connexion FBI non
reconnu (aucun champ mot de passe trouvé)" — `LOGIN_FORM_NOT_RECOGNIZED`
au niveau du LOGIN lui-même (`HttpFbiClient`/`BrowserFbiClient`), pas de
la découverte de documents. Classé `AUTH_FLOW_CHANGED` par
`classifyFbiLoginStatus` → jamais retried automatiquement (§ commentaire
`process-discover-emarque.ts` : "ne se corrigera jamais tout seul en
réessayant") → ~190 jobs `discover_emarque` marqués `failed`
PERMANENTS en quelques minutes, alors que des dizaines de connexions
manuelles espacées (~30s+ entre clics) n'avaient jamais déclenché cette
erreur. Signature cohérente avec un blocage anti-bot FBI déclenché par le
rythme (jamais confirmé formellement — aucun accès pour inspecter la
réponse FBI réelle reçue à ce moment-là).

**Réaction immédiate** (pendant l'incident, avant le correctif) :
`fbi_jobs.scheduled_at` des jobs `pending` restants repoussé de 2h en
base directement (arrête la boucle proprement : le prochain lot réclamé
renvoie `claimed: 0`, la boucle s'arrête d'elle-même) ; les ~190 jobs
`failed` par cette erreur précise remis en `pending` (`attempt_count`,
`last_error`, `finished_at` réinitialisés, `scheduled_at` +2h) — la cause
la plus probable étant transitoire (rythme), pas un vrai changement
définitif du formulaire FBI.

**Corrigé** : `ProcessFbiJobsButton` (le seul des deux boutons qui pilote
un vrai login FBI — `ParseFbiDocumentsButton` ne fait que de l'OCR/PDF
local, aucun risque équivalent) ajoute désormais `ROUND_DELAY_MS = 5000`
(pause entre deux lots) ET un coupe-circuit : `MAX_CONSECUTIVE_FULL_
FAILURES = 2` lots consécutifs entièrement en échec (`succeeded === 0`
alors que `claimed > 0`) interrompt la boucle plutôt que de vider toute
la file restante en échecs — un vrai blocage ne se corrige jamais en
insistant plus vite.

**Douzième déclenchement — la boucle auto ne s'arrêtait jamais (même
avec 0 job réellement disponible) : "ligne fantôme" de PostgREST.**
Repéré via les logs Vercel collés par le club juste après le repoussement
des `scheduled_at` (déclenchement précédent) : `"Job FBI réclamé"` avec
`jobId: null, clubId: null, type: null` — alors que `processJobBatch`
vérifie `if (!job) break;` avant de logger quoi que ce soit. Vérifié
directement en SQL : `select * from claim_next_fbi_job_for_club(...)`
quand rien n'est disponible renvoie **une ligne** dont CHAQUE colonne
vaut `null` (`{ id: null, club_id: null, ... }`), jamais zéro ligne — une
fonction PL/pgSQL `returns public.fbi_jobs` (composite, pas `SETOF`) est
appelée comme une fonction SCALAIRE : elle produit toujours exactement
une valeur de sortie, y compris quand cette valeur EST `null` en interne
(`if claimed_job.id is null then return null`) ; PostgREST sérialise
alors un objet aux champs tous `null`, jamais un `null` JSON bare. Ce
même bug affecte `claim_next_fbi_job` (le cron global) depuis le début —
jamais détecté car les tests unitaires existants mockent `{ data: null }`
directement, sans jamais exercer la vraie sérialisation PostgREST.

Conséquence concrète : `processJobBatch`'s `if (!job) break;` ne se
déclenchait JAMAIS (un objet est toujours "truthy" en JS) — `claimed`
était incrémenté à tort à chaque appel, la boucle continuait indéfiniment
(jusqu'à `MAX_ROUNDS`/le coupe-circuit du déclenchement précédent), et
chaque "job fantôme" partait en traitement avec `match_id: null` →
`processDiscoverEmarqueJob` échouait immédiatement à l'étape "Match
introuvable" (AVANT tout contact FBI, donc sans risque de blocage
anti-bot cette fois — les timestamps très rapprochés dans les logs du
club, ~200ms d'écart, en étaient déjà la preuve).

**Corrigé** : `claimNextJob`/`claimNextJobForClub` (`jobs/claim.ts`)
détectent maintenant cette ligne fantôme via `row.id === null` (même
sentinel que la fonction SQL elle-même) et renvoient `null` — jamais une
correction de la fonction SQL (compliquée à faire proprement pour une
fonction à ligne unique appelée via PostgREST), le garde-fou côté
application est plus simple et suffisant. Couvert par un test dans
`claim.test.ts` reproduisant exactement cette forme de réponse.

**Treizième déclenchement — le correctif `EMARQUE_MATCH_PAGE_NOT_REACHED`
avait lui-même un faux positif pour un numéro de rencontre court.** Une
fois les deux correctifs précédents déployés, le club a débloqué 3 jobs
réels pour tester (rencontres n°1, 4516, 1481). Résultat : n°1481 a
correctement échoué avec le diagnostic attendu (page restée sur "FBI -
Accueil") — mais n°1 a "réussi", en remontant EXACTEMENT les mêmes 5
documents génériques que ceux du bug initial ("e-Marque.pdf" ×3,
"Télécharger_e-Marque_V2/MiniBasket.pdf"). Cause : `pageMentionsMatchNumber`
utilisait `.includes(matchNumber)` — un simple test de sous-chaîne. Pour
un numéro à un seul chiffre comme "1", ce test réussit sur N'IMPORTE
QUELLE page contenant un nombre qui contient "1" (ici "2813", visible sur
la page de résultats de recherche par défaut) — donc quasiment n'importe
quelle page, vidant le garde-fou de son utilité pour ce cas.

**Corrigé** : `pageMentionsMatchNumber` recherche maintenant le numéro
comme un nombre ISOLÉ (`(?<!\d)matchNumber(?!\d)`, bordures non-chiffres
des deux côtés) plutôt qu'une sous-chaîne brute — "1" ne matche plus
l'intérieur de "2813" ou "1481". Reste imparfait par construction pour un
numéro à 1-2 chiffres très court (un vrai chiffre isolé identique
ailleurs sur la page resterait un faux positif possible), mais nettement
plus fiable qu'un `.includes()` nu. Testé explicitement contre ce cas
précis (numéro "1", page contenant "2813"). Le job de la rencontre n°1
déjà "réussi" à tort (5 documents génériques déjà en base) a été nettoyé
manuellement en base (SQL direct) et remis en attente.

**Quatorzième déclenchement — même faux positif persistant après le
correctif ci-dessus, toujours sur la rencontre n°1.** Une fois le
correctif "nombre isolé" déployé, la rencontre n°1 a de nouveau "réussi"
avec EXACTEMENT les mêmes 5 documents génériques — alors que n°4516 et
n°1481, elles, échouaient correctement avec le diagnostic attendu. Cause
trouvée : `pageMentionsMatchNumber` protège bien la vérification FINALE,
mais `tryOpenMatchResult` (l'étape de navigation qui clique sur le
résultat de recherche) utilisait ENCORE `getByText(matchNumber, { exact:
false })` — un test de sous-chaîne — AVANT cette vérification. Pour "1",
ça cliquait le premier élément de la page contenant "1" n'importe où (ex:
un lien de pagination "page 10"), atterrissant sur une page DIFFÉRENTE de
la page d'accueil (donc pas rattrapée par le garde-fou précédent) mais
qui n'est toujours pas la vraie page de la rencontre — et qui contenait,
par coïncidence ou par structure de page générique, de quoi passer aussi
le test "nombre isolé" (une page réellement inconnue peut légitimement
contenir un "1" isolé n'importe où : numéro de version, élément de liste,
etc.).

**Corrigé** : nouvelle fonction partagée `selectors.matchNumberAsIsolatedText`
(même regex bordures non-chiffres que `pageMentionsMatchNumber`, factorisée)
— `tryOpenMatchResult` l'utilise maintenant pour son `getByText(...)` AU
LIEU de `{ exact: false }`, donc ne clique plus jamais un élément dont le
texte ne contient le numéro que comme fragment d'un nombre plus grand.
Testé explicitement : une page de résultats sans correspondance réelle
mais contenant un lien décorateur "Voir la page 10" ne doit jamais être
cliquée pour la rencontre "1", jamais aboutir à `EMARQUE_MATCH_PAGE_NOT_
REACHED` cette fois via un vrai chemin de clic plutôt qu'une coïncidence
de texte. Rencontre n°1 de nouveau nettoyée en base — À CONFIRMER une
fois ce troisième correctif déployé : si le problème persiste encore
pour ce numéro précis, la piste la plus probable devient l'observation
directe du VRAI markup FBI (impossible depuis cet environnement, réseau
*.ffbb.com bloqué) plutôt qu'un nouvel ajustement de regex à l'aveugle —
les numéros n°4516/n°1481 étant, eux, correctement diagnostiqués à
chaque tentative, le cœur du correctif (distinguer succès réel d'échec
silencieux) est validé ; seule la fragilité inhérente d'un numéro à un
seul chiffre reste en jeu.

**Quinzième déclenchement — "3 jobs traités, 3 réussis" affiché côté
ball-manager-web alors qu'un seul avait réellement abouti.** Après déploiement des
correctifs ci-dessus, le club a reclique sur "Traiter les jobs FBI en
attente" : le bouton a affiché un succès complet pour un lot de 3, mais
les logs Vercel montraient deux `FbiError EMARQUE_MATCH_PAGE_NOT_REACHED`
(n°1481 et n°4516) DANS CE MÊME LOT, et la base ne montrait qu'UN SEUL
job réellement `finished_at`/`succeeded` (n°1) sur toute la fenêtre —
les deux autres étaient simplement repassés en `pending` (replanifiés).

**Cause** : `processDiscoverEmarqueJob`/`processTestConnectionJob` gèrent
LEURS PROPRES échecs en interne (`rescheduleJob`/`failJob`, voir plus
haut) et ne lèvent JAMAIS d'exception vers leur appelant, par design (pour
que la boucle de `processJobBatch` ne plante jamais sur un job en
particulier). Mais `processJobBatch` comptait `succeeded += 1` dès que
l'appel `await processXxxJob(...)` se terminait SANS lever d'exception —
confondant "n'a pas crashé" avec "a réellement réussi". Un job simplement
replanifié (page introuvable, rien à télécharger pour l'instant) se
comptait donc TOUJOURS comme un succès dans le résultat agrégé renvoyé à
ball-manager-web, même si la vraie ligne `fbi_jobs` repassait en `pending`.

**Corrigé** : les deux fonctions renvoient maintenant `Promise<boolean>`
(`true` UNIQUEMENT sur le chemin qui atteint réellement `status:
"succeeded"`, `false` sur tout chemin de reschedule/fail interne) au lieu
de `Promise<void>` — `processJobBatch` utilise cette valeur de retour au
lieu de la simple absence d'exception. Le `catch` autour de l'appel reste
en place pour le cas vraiment inattendu (crash avant que la fonction
gère elle-même son erreur). Couvert par deux tests dans
`process-batch.test.ts` : un job qui lève toujours compté en échec
(inchangé), et un NOUVEAU test explicite pour un job qui renvoie `false`
SANS lever d'exception — le vrai scénario de cette régression.

**Seizième déclenchement — le blocage ne dépend pas du numéro de
rencontre : TOUS les matchs testés restent sur "FBI - Accueil".** Une
fois le correctif de comptage déployé, le club a de nouveau cliqué
"Traiter les jobs FBI en attente" : la file globale (416 jobs, backlog
complet, plus seulement les 3 numéros de test) a recommencé à défiler.
Nouvel échec observé, rencontre n°752 (jamais testée avant, numéro à 3
chiffres, aucune ambiguïté possible avec un chiffre isolé) — même
diagnostic EXACT que n°1481/n°4516 : page actuelle "FBI - Accueil",
`https://extranet.ffbb.com/fbi/accueil.fbi`. Ce n'est donc PAS un
problème de longueur de numéro (les correctifs précédents sur ce point
restent corrects et nécessaires, mais ne sont pas la cause racine) : la
navigation ne quitte JAMAIS la page d'accueil post-login, pour AUCUN
numéro testé jusqu'ici. Suspect le plus probable :
`tryNavigateToSearchScreen` (`browser-client.ts`), le tout premier clic
best-effort — `page.getByRole("link", { name: /rencontre|compétition|
calendrier/i })` — ne trouve rien sur le VRAI accueil FBI (libellé
différent, élément qui n'est pas un `role=link`, etc.), jamais observable
depuis cet environnement (réseau `*.ffbb.com` bloqué).

**Corrigé (diagnostic, pas une correction de sélecteur — pas assez
d'évidence pour deviner un quatrième correctif à l'aveugle)** :
`EMARQUE_MATCH_PAGE_NOT_REACHED` inclut désormais la liste des liens
RÉELLEMENT visibles sur la page bloquée (`selectors.listVisibleLinks`,
texte + href, plafonné à 25) dans son message. Le prochain échec en
production révélera les libellés réels de navigation disponibles sur
l'accueil FBI, permettant d'ajuster `tryNavigateToSearchScreen` sur le
VRAI markup plutôt que sur une hypothèse — même méthode que celle qui a
permis de corriger le formulaire de login au tout début de cette
intégration. **Prochaine étape explicite** : récupérer le message
d'erreur complet du prochain job en échec (logs Vercel ou colonne
`fbi_jobs.last_error`) et l'analyser avant tout nouveau correctif de
sélecteur.

**Dix-septième déclenchement — le dump de liens révèle le MENU GLOBAL
ffbb.com, pas la navigation FBI ; trace étape par étape ajoutée.** Le
diagnostic ci-dessus a livré ses premiers résultats en production
(rencontre n°178) : les 25 premiers liens de la page "FBI - Accueil"
sont "Fédération", "Compétitions", "La Boulangère Wonderligue", "Ligue
Féminine 2", "Coupe de France", "Billetterie", "FFBB Store", "e-Marque"
(→ `ffbb.com/e-marque-v2`, confirme définitivement l'origine des
documents génériques du tout premier bug de cette section), "Calendriers",
"Désignations arbitrage" (→ pointe vers `connexion.fbi`, pas une page
FBI authentifiée), etc. — c'est le MENU GLOBAL du portail ffbb.com
(fédération, compétitions, boutique...), embarqué comme en-tête
persistant sur la page FBI, pas une navigation spécifique à l'extranet
FBI. Il matche `/compétition|calendrier/i` (§ `tryNavigateToSearchScreen`)
alors que ce lien mène à un AUTRE DOMAINE (`competitions.ffbb.com`),
jamais la recherche de rencontre FBI elle-même.

Ce dump de liens (plafonné à 25) ne suffisait PAS à savoir si le clic
avait seulement échoué, ou avait réussi mais changé de domaine sans
jamais revenir sur une page utile : il manquait une TRACE de ce que
chaque étape avait réellement fait. **Corrigé** : `tryNavigateToSearchScreen`/
`trySearchByMatchNumber`/`tryOpenMatchResult` renvoient chacune une
phrase de diagnostic (élément trouvé ou non, clic réussi ou non, URL
avant/après) au lieu de `Promise<void>` — la prochaine
`EMARQUE_MATCH_PAGE_NOT_REACHED` inclura une "Trace de navigation : [1]
... — [2] ... — [3] ..." précise, en plus de la liste de liens (portée à
60 pour dépasser le menu global répété et atteindre, si elle existe,
une vraie navigation FBI plus bas dans le DOM). **Prochaine étape** :
lire cette trace sur le prochain échec — si l'étape [1] montre que le
clic change bien de domaine vers `competitions.ffbb.com` (confirmant
l'hypothèse ci-dessus), la vraie correction sera de RETIRER
`compétition|calendrier` du regex de `tryNavigateToSearchScreen` (garder
`rencontre` seul, ou cibler un lien spécifiquement DANS le domaine
`extranet.ffbb.com`) et/ou chercher directement le champ de recherche
sans cette étape de clic intermédiaire, désormais contre-productive.

**Dix-huitième déclenchement — navigation reconstruite à partir d'une
capture d'écran du VRAI FBI, plus jamais devinée.** Après dix-sept
tentatives de correctifs basés uniquement sur des messages d'erreur et
des dumps de liens (jamais le markup réel, le réseau `*.ffbb.com` étant
bloqué depuis cet environnement — voir `docs/FBI_AUTHENTICATED_SPIKE.md`),
le club a fourni la première preuve visuelle directe de cette
intégration : deux captures d'écran de
`https://extranet.ffbb.com/fbi/rechercherRencontreSaisieResultat.fbi`
(l'écran de recherche de rencontre lui-même, et son tableau de
résultats). Elles révèlent :

- L'URL exacte de l'écran de recherche : `rechercherRencontreSaisieResultat.fbi`
  — jamais un lien à deviner/cliquer depuis l'accueil.
- Le tableau de résultats a des colonnes `Division | N° | Equipe 1 |
  Equipe 2 | Date de rencontre | Heure | Salle | EM | Score...`.
- La colonne **"EM"** contient le document e-Marque : un code cliquable
  (ex. "DCBLRCA7") ou une icône "FDM" pour une rencontre déjà jouée avec
  un e-Marque disponible, **vide** sinon (rencontre pas encore jouée, ou
  sans e-Marque) — ce n'était PAS un lien texte générique ("feuille de
  match", etc.) à chercher n'importe où sur la ligne ou la page, comme le
  supposait tout le code précédent.

**Corrigé — réécriture complète des trois étapes de navigation sur cette
base, jamais sur une hypothèse** :

- `tryNavigateToSearchScreen` navigue maintenant DIRECTEMENT vers
  `{baseUrl}/rechercherRencontreSaisieResultat.fbi` (`page.goto`) au lieu
  de chercher un lien à cliquer depuis l'accueil — élimine d'un coup
  toute la classe de bugs des seizième/dix-septième déclenchements
  (lien introuvable, ou menu global ffbb.com cliqué par erreur). L'ancien
  clic sur un lien de même origine reste en repli si cette URL directe
  échoue, au cas où elle ne serait pas valide pour tous les
  rôles/contextes FBI.
- `trySearchByMatchNumber` clique désormais le bouton "RECHERCHER"
  (`selectors.searchSubmitControl`, type submit en priorité) plutôt que
  de compter sur `Enter` seul (un formulaire non natif peut intercepter
  la soumission en JS).
- `tryOpenMatchResult` utilise un nouveau sélecteur
  `selectors.emarqueColumnLinkForMatch` : il lit l'index des colonnes
  "N°" et "EM" depuis les EN-TÊTES du tableau (jamais une position
  `nth-child` câblée en dur, conformément à la philosophie du fichier —
  voir l'en-tête de `selectors.ts`), trouve la ligne dont la cellule "N°"
  correspond EXACTEMENT (pas une sous-chaîne) au numéro recherché, puis
  clique le lien/bouton de SA cellule "EM" — renvoie `null` (jamais une
  erreur) si le tableau n'a pas cette forme, si la ligne n'existe pas, ou
  si sa colonne EM est vide (match pas encore joué : cas légitime, pas un
  échec).

**Découvert en écrivant les tests contre cette nouvelle logique (jamais
en production) — deux bugs supplémentaires, corrigés avant tout
déploiement** :

1. Le serveur HTTP de test synthétique (`src/test-support/static-server.ts`,
   utilisé UNIQUEMENT par les tests, jamais par le vrai FBI) ne déclarait
   pas `charset=utf-8` sur ses réponses `text/html` : Chromium décodait
   alors les octets UTF-8 du fichier fixture avec un autre charset par
   défaut, transformant "N°" en "NÂ°" — la recherche de colonne par
   libellé échouait donc silencieusement même avec la bonne logique.
   Corrigé en ajoutant `; charset=utf-8` aux réponses textuelles qui n'en
   déclarent pas déjà un.
2. Une fois ce problème d'encodage réglé, un test délibérément conçu pour
   piéger un faux positif de numéro court ("1") a quand même échoué :
   rester sur la page de résultats (ligne "1" introuvable, donc
   `emarqueColumnLinkForMatch` renvoie `null`) puis vérifier avec
   `pageMentionsMatchNumber` sur le texte ENTIER de la page matchait à
   tort — l'en-tête de colonne **"Score 1"** contient lui-même un "1"
   isolé (précédé d'un espace, suivi d'un saut de ligne), sans rapport
   avec le numéro de rencontre recherché. Corrigé avec un nouveau
   sélecteur `matchNumberInResultsTable` : quand un tableau de résultats
   est présent sur la page courante, la vérification finale de
   `findEmarqueDocuments` compare désormais la cellule "N°" de chaque
   ligne EXACTEMENT au numéro recherché (aucun risque de faux positif
   textuel) plutôt que de scanner tout le texte de la page ; le texte de
   page libre (`pageMentionsMatchNumber`) reste le seul recours sur une
   page SANS tableau (ex. la page de détail atteinte après un clic sur le
   lien EM).

Couvert par une réécriture complète de la fixture de test
(`__fixtures__/rechercher-rencontre.html`, qui reproduit fidèlement la
structure de colonnes observée) et du bloc de tests
`BrowserFbiClient.findEmarqueDocuments` (`browser-client.test.ts`) :
succès (colonne EM avec code cliquable), liste vide sans erreur (colonne
EM vide, rencontre pas encore jouée), `EMARQUE_MATCH_PAGE_NOT_REACHED`
pour une rencontre absente du tableau, et spécifiquement la régression du
faux positif "1"/"Score 1" décrite ci-dessus. C'est la première
correction de cette section entièrement basée sur une observation directe
du vrai FBI plutôt que sur une inférence à partir de logs d'erreur —
confiance nettement plus élevée que les dix-sept précédentes, mais reste
non confirmée en production tant que le prochain déploiement n'aura pas
été testé sur un vrai match SC Sète.

**Dix-neuvième déclenchement — la navigation directe fonctionne enfin
(première fois que la page réelle de recherche est atteinte en
production), mais le champ de recherche sélectionné est une checkbox.**
Test isolé sur 3 matchs réels (2813, 1481, 4516, file d'attente réduite
volontairement à ces 3 jobs pour ne pas bombarder FBI de requêtes
pendant le débogage) après déploiement du correctif précédent :

- **Étape [1] (navigation) RÉUSSIE** pour la première fois de toute cette
  série de corrections — `page.title()` confirme "FBI - Rechercher une
  rencontre pour la saisie des résultats", exactement la page attendue.
  Valide définitivement l'URL `rechercherRencontreSaisieResultat.fbi` et
  l'abandon de l'ancienne stratégie de clic sur un lien depuis l'accueil.
- **Étape [2] (remplissage du champ) EN ÉCHEC** : `locator.fill: Error:
  Input of type "checkbox" cannot be filled`. Le formulaire réel contient
  une checkbox "non joué" avec l'attribut
  `name="rechercheRencontreSaisieResultatForm.rechercherRencontreSaisieResultatBean.nonJoue"`
  — elle matche le motif `input[name*="rencontre" i]` de
  `selectors.matchNumberSearchInput` tout autant qu'un vrai champ texte.
  Playwright résout une liste de sélecteurs CSS séparés par des virgules
  dans l'ORDRE DU DOM (comme `querySelectorAll`), jamais dans l'ordre
  d'écriture des alternatives du code : cette checkbox apparaît AVANT le
  vrai champ numéro dans le markup réel, donc `.first()` la sélectionnait
  à tort.

**Corrigé** : `matchNumberSearchInput` exclut désormais explicitement les
types non-texte (`checkbox`, `radio`, `hidden`, `submit`, `button`) de
chacune de ses alternatives — élimine ce faux positif quel que soit
l'ordre du DOM, sans avoir à deviner une position ou un ordre de
priorité. La fixture `__fixtures__/rechercher-rencontre.html` reproduit
maintenant fidèlement cette checkbox (même `name`, placée avant le champ
texte) pour que le test de bout en bout (`browser-client.test.ts`,
premier test du bloc `findEmarqueDocuments`) couvre cette régression
exacte en continu.

**Méthode de test adoptée pour la suite** : plutôt que de relancer les
~400 jobs `discover_emarque` en attente à chaque itération (risque de
marteler FBI avec des identifiants réels pendant qu'on corrige des bugs
un par un), les jobs de TOUS les autres matchs sont repoussés de 30 jours
(`fbi_jobs.scheduled_at`) et seuls 2813/1481/4516 restent immédiatement
réclamables. Réinitialisés à chaque nouveau correctif (`attempt_count`,
`last_error`, `scheduled_at` remis à zéro) pour un cycle de test rapide
et ciblé. Le reste de la file ne sera réactivé qu'une fois ces 3 matchs
validés de bout en bout (document téléchargé ET parsé).

**Suite immédiate — le correctif checkbox déployé, la recherche
"réussit" mais ne renvoie AUCUNE ligne.** Nouveau test en production sur
les 3 mêmes matchs isolés : l'étape [2] montre cette fois `champ rempli
("2813") et recherche soumise, mais l'URL n'a pas changé` — le
remplissage/la soumission n'ont plus levé d'exception (la checkbox n'est
plus ciblée). Mais l'étape [3] ne trouve toujours aucun lien e-Marque, et
la liste des liens visibles ne contient AUCUNE trace de tableau de
résultats (seulement le menu global permanent) — pour un match RÉELLEMENT
joué (n°2813, score connu, preuve visuelle du code EM). Ce n'est donc pas
un problème de sélecteur de lien, mais une recherche qui n'a
véritablement rien retourné.

Hypothèse à vérifier sur preuve, pas à deviner (le réseau `*.ffbb.com`
reste bloqué depuis cet environnement) : un formulaire de ce type a très
probablement d'autres champs obligatoires que "N° Rencontre" — en
particulier une **saison** — qui filtrent la recherche. Les 3 matchs
testés datent tous de la saison 2025-2026 (joués entre septembre 2025 et
mai 2026) ; la date du jour en production est le 2026-09-24, donc en
saison 2026-2027. Si un sélecteur de saison sur cette page défaute sur la
saison EN COURS plutôt que sur celle du match recherché, la recherche ne
peut jamais aboutir, quel que soit le champ numéro ciblé.

**Corrigé (diagnostic, encore une fois — pas assez de preuve pour deviner
un cinquième champ à l'aveugle)** : `selectors.listFormFields` dump
désormais TOUS les champs du formulaire de la page (input/select/textarea),
avec pour un `<select>` le LIBELLÉ de l'option actuellement sélectionnée
— inclus dans le message `EMARQUE_MATCH_PAGE_NOT_REACHED` aux côtés de la
trace de navigation et des liens visibles. Le prochain échec révélera
l'état réel de chaque champ (nom du champ numéro ciblé également ajouté à
la trace de `trySearchByMatchNumber`, pour confirmer qu'il s'agit bien du
bon champ et pas d'un homonyme).

**Corrigé en même temps (bug réel, découvert en écrivant le test du
diagnostic ci-dessus, jamais en production)** : `matchNumberSearchInput`
combinait ses 4 alternatives dans un seul sélecteur CSS `a, b, c, d` —
résolu par Playwright dans l'ORDRE DU DOM, jamais dans l'ordre d'écriture
des alternatives (même piège que la checkbox du déclenchement précédent,
sous une forme différente : n'importe quel AUTRE champ texte matchant
`rencontre` avant le vrai champ "numero" dans le markup aurait pu être
ciblé à tort). Résout maintenant chaque alternative dans l'ordre de
priorité écrit dans le code (renvoie la première dont au moins un élément
existe), jamais une seule requête CSS fusionnée.

Couvert par une nouvelle fixture (`rechercher-rencontre.html`) qui ajoute
un `<select name="saison">` (option "2026-2027" sélectionnée) avant la
checkbox et le champ texte, et un nouveau test qui vérifie que le message
d'erreur contient `champ "numeroRencontre" rempli` (jamais supposé) et
`select[name=saison]="2026-2027"` dans le dump des champs de formulaire.

**Vingtième déclenchement — le dump révèle la cause racine définitive :
deux filtres par défaut, pas un problème de sélecteur.** Nouveau test en
production sur les 3 mêmes matchs isolés (2813, 1481, 4516), avec le
diagnostic du déclenchement précédent activé. Le dump complet du
formulaire confirme, sur preuve directe cette fois (jamais une
hypothèse) :

- `input[type=checkbox,name=...nonJoue]="true"` — la checkbox "non joué"
  (résultat pas encore saisi) est **cochée par défaut**. Cette page
  (`rechercherRencontreSaisieResultat.fbi` = écran de SAISIE de
  résultat) filtre donc naturellement aux rencontres dont le résultat
  n'est pas encore homologué — jamais les matchs déjà joués, précisément
  ceux qui ont un document e-Marque disponible.
- `select[name=...idSaison]="Saison 2026-2027"` — le sélecteur de saison
  défaute sur la saison EN COURS. Les 3 matchs de test datent tous de la
  saison 2025-2026 (joués entre septembre 2025 et mai 2026) ; la
  production tourne le 2026-09-24, donc en saison 2026-2027.

Ces deux filtres, actifs par défaut, expliquent à eux seuls tous les
échecs "recherche réussie mais aucun résultat" observés depuis le
Dix-neuvième déclenchement — indépendamment de tout bug de sélecteur.

**Corrigé** : nouvelle étape `tryPrepareSearchFilters` (entre la
navigation et la recherche par numéro) qui, à chaque appel de
`findEmarqueDocuments` :

1. Décoche systématiquement la case "non joué" si elle est cochée
   (`selectors.nonJoueCheckbox`, `Locator.isChecked()`/`uncheck()` — on
   ne cherche jamais un match "non joué" ici, quel que soit le match).
2. Sélectionne, dans `selectors.seasonSelect`, l'option dont le LIBELLÉ
   contient la saison du match (`Locator.selectOption()`) — jamais une
   valeur d'`<option>` devinée. La saison est calculée par l'appelant
   (`resolveSeasonLabel(match.match_datetime)`, déjà utilisée par
   ailleurs pour le chemin de stockage Supabase, désormais aussi passée
   à `findEmarqueDocuments` en 3ᵉ paramètre) AVANT l'appel, plutôt que
   recalculée en double.

La trace de navigation passe de 3 à 4 étapes (`[1]` navigation, `[2]`
préparation des filtres, `[3]` recherche par numéro, `[4]` ouverture du
résultat). Couvert par un nouveau test qui vérifie que le message
d'erreur contient `case "non joué" décochée`, `saison "Saison 2025-2026"
sélectionnée`, et que l'URL de soumission du formulaire contient
effectivement `idSaison=12` (la valeur de l'option choisie) — preuve que
la sélection a réellement été soumise, pas juste rapportée dans la
trace.

**Vingt-et-unième déclenchement — saison corrigée en production
(confirmée "Saison 2025-2026" dans le dump), mais toujours aucun
résultat ; deux angles morts du diagnostic comblés.** Nouveau test sur
les 3 mêmes matchs isolés après déploiement du correctif de saison. Le
dump confirme que la saison est bien passée à "Saison 2025-2026" — mais
la recherche pour n°2813 (preuve visuelle du code EM) ne trouve toujours
rien. Deux limites du diagnostic empêchaient d'aller plus loin :

1. `listFormFields` ne listait QUE `input`/`select`/`textarea` — jamais
   les `<button>`. Impossible de vérifier si `searchSubmitControl` avait
   réellement ciblé le bouton "RECHERCHER" plutôt qu'un autre bouton du
   même formulaire.
2. Le dump affichait la valeur de SOUMISSION fixe (`value="true"`) d'une
   checkbox comme si c'était son état coché — deux choses différentes.
   Ça avait fait conclure à tort, au déclenchement précédent, que la
   checkbox "non joué" était cochée par défaut alors que ce n'était pas
   prouvé (elle s'est révélée déjà décochée à l'exécution, la trace ne
   mentionnant "décochée" que quand une action a réellement eu lieu).

**Corrigé** : `listFormFields` inclut maintenant les `<button>` (texte
visible comme "valeur"), et lit l'état RÉEL d'une checkbox/radio via
`Locator.isChecked()` (`"checked"`/`"unchecked"`) au lieu de son
attribut `value` figé. Le texte du bouton effectivement cliqué est aussi
ajouté à la trace de `trySearchByMatchNumber`.

**Corrigé en même temps (amélioration défensive, pas une preuve directe
d'un bug — les noms de champs `identificationForm.identificationBean`,
`rechercheRencontreSaisieResultatForm...` évoquent une appli Java legacy
de type JSF, où un bouton peut soumettre en AJAX sans navigation ni
changement d'URL)** : `trySearchByMatchNumber` attend désormais AUSSI
`page.waitForLoadState("networkidle", { timeout: 5000 })` (best-effort,
en plus du délai fixe existant) après avoir soumis la recherche — un
délai fixe de 500ms pourrait ne pas suffire à un aller-retour serveur
réel en production pour un formulaire soumis en XHR.

Couvert par des tests étendus qui vérifient la présence de
`button[type=submit,name=]="RECHERCHER"` et `bouton "RECHERCHER"
cliqué"` dans le message, ainsi que le nouveau format `"checked"` (au
lieu de l'ancien `"true"` trompeur) pour l'état d'une checkbox.
**Prochaine étape** : le prochain échec en production révélera enfin,
sur preuve, si le bon bouton est ciblé et si un problème de timing AJAX
était en jeu — ou pointera vers autre chose (ex. un des champs encore
sur leur valeur "placeholder" : `idDivision`, `idPoule`, `numeroEquipe`).

**Vingt-deuxième déclenchement — PREMIER SUCCÈS DE BOUT EN BOUT (rencontre
n°1481, 5 documents "téléchargés"), mais deux nouveaux bugs découverts en
creusant le résultat : timeout d'infrastructure bloquant la file, et
documents leurres/dupliqués téléchargés au lieu des vraies données du
match.** Nouveau test sur les 3 mêmes matchs isolés après déploiement du
correctif précédent (dump des boutons + attente réseau) :

1. **`Job discover_emarque réussi`, n°1481, `documentsDownloaded: 5`** —
   la toute première fois, dans cette série de vingt et un correctifs,
   qu'un job atteint réellement `status: "succeeded"` contre le vrai FBI.
   Confirme que la navigation, le remplissage, la saison, la case "non
   joué" et le clic du bouton RECHERCHER fonctionnent tous ensemble.
2. **Immédiatement après, `Vercel Runtime Timeout Error: Task timed out
   after 300 seconds`** pendant le traitement du job suivant (n°4516,
   même lot de 3). Le job n°1481 a pris ~3min30 contre le vrai FBI (bien
   plus lent que les fixtures locales) — un lot de 3 jobs réels dépasse
   `maxDuration: 300`. Le process tué EN PLEIN TRAITEMENT du job suivant
   ne peut jamais exécuter son `finally` (fermeture de session/browser,
   `browser-client.ts`) : ce job reste bloqué en `status = 'claimed'`
   indéfiniment, ce qui bloque ENSUITE tout nouveau job pour ce club via
   la contrainte "un seul job actif par club" — constaté par une requête
   SQL directe, débloqué manuellement une première fois.

   **Corrigé** : `CLUB_JOB_BATCH_SIZE` (`routes.ts`) et `JOB_BATCH_SIZE`
   (`api/internal/index.ts`, cron) réduits de 3 à 1 — un seul job réel
   par invocation, largement sous `maxDuration: 300`. Le bouton "Traiter
   les jobs FBI en attente" boucle déjà automatiquement côté ball-manager-web, donc
   aucune perte fonctionnelle. **ET** : migration
   `20260924140000_fbi_jobs_claim_stale_recovery.sql` — la garde "un seul
   job actif par club" des deux fonctions `claim_next_fbi_job*` n'exclut
   désormais que les jobs `claimed`/`running` dont `claimed_at` est
   RÉCENT (< 10 minutes, largement au-dessus de `maxDuration` lui-même) :
   un job plus vieux que ça a forcément été tué par un timeout/crash, il
   ne bloque plus jamais la file indéfiniment — auto-guérison, plus
   besoin d'intervention manuelle en base.

3. **En inspectant les "5 documents téléchargés" pour n°1481** (le club a
   demandé pourquoi "Traiter les documents téléchargés" ne trouvait rien
   à parser malgré ce succès) : 4 lignes `match_documents` réellement
   présentes, TOUTES de type `other` (jamais `emarque_zip` — le seul type
   que `parseDownloadedEmarqueDocuments` traite, par design, voir le
   commentaire en tête de ce fichier : les documents séparés n'ont pas de
   parseur dédié). Mais surtout : l'une d'elles est
   `T_l_charger_e-Marque_V2.pdf` ("Télécharger e-Marque V2.pdf") — EXACTEMENT
   le lien-leurre du LOGICIEL e-Marque déjà identifié aux Quinzième/
   Seizième déclenchements sur l'accueil FBI, cette fois trouvé sur LA
   PAGE DE DÉTAIL atteinte après le clic sur le lien EM lui-même (jamais
   vérifié avant, faute d'un succès pour l'observer). Et 3 lignes
   nommées identiquement `e-Marque.pdf`, au MÊME `storage_path` (donc
   s'écrasant mutuellement dans Storage) — un même lien de document
   dupliqué 3 fois dans le DOM (même phénomène que le menu global déjà
   observé dupliqué 2-3 fois dans `listVisibleLinks`).

   **Corrigé** : `findDocumentLinks` (`selectors.ts`) exclut désormais
   explicitement les liens correspondant au logiciel e-Marque
   (`SOFTWARE_DOWNLOAD_PATTERN` : "e-Marque V2", "MiniBasket", "logiciel",
   "installer" — le motif générique `e-?marque` de
   `DOCUMENT_LABEL_PATTERN` les matchait à tort) et déduplique par `href`
   (jamais deux fois le même lien). `fileNameFromLabelOrUrl`
   (`browser-client.ts`) ajoute un court hash de l'URL au nom de fichier
   dérivé du libellé (repli générique, quand l'URL elle-même n'a pas
   d'extension exploitable) : deux documents DIFFÉRENTS au même libellé
   visible ("e-Marque") ne produisent plus jamais le même nom de fichier,
   donc plus jamais le même `storage_path` — élimine la classe de bug
   "écrasement silencieux en Storage" pour de bon, pas seulement pour ce
   cas précis.

Documents leurres/dupliqués supprimés manuellement pour n°1481
(`match_documents`), `emarque_status` et jobs des 3 matchs de test
remis à zéro pour un nouveau cycle de test propre. **Toujours ouvert** :
aucun des documents découverts pour n°1481 n'était un `.zip` — reste à
confirmer si CE match n'expose vraiment que des PDF séparés (auquel cas
le pipeline de parsing automatique, qui ne traite que les ZIP, ne
s'appliquera jamais à lui) ou si la vraie page de détail expose aussi un
ZIP que la découverte n'a pas trouvé — seul un prochain succès "propre"
(post-correctifs ci-dessus) le confirmera.

**Vingt-troisième déclenchement — le chemin "aucun document trouvé" (retry
silencieux) n'avait AUCUN diagnostic, contrairement au chemin d'échec dur.**
Nouveau test sur les 3 matchs isolés après déploiement des correctifs
précédents (batch size 1, auto-guérison, exclusion leurre/dédup) : la
rencontre n°2813 (preuve visuelle du code EM "DCBLRCA7") ressort avec
`documents.length === 0` — `processDiscoverEmarqueJob` traite ça comme un
cas légitime ("pas encore de document disponible"), reschedule
silencieusement, sans lever `EMARQUE_MATCH_PAGE_NOT_REACHED` et donc SANS
la trace de navigation/dump de champs/liens visibles qu'on a mis deux
déclenchements à construire. Un match confirmé comme ayant un vrai
document qui ressort à zéro mérite la même preuve qu'un échec dur — sinon
le prochain cycle repart à l'aveugle.

**Corrigé** : `findEmarqueDocuments` (`browser-client.ts`) logue
désormais (`logInfo`, jamais une exception — ce cas reste légitime et le
retry programmé reste le bon comportement) la trace de navigation
complète ET les liens visibles de la page dès que `documents.length ===
0` APRÈS confirmation qu'on est sur la bonne page pour ce match — visible
dans les logs Vercel au prochain passage, sans attendre un échec dur.

**Vingt-quatrième déclenchement — malgré saison/case/bouton corrects, la
recherche ne renvoie toujours rien ; dump du HTML brut du formulaire
pour voir la VRAIE structure au lieu de deviner.** Nouveau test après le
diagnostic précédent : les rencontres n°2813 et n°1481 échouent avec le
MÊME motif détaillé — et ce qu'il révèle est riche :

- La saison est bien "Saison 2025-2026" (correctement sélectionnée).
- La case "non joué" est `unchecked` (déjà décochée à l'arrivée sur la
  page, comme en réalité constaté aux déclenchements précédents).
- Le bouton effectivement cliqué est bien celui affichant "Rechercher".
- MAIS ce bouton "Rechercher" est `type="button"`, jamais `type="submit"` —
  confirme qu'il n'y a AUCUNE soumission de formulaire HTML native
  possible ici, uniquement un gestionnaire JS.
- Chaque `<select>` (idSaison, idDivision, rechercherEquipe2, idPoule,
  numeroEquipe) est accompagné d'un `<button type="button">` JUMEAU
  affichant la MÊME valeur (`button[...]="Saison 2025-2026"`,
  `button[...]="Division"`...), plus des boutons `"×"` (probablement pour
  vider les champs de date) — signature typique d'un widget JS
  (React/Vue/PrimeFaces-like) qui enrichit un `<select>` natif d'une
  interface personnalisée.

Le bouton reflète bien la valeur qu'on a sélectionnée via
`Locator.selectOption()` (donc la sélection semble RÉELLEMENT prise en
compte par le framework, pas juste écrite dans un `<select>` caché
ignoré) — ce qui infirme l'hypothèse la plus simple ("l'état JS n'est
jamais synchronisé"). La cause exacte de l'absence de résultat reste
donc INCERTAINE avec les preuves actuelles : possible désynchronisation
plus subtile, validation cliente bloquante, ou un champ requis
supplémentaire non identifié.

**Corrigé (diagnostic, pas un correctif de comportement — pas assez de
certitude pour deviner une interaction précise sans risquer un
cinquième cycle dans le vide)** : `selectors.formHtmlSnippet` dump le
HTML BRUT (`outerHTML`, plafonné à 4000 caractères) du premier `<form>`
de la page — inclus dans le message `EMARQUE_MATCH_PAGE_NOT_REACHED` ET
dans le nouveau log "aucun document retenu" (Vingt-troisième
déclenchement). Le prochain échec révélera la structure EXACTE de ces
widgets (classes CSS, attributs `data-*`, wrapper DOM) — nécessaire pour
soit corriger l'interaction (cliquer le widget custom au lieu du
`<select>` natif, si c'est bien le problème), soit découvrir la vraie
cause si ce n'est pas ça.

**Vingt-cinquième déclenchement — le dump HTML révèle qu'il dumpait le
MAUVAIS formulaire depuis le début.** Premier retour en production du
correctif précédent (via le log "aucun document retenu", niveau `info` —
le club a dû déplier une entrée de log Vercel groupant plusieurs lignes
pour le trouver). Le `formHtml` obtenu pour la rencontre n°1481 est :

```html
<form id="identificationEntete" name="identificationEntete" action="/fbi/identification.fbi" method="post">
  <input type="hidden" name="identificationForm.identificationBean.identifiant" value="">
  <input type="hidden" name="utilisateurId" value="">
  <input type="hidden" name="isConnexionEntete" value="true">
</form>
```

Un formulaire d'EN-TÊTE minuscule (3 champs cachés d'identification),
PAS le formulaire de recherche — alors que `formFields`
(`listFormFields`, qui lit DANS TOUS les formulaires de la page, pas
juste un seul) montrait bien les vrais champs de recherche
(saison/case/numéro/bouton) juste à côté dans le MÊME log. Cause : la
page a PLUSIEURS `<form>`, et ce formulaire d'en-tête précède le vrai
formulaire de recherche dans le DOM — `formHtmlSnippet`
(`page.locator("form").first()`) prenait donc systématiquement le
mauvais. Toute la piste des widgets JS "boutons jumeaux" du Vingt-quatrième
déclenchement reste valide (visible dans `formFields`), mais on n'avait
en réalité JAMAIS vu le HTML du bon formulaire pour la confirmer/l'infirmer.

**Corrigé** : `formHtmlSnippet` s'ancre désormais sur `seasonSelect` (un
champ connu du VRAI formulaire de recherche) puis remonte à SON `<form>`
ancêtre via `xpath=ancestor::form[1]` — même principe que `loginForm`
plus haut dans ce fichier pour le formulaire de connexion, jamais une
position DOM devinée. Couvert par un nouveau `<form id="identificationEntete">`
décoy ajouté à la fixture `rechercher-rencontre.html` (avant le vrai
formulaire, reproduisant exactement la structure de production) et une
assertion que le dump NE contient PAS `identificationEntete`.

**Vingt-sixième déclenchement — le dump du bon formulaire arrive enfin,
mais tronqué à 4000 caractères sur un formulaire qui en fait ~43000 :
révèle que c'est le widget jQuery `bootstrap-select`, mais se coupe
avant d'atteindre le bouton "Rechercher".** Nouveau test sur les 3
matchs isolés : le `formHtml` pour la rencontre n°1481 montre enfin le
VRAI formulaire (`id="rechercheRencontreSaisieResultatForm"`,
confirmé) — mais le sélecteur "Division" seul liste des centaines
d'`<option>` (ex : "0034 - Coupes et tournois - CH U9M-2"...), poussant
le formulaire bien au-delà de la limite de troncature AVANT même
d'atteindre le champ numéro ou le bouton de recherche, plus loin dans
le DOM.

Ce dump confirme malgré tout une hypothèse en suspens depuis le
Vingt-quatrième déclenchement : c'est le widget jQuery **bootstrap-select**
(bibliothèque très répandue, bien documentée), pas un framework JS
propriétaire exotique. Structure observée pour le `<select>` de saison :
```html
<div class="dropdown bootstrap-select ...">
  <select name="...idSaison" id="idSaison" class="selectpicker ...">
    <option value="1037" selected="selected">Saison 2026-2027</option>
    <option value="1036">Saison 2025-2026</option>
    ...
  </select>
  <button type="button" class="btn dropdown-toggle ..." title="Saison 2025-2026">...</button>
  <div class="dropdown-menu">...</div>
</div>
```
L'attribut HTML `selected="selected"` reste figé sur l'option par
défaut d'origine (2026-2027) même après notre sélection — ARTEFACT
CONNU du DOM (l'attribut HTML `selected` reflète le rendu initial côté
serveur, jamais resynchronisé automatiquement par le navigateur après
une sélection programmatique ; c'est la PROPRIÉTÉ `selected`, invisible
dans un dump `outerHTML`, qui change réellement). Le bouton affichant
bien "Saison 2025-2026" (sa valeur RÉELLEMENT affichée à l'écran, lue
depuis le DOM live) est la preuve que `bootstrap-select` écoute
correctement l'événement `change` du `<select>` natif et se resynchronise
— la sélection de saison fonctionne donc réellement, contrairement à
l'hypothèse "état JS jamais synchronisé" envisagée au déclenchement
précédent.

**Corrigé** : nouveau `selectors.searchControlsHtmlSnippet`, qui cible
directement le conteneur `.row` le plus proche du bouton de recherche
(`searchSubmitControl`) plutôt que le formulaire entier — inclus dans le
message d'erreur ET le log "aucun document retenu", aux côtés du dump
du formulaire complet (toujours utile pour les champs en amont comme la
saison). Couvert par une fixture étendue avec ~150 `<option>` de
remplissage (reproduisant la taille réelle) pour vérifier que le dump
ciblé atteint bien le bouton "Rechercher" et le champ numéro malgré la
troncature du formulaire complet.

**Vingt-septième déclenchement — capture réseau du clic, et le
diagnostic devient consultable directement en base (plus besoin de
relayer les logs Vercel à la main).** Le club a fait remarquer, à raison,
que le cycle "coller un log → attendre un correctif → recliquer →
recoller un autre log" est lourd et lent — et a proposé un accès direct à
FBI. Vérifié sur preuve : cet environnement bloque TOUT accès réseau
sortant non explicitement autorisé (confirmé par un test direct vers
`extranet.ffbb.com` ET vers le propre déploiement Vercel de l'API — les
deux rejetés par la politique réseau de l'environnement), donc même avec
des identifiants un accès direct est impossible. Deux améliorations
concrètes réduisent quand même le coût de chaque cycle :

1. **Capture réseau du clic sur "Rechercher"** (`trySearchByMatchNumber`,
   `browser-client.ts`) : après plusieurs cycles à deviner depuis le DOM
   (saison/case/bouton tous confirmés corrects, toujours aucun résultat),
   la seule preuve définitive de ce qui se passe RÉELLEMENT au clic est
   la requête HTTP elle-même. Capture désormais toute requête
   XHR/fetch/POST survenant après le clic — méthode, URL, corps envoyé
   (révèle si saison/numéro sont bien transmis au serveur), et un extrait
   de la réponse (révèle si le serveur renvoie déjà les bonnes données —
   auquel cas le problème serait côté rendu client, jamais côté
   recherche — ou rien du tout). Inclus dans la trace de navigation,
   donc dans le message d'erreur ET le diagnostic "aucun document
   retenu".
2. **Le diagnostic "aucun document retenu" (Vingt-troisième
   déclenchement) est désormais renvoyé par `findEmarqueDocuments` à
   l'appelant** (nouveau champ `diagnostic: string | null` sur son type
   de retour, `{ documents, diagnostic }` au lieu d'un simple tableau),
   PAS SEULEMENT loggé — `process-discover-emarque.ts` le persiste dans
   `fbi_jobs.last_error` (même colonne déjà utilisée pour un vrai échec,
   préfixé `[info, pas une erreur]` pour éviter toute confusion). Cette
   colonne est directement consultable via une requête SQL sur Supabase —
   sans dépendre des logs Vercel, que seul un humain avec accès au
   dashboard peut lire et coller manuellement à chaque itération.

Le club doit toujours déclencher le job (bouton "Traiter les jobs FBI en
attente" côté ball-manager-web) — ça, rien ne peut le remplacer depuis cet
environnement — mais le RÉSULTAT (succès, échec dur, ou "aucun document
retenu" avec sa trace complète incluant maintenant la capture réseau)
devient consultable directement, sans étape de copier-coller.

**Vingt-huitième déclenchement — le diagnostic consultable en base révèle
enfin la vraie mécanique de FBI : DataTables + un lien EM sans `href`.**
Premier résultat lu directement en base (sans que le club n'ait besoin de
relayer un log) pour la rencontre n°1481. La capture réseau du clic sur
"Rechercher" (déclenchement précédent) montre la séquence RÉELLE :

1. `POST .../rechercherRencontreSaisieResultat.fbi?action=controleRecherche`
   — une étape de validation, renvoie un tableau HTML avec `<tbody></tbody>`
   VIDE (jamais les données).
2. `GET .../rechercherRencontreSaisieResultat.fbi?action=executeRecherche&...
   &sEcho=1&iColumns=14&...` — le VRAI appel, au format **DataTables**
   server-side classique (paramètres `sEcho`/`iColumns`/`iDisplayStart`...),
   réponse JSON `{"iTotalRecords":1,"aaData":[[...]]}` contenant la ligne
   RÉELLE du match 1481 (équipes, date, score). La colonne EM contient :
   `<a class="emarquepictureafter emarqueV2200000013858788"
   onclick="telechargerMatch('hpSiYXprCd6ZgGhweKzIfw%3D%3D','200000013858788')">`
   — **aucun `href`**, juste un gestionnaire `onclick` JS.

La trace confirme que `emarqueColumnLinkForMatch` a bien trouvé CE lien et
que le clic a eu lieu (`[4] lien EM "" cliqué`) — la découverte de la
ligne et du lien EM fonctionne donc déjà correctement, y compris pour un
lien sans `href`. Mais cliquer un `onclick` ne change jamais l'URL et ne
laisse rien à scanner sur la page pour `findDocumentLinks` (qui exige
`a[href]`) : `telechargerMatch()` déclenche presque certainement un
téléchargement natif du navigateur (nom de fonction explicite), une
popup, ou un appel réseau qu'on ne capturait pas encore À CETTE étape
précise (seule `trySearchByMatchNumber` capturait le réseau jusqu'ici,
jamais `tryOpenMatchResult`).

**Corrigé** : `tryOpenMatchResult` capture désormais, autour du clic sur
le lien EM, les mêmes catégories de preuve que `trySearchByMatchNumber` —
requêtes réseau XHR/fetch/POST (méthode, URL, corps, extrait de réponse)
— PLUS les événements Playwright `download` (téléchargement natif :
URL, nom de fichier suggéré) et `popup` (nouvel onglet/fenêtre : URL).
Le prochain passage révélera lequel des trois se produit réellement au
clic sur ce lien — la preuve manquante pour enfin capturer le vrai
document au lieu de conclure "aucun document retenu".

**Découvert en écrivant le test de ce correctif (jamais en production)** :
un élément dont les dimensions visibles dépendent d'une classe CSS
(`emarquepictureafter`, une icône) mais SANS cette CSS chargée (comme
notre fixture de test, ou toute page où le CSS n'a pas fini de charger)
reste invisible (0×0) — `Locator.click()` attend alors l'intégralité de
son délai d'actionabilité PAR DÉFAUT (30s, exactement le budget d'un
test Vitest par défaut) avant d'abandonner, consommant un tiers du
budget d'un job entier pour un clic qui n'aboutira jamais. Corrigé avec
un timeout explicite et court (10s) sur ce clic précis — échoue vite et
clairement plutôt que de gaspiller le budget du job.

**Vingt-neuvième déclenchement — CONFIRMÉ EN PRODUCTION (rencontre
n°1481) : le clic EM déclenche un vrai téléchargement natif, avec une URL
réutilisable — le document est maintenant traité comme n'importe quel
autre document découvert.** La capture ajoutée au déclenchement précédent
a immédiatement porté ses fruits, lue directement en base :

```
téléchargement natif déclenché : url=https://extranet.ffbb.com/fbi/
telechargerFeuilleMatchEmarque.fbi?action=emV2&plugin=true&idRenc=
hpSiYXprCd6ZgGhweKzIfw%3D%3D, nom suggéré="OCC_RF2_MED_1481_SPORT_CLUB_DE
_SETE_BASKET_LA_CROIX_D_ARGENT_B_MONTPELLIER-2.zip"
```

`telechargerMatch()` déclenche donc bien un téléchargement natif du
navigateur (pas une popup, pas un simple appel AJAX) — l'hypothèse posée
au déclenchement précédent. Point important : `download.url()` est une
VRAIE URL FBI ré-appelable via `context.request.get()` (mêmes cookies de
session que `downloadDocument()`), jamais un `blob:` temporaire propre à
l'instance Chromium qui l'a téléchargée — elle peut donc être fetchée à
nouveau plus tard, exactement comme un lien `href` classique.

**Corrigé** : `tryOpenMatchResult` retourne désormais `{ trace,
discoveredDocument }` au lieu d'une simple trace texte —
`discoveredDocument` vaut `{ url: download.url(), fileName:
download.suggestedFilename() }` quand un téléchargement natif est
détecté, `null` sinon. Le fichier réellement écrit par Playwright dans
`/tmp` (stockage éphémère de @sparticuz/chromium, voir
`browser-launcher.ts`) est supprimé (`download.delete()`, best effort) —
inutile, puisque le VRAI téléchargement passera par `downloadDocument()`
comme tout autre document. `findEmarqueDocuments` fusionne ce document
découvert dans son tableau `documents` (dédupliqué par URL avec ceux
trouvés par `findDocumentLinks`), donc `process-discover-emarque.ts` n'a
besoin d'aucun changement : le document EM suit exactement le même
pipeline téléchargement/Storage/`match_documents` que n'importe quel
autre.

Non re-testé avec un vrai événement `download` Playwright dans
`browser-client.test.ts` : simuler un téléchargement natif réel dans ce
harnais Chromium headless (`window.location.href` vers un zip, puis un
`<a download>` généré dynamiquement) a fait planter Vitest pendant 30s à
plusieurs reprises lors de l'écriture du correctif précédent — la
fixture n°5555 reste volontairement un simple `fetch()` de télémétrie
(valide le chemin de capture réseau, pas la capture `download`). La
mécanique de fusion `discoveredDocument` → `documents` est, elle, prouvée
par preuve de production ci-dessus plutôt que par une simulation locale.

**Trentième déclenchement — le ZIP e-Marque est confirmé téléchargé en
production (n°1481), mais deux bugs distincts empêchaient son parsing
d'aboutir, tous deux de la même famille que le correctif `pdfjs-dist`
(un fichier lu dynamiquement par `fs`, jamais tracé par le pipeline de
build Vercel).**

1. **`pdfjs-dist` — confirmé résolu par le correctif du déclenchement
   précédent.** Le parsing du PDF a bien progressé au-delà de l'étape
   d'extraction de texte natif (0 caractère, comme attendu pour un
   e-Marque V2 — voir `pdf-text-extractor.ts`), donc est bien tombé sur le
   repli rastérisation + OCR (`pdf-raster-ocr-extractor.ts`).
2. **`tesseract.js-core` — même famille de bug, jamais rencontrée avant
   d'avoir un vrai document à parser.** Erreur en production :
   `Setting up fake worker failed: Cannot find module '/var/task/
   node_modules/tesseract.js-core/tesseract-core-relaxedsimd.wasm'`.
   `tesseract.js` (`worker-script/node/getCore.js`) détecte au RUNTIME le
   support WASM SIMD de l'environnement (`wasm-feature-detect`) puis
   `require()` UN des 6 fichiers `tesseract-core-*.js`/`.wasm` possibles
   selon le résultat — un choix qui ne peut être connu qu'à l'exécution,
   jamais par l'analyse statique de la pipeline de build Vercel (§
   déclenchement précédent pour `pdfjs-dist`, même cause). Contrairement
   au worker `pdfjs-dist`, `tesseract.js-core` n'expose aucun point
   d'extension type `globalThis.pdfjsWorker` pour contourner ce `require`
   dynamique — la seule solution robuste est de forcer Vercel à inclure
   physiquement TOUT le paquet dans le déploiement, peu importe la
   variante réellement choisie à l'exécution (qui peut d'ailleurs varier
   selon la version exacte du runtime Node/V8 de la Lambda).
3. **Le modèle de langue OCR (`fra.traineddata`) n'a en réalité JAMAIS été
   porté depuis ball-manager-web lors de la migration vers ce repo — bug distinct,
   resté invisible car jamais atteint avant que le point 2 ne soit
   corrigé.** `pdf-raster-ocr-extractor.ts` pointait
   `OCR_LANG_PATH` vers `src/server/emarque/ocr-data` — une convention
   Next.js de l'ancien monolithe ball-manager-web (répertoire déclaré via
   `next.config.ts#outputFileTracingIncludes`, voir l'historique Git de
   ball-manager-web, commit `5db6b6a`), jamais adaptée à la structure de
   `ball-manager-back` (pas de `src/server/`, voir `ARCHITECTURE.md`) ni
   au mécanisme d'inclusion propre à ce repo (`vercel.json`, pas
   `next.config.ts`) — ce dossier n'a jamais existé ici.

**Corrigé** (les trois, docs/EMARQUE.md pour le détail) :
- `fra.traineddata` (+ son `README.md`, licence Apache 2.0,
  `tesseract-ocr/tessdata_fast`) porté depuis l'historique Git de ball-manager-web
  vers `src/integrations/emarque/ocr-data/` (checksum SHA-256 vérifié
  identique à l'original) — emplacement cohérent avec la structure de ce
  repo (sibling de `extractors/`, `normalizers/`, etc.), `OCR_LANG_PATH`
  mis à jour en conséquence.
- `vercel.json` (`functions."api/index.ts".includeFiles`) force
  désormais l'inclusion de `node_modules/tesseract.js-core/**` (~44 Mo,
  négligeable à côté de `@sparticuz/chromium` déjà embarqué pour
  `BrowserFbiClient`) et de `src/integrations/emarque/ocr-data/**` — les
  deux catégories de fichiers lus dynamiquement par `fs`, jamais par
  `require`/`import` statique, donc jamais tracés automatiquement.

Aucun de ces trois bugs ne remet en cause le correctif FBI du
déclenchement précédent : la découverte et le téléchargement du document
e-Marque fonctionnent bout en bout en production, confirmé sur preuve
(n°1481). Ce qui restait cassé se situait entièrement en aval, dans le
pipeline de parsing PDF/OCR — hérité verbatim de ball-manager-web (§ "Ce module est
un report quasi verbatim", docs/EMARQUE.md) sans qu'aucun document réel
n'ait jamais auparavant atteint cette étape en production sur
`ball-manager-back` pour révéler ces deux angles morts de la migration.

**Trente-et-unième déclenchement — le premier vrai document "résumé" de
production révèle deux bugs dans la calibration des zones OCR (jamais
dans FBI lui-même) : un décalage de ligne complet, et une fragilité de
lecture ligne-entière déjà identifiée en théorie mais jamais mesurée sur
un vrai document.** Le club a fourni directement le PDF `resume_*.pdf` de
la rencontre n°1481 (le pipeline correctif précédent l'avait bien
téléchargé et parsé, mais l'onglet "Statistiques" affichait des valeurs
clairement fausses — un joueur avec 101 points, des champs manquants). Ce
PDF réel a permis, pour la première fois, de calibrer `resume-layout.ts`
contre de vraies coordonnées pixel (détection automatique des lignes de
grille sur le rendu produit par notre propre pipeline, vérifiée en
superposant les lignes détectées sur l'image d'origine et en OCR-ant
isolément des cellules choisies) plutôt que par estimation visuelle ou
symétrie, comme documenté depuis l'origine (`resume-layout.ts` :
"Équipe B... coordonnées estimées par symétrie... confiance plus
faible").

Deux bugs distincts confirmés :

1. **Décalage de ligne complet sur l'équipe LOCAUX.** `rowTop: 748` avait
   été calibré visuellement comme "le bas de l'en-tête" — en réalité l'
   en-tête s'étend plus haut, et 748 tombe déjà sur le DEUXIÈME joueur.
   Conséquence : le premier joueur de CHAQUE relevé "résumé" LOCAUX
   disparaissait entièrement (jamais un champ faux : la ligne entière
   n'était jamais lue). Confirmé en isolant la cellule maillot à
   `y=685` : lecture OCR "1" (le bon joueur), jamais "4" (lu à `y=752`,
   l'ancien calibrage). L'équipe VISITEURS n'avait PAS ce décalage
   (vérifié de la même façon : `y=2064` lit bien "4", le bon premier
   visiteur).
2. **Lecture ligne entière + `extractTrailingIntegers` : le bug
   théorique du "Trentième déclenchement" (implicite dans le commentaire
   du fichier) est confirmé sur un vrai document.** La ligne entière
   d'un joueur (numéro + nom + temps de jeu + 7 statistiques) est lue en
   UN SEUL appel OCR, puis les 7 derniers nombres entiers de cette
   chaîne sont supposés être les 7 statistiques — mais le numéro de
   maillot ET le temps de jeu ("23:35" contribue déjà "23" et "35" comme
   entiers isolés) contribuent des entiers AVANT les vraies statistiques.
   Dès qu'UN SEUL chiffre est mal lu n'importe où dans la ligne (très
   probable sur une ligne aussi large — jusqu'à 2400px), TOUTES les
   statistiques de cette ligne se décalent silencieusement. C'est
   précisément ce qui produisait des valeurs absurdes (101 points) et
   des champs vides signalés par le club.

**Corrigé** :
- `resume-layout.ts` : `rowTop` de l'équipe LOCAUX passé de 748 à 681
  (vérifié par lecture OCR isolée, jamais réestimé à l'œil), colonnes X
  mesurées précisément pour les 11 colonnes du tableau (maillot, nom,
  titulaire, temps, et les 7 statistiques).
- `parse-resume.ts` : chaque colonne est désormais lue par un appel OCR
  SÉPARÉ (`extractSingleInteger`, jamais `extractTrailingIntegers` sur la
  ligne entière) — un chiffre mal lu n'affecte plus que SA colonne,
  jamais les 10 autres champs de la ligne. Appels toujours séquentiels
  (jamais `Promise.all`, voir le commentaire dans `parse-feuillematch.ts`
  sur la corruption constatée en développement avec des appels
  concurrents sur un même worker OCR partagé).
- `PdfRasterOcrExtractor.extractZone` : nouvelle option
  `expectDigitsOnly` — si la première passe OCR (réglages par défaut) ne
  trouve AUCUN chiffre sur une cellule censée être numérique, une seconde
  passe (agrandissement 2×, alphabet restreint aux chiffres) est
  tentée. Mesuré sur un échantillon de 120 cellules réelles (13 joueurs ×
  ~9 champs) : 71,7 % de cellules correctes avant tout correctif, 83,3 %
  avec la seule correction "O"/"o" isolé → "0" (confusion OCR
  systématique : 14 occurrences sur 14 dans l'échantillon), 89,2 % avec
  la seconde passe. Restant : quelques cellules restent honnêtement
  `null` (jamais une valeur devinée, voir `extractSingleInteger`) plutôt
  que fausses — cohérent avec le principe déjà affiché côté frontend
  ("« — » signifie une donnée non lue avec certitude, jamais une valeur
  nulle supposée").
- `text-fields.ts` : nouvelle fonction `extractSingleInteger` (une seule
  cellule isolée, jamais une ligne entière), avec la correction "O"/"o" →
  "0" intégrée.
- Premier test de ce module contre un VRAI document (`parse-resume.test.ts`,
  fixture `__fixtures__/resume-1481.pdf`, fournie directement par le
  club) — jusqu'ici uniquement testé manuellement pendant le
  développement (voir `docs/FBI_AUTHENTICATED_SPIKE.md`), jamais en CI.

Limite connue, acceptée plutôt que sur-corrigée : un nombre à deux
chiffres avec un chiffre répété (ex : "11") est parfois lu comme un seul
chiffre par la première passe OCR (une valeur non-null mais fausse,
jamais détectée par le mécanisme de repli qui ne se déclenche que sur une
cellule totalement illisible) — constaté sur un seul joueur de
l'échantillon réel. Corriger ce cas précis demanderait une heuristique
supplémentaire non justifiée par une seule occurrence ; le principe
directeur reste `null` plutôt qu'une valeur devinée pour tout le reste.

**Trente-deuxième déclenchement — le correctif précédent tourne bien en
production (les valeurs affichées correspondent exactement à ce qui avait
été validé localement), mais 12 des 15 joueurs de la rencontre n°1481
manquaient encore entièrement de l'onglet "Statistiques" côté ball-manager-web.**
Root-cause, PAS un nouveau bug OCR : `mergePlayersWithStats` (`merge.ts`)
conservait bien une ligne de statistiques "resume" sans joueur
correspondant dans l'effectif "feuillematch" (comportement déjà testé et
documenté), mais `persist-emarque-match.ts#insertPlayerStats` cherche un
`participant_id` par `${teamSide}:${jerseyNumber}` et **ignore
silencieusement** toute ligne sans correspondance — jamais une erreur,
jamais un avertissement qualité, juste une statistique qui n'atteint
jamais la base. Le document "feuillematch" (composition/effectif) a sa
propre calibration OCR, JAMAIS revue ni validée avec la même rigueur que
"resume" ce déclenchement-ci (aucun exemplaire réel fourni pour ce
document précis) — voir `feuillematch-layout.ts`, dont le commentaire
d'origine signale déjà "Équipe B... confiance plus faible" ; c'est là
qu'était le trou, jamais dans le pipeline "resume" corrigé au
déclenchement précédent.

**Corrigé sans attendre un exemplaire réel de "feuillematch"** (qui
resterait la correction la plus rigoureuse à terme, voir la limite
ci-dessous) : `mergePlayersWithStats` synthétise désormais un joueur
minimal à partir de la ligne "resume" elle-même (numéro de maillot, nom,
statut titulaire — déjà lus par `parse-resume.ts`) quand aucun joueur
"feuillematch" ne correspond, pour que `insertParticipants` crée bien une
ligne à laquelle `insertPlayerStats` peut rattacher la statistique.
Jamais de licence inventée (`licenseNumber: null`, jamais de
`licencie_id`) — seule l'identité de base vient de "resume" ; une vraie
correspondance de numéro de licence reste l'unique façon de relier un
participant à un licencié existant (ARCHITECTURE.md §22/§26). Un test
existant qui documentait EXACTEMENT l'ancien comportement ("une ligne de
statistiques sans joueur correspondant... `merged` reste vide") a été mis
à jour pour refléter le nouveau comportement voulu — ce n'était pas un
bug caché, c'était un choix de conception jamais reconsidéré à la lumière
de son effet en aval (une ligne "conservée" par le parseur mais
silencieusement perdue par la persistance équivaut, pour l'utilisateur, à
une ligne perdue).

Limite restante, honnêtement documentée plutôt que masquée : les
statistiques d'un joueur synthétisé de cette façon ne seront JAMAIS
rattachées à un licencié (pas de numéro de licence dans "resume"), donc
jamais visibles depuis la fiche d'un licencié — seulement depuis la fiche
du match. Calibrer `feuillematch-layout.ts` avec la même rigueur que
`resume-layout.ts` (coordonnées pixel par pixel contre un vrai document,
voir le déclenchement précédent) reste la correction de fond à faire dès
qu'un exemplaire réel de ce document sera disponible — ce correctif-ci
supprime la perte de données observable, pas la cause profonde côté
"feuillematch".

**Trente-troisième déclenchement — le correctif précédent créait un
DOUBLON exactement dans le cas qu'il devait éviter.** Signalé par le club
via l'UI : deux joueuses ("#? COUIX L. Ô (C)" et "#? MESTRES J. LI")
affichées avec un numéro de maillot manquant, alors qu'il "figure bien
sur les docs". Vérifié en base (`match_participants`, rencontre n°1481) :
chacune de ces deux joueuses avait EFFECTIVEMENT deux lignes — une
provenant de "feuillematch" (nom abrégé bruité mais numéro de LICENCE
correct, ex. `VT640539`, et capitanat correctement lu pour COUIX) avec
`jersey_number = null`, et une SECONDE synthétisée par le correctif du
déclenchement précédent à partir de "resume" (nom propre, maillot correct,
mais sans licence). Cause : `feuillematch` avait bien trouvé la personne
(nom, licence, capitanat) mais avait échoué à lire SEULEMENT son numéro de
maillot — la comparaison stricte par maillot exact ne pouvait jamais
rapprocher ces deux lignes du MÊME document logique, donc chaque source
produisait la sienne.

**Corrigé** : `mergePlayersWithStats` tente désormais, pour un joueur
"feuillematch" dont le maillot est manquant, un rapprochement par NOM DE
FAMILLE (normalisé, comparaison de sous-chaîne dans les deux sens — gère
`"COUIX L. Ô"` ⊇ `"COUIX"`) avec une ligne "resume" de la même équipe pas
encore réclamée — mais SEULEMENT si ce rapprochement est SANS AMBIGUÏTÉ
(exactement un candidat) ; avec zéro ou plusieurs candidats, on ne devine
jamais, on retombe sur la synthèse d'un doublon (préférable à un mauvais
rapprochement). Quand le rapprochement réussit, SEULS le maillot et le
statut titulaire (que "feuillematch" n'avait pas) viennent de "resume" —
nom, prénom, licence et capitanat restent ceux de "feuillematch", jamais
écrasés (même principe que le rapprochement par maillot exact).

**Trente-quatrième déclenchement — demande du club (« associer chaque
joueur à sa licence ») : `feuillematch-layout.ts` n'avait JAMAIS été
recalibré avec la même rigueur que `resume-layout.ts` (Trente-et-unième
déclenchement) alors que c'est l'UNIQUE source des numéros de licence.**
Le club a fourni le vrai document "feuillematch" de la rencontre n°1481
ainsi que la liste complète des 15 joueuses des deux équipes avec leurs
numéros de licence réels — première vérité de terrain disponible pour ce
document précis (jusqu'ici jamais testé contre un exemplaire réel, voir
la limite documentée au Trente-deuxième déclenchement).

Root-cause, deux bugs de calibration indépendants, confirmés par lecture
OCR isolée de cellules contre le document réel puis comparés à la liste
fournie par le club :

1. **Colonnes LICENCE/Nom de l'équipe VISITEURS tronquaient
   systématiquement le préfixe à deux lettres du numéro de licence**
   (ex. `00970` lu au lieu de `VT000970`, `DEI` au lieu de `DENIS`).
   Contrairement au document "résumé" (mêmes colonnes pour les deux
   équipes), les deux encadrés "Équipe A"/"Équipe B" de "feuillematch"
   sont dessinés INDÉPENDAMMENT dans le gabarit FFBB — une détection de
   grille RE-FAITE séparément sur la zone Y de l'équipe B a trouvé des
   bornes X réellement différentes de celles de l'équipe A
   (`[40,114,185,460,...]` contre `[40,210,277,539,...]`). Le code
   réutilisait telles quelles les bornes de l'équipe A pour l'équipe B,
   jamais mesurées séparément.
2. **Confusion OCR "O"/"0" BIDIRECTIONNELLE à l'intérieur d'un même
   numéro de licence isolé** (2 lettres + 6 chiffres) : certaines
   licences avaient un vrai "0" lu comme "O" (`VT010167` → `VTO10167`),
   d'autres un vrai "O" lu comme "0" (`OH954244` → `0H954244`). Une
   substitution aveugle dans un seul sens (comme celle déjà en place pour
   `extractSingleInteger`, réservée aux cellules numériques pures) aurait
   nécessairement cassé l'un des deux cas.
3. **Repli** : en creusant pourquoi 0 entraîneur n'était initialement lu
   côté équipe LOCAUX (qui en a pourtant deux, principal + adjoint), la
   position des lignes s'est révélée correcte (coordonnées Y calculées à
   partir du même `rowHeight` extrapolé tombant quasi exactement sur les
   lignes de grille détectées, `y≈1560`/`1619`) — le problème était en X,
   pas en Y : sur une ligne entraîneur, la colonne
   "type/surclassement" adjacente à la licence (qui contient un vrai
   marqueur sur une ligne joueuse, ex. `1C`/`2C`/`N`) est vide et non
   délimitée visuellement, donc le texte de la licence y démarre PLUS À
   GAUCHE que sur une ligne joueuse — la borne étroite habituelle
   tronquait alors systématiquement les deux premiers caractères
   (préfixe lettre) de la licence de l'entraîneur.

En creusant ce dernier point, deux bugs préexistants (non introduits ce
déclenchement-ci) ont aussi été découverts dans `parse-feuillematch.ts` :
un `break` immédiat sur la PREMIÈRE ligne "entraineur" trouvée (donc
l'entraîneur adjoint, sur la ligne suivante, n'était jamais atteint pour
une équipe qui en a deux), et un `role` toujours codé en dur à
`"principal"` sans jamais lire le mot "adjoint" présent dans la cellule.

**Corrigé** :
- `feuillematch-layout.ts` : `ROSTER_COLUMNS_TEAM_A`/`ROSTER_COLUMNS_TEAM_B`
  désormais entièrement séparées (plus jamais un seul jeu de colonnes
  partagé), mesurées pixel par pixel contre le document réel et vérifiées
  par superposition visuelle + OCR isolé. Nouvelle zone de repli
  `licenseNumberWideZone` (bornes X élargies absorbant la colonne
  "type/surclassement"), utilisée UNIQUEMENT quand la cellule contient le
  mot "entraineur" — testé explicitement que l'élargir pour une ligne
  joueuse contamine la lecture (le marqueur de la colonne voisine
  s'invite dans le texte), donc jamais utilisée hors de ce cas précis.
- `text-fields.ts` : nouvelle fonction `extractIsolatedLicenseNumber`,
  correction "O"/"0" PAR POSITION (index 0-1 : lettre, un "0" lu devient
  "O" ; index 2-7 : chiffre, un "O" lu devient "0") plutôt qu'une
  substitution aveugle — exige exactement 8 caractères après suppression
  des espaces (jamais de tolérance sur la longueur, un décalage d'un
  caractère décalerait la correspondance position→rôle de façon
  indétectable). Validé sur les 15 licences réelles fournies par le club :
  15/15 correctes avec cette correction positionnelle, contre 6/15 sans
  elle.
- `parse-feuillematch.ts` : `readTeamRosterAndCoach` renommée
  `readTeamRosterAndCoaches`, ne fait plus jamais `break` sur la première
  ligne entraîneur — collecte tous les entraîneurs trouvés dans un
  tableau, `role` désormais détecté depuis le texte de la cellule
  (`principal`/`adjoint`) au lieu d'être toujours `"principal"`. Nouvelle
  fonction `stripCoachRolePrefix` : le préfixe "Entraineur Principal :"
  n'était auparavant jamais retiré avant de découper le nom, donc
  `lastName` incluait cette phrase.
- Nouveau test contre le document réel
  (`parser/parse-feuillematch.test.ts`, fixture
  `__fixtures__/feuillematch-1481.pdf`, fournie directement par le club) :
  les 15 joueuses (numéro de maillot, numéro de licence exact,
  capitanat), et les 3 entraîneurs (2 côté LOCAUX avec leurs rôles
  respectifs, 1 côté VISITEURS) avec leur numéro de licence — comparés
  ligne à ligne à la liste fournie par le club.

Limite restante, honnêtement documentée : le nom complet d'un des trois
entraîneurs reste partiellement tronqué par l'OCR (le prénom abrégé,
jamais le numéro de licence — la clé de liaison réelle — qui est exact) ;
accepté comme limitation mineure faute d'une seconde occurrence dans
l'échantillon justifiant une heuristique dédiée, cohérent avec le
principe `null`/valeur honnête plutôt que devinée déjà en place ailleurs
dans ce module.

Cette calibration débloque directement la demande du club : relier
chaque joueur/joueuse à son numéro de licence FFBB pour, à terme, une
fiche joueur listant tous ses matchs et ses statistiques par match — non
implémentée à ce stade, la présente calibration en est le prérequis.
Portée explicitement limitée, sur demande du club, aux licencié(e)s du
club exploitant le compte FBI (SC Sète) : le club adverse d'une rencontre
devra disposer de son propre compte pour accéder à ses propres
statistiques par licencié.

**Trente-cinquième déclenchement — vérification en production du correctif
précédent : le club a re-déclenché le parsing de la rencontre n°1481
depuis l'app (`POST .../fbi/parse-documents`, § "Huitième déclenchement"
plus haut) après un reset complet de l'import. Les 15 numéros de licence
et les 3 entraîneurs correspondent bien à la liste fournie par le club —
mais un DEUXIÈME bug de rapprochement, distinct de celui du Trente-
troisième déclenchement, s'est révélé sur les données réelles.**

Constaté en base (`match_participants`, rencontre n°1481) : 16 lignes côté
VISITEURS au lieu de 15 attendues. `MESTRES Julie` (maillot 11 réel,
licence `JN870663`, correctement lue par "feuillematch") apparaissait
DEUX FOIS : une fois correcte (maillot 11, licence renseignée, mais SANS
statistiques), et une fois fantôme (maillot `1`, AUCUNE licence, mais avec
ses vraies statistiques — 28 points, 2096 secondes jouées).

Root-cause : `parse-resume.ts` avait lu son maillot "1" au lieu de "11"
(confusion sur un chiffre répété — précisément la limite déjà documentée
et acceptée au Trente-et-unième déclenchement, "un nombre à deux chiffres
avec un chiffre répété est parfois lu comme un seul chiffre"). Le
rapprochement par maillot exact (passe 1 de `mergePlayersWithStats`)
échouait donc pour les deux : aucune ligne "resume" n'a le maillot "11".
Le rapprochement par nom de famille (passe 2, corrigé au Trente-troisième
déclenchement) ne se déclenchait, lui, QUE pour un joueur "feuillematch"
dont le maillot était `null` — pas le cas ici, "feuillematch" avait bien
lu "11". La ligne "resume" au maillot erroné restait donc non réclamée,
puis synthétisée en un second participant fantôme (même mécanisme que le
Trente-deuxième déclenchement) — les vraies statistiques s'attachaient à
ce fantôme sans licence, jamais au participant licencié.

**Corrigé** (`merge.ts`) : la passe 2 (rapprochement par nom de famille)
s'applique désormais à TOUT joueur "feuillematch" non rapproché par la
passe 1 — maillot lu ou non — au lieu de se limiter aux maillots `null`.
Un maillot déjà lu par "feuillematch" n'est en revanche JAMAIS remplacé
par celui de "resume" (moins fiable, voir ci-dessus) : seul un maillot
`null` continue d'être comblé depuis "resume", exactement comme avant.
`playerStats` (jusqu'ici dérivé naïvement des lignes "resume" brutes,
donc encore indexé sous le maillot erroné après rapprochement) est
maintenant réindexé sous l'IDENTITÉ FINALE du joueur — sans ce
changement, `persist-emarque-match.ts#insertPlayerStats` n'aurait plus
retrouvé de participant au maillot "1" (qui n'existe plus) et aurait
ignoré la statistique en silence, réintroduisant sous une autre forme
exactement le bug du Trente-deuxième déclenchement.

**Deuxième correctif, demande explicite du club dans la foulée
("j'aimerais mettre nom + prénom et pas juste nom + 1ère lettre du
prénom dans les stats") :** le prénom affiché venait toujours de
"feuillematch", qui n'imprime QUE l'initiale ("NOM P.", convention du
document lui-même — voir `splitUppercaseAbbreviatedName`), jamais du
"résumé" qui imprime le prénom complet ("NOM, Prénom" — voir
`splitCommaSeparatedName`, confirmé sur l'échantillon réel dès le
Trente-et-unième déclenchement : "Clemence", "Aurore"...). Corrigé :
`mergePlayersWithStats` ramène désormais le prénom complet de "resume"
par-dessus celui, abrégé, de "feuillematch" dans les deux passes de
rapprochement (exact et par nom de famille) — jamais le reste de
l'identité (nom de famille, licence, capitanat), qui reste toujours celui
de "feuillematch", en vue de la fiche joueur à venir.

Deux nouveaux tests dans `merge.test.ts` : régression exacte du cas
MESTRES (maillot lu des deux côtés mais en désaccord → un seul
participant, licence conservée, statistiques réindexées sous le bon
maillot), et vérification que le prénom complet remplace bien l'abrégé
sans toucher au reste de l'identité. Suite complète (37 fichiers, 322
tests) toujours verte après ce correctif.

**Trente-sixième déclenchement — vérification en production du correctif
précédent : plus de doublon MESTRES, prénoms complets affichés. Le club
signale immédiatement après un TROISIÈME cas du même bug racine
("2int c'est 11 pas 1") : `twoPointsInteriorMade` de MESTRES (maillot 11)
affichait `1` au lieu de `11`.** Vérifié par l'arithmétique du score :
28 points = 11×2 (2int) + 6 (LF), avec 2ext=0 — cohérent UNIQUEMENT avec
2int=11, jamais 2int=1 (1×2+6=8 ≠ 28).

Root-cause identique aux Trente-et-unième/Trente-cinquième déclenchements
(fusion d'un chiffre RÉPÉTÉ IDENTIQUE en un seul glyphe par l'OCR), mais
cette fois dans une cellule de STATISTIQUE, pas un numéro de maillot — le
repli existant (`PdfRasterOcrExtractor.extractZone`) ne se déclenchait
QUE quand la première passe ne trouvait AUCUN chiffre ; ici un chiffre
FUT trouvé ("1", juste le mauvais), donc le repli ne s'exécutait jamais.
C'était précisément la limite déjà documentée au Trente-et-unième
déclenchement et jusqu'ici acceptée plutôt que corrigée ("accepté comme
limitation mineure faute d'une seconde occurrence justifiant une
heuristique dédiée") — la DEUXIÈME occurrence réelle (Trente-cinquième,
sur un maillot) puis cette TROISIÈME (sur une statistique, donc une
VALEUR AFFICHÉE fausse, pas seulement une donnée manquante) ont fait
franchir ce seuil.

**Corrigé** (`pdf-raster-ocr-extractor.ts`) : le repli se déclenche
désormais aussi quand la première passe trouve EXACTEMENT UN chiffre
(pas zéro, pas plusieurs) — mais son résultat n'est accepté QUE s'il
révèle EXACTEMENT ce même chiffre RÉPÉTÉ ("11", "111"... jamais un
chiffre différent) : le repli (alphabet restreint + agrandissement 2×)
reste par ailleurs moins fiable qu'une lecture normale sur un chiffre
isolé (mesuré au Trente-et-unième déclenchement, dégrade la lecture d'un
"1" réellement isolé) — on ne le laisse jamais remplacer une lecture par
autre chose qu'une correction de CE bug précis, jamais une supposition
plus large. Validé contre le document réel : `shotsMade` de MESTRES
passe aussi de (implicitement) une valeur suspecte à `11`, cohérent avec
`twoPointsInteriorMade: 11` (aucun tir à 3 points ni extérieur pour elle
sur cette rencontre). Nouvelle assertion dans `parse-resume.test.ts`
(ligne MESTRES, vérifiée par l'arithmétique du score). Suite complète
(37 fichiers, 322 tests) toujours verte, aucune régression sur les
lignes déjà validées exactement (GEORGES, DA CUNHA, OLIVIERI, COUIX,
N DIOGOYE).

## Dérogations / licenciés FBI

Non développé (§60/§40/§41 de la demande — pas de module tables de marque
ni de dérogations à ce stade). Un export XLSX des dérogations et des
routes AJAX de consultation (ex. `afficherLicenceStatistiqueAjax.fbi`,
classée READ_ONLY par `action-classification.ts`) ont été rapportés lors
d'un spike antérieur côté ball-manager-web (`docs/FBI_AUTHENTICATED_SPIKE.md`, jamais
confirmé indépendamment). Point d'extension prévu mais non implémenté :
une méthode `listDerogations()` sur l'interface `FbiAutomationClient`.

## Rapprochement calendrier FFBB/FBI

Demande explicite du club (2026-09-25), en réaction à une question sur le
remplacement du calendrier FFBB par FBI : **"il faut pas remplacer ffbb par
fbi, car certains clubs seront que en sync ffbb et d'autres ffbb + fbi. FBI
est l'info réelle. si ya une info sur fbi pour la même rencontre différente
de ffbb, c'est une anomalie. si un match est sur fbi, et pas sur ffbb, c'est
à alerter aussi."**

FFBB reste donc la SEULE source du calendrier écrite dans `matches`, pour
TOUS les clubs (`syncFfbb`, inchangé). FBI, quand un club l'a configuré, sert
UNIQUEMENT à détecter des anomalies sur ce calendrier — jamais à le
remplacer ni à y écrire quoi que ce soit. Un club FFBB-only continue de
fonctionner exactement comme avant, zéro dépendance à FBI.

**Page FBI utilisée** : `rechercherRencontreSaisieResultat.fbi` — la MÊME
page déjà utilisée pour la découverte de documents e-Marque (voir
`selectors.ts#resultsTableColumns`, confirmée par capture d'écran le
2026-09-24). Le club a fourni le 2026-09-25 une nouvelle capture montrant
son usage en LISTING complet (recherche à numéro vide) : colonnes
`Division | N° | Equipe 1 | Equipe 2 | Date de rencontre | Heure | Salle |
EM | Score 1 | Forfait 1`, pagination "Précédent 1 2 3 4 5 6 Suivant"
(confirmée gérant plusieurs pages, jamais supposée à une seule).

**Clé de rapprochement** : `competitions.code` + `matches.numero` =
exactement les colonnes "Division"/"N°" de FBI — déjà présentes dans le
schéma existant, aucune nouvelle donnée à synchroniser côté FFBB pour
permettre le rapprochement.

**Architecture** :
- `FbiAutomationClient.fetchScheduleRows(session)` (nouvelle méthode,
  `types.ts`) : récupère TOUTES les rencontres du club, toutes divisions
  confondues. `HttpFbiClient` échoue explicitement
  (`SCHEDULE_SEARCH_ENDPOINT_NOT_CONFIRMED`, même discipline que
  `EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED` — jamais une route HTTP
  devinée) ; `BrowserFbiClient.fetchScheduleRows` est l'implémentation
  fonctionnelle : navigue vers l'écran de recherche, DEUX passes (case "non
  joué" cochée puis décochée — elle filtre à un SEUL état à la fois, voir
  `selectors.nonJoueCheckbox` ; sans les deux passes, la moitié du
  calendrier du club serait invisible), recherche à numéro VIDE (renvoie
  tout le club), parcourt toutes les pages via le contrôle "Suivant"
  (`selectors.nextPageControl`, s'arrête dès qu'un clic ne change plus le
  contenu — jamais un nombre de pages supposé).
- `selectors.resultsTableGenericRows(page)` : lecture GÉNÉRIQUE du tableau
  de résultats (une ligne = un dictionnaire "libellé d'en-tête" → "texte de
  cellule"), jamais une position de colonne câblée — survit à un
  réordonnancement/ajout de colonne FBI.
- `schedule-row.ts#normalizeScheduleRow` : convertit ce dictionnaire en
  `FbiScheduleRow` typé (fonction PURE, testée sans Playwright).
- `schedule-reconciliation.ts#reconcileFbiSchedule` : fonction PURE (aucune
  IO) qui compare le listing FBI aux rencontres FFBB déjà synchronisées et
  produit les anomalies. Portée v1 volontairement limitée à ce qui est
  FIABLE sans avoir observé le format réel d'un match déjà joué sur FBI (les
  captures fournies ne montrent que des rencontres À VENIR) :
  - **présence** (`missing_in_ffbb`/`missing_in_fbi`) — la demande explicite
    du club, jamais ambiguë ; une rencontre "Exempt" (bye) n'est jamais une
    anomalie ; une rencontre `cancelled` côté FFBB absente de FBI non plus.
  - **date/heure** (`mismatch`) — précisément la valeur citée par le club
    ("les modifs en avance") : FBI reflète un changement de planning AVANT
    que la resynchro FFBB périodique ne le rattrape.
  - Score/forfait/salle **PAS COMPARÉS** pour l'instant : le format réel
    d'un "Score 1"/"Forfait 1" FBI sur un match joué n'a jamais été observé,
    et "Forfait 1" est une case à cocher (jamais un texte — l'extracteur
    générique ne lit que du texte de cellule, donc toujours vide pour cette
    colonne). Prochaine étape si le club le souhaite : étendre l'extracteur
    pour lire l'état `checked` d'une case, puis confirmer le format d'un
    score réel contre un vrai match joué.
- `fbi_schedule_discrepancies` (nouvelle table, migration
  `20260925120000_fbi_schedule_reconciliation.sql`) : journal d'anomalies
  OUVERTES/résolues — jamais une écriture sur `matches`. Une anomalie
  précédemment ouverte que le rapprochement suivant ne revoit plus est
  résolue automatiquement (`resolved_at`), sans action manuelle.
- `process-reconcile-schedule.ts` (nouveau type de job `reconcile_schedule`,
  file `fbi_jobs` existante — un seul par club à la fois, contrainte
  `fbi_jobs_unique_pending_reconcile_schedule`) : login FBI, scrape,
  rapprochement, écriture des anomalies. Déclenché à la demande pour
  l'instant (`POST /v1/clubs/:clubId/integrations/fbi/reconcile-schedule`,
  club_admin, empile le job — consommé par le bouton "Traiter les jobs FBI
  en attente" existant ou le cron quotidien), PAS encore planifié
  automatiquement (voir "Ce qui n'est pas fait" ci-dessous).
- `modules/issues/routes.ts` : `GET /v1/clubs/:clubId/issues` surface
  désormais aussi les anomalies `fbi_schedule_discrepancies` ouvertes, à
  côté des anomalies e-Marque existantes (`IssueDto.integration` étendu à
  `"fbi_schedule"`, `matchId` devenu nullable pour `missing_in_ffbb`) —
  même page /admin/issues côté ball-manager-web, aucune nouvelle UI dédiée nécessaire.

**CONFIRMÉ en production le 2026-09-25** : le club a lancé le bouton
"Vérifier le calendrier" contre son vrai compte FBI (club SC Sète Basket) —
le scraper (deux passes, pagination) a bien fonctionné, et le rapprochement
a produit des anomalies réelles cohérentes avec son calendrier FFBB
(écarts de date/heure sur des rencontres de septembre/octobre 2026,
rencontres FFBB introuvables dans le listing FBI). Statut de
`BrowserFbiClient.fetchScheduleRows` donc mis à jour : CONFIRMÉ, pas
seulement PREPARED — contrairement au reste de `BrowserFbiClient`
(login, découverte de documents e-Marque), qui reste PREPARED (jamais
exécuté contre le vrai FBI depuis CET environnement, réseau `*.ffbb.com`
bloqué, mais confirmé indépendamment par le club pour `fetchScheduleRows`).

**Ce qui n'est PAS fait** :
- Comparaison score/forfait/salle (voir ci-dessus).
- Planification automatique (cron quotidien/hebdomadaire) — pour l'instant
  déclenché uniquement à la demande via le bouton admin.
- Résolution manuelle d'une anomalie individuelle côté API (`POST
  .../issues/:matchId/resolve` ne cible que les anomalies e-Marque) — une
  anomalie FBI se résout uniquement en corrigeant la donnée FFBB source,
  automatiquement constatée au rapprochement suivant.

## Filtre saison + détection de doubles réservations (page Anomalies)

Retour du club le 2026-09-25, après le premier test réel du rapprochement
calendrier ci-dessus, sur la page /admin/issues :

1. **"ceux qui sont en error on s'en fou de 2025 faut pas, ça doit
   impacter que les matchs à venir pour ensuite agir dessus."** — la
   liste mélangeait des erreurs e-Marque de la saison 2024-2025 (terminée,
   plus aucune action possible) avec les nouvelles anomalies de
   rapprochement calendrier de la saison en cours. `GET
   /v1/clubs/:clubId/issues` filtre désormais TOUTES les anomalies liées à
   un match (`emarque_import_error`/`emarque_needs_review`,
   `fbi_schedule_mismatch`/`fbi_schedule_missing_in_fbi`) à `match_datetime
   >= currentSeasonStart()` (`src/season.ts`, même formule que ball-manager-web —
   1er août). `fbi_schedule_missing_in_ffbb` (pas de `matchId`, donc pas de
   date connue côté FFBB) reste toujours affichée : elle reflète l'état
   ACTUEL du scrape FBI, jamais une donnée historique.

2. **"faut voir si ya pas des matchs prévus à la même heure au même
   endroit, genre 2 équipes qui jouent le dimanche à 11h à Clavel."** —
   nouvelle détection, indépendante de FBI : `modules/issues/venue-conflicts.ts`
   (fonction PURE) compare toutes les rencontres À DOMICILE du club (celles
   qui occupent une salle DU CLUB) de la saison en cours, groupées par
   (date/heure EXACTE, salle — `venue_id` résolu par la synchro FFBB en
   priorité, sinon `venue_raw_label` normalisé). Un groupe de 2+ rencontres
   est un conflit matériel (le club ne peut pas faire jouer deux équipes en
   même temps au même endroit) : une anomalie `integration: "scheduling"`,
   `type: "venue_time_conflict"`, sévérité `error`, est émise PAR
   rencontre impliquée (chacune mentionne l'autre/les autres dans son
   message). Dérivé uniquement de `matches` (déjà synchronisé FFBB) — ne
   dépend jamais de FBI, fonctionne pour tous les clubs.

`IssueDtoSchema.integration`/`.type` étendus en conséquence
(`"scheduling"`/`"venue_time_conflict"`). Testé (`venue-conflicts.test.ts`,
`season.test.ts`, cas ajoutés à `modules/issues/routes.test.ts`).

## Gestion des dérogations (lecture seule, phase 1)

Demande du club, 2026-09-25 : **"faut qu'on gere les derog depuis
l'outil."** Le club a partagé sa conversation avec son correspondant
(Nicolas Correa), qui gère les dérogations au quotidien sur FBI
(Compétitions → Dérogations) : recherche/filtre un match, coche ce qu'il
veut modifier (salle/horaire/date/inversion), la demande part au club
adverse (accord automatique pour un changement de SALLE SEULE, sinon
acceptation du club adverse PUIS confirmation du comité pour les autres
changements).

**Décision explicite avant de construire quoi que ce soit** (voir
AskUserQuestion) : ceci implique d'ÉCRIRE sur FBI (soumettre une vraie
demande à un club adverse, difficile à annuler proprement) — risque d'une
nature différente de tout ce qui précède dans ce document, qui ne fait
QUE lire FBI. Le club a choisi explicitement de commencer par la LECTURE
SEULE (consulter l'état d'une dérogation), la création/réponse aux
demandes étant une phase future délibérément pas construite maintenant.

**URLs confirmées** par le club (copiées depuis sa barre d'adresse le
2026-09-25, jamais devinées) :
- Recherche : `https://extranet.ffbb.com/fbi/rechercherDerogation.fbi`
- Détail d'une dérogation précise : `https://extranet.ffbb.com/fbi/afficherDerogation.fbi?idDerogation=0&idRencontre=<jeton opaque>`
  — le jeton `idRencontre` est renvoyé PAR la page de résultats (visible
  au clic sur une ligne), jamais construit à partir du numéro de
  rencontre : cette page de détail n'est donc PAS scrapée en phase 1 (pas
  nécessaire — le tableau de résultats suffit, voir ci-dessous).

**"Faudra utiliser la recherche par numéro de rencontre, car on l'a déjà
et c'est bcp + simple"** (demande explicite du club) — `fetchDerogationForMatch`
recherche donc DIRECTEMENT par `matches.numero` (déjà connu via la
synchro FFBB), jamais par division/date/domicile-visiteur.

**Bug corrigé le 2026-09-25 (capture d'écran du VRAI sélecteur)** : la
première version de `navigateToDerogationSearchScreen` réinitialisait le
filtre "Etat de la dérogation" à `options.first()`/position 0, en supposant
que la première option serait un état neutre "tout afficher". Une capture
d'écran du vrai FBI a révélé la liste réelle : "A Créer | En Cours |
Acceptée par les deux associations sportives | Acceptée par l'organisme
dirigeant | Refusée | Tous les états (sauf à créer)" — la position 0 est en
réalité **"A Créer"** (état de bruit/référence, jamais une vraie demande en
cours), et l'option qui affiche réellement tout, **"Tous les états (sauf à
créer)"**, est la DERNIÈRE (déjà présélectionnée par défaut sur le vrai
site). Le code déployé avant ce correctif aurait donc silencieusement
masqué toutes les vraies demandes de dérogation en cours lors de chaque
recherche — l'inverse de l'objectif. Corrigé : la sélection se fait
désormais en parcourant tous les `<option>` et en matchant leur LIBELLÉ
visible (`/tous les états/i`), jamais par position. Le sélecteur reste
"best effort" (si l'option n'est pas trouvée, la recherche continue avec
l'état déjà en place plutôt que d'échouer).

**Architecture** :
- `navigateToDerogationSearchScreen(page)` (méthode partagée, extraite pour
  être réutilisée par `fetchDerogationForMatch` ET `fetchAllDerogations` —
  voir ci-dessous) : navigue vers `rechercherDerogation.fbi`, réinitialise
  le sélecteur "Etat de la dérogation" sur "Tous les états (sauf à créer)"
  par LIBELLÉ (voir bug corrigé ci-dessus).
- `FbiAutomationClient.fetchDerogationForMatch(session, matchNumber)`
  (`types.ts`) : appelle `navigateToDerogationSearchScreen`, remplit
  "Numéro de rencontre" (réutilise `selectors.matchNumberSearchInput`, déjà
  générique), soumet, lit le tableau de résultats (réutilise
  `selectors.resultsTableGenericRows` — MÊME structure générique que les
  deux autres pages FBI), et ne retient QUE la ligne dont le "N° Renc"
  correspond EXACTEMENT au numéro cherché. `null` quand rien n'est trouvé
  — cas normal (la grande majorité des matchs n'ont aucune dérogation),
  jamais une erreur. `HttpFbiClient` échoue explicitement
  (`DEROGATION_SEARCH_ENDPOINT_NOT_CONFIRMED`, même discipline que les
  deux autres pages FBI).
- `derogation-row.ts#normalizeDerogationRow` : colonnes confirmées par
  capture d'écran — "Date de dépôt | N° Renc | Division | Domicile |
  Visiteur | Date rencontre | Heure | Date déro | Etat de la dérogation".
  Fonction PURE, testée sans Playwright.
- `fbi_derogation_checks` (nouvelle table, migration
  `20260925130000_fbi_derogation_checks.sql`) : UNE ligne par match
  (mise à jour à chaque vérification, jamais un historique accumulé).
  Toutes les valeurs restent au format BRUT FBI (texte) — le format exact
  n'a été observé QUE sur cette capture d'écran, pas confirmé pour tous
  les états ("En cours", "Acceptée", "Refusée"...).
- `process-check-derogation.ts` (nouveau type de job `check_derogation`,
  file `fbi_jobs` existante, scopé à UN match comme `discover_emarque` —
  un seul par match à la fois, contrainte
  `fbi_jobs_unique_pending_derogation_check`) : login FBI, recherche,
  écrit/supprime la ligne `fbi_derogation_checks` correspondante.
- `GET /v1/clubs/:clubId/matches/:matchId/derogation` (tout membre du
  club) — dernier état connu, `null` si jamais vérifié ou si la dernière
  vérification n'a rien trouvé.
- `POST /v1/clubs/:clubId/matches/:matchId/derogation/check` (club_admin)
  — empile le job, consommé par le bouton "Traiter les jobs FBI en
  attente" existant ou le cron quotidien (même modèle que
  `reconcile-schedule`, jamais synchrone ici).

### Vérification globale (2026-09-25)

Demande du club juste après la phase 1 : **"je veux un bouton global qui
check toutes les demandes, pas match par match, c pas le cas ?"** —
vérifier chaque match un par un impliquerait une connexion FBI par match,
alors qu'un incident déjà documenté (`ProcessFbiJobsButton.tsx`) montre
qu'environ 190 connexions FBI rapprochées ont déjà déclenché un blocage
anti-bot. Une seule connexion pour tout le club est donc préférée dès le
départ, pas seulement une optimisation :
- `FbiAutomationClient.fetchAllDerogations(session)` (`types.ts`) : appelle
  `navigateToDerogationSearchScreen`, soumet la recherche avec le "Numéro
  de rencontre" VIDE (renvoie donc TOUTES les dérogations visibles dans
  l'état "Tous les états (sauf à créer)"), lit toutes les pages de
  résultats (réutilise `collectAllResultPages`, même pagination générique
  que les deux autres pages FBI). `HttpFbiClient` échoue explicitement
  (même discipline).
- `check_all_derogations` (nouveau type de job `fbi_jobs`, scopé au CLUB
  — `match_id` NULL, un seul par club à la fois, contrainte
  `fbi_jobs_unique_pending_all_derogations`, migration
  `20260925140000_fbi_check_all_derogations.sql`) : login FBI UNE FOIS,
  `fetchAllDerogations`, puis pour chaque dérogation trouvée fait
  correspondre son "N° Renc" à `matches.numero` du club et upsert la ligne
  `fbi_derogation_checks` (`onConflict: "club_id,match_id"`) — une
  dérogation dont le numéro ne correspond à aucun match connu du club est
  simplement comptée (`unmatched`) et ignorée, jamais une erreur (résultat
  du job : `{ derogationsFound, matched, unmatched }`).
- `POST /v1/clubs/:clubId/integrations/fbi/check-all-derogations`
  (club_admin) — empile le job, même modèle que `reconcile-schedule` (409
  `CHECK_ALL_DEROGATIONS_ALREADY_QUEUED` si une vérification est déjà en
  attente/en cours pour ce club).
- `GET /v1/clubs/:clubId/derogations` (club_admin — c'est aussi ce que la
  policy RLS `fbi_derogation_checks_select_club_admin` autorise déjà, voir
  migration `20260925130000` : un simple membre obtiendrait de toute façon
  une liste vide, autoriser la route plus largement aurait été trompeur)
  — liste TOUTES les lignes `fbi_derogation_checks` du club, enrichies du
  match FFBB correspondant (`matchId`/`opponentName`/`matchDatetime`) ;
  jamais un SELECT direct côté frontend.

Côté ball-manager-web : bouton "Vérifier toutes les dérogations" (Intégrations → FBI,
`CheckAllDerogationsButton.tsx`) et page `/admin/derogations` listant le
résultat, chaque ligne liée à son match. Carte "Dérogations" sur le
dashboard (club_admin uniquement) plutôt qu'un doublon de la carte
placeholder "Bientôt disponible" qui y restait affichée — relevé par le
club ("j'ai la dérog mais... faut vraiment toujours optimiser").

### Détail d'une dérogation (2026-09-25)

Juste après la vérification globale, demande du club : **"ici ok j'ai la
dérog mais il me faut du détail sur le motif, le pk du comment, les dates
initiales et demandées etc (comme sur fbi)"** — capture d'écran fournie de
`afficherDerogation.fbi` (sections "Demande de dérogation"/"Réponse de
l'adversaire"). Les dates/heure INITIALES sont déjà connues via le
tableau de résultats (`FbiDerogationRow.dateRencontre`/`.heure`) ; ce qui
manquait est UNIQUEMENT sur la page de détail :
- `FbiDerogationDetailFields` (`types.ts`) : `demandeur`, `motif`,
  `dateRencontreDemandee`, `heureDemandee` (section "Demande de
  dérogation"), `adversaire`, `dateReponse`, `acceptation`, `motifRefus`
  (section "Réponse de l'adversaire"). Volontairement PAS les cases à
  cocher (Modifier la date/l'horaire/la salle, Inverser la
  rencontre/les équipes) — pas demandées, et leur état coché/décoché ne se
  lit pas de façon fiable dans le texte visible de la page.
- `BrowserFbiClient.fetchDerogationDetailForRow(page, rowIndex)` (privée) :
  clique le `<tr>` de la ligne trouvée (jamais la case à cocher en
  première colonne), vérifie que l'URL obtenue contient
  `afficherDerogation.fbi`, lit `selectors.derogationDetailPageLines`
  (texte visible de la page, ligne par ligne — volontairement PAS un
  sélecteur `label → input`, la mise en page de cette page — floating
  labels + soulignement, probable Angular Material — n'a été vue qu'en
  capture d'écran, JAMAIS en HTML source), extrait via
  `derogation-detail.ts#extractDerogationDetailFields` (fonction PURE :
  libellé connu → ligne suivante = valeur, sauf si cette ligne suivante
  est ELLE-MÊME un des libellés connus, auquel cas le champ est vide —
  cas réel : "Date de réponse" suivi immédiatement de "Acceptation" tant
  que l'adversaire n'a pas répondu), puis `page.goBack()` pour revenir au
  tableau de résultats. Best effort intégral : un clic qui ne mène pas à
  `afficherDerogation.fbi`, ou une page de détail à la forme inattendue,
  renvoie `null` SANS lever d'erreur — le tableau de résultats reste la
  source de vérité minimale, jamais bloquée par le détail.
- `fetchDerogationForMatch` ET `fetchAllDerogations` appellent maintenant
  cette méthode (pour `fetchAllDerogations` : après chaque page de
  résultats, pour CHAQUE ligne, via la nouvelle
  `collectAllDerogationsWithDetail`, séparée de `collectAllResultPages`
  — utilisée aussi par le rapprochement calendrier, qui n'a pas de page de
  détail à ouvrir). Compromis assumé : nettement plus de navigations pour
  `check_all_derogations` (un clic + retour par dérogation trouvée, en
  plus du tableau) — jamais plus de connexions/logins FBI, donc pas le
  même risque anti-bot que la boucle par match déjà documentée, mais une
  session FBI plus longue.
- `fbi_derogation_checks` (migration
  `20260925150000_fbi_derogation_detail_fields.sql`) : 8 colonnes texte de
  plus (`demandeur`, `motif`, `date_rencontre_demandee`, `heure_demandee`,
  `adversaire`, `date_reponse`, `acceptation`, `motif_refus`), toujours au
  format BRUT FBI. `DerogationStatusDto`/`DerogationListItemDto` étendus
  en conséquence — visible sur `/matchs/:id` (carte Dérogation) ET
  `/admin/derogations`.

### Bug corrigé le 2026-09-25 (deuxième round — test réel en production)

Premier test en conditions réelles du bouton "Vérifier toutes les
dérogations" : la recherche/liaison au bon match fonctionnait (rencontres
réelles retrouvées, numéros/adversaires corrects), MAIS **toutes les
lignes ressortaient à l'état "A Créer"** et sans aucun détail
(motif/dates demandées vides partout) — alors que le club avait
confirmé par capture d'écran, des semaines plus tôt, que la rencontre
n°1 avait pour état réel "Acceptée par l'organisme dirigeant". Le club a
fourni le HTML SOURCE réel de `rechercherDerogation.fbi` (jamais accessible
depuis cet environnement, réseau bloqué), qui a révélé deux choses :

1. **Le `<label>` "Etat de la dérogation" est un FRÈRE du `<select>`,
   jamais son parent** : `<select
   name="rechercheDerogationForm.rechercheDerogationBean.etatDerogation">
   ...</select><label>Etat de la dérogation</label>`. Le sélecteur
   `page.locator("label", {hasText}).locator("select")` (recherche du
   `<select>` comme DESCENDANT du `<label>`) ne trouvait donc RIEN contre
   le vrai DOM (`count() === 0`) — construit et validé UNIQUEMENT contre
   une fixture synthétique qui, elle, imbriquait le `<select>` dans le
   `<label>` (jamais confirmée avant ce jour). Le bloc entier de
   réinitialisation était donc silencieusement ignoré (best effort) sur
   le vrai site. **Corrigé** : le `<select>` est maintenant trouvé par
   attribut `select[name*="etat" i]` (même principe que
   `nonJoueCheckbox`), robuste à l'emplacement du `<label>`. Les vraies
   valeurs d'option sont aussi maintenant connues (`CREER`/`EC`/`ACCEPT`/
   `ORGCREACC`/`ORGCREREF`/`TT`, jamais devinées) — le code continue de
   sélectionner par LIBELLÉ visible et de lire la valeur dynamiquement,
   jamais en codant ces chaînes en dur.
2. **La recherche est 100% AJAX, la page ne navigue JAMAIS** : le bouton
   "RECHERCHER" est `type="button"` (`onClick="rechercherDerogationAjax()"`),
   qui poste `$("#rechercherDerogation").serialize()` et injecte le
   résultat dans `#getTableauDerogation` sans changer l'URL — hypothèse
   fausse de la première version (qui supposait un formulaire GET natif,
   d'où la vérification par `page.url()` dans les tests, maintenant
   remplacée par une lecture directe de `select[name*="etat" i]
   .inputValue()`).

Cette deuxième info a révélé un troisième bug, découvert en réécrivant
la fixture pour être fidèle au vrai comportement AJAX : `page.goBack()`
(dans `fetchDerogationDetailForRow`, après avoir consulté le détail
d'une ligne) ne restaure PAS le tableau injecté par AJAX — un retour en
arrière recharge la page de recherche VIERGE, jamais son état
post-recherche. La ligne SUIVANTE d'une recherche groupée
(`check_all_derogations`) se retrouvait donc introuvable dans le DOM,
son détail ressortant toujours `null` silencieusement (constaté en test,
pas seulement supposé). **Corrigé** : `collectAllDerogationsWithDetail`
relance désormais une recherche complète (+ repagination jusqu'à la page
courante) via `rebuildDerogationResultsTable` après CHAQUE ligne
visitée, jamais un simple `goBack()`. Plus lent (une recherche FBI de
plus par dérogation trouvée), mais fiable quel que soit le comportement
de cache du navigateur réel — accepté comme compromis (lecture seule,
job asynchrone, pas de contrainte de temps de réponse).

### Bug corrigé le 2026-09-25 (troisième round — HTML source réel de la page de détail)

Après le round 2, un nouveau test réel a montré le filtre état enfin
fonctionnel (une rencontre est ressortie avec un état RÉEL différent de
"A Créer" pour la première fois), mais deux problèmes restaient :

1. **Le motif/dates demandées restaient vides, même pour la rencontre
   dont l'état était correct.** Le club a fourni le HTML SOURCE RÉEL de
   DEUX pages de détail différentes (jamais juste une capture d'écran
   cette fois), qui a révélé que `derogationDetailPageLines`
   (précédente version) ne pouvait STRUCTURELLEMENT pas fonctionner :
   elle lisait `page.locator("body").innerText()` en supposant un layout
   "libellé au-dessus de la valeur" tiré d'une capture d'écran — mais
   `innerText()` ne contient JAMAIS la `value` d'un `<input>` ou le
   contenu d'un `<textarea>`, uniquement le texte "en dur" du DOM. Les
   vrais champs (`demandeurLibelle`, `motif`, `dateDerogation`,
   `horaireHour`, `adversaire`, `reponseAdversaireDate`, `acceptation`,
   `motifRefus`) sont des `<input disabled>`/`<textarea readonly>`, avec
   des `id` STABLES et IDENTIQUES confirmés sur les deux exemples
   fournis. **Corrigé** : `selectors.derogationDetailFields` lit
   maintenant directement `.inputValue()` de chaque champ par son `id`
   confirmé (remplace `derogation-detail.ts#extractDerogationDetailFields`,
   supprimé). Piège relevé au passage : `id="dateDerogation"` existe en
   DOUBLE dans le vrai HTML (le `<div>` englobant ET l'`<input>` à
   l'intérieur) — `input#dateDerogation` cible spécifiquement le bon,
   jamais `#dateDerogation` seul (qui retomberait sur le `<div>`).
2. **Toutes les autres rencontres du club restaient à "A Créer", avec
   une "Dernière vérification" DATÉE D'AVANT le correctif du filtre
   état** (confirmé par les horodatages : une seule ligne à 16:06:07,
   toutes les autres à 15:42:19 — la vérification précédente, jamais
   rafraîchie). `processCheckAllDerogationsJob` n'a jamais nettoyé les
   lignes `fbi_derogation_checks` PÉRIMÉES. Un nettoyage automatique a été
   ajouté ce round, puis **retiré le jour même** après avoir causé une
   perte de données réelle — voir le round suivant.

**Limite connue, pas construite** : la page de détail a une TROISIÈME
section, "Réponse de l'organisme dirigeant" (masquée par défaut dans le
HTML fourni, `style="display:none"`), distincte de "Réponse de
l'adversaire" — pertinente pour un état comme "Acceptée par l'organisme
dirigeant" (validation du comité plutôt que réponse directe du club
adverse). Non lue pour l'instant : `adversaire`/`dateReponse`/
`acceptation` peuvent donc rester vides pour ce cas précis même une fois
le motif de la demande récupéré correctement — à construire si le club
en a besoin, sur la base des mêmes `id` stables
(`dateReponseOrganismeDirigeant`, `reponseOrganismeDirigeantValidee`,
`organismeDirigeantMotifRefus`), déjà confirmés par le même HTML source.

### Incident et revert le 2026-09-25 (quatrième round — perte de données réelle)

Le nettoyage automatique décrit au round précédent a tourné en production
et **effacé la totalité des dérogations connues du club** (0 ligne
restante, `/admin/derogations` affichant "Aucune dérogation connue" alors
que ~20 étaient connues quelques heures plus tôt). Séquence exacte :
- L'exécution avait trouvé anormalement PEU de dérogations (`derogationsFound:
  3`, contre 23 lors de l'exécution précédente) et n'en avait matché
  AUCUNE à un match courant (`matched: 0`) — cause probable : la variante
  "détail par ligne" de `fetchAllDerogations` (ajoutée au round 3)
  relance une recherche FBI complète PAR DÉROGATION TROUVÉE
  (`rebuildDerogationResultsTable`) pour contourner la perte du tableau
  AJAX après un `goBack()` — un enchaînement de dizaines de
  navigations/soumissions successives, chacune un point de défaillance
  possible, sur lequel ce job ne peut PAS détecter une recherche qui
  "perd" des résultats en cours de route (aucun moyen de distinguer "il
  n'y a vraiment que 3 dérogations" de "la recherche a dégénéré").
- Le nettoyage (`matched === 0` ⇒ aucune exclusion dans le `DELETE`)
  a alors supprimé TOUTES les lignes existantes du club, y compris
  celles d'une exécution antérieure fiable (23 trouvées, 20 matchées).

**Décision** : une perte de données pour un affichage périmé est un
échange largement défavorable, quelle que soit la fréquence de
l'incident déclencheur. Revert intégral plutôt qu'un correctif plus fin
du nettoyage :
- `processCheckAllDerogationsJob` ne supprime plus AUCUNE ligne — une
  ligne "A Créer" périmée peut rester affichée quelques exécutions de
  plus, elle se corrige d'elle-même dès qu'une exécution future la
  retrouve (upsert). Jamais de suppression automatique tant qu'on ne peut
  pas garantir qu'une recherche est exhaustive.
- `fetchAllDerogations` (bulk, "Vérifier toutes les dérogations") ne
  clique plus dans le détail des lignes — retour à la lecture simple du
  tableau (`collectAllResultPages`, MÊME pagination que les deux autres
  pages FBI), aussi fiable que le tout premier round de cette
  fonctionnalité. `collectAllDerogationsWithDetail`/
  `rebuildDerogationResultsTable` supprimées.
- Le détail par ligne (motif/dates demandées/réponse) reste disponible
  UNIQUEMENT via `fetchDerogationForMatch` (bouton "Vérifier sur FBI",
  un seul match à la fois, un seul aller-retour détail — jamais
  d'enchaînement de recherches répétées, le scénario qui a dégradé le
  bulk). Le club peut ouvrir le détail d'une dérogation précise depuis sa
  fiche match ; la liste globale reste volontairement un simple résumé
  (état/dates initiales), fiable et complet.

Après ce revert, relancer "Vérifier toutes les dérogations" doit
retrouver les ~20 dérogations matchées comme lors de l'exécution
15:40-15:42 (avant l'incident) — la liste vide constatée n'est pas
récupérable autrement qu'en relançant une vérification.

**Ce qui n'est PAS fait (volontairement)** :
- **Toute écriture sur FBI** : créer une dérogation, cocher
  salle/horaire/date/inversion, soumettre une demande, répondre à une
  demande reçue. C'est la phase 2, plus risquée (envoie une vraie demande
  à un club adverse, difficile à annuler proprement) — à cadrer
  explicitement avec le club avant toute construction, une fois la phase 1
  validée en conditions réelles.
- Les 5 cases à cocher de "Demande de dérogation" (Modifier la
  date/l'horaire/la salle, Inverser la rencontre/les équipes) et la pièce
  jointe éventuelle (`#docDerogation`, lien de téléchargement) — pas
  demandées.
- La section "Réponse de l'organisme dirigeant" — voir ci-dessus.
- Le scraper de RECHERCHE (`rechercherDerogation.fbi`) ET la page de
  DÉTAIL (`afficherDerogation.fbi`) sont maintenant construits contre le
  HTML SOURCE réel fourni par le club (fixtures
  `__fixtures__/rechercher-derogation.html` et
  `__fixtures__/afficher-derogation.html` réécrites en conséquence). Seul
  le clic ligne→détail (navigation `onclick`) reste une HYPOTHÈSE DE TEST
  non confirmée — jamais vu le HTML réel des LIGNES du tableau de
  résultats (uniquement leur contenu texte, via capture d'écran).

### Cron quotidien — vérifications automatiques (2026-09-25)

Demande du club : **"il faut aussi intégrer toutes ces maj dans le cron
daily qui va récup les infos en automatique, sans cliquer h24 sur des
boutons manuels"** — `reconcile_schedule` et `check_all_derogations`
n'étaient déclenchés QUE par les boutons manuels de Intégrations → FBI
(`ReconcileFbiScheduleButton`/`CheckAllDerogationsButton`), jamais repris
par le cron existant.
- `enqueueFbiVerificationJobsForClub`/`...ForAllClubs`
  (`jobs/enqueue-fbi-verifications.ts`) : empile UN job `reconcile_schedule`
  ET UN job `check_all_derogations` par club FBI configuré (gate sur
  `fbi_integration_status.configured` seul, jamais `auto_import_emarque`
  — propre à l'e-Marque, sans rapport ici). Idempotent : la contrainte
  unique de `fbi_jobs` absorbe un appel répété le lendemain si la veille
  n'est pas encore traitée.
- Appelé depuis `GET /internal/cron/fbi-enqueue` (même route que
  `enqueueEmarqueDiscoveryJobsForAllClubs`, jamais une route cron séparée
  — un seul passage quotidien d'empilement pour tous les jobs FBI
  récurrents).
- **Limite connue, pas silencieusement contournée** : `GET
  /internal/cron/fbi-jobs` ne traite qu'UN SEUL job par invocation
  (`JOB_BATCH_SIZE = 1`, voir `src/api/internal/index.ts` — un job
  `discover_emarque` a déjà dépassé le budget Vercel Hobby à 3 par lot).
  `reconcile_schedule`/`check_all_derogations` entrent donc dans la MÊME
  file que `discover_emarque`/`check_derogation`, réclamée dans l'ordre
  d'ancienneté : un club avec beaucoup de jobs `discover_emarque` en
  attente peut retarder de plusieurs jours le traitement automatique de sa
  vérification calendrier/dérogations. Le bouton manuel
  (`processFbiJobs`, jusqu'à `CLUB_JOB_BATCH_SIZE` jobs DE CE CLUB en une
  requête) reste le moyen le plus rapide de forcer un traitement immédiat.
  Augmenter `JOB_BATCH_SIZE` réduirait ce délai mais réintroduirait le
  risque de timeout Vercel déjà rencontré — à décider explicitement avec
  le club, pas changé ici.

### Détail par ligne restauré dans le bulk le 2026-09-25 (cinquième round — HTML source réel d'une ligne du tableau)

Le round précédent ("Incident et revert") avait explicitement laissé
"le clic ligne→détail... une HYPOTHÈSE DE TEST non confirmée — jamais vu
le HTML réel des LIGNES du tableau de résultats". Le club a alors testé de
nouveau en production ("ca marche tjr pas les motifs etc, c ca la page
rechercher une dérogation") et fourni l'`outerHTML` RÉEL d'une ligne :

```html
<tr role="row" class="odd">
  <td class=" dt-body-center"><input type="checkbox" class="FBICheckbox rechercheCheckBox" name="rechercheCheckBox14" value="M1077LX%2B5SKhWamEPnnf%2FQ%3D%3D"></td>
  <td><div class="alignCentrer"><a href="afficherDerogation.fbi?idDerogation=M1077LX%2B5SKhWamEPnnf%2FQ%3D%3D&idDerogationPrecedente=...&idDerogationSuivante=...&idRencontre=0">08/09/2026 09:14</a></div></td>
  <!-- ... une cellule <td><div class="alignCentrer"><a href="même URL">texte</a></div></td> par colonne restante ... -->
</tr>
```

Deux faits confirmés qui invalident les deux tentatives précédentes :
1. La 1ère colonne est une checkbox (`class="FBICheckbox rechercheCheckBox"`)
   — **jamais** un lien ni une cible de clic.
2. **Chaque cellule de donnée enveloppe son texte dans un vrai
   `<a href="afficherDerogation.fbi?idDerogation=...&idRencontre=0">`** —
   un lien HTML statique et navigable, jamais un `onclick`/gestionnaire JS
   attaché en ligne (contrairement au lien EM de
   `rechercherRencontreSaisieResultat.fbi`, lui bien confirmé sans `href`,
   voir plus haut — DEUX pages FBI différentes, DEUX mécaniques
   différentes, jamais supposées identiques).

**Conséquence directe** : le détail n'a jamais eu besoin d'un clic sur la
ligne (perd le tableau AJAX au retour) ni d'une reconstruction de
recherche après chaque ligne (a fait perdre des résultats en production,
round précédent) — il suffit de LIRE le `href`, sans jamais interagir avec
la page principale :

- `derogationRowDetailHref(page, rowIndex)` : lit `href` sur
  `row.locator('a[href*="afficherDerogation"]').first()` — aucun clic,
  aucune navigation de la page courante.
- `fetchDerogationDetailByHref(page, href)` : ouvre CET `href` dans un
  **second onglet** du même `BrowserContext` (`page.context().newPage()`,
  mêmes cookies de session, aucune reconnexion), y lit le détail via
  `selectors.derogationDetailFields` (déjà correct depuis le round 3), puis
  ferme l'onglet. La page principale — son URL, son tableau DataTables, sa
  pagination — n'est JAMAIS touchée, qu'il réussisse ou échoue (best effort
  intégral, `null` sans exception).
- `collectAllDerogationsWithDetail(page)` remplace la lecture simple
  (`collectAllResultPages` + `normalizeDerogationRow` sans détail) dans
  `fetchAllDerogations` : parcourt les pages de résultats EXACTEMENT comme
  avant (même pagination "Suivant"), et enrichit chaque ligne avec son
  détail via le mécanisme ci-dessus avant de passer à la page suivante.
- `fetchDerogationDetailForRow` (utilisée par `fetchDerogationForMatch`,
  un seul match) devient un simple assemblage
  `derogationRowDetailHref` + `fetchDerogationDetailByHref` — signature
  inchangée, mais ne clique/ne navigue plus la page principale du tout,
  donc plus besoin de `page.goBack()` non plus.

**Pourquoi cette fois est structurellement différente des deux échecs
précédents** (jamais une simple 3ème tentative "on croise les doigts") :
1. Le clic+`goBack()` (round 3) perdait le tableau AJAX injecté — cause
   racine désormais évitée : on ne quitte JAMAIS la page principale.
2. La reconstruction de recherche après chaque ligne (fix raté du round 3,
   cause de l'incident du round 4) multipliait les points de défaillance
   sur des dizaines d'allers-retours réseau sur la MÊME page — cause
   racine désormais évitée : chaque détail est un aller-retour isolé sur
   un ONGLET séparé, sans jamais réémettre la recherche principale.
3. Une tentative intermédiaire (interception de route Playwright,
   `route.abort()` sur la navigation vers le détail pour l'empêcher côté
   page principale) a été testée et **immédiatement rejetée avant tout
   commit** : `route.abort()` sur une navigation de premier niveau fait
   atterrir Chromium sur `chrome-error://chromewebdata/`, cassant la page
   entière (confirmé par 4 échecs de test — jamais poussé en production).
   Le `href` était déjà connu à ce moment-là mais mal exploité (interception
   au lieu de lecture directe) — la vraie leçon de cette tentative ratée
   est que la page principale ne doit **jamais** être touchée, ce qui a
   directement guidé le choix du second onglet ci-dessus.

**Vérifié** : `rechercher-derogation.html` (fixture) réécrite pour
reproduire EXACTEMENT cette structure (checkbox en 1ère colonne, chaque
cellule de donnée dans `<div class="alignCentrer"><a href="...">`) ;
`browser-client.test.ts` vérifie désormais que `fetchAllDerogations`
ramène motif/dates demandées/demandeur pour CHAQUE ligne ET que
`session.page.url()` reste sur `rechercherDerogation.fbi` tout le
parcours (jamais quittée) — 24/24 tests passants, suite complète
(415 tests) inchangée par ailleurs. `processCheckAllDerogationsJob`
n'a nécessité AUCUN changement : il écrivait déjà les 8 colonnes de
détail sans condition, restées `null` tant que `fetchAllDerogations` ne
les remplissait pas.

### Statut "En Cours" absent des résultats le 2026-09-26 (sixième round)

Après le déploiement du cinquième round, le club relance "Vérifier toutes
les dérogations" en production : `derogationsFound: 3, matched: 0` — un
lot connu de ~20 dérogations (voir la requête SQL directe sur
`fbi_derogation_checks`, toutes avec `updated_at` figé à la veille, preuve
qu'aucune n'a été mise à jour par cette exécution) retombe à 3 trouvées,
aucune matchée. Diagnostic ajouté (`fbi_jobs.result` enrichi de
`foundDerogations`/`matchNumerosDisponibles`, consultable en base sans
dépendre des logs Vercel) pour départager deux hypothèses avant de
retenter à l'aveugle.

Le club fournit alors, sans attendre le prochain résultat du diagnostic,
DEUX preuves directes :
1. Le HTML source réel de `rechercherDerogation.fbi` montre le `<select>`
   "Etat de la dérogation" avec **"En Cours" (`EC`) sélectionné par
   défaut**, pas "Tous les états" — signe que ce champ garde en session la
   dernière valeur choisie par l'utilisateur (patron JSF classique, bean
   session-scope), pas une preuve en soi d'un bug.
2. Le HTML source réel de `afficherDerogation.fbi?idDerogation=...` pour
   la rencontre n°9820 (division PRF Poule A) montre une dérogation
   **ACTUELLEMENT "En Cours"** : `acceptation` = "NC" (non communiqué),
   AUCUNE `reponseAdversaireDate` — un dossier réellement en attente de
   réponse, déposé le 14/09/2026 (`dateDepot`), demandant à déplacer la
   rencontre du 15/11/2026 au 14/11/2026 à 21:00.
3. Message du club, sans ambiguïté : **"ya le statut en cours qui est pas
   pris en compte"**.

Or `fetchAllDerogations`/`fetchDerogationForMatch` sélectionnent TOUJOURS
"Tous les états (sauf à créer)" (`TT`) avant de chercher — jamais "En
Cours" (`EC`) spécifiquement. Que "Tous les états (sauf à créer)" exclue
RÉELLEMENT aussi "En Cours" côté FBI (comportement voulu ou bug, jamais
vérifiable depuis cet environnement, réseau `*.ffbb.com` bloqué) ou que ce
soit encore autre chose, le retour direct et non ambigu du club — la
dérogation n°9820 existe, est "En Cours", et n'apparaît pas dans nos
résultats — est une preuve suffisante pour agir SANS attendre une
confirmation supplémentaire du diagnostic.

**Fix** : `fetchAllDerogations` et `fetchDerogationForMatch` bouclent
maintenant sur `DEROGATION_ETAT_PASSES = ["tousLesEtats", "enCours"]`
(browser-client.ts) — exactement le même principe déjà établi par
`fetchScheduleRows` pour la case "non joué" (deux passes, un seul filtre à
la fois ne couvre jamais les deux sous-ensembles) :
- `navigateToDerogationSearchScreen(page, pass)` accepte désormais quel
  état sélectionner (par LIBELLÉ, jamais par valeur devinée — "Tous les
  états" ou "En Cours" selon `pass`), au lieu de toujours forcer "TT".
- `fetchAllDerogations` : boucle les deux passes, dédoublonne par numéro
  dans une `Map` (la passe "En Cours", exécutée en second, gagne en cas de
  conflit — un dossier "En Cours" retrouvé est plus à jour qu'un éventuel
  doublon "TT" pour le même numéro).
- `fetchDerogationForMatch` : boucle les deux passes, s'arrête à la
  première qui trouve CE numéro (évite une recherche "En Cours"
  systématique quand "TT" suffit déjà).

**Fixture mise à jour pour reproduire le bug, pas juste le corriger dans
le vide** : `rechercher-derogation.html` ajoute une 4ᵉ ligne ("9820", état
"En Cours") explicitement EXCLUE du filtre "TT" dans le script de la
fixture (reproduit le comportement RÉEL constaté, pas un comportement
"logique" supposé) — sans ce test, un futur refactor pourrait réintroduire
la régression sans qu'aucun test ne la détecte. 26/26 tests passants
(2 nouveaux : `fetchDerogationForMatch` retombe sur "EC" quand "TT" ne
trouve rien, `fetchAllDerogations` retrouve bien "9820"), suite complète
(417 tests) inchangée par ailleurs.

**Ce qui reste à vérifier en production** : ce fix suppose que "TT" ET
"EC" couvrent ensemble tous les états pertinents (CREER étant le seul
volontairement exclu). Si un futur retour du club montre qu'un état
`ACCEPT`/`ORGCREACC`/`ORGCREREF` manque ÉGALEMENT sous "TT" (jamais
constaté à ce jour — le lot de ~20 dérogations connu avant l'incident du
round 4 contenait déjà ces trois états), le même principe s'étendrait à
une passe par état plutôt que seulement `TT`+`EC`.

### Ligne fantôme DataTables et statut "En Cours" toujours absent (septième round, 2026-09-26)

Le club relance après déploiement du sixième round : toujours aucune
dérogation "En Cours" dans la liste. `fbi_jobs.result` (lu directement en
base, deux exécutions consécutives) révèle un fait inattendu :
`foundDerogations` contient systématiquement UNE ligne
`{"etat":null,"numero":null,"motifLu":false}` mélangée aux vraies lignes —
JAMAIS une vraie dérogation à l'état "En Cours" (0 sur les deux
exécutions).

**Cause de la ligne fantôme, identifiée sur preuve (pas devinée)** :
DataTables insère dans `<tbody>` une ligne `<tr><td colspan="N">Aucune
donnée disponible dans le tableau</td></tr>` quand une recherche/page ne
renvoie AUCUN résultat — un unique `<td>` (le `colspan`), que
`resultsTableGenericRows` (qui aligne chaque cellule à l'INDEX de sa
colonne, jamais son libellé) associe à tort à l'en-tête de la 1ère colonne
(vide, la checkbox) — ignoré (`if (!header) continue`), d'où un `record`
entièrement vide, puis un `FbiDerogationRow` avec `numero: null` que rien
ne distinguait jusqu'ici d'une vraie ligne. Cette ligne fantôme gonflait
`derogationsFound`/`unmatched` sans jamais correspondre à une vraie
dérogation.

**Fix** : `collectAllDerogationsWithDetail` (browser-client.ts) filtre
désormais explicitement toute ligne dont `numero === null` — une VRAIE
dérogation a TOUJOURS un numéro de rencontre, jamais un moyen légitime de
produire ce cas. Fixture `rechercher-derogation.html` mise à jour pour
reproduire fidèlement cette ligne DataTables (`colspan`, classe
`dataTables_empty`, texte exact) quand la recherche filtrée ne trouve
aucune ligne, plutôt qu'un `<tbody>` simplement vide — le test "renvoie
null quand aucune dérogation n'existe pour ce numéro" traverse maintenant
cette ligne fantôme sur les deux passes sans la confondre avec une vraie
dérogation.

**Diagnostic supplémentaire** : chaque dérogation trouvée porte désormais
un marqueur `raw.__etatPass` (jamais persisté, lu uniquement par
`processCheckAllDerogationsJob` pour enrichir `foundDerogations` d'un
champ `pass`) — confirme, sur la PROCHAINE exécution après ce
déploiement, si la passe "En Cours" tourne bien et ce qu'elle trouve
RÉELLEMENT (0 lignes réelles ± la fantôme désormais filtrée, ou enfin de
vraies lignes "En Cours").

**Hypothèse "résolue entre-temps" INVALIDÉE par preuve directe** : le club
a fourni la capture COMPLÈTE et actuelle de "Rechercher une dérogation"
filtrée sur "En Cours" — **9 dérogations réellement en cours** à cet
instant (numéros 9820, 9860, 5, 9538, 13, 16, 9608, 5009, 15, toutes avec
"Affichage de 1 à 9 sur 9 entrées", une seule page). La dérogation n°9820
elle-même y figure encore "En Cours" — contredisant directement le constat
précédent (elle ressortait "Acceptée par l'organisme dirigeant" sous la
passe "TT" de nos propres exécutions). Ce n'est donc PAS un cas résolu
entre-temps : la passe "EC" de `fetchAllDerogations` ne trouve
véritablement AUCUNE de ces 9 dérogations, alors qu'elles existent
bel et bien sous ce filtre sur le vrai FBI. Un bug réel, pas une preuve
insuffisante — mais sa NATURE précise (sélection d'état qui échoue
silencieusement ? recherche soumise mais résultat vide pour une autre
raison ?) reste à confirmer sur preuve, pas à deviner un troisième
correctif à l'aveugle.

**Diagnostic ajouté (pas encore de fix comportemental)** : `BrowserFbiClient`
expose désormais `getLastDerogationPassDiagnostics()`, lu par
`processCheckAllDerogationsJob` et persisté dans `fbi_jobs.result.passDiagnostics`
— un tableau `{ pass, selectedEtatValueAtSubmit, rawRowCount, keptRowCount }`
par passe (`tousLesEtats`/`enCours`) :
- `selectedEtatValueAtSubmit` : relit la valeur RÉELLE du `<select>` juste
  avant le clic sur RECHERCHER (jamais supposée) — si elle affiche autre
  chose que `"EC"` pour la passe `enCours`, la sélection par libellé
  échoue silencieusement (bootstrap-select non synchronisé, option
  introuvable...). Si elle affiche bien `"EC"` mais `rawRowCount` reste à
  0, le problème est ailleurs (soumission, rendu du tableau, timing AJAX).
- `rawRowCount` : nombre de lignes lues AVANT le filtrage de la ligne
  fantôme DataTables (voir round précédent) — distingue "recherche vide"
  (0) de "recherche a trouvé des lignes mais toutes fantômes" (impossible
  en pratique, mais vérifiable) de "a trouvé les 9 vraies lignes"
  (`rawRowCount` ≈ 9, `keptRowCount` ≈ 9).

Prochaine étape, sur la base de CE diagnostic (relancer "Vérifier toutes
les dérogations" puis lire `fbi_jobs.result.passDiagnostics` directement
en base) : si `selectedEtatValueAtSubmit` pour `enCours` n'est PAS `"EC"`,
corriger la sélection d'état (probablement une histoire de timing avec
bootstrap-select, ou une différence entre l'option visible et l'option
native). Si c'est bien `"EC"` mais `rawRowCount: 0`, chercher côté
soumission/rendu (peut-être une case complémentaire du formulaire, comme
la case "non joué" pour l'écran de rencontres, qui filtre aussi les
dérogations sans qu'on l'ait identifiée).

### Lecture du tableau trop tôt après l'AJAX (huitième round, 2026-09-26/27)

Le diagnostic ci-dessus, lu sur l'exécution suivante, TRANCHE
définitivement : `selectedEtatValueAtSubmit` vaut bien `"EC"` pour la
passe "En Cours" — la sélection d'état N'EST PAS le problème, contrairement
à l'hypothèse précédente. Mais le résultat est pourtant pire que jamais :
```
passDiagnostics: [
  { pass: "tousLesEtats", rawRowCount: 4, keptRowCount: 1, selectedEtatValueAtSubmit: "TT" },
  { pass: "enCours",      rawRowCount: 4, keptRowCount: 0, selectedEtatValueAtSubmit: "EC" },
]
derogationsFound: 1 (numéro 2659, "Refusée")
```
Un lot connu de ~20 dérogations (passe "TT" seule) tombe à **1 seule**
trouvée — bien pire que les exécutions précédentes (20, 20, 21) — et le
job entier a pris ~38s au lieu des ~90-100s habituels (bien moins de
détails à récupérer, cohérent avec bien moins de lignes lues). `4` lignes
brutes identiques pour les DEUX passes (au lieu de ~20 pour "TT" et 9 pour
"EC", confirmées par la capture du club) est la preuve la plus parlante :
la recherche n'a manifestement pas eu le temps de charger avant d'être lue.

**Cause identifiée (raisonnement, pas une preuve réseau directe — le
réseau `*.ffbb.com` reste bloqué depuis cet environnement)** :
`rechercherDerogationAjax()` (HTML source réel, round 5) est un vrai appel
AJAX (`postAjax("rechercherDerogation.fbi?action=controleRecherche", ...,
function(xhr) { remplirDiv("getTableauDerogation", xhr); })`) —
`page.waitForLoadState("networkidle")` peut se résoudre dès que la
RÉPONSE réseau est reçue, potentiellement AVANT que le callback
`remplirDiv()` ait fini d'injecter le HTML et que DataTables ait fini de
(re)dessiner le tableau — un délai variable selon la charge du serveur
FBI à cet instant, jamais garanti par un simple délai fixe
(`navigationSettleMs`, 500ms par défaut).

**Fix** : `waitForStableDerogationTable(page)` — attend que deux lectures
successives du tableau (même principe que la détection de fin de
pagination dans `collectAllDerogationsWithDetail`) soient IDENTIQUES avant
de continuer, jusqu'à 6 tentatives espacées de `navigationSettleMs`
(jamais un délai fixe supposé suffisant). Appelée après CHAQUE soumission
de recherche de dérogation (`fetchAllDerogations` ET
`fetchDerogationForMatch`), avant toute lecture du tableau. Ne bloque
jamais indéfiniment (recherche réellement vide : épuise les tentatives
puis continue normalement, comme avant) — coût supplémentaire négligeable
en test (fixture synthétique déjà stable dès la 1ère lecture, contexte
`navigationSettleMs: 50` dans les tests), mesuré : 26/26 tests toujours
verts, aucun ralentissement notable.

**Reste à confirmer sur la prochaine exécution** : si `rawRowCount`
remonte à ~20 (TT) et ~9 (EC, conforme à la capture du club) une fois ce
correctif déployé, la cause est confirmée et le problème résolu. Si le
symptôme persiste malgré `waitForStableDerogationTable`, l'hypothèse du
timing AJAX serait insuffisante et il faudrait alors envisager qu'un
symbole d'anti-bot/rate-limit FBI dégrade la recherche après plusieurs
connexions rapprochées dans la même fenêtre de temps (déjà documenté par
ailleurs pour `discover_emarque`) — jamais deviné sans nouvelle preuve.

### Retour à une seule passe TT (neuvième round, 2026-09-27)

Le correctif ci-dessus (`waitForStableDerogationTable`) fait remonter
`rawRowCount` de 4 à 23 (TT) — une nette amélioration — mais la passe "En
Cours" reste incomplète (7 dérogations sur les 9 réellement en cours,
confirmées par une capture complète et actuelle du club). Puis le club
signale une DEUXIÈME dérogation manquante — rencontre n°16, état
"Acceptée par les deux associations sportives" (`ACCEPT`) — avec ce
message, décisif : **"si si il prend tout en compte le tous les états, c
juste que ya 5 pages à prendre en compte"**.

Ce retour CORRIGE directement l'hypothèse de tous les rounds précédents
depuis le sixième : "Tous les états" (`TT`) n'a jamais été le problème —
il couvre RÉELLEMENT tous les états (y compris "En Cours" et "Acceptée
par les deux associations sportives"). La vraie cause, de bout en bout,
était une **pagination incomplète** : le club voit 5 pages de résultats
sous "Tous les états", notre code n'en lisait qu'une fraction.

**Décision** : retour à une seule passe `TT` (`DEROGATION_ETAT_PASSES =
["tousLesEtats"]`), suppression de la sélection par état individuel
(`EC`/`ACCEPT`/`ORGCREACC`/`ORGCREREF`) introduite aux rounds 7/8 —
fondée sur une fausse piste, et inutilement coûteuse (jusqu'à 4
recherches/logins au lieu d'une). Le diagnostic par passe
(`DerogationPassDiagnostic`/`getLastDerogationPassDiagnostics()`) est
conservé (structure en tableau à un seul élément) : utile pour prouver
sur preuve un futur besoin similaire, jamais pour en deviner un.

**Deuxième correctif, dans `collectAllDerogationsWithDetail`** : la
`nextDisabledAncestor` (détection d'un "Suivant" désactivé via une classe
`disabled` sur le `<li>` parent) ajoutée juste avant ce retour en arrière
est retirée — elle reposait sur une convention DataTables **jamais
confirmée par le HTML réel de CE tableau précis** (deviné par analogie
avec la librairie générique, contraire à la discipline du projet), et
risquait justement de provoquer l'inverse du symptôme réel (arrêter la
pagination trop tôt plutôt que trop tard). La vraie cause de la
pagination incomplète est la MÊME lecture-trop-tôt déjà diagnostiquée
pour la recherche initiale : `waitForStableDerogationTable(page)` est
maintenant aussi appelée après CHAQUE clic sur "Suivant" (pas seulement
après la soumission de recherche), avant de relire le tableau pour la
page suivante — sans dépendre d'une classe CSS jamais vue en HTML réel.

**Test de régression** ajouté avec des données RÉALISTES : la fixture
`rechercher-derogation.html` force artificiellement 2 pages sous "Tous
les états" (`PAGE_SIZE = 2`, 4 rencontres non-"A Créer" désormais, dont la
n°16 ajoutée pour reproduire fidèlement le retour du club), avec une
VRAIE pagination "Suivant"/"Précédent" cliquable (jamais un `href="#"`
inerte) — le nouveau test vérifie que `fetchAllDerogations` retrouve bien
les 4 rencontres, y compris celles de la 2ᵉ page, et que
`rawRowCount === keptRowCount === 4` (aucune ligne fantôme, aucune page
perdue en route). 25/25 tests passants (FBI), suite complète (416 tests)
inchangée par ailleurs.

**Prochaine vérification en production** : si `fbi_jobs.result` montre
maintenant `derogationsFound` proche du total réel du club (le club a vu
5 pages, donc probablement ~40-50+ dérogations selon la taille de page
réelle de FBI) avec `rawRowCount === keptRowCount` pour la passe unique
`tousLesEtats`, la pagination est enfin correctement traversée. Sinon,
demander au club le nombre exact affiché ("Affichage de X à Y sur Z
entrées") pour comparer directement à `derogationsFound`, plutôt que de
deviner un dixième correctif.

### La vraie cause : `<a>` sans `href` n'a aucun rôle "link" (dixième round, 2026-09-27)

Le round précédent (`waitForStableDerogationTable` après chaque clic
"Suivant") n'a RIEN changé : `rawRowCount` reste bloqué à 23 (`TT`),
exactement comme sur TOUTES les exécutions précédentes, alors que le club
signale "il y a + de 80 dérogations" en regardant le vrai FBI. Un nombre
IDENTIQUE à chaque exécution, peu importe l'heure, élimine l'hypothèse du
timing/de la charge serveur (round précédent) : c'est un problème
STRUCTUREL — la pagination ne lit tout simplement JAMAIS une 2ᵉ page.

Le club fournit enfin l'`outerHTML` réel du bouton "Suivant" :
```html
<a class="paginate_button next" aria-controls="rechercherDerogationAjax" data-dt-idx="6" tabindex="0" id="rechercherDerogationAjax_next">Suivant</a>
```
**Aucun attribut `href`.** Règle HTML/ARIA : le rôle implicite "link" d'un
`<a>` dépend de la présence de `href` — sans lui, l'élément n'a AUCUN
rôle ARIA. `selectors.nextPageControl` cherchait `page.getByRole("link",
{ name: /^suivant$/i })` — ne pouvait donc JAMAIS matcher ce bouton précis
(`count() === 0`), sur AUCUNE des pages FBI utilisant cette même
convention DataTables (`paginate_button`), depuis le tout premier round
qui a introduit cette fonction. La pagination des dérogations s'arrêtait
donc systématiquement après la 1ère page (~20-23 lignes) — jamais un
problème de timing, jamais un problème d'état, un problème de SÉLECTEUR
pur, non détecté jusqu'ici car jamais vu le vrai HTML de ce bouton précis.

**Fix** : `nextPageControl` (selectors.ts) cherche maintenant PAR CLASSE
CSS `paginate_button` (`a.paginate_button.next, button.paginate_button.next,
[class*="paginate_button"][class*="next" i]`) EN PRIORITÉ — la convention
DataTables CONFIRMÉE par ce HTML réel, jamais une classe devinée par
analogie comme la tentative avortée du round 8 — avec un repli par rôle
ARIA + texte pour toute page FBI qui utiliserait un vrai lien accessible.

**Effet de bord potentiellement bénéfique** : `nextPageControl` est
PARTAGÉE par `collectAllResultPages` (`fetchScheduleRows`, rapprochement
calendrier FFBB/FBI, `reconcile_schedule`) — si l'écran
`rechercherRencontreSaisieResultat.fbi` utilise la MÊME convention
DataTables (probable, mêmes `<script>` `dataTableFFBBNew.min.js`/
`jquery.datatable.min.js` inclus sur les deux pages, jamais confirmé
directement pour CETTE page précise), ce correctif corrige aussi
silencieusement une pagination incomplète jamais signalée là-bas — à
surveiller sur les prochaines synchronisations calendrier plutôt qu'à
supposer réglé sans preuve.

**Fixture mise à jour pour reproduire fidèlement CE bug** :
`rechercher-derogation.html` reproduit maintenant l'outerHTML RÉEL exact
du bouton (`class="paginate_button next"`, aucun `href`) — sans cette
mise à jour, le test de pagination à 2 pages ajouté au round précédent
aurait continué à passer avec l'ANCIEN sélecteur cassé, puisque le
`href="#"` deviné à tort le faisait matcher par rôle "link" alors que le
vrai bouton ne l'est jamais. 25/25 tests passants, suite complète
(416 tests) inchangée par ailleurs.

### Timeout Vercel — retour à zéro détail dans le bulk (onzième round, 2026-09-27)

`nextPageControl` corrigé, `check_all_derogations` timeout désormais :
`Vercel Runtime Timeout Error: Task timed out after 300 seconds`. Cause
évidente une fois la pagination RÉELLEMENT fonctionnelle : le club voit
80+ dérogations sur 5 pages — `fetchAllDerogations` ouvrait jusqu'ici un
SECOND ONGLET par ligne pour son détail (`fetchDerogationDetailForRow`,
round 5) ; 80+ allers-retours séquentiels (nouvel onglet, navigation,
lecture, fermeture) dépassent largement les 300s d'une Vercel Function,
là où l'ancienne pagination cassée (~20-23 lignes) restait juste dans les
temps par accident.

Le club le dit directement : **"Fais le de la meme facon quon a vérifié
tous les matchs prévus fbi pour comparer a ffbb, ca doit pas bloquer"** —
`fetchScheduleRows` (rapprochement calendrier FFBB/FBI,
`reconcile_schedule`) ne fait QUE lire le tableau (`collectAllResultPages`,
pagination seule, JAMAIS de nouvel onglet) et n'a jamais eu ce problème,
même sur un calendrier de plusieurs centaines de rencontres.

**Fix** : `fetchAllDerogations` abandonne le détail par ligne, DEUXIÈME
fois après le round 4 — mais cette fois pour une raison de VOLUME
(timeout), pas de perte de données. Utilise désormais
`collectAllResultPages` (générique, déjà partagé avec `fetchScheduleRows`)
au lieu de `collectAllDerogationsWithDetail` (méthode retirée
intégralement — plus aucun appelant). Le filtre de la ligne fantôme
DataTables (numéro `null`) est appliqué directement dans
`fetchAllDerogations` après normalisation. Le détail par ligne
(motif/dates demandées/réponse adversaire) reste disponible UNIQUEMENT
via `fetchDerogationForMatch` (bouton "Vérifier sur FBI", UN SEUL match à
la fois — jamais un problème de volume, `fetchDerogationDetailForRow`/
`derogationRowDetailHref`/`fetchDerogationDetailByHref` restent
utilisées par cette seule méthode). Copie ball-manager-web (page Dérogations, page
Intégrations FBI) à revérifier : elle affirmait à tort depuis le
neuvième round que le bulk ramène aussi le détail.

**Test mis à jour** : la fixture force toujours 2 pages (80+ dérogations
réelles ne sont pas nécessaires en test, la mécanique de pagination est
déjà couverte) — le test vérifie maintenant que `motif`/
`dateRencontreDemandee` restent `null` pour toutes les lignes du bulk, et
qu'AUCUN second onglet n'est ouvert (`session.context.pages()` reste à 1
tout le parcours). 25/25 tests FBI passants, suite complète (416 tests)
inchangée par ailleurs.

### Toujours incomplet (40/82) + doublons — diagnostic de pages ajouté (douzième round, 2026-09-27)

Après déblocage du job resté coincé en "claimed" (timeout Vercel du round
précédent, nettoyé manuellement en base), la première exécution avec le
détail retiré du bulk tourne enfin vite (24s) et progresse nettement :
`rawRowCount` passe de 23 à 46 (`keptRowCount: 40`). Mieux, mais le club
signale toujours deux manques concrets ("Acceptée par les deux
associations sportives", rencontres n°16 et n°9) et rappelle le total
attendu : **82 entrées, "on en est loin"**.

Fait notable dans `foundNumeros` de cette exécution : plusieurs numéros
apparaissent DEUX FOIS (`9544`, `9578`, `9589`, `9820`, `9830`, `9860`) —
alors qu'une dérogation n'a qu'un seul numéro de rencontre. Signe qu'au
moins une page a été comptée deux fois dans `collectAllResultPages`,
probablement parce que deux lectures de LA MÊME page produisent des
signatures `JSON.stringify` différentes (un détail non identifié rend
chaque lecture légèrement différente) — la boucle continue alors à tort
au lieu de s'arrêter, ET compte une page déjà vue comme "nouvelle".

**Pas de nouveau correctif à l'aveugle cette fois** : deux diagnostics
ajoutés pour objectiver ce qui se passe RÉELLEMENT à la prochaine
exécution, avant de deviner une treizième fois :
- `collectAllResultPages` renvoie maintenant aussi `pageCount` (nombre de
  fois où la boucle a lu une page AVANT de s'arrêter) — persisté dans
  `passDiagnostics[0].pageCount`. Si `pageCount` reste bloqué à 2-3 alors
  que le club voit 5 pages, la pagination s'arrête encore trop tôt malgré
  `nextPageControl`/`waitForStableDerogationTable`. Si `pageCount` monte
  à 5+ mais `keptRowCount` reste sous 82, le problème serait alors des
  pages relues (cohérent avec les doublons observés).
- `fetchAllDerogations` dédoublonne désormais explicitement par numéro
  (`Map` par numéro avant de renvoyer) — une VRAIE dérogation n'a qu'un
  numéro, jamais deux lignes pour la même rencontre. Ne résout pas la
  cause racine (pourquoi une page est relue), mais élimine son symptôme
  le plus visible côté ball-manager-web (des doublons dans `/admin/derogations`).

**Ce qui reste à vérifier sur la PROCHAINE exécution** (lire
`fbi_jobs.result.passDiagnostics[0]` directement en base) : `pageCount`
et `rawRowCount`/`keptRowCount` diront si le problème est "pagination
encore trop courte" (pageCount bas) ou "pages relues sans avancer"
(pageCount élevé mais count final toujours sous 82) — deux causes
différentes, deux corrections différentes, aucune à deviner avant d'avoir
ce chiffre.

### Pagination "Suivant" instable côté serveur — maximiser la longueur de page (treizième round, 2026-09-27)

Le diagnostic du round précédent a payé : `passDiagnostics[0]` en
production donne `{ pageCount: 5, rawRowCount: 97, keptRowCount: 51 }`.
`pageCount: 5` confirme que la pagination avance RÉELLEMENT sur 5 pages
distinctes (jamais la même page relue en boucle, hypothèse éliminée) —
mais `rawRowCount: 97` pour seulement `keptRowCount: 51` après
déduplication par numéro signifie que ~46 lignes sont des DOUBLONS de
lignes déjà vues sur une page précédente. Signe classique d'une
pagination "offset" côté serveur dont le tri n'est pas parfaitement
déterministe : entre deux clics "Suivant", le jeu de résultats se
retrie/se refenêtre légèrement, faisant réapparaître certaines lignes
(déjà vues) et probablement en sautant d'autres (jamais vues du tout) —
cohérent avec le club qui reste bloqué à 51/82 malgré 5 pages
parcourues.

**Fix** : plutôt que de continuer à corriger le mécanisme "Suivant" lui-
même (déjà deux rounds dessus), contourner entièrement la pagination —
DataTables expose un contrôle "Afficher X entrées" (`<select
id="<idTable>_length">`, convention CODÉE EN DUR dans la librairie,
jamais personnalisée par FBI, même principe que `<idTable>_next` du
dixième round) avec une option `-1` ("Tous") qui affiche TOUT en une
seule page — plus de découpage serveur en pages, donc plus d'instabilité
possible. `selectors.resultsLengthSelect` (`select[name$="_length"
i], select[id$="_length" i]`) + `BrowserFbiClient.tryMaximizeResultsPageLength`
(nouveau, best effort) choisissent la plus grande valeur disponible
(`-1` en priorité, sinon la plus grande valeur numérique) et
sélectionnent cette option AVANT de commencer la lecture — la pagination
"Suivant" de `collectAllResultPages` ne sert plus que de repli si ce
contrôle est absent/inefficace sur une page FBI qui ne l'aurait pas.

**Bug découvert en écrivant le test** (30s de timeout sur les 3 tests
`fetchAllDerogations`, jamais en production — seulement en test avant ce
commit) : une fois "Tous" sélectionné, DataTables MASQUE ses contrôles
de pagination (`.dataTables_paginate { display: none }`, reproduit dans
la fixture) — mais les `<a>` "Précédent"/"Suivant" restent PRÉSENTS dans
le DOM (juste invisibles), donc `nextPageControl(page).count()` ET
`isEnabled()` restent vrais. `collectAllResultPages` tentait alors de
CLIQUER sur ce bouton invisible — l'actionabilité Playwright (visible ET
stable ET activé) n'est jamais remplie pour un élément cliqué mais
masqué, bloquant chaque test pendant les 30000ms du timeout
d'actionabilité par défaut. Fix : vérifier explicitement `isVisible()`
avant `isEnabled()`/le clic, jamais juste présence + activé — la même
règle vaudra pour tout futur contrôle DataTables masqué plutôt que
supprimé du DOM.

### Le détail redevient nécessaire — cinquième revirement (quatorzième round, 2026-09-27)

Constat club immédiat une fois le round précédent en production : **"gros
probleme, on récupère plus le demandeur le motif, lheure la date etc"**.
Vérification directe en base (`fbi_derogation_checks`, lecture seule) :
`date_rencontre`/`heure` (colonnes du TABLEAU de résultats, jamais retirées)
étaient bien renseignées — mais `demandeur`/`motif`/
`date_rencontre_demandee`/`heure_demandee`/`adversaire`/`date_reponse`/
`acceptation`/`motif_refus` (colonnes de DÉTAIL, une page par ligne)
étaient TOUTES `null` pour les 51 lignes connues, sans exception. Cause
directe : le onzième round (timeout Vercel) avait retiré tout détail par
ligne du bulk, remplacé `fetchAllDerogations` par la même mécanique
"liste seule" que `fetchScheduleRows` — un compromis délibéré à l'époque
("`ca doit pas bloquer`"), mais qui casse l'affichage de
`DerogationsList.tsx` (ball-manager-web) pour CHAQUE dérogation, jamais seulement au
clic "Vérifier sur FBI" d'un match précis. Un échange non voulu par le
club : le compromis n'était acceptable QUE tant qu'il restait implicite,
jamais annoncé comme "plus de détail du tout" à l'utilisateur final.

**Pourquoi le détail redevient praticable maintenant** : le onzième round
avait retiré le détail par ligne à cause du VOLUME (80+ nouveaux onglets
séquentiels) — mais le treizième round (ci-dessus) élimine l'essentiel du
temps qui restait après ça, en ramenant la recherche à UNE SEULE page
(`tryMaximizeResultsPageLength`) plutôt que 5 pages avec un clic
"Suivant" à plusieurs secondes chacun. Le budget de temps restant pour le
détail par ligne est donc bien plus large qu'au onzième round.

**Fix** : `collectAllDerogationPages` (nouvelle méthode, remplace l'usage
de `collectAllResultPages` dans `fetchAllDerogations` — `fetchScheduleRows`
garde `collectAllResultPages`, INCHANGÉ, jamais concerné par le détail)
reprend la mécanique de pagination du treizième round, mais enrichit
CHAQUE ligne de son détail (`fetchDerogationDetailForRow`, même
mécanisme qu'utilise déjà `fetchDerogationForMatch` depuis le
cinquième round — nouvel onglet, lu, refermé) avant de passer à la page
suivante. **Jamais un retour pur et simple au onzième round sans
protection** : borné explicitement par `derogationDetailBudgetMs`
(nouvelle option du constructeur, défaut 220 000 ms sur les 300 000 ms
Vercel — 80s de marge pour le lancement du navigateur, le login, la
recherche elle-même et l'écriture en base, jamais mesurés depuis cet
environnement donc volontairement généreux). Dès que ce budget est
dépassé, les lignes restantes (page courante ET pages suivantes le cas
échéant) gardent leurs champs de détail à `null` plutôt que de risquer un
nouveau dépassement dur du timeout Vercel — jamais une ligne perdue pour
autant, juste son détail (le tableau de résultats — numéro/état/dates —
reste la source de vérité minimale, toujours renseigné).

**Filet de sécurité côté écriture** (`processCheckAllDerogationsJob`) :
avant cette exécution, `fbi_derogation_checks` était TOUJOURS écrasé avec
les valeurs de détail de `fetchAllDerogations`, `null` ou pas — un
détail déjà connu d'une exécution précédente (`fetchDerogationForMatch`,
ou un `check_all_derogations` antérieur qui avait eu le temps de le
lire) pouvait donc être ÉCRASÉ à `null` par une exécution qui, elle,
n'a pas eu ce temps (budget dépassé, best effort). C'est exactement ce
qui s'est produit ici : le round précédent écrasait tout systématiquement.
Corrigé : `processCheckAllDerogationsJob` lit maintenant le détail déjà
connu du club (une seule requête, avant la boucle d'upsert) et ne
l'écrase JAMAIS avec `null` — seulement avec une vraie valeur fraîche.
Les champs TOUJOURS fiables depuis le tableau de résultats (état, dates,
domicile/visiteur) restent eux systématiquement rafraîchis, jamais de
repli sur l'ancien.

**Tests** : le test "ne ramène PAS le détail" du onzième round est
inversé (le serveur de test route par chemin seul, donc chaque ligne
ramène le même détail fixe de la fixture `afficher-derogation.html` —
suffisant pour prouver que le détail est bien lu). Nouveau test dédié à
`derogationDetailBudgetMs: 0` : confirme que budget épuisé ⇒ aucun
onglet ouvert, détail `null`, mais le tableau de résultats (numéro/état)
reste intact. 26/26 tests FBI passants, suite complète (417 tests)
inchangée par ailleurs.

**Prochaine vérification en production** : re-déclencher "Vérifier
toutes les dérogations", puis lire `fbi_derogation_checks` — `demandeur`/
`motif`/etc. devraient être renseignés pour les ~51-82 lignes (dans la
limite du budget de 220s), et `fbi_jobs.result.passDiagnostics[0]`
devrait montrer `pageCount: 1` (ou très bas) avec `rawRowCount ===
keptRowCount` (plus de doublons dus à la pagination instable).

### Toujours 51 après le round treize/quatorze — diagnostic du contrôle de longueur ajouté plutôt qu'un quinzième correctif à l'aveugle (2026-09-27)

Le club confirme que le détail (demandeur/motif/dates) est bien revenu
(quatorzième round), **mais reste toujours bloqué à 51 dérogations**,
malgré `tryMaximizeResultsPageLength` censé ramener tout en une seule
page. L'exécution la plus récente en base (job `0e65ae27`, ~14 minutes
après le déploiement du treizième/quatorzième round — largement assez de
marge pour un redéploiement Vercel, donc bien contre le NOUVEAU code) donne
`{ pageCount: 2, rawRowCount: 46, keptRowCount: 34 }` : NI `pageCount: 1`
(la maximisation aurait dû tout ramener en une page) NI la valeur stable
attendue — un résultat encore plus bas que les 51 déjà connus, et
incohérent d'une exécution à l'autre (2, 5 pages... jamais 1). Signe fort
que `tryMaximizeResultsPageLength` échoue silencieusement sur le VRAI
FBI (best effort — une erreur n'y bloque jamais la recherche) et que
`collectAllDerogationPages` retombe systématiquement sur la pagination
"Suivant", CONNUE instable (doublons/pertes constatés au round douze).

**Cause probable, jamais confirmée par du HTML réel** : contrairement à
`nextPageControl` (corrigé au dixième round sur la foi d'un VRAI
`outerHTML` fourni par le club), l'EXISTENCE même d'un `<select
id="..._length">` ("Afficher X entrées") sur CETTE page FBI précise n'a
JAMAIS été confirmée — seulement déduite par analogie avec la convention
DataTables (`<idTable>_next` confirmé ⇒ `<idTable>_length` "très
probablement" présent). Beaucoup d'intégrations DataTables désactivent
explicitement ce contrôle (`lengthChange: false`) tout en gardant la
pagination "Suivant" — auquel cas `resultsLengthSelect(page).count()`
vaut `0` sur le vrai FBI, `tryMaximizeResultsPageLength` ne fait
STRICTEMENT rien (return anticipé), et tout retombe sur "Suivant".

**Pas de quinzième correctif à l'aveugle** — même discipline que le
douzième round ("diagnostic de pages ajouté" plutôt que deviner) :
`tryMaximizeResultsPageLength` renvoie désormais un `LengthSelectDiagnostic`
(`found`/`selectId`/`optionValues`/`appliedValue`), persisté dans
`passDiagnostics[0].lengthSelect` (consultable directement en base, sans
dépendre des logs Vercel). La PROCHAINE exécution dira, sans deviner :
- `found: false` ⇒ ce contrôle n'existe simplement pas sur cette page —
  il faut soit demander au club une capture/le HTML autour du tableau de
  résultats (comme pour `nextPageControl` au dixième round) pour trouver
  le VRAI mécanisme (peut-être un `<select>` sans le suffixe `_length`,
  ou un contrôle non-DataTables), soit accepter la pagination "Suivant"
  et s'attaquer plutôt à SA cause d'instabilité (tri non déterministe
  côté serveur — hors de portée d'un simple sélecteur).
- `found: true` mais `appliedValue` différent de ce qui était attendu (ex :
  une valeur "20" au lieu de "-1"/"Tous" faute d'option "Tous" réelle) ⇒
  le contrôle existe mais sa VRAIE liste d'options (`optionValues`) diffère
  de la fixture — ajuster le choix de la meilleure valeur en conséquence,
  sur preuve cette fois.
- `found: true` ET `appliedValue` correct mais `pageCount` reste > 1 ⇒ la
  sélection s'applique mais ne suffit pas à afficher tout en une page
  (ex : un maximum serveur inférieur au total réel) — chercher alors une
  vraie limite haute plutôt que "-1".

Testé contre la fixture (qui, elle, a bien ce contrôle) : nouveau
sous-test confirmant `lengthSelect: { found: true, selectId:
"getTableauDerogation_length", appliedValue: "-1" }`. 26/26 tests FBI
passants, suite complète (417 tests) inchangée par ailleurs.

### Preuve obtenue : le contrôle n'existe pas — la vraie cause était une lecture prématurée après "Suivant" (seizième round, 2026-09-27)

Le club relance, le diagnostic répond SANS deviner :
```json
"lengthSelect": { "found": false, "selectId": null, "appliedValue": null, "optionValues": [] }
```
Confirmé : le contrôle "Afficher X entrées" n'existe PAS sur cette page
FBI. `tryMaximizeResultsPageLength` no-op donc systématiquement (best
effort) et `collectAllDerogationPages` retombe TOUJOURRS sur la
pagination "Suivant" — seule option réelle disponible.

**Mais le vrai problème n'est pas là où le treizième round le pensait.**
La même exécution donne `{ pageCount: 1, rawRowCount: 23, keptRowCount: 20 }`
— PIRE que les 51 déjà connus. Et l'exécution juste avant (contre le même
code) donnait `{ pageCount: 2, rawRowCount: 46 }`. Deux exécutions
consécutives contre EXACTEMENT le même code, le même club, le même jeu de
dérogations réel — `pageCount` passe de 1 à 2 à (déjà vu) 5. Une pagination
qui s'arrête à un nombre de pages différent CHAQUE FOIS n'est pas un
problème de tri instable côté serveur (hypothèse du douzième round) : le
nombre de pages RÉELLES ne change pas d'une minute à l'autre. C'est la
DÉTECTION DE FIN DE PAGINATION elle-même qui est en cause.

**Cause identifiée** : l'ancienne boucle (`collectAllResultPages`/
`collectAllDerogationPages`) lisait le tableau, cliquait "Suivant", puis
comparait la PROCHAINE lecture à celle d'AVANT le clic — si identique,
elle concluait "dernière page atteinte, le clic n'a rien changé". Cette
comparaison confond deux causes totalement différentes : une VRAIE
dernière page (rien de plus à charger, le clic est un no-op) et un AJAX
FBI simplement LENT dont la réponse n'est pas encore arrivée au moment de
la lecture — dans ce second cas, le tableau affiche encore l'ANCIENNE
page au moment où le code la lit, indistinguable d'une dernière page pour
cette comparaison. Le VRAI FBI, servi depuis Vercel vers l'extranet FFBB
(latence réseau réelle, jamais observée dans les tests contre une fixture
locale synchrone), a un temps de réponse variable d'une exécution à
l'autre — expliquant enfin pourquoi `pageCount` varie 1/2/5 pour le même
jeu de données.

**Fix** : nouvelle méthode `waitForDerogationPageAdvance` — après un clic
"Suivant", repolle jusqu'à 15 fois une lecture qui DIFFÈRE de la page
précédente ET qui se STABILISE (deux lectures consécutives identiques),
avant de l'accepter comme la nouvelle page. Renvoie `null` UNIQUEMENT si
le contenu n'a jamais changé après ces 15 tentatives — alors, et
seulement alors, la dernière page est considérée réellement atteinte.
`collectAllDerogationPages` restructurée en conséquence (lit une fois
avant le clic, utilise `waitForDerogationPageAdvance` après, jamais un
second `resultsTableGenericRows` non gardé par cette attente).

**Fixture mise à jour pour refléter la preuve, pas une supposition** :
- Le contrôle "Afficher X entrées" (ajouté au treizième round par
  analogie, jamais confirmé) est RETIRÉ de la fixture — il n'existe pas
  sur le vrai FBI (`lengthSelect.found: false` ci-dessus), le garder
  aurait continué à tester un scénario qui n'arrive jamais en production.
- `changerPage` différée par un `setTimeout` de 150ms — simule l'AJAX
  FBI réel lent. Sans ce délai, une fixture synchrone ne pouvait
  structurellement jamais reproduire ce bug (la lecture "trop précoce"
  n'existe pas quand tout se met à jour instantanément).
- Le test de pagination multi-page attend maintenant `pageCount: 2` (2
  vraies pages, `PAGE_SIZE` fixe à 2) avec `rawRowCount === keptRowCount
  === 4` MALGRÉ le délai artificiel — preuve directe que le nouveau code
  attend correctement la fin de l'AJAX avant de conclure.

26/26 tests FBI passants, suite complète (417 tests) inchangée par
ailleurs. **Prochaine vérification en production** : re-déclencher
"Vérifier toutes les dérogations" — `passDiagnostics[0]` devrait
désormais montrer un `pageCount` STABLE d'une exécution à l'autre (le
vrai nombre de pages FBI, probablement ~4-5 pour ~82 dérogations) avec
`rawRowCount === keptRowCount` (plus de doublons — la sortie de boucle
n'intervient plus qu'une fois la VRAIE dernière page confirmée).

### Résultat encore pire (0/51) juste après déploiement — diagnostic de contenu ajouté, pas de dix-septième correctif à l'aveugle (2026-09-27)

Le club relance ~70 secondes après le push du seizième round —
probablement AVANT la fin du redéploiement Vercel (build + bascule,
souvent 1-3 minutes) : le job qui a tourné donne `{ pageCount: 1,
rawRowCount: 3, keptRowCount: 0 }` — encore moins que les 51 déjà
connus, et pour la première fois AUCUNE ligne gardée du tout
(`matched: 0`). Deux hypothèses concurrentes, aucune confirmée par une
preuve directe pour l'instant :
1. Ce job a tourné contre l'AVANT-DERNIER déploiement (le round
   diagnostic seul, sans le fix de pagination) — plausible vu le délai
   court, mais n'explique pas `rawRowCount: 3` (un résultat bien plus
   bas que tout ce qui avait été vu jusqu'ici, y compris avant tout
   correctif de pagination).
2. Un problème distinct : accès répété au VRAI FBI (7 déclenchements
   manuels du même job en moins de 3 heures) déclenchant un
   ralentissement/une dégradation côté FBI, OU une navigation qui a
   atterri sur une page/tableau qui n'est PAS celui des dérogations (3
   lignes sans rapport, jamais vérifié directement).

**Toujours pas de correctif à l'aveugle** : `rawRowSample` (jusqu'aux 3
premières lignes BRUTES lues, dictionnaire en-tête→cellule complet,
AVANT tout filtrage) et `pageTitleAtFirstRead` (titre de la page au
moment de cette lecture) sont ajoutés à `passDiagnostics[0]` — la
PROCHAINE exécution dira, sans deviner, si ces 3 lignes sont la ligne
fantôme DataTables ("Aucune donnée disponible..."), le contenu d'une
tout autre page, ou autre chose. 26/26 tests FBI passants, suite
complète (417 tests) inchangée par ailleurs.

**Recommandation au club** : laisser 2-3 minutes après un push avant de
relancer "Vérifier toutes les dérogations" (le temps qu'un déploiement
Vercel bascule), et éviter de le redéclencher en rafale (attendre au
moins quelques minutes entre deux tentatives) — le nombre de
déclenchements rapprochés cette après-midi (7 en moins de 3 heures)
pourrait lui-même contribuer à une dégradation côté FBI, hypothèse à
confirmer ou écarter avec `pageTitleAtFirstRead`/`rawRowSample` sur la
prochaine exécution plutôt que supposée.

### La vraie cause de "82 vs 51" — une rencontre peut avoir PLUSIEURS dérogations, et un numéro n'est pas unique au club (dix-septième round, 2026-09-27)

Le club fournit enfin la preuve qui manquait depuis le début : un export
Excel du VRAI FBI (`rechercherDerogation.xlsx`, capture d'écran de son
écran "Compétitions > Dérogations", "voici un excel de tt celles qui
doivent figurer"). Lu directement (zip/XML brut, sans dépendance
manquante) : **82 lignes réelles, mais seulement 51 numéros de rencontre
UNIQUES.** 21 numéros ont PLUSIEURS lignes — jusqu'à **8** pour la seule
rencontre n°23, avec des "Date de dépôt" différentes (parfois une heure
proposée différente). Le club confirme ensuite, capture d'écran à
l'appui : ces 8 lignes du n°23 correspondent en réalité à **deux
rencontres distinctes** (divisions `BU11FN23` et `BU11MN2`) qui partagent
COÏNCIDEMMENT le même numéro.

Ce n'était donc JAMAIS un bug de pagination/lecture (les treize rounds
précédents avaient bien progressé sur ce terrain, à raison) : **51 EST le
nombre exact de rencontres uniques**, et le code faisait exactement ce
qu'il devait faire AVEC UNE HYPOTHÈSE FAUSSE — dédoublonner par `numero`,
en supposant (jamais vérifié) qu'une rencontre n'a qu'une seule
dérogation et qu'un numéro identifie une rencontre unique au club. Les
DEUX hypothèses sont fausses :
1. Une rencontre peut avoir plusieurs dérogations FBI distinctes
   (resoumissions, propositions d'horaires différentes...).
2. Le numéro de rencontre n'est PAS unique au club — deux rencontres de
   divisions différentes peuvent partager le même numéro.

**Décision du club** (AskUserQuestion) : afficher les 82, une carte par
dérogation — jamais dédupliquées par rencontre.

**Fix, en plusieurs parties** :
- `FbiDerogationRow.idDerogation` (nouveau champ) : le jeton `idDerogation`
  du lien de détail de CHAQUE ligne (`afficherDerogation.fbi?idDerogation=...`)
  — LA clé stable d'une VRAIE dérogation FBI, extrait une seule fois par
  ligne (`derogationRowDetailHref`/`parseIdDerogation`, browser-client.ts)
  et réutilisé à la fois pour l'identité de la ligne ET pour son détail
  (plus de double requête DOM).
- `fetchAllDerogations` dédoublonne désormais par `idDerogation` (absorbe
  les VRAIS doublons de lecture, une page relue deux fois) — JAMAIS plus
  par `numero`, qui écrasait à tort de vraies dérogations distinctes.
- `fetchDerogationForMatch` accepte un `division` optionnel pour
  désambiguïser un numéro partagé entre compétitions ; si plusieurs
  dérogations matchent malgré tout (même rencontre, plusieurs demandes),
  garde la plus RÉCENTE (`compareDerogationDateDepot`, derogation-row.ts).
- `processCheckAllDerogationsJob`/`processCheckDerogationJob` rapprochent
  désormais dérogation → match par `(numero, division)` — `division` FBI
  ≙ `competitions.code` FFBB, lu via une requête séparée (jamais un
  embedded select, jamais éprouvé dans ce module) et croisé en mémoire.
- Migration `fbi_derogation_multiple_per_match` : la contrainte
  `unique (club_id, match_id)` (au plus UNE dérogation par rencontre)
  est remplacée par `unique (club_id, fbi_row_key)` — `fbi_row_key` dérivé
  d'`idDerogation` (repli composite si absent). `match_id` reste
  obligatoire mais n'est plus unique : une rencontre peut désormais avoir
  plusieurs lignes `fbi_derogation_checks`.
- API/ball-manager-web : `DerogationListItemDto` gagne un champ `id` (la ligne
  `fbi_derogation_checks`, jamais `matchId` comme clé — une rencontre peut
  en avoir plusieurs). `DerogationsList.tsx` clé désormais ses cartes par
  `id` et affiche la "Date de dépôt" pour les distinguer visuellement
  quand plusieurs cartes partagent la même rencontre.

**Tests** : nouvelle rencontre n°1 dans la fixture (même numéro, division
`BU13MN2` différente de la 1ère "1"/BU13FN23, `idDerogation` différent) —
`fetchAllDerogations` doit ramener les DEUX ; `fetchDerogationForMatch`
sans division garde la plus récente, avec la bonne division trouve
l'AUTRE. 28/28 tests FBI passants, suite complète (422 tests) inchangée
par ailleurs.

**Prochaine vérification en production** : re-déclencher "Vérifier toutes
les dérogations" — `fbi_derogation_checks` devrait désormais compter ~82
lignes (dans la limite de ce que la pagination/le budget de détail
ramènent réellement), plusieurs par rencontre pour les 21 numéros
concernés.

### Rencontre 23 uniquement — le champ "Numéro de rencontre" n'est PAS vide par défaut sur le VRAI FBI (dix-huitième round, 2026-09-27)

Le club relance après le dix-septième round : le résultat est PIRE que
jamais — `matched: 8, unmatched: 0`, et les 8 dérogations trouvées sont
TOUTES pour la rencontre "23" (les deux divisions BU11FN23/BU11MN2
confondues), plus 3 lignes filtrées (`rawRowCount: 11`). Aucune autre
rencontre. `fetchAllDerogations` ne remplit JAMAIS le champ "Numéro de
rencontre" (recherche "à numéro vide", voir sa doc) — donc si le résultat
est filtré sur "23" pile, c'est que ce champ N'ÉTAIT PAS vide au moment
de la soumission.

Preuve corrélée directement en base (`fbi_jobs`) : **deux jobs
`check_derogation` pour CETTE MÊME rencontre "23" ont tourné la veille**
(2026-09-25) — `fetchDerogationForMatch` REMPLIT ce champ avec le numéro
recherché avant de soumettre. Le VRAI FBI (application Java legacy)
retient donc la DERNIÈRE VALEUR SOUMISE pour ce champ CÔTÉ SERVEUR (très
probablement liée au compte utilisateur, pas au cookie de session) — un
nouveau login/`BrowserContext` frais ne le réinitialise PAS. Jamais
constaté ni supposé avant ce round : `fetchAllDerogations` comptait sur
un champ "vide par défaut" après navigation vers l'écran de recherche,
une hypothèse qui ne tient pas en pratique.

**Fix** : le champ est désormais vidé EXPLICITEMENT (`.fill("")`) juste
avant CHAQUE soumission dans `fetchAllDerogations`, quelle que soit sa
valeur de départ — ne plus jamais dépendre d'un état ambiant supposé
quand on peut l'imposer. Sa valeur AVANT ce vidage est capturée dans
`passDiagnostics[0].numeroValueBeforeClear` (persisté, consultable sans
deviner si ce risque se reproduit).

**Fixture mise à jour pour refléter la preuve** : le champ "Numéro de
rencontre" démarre désormais à `value="23"` (jamais vide) dans
`rechercher-derogation.html` — reproduit fidèlement le comportement
constaté, et par la même occasion couvre TOUS les tests
`fetchAllDerogations` existants contre cette régression (ils
échoueraient tous si le vidage explicite manquait). Nouveau test dédié
vérifiant `numeroValueBeforeClear: "23"`. 29/29 tests FBI passants, suite
complète (423 tests) inchangée par ailleurs.

**Prochaine vérification en production** : re-déclencher "Vérifier
toutes les dérogations" — `foundNumeros`/`matched` devrait à nouveau
couvrir la diversité de rencontres attendue (pas uniquement "23"), et
`passDiagnostics[0].numeroValueBeforeClear` confirmera si ce risque était
bien la cause (une valeur non-vide) ou si le champ était déjà vide cette
fois (cause différente à chercher).

### Confirmé, puis zéro résultat — le même bug de lecture prématurée touchait aussi la soumission INITIALE (dix-neuvième round, 2026-09-27)

Le club relance : `numeroValueBeforeClear: "23"` confirme noir sur blanc
que le champ n'était PAS vide (la théorie du round précédent était
correcte) — mais le résultat est `rawRowCount: 0, keptRowCount: 0` cette
fois, ZÉRO ligne, pas même la ligne fantôme "Aucune donnée disponible".
Le club le vit très mal ("ya un gros pb lol"), à raison : trois rounds
d'affilée sans amélioration visible.

**La cause est la MÊME que celle du seizième round (pagination
"Suivant")**, jamais appliquée à la soumission INITIALE jusqu'ici :
`waitForStableDerogationTable` (utilisé après le clic RECHERCHER) compare
deux lectures CONSÉCUTIVES entre elles, jamais à l'état d'AVANT la
soumission — si l'AJAX est lent, il peut se "stabiliser" sur l'écran
encore VIDE (avant tout résultat) et jamais attendre le VRAI résultat.
Vider le champ "Numéro de rencontre" (round précédent) a changé la
recherche RÉELLE de "un seul numéro" (rapide) à "tous les numéros"
(nécessairement plus lente côté serveur, davantage de lignes à préparer)
— exposant ce bug latent qui n'avait jamais posé de problème quand la
recherche restait filtrée sur un numéro par accident.

**Fix** : `waitForDerogationPageAdvance` (créé au seizième round pour la
pagination) est généralisé en `waitForDerogationTableRefresh` et utilisé
aussi pour la soumission INITIALE de `fetchAllDerogations` ET
`fetchDerogationForMatch` — capture l'état du tableau AVANT le clic
RECHERCHER, attend un changement RÉEL par rapport à CET état (jamais
juste une stabilisation), avant de continuer. `collectAllDerogationPages`
(pagination "Suivant") réutilise la même méthode générale.

29/29 tests FBI passants, suite complète (423 tests) inchangée par
ailleurs. **Prochaine vérification en production** : re-déclencher
"Vérifier toutes les dérogations" — `rawRowCount` devrait cette fois
refléter la RÉELLE ampleur de la recherche "tous les numéros" (plusieurs
dizaines de lignes, pas 0), avec `numeroValueBeforeClear` confirmant que
le champ est bien vidé avant chaque soumission désormais.

### "jen ai que 8" — `page.locator("table ...")` lisait un tableau SANS RAPPORT ailleurs sur la page (vingtième round, 2026-09-27)

Le club relance : `numeroValueBeforeClear: ""` confirme que le champ est
bien vide dès le départ cette fois (round précédent confirmé réglé) —
mais le résultat retombe EXACTEMENT au même schéma que deux exécutions
antérieures (20:41 et 21:46) : `rawRowCount: 3, keptRowCount: 0,
rawRowSample: [{}, {}, {}]` — trois lignes, TOUJOURS vides une fois
mappées à nos 9 colonnes attendues. Constaté IDENTIQUE à trois reprises
différentes (jamais une valeur qui varie comme un aléa de timing le
ferait) : signe d'un problème STRUCTUREL, pas d'une course AJAX — la
famille de bug déjà corrigée aux rounds seize et dix-neuf.

**La vraie cause, enfin isolée** : `selectors.resultsTableGenericRows`
(et `derogationRowDetailHref`) utilisaient `page.locator("table th, ...")`
/`page.locator("table tbody tr")` — un sélecteur qui matche N'IMPORTE
QUEL `<table>` de TOUTE la page, jamais scopé au VRAI tableau de
résultats. Si ce vrai tableau n'a pas encore de lignes au moment de la
lecture (recherche encore en cours, ou juste après navigation), ce
sélecteur retombe sur un AUTRE tableau sans rapport ailleurs sur la page
(menu, mise en page — probablement toujours LE MÊME, d'où les "3 lignes"
identiques à chaque fois) — un bug de longue date, jamais visible avant
que la recherche "tous les numéros" ne s'exécute pour de vrai (les
recherches filtrées par numéro, plus rapides, laissaient rarement le
temps à ce mauvais lock-on de se produire).

**Fix** : `selectors.derogationResultsContainer(page)` scope désormais
les lectures au VRAI conteneur — `id="rechercherDerogationAjax"`,
enveloppé dans `id="rechercherDerogationAjax_wrapper"` (convention
DataTables CODÉE EN DUR, même famille que `<idTable>_next` déjà confirmé
réel sur le bouton "Suivant" — jamais `getTableauDerogation`, une
supposition antérieure jamais confirmée par du HTML réel). `resolveDerogationScope`
résout ce conteneur UNE FOIS par recherche (repli sur `page` entière,
comportement d'avant ce round, si le conteneur n'est pas trouvé — jamais
un échec dur), réutilisé pour TOUTES les lectures de cette recherche
(`resultsTableGenericRows`, `derogationRowDetailHref`,
`waitForDerogationTableRefresh`) — jamais un mélange d'un tableau scopé
et d'un tableau page-entière pour la même recherche. `derogationContainerFound`
persisté dans `passDiagnostics[0]` pour confirmer si ce conteneur existe
vraiment sur le VRAI FBI.

**Fixture mise à jour pour reproduire fidèlement ce bug** — table et
conteneur renommés `rechercherDerogationAjax`/`_wrapper` (au lieu de
`getTableauDerogation`/`tableauResultats`, jamais confirmés), et une
TABLE DÉCOY (`#menuSansRapport`, mise en page plausible) ajoutée avant le
conteneur des résultats. Vérifié manuellement que retirer le scope
(passer `page` au lieu du conteneur résolu) fait ÉCHOUER 4 tests avec un
résultat corrompu très parlant — le numéro de rencontre remplacé par des
noms d'équipe (colonnes mal alignées entre le décoy et le vrai tableau) —
la même famille de symptôme que "3 lignes vides" en production. 29/29
tests FBI passants avec le scope actif, suite complète (423 tests)
inchangée par ailleurs.

**Prochaine vérification en production** : re-déclencher "Vérifier toutes
les dérogations" — `derogationContainerFound` dira si l'id
`rechercherDerogationAjax` est confirmé réel ; `rawRowCount` devrait
enfin refléter la vraie ampleur de la recherche (plusieurs dizaines de
lignes, jamais 3).

## Revirement du 2026-09-27 : FBI l'emporte désormais sur FFBB (date/heure, salle)

Décision d'origine (20260925120000_fbi_schedule_reconciliation.sql) :
"FFBB reste la seule source ÉCRITE dans `matches`... jamais une écriture
automatique sur `matches`" — le rapprochement calendrier FFBB/FBI ne
faisait que journaliser des anomalies pour correction manuelle côté FFBB.

Le club est revenu explicitement sur cette décision : **"Non, FBI doit
emporter sur FFBB car les vraies infos proviennent de FBI"**, avec deux
précisions apportées en clarifiant la demande :
1. Correction **automatique**, pas un bouton "valider" par anomalie.
2. Portée : **écart date/heure ET salle** — les deux seuls champs
   comparés par `reconcileFbiSchedule` (score/forfait restent hors
   scope, format jamais confirmé). `missing_in_ffbb`/`missing_in_fbi`
   restent des anomalies MANUELLES — FBI seul n'a pas assez d'info
   (logo, équipe, engagement FFBB...) pour créer/compléter un match.

**Implémentation** :
- `schedule-reconciliation.ts` (fonction pure) calcule désormais, pour
  chaque `mismatch`, une `correction` prête à écrire
  (`{ matchDatetime }` ou `{ venueRawLabel }`) — jamais pour une anomalie
  de présence.
- Salle comparée avec `venuesLikelyMatch` (containment, insensible
  casse/accents) plutôt qu'une égalité stricte : `matches.venue_raw_label`
  combine nom ET adresse FFBB (`"Nom — Adresse"`), FBI n'affiche
  vraisemblablement que le nom (jamais confirmé par une vraie capture) —
  une égalité stricte aurait fait remonter une anomalie sur quasiment
  CHAQUE rencontre.
- `process-reconcile-schedule.ts` applique la correction sur `matches`
  puis marque la ligne `fbi_schedule_discrepancies` correspondante
  `resolved_at` + `auto_corrected_at` (nouvelle colonne, migration
  `20260927010000`) DANS LA MÊME EXÉCUTION — jamais laissée "ouverte"
  comme si une action restait à faire.
- Page Anomalies (`GET .../issues`) : affiche en plus des anomalies
  ouvertes celles auto-corrigées dans les 7 derniers jours (transparence
  "qu'est-ce qui a changé"), avec un message au passé et
  `status: "auto_corrected"` (nouvelle valeur, `IssueDtoSchema.status`
  élargi de `z.literal("open")` — exactement l'extension anticipée par
  son propre commentaire).

**Bug corrigé au passage** : l'alerte de conflit de créneau (dérogations,
voir plus bas) comparait TOUS les matchs du club entre eux, y compris
domicile-vs-extérieur — signalé par le club : "palavas sete c un match a
lextérieur. donc il ny a pas de conflit... si ya 1 match domicile 1
extérieur meme heure c pas un soucis". Un match à l'extérieur se joue
chez l'adversaire, jamais dans une salle du club : `derogations/routes.ts`
ne compare désormais que les matchs à DOMICILE entre eux (même
raisonnement que `venue-conflicts.ts`), et ne calcule même plus l'alerte
pour la dérogation d'un match à l'extérieur.

## "aucune dérogation connue" puis "jai pas le motif" — deux rounds le même jour (2026-09-27)

Round 1 : le club signale un badge "Dérog en cours" sur un match dont la
fiche détail affiche "aucune dérogation connue". Cause confirmée en base
(rencontre n°5009) : DEUX lignes `fbi_derogation_checks` réelles pour la
même rencontre ("En Cours" et "Acceptée par l'organisme dirigeant", même
`checked_at`, `fbi_row_key` distincts — § "82 vs 51"). `GET .../matches/
:matchId/derogation` utilisait encore `.maybeSingle()` (hypothèse
pré-migration d'une seule ligne par match) : PostgREST rejette cet appel
dès 2+ lignes, l'erreur était silencieusement ignorée (`const { data } =
...`), donnant `derogation: null`. Corrigé une première fois en
priorisant une ligne RÉELLEMENT "En Cours".

Round 2, le club revient aussitôt : "mais la ligne en cours devrait aussi
avoir son détail". Le premier correctif avait résolu le `null` mais
choisi la MAUVAISE ligne sur une autre rencontre réelle (n°15) : sa ligne
"En Cours" n'avait JAMAIS eu son détail récupéré (`demandeur`/`motif`/etc
tous `null`), alors qu'une autre ligne pour la même rencontre, "Acceptée
par l'organisme dirigeant", avait le détail complet — et son
`heureDemandee: "17:00"` correspondait bien à l'heure RÉELLE affichée
ailleurs sur la fiche match, confirmant qu'elle seule reflétait l'état
réel, "En Cours" n'étant qu'un reliquat sans détail jamais récupéré.

Root cause identifiée avec le client : `collectAllDerogationPages`
fetchait le détail ligne par ligne, DANS L'ORDRE DU TABLEAU FBI, borné par
`derogationDetailBudgetMs`. Si le budget s'épuisait en cours de route, les
lignes restantes perdaient leur détail au hasard de leur POSITION dans le
tableau — sans lien avec leur importance réelle. Corrigé : href/
idDerogation collectés pendant la pagination (lecture DOM, jamais de
navigation), le détail lui-même récupéré dans une passe séparée APRÈS
avoir parcouru toutes les pages, triée par priorité — "En Cours" (dossier
réellement actionnable) d'abord, le reste ensuite. Si le budget doit
sacrifier des lignes, ce sont désormais les moins actionables qui perdent
leur détail en premier, jamais un tirage dépendant de l'ordre FBI. Séparer
la collecte du détail de la pagination est sûr : `fetchDerogationDetailByHref`
ouvre un onglet indépendant par ligne, sans dépendance à l'état de
navigation de la page principale.

Côté `GET .../matches/:matchId/derogation` : la sélection de "quelle
ligne afficher" quand plusieurs existent priorise désormais la COMPLÉTUDE
du détail (une ligne avec du contenu réel vaut mieux qu'un état "actif"
mais vide), départagée par `date_depot` (date de dépôt RÉELLE côté FBI),
jamais par l'état seul ni par `checked_at` (qui ne reflète que l'heure de
NOTRE vérification).

## Réponse RÉELLE à une dérogation (accepter/refuser) — la phase 1 se termine

Demande du club, 2026-09-27 : **"maintenant pour une rencontre en cours
qui attend une validation ou refus de notre part, je veux le faire via
loutil."** Revient explicitement sur le choix de phase 1 ("Gestion des
dérogations (lecture seule, phase 1)" ci-dessus) — la consultation seule
ne suffit plus, le club veut répondre RÉELLEMENT (accepter/refuser) aux
demandes de l'adversaire directement depuis cet outil, sans repasser par
FBI.

**Toujours pas une décision anodine** : ça ÉCRIT sur FBI/FFBB — une action
réelle et engageante envers un tiers (le club adverse, potentiellement
l'organisme dirigeant), jamais annulable depuis cet outil une fois
confirmée par FBI. Construit avec deux garde-fous que la phase 1 n'avait
pas besoin d'avoir :
1. Une confirmation explicite côté ball-manager-web avant tout envoi (jamais un simple
   clic direct sur "Accepter"/"Refuser").
2. Une trace d'audit systématique (`fbi_derogation_responses` — qui, quand,
   quelle décision, ce que FBI a RÉELLEMENT renvoyé), écrite AVANT de
   retourner le résultat à l'appelant, succès ou échec.

**"si action besoin de ma part, faut un badge action requise"** — une
dérogation "En Cours" n'attend pas TOUJOURS une décision du club : si LUI
est demandeur, il attend l'adversaire (rien à faire). `demandeur`
("Domicile"/"Visiteur") est un jargon FBI relatif à la rencontre, jamais
comparable au nom d'équipe brut (fuzzy, non fiable) — comparé à `isHome`
(fiable, déjà connu via la synchro FFBB) dans `modules/derogations/action-required.ts`,
exposé côté API comme `actionRequired` sur `DerogationStatusDto`/
`DerogationListItemDto`. `false` par défaut si le côté du club n'a pas pu
être déterminé — jamais deviné pour une action irréversible.

**HTML source réel fourni par le club** (rencontre 9538, division DM2,
2026-09-27) pour le cas "réponse attendue" — DIFFÉRENT du HTML déjà connu
(rencontre 15, § plus haut) qui montrait la section "Réponse de
l'adversaire" en LECTURE SEULE (le club y est demandeur, donc en attente) :
- Champ de décision : `<select name="derogationForm.derogationReponseAdversaireBean.acceptation">`
  avec options `P`=NC (défaut) / `N`=Refusée / `O`=Acceptée — PAS
  `input#acceptation` (ça, c'est l'affichage lecture seule, déjà lu par
  `selectors.derogationDetailFields`, un champ DIFFÉRENT qui coexiste sur
  la même page).
- Motif de refus : `<textarea name="derogationForm.derogationReponseAdversaireBean.motifRefus">`,
  activable (jamais `readonly` dans ce cas).
- Bouton "Enregistrer" (`button.boutonEnregistrer`) déclenche
  `enregistrerDerogationAjax()` (JS réel de la page) : sérialise le
  formulaire (`$("#afficherDerogation").serialize()` — les champs
  `disabled` de la section "Demande de dérogation" ne sont donc jamais
  soumis), POST vers `enregistrerDerogation.fbi`. Succès → navigation vers
  `rechercherDerogation.fbi` (`retourArriere()`) ; échec → `afficherErreur(request)`
  avec un contenu contenant `<ul class="errorMessage">` (jamais un message
  générique inventé côté applicatif).

**Détection du résultat** (`BrowserFbiClient.respondToDerogation`) :
navigation loin de la page = succès ; `ul.errorMessage` présent sans
navigation = échec (message RÉEL remonté tel quel) ; NI L'UN NI L'AUTRE
dans le délai imparti = `unknown`, JAMAIS traité comme un succès sans
preuve — l'admin doit alors vérifier manuellement sur FBI avant de
réessayer. `afficherErreur`/`postAjax` sont des fonctions JS PARTAGÉES
(fichier externe, jamais vues en clair) : leur comportement exact n'est
donc déduit que de ce qui est OBSERVABLE (navigation ou absence), jamais
deviné plus finement.

**Architecture volontairement SYNCHRONE** (`respondToDerogationForClub`,
`POST .../derogations/:derogationId/respond` et
`POST .../matches/:matchId/derogation/respond`) — contrairement à
`check_derogation`/`check_all_derogations` qui empilent un job `fbi_jobs`
traité séparément. Une action ponctuelle et volontaire où l'admin attend
une confirmation immédiate ne doit JAMAIS retomber dans l'ambiguïté "le
job est-il déjà passé ?" déjà vécue le jour même avec la famine de la file
`fbi_jobs` (voir migration `20260927020000_fbi_jobs_priority_by_type.sql`
et son commit) — login FBI, soumission, et (si succès) un rafraîchissement
immédiat de `fbi_derogation_checks` via `fetchDerogationForMatch` dans LA
MÊME session, le tout dans une seule requête HTTP.

`actionRequired` revalidé CÔTÉ SERVEUR dans `respondToDerogationForClub`
(jamais confiance dans le client) : le bouton ne doit exister côté ball-manager-web
que quand c'est vrai, mais une requête directe à cette route sans repasser
par l'UI ne doit jamais pouvoir soumettre une réponse pour une dérogation
qui n'attend pas celle du club.

## Vérifications manuelles rendues SYNCHRONES — "doit y avoir rien en attente"

Demande du club, 2026-09-28, après une nouvelle famine de la file
`fbi_jobs` (le job `check_all_derogations` empilé par un clic est resté
`pending` PLUS D'UNE JOURNÉE, un autre job plus ancien du club étant
traité à sa place à chaque appel `process-jobs` — malgré la priorité par
type déjà corrigée la veille, migration `20260927020000`) : **"à chaque
fois cest le meme pb quand je clique sur verifier les derog ya des
attentes, cest pas bon. doit y avoir rien en attente, faut que tu
corriges ca."**

Root cause structurelle, pas un simple réglage de priorité : le modèle
"empiler un job `fbi_jobs` puis espérer qu'un `process-jobs` traite CE job
précis" reste intrinsèquement fragile tant que d'autres jobs du même club
peuvent exister dans la file (cron quotidien, autre bouton oublié en
attente, etc.) — AUCUN ordre de priorité ne supprime cette incertitude
pour l'utilisateur qui vient de cliquer.

**Fix** : les deux vérifications déclenchées par un bouton (`POST
.../matches/:matchId/derogation/check` et `POST
.../integrations/fbi/check-all-derogations`) sont devenues SYNCHRONES —
`checkDerogationForMatchSync`/`checkAllDerogationsForClubSync`
(`modules/derogations/`) login/consultent FBI/enregistrent DANS la
requête HTTP et renvoient le résultat RÉEL immédiatement, jamais un job à
espérer voir traité. Même principe déjà appliqué à `respondToDerogationForClub`
(accepter/refuser, voir plus haut) — les TROIS actions FBI déclenchées
par un clic partagent maintenant ce modèle.

**Le cron quotidien continue d'empiler un job** `check_all_derogations`
(et `reconcile_schedule`) chaque matin via `enqueue-fbi-verifications.ts`
— volontairement CONSERVÉ tel quel (demande du club, 2026-09-26 : "faut
aussi intégrer toutes ces maj dans le cron daily... sans cliquer h24 sur
des boutons manuels") : un cron n'a personne à qui répondre
immédiatement, empiler puis traiter en arrière-plan (`/internal/cron/
fbi-jobs`) reste le bon modèle pour LUI. Les deux chemins (manuel
synchrone, cron asynchrone) écrivent dans la même table
`fbi_derogation_checks` via le même upsert — aucun conflit de données,
seule la façon de déclencher diffère.

**Garde-fou ajouté** (`modules/derogations/fbi-session-lock.ts`,
`assertNoActiveFbiJob`) : sans le passage par `fbi_jobs`, une action
synchrone perdait la protection "un seul job actif par club à la fois"
(`claim_next_fbi_job(_for_club)`) qui empêchait deux sessions FBI
simultanées pour le même club — un risque direct de blocage anti-bot déjà
vécu en production (voir ProcessFbiJobsButton.tsx, incident du
2026-09-24). Les trois actions synchrones vérifient maintenant
explicitement qu'aucun job `fbi_jobs` n'est `claimed`/`running` pour le
club avant de lancer Playwright — sinon 409 ("réessaie dans quelques
instants") plutôt qu'une deuxième connexion FBI concurrente.

## Création RÉELLE d'une dérogation — "mtn faut en créer une"

Demande du club, 2026-09-28, immédiatement après la phase 1 (accepter/
refuser) ci-dessus : **"on a vu comment accepter ou refuser une dérog, mtn
faut en créer une. (sur chaque rencontre faut un bouton "Créer une
dérogation") On va dans dérog > état : à créer > on cherche la rencontre
concernée > on remplit et choisi le motif, et on envoie de la meme facon
que pour accpter ou refuser"** — accompagnée du HTML source réel du
formulaire de création (`afficherDerogation.fbi?idDerogation=0&idRencontre=<jeton>`,
rencontre 16, Plateau BU18MN1 Poule A du 11/10/2026).

**Flux implémenté** (`BrowserFbiClient.createDerogation`, `modules/derogations/create-derogation.ts`,
`POST .../matches/:matchId/derogation/create`) : "on cherche la rencontre
concernée" est fait CÔTÉ SERVEUR, à partir du `matchId` déjà connu — jamais
une recherche manuelle côté UI. Recherche la ligne "A Créer" de cette
rencontre sur `rechercherDerogation.fbi` (état forcé sur `value="CREER"`,
JAMAIS `"TT"` qui l'exclut explicitement, voir plus haut), même
désambiguïsation par division que `fetchDerogationForMatch` (un numéro de
rencontre n'est pas unique au club). Navigue ensuite vers le `href` RÉEL
de cette ligne (jamais une URL de création construite à la main) : FBI y
affiche directement le formulaire de création pré-rempli. `null` renvoyé
par `createDerogation` si aucune ligne "A Créer" ne correspond (dérogation
déjà existante, ou numéro/division ne correspondant à rien) — traité comme
`outcome: "error"` côté `create-derogation.ts`, jamais une exception dure.

Champs RÉELS du formulaire supportés (jamais devinés, confirmés par le
HTML source fourni) : cases `#modifierDate`/`#modifierHoraire` (chacune
affiche son champ associé via `afficherComposant()`, JS réel de la page —
masqué par défaut), `#inverserRencontre`/`#inverserEquipe` (mutuellement
exclusives côté JS réel de la page ET revalidées côté serveur avant
l'appel Playwright, `CreateDerogationDtoSchema.refine()`), `#motif`
(obligatoire). Même bouton d'enregistrement et même détection de résultat
(navigation loin de la page = succès, `ul.errorMessage` = erreur, ni l'un
ni l'autre en 45s = `unknown`, jamais un succès supposé sans preuve) que
`respondToDerogation`.

**Volontairement PAS supporté : modification de SALLE**
(`#modifierSalle`). Le champ salle du formulaire réel n'est pas un champ
texte libre mais un bouton ouvrant une MODALE chargée en AJAX
(`rechercherModaleSalle()` → `rechercherSalleModaleAjax.fbi`, résultat
injecté dans `#rechercheSalleModaleCorps` puis sélectionné via
`retourSalleModale(idSalle, nomSalle)`) — sa mécanique réelle (contenu de
la modale, structure de la liste/recherche de salles) n'a jamais été
observée sur du HTML réel. Même règle que tout le reste de cette
intégration (AGENTS.md) : jamais un sélecteur deviné sans preuve directe.
Si ce besoin se confirme, il faudra d'abord obtenir le HTML réel de cette
modale (ex. capture réseau du club en ouvrant "Modifier la salle" sur le
vrai FBI) avant de l'implémenter.

Audit : chaque tentative de création (succès, erreur, `unknown`) est
journalisée dans `fbi_derogation_creations` (migration
`20260928000000_fbi_derogation_create.sql`) — même raisonnement que
`fbi_derogation_responses` (action réelle et engageante, jamais annulable
depuis cet outil). Même verrou anti-session-concurrente
(`assertNoActiveFbiJob`) que les deux autres actions synchrones.

## Job `reconcile_schedule` bloqué indéfiniment — "corrige stp"

Constaté en production le 2026-09-28 : un job `reconcile_schedule` empilé
à 03:18 (`fbi_jobs`, `status: pending`) n'a jamais été réclamé par aucun
worker/cron — aucun appel `.../fbi/process-jobs` ne s'est enchaîné derrière
cet insert ce jour-là. Des heures plus tard, le bouton "Vérifier le
calendrier (FFBB vs FBI)" échouait systématiquement avec "Un rapprochement
calendrier FBI est déjà en attente ou en cours pour ce club." — la
contrainte `fbi_jobs_unique_pending_reconcile_schedule` (migration
`20260925120000_fbi_schedule_reconciliation.sql`) interdit un DEUXIÈME job
`reconcile_schedule` actif (`pending`/`claimed`/`running`) pour ce club,
SANS AUCUNE fenêtre de fraîcheur — contrairement à `claim_next_fbi_job(_for_club)`
et `assertNoActiveFbiJob` (fenêtre de 10 min, voir plus haut) qui ignorent
déjà un job `claimed`/`running` trop vieux pour être un vrai traitement en
cours. Le cas `pending` (jamais réclamé du tout) n'était couvert par
AUCUNE de ces deux protections : un job resté `pending` bloquait ce club
INDÉFINIMENT, sans jamais expirer.

**Corrigé** (`reclaimStaleReconcileScheduleJob`,
`modules/derogations/fbi-session-lock.ts`, appelée juste avant l'`insert`
dans `POST .../fbi/reconcile-schedule`) : marque `failed` tout job
`reconcile_schedule` de ce club bloqué au-delà du même seuil de fraîcheur
de 10 minutes, qu'il soit encore `pending` (référence `scheduled_at`) ou
`claimed`/`running` (référence `claimed_at`, déjà couvert ailleurs mais
reproduit ici pour que cette route seule suffise). Le job fantôme reste en
base en `failed` (trace d'audit), jamais supprimé. Un job `pending` après
10 minutes n'est jamais une course bénigne ici : le bouton qui déclenche
cet insert appelle justement `process-jobs` juste après dans le même clic
— un job encore `pending` passé ce délai n'a donc pu être traité par
personne.

Nettoyage immédiat appliqué en production le 2026-09-28 (SQL direct,
avant ce correctif) : job `ffbdb1f1-6fff-4548-ada0-164ced80a0df` marqué
`failed`, et `matches.match_datetime` du match 15 (BU13MN23, U13 M vs MEZE
LOUPIAN) corrigé à `2026-10-03T11:00:00Z` (13h Europe/Paris, confirmé par
une recherche FBI directe — la dérogation acceptée avait bien changé
l'heure sur FBI, mais le rapprochement calendrier bloqué depuis des heures
n'avait jamais pu répercuter ce changement dans `matches`).

## Timeout client sur `POST .../integrations/ffbb/sync` — "Synchronisation impossible"

Bug séparé constaté le même jour : le bouton "Relancer maintenant"
affichait "Synchronisation impossible. Réessaie." (message de repli côté
ball-manager-web pour toute exception qui n'est pas une `ApiError` — donc un timeout
client, jamais une vraie erreur métier renvoyée par l'API) alors que
`sync_runs.status` passait bien à `success` côté serveur. `syncFfbb`
(`integrations/ffbb/sync.ts`) traite chaque match du club un par un
(lecture + upsert + historique, plusieurs aller-retours Postgres par
match) — largement au-delà des 20s de timeout par défaut du client HTTP
ball-manager-web (`src/lib/api/client.ts`) dès que le club a plusieurs centaines de
matchs sur la saison. Même classe de bug déjà corrigée une première fois
pour `.../fbi/process-jobs` (voir son commentaire dans `src/lib/api/integrations.ts`
côté ball-manager-web).

**Corrigé côté ball-manager-web uniquement** (`triggerFfbbSync`, `src/lib/api/integrations.ts`) :
`timeoutMs: 280_000`, même valeur et même marge sous `maxDuration: 300`
(vercel.json) que `processFbiJobs`/`checkAllDerogations`. Aucun changement
requis côté ball-manager-back — la route elle-même a toujours réussi, seul
le client abandonnait trop tôt.

## Salle FBI tronquée qui écrasait notre libellé complet — "les matchs sont plus a clavel ou lido"

Constaté en production le 2026-09-28, en même temps que le job bloqué
ci-dessus : une fois le rapprochement calendrier débloqué, le club a
signalé que ses matchs à domicile n'apparaissaient plus dans les colonnes
"Gymnase Maurice Clavel"/"Complexe sportif du Lido" côté ball-manager-web (rendu
agenda par salle) — tous tombaient dans "Autre salle" alors que
`venue_raw_label` était correct en base au démarrage de la session.

Root cause à deux niveaux dans `venuesLikelyMatch`
(`integrations/fbi/schedule-reconciliation.ts`), tous les deux invisibles
en relisant le code car le texte affiché semble identique de part et
d'autre :

1. **Espaces insécables non normalisés.** Le texte de cellule scrapé du
   tableau FBI (`resultsTableGenericRows`) sépare les mots par des espaces
   INSÉCABLES (`&nbsp;`, U+00A0), jamais un espace ASCII normal comme le
   libellé FFBB. `normalize()`/`.toLowerCase()`/`.trim()` ne les touchent
   pas : `"GYMNASE MAURICE CLAVEL".includes("gymnase maurice
   clavel")` est `false` malgré un rendu visuel identique — un faux
   `mismatch` de salle sur QUASIMENT chaque rencontre.
2. **Salle tronquée par FBI lui-même.** FBI tronque les noms de salle trop
   longs dans son tableau, en ajoutant `...` littéral (jamais une
   troncature CSS invisible) : `"GYMNASE MAURICE C..."` pour `"GYMNASE
   MAURICE CLAVEL — 22 rue Maurice Clavel"`. Un préfixe tronqué n'est
   JAMAIS contenu dans notre libellé complet, ni l'inverse — `mismatch`
   détecté à tort, et la correction alors appliquée ÉCRASAIT notre libellé
   complet et correct par ce texte tronqué et inutilisable
   (`processReconcileScheduleJob` écrit `correction.venueRawLabel` tel
   quel). Reproduit sur ~20 rencontres du club pilote (matchs à domicile
   ET à l'extérieur) le jour même où le job bloqué a enfin pu tourner.

**Corrigé** (`normalizeVenueText`/`isTruncatedFbiSalle`,
`schedule-reconciliation.ts`) :
- Les espaces insécables sont convertis en espace normal avant toute
  comparaison (`String.fromCharCode(160)`, jamais l'échappement ` `
  dans une regex — un aller-retour JSON précédent avait déjà transformé un
  tel échappement en caractère brut par accident dans ce même fichier,
  piège à ne plus reproduire).
- Une salle FBI tronquée (se terminant par `...`) est comparée par
  PRÉFIXE à notre libellé complet plutôt que par `includes()` — un
  préfixe qui correspond au début de notre libellé n'est jamais un vrai
  changement de salle.
- Une salle FBI tronquée qui NE matche aucun de nos libellés connus (cas
  rare, préfixe réellement ambigu comme "HALLE DES SPORTS..." qui
  correspond à 3 salles différentes) reste signalée comme anomalie
  (`kind: "mismatch"`, visible pour vérification manuelle) mais
  `correction: null` — jamais une correction tronquée écrite
  automatiquement dans `matches.venue_raw_label`, quel que soit le
  résultat du rapprochement.

Nettoyage immédiat appliqué en production le 2026-09-28 (SQL direct,
avant ce correctif de code) : ~19 rencontres du club pilote reconstruites
sans ambiguïté à partir des libellés complets déjà connus par ailleurs en
base (les matchs à domicile Clavel/Lido identifiés sans ambiguïté via
`is_home = true`, les rencontres à l'extérieur via préfixe unique parmi
les libellés distincts déjà présents) — 1 seule rencontre à l'extérieur
laissée telle quelle (préfixe réellement ambigu entre 3 salles), sans
impact sur le rendu agenda du club (matchs à domicile uniquement). Elle se
corrigera automatiquement au prochain rapprochement calendrier réel
maintenant que le code ne peut plus réécrire de valeur tronquée.

## Visibilité du job FBI en cours (`activeJob`) — retour du club, 2026-09-29

Avec le relai GitHub Actions toutes les 15 minutes (voir docs/DEPLOYMENT.md
"Relai GitHub Actions..."), la garde "un seul job FBI actif par club à la
fois" (`claim_next_fbi_job(_for_club)`, fenêtre de fraîcheur 10 minutes,
voir plus haut) devient bien plus visible qu'avant : un job un peu long
(`check_all_derogations` sur un roster important, ~4-5 min en pratique)
bloque désormais régulièrement "Traiter les jobs FBI en attente" côté
club_admin — jamais un bug, juste la même protection anti-double-session
FBI qu'avant, simplement sollicitée plus souvent. Le club a signalé ne pas
pouvoir savoir POURQUOI le bouton affichait "rien en attente" alors qu'un
job venait d'être empilé.

`GET /v1/clubs/:clubId/integrations` expose désormais `fbi.activeJob`
(`FbiActiveJobDto | null`) — le job `claimed`/`running` le plus récent pour
ce club, **uniquement** s'il est dans la même fenêtre de fraîcheur de 10
minutes que la garde de claim elle-même (`findActiveFbiJob`,
`modules/integrations/routes.ts`) : un job plus vieux que ça a forcément
été tué par un timeout/crash, jamais affiché comme "en cours" (ce serait
mentir, et ça ne bloque déjà plus la file côté claim). Affiché côté ball-manager-web
en bandeau sur `/admin/integrations/fbi` ("En cours : ... — depuis X min").
Rendu côté serveur (page non auto-rafraîchie) : un rechargement de page
suffit à revoir l'état à jour, pas de polling client pour un simple
indicatif.

## Régression critique : la garde de fraîcheur 10 min avait disparu — retour du club, 2026-09-30

Retour du club le lendemain matin : "jai laissé tourner la nuit et jai tjr
pas les stats sur les matchs joués", alors que le relai GitHub Actions
(`fbi-frequent-sync.yml`, toutes les 15-20 min) avait tourné avec succès
48 fois cette nuit-là sans interruption. Investigation en base
(`fbi_jobs`) : 37 jobs `discover_emarque` et 1 `check_all_derogations`
étaient `pending` avec `claimed_at IS NULL` depuis 15h la veille — JAMAIS
réclamés, malgré des dizaines d'exécutions du cron. Un job
`reconcile_schedule` était resté bloqué en `status = 'claimed'` depuis
2026-09-30 01:30:34 (très probablement tué par un timeout Vercel, comme
dans le cas documenté en 20260924140000) — plus de 6h avant d'être
constaté.

Cause racine : la migration `20260927020000_fbi_jobs_priority_by_type.sql`
(ajout de la priorité de type dans l'`ORDER BY` de
`claim_next_fbi_job`/`claim_next_fbi_job_for_club`) a été écrite à partir
d'une copie de la fonction ANTÉRIEURE à
`20260924140000_fbi_jobs_claim_stale_recovery.sql` — la clause
`and claimed_at > now() - interval '10 minutes'` de la garde anti-blocage
a été perdue silencieusement dans le `create or replace function`, le
diff de cette migration se concentrant sur le nouvel `ORDER BY` sans que
personne ne remarque la régression sur la clause `WHERE`. Résultat : un
job `claimed`/`running` bloquait la file **indéfiniment** au lieu de 10
minutes maximum, pour n'importe quel club touché par un job tué par un
timeout Vercel.

Corrigé par `20260930080000_fbi_jobs_claim_priority_and_staleness_fix.sql`
— recombine les deux correctifs qui n'auraient jamais dû être perdus l'un
pour l'autre. Vérifié en production : dès application de la migration, le
prochain déclenchement du workflow a immédiatement réclamé un nouveau job
pour le club malgré le job fantôme de 01:30 toujours présent en base (trace
d'audit conservée, comme prévu). **Leçon pour toute future migration
touchant `claim_next_fbi_job`/`claim_next_fbi_job_for_club`** : repartir
de la dernière version en base (`pg_get_functiondef`), jamais d'un fichier
de migration antérieur pris isolément — un `create or replace function`
écrase silencieusement tout correctif qui n'est pas explicitement repris.

## Une connexion par passage + proxy à IP fixe — retour du club, 2026-10-06

Constaté le 2026-10-06 : la plupart des essais de l'heure échouaient sur « Page de connexion FBI injoignable » ou « Failed to fetch », alors que la connexion manuelle du club fonctionnait au même moment. Deux causes cumulées : une connexion complète (identifiant + mot de passe) par match, et des IP de sortie Vercel partagées et changeantes.

1. **Une connexion par passage** : `processDiscoverEmarqueJob` ouvre la session FBI une fois, puis réclame les autres jobs `discover_emarque` dus du même club via `claim_next_discover_job_in_session` (migration `20261006140000`) et les traite dans cette session. Pas de garde « un job actif par club » dans cette fonction : l'appelant détient déjà le job actif du club. Bornes : aucun nouveau match après 2 min, 10 s entre deux matchs (écran de recherche réutilisé, images/polices/médias bloqués pour limiter les connexions), arrêt de l'enchaînement à la première erreur FBI.
2. **Proxy à IP fixe** : `FBI_PROXY_URL` (format `http://utilisateur:motdepasse@hote:port`, ou `socks5://hote:port`) est passé à Chromium au lancement et à chaque contexte navigateur, ce qui couvre aussi `context.request`. Sans la variable, rien ne change. Utiliser une adresse FIXE dédiée (petit VPS avec un proxy type Squid/tinyproxy, ou un service « static IP »). Ne jamais utiliser un proxy rotatif : le compte du club apparaîtrait depuis des dizaines d'adresses. Les identifiants du proxy ne sont jamais journalisés. `HttpFbiClient` (test de connexion HTTP) n'utilise pas ce proxy.

## Proxy à IP fixe sur un VPS OVH — mise en place (2026-10-06)

Mesuré le 2026-10-06 : FBI ignore par moments les connexions venant de Vercel (`ERR_CONNECTION_TIMED_OUT` dès la page de connexion), alors qu'il répond en 0,6 s à une autre machine au même instant. Correctif : tout le trafic navigateur vers FBI passe par un VPS à adresse fixe (`FBI_PROXY_URL`, voir plus haut).

Installation sur le VPS (Ubuntu 22.04/24.04), une commande : `curl -fsSL https://raw.githubusercontent.com/anisfut1/ball-manager-back/main/ops/fbi-proxy/install.sh | sudo bash`.

Le script `ops/fbi-proxy/install.sh` :
- installe Squid avec authentification (mot de passe aléatoire généré sur le VPS, affiché uniquement à l'écran et gardé dans `/root/fbi-proxy-url.txt`) ;
- limite les destinations à `*.ffbb.com`, ports 80/443 : autre site → 403, sans mot de passe → 407 (vérifié avec Squid 6.14) ;
- coupe les journaux de connexion et les en-têtes `Via`/`X-Forwarded-For` ;
- ouvre le pare-feu sur SSH et le port du proxy seulement (port aléatoire 20000-60000) ;
- active les mises à jour de sécurité automatiques ;
- teste FBI à travers le proxy et affiche la valeur `FBI_PROXY_URL` à ajouter dans Vercel (projet club-manager-api, Production), puis redéployer.

Les identifiants FBI des clubs ne transitent jamais en clair par le VPS : Chrome ouvre un tunnel HTTPS de bout en bout jusqu'à FBI à travers le proxy.

**Sans passer par Vercel** : l'adresse du proxy peut aussi être enregistrée en base, `platform_settings` (clé `fbi_proxy_url`, migration `20261006170000`, service_role uniquement). Elle est lue à chaque lancement du navigateur : active au passage suivant, sans redéploiement. La variable `FBI_PROXY_URL`, si elle existe dans Vercel, reste prioritaire. Valeur invalide ou illisible : sortie directe, jamais un échec du job.

## FBI coupe l'adresse d'un navigateur annoncé « HeadlessChrome » (2026-10-06)

Constaté le 2026-10-06 : le VPS du proxy répondait en 0,44 s à l'installation (12:45). Après une session de l'app (connexion réussie à 13:03), FBI ne lui répondait plus du tout (3 essais `curl` à 25 s), alors que le navigateur du club, au même moment, chargeait FBI en 1 s. C'est la même signature que les coupures des adresses Vercel. Le Chrome sans écran s'annonçait `HeadlessChrome` (User-Agent et `Sec-CH-UA`), sous Linux, en anglais, avec `navigator.webdriver = true`.

Correctif : `fbiBrowserIdentity` (User-Agent et `Sec-CH-UA` d'un Chrome de bureau Windows de la même version que le moteur, `fr-FR`, fuseau Europe/Paris, fenêtre 1366×768) et `--disable-blink-features=AutomationControlled`. Vérifié sur un serveur local : en-têtes et `navigator` sans aucune trace « Headless » ni `webdriver`.

## Diagnostic et ménagement de l'accès FBI (2026-10-06)

Migration `20261006180000`, trois tables service_role uniquement :
- **`fbi_reachability_checks`** : à chaque passage du planificateur (`/internal/cron/fbi-reachability`, plus avant toute session dans `/internal/cron/fbi-jobs`), une requête `GET /fbi/connexion.fbi` sans identifiant, via le proxy s'il existe. Seuls 2xx/3xx comptent comme « FBI répond ». FBI injoignable : `/cron/fbi-jobs` saute le passage sans lancer Chrome ni se connecter, et les jobs gardent leur créneau. L'historique donne le début, la fin et la durée de chaque coupure.
- **`fbi_session_traces`** : chaque session navigateur, requête par requête. On y trouve le chemin sans paramètres ni `;jsessionid`, le type, le statut ou l'erreur réseau, la durée, et `ignoré` pour les images et polices bloquées volontairement. Jamais de corps, cookie ni identifiant. Sert à voir à quelle requête FBI coupe.
- **`fbi_saved_sessions`** : cookies de la session FBI chiffrés (AES-256-GCM, `club_id` en AAD), repris au passage suivant via `accueil.fbi`. Plus de déconnexion en fin de passage, d'où une connexion identifiant/mot de passe par jour au lieu d'une par passage. Une session de plus de 12 h n'est pas tentée. Si FBI coupe pendant un passage, la session est supprimée et la suivante repart d'une connexion neuve.

### Trace du 2026-10-06 14:21 : coupure quelques secondes après le premier téléchargement

Session en direct (adresse Vercel), avec la nouvelle identité Chrome. Connexion, accueil, recherche, puis téléchargement de la feuille (HTTP 200) à 8,6 s. Toutes les requêtes suivantes, dès 20,4 s, partent en `ERR_CONNECTION_TIMED_OUT`. Recoupé avec les coupures de la journée (10:44, 11:20, 13:03), le blocage tombe 10 à 20 s après la connexion, sur une session qui enchaîne les pages sans interaction. C'est la signature d'un pare-feu anti-robots comportemental. L'URL de téléchargement est bien celle du clic sur l'icône EM, confirmée en production.

Mesures :
- **rythme humain** (`humanPacing`) : pauses de 1,5 à 4,5 s entre les étapes, identifiants saisis caractère par caractère, mouvements de souris ;
- **un match par session** (`MAX_MATCHES_PER_SESSION = 1`), la session étant reprise au passage suivant sans nouvelle connexion ;
- **signature du pare-feu** dans `fbi_session_traces.fingerprint` : noms des cookies (jamais leur valeur) et en-têtes d'infrastructure `server`, `via`, `x-*`. Chaque fabricant (F5, Akamai, Imperva, Cloudflare…) laisse la sienne.

### Trace du 2026-10-06 14:45 : la coupure suit la connexion avec identifiants

Avec le rythme humain, la coupure tombe environ 9 s après `POST /fbi/identification.fbi`, avant toute recherche et tout téléchargement. Signature serveur : `server: Apache`, seul cookie `JSESSIONID`. Il n'y a donc pas de pare-feu anti-robots commercial, mais une règle réseau côté FFBB. Toutes les coupures de la journée suivent une connexion avec identifiants, et l'app en faisait jusqu'à plusieurs centaines par jour.

Correctif : plafond d'**une connexion identifiant/mot de passe toutes les 3 h par club** (`fbi_integration_status.last_credential_login_at`, migration `20261006200000`, enregistré juste avant l'envoi des identifiants). Entre deux connexions, seule la session conservée est reprise, et une coupure réseau ne la supprime plus. Sans session à reprendre et avec le plafond atteint, aucun accès à FBI : les jobs du club sont repoussés à l'heure autorisée. Si la session conservée est refusée par FBI alors que le plafond est atteint, elle est supprimée et les jobs sont repoussés de la même façon.

### 2026-10-06 soir : retour au fonctionnement « un match par passage, adresse Vercel, déconnexion »

Constats :
- 17:12 : le VPS est débloqué, environ 4 h après sa coupure de 13:03.
- 17:48 : à travers le VPS, première connexion avec identifiants depuis 3 h. La connexion réussit, puis l'adresse est coupée environ 8 s plus tard.
- 18:38 : la session de 17:49 est reprise depuis une adresse Vercel et FBI la refuse (page de connexion). Elle est liée à l'adresse d'origine, ou a expiré.

Les coupures existaient déjà fin septembre (`connect ETIMEDOUT` notés les 30/09 et 02/10). L'ancien fonctionnement, un match par invocation, chacune depuis une adresse Vercel souvent différente, les rendait invisibles. Le 06/10, trois changements les ont rendues bloquantes : la relecture de 19 matchs d'un coup, l'enchaînement de plusieurs matchs par session, et une adresse fixe (VPS, coupée environ 4 h).

Retenu : un match par passage (`MAX_MATCHES_PER_SESSION = 1`), en direct depuis Vercel, avec connexion puis déconnexion à chaque fois. On abandonne le plafond de 3 h et la reprise de session (la table `fbi_saved_sessions` reste, inutilisée). La vérification préalable de joignabilité, les délais maximum, le rythme humain et les traces restent en place. Le proxy (`platform_settings.fbi_proxy_url`) est retiré de la configuration. Le code reste prêt si la FFBB autorise un jour une adresse fixe.

### Fenêtre d'environ 8 s après la connexion : le parcours doit être rapide (2026-10-06, 19:07)

Comparaison des traces :
- **14:21, sans pauses** : connexion à 2,2 s, feuille téléchargée à 8,6 s, soit 6,4 s après la connexion. Succès.
- **14:45, 17:48 et 19:07, avec le rythme humain** : coupure 7,7 à 9,3 s après la connexion, avant même la recherche.

FBI laisse donc environ 8 s après chaque connexion avant de couper l'adresse. L'ancien parcours rapide finissait dans cette fenêtre, d'où le « ça marchait avant ». `humanPacing` est désactivé (option conservée dans `BrowserFbiClient`), et le parcours reste le plus court possible : connexion, recherche directe sans ouvrir l'écran, téléchargement.

### 2026-10-06 19:18 : coupure 0,4 s après la connexion, puis pause générale

Même sans pauses et depuis une adresse Vercel neuve (`connexion.fbi` en 200), l'adresse est coupée 0,4 s après `POST /fbi/identification.fbi`. Le premier fichier JS de l'accueil part déjà en `ERR_CONNECTION_TIMED_OUT`. Le délai avant coupure a diminué au fil de la journée : 6 à 9 s, puis 0,4 s. FBI semble réagir désormais immédiatement à toute connexion automatique de ce compte.

Interrupteur général : `platform_settings.fbi_paused_until`, une date ISO lue par `fbiPausedUntil`. Avant cette date, ni `/internal/cron/fbi-jobs` ni `POST .../fbi/process-jobs` ne se connectent à FBI. Il est posé au 2026-10-07 06:00 UTC pour laisser retomber la protection.

### Session « légère » + saison en cache (2026-10-07)

Trace du 2026-10-07 06:25 UTC : connexion à 2,1 s, puis les scripts de
l'accueil lancent 4 XHR (≈ 2 s chacune) ; la recherche ne part qu'après et le
téléchargement (10,2 s) tombe juste après la coupure de FBI (≈ 8 s après la
connexion). Correctifs, e-Marque uniquement :

- `BrowserFbiClient({ lightSession: true })` : une fois sur `accueil.fbi`,
  plus aucun script, style ni XHR de FBI (aborted). La recherche et le
  téléchargement passent par `fetch` depuis la page (type `fetch`, non bloqué).
- identifiant FBI de la saison en cache dans `platform_settings`
  (`fbi_season_id:<saison>`) : plus de lecture de l'écran de recherche
  (≈ 1,7 s). Rencontre introuvable avec l'identifiant en cache → cache vidé,
  relu sur FBI au passage suivant.

### Région Vercel : retour au fonctionnement d'avant le 30/09 (2026-10-07)

Historique `fbi_jobs` : jusqu'au 30/09 midi, 30+ connexions FBI par jour
(dérogations, calendrier, e-Marque) sans aucune coupure — les fonctions
tournaient alors sans région fixée (cle1/sfo1, États-Unis). Le 30/09 à
13:58, `vercel.json` a fixé la région sur Paris (`cdg1`) ; dès le 02/10, les
coupures `ETIMEDOUT` sont devenues systématiques. Même constat avec l'IP fixe
du VPS : FBI coupe une ADRESSE après une connexion automatisée, et une
adresse réutilisée d'un passage à l'autre reste coupée. Le 07/10 07:35, le
passage a réussi (feuille téléchargée 2,7 s après la connexion) mais l'appel
suivant, quelques secondes plus tard, trouvait déjà FBI coupé.

Correctif : région Paris retirée de `vercel.json` (fonctionnement d'avant).
Contrôle : l'IP de sortie est enregistrée à chaque contrôle de joignabilité
(`fbi_reachability_checks.egress_ip`) et dans chaque trace
(`fbi_session_traces.fingerprint.egressIp`).

### Écart minimal entre deux connexions FBI (2026-10-07)

Après le retrait de la région Paris : 07:46 connexion réussie depuis
13.221.x (feuille n°6 téléchargée), 07:47 nouvelle connexion depuis une AUTRE
adresse (44.192.x) — coupée 3 s après. Ce n'est donc pas (seulement)
l'adresse : ce sont les connexions rapprochées sur le compte. Jusqu'au 30/09
(aucune coupure), une connexion toutes les ~20 min ; depuis le 02/10, la
boucle du workflow (et les 6 essais de connexion d'affilée) en enchaînait
plusieurs par minute.

`FBI_MIN_LOGIN_GAP_MS` (12 min) : `/internal/cron/fbi-jobs` et
« Traiter les jobs » ne se connectent pas si la dernière connexion
(`fbi_integration_status.last_credential_login_at`, renseignée par tous les
types de job) date de moins de 12 min — réponse `skipped:
"connexion_fbi_recente"`.

### Statut des hypothèses et protocole de diagnostic (2026-10-07)

Les explications avancées dans les sections précédentes (« FBI coupe une
adresse », « connexions rapprochées sur le compte », région Paris…) sont des
**hypothèses** : aucune trace ne montre directement la cause d'une coupure.
Ce que les traces établissent : des requêtes vers FBI échouent en
`net::ERR_CONNECTION_TIMED_OUT` quelques secondes après une connexion avec
identifiants, et `ETIMEDOUT` sur la sonde suivante. Rien ne dit encore à
quelle couche (TCP, TLS, HTTP) ni pourquoi.

Outils ajoutés (production inchangée) :

- `src/integrations/fbi/layered-probe.ts` + `npm run fbi:probe` : sonde
  anonyme DNS → TCP → TLS → HTTP, chaque couche mesurée et classée séparément
  (ETIMEDOUT/ECONNRESET/refus TCP, échec TLS, 403/429/5xx, redirection vers
  l'identification). L'émetteur du certificat révèle un intermédiaire qui
  intercepte TLS (constaté depuis l'environnement de développement : passerelle
  de sortie, 403 qui ne vient PAS de FBI).
- `ops/fbi-session-worker/` : worker de test sur le VPS OVH, accès direct,
  navigateur et profil persistants, une seule connexion manuelle, aucune
  reconnexion automatique, expiration de session journalisée avec preuves
  (`fbi_probe_events`). Voir son README.

### Mesure du 07/10 08:37 UTC depuis le VPS OVH (15.235.62.135)

| Cible | Résultat |
|---|---|
| extranet.ffbb.com (178.170.19.77) :443 et :80 | **aucune réponse au SYN** (curl 28, nc « timed out ») |
| resultats.ffbb.com (178.170.19.78, même bloc) | TCP 0,17 s, HTTP 404 sur « / » |
| emarque.ffbb.com (178.170.19.84, même bloc) | TCP 0,15 s, HTTP 404 sur « / » |
| www.ffbb.com (autre infrastructure) | HTTP 200 |

`traceroute -T -p 443` vers .77 et .78 : chemin identique jusqu'à la
passerelle du bloc FFBB (178.170.19.6, saut 16). Vers .78 le saut suivant est
la cible ; vers .77, plus aucune réponse après 178.170.19.6. Le même
navigateur Chromium, piloté à la main sur le VPS, échoue en
`ERR_CONNECTION_TIMED_OUT` ; un PC personnel joint FBI au même moment.

Établi : DNS, routage OVH, transit et réseau de l'hébergeur FFBB
fonctionnent ; les paquets de 15.235.62.135 vers 178.170.19.77 sont
abandonnés sans réponse (ni RST ni ICMP) **sur le dernier segment** — serveur
FBI ou équipement de filtrage juste devant lui — et seulement pour cette
source. NON établi : ce qui a déclenché ce filtrage et sa durée
(chronologie seule : joignable 06/10 17:12–17:48, session automatisée à
17:48:47, injoignable de 18:13 jusqu'à la mesure).

Le worker sonde désormais aussi un hôte témoin (resultats.ffbb.com) à chaque
passage pour distinguer « chemin en panne » de « FBI seul injoignable ».
