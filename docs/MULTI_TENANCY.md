# Multi-tenancy

Modèle repris intact de ball-manager-web (`docs/MULTI_TENANCY.md` original, migration
détaillée dans `docs/MIGRATION.md`) — ce document résume ce qui concerne
directement ce backend.

## Modèle

- `clubs` — le tenant. `id` (UUID) est la clé de scope de toutes les
  tables métier ; `slug` est la forme lisible acceptée en alternative dans
  les routes `/v1/clubs/:clubId/...`.
- `club_memberships` — un utilisateur Supabase Auth peut être membre de
  plusieurs clubs, avec un `id` de membership distinct par club.
- `membership_roles` — un ou plusieurs rôles par membership (`ClubRole`).
- `platform_admins` — opérateur de la plateforme, jamais un rôle de club,
  table séparée sans self-service possible.

## RLS — jamais contournée par l'API

Chaque table métier a `club_id` et des policies RLS scopées via les
fonctions SQL `is_club_member(club_id)` / `has_club_role(club_id, role)` /
`is_platform_admin()` (toutes `SECURITY DEFINER`, `search_path` fixé —
voir `supabase/migrations/20260921100090_rls_multitenant_rewrite.sql`).
Ce backend s'appuie dessus via `createUserSupabaseClient` (voir
`docs/AUTH.md`) plutôt que de réimplémenter des vérifications d'appartenance
en TypeScript qui pourraient diverger de la RLS.

## `getClubCapabilities` — FBI est facultatif

`tenancy/club-capabilities.ts` centralise `{ ffbb, fbi, emarque }` pour un
club donné. Le frontend lit `GET /v1/clubs/:clubId/capabilities` plutôt que
de disperser des `if (fbiCredentials)` — voir `docs/FBI.md`.

## Isolation testée contre un vrai PostgreSQL

`supabase/tests/isolation_test.sql` (38 assertions, voir
`supabase/tests/README.md`) vérifie contre un moteur PostgreSQL réel
(pas un mock) que :

- un membre du Club A ne voit jamais une ligne du Club B, y compris en
  connaissant son UUID, y compris en tentant une écriture directe ;
- `fbi_jobs`/`match_documents` (le pipeline FBI) suivent la même règle ;
- `claim_next_fbi_job` (SECURITY DEFINER) est refusée pour `authenticated`
  et `anon` — corrige une faille réelle détectée pendant cette migration
  (voir `20260921110040_fbi_jobs_execute_lockdown.sql`) où n'importe quel
  utilisateur authentifié aurait pu réclamer et lire le job d'un autre
  club, contournant totalement la RLS ;
- le `service_role` (utilisé par `/internal/*`), lui, traite bien les jobs
  des deux clubs sans jamais les mélanger.

## Ce que l'API ajoute par rapport à la RLS seule

La RLS empêche une fuite de données. Elle n'empêche pas un mauvais
paramètre de route de renvoyer un 404 plutôt qu'un 403 de façon cohérente,
ni de composer proprement `requireClubRole` par-dessus `requireClubMembership`.
C'est le rôle de `src/auth/middleware.ts` — voir `docs/AUTH.md`.
