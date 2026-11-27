-- =============================================================================
-- Fonctions SECURITY DEFINER appelables sans connexion (conseiller sécurité
-- Supabase, lint 0028, constaté le 2026-11-27).
--
-- Constat : par défaut, PostgreSQL accorde EXECUTE à PUBLIC sur toute fonction,
-- et Supabase l'accorde aussi à `anon` et `authenticated`. Les fonctions
-- d'appartenance ci-dessous étaient donc appelables avec la seule clé publique
-- via `/rest/v1/rpc/...`, ce qui permettait de sonder rôles et appartenances.
--
-- Correctif :
--   * `is_club_member`, `has_club_role`, `is_platform_admin`,
--     `can_read_derogation_request` : retirées à PUBLIC et `anon`, gardées pour
--     `authenticated` (utilisées par les policies RLS des utilisateurs
--     connectés et par `rpc("is_platform_admin")` dans le back, appelé avec le
--     JWT de l'utilisateur) et `service_role`.
--   * `check_derogation_request_same_club` : fonction de trigger, jamais appelée
--     directement. EXECUTE retiré à PUBLIC, `anon` et `authenticated` (un
--     trigger s'exécute sans vérifier ce droit chez l'utilisateur).
--   * `fbi_probe_token_valid` : NON modifiée. La policy « insert to anon » de
--     `fbi_probe_events` l'appelle avec la clé publique (worker FBI de
--     diagnostic, voir 20261007090000_fbi_probe_events.sql).
--
-- Vérifié avant écriture : aucune policy pour `anon` ou PUBLIC n'appelle ces
-- fonctions (hors `fbi_probe_token_valid`). Aucun changement de code du back.
--
-- Vérification après coup (doit renvoyer 0 ligne) :
--   select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in ('is_club_member','has_club_role','is_platform_admin',
--                       'can_read_derogation_request','check_derogation_request_same_club')
--     and has_function_privilege('anon', p.oid, 'EXECUTE');
-- =============================================================================

revoke execute on function public.is_club_member(uuid) from public, anon;
revoke execute on function public.has_club_role(uuid, public.club_role) from public, anon;
revoke execute on function public.is_platform_admin() from public, anon;
revoke execute on function public.can_read_derogation_request(uuid, uuid, uuid) from public, anon;

grant execute on function public.is_club_member(uuid) to authenticated, service_role;
grant execute on function public.has_club_role(uuid, public.club_role) to authenticated, service_role;
grant execute on function public.is_platform_admin() to authenticated, service_role;
grant execute on function public.can_read_derogation_request(uuid, uuid, uuid) to authenticated, service_role;

revoke execute on function public.check_derogation_request_same_club() from public, anon, authenticated;
grant execute on function public.check_derogation_request_same_club() to service_role;
