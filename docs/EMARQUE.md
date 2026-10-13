# e-Marque — documents et statistiques de match

Pipeline d'enrichissement, dépendant de FBI (`FBI_ENHANCED`) — jamais requis
pour qu'un club fonctionne (voir `docs/FBI.md`, `docs/FFBB.md`).

## Vue d'ensemble

```
BrowserFbiClient.findEmarqueDocuments()  (§ discover, job "discover_emarque")
  → téléchargement (context.request.get(), cookies de session réutilisés)
  → Supabase Storage (bucket privé "emarque")               ← temporaire
  → match_documents (manifeste, un enregistrement par fichier)
  → job "parse_document" empilé
  → integrations/emarque/parser.ts (job "parse_document", cron emarque-parse)
  → extraction (participants, stats, officiels, OTM, avertissements qualité)
  → emarque_imports (ledger de cycle de vie du parse)
  → purge du fichier Storage (SUCCÈS uniquement, voir "Purge...")
```

## Découverte et téléchargement

Uniquement via `BrowserFbiClient` (voir `docs/FBI.md` — `HttpFbiClient`
échoue explicitement avec `EMARQUE_DOWNLOAD_ENDPOINT_NOT_CONFIRMED`, aucun
endpoint HTTP e-Marque n'a jamais été confirmé). Le job
`discover_emarque` (`src/jobs/process-discover-emarque.ts`) :

1. réclame un job via `claim_next_fbi_job` (voir `docs/JOBS.md`) ;
2. lance `launchServerlessBrowser()`, se connecte avec les identifiants du
   club (`getFbiCredentials`) ;
3. navigue jusqu'à la page e-Marque du match et énumère les documents
   disponibles (feuille de match, fiche de rencontre, ce qui est exposé —
   jamais un nom de document deviné, voir `selectors.ts`) ;
4. télécharge chaque document via `context.request.get()` (cookies de
   session réutilisés, jamais un `page.waitForEvent('download')`) ;
5. upload vers Storage puis enregistre une ligne `match_documents` par
   fichier, idempotente sur `sha256` — un même fichier retéléchargé
   n'écrit jamais deux fois la même donnée.
6. si aucun document n'est encore disponible (match pas encore feuille de
   match remplie côté FBI), le job repasse en attente avec le backoff
   "attente" (voir `docs/JOBS.md`), jamais une erreur.

## Stockage — convention de chemin figée

`storage/emarque-storage.ts` — jamais d'URL publique permanente, toujours
signée à la demande (`createEmarqueSignedUrl`, TTL court) et uniquement
après vérification du rôle (`docs/API.md` — route documents réservée à
`club_admin` pour le téléchargement) :

```
private/emarque/{club_id}/{season}/{match_id}/{type}-{sha256}.{ext}
```

`resolveSeasonLabel` calcule `{season}` de façon déterministe à partir de
la date du match (même règle que le reste de l'app — une saison FFBB ne
suit pas l'année civile). Bucket `emarque` : privé, sans policy Storage
`authenticated` — accès uniquement via le client service role, jamais
directement par un utilisateur (voir `docs/AUTH.md`).

## Purge après parsing — le fichier original n'est jamais conservé en cas de succès

Retour du club, 2026-09-29 : "je veux juste l'interpréter, récupérer les
stats et ensuite pas la stocker" — le séjour d'un document dans Storage
est volontairement TEMPORAIRE, le temps du parsing. Une fois le parsing
**réussi** (`jobs/parse-downloaded-documents.ts`, `status: 'imported'` ou
`'needs_review'` — voir "Nouvelle tentative..." pour la distinction),
`storage/emarque-storage.ts#deleteEmarqueFile` supprime le fichier et
`match_documents.purged_at` est renseigné.

**Sur un échec de parsing (`status: 'error'`), le fichier n'est PLUS purgé**
depuis le retour du club, même jour : "faut corriger les imports des
stats... sur tous les matchs, sans bug, sans interruption". Purger un
document en erreur détruisait la seule preuve exploitable pour diagnostiquer
un bug de parsing, et bloquait toute nouvelle tentative une fois le parseur
corrigé — voir "Nouvelle tentative des imports en erreur" ci-dessous, qui
réutilise ce fichier conservé.

- `match_documents` reste le manifeste (type, filename, discovered_at,
  sha256) même après purge — pour l'audit et pour ne jamais retélécharger
  un même fichier déjà traité (dédoublonnage sur sha256).
- `GET .../matches/:matchId/documents` renvoie `downloadUrl: null` et
  `purged: true` pour tout document purgé, quel que soit le rôle de
  l'appelant (`club_admin` inclus) — voir `modules/documents/shared.ts`.
- La purge est best-effort et jamais bloquante : un échec de suppression
  Storage est loggé mais ne remet jamais en cause l'import déjà persisté
  (les stats en base sont ce qui compte, pas le fichier).
- Ne concerne QUE `type = 'emarque_zip'` (ce que
  `parseDownloadedEmarqueDocuments` traite) : les documents séparés de
  repli (`match_sheet`/`summary`/`shot_chart`, téléchargés uniquement
  quand aucun ZIP n'est disponible) n'ont toujours aucun parseur dédié —
  les purger n'extrairait aucune statistique en échange, ce serait de la
  perte de donnée pure. Ils restent donc téléchargeables normalement.

## `match_documents` vs `emarque_imports`

Deux tables à deux responsabilités distinctes, jamais fusionnées :

- **`match_documents`** — manifeste, un enregistrement par fichier
  physique. Unique sur `(club_id, match_id, type, sha256)` : un nouveau
  téléchargement du même contenu ne duplique rien. `purged_at` distingue
  un fichier encore présent (`NULL`) d'un fichier déjà purgé (voir
  ci-dessus) — le manifeste, lui, n'est jamais supprimé (sauf suppression
  du match lui-même, cascade FK).
