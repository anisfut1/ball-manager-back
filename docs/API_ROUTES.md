# Inventaire des routes de l'API

> Fichier **généré** par `npm run docs:routes` (ops/docs/generate-routes-doc.ts) — ne pas modifier à la main.
> 180 routes montées dans le code, 173 décrites dans le contrat OpenAPI (`/openapi.json`, `/docs`).

Accès : **Compte connecté** = JWT Supabase (`Authorization: Bearer`), droits vérifiés par club ; **Public** = sans compte ; **Public (lien perso si action)** = lecture libre, écriture avec le jeton du lien personnel ; **Secret cron** = `CRON_SECRET`.

## Club — capabilities

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/capabilities` | Compte connecté | Capacités du club (FBI facultatif) |

## Club — club

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId` | Compte connecté | Détail du club |
| PATCH | `/v1/clubs/:clubId` | Compte connecté | Club mis à jour (branding uniquement) |

## Club — derogation-requests

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/derogation-requests` | Compte connecté | Inbox coordinateur / demandes du coach |
| POST | `/v1/clubs/:clubId/derogation-requests` | Compte connecté | Demande créée (créneau revalidé côté serveur) |
| DELETE | `/v1/clubs/:clubId/derogation-requests/:requestId` | Compte connecté | Demande supprimée |
| GET | `/v1/clubs/:clubId/derogation-requests/:requestId` | Compte connecté | Demande, match, propositions, conversation, permissions |
| POST | `/v1/clubs/:clubId/derogation-requests/:requestId/actions` | Compte connecté | Statut mis à jour + événement système |
| POST | `/v1/clubs/:clubId/derogation-requests/:requestId/messages` | Compte connecté | Message ajouté (demande à jour) |
| POST | `/v1/clubs/:clubId/derogation-requests/:requestId/official` | Compte connecté | Résultat FBI réel + demande à jour |
| POST | `/v1/clubs/:clubId/derogation-requests/:requestId/proposals` | Compte connecté | Nouveau créneau proposé (historique conservé) |
| GET | `/v1/clubs/:clubId/derogation-requests/context` | Compte connecté | Demandeur, coordinateur configuré, gymnases, matchs éligibles |

## Club — derogations

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/derogations` | Compte connecté | Toutes les dérogations connues du club |
| POST | `/v1/clubs/:clubId/derogations/:derogationId/respond` | Compte connecté | Résultat RÉEL renvoyé par FBI (success/error/unknown) |

## Club — emarque-imports

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/emarque-imports` | Compte connecté | Imports e-Marque du club (filtrés, paginés) |

## Club — emarque-tracking

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/emarque-tracking` | Compte connecté | État de récupération des statistiques de chaque match joué de la saison |
| POST | `/v1/clubs/:clubId/emarque-tracking/:matchId/relaunch` | Compte connecté | Relance enregistrée : essai au prochain passage, puis 7 jours au calendrier fixe |

## Club — integrations

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/integrations` | Compte connecté | Statut des intégrations |
| PATCH | `/v1/clubs/:clubId/integrations/fbi` | Compte connecté | Réglages FBI mis à jour |
| POST | `/v1/clubs/:clubId/integrations/fbi` | Compte connecté | Identifiants enregistrés (jamais le mot de passe) |
| POST | `/v1/clubs/:clubId/integrations/fbi/check-all-derogations` | Compte connecté | Résultat immédiat de la vérification globale FBI |
| POST | `/v1/clubs/:clubId/integrations/fbi/parse-documents` | Compte connecté | Lot de documents e-Marque téléchargés du club parsés (OCR/PDF, jamais de navigateur) |
| POST | `/v1/clubs/:clubId/integrations/fbi/process-jobs` | Compte connecté | Lot de jobs FBI du club traité (discover_emarque/test_connection en attente) |
| POST | `/v1/clubs/:clubId/integrations/fbi/reconcile-schedule` | Compte connecté | Job de rapprochement calendrier FFBB/FBI empilé (un seul par club à la fois) |
| POST | `/v1/clubs/:clubId/integrations/fbi/test` | Compte connecté | Résultat du test (HttpFbiClient, ou BrowserFbiClient en repli) |
| PATCH | `/v1/clubs/:clubId/integrations/ffbb` | Compte connecté | Intégration FFBB mise à jour (jamais de suppression de l'historique déjà synchronisé) |
| POST | `/v1/clubs/:clubId/integrations/ffbb/sync` | Compte connecté | Résultat de la synchronisation |
| GET | `/v1/clubs/:clubId/integrations/sync-runs` | Compte connecté | Historique des synchronisations |

## Club — issues

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/issues` | Compte connecté | Anomalies e-Marque à vérifier |
| POST | `/v1/clubs/:clubId/issues/:matchId/resolve` | Compte connecté | Anomalie résolue |

