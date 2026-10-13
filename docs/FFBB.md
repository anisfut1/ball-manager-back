# FFBB — intégration de base (obligatoire)

Chaque club fonctionne avec UNIQUEMENT FFBB (mode `PUBLIC_ONLY`) : calendrier,
équipes, compétitions, dates/horaires/salles, adversaires, scores,
classements si disponibles. Aucune erreur parce que FBI est absent — voir
`docs/FBI.md`.

## Composants

- `integrations/ffbb/directus-client.ts` — client HTTP bas niveau vers
  l'API publique Directus de FFBB (`api.ffbb.app`), jeton public mis en
  cache en mémoire (15 min).
- `integrations/ffbb/public-provider.ts` (`FfbbPublicProvider`) — normalise
  les formes brutes Directus en DTO stables (`NormalizedMatch`,
  `NormalizedCompetition`, ...). Le reste de l'app ne connaît jamais le
  format brut FFBB.
- `integrations/ffbb/mapping.ts` — fonctions pures : `NormalizedMatch` →
  ligne `matches` upsertable, détection de changement de champ suivi
  (`diffTrackedFields`), déclenchement e-Marque (`shouldRequestEmarque`).
- `integrations/ffbb/sync.ts` (`syncFfbb`) — orchestration pour UN club :
  upsert idempotent (jamais de `DELETE`+`INSERT`), historise chaque
  changement détecté dans `match_change_history`.
- `integrations/ffbb/scheduler.ts` (`syncAllDueClubs`) — sélectionne les
  clubs dus (`ffbb_enabled = true AND next_sync_at <= now()`), verrouille
  chacun (`try_acquire_sync_lock`), synchronise, décale son échéance.

## Statut

**LIVE — premier cron réel en production réussi le 2026-09-22**
(`{"clubsDue":1,"clubsSynced":1,"clubsSkippedLocked":0,"clubsFailed":0}`),
après correction successive de 4 bugs réels trouvés uniquement par
l'exécution en production (jamais reproductibles avant, réseau
`api.ffbb.app` bloqué dans tous les environnements de développement
disponibles) : nom de champ du jeton API, relation Directus `salle`
interdite en lecture, champ `publicationInternet` reçu comme chaîne au
lieu d'un booléen, et absence de pagination sur `items/ffbbserver_rencontres`
(troncature silencieuse avant les matchs de la saison en cours) — voir
l'historique détaillé ci-dessous, conservé tel quel. La logique de
mapping/diff/idempotence est testée unitairement
(`integrations/ffbb/mapping.test.ts`, 100% pur, aucun accès réseau), mais
aucun appel réel contre `api.ffbb.app` n'a pu être fait depuis un
environnement de développement (réseau `*.ffbb.app` bloqué dans tous les
environnements où ce code a été écrit et testé, y compris les sandbox
utilisées pour le déploiement — voir le premier spike côté ball-manager-web,
`docs/FFBB_ECOSYSTEM_RESEARCH.md`, conservé dans ball-manager-web). Les noms de champs
et endpoints sont ceux confirmés par recoupement de bibliothèques clientes
open source indépendantes dans ce même document, jamais observés en direct.

Premier déclenchement réel du cron `/internal/cron/ffbb` en production :
échec avec `FfbbApiError: Jeton API absent de la réponse de configuration
FFBB`. Un premier renforcement diagnostique (lecture du corps en texte brut
avant `JSON.parse`, recherche par motif de clé) a confirmé, via les logs
Vercel du déclenchement suivant, que **`data.api_bearer_token` n'existe
tout simplement pas** dans la vraie réponse de `items/configuration`. Les
clés réellement présentes (2026-09-22, en production) :

```text
date_created, date_updated, id, key_dh, key_ms, user_created, user_updated,
ios_version, android_version, key_directus_website, key_directus_competitions,
force_ms_reindex
```

