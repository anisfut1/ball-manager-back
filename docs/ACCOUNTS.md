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

le lien est **actif tout de suite**, sans validation du club (décision du
club pilote, 28/11/2026). La `source` garde la trace de la preuve éventuelle
(`personal_link`, `email_match` si l'adresse VÉRIFIÉE est connue sur la fiche,
sinon `request`) pour l'écran du club. Un lien personnel d'une autre personne
reste refusé (`TOKEN_MISMATCH`). `pending` n'est plus produit.

Le club garde la main après coup (`/v1/clubs/{clubId}/account-links`,
club_admin ou correspondant) :

- `DELETE /{linkId}` **retire un rattachement** : statut `refused`, l'accès est
  coupé et le compte ne peut plus le redemander (`LINK_REMOVED_BY_CLUB`) ;
  l'admin peut le rétablir par `POST /{linkId}/accept` ;
- `POST /{linkId}/remove-account` **retire le compte du club** : tous ses
  rattachements du club passent à `refused`, ses jetons push du club sont
  effacés ; s'il ne suit plus personne ailleurs et n'est membre d'aucun club,
  le compte Auth est supprimé (`accountDeleted: true`). Un admin ne peut pas
  se retirer lui-même.

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
