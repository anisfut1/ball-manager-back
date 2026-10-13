# ball-manager-back

Backend REST du SaaS multi-clubs (FFBB / FBI / e-Marque). TypeScript, [Hono](https://hono.dev/), déployé comme fonctions Vercel. Aucune infrastructure autre que **Vercel** et **Supabase** (PostgreSQL, Auth, Storage) — voir `docs/DEPLOYMENT.md`.

Ce dépôt est le résultat d'une migration depuis le dépôt frontend historique
[ball-manager-web](https://github.com/anisfut1/scsb) (commit `5deeaa4`) : voir
`docs/MIGRATION.md` pour le détail de ce qui a été repris tel quel, adapté,
ou volontairement laissé de côté (le frontend Next.js reste dans ball-manager-web).

## Démarrage rapide

```bash
npm install
cp .env.example .env   # remplir SUPABASE_URL, SUPABASE_ANON_KEY,
                        # SUPABASE_SERVICE_ROLE_KEY, FBI_CREDENTIALS_ENCRYPTION_KEY,
                        # CRON_SECRET, FRONTEND_ORIGINS
npm run dev             # http://localhost:3001
```

- `GET /health` — sans auth.
- `GET /openapi.json` — spec OpenAPI générée depuis les DTO zod.
- `GET /docs` — Swagger UI (`/openapi.json`).
- `GET /v1/...` — API destinée au frontend (JWT Supabase Auth requis).
- `GET|POST /internal/...` — cron/jobs internes (protégés par `CRON_SECRET`, jamais appelables par un utilisateur).

## Vérifications

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Tests PostgreSQL réels (RLS) : voir `supabase/tests/README.md`.

## Architecture

Voir `ARCHITECTURE.md` pour la vue d'ensemble, et `docs/` pour le détail par domaine :

| Document | Contenu |
|---|---|
| `docs/API.md` | Routes `/v1` et `/internal`, contrat d'erreur, pagination |
| `docs/AUTH.md` | Flux JWT Supabase Auth → middleware → RLS |
| `docs/MULTI_TENANCY.md` | Modèle club/membership/rôles, isolation |
| `docs/FFBB.md` | Intégration API publique FFBB (calendrier, obligatoire) |
| `docs/FBI.md` | Intégration FBI (optionnelle), HTTP vs navigateur, limites Vercel réelles |
| `docs/EMARQUE.md` | Pipeline documents + parsing e-Marque |
| `docs/JOBS.md` | File `fbi_jobs`, claim atomique, retry/backoff |
| `docs/DEPLOYMENT.md` | Déploiement Vercel, variables, cron |

## Ce que ce dépôt N'EST PAS

Backend uniquement — aucun React, page, composant UI. Le frontend (ball-manager-web)
continue de fonctionner de façon autonome pendant la transition ; il
n'appelle pas encore cette API (voir `docs/MIGRATION.md`, "Duplication
temporaire").
