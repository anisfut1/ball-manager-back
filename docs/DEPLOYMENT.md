# Déploiement — Vercel + Supabase, rien d'autre

Aucune infrastructure externe. Pas de Railway, Render, Fly.io, ni aucun
serveur à provisionner (§ contrainte fondamentale de cette migration).

## Prérequis

- Un projet Vercel (import direct du repository GitHub
  `ball-manager-back`, sans étape supplémentaire).
- **Le même projet Supabase que le frontend `ball-manager-web`** — pas un nouveau
  projet. La séparation introduite par cette migration concerne le code,
  jamais les données (§ instruction explicite de la demande).
- Les migrations `supabase/migrations/` de ce repository doivent être
  appliquées sur ce projet Supabase (via `supabase db push` ou la CLI
  habituelle) — elles reprennent l'historique complet depuis ball-manager-web, jamais
  fusionnées en un seul fichier (voir `docs/MIGRATION.md`).

## Étapes

1. **Importer** le repository dans Vercel (Nouveau projet → sélectionner
   `ball-manager-back`). Aucune configuration de build particulière n'est
   requise au-delà de ce que `vercel.json` fournit déjà.
2. **Renseigner les variables d'environnement** (voir la liste complète
   ci-dessous et `.env.example`) dans les réglages du projet Vercel —
   jamais committées.
3. **Déployer**. Vercel construit `api/index.ts` comme Function unique
   (voir `vercel.json` — `rewrites` route tout vers `/api`,
   `functions."api/index.ts".maxDuration: 300`) et active automatiquement
   les 4 crons déclarés dans `vercel.json`.
4. **Configurer `FRONTEND_ORIGINS`** avec l'URL du déploiement Vercel du
   frontend ball-manager-web (jamais de wildcard, voir `docs/API.md`).
5. **Vérifier** `GET /health` (sans authentification) puis
   `GET /openapi.json`.

`npm run build` en local est une vérification de compilation uniquement
(`tsc --noEmit` + vérification que `dist/` se génère) — Vercel bundle
`api/index.ts` lui-même avec son propre pipeline (esbuild) au moment du
déploiement ; le `dist/` local n'est jamais déployé tel quel (voir
`.gitignore`).

**`"framework": null` dans `vercel.json` est délibéré, ne pas l'enlever.**
Sans lui, Vercel détecte automatiquement ce projet comme "Hono" et
applique un traitement spécifique à ce preset qui, en pratique (constaté
au premier déploiement réel), **désactive l'empaquetage esbuild normal** :
chaque fichier `.ts` est alors transpilé et exécuté individuellement au
lieu d'être bundlé en un seul fichier. Deux conséquences constatées :
1. Les imports relatifs multi-fichiers restent corrects, mais le nombre
   de lectures/transpilations disque au démarrage à froid grimpe avec la
   taille du projet — au point de dépasser le délai d'expiration des
   appels réseau internes (voir `src/db/client.ts`) et de faire échouer
   silencieusement toute requête pendant un démarrage à froid.
2. Avant le passage à des imports relatifs (voir l'historique Git), les
   alias `@/...` (résolus uniquement par TypeScript/tsconfig, jamais par
   Node natif) faisaient carrément planter chaque requête avec
   `ERR_MODULE_NOT_FOUND`.

`"framework": null` force Vercel à traiter `api/index.ts` comme une
Function Node.js standard (empaquetage esbuild réel), ce qui corrige les
deux.

**Deux conséquences directes de `"framework": null`, déjà traitées :**
- Sans preset détecté, Vercel invoque la Function à l'ancienne
  (`(req: IncomingMessage, res: ServerResponse)`) plutôt qu'avec un objet
  `Request` standard Web tout fait — d'où `api/index.ts` qui utilise
  `getRequestListener` de `@hono/node-server`, pas `handle` de
  `hono/vercel` (qui suppose ce `Request` déjà construit).
- Vercel attend par défaut un dossier de sortie statique nommé `public`
  après le build ("Other"/générique) et fait échouer le déploiement s'il
  est absent — d'où le dossier `public/` (vide, un simple `README.md`
  explicatif) : jamais servi tel quel, `rewrites` route tout vers l'API.

**`functions."api/index.ts".includeFiles` — nécessaire pour tout fichier
lu dynamiquement via `fs` (jamais `require`/`import`).** Constaté en
production (§ "Trentième déclenchement", docs/FBI.md) : ni l'empaquetage
esbuild ni le traçage de fichiers de Vercel ne suivent un `fs.readFileSync`
(ou un `require()`/`import()` dont la cible est calculée au runtime, ex :
`tesseract.js-core` qui choisit sa variante WASM selon le support SIMD
détecté à l'exécution) — seuls les `require`/`import` avec une chaîne
LITTÉRALE, résolus par l'analyse statique du bundler, sont automatiquement
inclus. `includeFiles` force l'inclusion physique de tout le reste :
aujourd'hui `node_modules/tesseract.js-core/**` (les 6 variantes WASM
possibles) et `src/integrations/emarque/ocr-data/**` (le modèle de langue
OCR vendorisé). Tout futur ajout d'un fichier lu par `fs` (nouveau modèle,
nouvelle dépendance native) doit être ajouté à ce glob — sinon il
fonctionnera en local (où `node_modules`/`src` sont intégralement
présents) mais échouera silencieusement en production avec `ENOENT`.