## Club — licencies

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/licencies` | Compte connecté | Roster du club |
| POST | `/v1/clubs/:clubId/licencies` | Compte connecté | Licencié créé |
| DELETE | `/v1/clubs/:clubId/licencies/:licencieId` | Compte connecté | Licencié supprimé |
| GET | `/v1/clubs/:clubId/licencies/:licencieId` | Compte connecté | Fiche joueur : identité, historique des matchs, statistiques par match |
| DELETE | `/v1/clubs/:clubId/licencies/:licencieId/photo` | Compte connecté | Photo retirée |
| POST | `/v1/clubs/:clubId/licencies/:licencieId/photo` | Compte connecté | Photo enregistrée, fiche à jour |
| PATCH | `/v1/clubs/:clubId/licencies/:licencieId/profile` | Compte connecté | Profil mis à jour (champs admin, ou contact/photo si le licencié lui-même) |
| POST | `/v1/clubs/:clubId/licencies/auto-assign-teams` | Compte connecté | Répartition terminée (total/assigned/skipped) |
| POST | `/v1/clubs/:clubId/licencies/import` | Compte connecté | Import terminé (total/inserted/skipped) |
| POST | `/v1/clubs/:clubId/licencies/import/fbi` | Compte connecté | Mise à jour demandée |
| POST | `/v1/clubs/:clubId/licencies/import/file` | Compte connecté | Licenciés mis à jour (compteurs) |
| GET | `/v1/clubs/:clubId/licencies/import/status` | Compte connecté | Dernière mise à jour des licenciés et demande FBI en cours |

## Club — matches

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/matches` | Compte connecté | Matchs du club (filtrés, paginés) |
| GET | `/v1/clubs/:clubId/matches/:matchId` | Compte connecté | Détail du match |
| GET | `/v1/clubs/:clubId/matches/:matchId/derogation` | Compte connecté | Dernier état connu de la dérogation de ce match (null si aucune) |
| GET | `/v1/clubs/:clubId/matches/:matchId/derogation-availability` | Compte connecté | Occupation des gymnases + créneaux candidats (match cible exclu) |
| GET | `/v1/clubs/:clubId/matches/:matchId/derogation-slot-check` | Compte connecté | Vérification serveur d'une heure personnalisée |
| POST | `/v1/clubs/:clubId/matches/:matchId/derogation/check` | Compte connecté | Résultat immédiat de la vérification FBI de ce match |
| POST | `/v1/clubs/:clubId/matches/:matchId/derogation/create` | Compte connecté | Résultat RÉEL renvoyé par FBI (success/error/unknown) |
| POST | `/v1/clubs/:clubId/matches/:matchId/derogation/respond` | Compte connecté | Résultat RÉEL renvoyé par FBI (success/error/unknown) |
| GET | `/v1/clubs/:clubId/matches/:matchId/documents` | Compte connecté | Documents e-Marque du match |
| PUT | `/v1/clubs/:clubId/matches/:matchId/referee-status` | Compte connecté | Statut arbitre enregistré |
| DELETE | `/v1/clubs/:clubId/matches/:matchId/table-assignments/:role` | Compte connecté | Affectation retirée (poste remis à 'À attribuer') |
| PUT | `/v1/clubs/:clubId/matches/:matchId/table-assignments/:role` | Compte connecté | Affectation enregistrée |
| GET | `/v1/clubs/:clubId/matches/:matchId/table-suggestions` | Compte connecté | Candidats classés (recommandés/disponibles/indisponibles) pour ce rôle sur ce match |

## Club — members

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/members` | Compte connecté | Membres du club et leurs rôles |
| POST | `/v1/clubs/:clubId/members` | Compte connecté | Membre invité/rattaché |
| PUT | `/v1/clubs/:clubId/members/:membershipId/roles` | Compte connecté | Rôles remplacés |

## Club — standings

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/standings` | Compte connecté | Classements FFBB des poules où le club est engagé |

