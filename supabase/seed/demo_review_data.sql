-- Données FICTIVES du club de démo (revue App Store + captures d'écran).
-- À exécuter après demo_review_club.sql. Ré-exécutable : les dates sont
-- recalculées à partir d'aujourd'hui (week-end à venir, résultats passés,
-- entraînements des 6 prochaines semaines). Ne touche QUE le club de démo.

do $$
declare
  club constant uuid := 'd0000000-0000-4000-8000-000000000001';
  u13 constant uuid := 'd0000000-0000-4000-8000-000000000101';
  u15 constant uuid := 'd0000000-0000-4000-8000-000000000102';
  tz constant text := 'Europe/Paris';
  sat date := current_date + ((6 - extract(dow from current_date)::int + 7) % 7);
begin
  -- 2e équipe (page Tables / Matchs plus remplies).
  insert into public.teams (id, club_id, name, category, sexe, active)
  values (u15, club, 'U15 Démo', 'U15', 'F', true)
  on conflict (id) do nothing;

  insert into public.licencies (id, club_id, first_name, last_name, birth_date, team_id, active)
  values
    ('d0000000-0000-4000-8000-000000000205', club, 'Inès', 'FICTIVE', '2011-04-02', u15, true),
    ('d0000000-0000-4000-8000-000000000206', club, 'Jade', 'EXEMPLE', '2011-08-21', u15, true),
    ('d0000000-0000-4000-8000-000000000207', club, 'Sami', 'DEMO', '2013-01-15', u13, true),
    ('d0000000-0000-4000-8000-000000000208', club, 'Léo', 'TEST', '2013-06-09', u13, true)
  on conflict (id) do nothing;

  -- Matchs à venir : samedi (domicile, 2 équipes) et week-end suivant (extérieur).
  update public.matches set match_datetime = ((sat::text || ' 15:00')::timestamp at time zone tz), is_home = true,
    opponent_name = 'Basket Club Exemple', venue_raw_label = 'Gymnase de démonstration', status = 'scheduled', score_home = null, score_away = null, journee = 'J4'
  where id = 'd0000000-0000-4000-8000-000000000301';
  update public.matches set match_datetime = (((sat + 7)::text || ' 14:00')::timestamp at time zone tz), is_home = false,
    opponent_name = 'Basket Fictif', venue_raw_label = 'Salle fictive', status = 'scheduled', score_home = null, score_away = null, journee = 'J5'
  where id = 'd0000000-0000-4000-8000-000000000302';

  insert into public.matches (id, club_id, ffbb_match_id, team_id, match_datetime, is_home, opponent_name, venue_raw_label, status, emarque_status, ffbb_last_seen_at, journee, score_home, score_away)
  values
    -- U15 à domicile ce samedi (tables à pourvoir).
    ('d0000000-0000-4000-8000-000000000303', club, 'demo-review-3', u15, ((sat::text || ' 17:00')::timestamp at time zone tz), true, 'Union Sportive Exemple', 'Gymnase de démonstration', 'scheduled', 'not_applicable', now(), 'J4', null, null),
    -- Résultats passés (score_home = équipe qui reçoit).
    ('d0000000-0000-4000-8000-000000000304', club, 'demo-review-4', u13, (((sat - 7)::text || ' 15:00')::timestamp at time zone tz), true, 'Avenir Fictif', 'Gymnase de démonstration', 'played', 'not_applicable', now(), 'J3', 62, 48),
    ('d0000000-0000-4000-8000-000000000305', club, 'demo-review-5', u13, (((sat - 14)::text || ' 16:00')::timestamp at time zone tz), false, 'Étoile Exemple', 'Salle de l''Étoile', 'played', 'not_applicable', now(), 'J2', 55, 51),
    ('d0000000-0000-4000-8000-000000000306', club, 'demo-review-6', u13, (((sat - 21)::text || ' 15:00')::timestamp at time zone tz), true, 'Basket Club Exemple', 'Gymnase de démonstration', 'played', 'not_applicable', now(), 'J1', 70, 41),
    ('d0000000-0000-4000-8000-000000000307', club, 'demo-review-7', u15, (((sat - 7)::text || ' 17:00')::timestamp at time zone tz), false, 'Cercle Démo', 'Salle du Cercle', 'played', 'not_applicable', now(), 'J3', 38, 52)
  on conflict (id) do update set match_datetime = excluded.match_datetime, status = excluded.status, score_home = excluded.score_home, score_away = excluded.score_away, journee = excluded.journee;

  -- Le coach demande les disponibilités pour le match de samedi (« À faire » de Camille).
  insert into public.match_availability_requests (club_id, match_id, team_id, opened_at, opened_by_licencie_id)
  select club, 'd0000000-0000-4000-8000-000000000301', u13, now(), 'd0000000-0000-4000-8000-000000000204'
  where not exists (select 1 from public.match_availability_requests where match_id = 'd0000000-0000-4000-8000-000000000301');

  -- Entraînements : mardi et jeudi 18:30–20:00 (U13), mercredi 17:00–18:30 (U15).
  insert into public.training_series (id, club_id, team_id, weekday, start_time, end_time, location_label, starts_on, ends_on)
  values
    ('d0000000-0000-4000-8000-000000000401', club, u13, 2, '18:30', '20:00', 'Gymnase de démonstration', current_date - 21, current_date + 300),
    ('d0000000-0000-4000-8000-000000000402', club, u13, 4, '18:30', '20:00', 'Gymnase de démonstration', current_date - 21, current_date + 300),
    ('d0000000-0000-4000-8000-000000000403', club, u15, 3, '17:00', '18:30', 'Gymnase de démonstration', current_date - 21, current_date + 300)
  on conflict (id) do nothing;

  insert into public.training_occurrences (club_id, team_id, series_id, series_date, starts_at, ends_at, location_label, status)
  select club, s.team_id, s.id, d::date,
         ((d::date::text || ' ' || s.start_time::text)::timestamp at time zone tz),
         ((d::date::text || ' ' || s.end_time::text)::timestamp at time zone tz),
         s.location_label, 'scheduled'
  from public.training_series s
  cross join generate_series(current_date - 14, current_date + 42, interval '1 day') d
  where s.club_id = club and extract(dow from d) = s.weekday
    and not exists (select 1 from public.training_occurrences o where o.series_id = s.id and o.series_date = d::date);
end $$;

select (select count(*) from public.matches where club_id = 'd0000000-0000-4000-8000-000000000001') as matchs,
       (select count(*) from public.training_occurrences where club_id = 'd0000000-0000-4000-8000-000000000001') as seances,
       (select count(*) from public.licencies where club_id = 'd0000000-0000-4000-8000-000000000001') as licencies;
