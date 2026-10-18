-- Test de public.delete_licencie_access contre un vrai Postgres.
-- Prérequis : shims 00/01 + toutes les migrations appliquées sur une base
-- LOCALE (jamais la production). Aucune fixture requise : le script crée ses
-- propres données et se termine par un ROLLBACK (rien ne subsiste).
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/delete_licencie_access.sql
--
-- Une assertion échouée lève une exception (le script s'arrête) : aller
-- jusqu'au bout sans erreur = tous les tests passent. Valeurs sentinelles
-- fictives uniquement.

begin;

create or replace function pg_temp.check_that(label text, ok boolean) returns void
language plpgsql as $$
begin
  if ok is not true then
    raise exception 'ECHEC [%]', label;
  end if;
  raise notice 'OK [%]', label;
end;
$$;

-- Deux clubs ; cible + témoin + enfant d'une session partagée dans le club D ; un licencié dans le club E.
insert into public.clubs (id, name, slug, ffbb_club_id, timezone) values
  ('dddddddd-0000-0000-0000-000000000000', 'Club D', 'club-d-del', 'DDD0000001', 'Europe/Paris'),
  ('eeeeeeee-0000-0000-0000-000000000000', 'Club E', 'club-e-del', 'EEE0000001', 'Europe/Paris');

insert into public.licencies (id, club_id, first_name, last_name, license_number, email, phone, photo_url, public_admin, public_coach, public_coordinator) values
  ('dddddddd-0000-0000-0000-00000000000a', 'dddddddd-0000-0000-0000-000000000000', 'Cible', 'Sentinelle', 'LIC-CIBLE', 'sentinelle-cible@example.invalid', '+33600000001', 'https://x.supabase.co/storage/v1/object/public/licencie-photos/dddddddd-0000-0000-0000-000000000000/cible/p.webp', true, true, true),
  ('dddddddd-0000-0000-0000-00000000000b', 'dddddddd-0000-0000-0000-000000000000', 'Temoin', 'Sentinelle', 'LIC-TEMOIN', 'sentinelle-temoin@example.invalid', '+33600000002', 'https://x.supabase.co/storage/v1/object/public/licencie-photos/dddddddd-0000-0000-0000-000000000000/temoin/p.webp', true, true, true),
  ('dddddddd-0000-0000-0000-00000000000c', 'dddddddd-0000-0000-0000-000000000000', 'Frere', 'Sentinelle', 'LIC-FRERE', 'sentinelle-frere@example.invalid', null, null, false, false, false),
  ('eeeeeeee-0000-0000-0000-00000000000a', 'eeeeeeee-0000-0000-0000-000000000000', 'Autre', 'Club', 'LIC-AUTRE', 'sentinelle-autre@example.invalid', '+33600000003', null, true, false, false);

insert into public.licencie_public_tokens (id, club_id, licencie_id, token_hash, email) values
  ('dddddddd-0000-0000-0000-0000000000a1', 'dddddddd-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-00000000000a', 'hash-cible', 'sentinelle-cible@example.invalid'),
  ('dddddddd-0000-0000-0000-0000000000b1', 'dddddddd-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-00000000000b', 'hash-temoin', 'sentinelle-temoin@example.invalid'),
  ('dddddddd-0000-0000-0000-0000000000c1', 'dddddddd-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-00000000000c', 'hash-frere', null),
  ('eeeeeeee-0000-0000-0000-0000000000a1', 'eeeeeeee-0000-0000-0000-000000000000', 'eeeeeeee-0000-0000-0000-00000000000a', 'hash-autre', null);

-- s1 : cible seule ; s2 : cible + frère (session partagée) ; s3 : témoin ; s4 : autre club.
insert into public.device_sessions (id, club_id, secret_hash, platform, expires_at) values
  ('dddddddd-0000-0000-0000-0000000000f1', 'dddddddd-0000-0000-0000-000000000000', 's-hash-1', 'ios', now() + interval '1 day'),
  ('dddddddd-0000-0000-0000-0000000000f2', 'dddddddd-0000-0000-0000-000000000000', 's-hash-2', 'ios', now() + interval '1 day'),
  ('dddddddd-0000-0000-0000-0000000000f3', 'dddddddd-0000-0000-0000-000000000000', 's-hash-3', 'ios', now() + interval '1 day'),
  ('eeeeeeee-0000-0000-0000-0000000000f4', 'eeeeeeee-0000-0000-0000-000000000000', 's-hash-4', 'ios', now() + interval '1 day');

insert into public.device_session_grants (session_id, club_id, licencie_id, token_id) values
  ('dddddddd-0000-0000-0000-0000000000f1', 'dddddddd-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-00000000000a', 'dddddddd-0000-0000-0000-0000000000a1'),
  ('dddddddd-0000-0000-0000-0000000000f2', 'dddddddd-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-00000000000a', 'dddddddd-0000-0000-0000-0000000000a1'),
  ('dddddddd-0000-0000-0000-0000000000f2', 'dddddddd-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-00000000000c', 'dddddddd-0000-0000-0000-0000000000c1'),
  ('dddddddd-0000-0000-0000-0000000000f3', 'dddddddd-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-00000000000b', 'dddddddd-0000-0000-0000-0000000000b1'),
  ('eeeeeeee-0000-0000-0000-0000000000f4', 'eeeeeeee-0000-0000-0000-000000000000', 'eeeeeeee-0000-0000-0000-00000000000a', 'eeeeeeee-0000-0000-0000-0000000000a1');

insert into public.device_push_tokens (session_id, club_id, token, environment) values
  ('dddddddd-0000-0000-0000-0000000000f1', 'dddddddd-0000-0000-0000-000000000000', 'push-s1', 'production'),
  ('dddddddd-0000-0000-0000-0000000000f2', 'dddddddd-0000-0000-0000-000000000000', 'push-s2', 'production'),
  ('dddddddd-0000-0000-0000-0000000000f3', 'dddddddd-0000-0000-0000-000000000000', 'push-s3', 'production'),
  ('eeeeeeee-0000-0000-0000-0000000000f4', 'eeeeeeee-0000-0000-0000-000000000000', 'push-s4', 'production');

insert into public.licencie_claim_requests (club_id, licencie_id, requested_email) values
  ('dddddddd-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-00000000000a', 'sentinelle-cible@example.invalid'),
  ('dddddddd-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-00000000000b', 'sentinelle-temoin@example.invalid'),
  ('eeeeeeee-0000-0000-0000-000000000000', 'eeeeeeee-0000-0000-0000-00000000000a', 'sentinelle-autre@example.invalid');

-- Instantané du témoin, du frère et de l'autre club AVANT l'appel.
create temp table before_other as
  select l.id, to_jsonb(l) as fiche,
         (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.licencie_public_tokens t where t.licencie_id = l.id) as tokens,
         (select coalesce(jsonb_agg(to_jsonb(g) order by g.session_id), '[]') from public.device_session_grants g where g.licencie_id = l.id) as grants,
         (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from public.licencie_claim_requests c where c.licencie_id = l.id) as claims
    from public.licencies l
   where l.id in ('dddddddd-0000-0000-0000-00000000000b', 'dddddddd-0000-0000-0000-00000000000c', 'eeeeeeee-0000-0000-0000-00000000000a');

-- L'appel : cible seule, dans le club D.
create temp table result as
  select public.delete_licencie_access('dddddddd-0000-0000-0000-000000000000', array['dddddddd-0000-0000-0000-00000000000a']::uuid[]) as photos;

-- Valeur de retour : l'ancienne photo de la cible, seulement.
select pg_temp.check_that('retourne la photo de la cible', (select photos from result) = array['https://x.supabase.co/storage/v1/object/public/licencie-photos/dddddddd-0000-0000-0000-000000000000/cible/p.webp']);

-- Cible : accès supprimé.
select pg_temp.check_that('cible : plus de jeton', not exists (select 1 from public.licencie_public_tokens where licencie_id = 'dddddddd-0000-0000-0000-00000000000a'));
select pg_temp.check_that('cible : plus de droit de session', not exists (select 1 from public.device_session_grants where licencie_id = 'dddddddd-0000-0000-0000-00000000000a'));
select pg_temp.check_that('cible : plus de demande de réclamation', not exists (select 1 from public.licencie_claim_requests where licencie_id = 'dddddddd-0000-0000-0000-00000000000a'));
select pg_temp.check_that('cible : session seule supprimée', not exists (select 1 from public.device_sessions where id = 'dddddddd-0000-0000-0000-0000000000f1'));
select pg_temp.check_that('cible : jeton push de la session supprimée disparu', not exists (select 1 from public.device_push_tokens where token = 'push-s1'));

-- Session partagée : conservée pour le frère, avec son jeton push.
select pg_temp.check_that('session partagée conservée', exists (select 1 from public.device_sessions where id = 'dddddddd-0000-0000-0000-0000000000f2'));
select pg_temp.check_that('session partagée : le frère garde son droit', (select count(*) from public.device_session_grants where session_id = 'dddddddd-0000-0000-0000-0000000000f2' and licencie_id = 'dddddddd-0000-0000-0000-00000000000c') = 1);
select pg_temp.check_that('session partagée : plus de droit pour la cible', (select count(*) from public.device_session_grants where session_id = 'dddddddd-0000-0000-0000-0000000000f2') = 1);
select pg_temp.check_that('session partagée : jeton push conservé', exists (select 1 from public.device_push_tokens where token = 'push-s2'));

-- Fiche de la cible : contact effacé, drapeaux à false, identité sportive intacte.
select pg_temp.check_that('fiche cible : conservée avec nom et licence', exists (select 1 from public.licencies where id = 'dddddddd-0000-0000-0000-00000000000a' and first_name = 'Cible' and last_name = 'Sentinelle' and license_number = 'LIC-CIBLE'));
select pg_temp.check_that('fiche cible : contact et photo effacés', exists (select 1 from public.licencies where id = 'dddddddd-0000-0000-0000-00000000000a' and email is null and phone is null and photo_url is null));
select pg_temp.check_that('fiche cible : drapeaux à false', exists (select 1 from public.licencies where id = 'dddddddd-0000-0000-0000-00000000000a' and not public_admin and not public_coach and not public_coordinator));

-- Aucune trace des sentinelles de la cible.
select pg_temp.check_that('aucune trace de sentinelle-cible / +33600000001', not exists (
  select 1 from (
    select to_jsonb(t)::text as j from public.licencies t
    union all select to_jsonb(t)::text from public.licencie_public_tokens t
    union all select to_jsonb(t)::text from public.licencie_claim_requests t
    union all select to_jsonb(t)::text from public.device_sessions t
    union all select to_jsonb(t)::text from public.device_session_grants t
    union all select to_jsonb(t)::text from public.device_push_tokens t
  ) x where j like '%sentinelle-cible%' or j like '%+33600000001%'));

-- Témoin, frère et autre club : strictement inchangés.
select pg_temp.check_that('témoin, frère, autre club inchangés', not exists (
  select 1 from before_other b join public.licencies l on l.id = b.id
  where to_jsonb(l) is distinct from b.fiche
     or (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]') from public.licencie_public_tokens t where t.licencie_id = l.id) is distinct from b.tokens
     or (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from public.licencie_claim_requests c where c.licencie_id = l.id) is distinct from b.claims
     or (select coalesce(jsonb_agg(to_jsonb(g) order by g.session_id), '[]') from public.device_session_grants g where g.licencie_id = l.id) is distinct from b.grants
));
select pg_temp.check_that('sessions et jetons push du témoin et de l''autre club conservés', (select count(*) from public.device_push_tokens where token in ('push-s3', 'push-s4')) = 2
  and (select count(*) from public.device_sessions where id in ('dddddddd-0000-0000-0000-0000000000f3', 'eeeeeeee-0000-0000-0000-0000000000f4')) = 2);

-- Un identifiant d'un autre club ne touche rien (appel avec le mauvais club).
select public.delete_licencie_access('dddddddd-0000-0000-0000-000000000000', array['eeeeeeee-0000-0000-0000-00000000000a']::uuid[]);
select pg_temp.check_that('licencié d''un autre club : rien touché', exists (select 1 from public.licencies where id = 'eeeeeeee-0000-0000-0000-00000000000a' and email = 'sentinelle-autre@example.invalid' and public_admin)
  and exists (select 1 from public.licencie_public_tokens where id = 'eeeeeeee-0000-0000-0000-0000000000a1'));

-- Liste vide / nulle : aucune erreur, rien de renvoyé.
select pg_temp.check_that('liste vide', public.delete_licencie_access('dddddddd-0000-0000-0000-000000000000', '{}') = '{}');
select pg_temp.check_that('liste nulle', public.delete_licencie_access('dddddddd-0000-0000-0000-000000000000', null) = '{}');

-- Droits : refusée aux rôles anon / authenticated.
do $$
begin
  set local role authenticated;
  perform public.delete_licencie_access('dddddddd-0000-0000-0000-000000000000', '{}');
  reset role;
  raise exception 'ECHEC [authenticated] : appel aurait du etre refuse';
exception
  when insufficient_privilege then
    reset role;
    raise notice 'OK [authenticated refusé]';
end;
$$;

rollback;
