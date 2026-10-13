# Migration depuis ball-manager-web — audit

Origine : repository `ball-manager-web` (frontend historique), branche
`claude/sete-basket-app-architecture-c3hlxx`, commit `5deeaa4`. ball-manager-web
**n'a pas été modifié** par cette migration — voir la section
"Duplication temporaire" ci-dessous.

## Migré verbatim (aucune logique changée)

- `security/crypto.ts` (AES-256-GCM, AAD=club_id).
- `tenancy/club-capabilities.test.ts`, la logique de `roles.ts`.
- `integrations/fbi/{action-classification,cookie-jar,http-client}.ts` et
  leurs tests.
- `integrations/emarque/**` (extracteurs, layout, normalizers, parser,
  quality, schemas, persist) — seuls les imports (`@/types/database` →
  `@/db/types`, retrait des marqueurs `server-only`) ont changé.
- `supabase/migrations/*.sql` (34 fichiers) — copiés dans leur ordre
  historique, jamais fusionnés en un `initial.sql` unique.
- `supabase/tests/{00_local_postgres_shim_before_migrations.sql,
  01_local_postgres_shim_after_migrations.sql, fixtures.sql,
  isolation_test.sql}` — 42 assertions PostgreSQL réelles (38 + 4 ajoutées
  lors de la résolution des gaps frontend, voir plus bas), toutes encore
  vertes depuis ce repository.

## Résolution des gaps API identifiés par le frontend (ball-manager-web)

Après la migration du frontend ball-manager-web vers cette API (`docs/MIGRATION_TO_API.md`
côté ball-manager-web), 8 écarts API (`BACKEND_API_GAP`) ont été documentés puis
comblés **uniquement dans ce repository**, sans toucher ball-manager-web — voir
`docs/API.md` (section "Frontend API gaps résolus") pour le détail des 8
points, et `docs/FFBB.md`/`docs/FBI.md`/`docs/EMARQUE.md` pour les
sections spécifiques à chaque intégration. La prochaine étape côté ball-manager-web
est de relancer `npm run api:generate` contre le nouvel `/openapi.json`
généré par cette API — non fait depuis ce repository.

## Adapté (logique conservée, code déplacé/reconnecté)

- `tenancy/club-context.ts` — signature changée pour accepter
  `(supabase, clubIdOrSlug, userId)` directement plutôt que de dépendre
  du contexte de requête Next.js.
- `integrations/ffbb/{directus-client,public-provider,mapping,sync,
  scheduler}.ts` — retrait des imports `server-only`, alias corrigés.
  Un bug d'auto-introduit pendant la copie (`scheduler.ts` important
  `./sync-ffbb` au lieu de `./sync`) a été détecté et corrigé pendant la
  vérification `tsc`.
- `integrations/fbi/errors.ts` — fusion de deux fichiers auparavant
  dupliqués entre `app/` et `worker/` côté ball-manager-web (`NAVIGATION_FAILED`
  n'existait que côté worker) : ce repository n'a plus qu'un seul
  consommateur des deux stratégies FBI, donc plus qu'un seul fichier
  d'erreurs.
- `storage/emarque-storage.ts` — fusion de deux versions légèrement
  divergentes (`resolveSeasonLabel` était dupliqué), toutes les fonctions
  prennent maintenant un `supabase: DbClient` explicite en paramètre
  plutôt qu'un client implicite.
- `integrations/fbi/browser-client.ts` (`BrowserFbiClient`) — logique
  Playwright conservée, mais le navigateur est maintenant lancé et fermé
  à chaque invocation de Vercel Function (`launchServerlessBrowser()` +
  `finally { browser.close() }`) plutôt que gardé vivant par un process
  worker long-running (voir `docs/FBI.md`, `docs/JOBS.md`).
- `jobs/{claim,backoff,process-test-connection,process-discover-emarque,
  enqueue-emarque,parse-downloaded-documents}.ts` — logique de file
  d'attente et de backoff conservée à l'identique ; seule la mécanique
  d'invocation change (cron Vercel → route `/internal/*`, plutôt qu'une
  boucle de polling dans un process worker Railway).

## Nouveau dans ce repository (n'existait pas côté ball-manager-web sous cette forme)

