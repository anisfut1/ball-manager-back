# Migration des dépôts (octobre 2026)

| Avant | Après | Rôle |
|---|---|---|
| `anisfut1/SCSB` | `anisfut1/ball-manager-web` | Frontend web Next.js (Vercel) : SaaS, pages publiques, AASA, confidentialité / aide, connexion web, Smart App Banner, repli des Universal Links |
| `anisfut1/club-manager-api` | `anisfut1/ball-manager-back` | API Hono (Vercel), Supabase, FFBB, FBI / e-Marque, OpenAPI, notifications APNs, authentification mobile, crons, migrations |
| (nouveau) | `anisfut1/ball-manager-app` | App mobile Expo / React Native (iOS, puis Android), EAS Build / Submit |

- Date : 2026-10-10.
- Les anciens noms n'apparaissent plus que dans ce document et dans `ball-manager-web/docs/REPOSITORY_RENAME_AUDIT.md`. Les fichiers de migration SQL déjà appliqués restent inchangés, car ce sont des commentaires historiques.

## Ce qui ne change pas

- **Projets Vercel.** Ils ne sont pas renommés : le domaine de l'API, `club-manager-api-two.vercel.app`, dérive du nom du projet. Il est appelé par le workflow `fbi-frequent-sync.yml` et par la variable `NEXT_PUBLIC_CLUB_MANAGER_API_URL` du web.
- **Noms de variables d'environnement** (`NEXT_PUBLIC_CLUB_MANAGER_API_URL`, `CLUB_MANAGER_OPENAPI_URL`).
- **Identifiants d'exécution du web** : clés `localStorage` `scsb:*`, cookie `scsb-public-known`, sel `scsb-public-session:`. Les changer déconnecterait les familles.
- **Répertoire du worker FBI déjà installé** (`/opt/club-manager-api`).
- **Base Supabase** : un seul projet.

## Liaisons

| Dépôt GitHub | Projet Vercel | Domaine de production |
|---|---|---|
| `ball-manager-web` | projet du frontend (inchangé) | `www.ball-manager.fr` |
| `ball-manager-back` | `club-manager-api` (inchangé) | `club-manager-api-two.vercel.app` |
| `ball-manager-app` | aucun (EAS) | App Store |

## Remotes

```sh
# ball-manager-web
git remote set-url origin https://github.com/anisfut1/ball-manager-web.git
# ball-manager-back
git remote set-url origin https://github.com/anisfut1/ball-manager-back.git
# ball-manager-app
git remote add origin https://github.com/anisfut1/ball-manager-app.git
```

## Branches

| Dépôt | Branche par défaut | Travail mobile |
|---|---|---|
| `ball-manager-web` | `claude/sete-basket-app-architecture-c3hlxx` (production) | `claude/mobile-support` (support web de l'app ; l'ancienne app Capacitor est retirée) |
| `ball-manager-back` | `main` | `claude/mobile-support` (sessions d'appareil, push ; `claude/ios-app` historique) |
| `ball-manager-app` | `main` | `claude/expo-app` |

## OpenAPI

`ball-manager-back` publie `/openapi.json`. C'est la source de vérité. Le web et l'app génèrent chacun leurs types (`npm run api:generate`).

## Vérifications après renommage (2026-10-10)

- **Remotes locaux** mis à jour et vérifiés (`git fetch` OK) : `https://github.com/anisfut1/ball-manager-web`, `https://github.com/anisfut1/ball-manager-back`.
- **Liaison Vercel ↔ GitHub conservée.** Les commits poussés **après** le renommage ont reçu un déploiement Vercel sur les deux dépôts (statut `Vercel` publié sur le commit).
  - `ball-manager-back` : déploiement de prévisualisation **réussi**.
  - `ball-manager-web` : prévisualisation **en échec**, mais **avant** le renommage déjà. Toutes les prévisualisations hors branche de production échouent depuis le 2026-10-06 (`fix/next-security`, `refactor/migration-back`, `claude/fervent-brahmagupta-pu78c4`, `claude/ios-app`). La branche de production, elle, déploie sans erreur. Cause probable, non vérifiée faute d'accès aux journaux Vercel : des variables d'environnement définies seulement pour « Production ». Le renommage n'en est pas la cause.
- **Production** (`www.ball-manager.fr`, `club-manager-api-two.vercel.app`) : non testable depuis l'environnement de travail (réseau sortant restreint).