- **`emarque_imports`** — ledger du cycle de vie du *parsing* d'un
  document (`pending` → `parsed` / `failed`), avec ses propres
  avertissements de qualité.

## Parsing — pipeline OCR/PDF réutilisé sans changement

`integrations/emarque/parser.ts` orchestre, dans l'ordre : extraction du
texte structuré (extracteurs PDF texte natif puis, en repli, rastérisation
+ OCR via `pdf-raster-ocr-extractor.ts` + `tesseract.js` pour les scans),
normalisation (`normalizers/`), validation de schéma (`schemas/`), puis
persistance (`persist/`) :

- **participants** — joueurs de chaque équipe, numéros de licence si
  lisibles ;
- **statistiques** — par joueur (`PlayerMatchStatsDto`, voir
  `docs/API.md`) ;
- **officiels** — arbitres, table de marque ;
- **OTM** (Officiel de Table de Marque) — rôle spécifique tracé
  séparément des autres officiels ;
- **avertissements de qualité** (`quality/`) — un champ illisible ou
  incohérent (ex : score total qui ne correspond pas à la somme des points
  par joueur) est signalé, jamais silencieusement ignoré ni bloquant pour
  le reste de l'import.

Ce module est un report quasi verbatim de `src/server/emarque/**` de ball-manager-web
(voir `docs/MIGRATION.md`) — la logique d'extraction ne dépend d'aucune
API Next.js, seul l'import `@/types/database` → `@/db/types` a changé.

**Constaté en production le 2026-09-24 (rencontre n°1481) : le ZIP
e-Marque était bien téléchargé (§ "Vingt-neuvième déclenchement",
docs/FBI.md) mais son parsing échouait systématiquement sur Vercel** avec
`Setting up fake worker failed: Cannot find module
'/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'`. Cause :
`pdfjs-dist` (`legacy/build/pdf.mjs`) charge son worker via un
`import(this.workerSrc)` **dynamique et relatif**, invisible à l'analyse
statique de la pipeline de build Vercel (empaquetage esbuild d'une
Function unique, voir `docs/DEPLOYMENT.md`) — ce fichier n'est donc jamais
copié dans le déploiement. `pdfjs-dist` prévoit exactement ce cas :
`PDFWorker.#mainThreadWorkerMessageHandler` vérifie d'abord
`globalThis.pdfjsWorker?.WorkerMessageHandler` et ne tente l'import
dynamique QUE si ce global est absent. **Corrigé** dans
`pdfjs-loader.ts` : un import STATIQUE (littéral) du module worker,
correctement inclus par l'analyse statique, assigné à ce global avant
tout appel à `getDocument()` — l'import dynamique interne à `pdfjs-dist`
n'a alors jamais lieu.

