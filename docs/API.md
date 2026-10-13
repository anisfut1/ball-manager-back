# API

> Inventaire complet et à jour de toutes les routes : [API_ROUTES.md](API_ROUTES.md) (généré par `npm run docs:routes`).

Spec complète et à jour : `GET /openapi.json` (générée depuis `src/contracts/*.ts`
via `src/openapi.ts`) ou `GET /docs` (Swagger UI). Ce document donne la vue
d'ensemble ; ne le laisse pas diverger de la génération automatique — en
cas de doute, la spec générée fait foi.

## Versionnage

Toutes les routes destinées au frontend sont sous `/v1/...`. Une route
n'existe que si elle correspond à un vrai service déjà construit — voir
`docs/MIGRATION.md` pour ce qui a été volontairement laissé de côté.

## Routes `/v1`

| Méthode | Route | Rôle requis |
|---|---|---|
| GET | `/v1/me` | authentifié |
| GET | `/v1/clubs` | authentifié (clubs dont il est membre) |
| GET | `/v1/clubs/:clubId` | membre du club |
| PATCH | `/v1/clubs/:clubId` | club_admin |
| GET | `/v1/clubs/:clubId/capabilities` | membre du club |
| GET | `/v1/clubs/:clubId/teams` | membre du club |
| POST | `/v1/clubs/:clubId/teams` | club_admin (voir docs/TEAMS.md) |
| PATCH | `/v1/clubs/:clubId/teams/:teamId` | club_admin |
| GET | `/v1/clubs/:clubId/matches` | membre du club |
| GET | `/v1/clubs/:clubId/matches/:matchId` | membre du club |
| GET | `/v1/clubs/:clubId/matches/:matchId/documents` | membre du club (URL de téléchargement réservée à club_admin) |
| GET | `/v1/clubs/:clubId/matches/:matchId/derogation` | membre du club (dernier état connu, voir docs/FBI.md) |
| POST | `/v1/clubs/:clubId/matches/:matchId/derogation/check` | club_admin (empile une vérification, voir docs/FBI.md) |
| GET | `/v1/clubs/:clubId/emarque-imports` | membre du club |
| GET | `/v1/clubs/:clubId/licencies` | membre du club |
| GET | `/v1/clubs/:clubId/licencies/:licencieId` | membre du club (fiche joueur, voir docs/LICENCIES.md) |
| PATCH | `/v1/clubs/:clubId/licencies/:licencieId/profile` | club_admin (tous les champs), ou le licencié lui-même (contact/photo uniquement) |
| GET | `/v1/clubs/:clubId/integrations` | membre du club |
| PATCH | `/v1/clubs/:clubId/integrations/ffbb` | club_admin |
| PATCH | `/v1/clubs/:clubId/integrations/fbi` | club_admin |
| POST | `/v1/clubs/:clubId/integrations/fbi` | club_admin |
| POST | `/v1/clubs/:clubId/integrations/fbi/test` | club_admin |
| POST | `/v1/clubs/:clubId/integrations/fbi/reconcile-schedule` | club_admin (empile un rapprochement calendrier FFBB/FBI, voir docs/FBI.md) |
| POST | `/v1/clubs/:clubId/integrations/ffbb/sync` | club_admin |
| GET | `/v1/clubs/:clubId/sync-runs` | membre du club |
| GET | `/v1/clubs/:clubId/issues` | membre du club |
| POST | `/v1/clubs/:clubId/issues/:matchId/resolve` | club_admin |
| GET | `/v1/jobs/:jobId` | authentifié (RLS filtre par club) |
| GET | `/v1/platform/clubs` | platform_admin |
| POST | `/v1/platform/clubs` | platform_admin |
| POST | `/v1/platform/maintenance/purge-emarque-documents` | platform_admin (idempotent, voir docs/EMARQUE.md) |
| POST | `/v1/platform/maintenance/delete-old-seasons` | platform_admin (IRRÉVERSIBLE, `clubId` obligatoire) |
| POST | `/v1/platform/maintenance/retry-failed-emarque-imports` | platform_admin (réutilise le fichier déjà téléchargé, voir docs/EMARQUE.md) |

`:clubId` accepte un UUID ou un slug (voir `tenancy/club-context.ts`).

## Frontend API gaps résolus

Cette section documente les 8 écarts identifiés lors de la migration du
frontend ball-manager-web vers cette API (voir `docs/MIGRATION.md` côté ball-manager-web), et
comment chacun a été comblé. Objectif : **aucun gap connu** restant côté
frontend après cette phase.

