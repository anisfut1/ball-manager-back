# Règles pour les agents (ball-manager-back)

API REST de Ball Manager : Hono + TypeScript, déployée en fonctions Vercel,
données dans Supabase (PostgreSQL, Auth, Storage). Clients : `ball-manager-web`
(Next.js) et `ball-manager-app` (Expo). Club pilote : SC Sète Basket
(`OCC0034008`), qui reste un tenant comme un autre : rien de câblé en dur.

## Conventions

- **Français** pour les commentaires, la doc, les messages de commit et les
  titres de PR (le code lui-même reste en anglais).
- **Jamais d'identifiant dans un journal** : ni mot de passe, ni jeton, ni clé,
  ni identifiant FBI, ni lien personnel. Passer par `src/logger.ts`.
- **Multi-tenant** : toute donnée métier porte un `club_id` ; toute lecture
  passe par la RLS ou un contrôle explicite d'appartenance (voir
  `docs/MULTI_TENANCY.md`).
- **Contrats** : les DTO sont des schémas zod dans `src/contracts/` ; l'OpenAPI
  (`/openapi.json`) en est générée et sert de source aux types du web et de
  l'app. Route ajoutée ou retirée : relancer `npm run docs:routes`.
- **Migrations** : uniquement de nouveaux fichiers horodatés dans
  `supabase/migrations/`. Ne jamais modifier une migration déjà appliquée.
- **Outils `ops/`** : jamais importés par `src/` ; chacun a sa ligne dans
  `ops/README.md`.

## Avant de dire qu'une tâche est finie

```bash
npm run lint && npm run typecheck && npm test
```

## Où lire

`ARCHITECTURE.md` pour la vue d'ensemble, puis `docs/` par domaine
(`API.md`, `AUTH.md`, `ACCOUNTS.md`, `FBI.md`, `FFBB.md`, `JOBS.md`, `EMARQUE.md`,
`DEPLOYMENT.md`).