Aucune ne contient littéralement le mot "token" — la forme documentée dans
`docs/FFBB_ECOSYSTEM_RESEARCH.md` §3.2 (déduite par recoupement de 3
bibliothèques clientes tierces) ne correspond pas au contrat réel actuel.
`key_ms` est manifestement le jeton Meilisearch (hors périmètre
`items/*`) ; les 3 autres candidats plausibles pour l'authentification des
collections `items/ffbbserver_*` sont `key_dh` ("Data Hub", terme employé
dans la recherche §2), `key_directus_website` et `key_directus_competitions`
— sans certitude sur lequel est le bon pour quelle collection.

**Solution retenue : découverte automatique, pas une nouvelle supposition
figée.** `FfbbDirectusClient.listItems` essaie chaque candidat
(`key_directus_competitions`, `key_dh`, `key_directus_website`, `key_ms`,
dans cet ordre) **contre le vrai endpoint demandé** jusqu'à obtenir un
succès HTTP, met en cache le champ gagnant (`logInfo("Jeton API FFBB
confirmé", { fieldName })` — à chercher dans les logs pour confirmer
lequel fonctionne réellement), et retente une découverte complète si le
jeton en cache se met soudain à échouer en 401/403 (rotation côté FFBB).
Si aucun candidat n'authentifie, l'erreur reste exploitable (dernière
erreur HTTP rencontrée). Voir `directus-client.test.ts` pour la couverture
de cette logique (mock de `fetchImpl`, aucun accès réseau réel).

