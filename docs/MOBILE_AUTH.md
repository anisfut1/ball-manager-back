# Authentification de l'app iOS (et liens)

L'audit et la décision d'architecture sont dans `ball-manager-web/docs/IOS_AUDIT.md`. La sécurité est détaillée dans `ball-manager-web/docs/IOS_SECURITY.md`.

## Une seule identité

Le **licencié du lien personnel** (`licencie_public_tokens`) reste la seule identité de l'espace public, pour le web comme pour l'app. Il n'y a ni nouveau compte ni nouveau JWT.

L'app reçoit une **session d'appareil** (`device_sessions`) : c'est une preuve **dérivée** du lien personnel.

| | Lien personnel (web) | Session d'appareil (app) |
|---|---|---|
| Transport | `X-Personal-Link-Token` (recommandé) ou `?token=` | `Authorization: Bearer bmd_…` et `X-BM-As: <licencieId>` |
| Stockage | cookie `bm_session` HttpOnly chiffré (ball-manager-web) | Keychain iOS (`AfterFirstUnlockThisDeviceOnly`) |
| Durée | jusqu'à révocation ou rotation | 180 jours **glissants** |
| Révocation | réinitialisation admin, ou nouveau lien | déconnexion, réinitialisation admin du lien, ou expiration |

Chaque personne d'une session (`device_session_grants`) est **adossée au jeton personnel** qui l'a prouvée :
- **réinitialisation par un admin** (jeton révoqué) : l'app perd l'accès à cette personne dès la requête suivante (401 `SESSION_INVALID`) ;
- **« lien perdu ? » vers la même adresse** : `issuePersonalLink(…, { keepAppSessions: true })` déplace les droits sur le nouveau jeton, et l'app reste connectée ;
- **demande approuvée par un admin pour une autre adresse** : pas de transfert.

Résolution de l'identité : `src/modules/public/credential.ts`, `licencieFromRequest`. C'est l'**unique** point d'entrée de toutes les routes `/v1/public/clubs/{slug}/…`. Les règles de droits qui suivent sont **identiques** au web.

Pour l'accueil (« À faire ») et le planning, l'app envoie `tokens: ["as:<licencieId>", …]`. Chaque entrée est vérifiée dans la session, et l'ordre (`tokenIndex`) est conservé.

## Routes `/v1/public/clubs/{clubSlug}/auth/…`

| Route | Rôle |
|---|---|
| `POST /device-sessions` `{ tokens, platform: "ios" }` | Amorçage depuis un lien personnel reçu par l'app (Universal Link). L'app ne garde **pas** le jeton. |
| `GET /session` | Personnes de la session. |
| `DELETE /session` | Déconnexion de cet appareil. |
| `POST /session/people` `{ tokens }` | Ajouter un enfant (son lien le prouve). |
| `DELETE /session/people/{licencieId}` | Retirer une personne de l'appareil. |
| `PUT /session/push-token` `{ token, environment, appVersion? }` | Jeton APNs de cet iPhone pour cette session (voir `ball-manager-web/docs/IOS_PUSH.md`). |
| `DELETE /session/push-token` | Plus de notifications de ce club sur cet appareil. |
| `POST /codes` `{ tokens, codeChallenge, codeChallengeMethod: "S256", redirectPath? }` | Page web `/public/{slug}/auth/app`, déjà identifiée : code de **5 min**, **usage unique**, lié au PKCE de l'app. |
| `POST /token` `{ code, codeVerifier?, platform }` | Échange d'un code. `ios` → session d'appareil ; `web` (lien de connexion par email) → liens personnels pour `bm_session`. |

Plus `GET /v1/public/clubs`, la liste des clubs actifs (nom, slug, logo) pour le choix du club dans l'app.

### Garanties testées (`src/modules/device-auth/device-auth.test.ts`)

- PKCE S256 seul (jamais `plain`) ; comparaison en temps constant.
- Code : usage unique par mise à jour conditionnelle `used_at is null`, expiration, lié au club.
- Secret de session : 32 octets aléatoires ; **seul son SHA-256 est en base**.
- Une session du club A est refusée sur le club B.
- `X-BM-As` vers une personne hors session : 403.
- Destination après connexion : chemin `/public/…` seulement (pas d'URL externe, pas de `//`, pas de `..`).
- Limites de débit par IP sur toutes les routes d'émission.

### Préchargement par les scanners d'emails

Aucune route GET ne consomme un code ni ne crée de session. Le lien de connexion `GET /public/{slug}/connexion/code/{code}` (ball-manager-web) affiche une page ; c'est le bouton « Continuer » qui fait le `POST /auth/token`. L'app, elle, fait le POST elle-même après ouverture par Universal Link.

## Liens de connexion à usage unique (`AUTH_LINK_CODES`)

- **Absent** (défaut) : l'email « ton lien personnel » garde exactement son format actuel, `/public/{slug}/{cible}?token=…`.
- **`AUTH_LINK_CODES=1`** : l'email contient `/public/{slug}/connexion/code/{code}`, un code de **48 h** à usage unique. Le jeton permanent n'est **jamais** dans l'email.
  - Le jeton reste émis et chiffré : le web en a besoin pour sa session, et l'admin peut réafficher le lien.
  - **Transition** : les anciens liens `?token=` et `#token=` restent valables partout, sur le web comme dans l'app.
  - **Effet visible** : un lien déjà utilisé affiche « Ce lien a déjà été utilisé. Demande un nouveau lien. » Un clic suffit pour en recevoir un autre.
  - À activer après le déploiement de la page ball-manager-web `/public/{slug}/connexion/code/{code}`.

## Liens : `BallManagerLinkService` (`src/links/links.ts`)

Une ressource logique correspond à **un** chemin `/public/{slug}/…`, partagé par :
- le web ;
- les Universal Links : même chemin, même routeur dans l'app ;
- les notifications push, via le champ `path`, relatif (`paths.*`).

Générateurs migrés :
- lien personnel (`issuePersonalLink`, `personalLinkUrl`) ;
- emails de dérogation (`notify.ts`) ;
- invitation de compte et accès accordé (`account-invites.ts`) ;
- liens « gérer les joueurs » vers l'espace club.

`resolvePublicAppBaseUrl` et `appBaseUrl` délèguent à `linkBaseUrl` : `PUBLIC_APP_URL`, sinon une origine autorisée, jamais une origine arbitraire.

## CORS

- L'app mobile native (`ball-manager-app`, Expo / React Native) n'envoie pas d'en-tête `Origin` : seules les origines web de `FRONTEND_ORIGINS` sont autorisées. L'API n'utilise aucun cookie.
- Les en-têtes `X-Personal-Link-Token` et `X-BM-As` sont autorisés.

## Migration SQL

- `supabase/migrations/20261011090000_device_sessions.sql` : `device_sessions`, `device_session_grants`, `auth_codes`.
- `supabase/migrations/20261011120000_push_notifications.sql` : `device_push_tokens`, `notification_outbox`.

Elles sont additives, avec RLS activée et aucune policy (accès par l'API seulement). Les deux sont appliquées.

## Pas de suppression de compte dans l'app

L'app ne crée aucun compte : l'accès vient d'un lien émis par le club. « Se déconnecter » révoque la session et son jeton push. La suppression des données passe par le club.
