-- Garde-fou (audit S-10, lot 3) : toute fonction SECURITY DEFINER des schémas
-- applicatifs doit figer son search_path (clause `set search_path` dans
-- proconfig). Sans cela, un appelant peut faire résoudre à la fonction, qui
-- s'exécute avec les droits de son propriétaire, un objet qu'il a lui-même
-- placé en tête de son search_path.
--
-- Schémas exclus : ceux de la plateforme Supabase, qui ne viennent pas des
-- migrations du dépôt. Notamment `net` (extension pg_net, propriétaire
-- supabase_admin, search_path=net posé par l'extension : fonctions
-- net.http_get / net.http_post), `auth`, `storage`, `extensions`, `realtime`,
-- `graphql*`, `pgsodium`, `vault`, `supabase_*` et `pg_*`.
--
-- Le script prouve d'abord qu'il détecte un oubli (fonction sonde créée sans
-- search_path, doit être signalée), puis contrôle la base réelle. Tout est
-- annulé par le ROLLBACK final.
--
-- Prérequis : base LOCALE, toutes les migrations appliquées.
--
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/security_definer_search_path.sql

begin;

create or replace function pg_temp.definer_without_search_path() returns text[]
language sql as $$
  select coalesce(array_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' order by n.nspname, p.proname), '{}')
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
    and n.nspname not in ('auth', 'storage', 'extensions', 'realtime', 'graphql', 'graphql_public', 'pgsodium', 'vault', 'net')
    and n.nspname not like 'supabase%'
    and n.nspname not like 'pg_%';
$$;

-- Auto-test : une fonction SECURITY DEFINER sans search_path doit être signalée.
create function public.__probe_definer() returns int
language sql security definer as $$ select 1 $$;

do $$
begin
  if not ('public.__probe_definer()' = any (pg_temp.definer_without_search_path())) then
    raise exception 'ECHEC auto-test : la fonction sonde sans search_path n''est pas détectée';
  end if;
  raise notice 'OK [auto-test] la fonction sonde sans search_path est détectée';
end;
$$;

-- Une fonction sonde AVEC search_path ne doit pas être signalée.
alter function public.__probe_definer() set search_path = public;

do $$
begin
  if 'public.__probe_definer()' = any (pg_temp.definer_without_search_path()) then
    raise exception 'ECHEC auto-test : la fonction sonde avec search_path est signalée à tort';
  end if;
  raise notice 'OK [auto-test] la fonction sonde avec search_path n''est pas signalée';
end;
$$;

drop function public.__probe_definer();

-- Contrôle réel.
do $$
declare
  offenders text[] := pg_temp.definer_without_search_path();
begin
  if cardinality(offenders) > 0 then
    raise exception E'ECHEC security_definer_search_path : SECURITY DEFINER sans search_path :\n%', array_to_string(offenders, E'\n');
  end if;
  raise notice '=== TESTS security_definer_search_path PASSES ===';
end;
$$;

rollback;
