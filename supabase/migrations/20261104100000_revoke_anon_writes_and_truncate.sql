-- =============================================================================
-- Lot B1 — droits d'écriture de `anon` et TRUNCATE (audit sécurité 2026-11).
--
-- Constat : par défaut Supabase accorde à `anon` et `authenticated` tous les
-- droits sur les tables du schéma `public`. La RLS filtre les lignes de
-- SELECT/INSERT/UPDATE/DELETE, mais PAS `TRUNCATE` (ni REFERENCES/TRIGGER) :
-- un simple jeton `authenticated`, voire la clé publique `anon`, pouvait vider
-- une table via PostgREST/SQL si une règle RLS était oubliée.
--
-- Correctif :
--   * `anon` : plus aucune écriture sur `public`. Aucune route ne l'utilise
--     (les espaces publics passent par le back en service_role). Seule
--     exception, vérifiée : le worker FBI du VPS insère son journal dans
--     `fbi_probe_events` avec la clé publique (policy « insert to anon » à
--     jeton, voir 20261007090000_fbi_probe_events.sql).
--   * `authenticated` : plus de TRUNCATE / REFERENCES / TRIGGER. Les écritures
--     ordinaires restent permises sous RLS : les routes écrivent au nom de
--     l'utilisateur. Un durcissement table par table (retirer INSERT/UPDATE/
--     DELETE où seul le service_role écrit) est un lot à part.
--   * Droits par défaut alignés pour les tables créées plus tard.
--
-- Aucun effet sur service_role (back, crons, jobs) ni sur les droits par
-- colonne déjà posés (profiles, clubs, licencies).
--
-- DÉPLOIEMENT : `supabase db push --dry-run` ne doit lister que cette
-- migration. Aucun changement de code du back n'est nécessaire.
-- Vérification après coup (SQL editor, doit renvoyer 0 ligne) :
--   select table_name, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and grantee = 'anon'
--     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
--     and table_name <> 'fbi_probe_events';
-- =============================================================================

revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- Seule écriture légitime de `anon` : le journal du worker FBI (RLS : jeton valide).
grant insert on public.fbi_probe_events to anon;

revoke truncate, references, trigger on all tables in schema public from authenticated;

-- Tables futures : mêmes droits restreints par défaut.
alter default privileges for role postgres in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from authenticated;
