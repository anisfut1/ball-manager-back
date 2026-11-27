# Auth

> Comptes de l'espace licencié (email + mot de passe, web et app iOS) : voir [ACCOUNTS.md](ACCOUNTS.md).

## Flux

```
Frontend (Supabase Auth) → JWT → Authorization: Bearer <JWT>
  → requireAuth()          — valide le JWT (supabase.auth.getUser), construit
                              un client Supabase RLS-bound "au nom de l'utilisateur"
  → requireClubMembership() — vérifie l'appartenance via LA RLS (jamais en
                              faisant confiance à :clubId seul)
  → requireClubRole(role)   — vérifie le rôle sur CE club
```

Voir `src/auth/jwt.ts` et `src/auth/middleware.ts`.

## Pourquoi valider le JWT via `auth.getUser(token)` plutôt qu'une vérification de signature locale

Appeler l'API Auth de Supabase garantit qu'un jeton révoqué (déconnexion,
changement de mot de passe) est rejeté immédiatement, sans que ce backend
ait besoin de connaître la rotation de clés de Supabase Auth. Le coût est
un aller-retour réseau par requête authentifiée — acceptable pour ce volume,
à revisiter avec un cache JWKS le jour où la charge le justifiera.

## Le client "au nom de l'utilisateur"

`createUserSupabaseClient(accessToken)` (`src/db/client.ts`) utilise la clé
anonyme MAIS transmet le JWT dans l'en-tête `Authorization` de chaque
requête PostgREST. `auth.uid()` résout donc côté PostgreSQL exactement
comme pour le frontend — la RLS n'est jamais un filtre "en plus", c'est LA
protection. Le backend ne fait jamais confiance à un `clubId` de route sans
que la RLS ait confirmé l'appartenance (voir `tenancy/club-context.ts`).

## Quand le client service role est utilisé

Seulement pour des tables sans policy `authenticated` du tout
(`fbi_credentials`, `platform_admins` en écriture) — et uniquement APRÈS
qu'un middleware a déjà vérifié le rôle nécessaire via la RLS. Voir
`modules/integrations/routes.ts` (`saveFbiCredentials`) et
`modules/documents/routes.ts` (URL signée) pour les deux cas concrets.

## Rôles

| Rôle | Portée | Table |
|---|---|---|
| `club_admin`, `correspondant_club`, `responsable_tables`, `coach`, `joueur`, `parent` | un club | `membership_roles` |
| `platform_admin` | toute la plateforme | `platform_admins` (aucune policy d'écriture `authenticated`) |

`requirePlatformAdmin()` appelle la fonction SQL `is_platform_admin()`
(`SECURITY DEFINER`) via RPC — jamais une requête directe sur
`platform_admins` qui obligerait à dupliquer la logique de vérification.

## Invitation (onboarding)

`POST /v1/platform/clubs` peut inviter le premier `club_admin` via
`supabase.auth.admin.inviteUserByEmail` — **uniquement depuis ce backend**
(client service role), jamais depuis le frontend (§43 de la demande).