- Toute la couche API REST : `src/app.ts`, `src/api/{v1,internal}/`,
  `src/modules/**/routes.ts`, `src/contracts/**` (DTOs zod),
  `src/openapi.ts` — ball-manager-web exposait ces données via des Server Components
  et Server Actions Next.js, jamais une API REST versionnée.
- `src/auth/{jwt,context,middleware}.ts` — la vérification JWT +
  membership + rôle était auparavant implicite dans le rendu serveur
  Next.js (accès direct à la session) ; elle est maintenant un middleware
  HTTP explicite, réutilisable par n'importe quelle route.
- `src/integrations/fbi/browser-launcher.ts` — n'existait pas car le
  worker ball-manager-web tournait sur une machine Railway avec Chromium installé
  nativement ; ce fichier gère spécifiquement le lancement de Chromium
  serverless (`@sparticuz/chromium`) requis par Vercel.
- `src/config/env.ts` — schéma d'environnement unifié (ball-manager-web séparait la
  validation d'environnement entre `app/` et `worker/`).

## Explicitement PAS migré (backend only)

Conformément à la demande ("Ce repository est BACKEND ONLY") :

- Aucun composant React, page Next.js, layout, navigation, dashboard ou
  page d'administration frontend.
- Le package `worker/` de ball-manager-web n'a pas été migré tel quel comme
  application déployable séparément — sa logique a été redistribuée dans
  les trois phases cron de `src/jobs/` (voir `docs/JOBS.md`). Toute
  référence à Railway, Render ou Fly.io a disparu de l'architecture
  cible et de la documentation.
- `docs/FBI_AUTHENTICATED_SPIKE.md` et `docs/FFBB_ECOSYSTEM_RESEARCH.md`
  (spikes de recherche antérieurs côté ball-manager-web) — non recopiés, seulement
  référencés depuis `docs/FFBB.md`/`docs/FBI.md` comme contexte
  historique ; ils restent dans ball-manager-web.
- Dérogations/tables de marque FBI authentifié au-delà de
  `listDerogations()` mentionné comme extension prévue non implémentée
  (voir `docs/FBI.md`).

## Tests — couverture récupérée

ball-manager-web comptait, au commit de référence, environ 158 tests côté `app/`, 44
côté `worker/`, et 38 assertions PostgreSQL. Répartition dans ce
repository (tests UI Next.js exclus par nature — ils restent dans ball-manager-web) :

- **189 tests** (26 fichiers Vitest) couvrant : crypto, tenancy/roles/
  capabilities/club-context, FFBB (mapping, scheduler), FBI (action
  classification, cookie jar, client HTTP, classification de statut de
  login, détection de type de document, client Playwright contre des
  fixtures HTML synthétiques, magasin d'identifiants chiffrés), jobs
  (claim, backoff, les 3 phases), et les 5 fichiers de tests e-Marque
  transférés sans changement depuis ball-manager-web.
- **38/38 assertions PostgreSQL** (`isolation_test.sql`) toujours vertes
  depuis ce repository, contre le même moteur PostgreSQL réel (pas un
  mock).

La couverture n'est pas un report ligne à ligne des 158+44 tests ball-manager-web —
certains testaient des détails d'intégration Next.js (Server Actions,
rendu) qui n'ont pas d'équivalent ici par nature. La logique métier
(mapping FFBB, classification FBI, parsing e-Marque, crypto, RLS) est
couverte de façon au moins équivalente.

## Duplication temporaire avec ball-manager-web

Le code métier (FFBB, FBI, e-Marque, tenancy, crypto) existe pour l'instant
**dans les deux repositories** : ball-manager-web n'a pas été modifié et continue de
fonctionner avec sa propre copie tant que le frontend n'a pas été
reconnecté pour appeler `ball-manager-back` à la place de ses Server
Actions actuelles. Cette duplication est explicitement temporaire — le
jour où le frontend bascule (hors périmètre de cette tâche, "Ne modifie
PAS encore le frontend"), le code correspondant devient mort côté ball-manager-web et
peut être supprimé.

Les deux repositories pointent vers **le même projet Supabase** — la
séparation ne concerne que le code, jamais les données (§ instruction
explicite).