1. **`PATCH /v1/clubs/:clubId`** — édition du branding club (`name`,
   `shortName`, `timezone`, `logoUrl`, `accentColor`) par `club_admin`
   uniquement. Ne peut jamais toucher `status`/`slug`/`ffbb_club_id`/
   `ffbb_enabled` : verrouillé au niveau colonne PostgreSQL (`revoke
   update on public.clubs from authenticated; grant update (name,
   short_name, logo_url, accent_color, timezone) ...`,
   `20260921100090_rls_multitenant_rewrite.sql`), pas seulement par le
   DTO Zod — vérifié contre un vrai PostgreSQL (`supabase/tests/isolation_test.sql`).
   `timezone` validé via `Intl.supportedValuesOf("timeZone")`.
2. **`ffbbClubCode`** — `ClubDto` expose désormais le code club FFBB sous
   ce nom explicite (jamais `ffbbClubId`, pour ne pas le confondre avec
   l'UUID interne). Changement de ce code : route dédiée
   `PATCH /v1/clubs/:clubId/integrations/ffbb` (`{clubCode, enabled}`),
   qui ne supprime jamais l'historique déjà synchronisé et replanifie
   `next_sync_at = now()` en cas de changement de code.
3. **`GET /v1/me`** — retourne désormais `displayName` (avec repli propre
   sur l'email si le profil n'a pas de nom, jamais d'identité inventée) en
   plus de `id`/`email`/`isPlatformAdmin`.
4. **`PATCH /v1/clubs/:clubId/integrations/fbi`** — active/désactive
   `autoImportEmarque` ou l'intégration sans jamais redemander
   username/password. Erreur métier `FBI_NOT_CONFIGURED` (409) si on tente
   d'activer sans identifiants déjà enregistrés ; `enabled: false` reste
   toujours permis.
5. **`GET /v1/clubs/:clubId/emarque-imports`** — liste tenant-scopée des
   imports e-Marque (filtres `matchId`/`status`/`from`/`to`, pagination
   `limit`/`offset`, défaut 20, max 100). Le détail de match
   (`GET .../matches/:matchId`)
   expose aussi `parserVersion`/`discoveredAt`/`importedAt`/
   `qualityWarnings`/`lastError` — `lastError` toujours assaini
   (`sanitizeEmarqueError`, jamais le message brut de l'exception).
6. **`IssueDto`** — enrichi avec `type`/`severity`/`status`/`message`
   (utilisateur) séparé de `technicalCode` (machine), `matchId`,
   `integration`, `qualityWarnings`, `createdAt`/`resolvedAt`. Jamais de
   stack trace ni de détail interne brut.
7. **`GET /v1/clubs/:clubId/matches`** — filtres serveur (`from`/`to` ISO
   8601, `teamId`, `homeAway` relatif au club du tenant, `status`) et
   raccourci `period=weekend` (calcul DST-safe dans le fuseau horaire du
   club, `src/util/timezone.ts`). `period` et `from`/`to` sont mutuellement
   exclusifs (400 sinon). `teamId` d'un autre club ne fuit jamais
   (résultat vide, jamais une erreur).
8. **Username FBI** — `GET /v1/clubs/:clubId/integrations` (et la réponse
   de `PATCH .../fbi`) exposent le username FBI configuré en clair
   (jamais masqué) pour `club_admin`/`platform_admin`, mais jamais le
   mot de passe, le ciphertext, l'IV ou l'auth tag.

## Pagination

`GET /v1/clubs/:clubId/matches` (défaut 50, max 200) et
`GET /v1/clubs/:clubId/emarque-imports` (défaut 20, max 100) ne renvoient
jamais un dump complet non borné : pagination `limit`/`offset` sur les
deux, limite par défaut et maximum documentés dans le schéma OpenAPI
(`MatchesQueryDtoSchema`, `EmarqueImportsQueryDtoSchema`).

## Routes `/internal`

Jamais sous `/v1`, jamais appelables par un utilisateur classique — voir
`docs/JOBS.md`. Protégées par `Authorization: Bearer <CRON_SECRET>`.

| Route | Rôle |
|---|---|
| GET `/internal/cron/ffbb` | synchronise un petit lot de clubs dus |
| GET `/internal/cron/fbi-enqueue` | empile des jobs `discover_emarque` |
| GET `/internal/cron/fbi-jobs` | réclame et traite un petit lot de jobs FBI |
| GET `/internal/cron/emarque-parse` | parse les documents e-Marque téléchargés |

## Async (§36)

Une opération potentiellement longue (ex : test de connexion FBI par
navigateur en secours) répond `202 { jobId }` plutôt que de garder la
connexion HTTP ouverte. Le frontend interroge ensuite `GET /v1/jobs/:jobId`.

## Erreurs

Contrat uniforme, jamais de stack trace en production :

```json
{ "error": { "code": "FORBIDDEN", "message": "Ce rôle (club_admin) est requis sur ce club." } }
```

Codes : `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`BAD_REQUEST` (400), `CONFLICT` (409), `INTERNAL_ERROR` (500).

## CORS

`FRONTEND_ORIGINS` (liste séparée par des virgules) — jamais de wildcard
avec authentification (voir `src/app.ts`).