**Deux bugs supplémentaires de la même famille, découverts juste après
(§ "Trentième déclenchement", docs/FBI.md, détail complet là-bas) :**
`tesseract.js-core` choisit lui aussi UN de ses 6 fichiers `.wasm` via un
`require()` dynamique basé sur une détection runtime du support SIMD —
jamais tracé statiquement non plus, et sans point d'extension équivalent
à `globalThis.pdfjsWorker` pour le contourner ; et le modèle de langue OCR
(`fra.traineddata`) n'avait en réalité **jamais été porté** depuis ball-manager-web
lors de la migration (`OCR_LANG_PATH` pointait vers un chemin Next.js de
l'ancien monolithe qui n'a jamais existé dans ce repo). Corrigé : le
fichier est maintenant vendorisé sous
`src/integrations/emarque/ocr-data/` (voir son `README.md`), et
`vercel.json` (`functions."api/index.ts".includeFiles`) force
l'inclusion de tout `node_modules/tesseract.js-core/` ainsi que de ce
dossier — les deux catégories de fichiers lus dynamiquement par `fs`
plutôt que par `require`/`import` statique.

**Une fois le pipeline de parsing débloqué, le premier vrai document
"résumé" de production a révélé deux bugs de calibration des zones OCR
dans `resume-layout.ts`/`parse-resume.ts` (§ "Trente-et-unième
déclenchement", docs/FBI.md, détail complet là-bas) :** un décalage de
ligne complet (le premier joueur de l'équipe LOCAUX disparaissait
entièrement d'un relevé "résumé"), et une lecture ligne-entière (numéro +
nom + temps + 7 statistiques en un seul appel OCR) où un seul chiffre mal
lu n'importe où dans la ligne décalait silencieusement toutes les
statistiques. Corrigé : coordonnées re-calibrées pixel par pixel contre le
document réel fourni par le club, chaque colonne lue par un appel OCR
séparé (`extractSingleInteger`), et une seconde passe OCR ciblée
(agrandissement + alphabet restreint aux chiffres) quand la première ne
trouve aucun chiffre sur une cellule censée être numérique — taux de
lecture correcte mesuré à 89,2 % sur cet échantillon (contre un pipeline
essentiellement inutilisable avant, données décalées ou valeurs absurdes
comme "101 points"). Premier test de ce module contre un vrai document
(`parser/parse-resume.test.ts`, fixture `__fixtures__/resume-1481.pdf`).

**`feuillematch-layout.ts` — l'unique source des numéros de licence —
n'avait jamais reçu la même recalibration (§ "Trente-quatrième
déclenchement", docs/FBI.md, détail complet là-bas) :** les colonnes
LICENCE/Nom de l'équipe VISITEURS tronquaient systématiquement le préfixe
à deux lettres de la licence (les deux encadrés d'équipe du gabarit FFBB
ont des largeurs de colonnes différentes, jamais mesurées séparément
avant), et la confusion OCR "O"/"0" à l'intérieur d'un numéro de licence
isolé était bidirectionnelle (un "0" réel lu "O" ET un "O" réel lu "0"
selon le cas) — corrigée par une correction positionnelle plutôt
qu'aveugle. Un bug de repli distinct affectait aussi la lecture des
entraîneurs (`break` sur le premier trouvé, `role` toujours codé en dur).
Validé à 15/15 numéros de licence exacts contre la liste fournie par le
club (rencontre n°1481), nouveau test contre le document réel
(`parser/parse-feuillematch.test.ts`, fixture
`__fixtures__/feuillematch-1481.pdf`). Débloque la demande du club de
relier chaque joueur/joueuse à sa licence FFBB ; scope explicitement
limité aux licencié(e)s du club exploitant le compte FBI, jamais ceux du
club adverse d'une rencontre.

## Correctifs d'import — retour du club, 2026-09-29 ("les imports des stats ça marche pas")

Constaté en production sur la saison 2026-2027 : 0/40 licences lues (contre
15/15 lors de la calibration initiale de `feuillematch-layout.ts`, voir
ci-dessus), et un match (`U13 M vs Frontignan`, rencontre n°3) importé avec
une composition/des statistiques manifestement incomplètes malgré un statut
apparent de succès. Trois bugs distincts, corrigés ensemble :

1. **`extractIsolatedLicenseNumber` (`normalizers/text-fields.ts`) trop
   stricte** — ne retirait que les espaces avant de vérifier une longueur
   de 8 caractères exactement. Tout bruit OCR non-alphanumérique de bordure
   de tableau (`.`, `-`, `|`, `_`...) faisait donc systématiquement échouer
   cette vérification, quelle que soit la qualité de la lecture du numéro
   lui-même. Corrigé : tout caractère hors `[A-Z0-9]` est retiré avant le
   contrôle de longueur — un numéro de licence FFBB n'en contient jamais,
   ce retrait ne risque donc aucune fausse lecture.
2. **`insertPlayerStats` (`persist/persist-emarque-match.ts`) faisait
   échouer tout l'import sur un doublon** — deux lignes "résumé" résolues
   vers le même participant (`${teamSide}:${jerseyNumber}`) violaient la
   contrainte unique `player_match_stats_participant_id_key`, ce qui
   remontait jusqu'à faire échouer la totalité du match, y compris les
   lignes par ailleurs correctement lues. Corrigé : la première ligne pour
   un participant donné est conservée, toute ligne suivante pour ce même
   participant est ignorée (loguée, jamais silencieuse).
3. **`persistEmarqueMatchData` ne nettoyait jamais les écritures partielles
   en cas d'échec en cours de traitement** — un match marqué `error`
   affichait quand même une composition/des statistiques incomplètes,
   jamais annoncées comme telles (exactement le symptôme rapporté par le
   club). Corrigé : le `catch` supprime désormais explicitement
   `match_participants`/`match_coaches`/`match_officials`/
   `match_table_officials`/`player_match_stats` pour ce match avant de
   marquer l'import en erreur — un match `error` n'affiche plus jamais de
   données partielles.

## Détection dynamique des tableaux — retour du club, 2026-09-29 (second signalement, avec document réel à l'appui)

Malgré les trois correctifs ci-dessus, un match (rencontre n°6, U15M1 vs
Agde Basket, 12 joueurs LOCAUX + 8 VISITEURS) affichait encore une
composition et des statistiques totalement méconnaissables — des noms
("LEO SIMON", "METROP Basile") qui ne correspondent à RIEN dans le document
réel fourni par le club en comparaison. Cause racine, commune à
`resume-layout.ts` ET `feuillematch-layout.ts` : ces deux tableaux
(LOCAUX/VISITEURS) étaient lus à des coordonnées Y **FIXES**, calibrées
pixel par pixel contre UN SEUL document réel (rencontre n°1481 — 8 joueurs
LOCAUX, 7 VISITEURS). Sur le gabarit FFBB, le tableau VISITEURS est imprimé
**après** le tableau LOCAUX : sa position verticale dépend donc directement
du nombre de lignes LOCAUX au-dessus. Un effectif LOCAUX différent de 8
(la quasi-totalité des matchs réels) décalait donc TOUJOURS la lecture de
l'équipe VISITEURS dans du texte sans rapport — jamais une erreur détectée,
juste une lecture silencieusement fausse.

**Corrigé par détection structurelle plutôt qu'un calibrage plus précis** —
`layout/table-structure.ts` (`locateTeamTables`) repère la position de
chaque tableau PAR DOCUMENT, à partir des lignes de grille horizontales
détectées sur le rendu (`DocumentExtractor#detectHorizontalLines`, nouvelle
méthode implémentée dans `pdf-raster-ocr-extractor.ts`) : une ligne d'EN-TÊTE
de colonnes est systématiquement ~1,5× plus haute qu'une ligne de données
(mesuré sur deux documents réels de compétitions différentes) — ce ratio,
jamais un effectif supposé, sert à repérer où commence chaque tableau. Les
coordonnées X (colonnes) restent calibrées comme avant, seule la position Y
de chaque ligne est désormais dynamique. `resume-layout.ts` et
`feuillematch-layout.ts` n'exposent plus de `rowTop`/`rowHeight` fixes.

Un document dont la structure n'est pas reconnue (moins de 2 tableaux
détectés) retourne un effectif VIDE plutôt qu'une lecture au hasard
(ARCHITECTURE.md §22) — signalé par un nouvel avertissement qualité
`NO_PLAYERS_EXTRACTED` (sévérité `error`, force `needs_review`) :
auparavant, un tel échec silencieux aurait pu passer pour un import
"réussi" sans aucun joueur.

