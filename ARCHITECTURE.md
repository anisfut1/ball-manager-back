# Architecture — ball-manager-back

## 1. Vue d'ensemble

```
FRONTEND (ball-manager-web, Next.js, Vercel)
   │ HTTPS + Authorization: Bearer <JWT Supabase Auth>
   ▼
ball-manager-back (Hono, Vercel Functions)
   │
   ├── /v1/*        — API façade métier (JWT requis, RLS appliquée)
   └── /internal/*  — cron/jobs (CRON_SECRET requis, jamais côté frontend)
   │
   ▼
Supabase (PostgreSQL + Auth + Storage) — MÊME instance que ball-manager-web
   │
   ▼
Services externes : FFBB (api.ffbb.app), FBI (extranet.ffbb.com)
```

Le navigateur du frontend n'appelle **jamais** directement FFBB, FBI, ou
e-Marque : tout passe par cette API. Supabase Auth reste utilisé
directement par le frontend pour le login/la session (§9/§11 de la
demande) ; les données métier, elles, passent par ici.

## 2. Un seul point d'entrée Vercel

`api/index.ts` est l'unique fonction Vercel — `vercel.json` réécrit toutes
les requêtes vers elle (`rewrites`), Hono (`src/app.ts`) route ensuite en
interne vers `/v1/*`, `/internal/*`, `/health`, `/openapi.json`, `/docs`.
Pas de fonction par route : un seul cold start à amortir, un seul endroit
où lire `vercel.json` pour comprendre le déploiement (§51/§52 de la
demande : configuration minimale).

## 3. Structure du code

```
src/
  app.ts              — assemblage Hono (CORS, erreurs, montage des routes)
  api-error.ts         — ApiError + contrat d'erreur uniforme
  logger.ts            — logs JSON structurés
  openapi.ts            — spec OpenAPI générée depuis contracts/

  config/env.ts         — validation zod des variables d'environnement

  db/
    types.ts            — types du schéma PostgreSQL (source : supabase/migrations/)
    client.ts            — client service role + client "au nom de l'utilisateur"

  security/crypto.ts     — AES-256-GCM (identifiants FBI), AAD = club_id

  auth/
    jwt.ts               — validation du JWT Supabase Auth
    context.ts           — types des variables Hono (RequestContext)
    middleware.ts         — requireAuth / requireClubMembership / requireClubRole / requirePlatformAdmin

  tenancy/
    roles.ts             — ClubRole, helpers purs
    club-context.ts        — résolution club + membership + rôles (RLS-bound)
    club-capabilities.ts    — FBI est facultatif : { ffbb, fbi, emarque }

  integrations/
    ffbb/                — client Directus public FFBB, mapping, sync, scheduler
    fbi/                 — HttpFbiClient (principal), BrowserFbiClient (secours), classification lecture/écriture
    emarque/              — parser OCR/PDF (inchangé depuis ball-manager-web), schémas, persistance

  storage/emarque-storage.ts — chemins Storage, upload/download/URL signée

  jobs/                  — claim atomique, backoff, traitement des jobs FBI, parsing e-Marque

  contracts/              — DTO zod (source des réponses API ET de la spec OpenAPI)
  modules/                — routes Hono par domaine (clubs, matches, integrations, documents, issues, platform)
  api/v1, api/internal    — assemblage des routeurs

api/index.ts             — entrypoint Vercel (hono/vercel)
supabase/migrations/      — SOURCE DE VÉRITÉ du schéma (voir docs/DEPLOYMENT.md)
supabase/tests/           — tests RLS réels (PostgreSQL)
```

## 4. Décisions structurantes

- **Hono, pas NestJS.** Léger, Vercel-friendly (`hono/vercel`), suffisant
  pour la surface de routes actuelle. Voir §6 de la demande.
- **DTO = contrat, jamais `select('*')`.** `contracts/*.ts` (zod) sert à la
  fois de validation et de source pour `/openapi.json` — un seul endroit
  à faire évoluer.
- **RLS jamais court-circuitée.** Les routes `/v1/*` utilisent un client
  Supabase construit avec le JWT de l'utilisateur (`createUserSupabaseClient`,
  voir `db/client.ts`) : la RLS s'applique exactement comme pour un accès
  direct. Le client service role n'est utilisé qu'après qu'un middleware a
  déjà vérifié membership/rôle via la RLS (ex : lire `fbi_credentials`, qui
  n'a intentionnellement aucune policy `authenticated`).
- **FBI est une intégration facultative**, jamais un prérequis — voir
  `docs/FBI.md` et `tenancy/club-capabilities.ts`.
- **Pas de worker séparé.** Contrairement à la tentative précédente
  (Railway), toute l'automatisation FBI (HTTP et navigateur) tourne dans
  des Vercel Functions déclenchées par Vercel Cron. Voir `docs/FBI.md` pour
  l'analyse des contraintes réelles avant cette décision.
