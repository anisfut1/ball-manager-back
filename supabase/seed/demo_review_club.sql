-- Club de DÉMONSTRATION pour la revue App Store (ball-manager-web/docs/APP_STORE.md).
-- PRÉPARÉ, NON APPLIQUÉ. Données 100 % fictives. Idempotent.
--
-- Après application : dans l'espace club (admin plateforme), donner une
-- adresse email que VOUS lisez au licencié « Camille DEMO », puis demander
-- son lien depuis /public/club-demo/… (« Recevoir un lien »). Le lien reçu
-- est à coller dans les notes de revue App Store (l'app sait l'ouvrir :
-- « J'ai reçu un lien Ball Manager »). Ne JAMAIS commiter ce lien.
--
-- Synchro FFBB désactivée (ffbb_enabled = false) : rien ne vient écraser ces données.
-- Pour retirer le club : delete from public.clubs where slug = 'club-demo';  (cascade)

insert into public.clubs (id, name, short_name, slug, ffbb_club_id, timezone, status, ffbb_enabled)
values ('d0000000-0000-4000-8000-000000000001', 'Club Démo Ball Manager', 'Démo', 'club-demo', 'DEMO-REVIEW', 'Europe/Paris', 'active', false)
on conflict (id) do nothing;

insert into public.teams (id, club_id, name, category, sexe, active)
values ('d0000000-0000-4000-8000-000000000101', 'd0000000-0000-4000-8000-000000000001', 'U13 Démo', 'U13', 'M', true)
on conflict (id) do nothing;

-- Licenciés fictifs (aucun email/téléphone : à renseigner à la main pour la démo).
insert into public.licencies (id, club_id, first_name, last_name, birth_date, team_id, active, public_coach, coached_team_ids)
values
  ('d0000000-0000-4000-8000-000000000201', 'd0000000-0000-4000-8000-000000000001', 'Camille', 'DEMO', '2013-05-01', 'd0000000-0000-4000-8000-000000000101', true, false, '{}'),
  ('d0000000-0000-4000-8000-000000000202', 'd0000000-0000-4000-8000-000000000001', 'Noah', 'EXEMPLE', '2013-03-12', 'd0000000-0000-4000-8000-000000000101', true, false, '{}'),
  ('d0000000-0000-4000-8000-000000000203', 'd0000000-0000-4000-8000-000000000001', 'Lou', 'TEST', '2013-09-30', 'd0000000-0000-4000-8000-000000000101', true, false, '{}'),
  ('d0000000-0000-4000-8000-000000000204', 'd0000000-0000-4000-8000-000000000001', 'Alex', 'COACHDEMO', null, 'd0000000-0000-4000-8000-000000000101', true, true, '{d0000000-0000-4000-8000-000000000101}')
on conflict (id) do nothing;

-- Deux matchs à venir (domicile / extérieur), relatifs à la date d'application.
insert into public.matches (id, club_id, ffbb_match_id, team_id, match_datetime, is_home, opponent_name, venue_raw_label, status, emarque_status, ffbb_last_seen_at)
values
  ('d0000000-0000-4000-8000-000000000301', 'd0000000-0000-4000-8000-000000000001', 'demo-review-1', 'd0000000-0000-4000-8000-000000000101',
   date_trunc('day', now()) + interval '6 days 14 hours', true, 'Équipe Exemple', 'Gymnase de démonstration', 'scheduled', 'not_applicable', now()),
  ('d0000000-0000-4000-8000-000000000302', 'd0000000-0000-4000-8000-000000000001', 'demo-review-2', 'd0000000-0000-4000-8000-000000000101',
   date_trunc('day', now()) + interval '13 days 15 hours', false, 'Basket Fictif', 'Salle fictive', 'scheduled', 'not_applicable', now())
on conflict (id) do nothing;