Validé contre DEUX documents réels de compétitions différentes (jamais un
seul, précisément parce que c'est la variation entre eux qui avait révélé
le bug) : `resume-1481.pdf`/`feuillematch-1481.pdf` (8+7 joueurs, régression)
et le nouveau `resume-agde-6.pdf` (12+8 joueurs, fourni directement par le
club) — `parser/parse-resume.test.ts`, `parser/parse-feuillematch.test.ts`.

## Nouvelle tentative des imports en erreur (`retryFailedEmarqueImports`)

Avant ce correctif, aucun mécanisme ne relançait un match resté
`emarque_status: 'error'` — le cron `discover_emarque` ne reprend que
`pending`/`waiting_for_emarque` (voir "Découverte et téléchargement"
ci-dessus), donc un match en erreur restait bloqué indéfiniment.

```
POST /v1/platform/maintenance/retry-failed-emarque-imports   (platform_admin)
```

Pour chaque match `emarque_status = 'error'` dont le document e-Marque
(`type = 'emarque_zip'`, `status = 'error'`) n'est **pas encore purgé**
(voir "Purge après parsing" ci-dessus — un match `error` n'est justement
plus jamais purgé) :

1. nettoie les données partielles déjà en base (cas d'un import en erreur
   persisté AVANT le correctif de rollback ci-dessus) ;
