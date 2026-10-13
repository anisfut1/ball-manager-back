# Jobs — file d'attente PostgreSQL, jamais Redis ni service externe

Aucune infrastructure au-delà de Vercel + Supabase (§ contrainte
fondamentale de cette migration). La file d'attente est une table
PostgreSQL, `fbi_jobs`, conservée telle quelle depuis ball-manager-web — jamais
réécrite ni généralisée sans raison (§ "ne réécris pas inutilement ce qui
fonctionne").

## Schéma (`fbi_jobs`)

Colonnes clé : `id`, `club_id`, `type` (`test_connection` |
`discover_emarque` | `parse_document`), `status` (`pending` | `running` |
`waiting` | `error` | `done`), `payload` (jsonb), `attempts`,
`next_attempt_at`, `last_error`, timestamps. RLS : aucune policy
`authenticated` en écriture sur les colonnes de traitement — seul le
`service_role` (`/internal/*`) peut réclamer et faire progresser un job
(voir la note de sécurité ci-dessous). Les utilisateurs authentifiés
peuvent uniquement *lire* le statut d'un job de leur propre club via
`GET /v1/jobs/:jobId` (RLS scope classique `is_club_member`).

## `claim_next_fbi_job` — réclamation atomique

Fonction SQL `SECURITY DEFINER`, `FOR UPDATE SKIP LOCKED` : plusieurs
invocations concurrentes de la même cron route ne réclament jamais deux
fois le même job, et une invocation bloquée sur un job ne bloque pas les
autres (`SKIP LOCKED` passe au suivant plutôt que d'attendre un verrou).

**Historique de sécurité conservé** — `claim_next_fbi_job` a été
verrouillée à `service_role` uniquement par
`supabase/migrations/20260921110040_fbi_jobs_execute_lockdown.sql`, suite
à une faille réelle détectée pendant le développement initial (ball-manager-web) :
avant cette migration, n'importe quel utilisateur `authenticated` pouvait
appeler la fonction directement et réclamer/lire le job d'un **autre**
club, contournant totalement la RLS de `fbi_jobs`. Le test de régression
qui a détecté cette faille est conservé intégralement dans
`supabase/tests/isolation_test.sql` (voir `docs/MULTI_TENANCY.md`) — il
vérifie explicitement que `authenticated` et `anon` reçoivent une erreur
de permission, et que seul `service_role` peut réclamer, sans jamais
mélanger les clubs.

## Backoff — deux échelles distinctes

`src/jobs/backoff.ts`, reprises sans changement de ball-manager-web :

- **`nextWaitingBackoffSeconds`** (document pas encore disponible côté
  FBI/e-Marque — ce n'est pas une erreur, juste "pas encore prêt") :
  30 min → 2 h → 6 h → 24 h, puis 24 h en boucle.
- **`nextErrorBackoffSeconds`** (échec réel — connexion FBI, page
  inattendue, erreur réseau) : 5 min → 15 min → 1 h → 4 h.

Distinguer les deux évite qu'un match qui n'a simplement pas encore sa
feuille de match remplie ne soit traité comme une panne, et inversement
qu'une vraie panne ne soit retentée toutes les 30 minutes indéfiniment.

## Traitement par petits lots — jamais tout en une invocation

Chaque route `/internal/cron/*` traite un **petit** lot fixe par
invocation (voir les tailles de lot dans `integrations/ffbb/config.ts` et
les jobs eux-mêmes) puis rend la main — le cron suivant (Vercel Cron,
`vercel.json`) reprend là où le précédent s'est arrêté. Aucune boucle
interne ne vide toute la file en un seul appel : ceci respecte à la fois
la contrainte de durée des Vercel Functions (voir `docs/FBI.md` pour les
chiffres Fluid Compute) et évite qu'un pic de jobs sur un club ne prive
les autres clubs de traitement.

## Les trois phases, trois routes cron indépendantes

Reprend la séparation des responsabilités de l'ancien `worker/` ball-manager-web,
mais comme trois Vercel Functions déclenchées par cron plutôt qu'un
process long-running séparé (§ "Railway/Render/Fly.io doit disparaître de
l'architecture cible") :

| Phase | Route | Fichier | Playwright ? |
|---|---|---|---|
| **Enqueue** | `GET /internal/cron/fbi-enqueue` | `jobs/enqueue-emarque.ts` | Non — requête SQL simple, empile des jobs `discover_emarque` pour les matches FFBB fraîchement synchronisés qui déclenchent e-Marque (`shouldRequestEmarque`, voir `docs/FFBB.md`) |
| **Process** | `GET /internal/cron/fbi-jobs` | `jobs/process-discover-emarque.ts`, `jobs/process-test-connection.ts` | Oui — `launchServerlessBrowser()` par invocation, fermé en `finally` |
| **Parse** | `GET /internal/cron/emarque-parse` | `jobs/parse-downloaded-documents.ts` | Non — réutilise le pipeline OCR/PDF (voir `docs/EMARQUE.md`) |

Chaque route est protégée par `Authorization: Bearer <CRON_SECRET>` — voir
`docs/API.md`, `docs/DEPLOYMENT.md`. Aucun utilisateur classique ne peut
les appeler.

## Ce qui n'a PAS été généralisé

`fbi_jobs` reste nommée ainsi (pas de renommage en `jobs` générique) —
elle ne porte aujourd'hui que des jobs liés à FBI/e-Marque, et la
généraliser sans un second type de job réel serait une abstraction
prématurée.