## Variables d'environnement requises

| Variable | Rôle |
|---|---|
| `SUPABASE_URL` | URL du projet Supabase (le même que ball-manager-web) |
| `SUPABASE_ANON_KEY` | Clé anonyme — utilisée avec le JWT utilisateur pour les requêtes "au nom de l'utilisateur" (voir `docs/AUTH.md`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé service role — jamais exposée au frontend, utilisée uniquement pour les tables sans policy `authenticated` et Storage |
| `FBI_CREDENTIALS_ENCRYPTION_KEY` | Clé AES-256-GCM (32 octets) pour `fbi_credentials` |
| `CRON_SECRET` | Secret partagé (min. 16 caractères) protégeant `/internal/*` — Vercel Cron l'envoie automatiquement en `Authorization: Bearer` pour ses propres appels programmés |
| `FRONTEND_ORIGINS` | Liste d'origines autorisées en CORS, séparées par des virgules |
| `BROWSER_FBI_ENABLED` | `true`/`false` (défaut `false`) — active `BrowserFbiClient` (voir `docs/FBI.md`) |
| `FBI_BASE_URL` | URL de base FBI (a une valeur par défaut, surchargeable) |
| `FBI_PROXY_URL` | Optionnel — proxy à IP fixe pour le trafic navigateur vers FBI (`http://utilisateur:motdepasse@hote:port`). Voir docs/FBI.md « Proxy à IP fixe ». |

Validées au démarrage par `src/config/env.ts` (zod) — une variable
manquante ou invalide fait échouer le démarrage immédiatement plutôt
qu'en cours de requête.

## Crons (déjà déclarés dans `vercel.json`)

```json
"crons": [
  { "path": "/internal/cron/ffbb", "schedule": "0 3 * * *" },
  { "path": "/internal/cron/fbi-enqueue", "schedule": "15 3 * * *" },
  { "path": "/internal/cron/fbi-jobs", "schedule": "30 3 * * *" },
  { "path": "/internal/cron/emarque-parse", "schedule": "45 3 * * *" }
]
```

Rien à configurer côté Vercel au-delà de l'import — les crons sont créés
automatiquement au déploiement à partir de ce fichier.

**Plan Vercel Hobby (gratuit) : limité à un cron par jour maximum.** Les
fréquences d'origine (`*/15 * * * *`, `0 * * * *`, `*/5 * * * *`,
`*/10 * * * *`) font échouer le déploiement sur ce plan ("Hobby accounts
are limited to daily cron jobs"). Les 4 crons ci-dessus tournent donc une
seule fois par jour, décalés de 15 minutes chacun pour respecter l'ordre
du pipeline (FFBB sync → empile les jobs FBI → les traite → parse les
documents téléchargés) — la synchronisation reste fonctionnelle, mais les
nouveaux matchs/scores/documents e-Marque n'apparaissent qu'une fois par
jour au lieu de quasi temps réel. Sur un plan Pro (ou supérieur), remettre
les fréquences d'origine ci-dessus (en commentaire) pour retrouver une
synchronisation toutes les 5 à 15 minutes.

### Relai GitHub Actions pour `fbi-enqueue`/`fbi-jobs`/`emarque-parse` (`*/15 * * * *`)

Retour du club, 2026-09-29 : une fois par jour est bien trop lent pour les
dérogations ("faut le faire tres souvent par jour"), pour rattraper
plusieurs matchs d'un même weekend au rythme d'UN SEUL job traité par
invocation (`JOB_BATCH_SIZE = 1`, voir `src/api/internal/index.ts` —
constaté le 2026-09-29 : 9 matchs en attente auraient mis 9 jours à se
vider au rythme du cron Vercel seul), et pour que les statistiques
apparaissent peu après le téléchargement du document plutôt qu'à un horaire
fixe ("le parsing doit etre appelé si des emarque ont été téléchargés").
`.github/workflows/fbi-frequent-sync.yml` (dans ce repo, gratuit, hors
Vercel) appelle successivement `/internal/cron/fbi-enqueue`,
`/internal/cron/fbi-jobs` PUIS `/internal/cron/emarque-parse` toutes les
15 minutes — la fréquence prévue à l'origine avant la contrainte du plan
Hobby. Aucun risque à appeler `emarque-parse` aussi souvent : pas de
Playwright/login FBI ici, uniquement de l'OCR/PDF local sur ce qui est déjà
téléchargé.

Requiert un secret de dépôt GitHub `CRON_SECRET` (Settings → Secrets and
variables → Actions), IDENTIQUE à la variable d'environnement `CRON_SECRET`
déjà configurée côté Vercel — jamais généré séparément, sinon les appels
échouent en 401. Les 4 crons `vercel.json` restent en place tels quels
(inoffensifs à laisser tourner en double, chaque route étant idempotente) —
ce workflow est un RELAI plus fréquent, jamais un remplacement.

## CI

Workflow `.github/workflows/ci.yml`, lancé sur chaque `pull_request` vers `main` et sur chaque `push` sur `main` (un nouveau commit annule le run en cours de la même branche). Permissions : `contents: read`, Node 24 écrit dans le workflow (pas de `.nvmrc` ni de champ `engines`, pour ne pas changer la version de Node de Vercel). Deux jobs :

- **`verify`** : `npm ci --ignore-scripts --no-audit --no-fund --loglevel=http` (trace HTTP de chaque requête, étape limitée à 5 minutes pour qu'un blocage échoue vite avec la dernière requête visible dans le log), lint (`--max-warnings 0`), typecheck, tests, build, puis `npm audit --omit=dev --audit-level=high`.
- **`gitleaks`** : scan de tout l'historique (`fetch-depth: 0`, `--all`), valeurs masquées (`--redact`). Un secret trouvé fait échouer le job.

`.github/workflows/fbi-frequent-sync.yml` (relai du cron) est à part : `permissions: {}`, il n'utilise que `curl` et le secret `CRON_SECRET`.

**Test exclu.** `src/integrations/fbi/browser-client.test.ts` est exclu par la ligne de commande (`npm test -- --exclude …`) : il lance Chromium, absent du runner, et contient une vraie assertion en échec. Ce test sera traité dans un lot dédié ; retirer alors l'option `--exclude` de `ci.yml`. C'est la seule exclusion.

**Valeurs factices.** Le bloc `env:` du job `verify` contient des valeurs factices (domaine `.invalid`, clé AES de 32 octets identiques) pour satisfaire `src/config/env.ts`. Aucun secret réel n'est utilisé en CI, il ne faut jamais en ajouter.

**Mettre à jour gitleaks.** La version et la somme SHA-256 de l'archive `linux_x64` sont codées en dur dans le job `gitleaks` (`GITLEAKS_VERSION`, `GITLEAKS_SHA256`). Pour changer de version : télécharger `gitleaks_<version>_linux_x64.tar.gz` et `gitleaks_<version>_checksums.txt` depuis la release officielle, calculer `sha256sum` de l'archive, vérifier qu'elle est identique à la ligne du fichier `checksums.txt`, puis reporter les deux valeurs dans `ci.yml`. `.gitleaksignore` contient deux empreintes de l'historique (jetons de test e-Marque, commit `2ef3ce0099`) ; n'y ajouter que des empreintes exactes, jamais de chemin ni de regex.

**Dependabot.** `.github/dependabot.yml` ouvre chaque lundi des PR vers `main` pour `npm` (préfixe `chore(deps)`) et `github-actions` (préfixe `ci`), 5 PR ouvertes au plus par écosystème. Les mises à jour patch et minor sont groupées en une PR ; chaque majeure a sa PR. Traitement : attendre que `verify` et `gitleaks` passent, lire le changelog pour une majeure, fusionner ; en cas d'échec, corriger sur la branche de la PR ou la fermer. Les actions restent épinglées par SHA : Dependabot met à jour le SHA et le commentaire `# vX`.

## Durcissement HTTP

- **Débit.** `POST /v1/account/password-reset` : 1 demande par adresse et par minute (silencieux), et **5 demandes par IP et par 15 minutes**, au-delà 429 `{ error: { code: "RATE_LIMITED" } }` avec `Retry-After` (secondes restantes). La réponse ne dépend jamais de l'existence du compte. Les limiteurs sont en mémoire, par instance, avec un plafond de 10 000 entrées : les expirées partent d'abord, puis les plus anciennes même actives (voir `src/security/`).
- **Taille des corps.** 1 Mio pour toutes les routes ; seule `POST /v1/clubs/:clubId/licencies/import/file` (export Excel FBI) accepte 5 Mio + 64 Kio. Au-delà : 413 `{ error: { code: "PAYLOAD_TOO_LARGE" } }`, avant toute lecture du corps. Vercel refuse de toute façon les corps de plus de 4,5 Mo.
- **En-têtes.** Toutes les réponses : `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. `/docs` a une CSP plus large (Swagger UI charge ses fichiers depuis `cdn.jsdelivr.net`). Les en-têtes CORS sont posés avant et ne changent pas.
- **`/docs` et `/openapi.json`.** `/docs` (Swagger UI) répond 404 quand `VERCEL_ENV` vaut `production`, 200 en preview et en local. `/openapi.json` reste public partout : `ball-manager-app/scripts/generate-api-types.mjs` le télécharge en production. À cacher après avoir changé ce script (le test `src/app-docs.test.ts` le rappelle).

## Ce que ce déploiement NE fait PAS

- Ne crée pas de nouveau projet Supabase.
- Ne provisionne rien en dehors de Vercel (pas de VM, pas de container
  long-running, pas de queue externe).
- Le frontend ball-manager-web n'est pas concerné par ce déploiement — c'est un
  projet Vercel strictement séparé (§ "Ne modifie PAS encore le
  frontend").