2. supprime la ligne `emarque_imports` correspondante — la contrainte
   UNIQUE `(club_id, file_hash)` ferait sinon revenir `alreadyImported` sans
   rien retraiter ;
3. repasse `match_documents.status` à `'downloaded'` — le prochain passage
   de `parseDownloadedEmarqueDocuments` (cron `emarque-parse`) reprend alors
   ce document tel quel, **sans nouveau téléchargement FBI** ;
4. repasse `matches.emarque_status` à `'downloaded'`.

**Ne couvre jamais `needs_review`** : ce statut correspond à un import qui
a RÉUSSI (avec un avertissement qualité), dont le fichier a donc déjà été
purgé sur le chemin de succès — le relancer nécessiterait un nouveau
téléchargement FBI (`discover_emarque`), hors périmètre de cette route qui
réutilise volontairement le fichier déjà en Storage.

## Cron

`GET /internal/cron/emarque-parse` (toutes les 10 minutes, voir
`vercel.json`) traite un petit lot de documents en attente de parsing —
jamais tous en une seule invocation (même philosophie que les crons FFBB
et FBI, voir `docs/JOBS.md`).

## API frontend (gaps 5 et 6 résolus)

Liste tenant-scopée des imports e-Marque, filtrée et paginée (défaut 20,
max 100, jamais un dump complet) :

```
GET /v1/clubs/:clubId/emarque-imports?matchId=&status=&from=&to=&limit=&offset=
```

Réponse : `EmarqueImportDto[]` (`id`, `matchId`, `status`, `source`,
`parserVersion`, `discoveredAt`/`downloadedAt`/`importedAt`,
`qualityWarnings`, `lastError`, `attemptCount`, `nextAttemptAt`) — jamais
de chemin de stockage interne, de stack trace, ni le contenu brut d'un
ZIP/PDF. Le détail d'un match (`GET .../matches/:matchId`) expose le même
niveau de détail e-Marque directement dans sa section `emarque`.

`lastError` est toujours **assaini** (`integrations/emarque/sanitize-error.ts`) :
`emarque_imports.last_error`/`match_documents.last_error` peuvent contenir
un message d'exception brut (`error.message` capturé tel quel côté job,
voir `src/jobs/parse-downloaded-documents.ts`) — jamais renvoyé au
frontend tel quel, uniquement une classification générique
(`SanitizedErrorDto { code, message }`) sûre à afficher.

`IssueDto` (`GET /v1/clubs/:clubId/issues`) est enrichi de la même
philosophie : `type`/`severity`/`status`, un `message` utilisateur séparé
de `technicalCode` (machine), `matchId`, `integration`, `qualityWarnings`,
`createdAt`/`resolvedAt` — jamais une erreur interne brute exposée telle
quelle. Exemple :

```json
{ "technicalCode": "EMARQUE_SCORE_MISMATCH", "message": "Le score e-Marque ne correspond pas au score FFBB." }
```

## Licenciés (voir docs/LICENCIES.md)

