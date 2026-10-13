# Licenciés / fiche joueur

Demande directe du club (2026-09-25) : *"faudrait associer chaque joueur à
sa licence pour ensuite avoir une fiche joueur avec tous ses matchs et ses
stats par match"*, avec la possibilité d'enrichir cette fiche (photo,
infos persos) soit par un admin, soit par le·la licencié·e lui/elle-même
une fois rattaché·e à un compte.

## Le trou qu'il fallait combler d'abord

`licencies` (le modèle "personne physique du club", voir
`supabase/migrations/20260921083010_licencies.sql`) existait depuis la
Phase 0, mais **rien dans ce backend n'y insérait jamais de ligne** —
confirmé en production le 2026-09-25 : `select count(*) from licencies`
renvoyait `0` pour le club pilote, alors même que les numéros de licence
de ses joueuses étaient déjà correctement extraits par le pipeline
e-Marque (voir "Trente-quatrième déclenchement", `docs/FBI.md`). Sans
licenciés, `match_participants.licencie_id` ne pouvait donc JAMAIS être
renseigné, quelle que soit la qualité de l'OCR — la demande du club était
structurellement impossible à satisfaire.

**Corrigé** : `persist-emarque-match.ts#insertParticipants` auto-
provisionne désormais un `licencies` pour un·e joueur·se **du camp du
club lui-même** (jamais l'équipe adverse) quand son numéro de licence est
lu mais qu'aucun licencié existant ne correspond déjà. Le "camp du club"
est déterminé par `matches.is_home` (`true` → nos joueur·se·s sont
`teamSide: "home"` dans les données e-Marque, `false` → `"away"`) —
jamais une supposition : si `is_home` n'est pas renseigné, aucun
provisionnement n'a lieu. Exige un prénom ET un nom de famille lisibles
(jamais une identité devinée ou vide, ARCHITECTURE.md §22) ; en cas de
course avec un autre import créant le même numéro de licence entre-temps
(23505), le licencié déjà créé est simplement réutilisé, jamais un
doublon. Voir `autoProvisionLicencieId` dans
`src/integrations/emarque/persist/persist-emarque-match.ts`.

Portée explicitement limitée aux licencié·e·s **du club exploitant le
compte** (instruction du club, "si l'autre club veut ses stats il devra
faire son compte") : les joueur·se·s de l'équipe adverse ne sont jamais
auto-provisionné·e·s, même quand leur numéro de licence est parfaitement
lu.

## Modèle de rattachement à un compte

Déjà prévu dès la Phase 0, jamais implémenté avant cette demande : un
compte Supabase Auth peut se rattacher à UN `licencies` via
`club_memberships.licencie_id` (une ligne par club, voir
`supabase/migrations/20260921100020_club_memberships.sql` — remplace
l'ancien `profiles.licencie_id`, devenu obsolète depuis que le
rattachement est scopé par club et non plus global). Ce rattachement
lui-même (inviter un compte, le relier à un licencié) reste un geste
manuel de `club_admin` en base à ce stade — aucune UI dédiée n'a été
construite pour cette demande précise, seule la fiche joueur elle-même
(lecture + édition selon ce rattachement) l'a été.

## Sectorisation par équipe (voir docs/TEAMS.md)

`licencies.team_id` renseigné automatiquement depuis `matches.team_id` du
match d'origine à l'auto-provisionnement — jamais réécrit ensuite
automatiquement, modifiable uniquement par `club_admin` (jamais le
licencié lui-même, identité admin-contrôlée comme le reste). Détail
complet (dont un bug de fusion garçons/filles découvert et corrigé au
passage) : `docs/TEAMS.md`.

## Fiche joueur : lecture

`GET /v1/clubs/:clubId/licencies/:licencieId` — identité (nom, prénom,
licence, date de naissance, contact, photo) + l'historique complet des
matchs où ce·tte licencié·e a été `match_participants.licencie_id`, avec
ses statistiques par match si le document "résumé" e-Marque les a lues
(`stats: null` sinon, jamais une valeur devinée — même principe que
`parser/merge.ts`). Lisible par **tout membre actif du club** (nouvelle
policy RLS `licencies_select_member`, voir migration
`20260925090000_licencies_profile_and_member_read.sql`) — la RLS
précédente (`licencies_select_own`, club_admin ou le licencié lui-même
seulement) aurait rendu une fiche joueur invisible à un coéquipier ou un
coach, incohérent avec le reste de l'app (`match_participants`/
`player_match_stats` sont déjà lisibles par tout membre).

`GET /v1/clubs/:clubId/licencies` liste le roster complet du club (tri
alphabétique), point d'entrée pour naviguer vers une fiche.

## Fiche joueur : édition

`PATCH /v1/clubs/:clubId/licencies/:licencieId/profile` — deux
populations de champs distinctes, appliquées côté serveur (voir
`src/modules/licencies/profile-fields.ts`, fonction pure testée
indépendamment de toute IO) :

- **`club_admin`** : tous les champs (identité, licence, statut actif,
  contact, photo).
- **Le·la licencié·e lui/elle-même** (rattaché·e via
  `club_memberships.licencie_id`) : **uniquement** `photoUrl`/`email`/
  `phone` — jamais son propre nom, sa date de naissance, son numéro de
  licence ou son statut actif/inactif. L'identité d'un licencié est ce
  qui relie ses statistiques à travers les matchs (et, pour la licence,
  ce qui a permis l'auto-provisionnement lui-même) — jamais laissée à la
  merci d'une auto-modification.

Un champ hors de la population autorisée pour l'appelant est **rejeté
(400)**, jamais silencieusement ignoré : un appelant ne doit jamais
croire avoir modifié un champ qui ne l'a pas été.

Écrit **toujours via le rôle service**, après ces vérifications
applicatives : la RLS actuelle (`licencies_all_club_admin`) ne couvre que
le `club_admin`, jamais un·e licencié·e éditant sa propre fiche — et
PostgreSQL ne compare pas nativement une valeur `OLD` à une valeur `NEW`
par colonne dans une policy `WITH CHECK` (une policy self-service
"colonne par colonne" serait fragile à écrire et à auditer). Aucune
policy RLS UPDATE additionnelle n'a donc été ajoutée pour le
self-service : sans elle, un appel direct à l'API REST Supabase avec le
JWT du licencié serait de toute façon rejeté par la RLS — la restriction
de champs n'existe donc QUE dans ce endpoint applicatif, jamais comme un
filet de sécurité optionnel.

`photoUrl` suit exactement la même convention que `ClubDto.logoUrl`
(`modules/clubs/routes.ts`) : une simple URL validée, jamais un pipeline
d'upload de fichier dans ce backend.

## Frontend (ball-manager-web)

- `GET /c/:clubSlug/joueurs` — roster du club, tri alphabétique, lien vers
  chaque fiche (`features/licencies` n'existe pas côté ball-manager-web, tout vit dans
  `app/c/[clubSlug]/joueurs/`).
- `GET /c/:clubSlug/joueurs/:licencieId` — la fiche joueur elle-même :
  identité, tableau des matchs avec statistiques par match, et le
  formulaire d'édition (`LicencieProfileEditForm`, `features/licencies/`)
  quand `canEdit` — le `mode` ("admin" vs "self") est décidé CÔTÉ SERVEUR
  dans la page (`isClubAdmin(club.roles)` sinon `profile.isSelf`), jamais
  recalculé côté client : le formulaire n'affiche que les champs pertinents,
  mais c'est de toute façon ball-manager-back qui reste la seule source de
  vérité sur ce qui est réellement accepté (rejet 400 sinon).
- Depuis l'onglet "Statistiques" d'un match (`matchs/[id]/page.tsx`), le
  nom d'un·e joueur·se devient un lien vers sa fiche dès que
  `PlayerMatchStatsDto.licencieId` est renseigné (ajouté à ce DTO pour
  cette demande — absent avant, voir `contracts/matches.ts`).
- Carte "Joueurs" ajoutée au dashboard du club, à côté de "Matchs".

## Ce qui n'est PAS fait

- Pas d'UI pour rattacher un compte Supabase Auth à un `licencies`
  (`club_memberships.licencie_id` reste un geste manuel en base) —
  point d'extension naturel si le club veut que les joueur·se·s
  s'auto-servent sans passer par un admin à chaque fois.
- Pas d'auto-provisionnement pour les entraîneurs (`match_coaches`),
  demande explicitement scopée aux joueurs ("associer chaque JOUEUR à sa
  licence") — même mécanisme trivialement extensible si demandé.
- Pas d'upload de photo (URL uniquement, voir plus haut) ni de pipeline de
  recadrage/redimensionnement.

## Import en masse depuis un export FBI — "ajoute les tous stp"

Demande du club, 2026-09-28, avec l'export réel de `rechercherLicence.fbi`
(critère "Validation" = "Validé") joint en pièce jointe (.xlsx, 140 lignes) :
**"Voici la liste des licenciés, ajoute les tous stp, a lavenir yen aura
dautres, faudra ignorer les doublons dans les exports. Fais moi un truc ou
jpeux glisser les cartes pr les mettre d'une equipe a lautre"**.

`POST /v1/clubs/:clubId/licencies/import` (`club_admin`) reçoit un tableau
de lignes déjà normalisées en JSON (le parsing du fichier XLSX/CSV réel se
fait côté ball-manager-web, jamais dans ce backend). Colonnes RÉELLES confirmées par
l'export fourni : "N° national" (`ffbbLicenceId`), "Numéro" (`licenseNumber`),
"Nom"/"Prénom", "Né(e) le" (converti en ISO côté ball-manager-web), "Catégorie"
(`categoryLabel`), "Sexe".

**Dédoublonnage** : `ffbbLicenceId` ("N° national") est LA clé stable d'une
personne physique côté FFBB — `license_number` ("Numéro") peut changer d'une
saison à l'autre, jamais fiable pour dédupliquer des imports répétés dans le
temps. Contrainte unique `(club_id, ffbb_licence_id)` (migration
`20260928020000_licencies_ffbb_import.sql`) : une ligne déjà connue est
IGNORÉE (`skipped`), jamais mise à jour (un club_admin ayant depuis corrigé
un champ à la main ne doit jamais se faire écraser par le prochain import)
ni dupliquée. Réponse `{total, inserted, skipped}` — confirmation exacte de
ce qui a réellement été ajouté.

Un import ne touche JAMAIS `teamId`/`active`/`photoUrl`/`email`/`phone` d'un
licencié existant, et n'assigne JAMAIS `teamId` à l'insertion (toujours
`null`) — l'export FBI ne dit pas à quelle équipe DU CLUB (il peut y en
avoir plusieurs par catégorie, ex. SM1/SM2/SF, voir docs/TEAMS.md)
appartient une personne. L'affectation reste un geste manuel exclusif de
`club_admin`, via le glisser-déposer côté ball-manager-web (`PATCH .../profile` avec
`teamId`, déjà existant — aucune nouvelle route nécessaire pour ça).

Les 8 licenciés déjà auto-provisionnés (voir plus haut) avant cette
migration n'avaient pas de `ffbb_licence_id` : enrichis manuellement en base
(par correspondance sur `license_number`) lors de l'import initial de
l'export du club, jamais par un backfill deviné dans le code applicatif.

## Répartition automatique par équipe — "on a une info pour commencer"

Demande du club, 2026-09-28, immédiatement après l'import initial (tous les
licenciés se sont retrouvés "Sans équipe") : **"c super par contre ils sont
tous sans équipe, alors qu'on a une info pour commencer déjà a les mettre
dans les équipes, si ya 2 equipes pour 1 catégorie, met tous dans 1 seule
pour linstant"**.

`POST /v1/clubs/:clubId/licencies/auto-assign-teams` (`club_admin`) traite
TOUS les licenciés sans équipe (`team_id is null`) du club en un seul appel
— voir `modules/licencies/auto-assign-teams.ts` pour l'algorithme complet
(`resolveTeamForLicencie`, fonction PURE et testée) :

1. Catégorie FFBB (`licencies.category_label`) comparée aux catégories
   RÉELLES des équipes actives du club (`teams.category`) — jamais un
   identifiant d'équipe codé en dur, entièrement dérivé des données. Une
   catégorie jeune manquante (ex. le club n'a pas d'équipe "U9") est
   rattachée à l'équipe existante la plus proche PAR LE HAUT (surclassement,
   pratique réelle d'un petit club), borné à 2 ans d'écart maximum — au-delà
   (ex. U5/U7 face à une équipe U11 seulement), le licencié reste SANS
   équipe plutôt qu'un rattachement trompeur.
2. U19/U20/U21 (ou "Seniors" directement) basculent vers l'équipe Seniors
   si le club en a une — trop âgés pour toute équipe jeune.
3. Sexe (`licencies.sexe`) préféré quand plusieurs équipes existent pour la
   même catégorie (ex. "Seniors 1" F et "Seniors 1 M" distinctes, voir
   `util/team-name.ts`) — jamais un mélange aveugle.
4. **"si ya 2 equipes pour 1 catégorie, met tous dans 1 seule pour
   linstant"** : parmi les équipes restantes (même catégorie, même sexe si
   possible), la plus petite `numeroEquipe` est choisie systématiquement —
   déterministe, jamais un tirage différent d'une exécution à l'autre.

