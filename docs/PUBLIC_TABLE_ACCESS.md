# Accès public sans compte aux Tables de marque

Retour du club, 2026-09-29 : "il faut un système où la personne qui va se
mettre sur un match ne peut pas être supprimée par quelqu'un d'autre sauf
un admin (sur demande). Car je vais envoyer le lien à tout le monde et ils
se positionneront, et une fois positionné, ils ne doivent plus pouvoir
être modifiés par qqn d'autre, mais peuvent se supprimer eux-mêmes si le
token est tjr actif, sinon faut faire une demande admin (car l'accès se
fera sans création de compte)".

Ce document décrit le mécanisme d'auto-affectation sans compte qui vient
compléter le module Tables de marque (voir `docs/TABLE_ASSIGNMENTS.md`,
qui reste la référence pour la règle des 120 minutes, la détection de
conflit, le ranking et l'équité — ce document-ci ne couvre QUE l'accès et
la propriété des affectations, jamais l'algorithme lui-même, identique des
deux côtés).

## Principe : un lien commun, un jeton personnel

Le club distribue **un seul lien**, commun à tout le monde (WhatsApp,
email de groupe, etc.) : `https://.../public/{clubSlug}/tables`. Il n'y a
**aucune création de compte, aucun mot de passe**.

À la première visite, la personne **choisit son nom** dans la liste des
licenciés actifs du club (`GET /v1/public/clubs/:clubSlug/licencies`, qui
renvoie `claimed: true/false` par licencié — jamais qui a déjà choisi
quoi, seulement si c'est encore possible), puis **demande son lien par
email** (`POST .../licencies/:licencieId/request-link`, retour du club,
2026-10-01 : "il va chercher son nom, il va mettre son mail... un bouton
qui renvoie vers son lien avec token. On va faire ça avec Resend").

Cette demande **mint un jeton personnel secret** à haute entropie
(32 octets aléatoires) et l'envoie **uniquement par email** (Resend, HTML
avec un bouton "Ouvrir mon espace" + le lien en texte) : le jeton n'est
**jamais** dans la réponse HTTP, seule `maskedEmail` (`c***@gmail.com`)
l'est. Seul son hash SHA-256 est stocké (`licencie_public_tokens.token_hash`),
jamais le jeton en clair (même précaution que `fbi_credentials`, voir
`docs/MULTI_TENANCY.md`).

Adresse de destination :

- **Adresse déjà connue** (`licencies.email`, ou celle du lien actif) →
  l'email part TOUJOURS à cette adresse, l'adresse saisie est ignorée.
  C'est aussi le "lien perdu ?" : redemander renvoie un nouveau lien au
  même endroit.
- **Aucune adresse connue, nom encore libre** → l'adresse saisie est
  exigée (`400 EMAIL_REQUIRED` sinon), puis enregistrée dans
  `licencies.email` **après** un envoi réussi (jamais l'écrasement d'une
  adresse existante — un·e admin la corrige depuis la fiche du licencié).
- **Aucune adresse connue mais nom déjà choisi** (ancien flux, lien
  affiché à l'écran) → `409 ALREADY_CLAIMED` : seul·e un·e admin peut
  réinitialiser, sinon n'importe qui pourrait détourner ce profil avec sa
  propre adresse.

Chaque envoi **remplace** le lien précédent (ancien jeton révoqué, un seul
lien actif par licencié), avec un délai minimal d'une minute entre deux
envois (`429 LINK_RECENTLY_SENT`). Si Resend refuse l'envoi (`502
EMAIL_SEND_FAILED`), le nouveau jeton est révoqué et l'ancien lien
restauré ; sans `RESEND_API_KEY`, la demande répond `503
EMAIL_NOT_CONFIGURED` **avant** toute écriture.

Le lien pointe vers `{origine}/public/{clubSlug}/{returnTo}?token=…`
(`returnTo` ∈ `matchs | tables | derogations`, défaut `tables`).
L'origine est celle de la requête si elle figure dans `FRONTEND_ORIGINS`,
sinon `PUBLIC_APP_URL`, sinon la première origine https de
`FRONTEND_ORIGINS` — jamais une origine arbitraire.

### Configuration Resend

- `RESEND_API_KEY` (Vercel, projet club-manager-api) — jamais commitée.
- `RESEND_FROM` (optionnel, défaut `SCSB <onboarding@resend.dev>`) — le
  nom affiché est remplacé par le nom du club, l'adresse est conservée.
- **Sans domaine vérifié** sur Resend, l'expéditeur `onboarding@resend.dev`
  ne livre **qu'à l'adresse du propriétaire du compte Resend** : toute
  autre adresse est refusée (`502`). Vérifier un domaine dans Resend puis
  définir `RESEND_FROM="Nom du club <noreply@domaine-verifie>"` pour
  envoyer à tout le monde.

**Un nom ne peut être choisi qu'une seule fois** tant qu'il est actif — un
index UNIQUE PARTIEL en base (`(club_id, licencie_id) WHERE revoked_at IS
NULL`) garantit cette règle de façon atomique, y compris en cas de double
clic simultané par deux personnes sur le même nom (jamais un
SELECT-puis-INSERT applicatif, qui laisserait une fenêtre de course).

## Ce que le jeton authentifie — et ce qu'il n'autorise jamais

Le jeton prouve **uniquement** "je suis ce licencié précis, de ce club" —
jamais un rôle applicatif, jamais un droit d'administration. Il donne
accès **exclusivement** aux routes du module `modules/public-tables/`
(auto-affectation sur SES propres postes) — jamais aux routes admin
authentifiées par Supabase Auth (`club_admin`/`responsable_tables`), qui
restent inchangées et peuvent toujours tout faire (voir plus bas).

## Propriété d'une affectation — le cœur de la demande

Une fois qu'une personne s'est affectée elle-même à un poste :

- **Personne d'autre, via le flux public, ne peut la remplacer ou la
  retirer.** `PUT .../table-assignments/:role?token=` refuse (409
  `ALREADY_TAKEN_BY_SOMEONE_ELSE`) si le poste est déjà occupé par un
  licencié différent de celui du jeton — contrairement au `PUT` admin
  (authentifié), qui peut toujours remplacer n'importe qui (§77 "Modifier"
  de `docs/TABLE_ASSIGNMENTS.md`). `DELETE .../table-assignments/:role?token=`
  refuse (403) de retirer l'affectation de quelqu'un d'autre, quelle que
  soit la raison.
- **La personne elle-même peut toujours se retirer**, tant que son jeton
  est actif — `DELETE` avec son propre jeton réussit toujours sur SON
  poste.
- **Un admin peut toujours tout faire** — les routes admin authentifiées
  (`PUT`/`DELETE .../table-assignments/:role` sous `/v1/clubs/:clubId/...`)
  ne changent pas : un club_admin ou responsable_tables peut remplacer ou
  retirer n'importe quelle affectation, quelle que soit son origine
  (créée par un admin ou auto-affectée). C'est la voie "demande admin"
  mentionnée dans la demande du club, pour tout cas que le flux public ne
  couvre pas.

Ces deux comportements (public restreint / admin toujours permissif)
partagent le **même moteur de conflit** (`determineEligibility`,
`assignTableRole`/`removeTableRole` dans `modules/tables/shared.ts`) —
jamais deux implémentations séparées des mêmes règles. Seul un paramètre
change : `blockIfHeldBySomeoneElse` (écriture) et `onlyIfLicencieId`
(retrait), tous deux `undefined`/absents côté admin.

## Jeton "toujours actif" vs "demande admin"

Tant que le jeton n'est pas révoqué, la personne peut se gérer elle-même
(auto-affectation, self-delete). Il **n'expire jamais automatiquement**
(retour du club : "jamais sauf révocation manuelle par un admin") — la
seule façon de le rendre inactif est une action explicite d'un
`club_admin` :

`POST /v1/clubs/:clubId/table-assignments/public-access/:licencieId/reset`
révoque le jeton actif du licencié (`revoked_at` rempli). Conséquences :

- Le lien personnel perdu/révoqué ne fonctionne plus (401 sur toute route
  publique).
- Le nom redevient choisissable (`claimed: false`) — la personne (ou
  quelqu'un en son nom, à vérifier hors outil) doit repasser par le lien
  commun et re-choisir son nom pour obtenir un nouveau jeton.
- **Les affectations déjà existantes de ce licencié ne sont JAMAIS
  touchées par une réinitialisation d'accès** — seul le moyen d'y accéder
  change, jamais les données elles-mêmes. Une fois qu'un nouveau jeton est
  émis pour ce même licencié, la personne peut de nouveau gérer ses
  affectations existantes normalement (l'appartenance se vérifie par
  `licencie_id`, jamais par l'identité du jeton lui-même).

`GET /v1/clubs/:clubId/table-assignments/public-access` liste, pour un
admin, qui a déjà revendiqué son nom (`claimed`, `email` optionnel fourni
à la revendication, `claimedAt`) — pour savoir qui réinitialiser en cas de
lien perdu signalé. Ces deux routes sont réservées à `club_admin`
uniquement (jamais `responsable_tables`) : c'est de la gestion
d'accès/identité, plus sensible que la simple gestion des postes.

## Base de données

Migration `20260929000000_licencie_public_access.sql` — table
`licencie_public_tokens` : `id`, `club_id`, `licencie_id`, `token_hash`,
`email` (optionnel, jamais vérifié en V1), `created_at`, `revoked_at`,
`revoked_by`.

- Index UNIQUE PARTIEL `(club_id, licencie_id) WHERE revoked_at IS NULL` —
  un seul jeton actif par licencié, une révocation libère immédiatement le
  nom pour une nouvelle revendication.
- Index UNIQUE sur `token_hash`.
- RLS activée, réservée à `club_admin` (`licencie_public_tokens_all_club_admin`)
  — **cette policy ne couvre que la gestion ADMIN**, jamais le flux public
  lui-même : celui-ci passe toujours par `createServiceSupabaseClient()`
  (bypass RLS), avec vérification manuelle du club/token dans le code
  applicatif (`modules/public-tables/routes.ts`), même précaution que
  `fbi_credentials` — voir `docs/MULTI_TENANCY.md`.

Isolation vérifiée contre un vrai PostgreSQL 16 (`supabase/tests/isolation_test.sql`,
Scénario 9) : `club_admin` peut créer/lire ses jetons, un autre club ne
les voit jamais même avec un UUID connu, un simple membre (coach) n'y a
aucun accès, et la contrainte UNIQUE partielle refuse bien un second
jeton actif pour le même licencié.

## API

Toutes les routes ci-dessous sont montées sous `/v1/public/clubs/:clubSlug`
(**jamais** `:clubId` — le slug seul est distribué dans le lien) et
n'exigent **aucun** header `Authorization` :

- `GET /` — infos club minimales (`slug`, `name`, `logoUrl`, `timezone`),
  jamais de données membre/rôle/FFBB.
- `GET /licencies` — roster pour choisir son nom (`claimed` seulement).
- `POST /licencies/:licencieId/request-link` (body `{ email?, returnTo? }`)
  — envoie le lien personnel par email, jamais dans la réponse (voir plus
  haut). Remplace l'ancien `POST .../claim` (supprimé).
- `GET /me?token=` — résout l'identité (vérification d'un lien déjà en
  poche) ; `isClubAdmin` indique si ce licencié est rattaché à un compte
  `club_admin` actif du club.
- `GET /derogations?token=` — dérogations du club en **lecture seule**,
  réservées aux licenciés à qui un club_admin a donné le **profil admin**
  depuis /joueurs (`licencies.public_admin`, aucun compte requis), ou
  rattachés (`club_memberships.licencie_id`) à un compte `club_admin`
  ACTIF de ce club : `401` sans jeton valide, `403
  CLUB_ADMIN_REQUIRED` sinon. Le jeton seul ne suffit jamais (retour du
  club, 2026-10-01 : dérogations "admins seulement"). Aucune action
  (répondre, vérifier sur FBI) n'est exposée publiquement.
- `GET /table-assignments?token=&from=&to=` — même contenu que la vue
  admin (`GET /v1/clubs/:clubId/table-assignments`), avec `me` en plus.
- `PUT /matches/:matchId/table-assignments/:role?token=` — auto-
  affectation. Le `licencieId` vient TOUJOURS du jeton, jamais du corps de
  la requête. `409 ALREADY_TAKEN_BY_SOMEONE_ELSE` si le poste appartient à
  quelqu'un d'autre.
- `DELETE /matches/:matchId/table-assignments/:role?token=` — retrait de
  SA PROPRE affectation. `403` si le poste appartient à quelqu'un d'autre.

Côté admin authentifié (sous `/v1/clubs/:clubId/table-assignments`) :

- `GET /public-access` — état des accès publics (`club_admin` uniquement).
- `POST /public-access/:licencieId/reset` — révoque le jeton actif
  (`club_admin` uniquement).

## Hors périmètre V1 (documenté, non implémenté)

- **Aucune expiration automatique** du jeton — seule une révocation admin
  explicite le rend inactif (choix confirmé par le club).
- **Aucune vérification de l'identité** au moment du choix du nom — rien
  n'empêche techniquement quelqu'un de choisir le nom d'un autre licencié
  du même club avant lui ; c'est un compromis assumé pour un outil interne
  à faible enjeu (choix confirmé par le club : "il choisit son nom dans la
  liste", sans étape de vérification supplémentaire). La réinitialisation
  admin reste le filet de sécurité en cas d'usurpation constatée.
- **Limitation de débit minimale** : une minute entre deux envois pour un
  même licencié, rien de global — un visiteur pourrait encore revendiquer
  plusieurs noms libres avec sa propre adresse. Risque jugé faible pour un
  lien distribué en interne à un club ; la réinitialisation admin reste le
  filet de sécurité.
- Le flux public **n'expose jamais** la bascule "pas besoin d'arbitre"
  (`referee-status`) — décision organisationnelle réservée à l'admin, voir
  `docs/TABLE_ASSIGNMENTS.md`.

## Délivrabilité (emails en indésirables)

Retour du club, 2026-10-08 : « le lien part dans les indésirables chez
certaines personnes ». Le classement dépend surtout du domaine d'envoi, pas
du code :

1. **Domaine vérifié sur Resend** avec les 3 enregistrements DNS au vert
   (SPF `send.<domaine>`, DKIM `resend._domainkey.<domaine>`, MX `send.<domaine>`).
2. **DMARC** sur le domaine : `_dmarc.<domaine>` TXT
   `v=DMARC1; p=none; rua=mailto:<boîte lue>` (Gmail/Yahoo l'exigent).
3. **Suivi des clics/ouvertures désactivé** sur le domaine dans Resend : il
   réécrit les liens vers un autre domaine, signal classique d'hameçonnage.
4. **Lien du même domaine que l'expéditeur** : `PUBLIC_APP_URL` (prioritaire
   sur l'origine de la requête depuis 2026-10-08) doit pointer vers le
   domaine personnalisé du frontend, jamais une URL `*.vercel.app`.
5. **`RESEND_REPLY_TO`** vers une boîte réellement lue.

Côté contenu (src/email/personal-link-email.ts) : version texte jointe, pas
d'emoji, raison de l'envoi explicite, aucune formule alarmante.

## Expiration des liens personnels (lot 5b, 2026-11)

Un lien personnel est valable **7 jours** (`licencie_public_tokens.expires_at`, défaut `now() + 7 jours`).

- Jeton connu mais échu : `401` avec le code `PERSONAL_LINK_EXPIRED` (web et app affichent « Lien expiré, demandez-en un nouveau »). Un jeton inconnu ou révoqué reste un `401` générique (`UNAUTHORIZED` / `INVALID_PERSONAL_LINK`).
- Pas d'envoi automatique : le licencié en redemande un ; l'admin qui rouvre sa fiche obtient un nouveau lien (l'échu est révoqué, jamais réaffiché).
- Un lien échu ne crée plus de session d'appareil, n'ajoute plus de personne à une session, ne peut plus être échangé contre un code d'autorisation et ne reçoit plus de notification push.
- **Déploiement** : appliquer la migration `20261104090000_personal_link_expiry.sql` (`supabase db push`, après `--dry-run`) **avant** de déployer le back. Les liens déjà diffusés expirent 7 jours après la migration : date butoir pour livrer le lot 5c (web et app).