## Club — table-assignments

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/table-assignments` | Compte connecté | Matchs à domicile du club, avec leurs 4 postes (affectés ou 'à attribuer') |
| GET | `/v1/clubs/:clubId/table-assignments/public-access` | Compte connecté | État des accès publics par licencié (revendiqué ou non) |
| POST | `/v1/clubs/:clubId/table-assignments/public-access/:licencieId/link` | Compte connecté | Lien personnel du licencié |
| POST | `/v1/clubs/:clubId/table-assignments/public-access/:licencieId/reset` | Compte connecté | Accès public réinitialisé |
| GET | `/v1/clubs/:clubId/table-assignments/public-access/claims` | Compte connecté | Demandes en attente (non expirées) |
| POST | `/v1/clubs/:clubId/table-assignments/public-access/claims/:requestId/approve` | Compte connecté | Lien envoyé à l'adresse demandée, enregistrée sur la fiche |
| POST | `/v1/clubs/:clubId/table-assignments/public-access/claims/:requestId/reject` | Compte connecté | Demande refusée, rien n'est envoyé |

## Club — team-life

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/team-life/matches/:matchId` | Compte connecté | Disponibilités et convocation du match (coach / admin) |
| POST | `/v1/clubs/:clubId/team-life/matches/:matchId/availability/open` | Compte connecté | Disponibilités demandées (aucune convocation créée) |
| PUT | `/v1/clubs/:clubId/team-life/matches/:matchId/convocation/draft` | Compte connecté | Brouillon enregistré (jamais visible des familles) |
| POST | `/v1/clubs/:clubId/team-life/matches/:matchId/convocation/preview` | Compte connecté | Aperçu : ce que recevront un parent et un joueur |
| POST | `/v1/clubs/:clubId/team-life/matches/:matchId/convocation/send` | Compte connecté | Convocation envoyée (ou mise à jour envoyée) |
| DELETE | `/v1/clubs/:clubId/team-life/matches/:matchId/laundry` | Compte connecté | Affectation retirée |
| PUT | `/v1/clubs/:clubId/team-life/matches/:matchId/laundry` | Compte connecté | Lavage attribué par le coach |
| GET | `/v1/clubs/:clubId/team-life/matches/:matchId/laundry/suggestions` | Compte connecté | Suggestions (lecture seule, aucune affectation créée) |
| POST | `/v1/clubs/:clubId/team-life/matches/:matchId/remind` | Compte connecté | Relance des sans réponse (affichée sur la Home des familles concernées) |
| GET | `/v1/clubs/:clubId/team-life/planning` | Compte connecté | Planning : matchs FFBB + entraînements |
| GET | `/v1/clubs/:clubId/team-life/teams/:teamId/overview` | Compte connecté | Vue d'ensemble de l'équipe (prochain match, entraînement, effectif) |
| GET | `/v1/clubs/:clubId/team-life/teams/:teamId/training-series` | Compte connecté | Créneaux d'entraînement en cours de l'équipe |
| POST | `/v1/clubs/:clubId/team-life/teams/:teamId/training-series` | Compte connecté | Créneaux créés, séances générées |
| DELETE | `/v1/clubs/:clubId/team-life/training-series/:seriesId` | Compte connecté | Créneau arrêté à partir d'une date (séances avec réponses annulées) |
| PATCH | `/v1/clubs/:clubId/team-life/training-series/:seriesId` | Compte connecté | Créneau modifié à partir d'une date (passé inchangé) |
| GET | `/v1/clubs/:clubId/team-life/trainings` | Compte connecté | Séances de la période (compteurs pour qui gère l'équipe) |
| GET | `/v1/clubs/:clubId/team-life/trainings/:occurrenceId` | Compte connecté | Séance + réponses nominatives (coach / admin) |
| PATCH | `/v1/clubs/:clubId/team-life/trainings/:occurrenceId` | Compte connecté | Séance modifiée (cette séance uniquement) |
| PUT | `/v1/clubs/:clubId/team-life/trainings/:occurrenceId/attendance/:licencieId` | Compte connecté | Présence réelle relevée (présent / retard / absent) |
| POST | `/v1/clubs/:clubId/team-life/trainings/:occurrenceId/cancel` | Compte connecté | Séance annulée (reste visible) |
| POST | `/v1/clubs/:clubId/team-life/trainings/:occurrenceId/restore` | Compte connecté | Séance rétablie |

## Club — teams

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/teams` | Compte connecté | Équipes du club (y compris sans engagement FFBB, voir docs/TEAMS.md) |
| POST | `/v1/clubs/:clubId/teams` | Compte connecté | Équipe créée |
| PATCH | `/v1/clubs/:clubId/teams/:teamId` | Compte connecté | Équipe mise à jour |

## Club — venues

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs/:clubId/venues` | Compte connecté | Gymnases du club |
| PATCH | `/v1/clubs/:clubId/venues/:venueId` | Compte connecté | Gymnase mis à jour |

## Compte (sans session)

| Méthode | Route | Accès | Description |
|---|---|---|---|
| POST | `/v1/account/password-reset` | Public | Demande prise en compte |

## Général — clubs

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/clubs` | Compte connecté | Clubs dont l'utilisateur est membre |

## Général — jobs

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/jobs/:jobId` | Compte connecté | Statut du job |

## Général — me

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/me` | Compte connecté | Utilisateur courant |

## Général — public

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs` | Public (lien perso si action) | Clubs actifs (nom, slug, logo) — choix du club dans l'app |

## Interne (tâches planifiées)

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/internal/cron/emarque-parse` | Secret cron |  |
| GET | `/internal/cron/fbi-enqueue` | Secret cron |  |
| GET | `/internal/cron/fbi-jobs` | Secret cron |  |
| GET | `/internal/cron/fbi-reachability` | Secret cron |  |
| GET | `/internal/cron/ffbb` | Secret cron |  |

## Plateforme (platform_admin)

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/platform/clubs` | Compte connecté | Clubs de la plateforme (platform_admin) |
| POST | `/v1/platform/clubs` | Compte connecté | Club créé |
| POST | `/v1/platform/clubs/:clubId/admins` | Compte connecté | Administrateur nommé (compte invité s'il n'existait pas) |
| DELETE | `/v1/platform/clubs/:clubId/admins/:membershipId` | Compte connecté | Rôle administrateur retiré (jamais le dernier) |
| GET | `/v1/platform/clubs/:clubId/members` | Compte connecté | Membres et rôles du club (platform_admin) |
| POST | `/v1/platform/maintenance/delete-old-seasons` | Compte connecté | Matchs des saisons précédentes supprimés (cascade FK sur toutes les données liées) |
| POST | `/v1/platform/maintenance/purge-emarque-documents` | Compte connecté | Purge terminée (idempotente, jamais destructive pour les stats déjà en base) |
| POST | `/v1/platform/maintenance/retry-failed-emarque-imports` | Compte connecté | Nouvelle tentative terminée (réutilise le fichier déjà en Storage, jamais un nouveau téléchargement FBI) |

## Public — access-requests

| Méthode | Route | Accès | Description |
|---|---|---|---|
| POST | `/v1/public/clubs/:clubSlug/access-requests` | Public (lien perso si action) | Demande transmise au club |

## Public — auth

| Méthode | Route | Accès | Description |
|---|---|---|---|
| POST | `/v1/public/clubs/:clubSlug/auth/codes` | Public (lien perso si action) | Code d'autorisation (5 min, usage unique, lié au PKCE) |
| POST | `/v1/public/clubs/:clubSlug/auth/device-sessions` | Public (lien perso si action) | Session d'appareil (secret affiché une seule fois) |
| DELETE | `/v1/public/clubs/:clubSlug/auth/session` | Compte connecté | Session révoquée |
| GET | `/v1/public/clubs/:clubSlug/auth/session` | Compte connecté | Personnes de la session d'appareil |
| POST | `/v1/public/clubs/:clubSlug/auth/session/people` | Compte connecté | Personne ajoutée à l'appareil |
| DELETE | `/v1/public/clubs/:clubSlug/auth/session/people/:licencieId` | Compte connecté | Personne retirée de l'appareil |
| POST | `/v1/public/clubs/:clubSlug/auth/token` | Public (lien perso si action) | Liens personnels pour la session web (web, lien de connexion) |

## Public — club

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug` | Public (lien perso si action) | Infos club minimales (aucune donnée membre/rôle) |

## Public — derogation-requests

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/derogation-requests` | Public (lien perso si action) | Demandes visibles (espace public) |
| POST | `/v1/public/clubs/:clubSlug/derogation-requests` | Public (lien perso si action) | Demande créée (espace public) |
| DELETE | `/v1/public/clubs/:clubSlug/derogation-requests/:requestId` | Public (lien perso si action) | Demande supprimée (espace public) |
| GET | `/v1/public/clubs/:clubSlug/derogation-requests/:requestId` | Public (lien perso si action) | Demande + conversation (espace public) |
| POST | `/v1/public/clubs/:clubSlug/derogation-requests/:requestId/actions` | Public (lien perso si action) | Statut mis à jour |
| POST | `/v1/public/clubs/:clubSlug/derogation-requests/:requestId/messages` | Public (lien perso si action) | Message ajouté |
| POST | `/v1/public/clubs/:clubSlug/derogation-requests/:requestId/official` | Public (lien perso si action) | Résultat FBI réel + demande à jour |
| POST | `/v1/public/clubs/:clubSlug/derogation-requests/:requestId/proposals` | Public (lien perso si action) | Nouveau créneau proposé |
| GET | `/v1/public/clubs/:clubSlug/derogation-requests/availability` | Public (lien perso si action) | Occupation des gymnases (espace public) |
| GET | `/v1/public/clubs/:clubSlug/derogation-requests/context` | Public (lien perso si action) | Contexte (espace public) |
| GET | `/v1/public/clubs/:clubSlug/derogation-requests/slot-check` | Public (lien perso si action) | Vérification d'une heure (espace public) |

## Public — derogations

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/derogations` | Public (lien perso si action) | Dérogations connues du club |
| POST | `/v1/public/clubs/:clubSlug/derogations/:derogationId/respond` | Public (lien perso si action) | Résultat de l'envoi à FBI |

## Public — home

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/home` | Public (lien perso si action) | Accueil personnel |

## Public — licencies

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/licencies` | Public (lien perso si action) | Introuvable |
| POST | `/v1/public/clubs/:clubSlug/licencies/:licencieId/request-link` | Public (lien perso si action) | Lien personnel envoyé par email à l'adresse connue (adresse masquée) |
| POST | `/v1/public/clubs/:clubSlug/licencies/search` | Public (lien perso si action) | Au plus 5 fiches : prénom et initiale du nom |

## Public — matches

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/matches` | Public (lien perso si action) | Matchs du club (filtrés, paginés) — mêmes filtres que la route authentifiée |
| GET | `/v1/public/clubs/:clubSlug/matches/:matchId` | Public (lien perso si action) | Détail du match (composition, statistiques, officiels, e-Marque) |
| GET | `/v1/public/clubs/:clubSlug/matches/:matchId/derogation` | Public (lien perso si action) | Dernier état connu de la dérogation de ce match (null si aucune) |
| POST | `/v1/public/clubs/:clubSlug/matches/:matchId/derogation/create` | Public (lien perso si action) | Résultat de l'envoi à FBI |
| GET | `/v1/public/clubs/:clubSlug/matches/:matchId/documents` | Public (lien perso si action) | Documents e-Marque du match — `downloadUrl` toujours `null` (jamais d'URL signée en public) |
| PUT | `/v1/public/clubs/:clubSlug/matches/:matchId/referee-status` | Public (lien perso si action) | Statut arbitre enregistré |
| DELETE | `/v1/public/clubs/:clubSlug/matches/:matchId/table-assignments/:role` | Public (lien perso si action) | Affectation retirée |
| PUT | `/v1/public/clubs/:clubSlug/matches/:matchId/table-assignments/:role` | Public (lien perso si action) | Affectation enregistrée |
| GET | `/v1/public/clubs/:clubSlug/matches/:matchId/table-suggestions` | Public (lien perso si action) | Candidats classés pour ce poste |

## Public — me

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/me` | Public (lien perso si action) | Identité résolue depuis le jeton |

## Public — players

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/players/:licencieId` | Public (lien perso si action) | Fiche joueur publique (saison en cours, matchs publiés uniquement) |

## Public — standings

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/standings` | Public (lien perso si action) | Classements FFBB (copiés à chaque synchronisation) |

## Public — table-assignments

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/table-assignments` | Public (lien perso si action) | Même contenu que la vue admin, avec `me` |

## Public — table-leaderboard

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/table-leaderboard` | Public (lien perso si action) | Classement des tables tenues cette saison (ex æquo = même rang) |

## Public — team-life

| Méthode | Route | Accès | Description |
|---|---|---|---|
| POST | `/v1/public/clubs/:clubSlug/team-life/action-center` | Public (lien perso si action) | Home « À faire » (liens de l'appareil fusionnés) |
| GET | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId` | Public (lien perso si action) | Disponibilités et convocation du match (coach / admin) |
| POST | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/availability/open` | Public (lien perso si action) | Disponibilités demandées (aucune convocation créée) |
| PUT | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/availability/response` | Public (lien perso si action) | Disponibilité du licencié du lien |
| PUT | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/convocation/draft` | Public (lien perso si action) | Brouillon enregistré (jamais visible des familles) |
| POST | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/convocation/preview` | Public (lien perso si action) | Aperçu : ce que recevront un parent et un joueur |
| PUT | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/convocation/response` | Public (lien perso si action) | Confirmation / refus du convoqué du lien |
| POST | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/convocation/send` | Public (lien perso si action) | Convocation envoyée (ou mise à jour envoyée) |
| DELETE | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/laundry` | Public (lien perso si action) | Affectation retirée |
| PUT | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/laundry` | Public (lien perso si action) | Lavage attribué par le coach |
| POST | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/laundry/seen` | Public (lien perso si action) | « J'ai vu » (licencié désigné) |
| GET | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/laundry/suggestions` | Public (lien perso si action) | Suggestions (lecture seule, aucune affectation créée) |
| POST | `/v1/public/clubs/:clubSlug/team-life/matches/:matchId/remind` | Public (lien perso si action) | Relance des sans réponse (affichée sur la Home des familles concernées) |
| POST | `/v1/public/clubs/:clubSlug/team-life/planning` | Public (lien perso si action) | Planning des équipes de l'appareil |
| GET | `/v1/public/clubs/:clubSlug/team-life/teams/:teamId/overview` | Public (lien perso si action) | Vue d'ensemble (joueurs de l'équipe, coach / admin) |
| GET | `/v1/public/clubs/:clubSlug/team-life/teams/:teamId/training-series` | Public (lien perso si action) | Créneaux d'entraînement en cours de l'équipe |
| POST | `/v1/public/clubs/:clubSlug/team-life/teams/:teamId/training-series` | Public (lien perso si action) | Créneaux créés, séances générées |
| GET | `/v1/public/clubs/:clubSlug/team-life/teams/:teamId/trainings` | Public (lien perso si action) | Séances d'une équipe gérée par le lien (compteurs de réponses) |
| DELETE | `/v1/public/clubs/:clubSlug/team-life/training-series/:seriesId` | Public (lien perso si action) | Créneau arrêté à partir d'une date (séances avec réponses annulées) |
| PATCH | `/v1/public/clubs/:clubSlug/team-life/training-series/:seriesId` | Public (lien perso si action) | Créneau modifié à partir d'une date (passé inchangé) |
| GET | `/v1/public/clubs/:clubSlug/team-life/trainings/:occurrenceId` | Public (lien perso si action) | Séance + réponses nominatives (coach / admin) |
| PATCH | `/v1/public/clubs/:clubSlug/team-life/trainings/:occurrenceId` | Public (lien perso si action) | Séance modifiée (cette séance uniquement) |
| PUT | `/v1/public/clubs/:clubSlug/team-life/trainings/:occurrenceId/attendance/:licencieId` | Public (lien perso si action) | Présence réelle relevée (présent / retard / absent) |
| POST | `/v1/public/clubs/:clubSlug/team-life/trainings/:occurrenceId/cancel` | Public (lien perso si action) | Séance annulée (reste visible) |
| PUT | `/v1/public/clubs/:clubSlug/team-life/trainings/:occurrenceId/response` | Public (lien perso si action) | Réponse enregistrée pour le licencié du lien |
| POST | `/v1/public/clubs/:clubSlug/team-life/trainings/:occurrenceId/restore` | Public (lien perso si action) | Séance rétablie |

## Public — teams

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/v1/public/clubs/:clubSlug/teams` | Public (lien perso si action) | Équipes du club (pour le filtre de la liste des matchs) |

## Technique

| Méthode | Route | Accès | Description |
|---|---|---|---|
| GET | `/docs` | Public |  |
| GET | `/health` | Public | État du service |
| GET | `/openapi.json` | Public |  |

## Écarts code / contrat

Aucun.
