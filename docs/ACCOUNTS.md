# Comptes de l'espace licencié

Depuis novembre 2026, chaque personne (joueur, parent, coach…) peut avoir son
propre compte, email + mot de passe, sur le web comme dans l'app iOS (exigence
App Store : un compte par utilisateur, et sa suppression depuis l'app).

Un compte suit un ou plusieurs licenciés, et un licencié peut être suivi par
plusieurs comptes (le père, la mère, l'enfant). Tous les comptes liés ont les
mêmes droits sur la fiche ; les droits staff (coach, responsable tables,
admin) restent dans `membership_roles`.

Les liens personnels (`X-Personal-Link-Token`) et les sessions d'appareil
(`bmd_…`) restent acceptés pendant la transition.

## Création de compte et connexion

Tout passe par l'API (aucune clé Supabase dans l'app) :

| Route | Rôle |
|---|---|
| `POST /v1/account/sign-up` | Crée le compte (ou reprend une création inachevée) et envoie un code à 6 chiffres. Même réponse si l'adresse a déjà un compte (un email « tu as déjà un compte » part alors à cette adresse). |
| `POST /v1/account/sign-up/resend` | Renvoie un code. |
| `POST /v1/account/sign-up/verify` | Vérifie le code, confirme l'adresse et ouvre la session. |
| `POST /v1/account/sign-in` | Email + mot de passe. `EMAIL_NOT_CONFIRMED` tant que le code n'a pas été saisi. |
| `POST /v1/account/refresh` | Nouveau jeton d'accès. |
| `POST /v1/account/password-reset` | Mot de passe oublié (email avec lien vers `/bienvenue`). |

Le code est envoyé par nos emails (Resend), jamais par l'email Supabase par
défaut. Il n'est stocké que haché dans `app_metadata`, expire en 30 minutes,
et 5 essais faux le bloquent. Aucun mot de passe, code ni jeton n'est
journalisé.

## Rattacher un licencié

Après la recherche du nom, `POST /v1/public/clubs/{slug}/account/links` :

- **actif tout de suite** si un lien personnel valide du même licencié est
  fourni, ou si l'adresse VÉRIFIÉE du compte est déjà connue (email de la
  fiche FBI ou d'un lien personnel actif) ;
- **en attente** sinon : un admin du club accepte ou refuse dans la file
  « Demandes de rattachement » (`/v1/clubs/{clubId}/account-links`).

Autres preuves : `POST …/account/links/device-session` reprend les personnes
d'une session d'appareil de l'app d'avant les comptes ; une invitation d'un
proche déjà lié (`POST …/account/invites`, lien à partager valable 7 jours, à
usage unique, code dans le fragment `#…` de l'URL) rend le lien actif à
l'acceptation (`POST …/account/invites/accept`).

## Droits

`licencieFromRequest` (`src/modules/public/credential.ts`) accepte en premier
`Authorization: Bearer <JWT>` : la personne active est choisie par `X-BM-As`
parmi les licenciés ACTIFS du compte dans ce club (le premier par défaut).
Un lien en attente ou refusé ne donne aucun droit ; le lien d'un club n'en
donne aucun dans un autre.

## Notifications

`PUT …/account/push-token` enregistre le jeton APNs de l'iPhone pour le
compte. À l'envoi, les destinataires (des licenciés) sont résolus vers tous
les comptes qui les suivent avec un lien actif : le père et la mère reçoivent
la convocation.

## Suppression

`DELETE /v1/public/clubs/{slug}/account` supprime l'utilisateur Auth et, en
cascade, ses liens et jetons push. Les fiches sportives restent au club et
les autres comptes de la famille ne sont pas touchés. Un compte
administrateur du club passe par la plateforme.

## Tables

`account_licencie_links`, `account_invites`, `account_push_tokens` (migration
`20261127180000_user_accounts.sql`) : RLS activée, accès par l'API (rôle
service) ; un compte connecté peut seulement lire ses propres liens.
