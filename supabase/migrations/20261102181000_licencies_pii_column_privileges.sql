-- Ferme l'accès direct (PostgREST) aux colonnes sensibles de public.licencies
-- (audit S-1, lot 2b). La policy `licencies_select_member` ouvre les LIGNES du
-- club à tout membre actif ; sans cette migration, un membre qui appelle
-- PostgREST avec son jeton et la clé `anon` publique lit aussi birth_date,
-- email, phone, license_number et ffbb_licence_id de tout le club, mineurs
-- compris, en contournant les règles du back (redactLicencieForViewer).
--
-- Décision : `anon` et `authenticated` perdent le droit de lire ces cinq
-- colonnes, y compris pour un club_admin. Seul le back les lit, avec le rôle
-- service_role, APRÈS sa propre décision d'autorisation
-- (src/modules/licencies/read.ts). Les colonnes publiques restent lisibles
-- par `authenticated` sous la RLS existante, inchangée.
--
-- ORDRE DE DÉPLOIEMENT : déployer d'abord le back (il lit déjà les colonnes
-- sensibles en service_role, ce qui marche avant comme après), PUIS appliquer
-- cette migration. Dans l'ordre inverse, les routes licenciés répondraient
-- « permission denied » entre les deux.
--
-- Les droits d'écriture (insert, update, delete) et service_role ne changent
-- pas (les droits d'écriture de anon/authenticated restent à revoir, hors de
-- ce lot). `anon` ne récupère aucune lecture : aucune route publique ne lit
-- `licencies` en direct (elles passent par le back, en service_role).
--
-- Toute NOUVELLE colonne de `licencies` est désormais illisible par
-- `authenticated` tant qu'une migration ne l'accorde pas : c'est voulu.

revoke select on public.licencies from anon, authenticated;

grant select (
  id,
  club_id,
  first_name,
  last_name,
  photo_url,
  team_id,
  active,
  category_label,
  sexe,
  public_admin,
  public_coach,
  public_coordinator,
  coached_team_ids,
  created_at,
  updated_at
) on public.licencies to authenticated;
