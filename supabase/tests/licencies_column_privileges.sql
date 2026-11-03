-- Colonnes sensibles de public.licencies : lecture directe (PostgREST) fermée
-- à anon et authenticated, y compris pour un club_admin (audit S-1, lot 2b).
-- Seul le back les lit, en service_role, après sa propre décision d'autorisation.
--
-- Prérequis : base LOCALE, toutes les migrations appliquées (`supabase db reset`
-- en local, ou shims 00/01 + migrations, voir README). Le script crée ses
-- propres données, se termine par un ROLLBACK (rien ne subsiste), et n'utilise
-- que des valeurs sentinelles fictives.
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/licencies_column_privileges.sql
--
-- Toutes les assertions sont jouées, puis le script échoue en listant chaque
-- assertion en échec. Aller jusqu'au bout sans erreur = tous les tests passent.

begin;

-- Accumule les échecs (set_config local à la transaction, donc utilisable
-- sous n'importe quel rôle) pour les afficher tous d'un coup à la fin.
create or replace function pg_temp.fail(msg text) returns void
language plpgsql as $$
begin
  perform set_config('app.failures', coalesce(nullif(current_setting('app.failures', true), ''), '') || msg || E'\n', true);
  raise notice 'ECHEC [%]', msg;
end;
$$;

-- La requête doit être refusée par un droit manquant (permission denied).
create or replace function pg_temp.assert_denied(label text, stmt text) returns void
language plpgsql as $$
begin
  execute stmt;
  perform pg_temp.fail(label || ' : aurait dû être refusé (permission denied)');
exception
  when insufficient_privilege then
    raise notice 'OK [%] (permission refusée comme attendu)', label;
end;
$$;

-- Nombre de lignes renvoyées, ou -1 si la requête est refusée.
create or replace function pg_temp.rows_or_denied(stmt text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute 'select count(*) from (' || stmt || ') q' into n;
  return n;
exception
  when insufficient_privilege then
    return -1;
end;
$$;

create or replace function pg_temp.assert_rows(label text, stmt text, expected bigint) returns void
language plpgsql as $$
declare
  n bigint := pg_temp.rows_or_denied(stmt);
begin
  if n = expected then
    raise notice 'OK [%] (=%)', label, n;
  else
    perform pg_temp.fail(label || format(' : attendu %s ligne(s), obtenu %s (-1 = refusé)', expected, n));
  end if;
end;
$$;

-- Nombre de lignes modifiées par une écriture, ou -1 si refusée.
create or replace function pg_temp.update_count(stmt text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
exception
  when insufficient_privilege then
    return -1;
end;
$$;

-- Un club, une cible aux cinq sentinelles, un joueur et un club_admin membres du club.
insert into public.clubs (id, name, slug, ffbb_club_id, timezone) values
  ('cccccccc-1111-0000-0000-000000000000', 'Club Privileges', 'club-privileges', 'PRV0000001', 'Europe/Paris');

insert into public.licencies (id, club_id, first_name, last_name, birth_date, license_number, email, phone, ffbb_licence_id) values
  ('cccccccc-1111-0000-0000-00000000000a', 'cccccccc-1111-0000-0000-000000000000', 'Camille', 'Sentinelle',
   '1901-01-01', 'SENTINEL-LIC-0000', 'sentinel-pii@example.invalid', '+33000000099', 'SENTINEL-FFBB-0000');

insert into auth.users (id, email) values
  ('cccccccc-1111-0000-0000-0000000000a1', 'joueur-privileges@example.invalid'),
  ('cccccccc-1111-0000-0000-0000000000a2', 'admin-privileges@example.invalid');

insert into public.club_memberships (id, club_id, user_id) values
  ('cccccccc-1111-0000-0000-0000000000b1', 'cccccccc-1111-0000-0000-000000000000', 'cccccccc-1111-0000-0000-0000000000a1'),
  ('cccccccc-1111-0000-0000-0000000000b2', 'cccccccc-1111-0000-0000-000000000000', 'cccccccc-1111-0000-0000-0000000000a2');

insert into public.membership_roles (membership_id, role) values
  ('cccccccc-1111-0000-0000-0000000000b1', 'joueur'),
  ('cccccccc-1111-0000-0000-0000000000b2', 'club_admin');

-- Rejoue les assertions pour un compte membre du club (rôle authenticated + claims).
create or replace function pg_temp.check_member(who text, uid text) returns void
language plpgsql as $$
declare
  col text;
  target constant text := 'cccccccc-1111-0000-0000-00000000000a';
  updated bigint;
begin
  perform set_config('request.jwt.claim.sub', uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- Colonnes publiques : toujours lisibles sous la RLS existante.
  perform pg_temp.assert_rows(who || ' lit nom/prénom de la cible',
    format('select first_name, last_name, photo_url, team_id, active, public_coach, coached_team_ids from public.licencies where id = %L', target), 1);

  -- Colonnes sensibles : refusées, une par une, même pour le club_admin.
  foreach col in array array['birth_date', 'email', 'phone', 'license_number', 'ffbb_licence_id'] loop
    perform pg_temp.assert_denied(who || ' select ' || col, format('select %I from public.licencies where id = %L', col, target));
  end loop;

  perform pg_temp.assert_denied(who || ' select *', format('select * from public.licencies where id = %L', target));
  perform pg_temp.assert_denied(who || ' filtre sur email', 'select first_name from public.licencies where email = ''sentinel-pii@example.invalid''');
  perform pg_temp.assert_denied(who || ' filtre sur license_number', 'select first_name from public.licencies where license_number = ''SENTINEL-LIC-0000''');
  perform pg_temp.assert_denied(who || ' tri sur phone', 'select first_name from public.licencies order by phone');
  perform pg_temp.assert_denied(who || ' count filtré sur birth_date', 'select count(*) from public.licencies where birth_date = ''1901-01-01''');

  execute 'reset role';
end;
$$;

select pg_temp.check_member('joueur', 'cccccccc-1111-0000-0000-0000000000a1');
select pg_temp.check_member('club_admin', 'cccccccc-1111-0000-0000-0000000000a2');

-- Écriture inchangée : le club_admin modifie toujours une colonne publique.
create or replace function pg_temp.check_admin_write() returns void
language plpgsql as $$
declare
  n bigint;
begin
  perform set_config('request.jwt.claim.sub', 'cccccccc-1111-0000-0000-0000000000a2', true);
  execute 'set local role authenticated';
  n := pg_temp.update_count('update public.licencies set photo_url = ''https://example.invalid/p.webp'' where id = ''cccccccc-1111-0000-0000-00000000000a''');
  if n = 1 then
    raise notice 'OK [club_admin écrit toujours une colonne publique] (=1)';
  else
    perform pg_temp.fail(format('club_admin update colonne publique : attendu 1 ligne, obtenu %s (-1 = refusé)', n));
  end if;
  execute 'reset role';
end;
$$;
select pg_temp.check_admin_write();

-- anon : aucune ligne, ou refusé (jamais une sentinelle).
create or replace function pg_temp.check_anon() returns void
language plpgsql as $$
declare
  n bigint;
begin
  execute 'set local role anon';
  n := pg_temp.rows_or_denied('select first_name from public.licencies');
  if n <= 0 then
    raise notice 'OK [anon ne lit aucune ligne] (=%)', n;
  else
    perform pg_temp.fail(format('anon lit %s ligne(s)', n));
  end if;
  perform pg_temp.assert_denied('anon select email', 'select email from public.licencies');
  execute 'reset role';
end;
$$;
select pg_temp.check_anon();

-- service_role (le back) : les cinq sentinelles restent lisibles.
create or replace function pg_temp.check_service_role() returns void
language plpgsql as $$
begin
  execute 'set local role service_role';
  perform pg_temp.assert_rows('service_role lit les cinq sentinelles',
    $q$select 1 from public.licencies
       where id = 'cccccccc-1111-0000-0000-00000000000a'
         and birth_date = '1901-01-01' and email = 'sentinel-pii@example.invalid' and phone = '+33000000099'
         and license_number = 'SENTINEL-LIC-0000' and ffbb_licence_id = 'SENTINEL-FFBB-0000'$q$, 1);
  execute 'reset role';
end;
$$;
select pg_temp.check_service_role();

-- Verdict : toutes les assertions ont été jouées, on échoue s'il y en a.
do $$
begin
  if coalesce(nullif(current_setting('app.failures', true), ''), '') <> '' then
    raise exception E'ECHEC licencies_column_privileges :\n%', current_setting('app.failures', true);
  end if;
  raise notice '=== TESTS licencies_column_privileges PASSES ===';
end;
$$;

rollback;