Chaque joueur·se importé·e depuis "feuillematch" (côté CLUB, jamais
l'adversaire) est désormais automatiquement rattaché·e à un `licencies` —
créé à la volée par `persist-emarque-match.ts#insertParticipants` si
aucun n'existe encore pour son numéro de licence. C'était le chaînon
manquant de la demande du club ("associer chaque joueur à sa licence") :
`licencies` n'a jamais été peuplé ailleurs dans ce backend, donc
`licencie_id` restait toujours `null` malgré des numéros de licence
correctement lus. Détail complet (scope, permissions, fiche joueur) :
`docs/LICENCIES.md`.

## Ce qui n'est PAS fait

Pas de module dérogations/tables de marque au sens FBI authentifié
au-delà de l'extension prévue mais non implémentée mentionnée dans
`docs/FBI.md` (`listDerogations()`).

## Processus de récupération des statistiques (déterministe, 2026-10-06)

Retour du club : « je veux un process clair, où je suis sûr que les matchs seront à jour avec les stats, dans l'ordre, pas au hasard ». Une seule règle, pour tous les matchs :

| Étape | Règle |
|---|---|
| Déclenchement | Synchro FFBB toutes les 15 min (GitHub Actions) : un match passé « joué » entre dans la file e-Marque. |
| Calendrier des essais | Fenêtre ouverte à la fin du match (début + 2 h) : un essai toutes les 15 min pendant 6 h, puis toutes les heures jusqu'à 48 h, puis toutes les 6 h jusqu'à 7 jours (`nextEmarqueCheckAt`, `src/jobs/backoff.ts`). Jamais dépendant du nombre d'essais. |
| Panne FBI | Jamais d'abandon : essai suivant au prochain créneau. Seuls des identifiants FBI refusés arrêtent (à corriger dans Intégrations). |
| Ordre | Les feuilles e-Marque passent avant les autres vérifications FBI, du match le plus ancien au plus récent (`claim_next_fbi_job`). |
| Connexion FBI | UNE connexion par passage et par club : après le premier match, les autres matchs dus du club sont traités dans la même session (`claim_next_discover_job_in_session`), 2 min max pour démarrer un nouveau match, 10 s entre deux matchs, écran de recherche réutilisé, images et polices FBI jamais téléchargées. Une erreur FBI en cours de session arrête l'enchaînement : les matchs restants gardent leur créneau. Connexion FBI échouée : tous les matchs dus du club passent au créneau suivant (une seule tentative de connexion par passage). |
| Délais | Chaque requête vers FBI a un délai maximum (20 à 40 s), chaque match 120 s au plus : au-delà, créneau suivant. L'issue est toujours enregistrée avant la coupure Vercel (300 s) : jamais un match laissé « en cours ». Erreur ou délai dépassé : les autres matchs dus du club passent aussi au créneau suivant. |
| Proxy à IP fixe (optionnel) | `FBI_PROXY_URL` (Vercel) : tout le trafic navigateur vers FBI sort par cette adresse fixe au lieu des IP Vercel, partagées et changeantes. Jamais un proxy « rotatif ». |
| Lecture | Téléchargement puis lecture dans le même passage du planificateur. |
| Contrôles avant publication | Score de la feuille = score FFBB ; somme des points des joueurs de chaque équipe = score de l'équipe ; maillots uniques (`computeStatsConsistencyWarnings`). Échec → « à vérifier » (`needs_review`) : rien n'est publié au public, la raison est visible par l'admin. |
| Fin de fenêtre | 7 jours sans feuille → « pas de feuille e-Marque » (`not_available`), état final. |
| Relance manuelle | Admin → Suivi des stats → Relancer : relecture de la feuille conservée si elle existe, sinon essai FBI au prochain passage puis nouvelle fenêtre de 7 jours (`fbi_jobs.window_start`). |
| Conservation | Feuille gardée 30 jours après téléchargement, puis supprimée automatiquement (20 max par passage). Saison en cours uniquement. |
| Parseur amélioré | Les feuilles conservées de la saison lues par une version plus ancienne sont relues automatiquement, 2 par passage, sans FBI. Lecture : 3 feuilles max par appel, matchs les plus récents d'abord. |

Suivi : `GET /v1/clubs/:clubId/emarque-tracking` (état clair par match joué, prochain essai, résultat du dernier essai, problèmes), `POST .../:matchId/relaunch`.