**Deuxième déclenchement réel (même jour) : `key_dh` confirmé sur
`items/ffbbserver_organismes`, puis 401 sur TOUS les candidats pour
`items/ffbbserver_rencontres` immédiatement après** (log `"Jeton API FFBB
confirmé"` avec `fieldName: "key_dh"` suivi, moins d'une seconde plus tard,
de l'échec total de `listMatchesForOrganisme`). Signature typique d'un
throttling passager (voir §10 de la recherche : "aucune documentation de
rate-limit trouvée") plutôt qu'un vrai jeton invalide — le jeton qui vient
de réussir ne peut pas être structurellement interdit sur une collection
sœur une seconde plus tard. Cause la plus probable : `fetchClubSnapshot`
lançait `listEngagements` et `listMatchesForOrganisme` en **parallèle**
(`Promise.all`) juste après l'appel `organismes`, créant une rafale de
requêtes. Deux corrections complémentaires :
1. `fetchClubSnapshot` (public-provider.ts) n'utilise plus `Promise.all` —
   tous les appels sont désormais strictement séquentiels, espacés de
   `FFBB_REQUEST_SPACING_MS` (200 ms).
2. `listItems` espace ses tentatives de candidats successives
   (`candidateRetryDelayMs`, 300 ms par défaut) et, lors d'une
   redécouverte, retente en PREMIER le dernier champ qui a fonctionné
   (`lastKnownGoodField`) plutôt que de repartir de l'ordre fixe — moins de
   requêtes en rafale si la cause est bien un throttling passager.

**Troisième déclenchement réel (même jour, après déploiement des
espacements) : échec IDENTIQUE** — `key_dh` confirmé sur `organismes`,
puis 401 sur les 4 candidats pour `rencontres`, malgré des appels
strictement séquentiels (plus de `Promise.all`, confirmé par la stack
trace qui ne mentionne plus `Promise.all`) et des délais de 200 ms/300 ms
entre chaque tentative. **La piste throttling est donc écartée** : un
throttling passager n'aurait pas dû résister à trois tentatives espacées
de plusieurs secondes chacune. Le 401 sur `items/ffbbserver_rencontres`
est reproductible et spécifique à cette collection/requête, pas à une
histoire de cadence.

Hypothèse retenue, non encore confirmée (réseau `api.ffbb.app` toujours
inaccessible depuis tous les environnements de développement disponibles) :
`listMatchesForOrganisme` est le seul appel à demander des champs de
relation imbriqués sur 2 niveaux (`salle.commune.libelle`, voir
`RENCONTRE_FIELDS`) et un filtre `_or` combinant deux conditions — tous
les autres appels (`organismes`, `engagements`, `competitions`, `poules`)
utilisent des champs plats et un filtre `_eq`/`_in` simple. Le système de
permissions Directus est fin (par champ, par relation) : il est plausible
que le rôle public associé à ces jetons n'autorise pas la traversée de
relation `salle → commune → libelle`, et que Directus rejette alors TOUTE
la requête plutôt que d'omettre silencieusement le champ non autorisé.

**Corrigé en conséquence** (`directus-client.ts`, `request()`) : le corps
de la réponse d'erreur Directus (400 premiers caractères) est maintenant
inclus dans le message de `FfbbApiError`, et chaque candidat rejeté est
loggé individuellement (`logInfo("Jeton API FFBB candidat rejeté", {
fieldName, errorMessage })`) — Directus renvoie quasi toujours
`errors[].message`/`extensions.code` qui nomme explicitement la vraie
cause (permission refusée sur tel champ, filtre non autorisé, jeton
invalide...). **Ceci est la seule vraie inconnue restante** : le prochain
déclenchement donnera enfin le texte d'erreur réel de Directus au lieu
d'un simple code 401 — à lire en priorité avant toute nouvelle
supposition sur les champs/filtre.

**Quatrième déclenchement réel : cause confirmée avec certitude, hypothèse
validée.** Le corps de réponse Directus (candidat `key_directus_website`,
403) :

```json
{"errors":[{"message":"You don't have permission to access field \"nom\" in collection \"ffbbserver_salles\" or it does not exist. Queried in \"salle\".","extensions":{"code":"FORBIDDEN"}}]}
```

Confirme exactement l'hypothèse ci-dessus : le rôle public associé à ces
jetons n'a pas le droit de lire les champs de la relation `salle` (au
minimum `nom`, probablement aussi `commune.libelle`), et Directus rejette
alors TOUTE la requête `items/ffbbserver_rencontres` plutôt que d'omettre
silencieusement le champ non autorisé. (Le candidat `key_ms` a échoué
séparément avec `"Invalid user credentials."` / `INVALID_CREDENTIALS` —
attendu, `key_ms` est le jeton Meilisearch, hors périmètre `items/*`, voir
plus haut.)

**Corrigé** (`public-provider.ts`, `RENCONTRE_FIELDS`) : les champs
`salle.id`/`salle.nom`/`salle.commune.libelle` sont retirés, remplacés par
le champ plat `salle` seul — Directus renvoie alors l'identifiant brut de
la relation (FK) sans l'étendre, un cas déjà géré par `normalizeVenue()`
(dégrade proprement : `venue.ffbbId` renseigné, `name`/`commune` à
`null`, plutôt que de faire échouer tout `syncFfbb` pour un champ annexe).
Couvert par `public-provider.test.ts` : vérifie que la requête générée ne
contient plus `salle.nom`/`salle.commune`/`salle.id`, et que la
normalisation d'une salle reçue comme FK brute ne plante pas.

Salle/commune du gymnase resteront `null` tant que cette permission n'est
pas élargie côté FFBB (hors de notre contrôle) — n'affecte ni le
calendrier, ni les scores, ni les adversaires, le cœur du Module 1.

**Piste documentée pour une amélioration future (nom/adresse des
salles), affinée par lecture directe du code source du SDK tiers
`ffbb-data-client` (github.com/nickdesi/ffbb-data-client, 2026, lu comme
référence uniquement — rien copié, réimplémentation propre si construit) :**

- `models/get_configuration_response.py` confirme avec certitude que
  `key_dh` EST le jeton API officiel (propriété `api_bearer_token` du
  modèle, retourne `self.key_dh`) et `key_ms` le jeton Meilisearch
  (propriété `meilisearch_token`) — cohérent avec notre découverte
  empirique du 2026-09-22. `CANDIDATE_TOKEN_FIELDS` (`directus-client.ts`)
  met désormais `key_dh` en premier candidat pour cette raison (au lieu
  d'être découvert par tâtonnement à chaque fois).
- `clients/_mixins/list_methods.py` montre que `list_salles()` de ce SDK
  interroge **directement `items/ffbbserver_salles`** (endpoint Directus
  `items/*` standard, voir `config.py` de ce SDK : `ENDPOINT_SALLES =
  "items/ffbbserver_salles"`) via `_list_directus_items_async()` — PAS
  Meilisearch. Piste plus précise que l'hypothèse Meilisearch précédente :
  une requête top-level séparée vers `items/ffbbserver_salles` (filtrée
  par `id: {_in: [...]}`, exactement le même schéma que
  `listCompetitions`/`listPools` déjà en place dans `public-provider.ts`)
  pourrait très bien réussir même si la traversée `rencontres.salle.nom`
  par relation échoue en 403 — les permissions Directus par champ
  s'appliquent parfois différemment selon que la collection est
  interrogée directement ou via une relation imbriquée. **Non vérifié en
  direct** (réseau `api.ffbb.app` toujours inaccessible depuis tous les
  environnements de développement disponibles).
- `clients/_mixins/getters.py` montre que même ce SDK tiers, dans sa
  propre méthode `get_rencontre_async`, ne demande jamais l'expansion de
  la relation `salle` — cohérent avec notre correctif (aucune preuve que
  la traversée de cette relation fonctionne ailleurs non plus).

Non implémenté ici (nouvel appel séparé `listSalles(salleIds)`, jamais
testé en direct) — à construire séparément si le nom des gymnases devient
un besoin réel, jamais avant d'avoir confirmé que le cœur du sync
(calendrier/scores/adversaires) fonctionne. Si construit : code écrit
depuis zéro par ce projet, sur le modèle de `listCompetitions`/`listPools`
déjà en place — jamais une adaptation du code du SDK tiers.

**Cinquième déclenchement réel : le fetch FFBB passe entièrement**
(`organismes`, `engagements`, `rencontres`, `competitions`, `poules` — plus
aucune erreur 401/403) — nouvel échec, cette fois dans NOTRE code
d'écriture en base : `Upsert compétition ... échoué : invalid input
syntax for type boolean: "AFF"`. `RawCompetition.publicationInternet`
était déclaré `boolean` (doc tierce jamais vérifiée en direct, comme
`api_bearer_token` et `salle.nom` avant lui) mais la vraie API renvoie une
**chaîne** (`"AFF"`, vraisemblablement "Affiché") — passée telle quelle à
`publication_internet boolean not null default true` (colonne Postgres),
elle fait planter l'upsert.

**Corrigé** (`public-provider.ts`) : `liveStat`/`emarqueV2`/
`publicationInternet` typés `unknown` (plus `boolean`) dans
`RawCompetition`, et `publicationInternet` converti explicitement
(`row.publicationInternet == null ? true : Boolean(row.publicationInternet)`)
au lieu du `?? true` seul qui laissait passer toute valeur non-null telle
quelle. Ce champ n'est stocké qu'à titre informatif (jamais utilisé pour
filtrer, voir `sync.ts`) : `Boolean("AFF")` → `true` est acceptable sans
connaître tous les codes possibles. Couvert par 2 nouveaux tests
(`public-provider.test.ts`) : conversion d'une chaîne reçue en vrai
booléen, et valeur par défaut quand le champ est absent.

**Quatrième bug réel, trouvé après le premier cron réussi par inspection
directe des données synchronisées** (pas par un nouvel échec — le cron
répondait `clubsSynced:1`, mais les données elles-mêmes étaient
incomplètes) : `team_id` était `null` sur les 500 rencontres synchronisées.
Investigation en base (requêtes SQL directes sur `raw_ffbb_payload`,
capturé lors du sync réussi — pas besoin de réseau FFBB pour ça) :

- **Cause 1, réelle mais sans correctif** (confirmée avec l'utilisateur) :
  un "engagement" FFBB (équipe↔compétition↔saison) est scopé par saison ;
  `listEngagements` ne récupère que la saison en cours, donc les rencontres
  de saisons passées référencent des `idEngagementEquipe1/2` qui n'existent
  plus dans la liste — pas de `team_id` pour l'historique. Tentative de
  contournement par le nom brut de l'équipe (`nomEquipe1/2`, ex. `"SPORT
  CLUB DE SETE BASKET - 1"`) écartée : les vraies données montrent des
  formes ambiguës (équipes inter-clubs/CTC type `"IE - CTC BASKET THAU"`,
  entrées sans numéro) qui rendraient un correctif par expression régulière
  fragile — risque de rattacher un match à la mauvaise équipe interne.
  Accepté comme limite connue : **seules les saisons passées sont
  concernées**, pas bloquant pour l'usage réel (confirmé par le club).
- **Cause 2, bug réel, corrigé** : `items/ffbbserver_rencontres` ne
  recevait AUCUN paramètre de pagination (`limit`/`offset`). Les 500
  rencontres reçues, triées par `date_rencontre` croissant, s'arrêtaient
  toutes avant novembre 2025 — **aucune ne concernait la saison en cours**
  (2026-2027, qui n'a pas encore de calendrier publié au moment de ce
  test, vérifié : 0 rencontre avec une date ≥ août 2026). Si l'API FFBB
  applique une limite par défaut côté serveur (non documentée
  officiellement, voir `docs/FFBB_ECOSYSTEM_RESEARCH.md` §3.5/§10), une
  requête sans pagination explicite perd silencieusement tout ce qui vient
  après la limite — potentiellement les rencontres les plus récentes en tri
  croissant.

**Corrigé** (`directus-client.ts`) : nouvelle méthode
`FfbbDirectusClient.listAllItems()` qui pagine explicitement (taille de
page fixée par nous, 200 par défaut — jamais `limit: -1`) jusqu'à ce
qu'une page renvoie moins d'éléments que la taille demandée, avec un
plafond de 50 pages en garde-fou. Utilisée pour `listEngagements`,
`listCompetitions`, `listPools` et `listMatchesForOrganisme`
(`public-provider.ts`) — les seuls appels dont le nombre de résultats
n'est pas borné par une liste d'identifiants explicite. `organismes`
reste sur `listItems` (recherche par code, `limit: 1`, jamais plus d'un
résultat attendu). Couvert par 3 nouveaux tests dans
`directus-client.test.ts` (pagination multi-pages, arrêt dès qu'une page
est incomplète, garde-fou anti-boucle-infinie) et 1 dans
`public-provider.test.ts` (confirme que `listMatchesForOrganisme` va bien
chercher une deuxième page).

**Sixième déclenchement réel, avec la pagination déployée :
`FUNCTION_INVOCATION_TIMEOUT` après 300s.** La pagination fonctionnait
(elle allait chercher l'historique COMPLET du club, des milliers de
rencontres sur plusieurs années), mais traiter chaque rencontre
séquentiellement (upsert compétition/poule/salle/match, détection de
changement, un aller-retour Supabase à la fois — voir `sync.ts`)
dépassait largement le budget d'une invocation Vercel. Or seule la saison
en cours compte réellement pour l'usage du club (confirmé explicitement
par le club — les saisons passées peuvent être ignorées).

**Corrigé** (`config.ts`, `public-provider.ts`) : `listMatchesForOrganisme`
filtre désormais sur `date_rencontre: {_gte: <6 mois avant aujourd'hui>}`
(`FFBB_MATCH_HISTORY_MONTHS`), combiné à la condition club existante via
`_and`. Aucune borne supérieure : toutes les rencontres futures (le
calendrier de la saison en cours, au fur et à mesure de sa publication par
la FFBB) remontent toujours. 6 mois de marge avant aujourd'hui pour ne
jamais manquer une rencontre reportée/rattrapée de fin de saison
précédente. `listAllItems` reste en place (garde-fou si une fenêtre de 6
mois dépassait quand même une page — improbable mais pas impossible en
période de forte activité). Couvert par un nouveau test
(`public-provider.test.ts`) : vérifie que le filtre `date_rencontre._gte`
est bien envoyé (format `YYYY-MM-DD`) et qu'aucune borne supérieure
(`_lte`) n'est ajoutée par erreur.

**Septième correctif : le 403 sur la relation `salle` (6ᵉ déclenchement)
était en fait un mauvais nom de champ, pas une permission refusée.**
`salle.nom`/`salle.commune.libelle` (déduits de
`docs/FFBB_ECOSYSTEM_RESEARCH.md` §3.4, jamais vérifiés en direct) ont été
retirés de `RENCONTRE_FIELDS` par prudence après le 403. Relecture du
modèle typé du SDK tiers `ffbb-data-client`
(`models/get_salle_response.py`, lu comme référence — rien copié) :
`ffbbserver_salles` expose en réalité `id`, `numero`, `libelle` (pas
`nom`), `adresse` (chaîne consolidée, PAS de commune séparée). Le message
d'erreur Directus disait explicitement *"... or it does not exist"* —
c'était probablement ça depuis le début.

**Corrigé** : `RENCONTRE_FIELDS` demande maintenant `salle.id`,
`salle.libelle`, `salle.adresse`. `RawSalle`/`NormalizedVenue` mis à jour
(`commune` renommé `address`, migration
`20260922100000_venues_address_field.sql`, appliquée). `venues.address`
stocke l'adresse complète. Faute d'un DTO d'API dédié pour l'adresse
(`contracts/matches.ts` n'expose que `venueLabel`, un seul champ),
`matches.venue_raw_label` combine nom et adresse
(`"Gymnase X — 12 rue Y, 34200 Sète"`, voir `formatVenueLabel` dans
`mapping.ts`) plutôt que de perdre l'adresse. **Non vérifié en direct**
(réseau `api.ffbb.app` toujours inaccessible depuis tous les
environnements de développement disponibles) — à confirmer par le
prochain cron réel : soit les salles remontent enfin avec nom/adresse,
soit `libelle`/`adresse` sont aussi de mauvais noms et le vrai message
d'erreur Directus (capturé depuis le sixième correctif, voir
`request()`) dira lequel.

**Huitième ajout : logos des organismes adverses** (demande explicite du
club). `models/get_organisme_response.py` du SDK tiers ffbb-data-client
(lu comme référence, rien copié) confirme `organisme.logo: { id,
gradient_color }` — une référence de fichier Directus, pas une URL
directe. L'image se sert via l'endpoint standard `assets/{id}` (voir
`FFBB_ENDPOINTS.assets`).

**Implémenté** (`public-provider.ts`) : `listOrganismeLogos(organismeIds)`
— appel séparé à `items/ffbbserver_organismes` (comme `salle`, jamais une
relation imbriquée testée en aveugle sur une collection qui peut aussi
être interrogée top-level), construit l'URL `{FFBB_API_BASE_URL}assets/{logo.id}`.
Câblé dans `fetchClubSnapshot` : après le calcul des matchs, les
identifiants d'organismes adverses distincts sont collectés et résolus en
une seule passe, puis attachés à chaque match (`opponentLogoUrl`).
Migration `20260922110000_matches_opponent_logo_url.sql` (appliquée) :
`matches.opponent_logo_url`. Exposé via l'API (`MatchListItemDto`/
`MatchDetailsDto.opponentLogoUrl`).

