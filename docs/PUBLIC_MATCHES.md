# Vue publique des matchs (sans compte)

Retour du club, 2026-09-29 : "je veux une vue publique avec toutes les infos
en vue directe, sans les boutons etc, en gros sans les fonctions admin, et
sans compte, en libre service" — la page `/c/{clubSlug}/matchs` existante
exige une session Supabase. Ce module expose exactement les mêmes données
(calendrier des matchs + fiche détaillée de chaque match) sans authentification
d'aucune sorte.

## Différence avec `PUBLIC_TABLE_ACCESS.md`

Le module Tables de marque (auto-affectation) a besoin d'une identité
personnelle (un jeton par licencié). Celui-ci n'en a **aucun besoin** : il
n'y a rien à posséder, seulement à consulter. Il n'y a donc :

- aucun jeton (`?token=`) ;
- aucun `localStorage` côté frontend ;
- aucune notion de "qui es-tu" — le club lui-même (via son `slug`) est la
  seule chose résolue.

## Ce qui est exposé

Mêmes données que verrait un membre du club **non-admin** authentifié,
réutilisant EXACTEMENT le même moteur (`modules/matches/shared.ts`,
`modules/documents/shared.ts`) que les routes authentifiées — jamais une
divergence de comportement entre les deux :

- `GET /v1/public/clubs/{clubSlug}` — infos club minimales.
- `GET /v1/public/clubs/{clubSlug}/teams` — équipes (pour le filtre).
- `GET /v1/public/clubs/{clubSlug}/matches` — calendrier, mêmes filtres/
  pagination que `GET /v1/clubs/{clubId}/matches` (`period`, `from`/`to`,
  `teamId`, `homeAway`, `status`, `limit`/`offset`).
- `GET /v1/public/clubs/{clubSlug}/matches/{matchId}` — fiche complète :
  informations, composition, statistiques joueurs, officiels, statut
  e-Marque.
- `GET /v1/public/clubs/{clubSlug}/matches/{matchId}/documents` — liste des
  documents e-Marque (jamais l'URL de téléchargement, voir ci-dessous).
- `GET /v1/public/clubs/{clubSlug}/matches/{matchId}/derogation` — dernier
  état connu d'une dérogation FBI pour ce match, lecture seule.

Composition et statistiques incluent les noms des joueurs. Décision
explicite du club (2026-09-29) : ces informations sont déjà publiques via
les feuilles de match e-Marque de la FFBB — cette vue n'expose rien qui ne
soit pas déjà consultable ailleurs.

## Ce qui n'est JAMAIS exposé

- **Aucune URL de téléchargement de document original.** `documents[].downloadUrl`
  vaut toujours `null` sur ce routeur — `loadMatchDocuments(...)` est
  appelé avec `canDownload: false` en dur (jamais une variable), donc
  aucune URL signée n'est même générée. Déjà réservé à `club_admin` côté
  authentifié (§34 de la demande) ; ici, réservé à personne.
- **Aucune écriture.** Ce routeur n'a que des `GET` — pas de "Vérifier sur
  FBI", pas de création/réponse à une dérogation (`club_admin` uniquement,
  restent sur `/v1/clubs/{clubId}/matches/...`).
- Aucune donnée membre/rôle/FFBB credentials — seulement ce qu'un club
  publierait de toute façon.

## Isolation multi-tenant

Comme `public-tables`, toute lecture passe par le client service role
(`resolvePublicClub`, `modules/public/club-resolver.ts` — partagé entre les
deux modules publics) : c'est le code applicatif, pas la RLS, qui garantit
qu'un visiteur ne voit jamais les données d'un autre club. Chaque requête
est manuellement scopée par `club.id` résolu depuis le `slug` de l'URL —
jamais son UUID (le slug seul figure dans le lien public).

## Frontend

`/public/{clubSlug}/matchs` (liste) et `/public/{clubSlug}/matchs/{matchId}`
(détail) côté ball-manager-web, réutilisant les mêmes composants d'affichage que la vue
authentifiée (`MatchTitle`, `HomeMatchesAgenda`, `DerogationCard`) avec
`isAdmin` figé à `false` — jamais un bouton d'action visible.