Reste un point de DÉPART, jamais une vérité définitive : un licencié déjà
affecté (même approximativement) n'est JAMAIS réécrit par cette route, et
le glisser-déposer (`PATCH .../profile`, page /joueurs côté ball-manager-web) reste le
moyen de corriger un rattachement approximatif au cas par cas.

## Suppression définitive — "faut aussi un bouton pour supprimer un licencié"

Demande du club, 2026-09-28. `DELETE /v1/clubs/:clubId/licencies/:licencieId`
(`club_admin`) — sûre SANS CONDITION : toutes les tables qui référencent
`licencies.id` (`match_participants`/`match_coaches`/`match_officials`/
`match_table_officials`/`club_memberships`) le font en `on delete set null`
(voir les migrations d'origine, phase 0/1) — jamais un blocage ni une
cascade. L'historique et les statistiques d'un match ne sont JAMAIS perdus :
`match_participants`/`match_coaches`/etc. stockent leur PROPRE nom/prénom/
n° de licence extraits de l'e-Marque, indépendamment de `licencies` (voir
leur commentaire de table) — seul le LIEN vers cette fiche précise est
détaché.

Jamais un archivage déguisé : pour un·e licencié·e qui a quitté le club
mais dont on veut garder la fiche/l'historique, `PATCH .../profile` avec
`active: false` (déjà existant) reste le bon geste — la suppression est
pour une fiche créée par erreur/en double, jamais pour "désactiver".