**Non vérifié en direct, sur DEUX points distincts** (réseau
`api.ffbb.app` toujours inaccessible) :
1. Le nom de champ `logo`/`logo.id` lui-même (même prudence que pour
   `salle` : à confirmer par le prochain cron réel, le corps d'erreur
   Directus dira si c'est faux).
2. **Plus important** : `assets/{id}` pourrait exiger le même jeton
   Bearer que le reste de l'API — dans ce cas, une simple balise `<img
   src="...">` côté frontend échouerait silencieusement (le navigateur
   n'envoie pas notre en-tête `Authorization`). Décision explicite du
   club : récupérer l'identifiant/URL maintenant, tester l'affichage
   séparément avant de construire quoi que ce soit de plus (proxy/cache
   d'images côté backend, à la manière des documents e-Marque, si
   nécessaire) — pas de sur-ingénierie avant d'avoir la confirmation.

**Neuvième déclenchement : les deux points ci-dessus confirmés en
production le 2026-09-22.** `venue_raw_label` et `opponent_logo_url`
remontent avec de vraies valeurs (`"GYMNASE ROGER COUDERC — 37 Rue MAS DE
LEMASSON"`, `https://api.ffbb.app/assets/55bb35db-...`) — `libelle`/
`adresse`/`logo.id` étaient les bons noms de champs du premier coup.
**`assets/{id}` est accessible sans authentification** : testé
directement dans un navigateur par le club, l'image s'affiche — pas
besoin de proxy/cache d'images, une balise `<img>` suffit côté frontend.

**Dixième ajout : logo DU club lui-même** (pas seulement des adversaires
— demande explicite, affichage "Sète vs X"). `findOrganismeByCode`
demande maintenant aussi `logo.id` (`NormalizedOrganisme.logoUrl`,
`public-provider.ts`). `syncClubLogoIfMissing` (`sync.ts`) renseigne
`clubs.logo_url` — réutilise le champ EXISTANT (déjà exposé via
`ClubDto.logoUrl`, déjà éditable manuellement via
`PATCH /v1/clubs/:clubId`) plutôt qu'une nouvelle colonne/un nouveau champ
d'API : `UPDATE clubs SET logo_url = ... WHERE id = club_id AND logo_url
IS NULL` — ne l'écrase jamais si le club l'a personnalisé, sync ou pas.
Couvert par 2 nouveaux tests (`public-provider.test.ts`).

## Cron

`GET /internal/cron/ffbb` (toutes les 15 minutes, voir `vercel.json`) :

```sql
select id, ffbb_club_id from clubs
where status = 'active' and ffbb_enabled = true
  and (ffbb_next_sync_at is null or ffbb_next_sync_at <= now())
limit 20  -- FFBB_SYNC_BATCH_SIZE, voir integrations/ffbb/config.ts
```

Batch volontairement petit (§27/§29 de la demande) : le cron suivant
reprend les clubs non traités, jamais une boucle qui traite tout en une
seule invocation.

## API frontend (gap 2 résolu)

`ClubDto` expose le code club FFBB sous le nom explicite `ffbbClubCode`
(jamais `ffbbClubId`, pour ne pas le confondre avec l'UUID interne du
club). Le changer passe par une route dédiée, pas par
`PATCH /v1/clubs/:clubId` :

```
PATCH /v1/clubs/:clubId/integrations/ffbb
{ "clubCode"?: string, "enabled"?: boolean }
```

`club_admin` uniquement (service role côté serveur : `ffbb_club_id`/
`ffbb_enabled`/`ffbb_next_sync_at` ne sont pas des colonnes accordées à
`authenticated`, voir `docs/API.md`). Ne supprime jamais l'historique déjà
synchronisé (aucun `DELETE` sur `matches`) ; un changement de code
replanifie `ffbb_next_sync_at = now()` pour resynchroniser au prochain
passage du cron. Voir `docs/API.md` pour le détail des 8 gaps résolus.

## Onzième correctif — /admin/intégrations et /admin/sync remontaient des erreurs (2026-09-22)

Signalé par le club : ces deux pages "sont en erreur". Diagnostic à partir
des données réelles en production (`sync_runs`, `fbi_integration_status`,
logs Supabase) plutôt que d'une supposition — deux causes distinctes,
toutes deux corrigées :

1. **Verrou de concurrence jamais posé sur le déclenchement manuel.**
   `try_acquire_sync_lock`/`release_sync_lock` (voir
   `supabase/migrations/20260921100070_sync_locks.sql`) existaient déjà et
   étaient déjà utilisés par `scheduler.ts` (le cron) — mais **jamais** par
   `POST /v1/clubs/:clubId/integrations/ffbb/sync` (bouton "Relancer
   maintenant" de `/admin/intégrations`). Un admin cliquant plusieurs fois
   de suite, ou cliquant pendant que le cron tournait déjà, lançait deux
   `syncFfbb` en parallèle pour le même club — confirmé dans l'historique
   `sync_runs` du club pilote (plusieurs déclenchements à quelques minutes
   d'écart le 2026-09-22 après-midi). Corrigé : la route pose maintenant le
   même verrou que le cron (`routes.ts`), avec un 409
   `FFBB_SYNC_ALREADY_RUNNING` explicite si une synchronisation est déjà en
   cours, et le libère systématiquement (`finally`) même si `syncFfbb`
   lève une exception. Testé (`routes.test.ts`, 4 nouveaux cas).

2. **Une ligne `sync_runs` restée "running" indéfiniment.** Un processus
   tué durement (timeout serveur, avant le correctif de fenêtre 6 mois —
   voir "Sixième déclenchement" plus haut) ne passe jamais par le `catch`
   de `syncFfbb` qui marque le run "error" : la ligne reste "running" pour
   toujours. `/admin/sync` affiche les 10 derniers runs sans filtrer par
   âge — une ligne "running" en réalité morte depuis des heures, mélangée
   à d'anciennes erreurs déjà résolues (coercion booléenne
   `publicationInternet`, déjà corrigée — voir "Cinquième déclenchement";
   jetons FFBB expirés, auto-résolus au run suivant), donnait l'impression
   d'un système cassé alors que les synchronisations récentes réussissaient
   toutes. Corrigé : `reapOrphanedRunningSyncRuns` (`sync.ts`), appelée en
   tête de `syncFfbb` — à ce stade le verrou vient d'être acquis, donc
   toute ligne "running" trouvée pour ce club est nécessairement orpheline
   (jamais un run concurrent légitime), et est requalifiée en "error" avec
   un message explicite. Testé isolément (`sync.test.ts`).

Fix complémentaire côté ball-manager-web : `/admin/sync` appelait
`api.matches.list(club.id)` SANS filtre `from`, paginant tout l'historique
du club à chaque chargement (le même risque de dépassement de délai déjà
corrigé sur la page Matchs publique) — aligné sur le même filtre
`currentSeasonStart()`.

Nettoyage ponctuel en production (une seule ligne, exécuté directement en
SQL, pas via une migration — pas un changement de schéma) : la ligne
`sync_runs` orpheline du club pilote (`c7574a14…`, démarrée le
2026-09-22 14:27, jamais terminée) a été requalifiée en "error" pour que
`/admin/sync` reflète immédiatement l'état réel sans attendre le prochain
cycle de synchronisation.

## Douzième correctif — équipes garçons/filles fusionnées par erreur (2026-09-25, § docs/TEAMS.md)

Découvert en creusant la demande du club de sectoriser le roster/calendrier
par équipe (`docs/LICENCIES.md`/`docs/TEAMS.md`), pas signalé
spontanément : `resolveTeamForEngagement` (`sync.ts`) résolvait/créait une
équipe par un NOM dérivé de la catégorie + numéro d'équipe SEUL,
n'encodant jamais le sexe — deux engagements de sexes différents
partageant le même numéro (ex. Seniors 1 féminine ET masculine)
généraient le même nom et fusionnaient dans LA MÊME ligne `teams`.
Constaté sur 5 équipes du club pilote (57 matchs mal regroupés, jamais
perdus). Corrigé : résolution par (catégorie, sexe, numéro d'équipe),
jamais par le nom ; les 5 équipes déjà fusionnées séparées via une
migration dédiée (matchs/engagements réaffectés selon leur compétition
d'origine, qui a toujours porté le bon sexe indépendamment de ce bug).
Détail complet, régression testée : `docs/TEAMS.md`.