## Import automatique depuis FBI (2026-10-08)

Retour du club : *« faire un système qui importe automatiquement les
licenciés, c'est une galère de le faire manuellement, faut être technique,
et faut que tout soit pour les nuls »*.

- **Chaque jour** (job `import_licences`, empilé avec le calendrier et les
  dérogations par `enqueueFbiVerificationJobsForClub`) et **sur demande**
  (`POST /v1/clubs/:clubId/licencies/import/fbi`, bouton de la page
  Joueurs) : dans la session FBI du club, écran « Gestion des licences »
  (`rechercherLicence.fbi`), filtre « Validation : Validé », RECHERCHER,
  puis bouton Excel ; le fichier est lu en mémoire, jamais stocké
  (`BrowserFbiClient.downloadValidatedLicencesExport`,
  `jobs/process-import-licences.ts`).
- **Secours sans FBI** : l'admin dépose le fichier Excel téléchargé
  lui-même (`POST …/licencies/import/file`, multipart `file`). Même
  traitement.
- Lecture : `modules/licencies/fbi-licence-export.ts` (en-têtes réels :
  N° national, Numéro, Nom, Prénom, Né(e) le, Catégorie, Sexe…).
- Mise à jour : `modules/licencies/sync-from-fbi.ts`. Rapprochement par
  N° national, sinon par numéro de licence pour une fiche créée sans
  N° national. Catégorie, sexe et numéro suivent FBI ; date de naissance
  seulement si absente ; **nom, prénom, email, téléphone, photo, équipe et
  rôles jamais modifiés**. Fiche désactivée qui réapparaît : réactivée.
  Fiche absente de l'export : comptée (`notInExport`), **jamais désactivée
  automatiquement**.
- Historique : `licence_import_runs` (compteurs seulement), lu par
  `GET …/licencies/import/status` pour « Dernière mise à jour ».
- Simulation sur la base réelle avant mise en service (fichier du club du
  2026-10-08, 190 licences validées) : 9 nouveaux, 1 fiche rattachée par
  numéro de licence, 180 inchangés, 0 absent.
