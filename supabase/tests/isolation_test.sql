-- Tests d'isolation RLS reels, executes contre un vrai moteur Postgres
-- (shim local reproduisant auth.uid()/roles Supabase). Chaque assertion
-- echouee leve une exception explicite (le script s'arrete au premier
-- echec) ; un script qui va jusqu'au bout sans erreur = tous les tests OK.

set client_min_messages to notice;

create or replace function pg_temp.assert_count(label text, expected bigint, actual bigint) returns void
language plpgsql as $$
begin
  if expected <> actual then
    raise exception 'ECHEC [%] : attendu %, obtenu %', label, expected, actual;
  else
    raise notice 'OK [%] (=%)', label, actual;
  end if;
end;
$$;

-- Vérifie qu'appeler `claim_next_fbi_job` sous le rôle courant lève bien
-- une erreur de permission (§49 du brief FBI : jamais accessible à un rôle
-- authenticated, uniquement service_role) — pas juste "renvoie rien".
create or replace function pg_temp.assert_claim_next_fbi_job_denied(label text) returns void
language plpgsql as $$
begin
  perform public.claim_next_fbi_job('rogue-authenticated-caller');
  raise exception 'ECHEC [%] : claim_next_fbi_job aurait du etre refusee (permission denied)', label;
exception
  when insufficient_privilege then
    raise notice 'OK [%] (permission refusee comme attendu)', label;
end;
$$;

-- =============================================================
-- Scenario 1 : User A (membre UNIQUEMENT du Club A) ne voit QUE le Club A
-- =============================================================
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

select pg_temp.assert_count('user A - matches visibles', 1, (select count(*) from public.matches));
select pg_temp.assert_count('user A - matches: bien celui du club A', 1, (select count(*) from public.matches where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user A - matches club B invisibles', 0, (select count(*) from public.matches where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));

select pg_temp.assert_count('user A - sync_runs visibles (club_admin de A)', 1, (select count(*) from public.sync_runs));
select pg_temp.assert_count('user A - emarque_imports visibles', 1, (select count(*) from public.emarque_imports));
select pg_temp.assert_count('user A - match_participants visibles', 1, (select count(*) from public.match_participants));
select pg_temp.assert_count('user A - player_match_stats visibles', 1, (select count(*) from public.player_match_stats));

-- licencies : lecture "own" uniquement (pas de membership.licencie_id ici) + club_admin => tout le club A
select pg_temp.assert_count('user A - licencies visibles (club_admin de A)', 1, (select count(*) from public.licencies));

-- fbi_credentials : AUCUNE policy authenticated => invisible meme pour son propre club
select pg_temp.assert_count('user A - fbi_credentials TOUJOURS invisibles (service role only)', 0, (select count(*) from public.fbi_credentials));

-- fbi_jobs / match_documents (voir docs/FBI_WORKER.md) : memes garanties que le reste (§56 du brief FBI).
select pg_temp.assert_count('user A - fbi_jobs visibles (club_admin de A)', 1, (select count(*) from public.fbi_jobs));
select pg_temp.assert_count('user A - fbi_jobs club B invisibles', 0, (select count(*) from public.fbi_jobs where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user A - match_documents visibles (club_admin de A)', 1, (select count(*) from public.match_documents));
select pg_temp.assert_count('user A - match_documents club B invisibles', 0, (select count(*) from public.match_documents where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));

-- fbi_jobs n'a AUCUNE policy d'ecriture pour authenticated (worker/service
-- role uniquement, §49 du brief FBI) : meme le club_admin DE CE CLUB ne
-- peut pas modifier une ligne fbi_jobs.
update public.fbi_jobs set status = 'succeeded' where club_id = 'aaaaaaaa-0000-0000-0000-000000000000';
select pg_temp.assert_count('user A - UPDATE fbi_jobs (meme son propre club) refuse', 0, (select count(*) from public.fbi_jobs where club_id = 'aaaaaaaa-0000-0000-0000-000000000000' and status = 'succeeded'));

-- match_documents a une policy ALL pour le club_admin de SON club (utile
-- pour une future action admin), mais jamais pour un autre club.
update public.match_documents set status = 'error' where club_id = 'bbbbbbbb-0000-0000-0000-000000000000';
select pg_temp.assert_count('user A - UPDATE match_documents club B affecte 0 ligne', 0, (select count(*) from public.match_documents where club_id = 'bbbbbbbb-0000-0000-0000-000000000000' and status = 'error'));

-- Gap 1 (PATCH /v1/clubs/:clubId, resolution des gaps frontend) : la
-- lockdown colonne-par-colonne posee par
-- 20260921100090_rls_multitenant_rewrite.sql (`revoke update on
-- public.clubs from authenticated; grant update (name, short_name,
-- logo_url, accent_color, timezone) ...`) doit reellement empecher
-- authenticated de modifier status/slug/ffbb_club_id/ffbb_enabled — meme
-- pour SON PROPRE club, meme en cas de bug applicatif qui laisserait
-- passer ces champs. La route ne les expose pas dans son DTO, mais c'est
-- cette GRANT/REVOKE au niveau colonne qui le garantit structurellement.
create or replace function pg_temp.assert_column_update_denied(label text, stmt text) returns void
language plpgsql as $$
begin
  execute stmt;
  raise exception 'ECHEC [%] : cette mise a jour de colonne aurait du etre refusee (permission denied)', label;
exception
  when insufficient_privilege then
    raise notice 'OK [%] (permission refusee comme attendu)', label;
end;
$$;

select pg_temp.assert_column_update_denied(
  'user A - UPDATE clubs.status refuse (colonne non accordee a authenticated)',
  $stmt$update public.clubs set status = 'suspended' where id = 'aaaaaaaa-0000-0000-0000-000000000000'$stmt$
);
select pg_temp.assert_column_update_denied(
  'user A - UPDATE clubs.ffbb_club_id refuse (colonne non accordee a authenticated)',
  $stmt$update public.clubs set ffbb_club_id = 'HACKED0001' where id = 'aaaaaaaa-0000-0000-0000-000000000000'$stmt$
);
select pg_temp.assert_column_update_denied(
  'user A - UPDATE clubs.slug refuse (colonne non accordee a authenticated)',
  $stmt$update public.clubs set slug = 'pirate-slug' where id = 'aaaaaaaa-0000-0000-0000-000000000000'$stmt$
);

-- Les colonnes accordees (branding + fuseau horaire) restent, elles,
-- modifiables par le club_admin de son propre club.
update public.clubs set name = 'Club A renomme par user A' where id = 'aaaaaaaa-0000-0000-0000-000000000000';
select pg_temp.assert_count('user A - UPDATE clubs.name (colonne accordee) reussit', 1, (select count(*) from public.clubs where id = 'aaaaaaaa-0000-0000-0000-000000000000' and name = 'Club A renomme par user A'));

-- Correctif audit de securite (deploiement reel, 20260922090000) : RLS a
-- ete activee tardivement sur club_memberships/membership_roles (policies
-- deja presentes mais RLS jamais activee dans l'historique de migration
-- original). Verifie ici en direct (SELECT sous authenticated), jamais
-- seulement via has_club_role()/is_club_member() (SECURITY DEFINER, qui
-- contournerait la RLS de ces tables par construction et ne l'aurait
-- jamais detectee).
select pg_temp.assert_count('user A - club_memberships : voit les 2 lignes de SON club (club_admin), aucune du club B', 2, (select count(*) from public.club_memberships));
select pg_temp.assert_count('user A - club_memberships club B invisibles', 0, (select count(*) from public.club_memberships where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user A - membership_roles : voit les 2 roles de SON club, aucun du club B', 2, (select count(*) from public.membership_roles));

-- try_acquire_sync_lock/release_sync_lock (meme correctif) : SECURITY
-- DEFINER mais reserve service_role desormais, meme principe que
-- claim_next_fbi_job (20260921110040). Sans ce verrou, n'importe quel
-- authenticated pouvait verrouiller/deverrouiller la sync d'un AUTRE club.
do $$
begin
  perform public.try_acquire_sync_lock('bbbbbbbb-0000-0000-0000-000000000000', 'ffbb');
  raise exception 'ECHEC [user A - try_acquire_sync_lock refuse] : aurait du etre refuse (permission denied)';
exception
  when insufficient_privilege then
    raise notice 'OK [user A - try_acquire_sync_lock refuse] (permission refusee comme attendu)';
end;
$$;

do $$
begin
  perform public.release_sync_lock('bbbbbbbb-0000-0000-0000-000000000000', 'ffbb');
  raise exception 'ECHEC [user A - release_sync_lock refuse] : aurait du etre refuse (permission denied)';
exception
  when insufficient_privilege then
    raise notice 'OK [user A - release_sync_lock refuse] (permission refusee comme attendu)';
end;
$$;

-- Tentative de lecture DIRECTE par UUID connu du match B (meme en connaissant l'ID)
select pg_temp.assert_count('user A - lecture directe match B par UUID refusee', 0, (select count(*) from public.matches where id = 'bbbbbbbb-0000-0000-0000-000000000006'));

-- Tentative d'ECRITURE sur le club B (UPDATE ne doit affecter aucune ligne)
update public.matches set score_home = 999 where club_id = 'bbbbbbbb-0000-0000-0000-000000000000';
select pg_temp.assert_count('user A - UPDATE sur match B affecte 0 ligne', 0, (select count(*) from public.matches where club_id = 'bbbbbbbb-0000-0000-0000-000000000000' and score_home = 999));

reset role;
-- (repasser en superuser pour verifier la verite terrain sans RLS)
select pg_temp.assert_count('verite terrain - match B intact malgre la tentative user A', 0, (select count(*) from public.matches where club_id = 'bbbbbbbb-0000-0000-0000-000000000000' and score_home = 999));

-- =============================================================
-- Scenario 2 : User B (membre UNIQUEMENT du Club B) ne voit QUE le Club B
-- =============================================================
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';

select pg_temp.assert_count('user B - matches visibles', 1, (select count(*) from public.matches));
select pg_temp.assert_count('user B - matches: bien celui du club B', 1, (select count(*) from public.matches where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - matches club A invisibles', 0, (select count(*) from public.matches where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - licencies club A invisibles', 0, (select count(*) from public.licencies where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - sync_runs club A invisibles', 0, (select count(*) from public.sync_runs where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - fbi_jobs club A invisibles (jamais la session/le cookie d''un autre club)', 0, (select count(*) from public.fbi_jobs where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - match_documents club A invisibles', 0, (select count(*) from public.match_documents where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
select pg_temp.assert_count('user B - match_documents: bien celui du club B', 1, (select count(*) from public.match_documents where club_id = 'bbbbbbbb-0000-0000-0000-000000000000'));

-- claim_next_fbi_job est SECURITY DEFINER : elle voit TOUTES les lignes
-- fbi_jobs, tous clubs confondus (necessaire pour le worker), donc si un
-- authenticated pouvait l'appeler il pourrait reclamer et LIRE le job d'un
-- club dont il n'est meme pas membre — un contournement total de la RLS.
-- Seul EXECUTE reserve a service_role empeche ca (§49 du brief FBI).
select pg_temp.assert_claim_next_fbi_job_denied('user B - claim_next_fbi_job refusee (jamais un role authenticated)');

reset role;

-- =============================================================
-- Scenario 3 : User AB (membre des DEUX clubs, coach en A, joueur en B)
-- =============================================================
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000001';

select pg_temp.assert_count('user AB - voit les matchs des DEUX clubs', 2, (select count(*) from public.matches));
select pg_temp.assert_count('user AB - est bien membre de A et B', 2, (select count(*) from public.club_memberships where user_id = 'cccccccc-0000-0000-0000-000000000001'));

-- User AB n'est PAS club_admin (coach/joueur seulement) => ne doit PAS pouvoir
-- ecrire sur les tables reservees aux club_admin (ex: teams).
update public.teams set name = 'Hack' where club_id = 'aaaaaaaa-0000-0000-0000-000000000000';
select pg_temp.assert_count('user AB (coach, pas admin) - UPDATE teams club A refuse', 0, (select count(*) from public.teams where club_id = 'aaaaaaaa-0000-0000-0000-000000000000' and name = 'Hack'));

reset role;

-- =============================================================
-- Scenario 4 : platform_admin voit tout, cross-club
-- =============================================================
insert into public.platform_admins (user_id) values ('cccccccc-0000-0000-0000-000000000001');

set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000001';

select pg_temp.assert_count('platform_admin - voit tous les matchs (2 clubs)', 2, (select count(*) from public.matches));
select pg_temp.assert_count('platform_admin - voit tous les sync_runs (2 clubs)', 2, (select count(*) from public.sync_runs));

reset role;
delete from public.platform_admins where user_id = 'cccccccc-0000-0000-0000-000000000001';

-- =============================================================
-- Scenario 5 : meme identifiant externe dans 2 clubs (coexistence, pas collision)
-- =============================================================
select pg_temp.assert_count('coexistence - 2 licencies avec le meme numero, clubs differents', 2, (select count(*) from public.licencies where license_number = 'AAA123456'));
select pg_temp.assert_count('coexistence - 2 matches avec le meme ffbb_match_id, clubs differents', 2, (select count(*) from public.matches where ffbb_match_id = 'ffbb-shared-123'));

-- =============================================================
-- Scenario 6 : sans authentification (anon), rien n'est visible
-- =============================================================
set role anon;
select pg_temp.assert_count('anon - aucun match visible', 0, (select count(*) from public.matches));
-- anon n'a plus aucun droit de lecture sur licencies (migration 20261102181000) :
-- exiger un refus de droit (42501), pas un simple comptage à 0.
do $$
begin
  perform count(*) from public.licencies;
  raise exception 'ECHEC [anon - licencies : permission denied attendu, la lecture a reussi]';
exception
  when insufficient_privilege then
    raise notice 'OK [anon - licencies refuse (42501)]';
end;
$$;
select pg_temp.assert_claim_next_fbi_job_denied('anon - claim_next_fbi_job refusee');
reset role;

-- =============================================================
-- Scenario 7 : le worker (service_role) reclame un job cross-club sans
-- jamais melanger les deux (§13/§56 du brief FBI) — sanity check que le
-- correctif de securite du Scenario 2 ne casse pas l'usage LEGITIME.
-- =============================================================
set role service_role;

select pg_temp.assert_count('service_role - voit les fbi_jobs des 2 clubs (bypassrls)', 2, (select count(*) from public.fbi_jobs));

-- Reclame un premier job : doit etre l'un des deux clubs, jamais les deux
-- a la fois (FOR UPDATE SKIP LOCKED, un seul at a time ici). `count(id)`,
-- pas `count(*)` : une fonction "RETURNS public.fbi_jobs" (pas SETOF) qui
-- renvoie NULL produit tout de meme UNE ligne (toutes colonnes NULL) dans
-- un contexte FROM — seul `count(id)` distingue "aucun job" de "1 job".
select pg_temp.assert_count('service_role - claim_next_fbi_job reclame exactement 1 job', 1, (select count(id) from public.claim_next_fbi_job('worker-test#0')));

-- Le job reclame est maintenant 'claimed' : le reclamer une SECONDE fois ne
-- doit RIEN renvoyer pour CE job (exclu par le WHERE status='pending'), et
-- l'autre club doit encore etre reclamable (aucun blocage cross-club).
select pg_temp.assert_count('service_role - 1 seul job encore pending apres 1 claim', 1, (select count(*) from public.fbi_jobs where status = 'pending'));
select pg_temp.assert_count('service_role - claim_next_fbi_job reclame le job de L''AUTRE club ensuite', 1, (select count(id) from public.claim_next_fbi_job('worker-test#1')));
select pg_temp.assert_count('service_role - plus aucun job pending (les 2 clubs traites, aucun melange)', 0, (select count(*) from public.fbi_jobs where status = 'pending'));

reset role;

-- =============================================================
-- Scenario 8 : Tables de marque (table_assignments) — isolation multi-
-- tenant + role responsable_tables (jamais exploite avant ce module).
-- =============================================================

create or replace function pg_temp.assert_unique_violation(label text, stmt text) returns void
language plpgsql as $$
begin
  execute stmt;
  raise exception 'ECHEC [%] : la contrainte UNIQUE aurait du refuser cet INSERT', label;
exception
  when unique_violation then
    raise notice 'OK [%] (unique_violation comme attendu)', label;
end;
$$;

-- Un second membre du Club A, avec UNIQUEMENT le role 'responsable_tables'
-- (jamais club_admin) — verifie que ce role seul suffit (§31 de la
-- demande : "s'il existe deja un role adapte... utilise-le").
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000010', 'table-manager-a@example.com');
insert into public.club_memberships (id, club_id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000010');
insert into public.membership_roles (membership_id, role) values ('aaaaaaaa-0000-0000-0000-000000000011', 'responsable_tables');

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000010';

insert into public.table_assignments (club_id, match_id, licencie_id, role, created_by)
values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000005', 'SCORER', 'aaaaaaaa-0000-0000-0000-000000000010');

select pg_temp.assert_count('responsable_tables Club A - peut creer et lire une affectation', 1, (select count(*) from public.table_assignments where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));

-- UNIQUE(club_id, match_id, role) : un 2e SCORER sur le meme match refuse
-- (§28 de la demande : un seul licencie par poste).
select pg_temp.assert_unique_violation(
  'UNIQUE(club_id, match_id, role) - un 2e SCORER sur le meme match refuse',
  $stmt$insert into public.table_assignments (club_id, match_id, licencie_id, role, created_by) values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000005', 'SCORER', 'aaaaaaaa-0000-0000-0000-000000000010')$stmt$
);

-- UNIQUE(club_id, match_id, licencie_id) : le MEME licencie ne peut pas
-- cumuler un 2e role sur le MEME match (§11/§28 de la demande).
select pg_temp.assert_unique_violation(
  'UNIQUE(club_id, match_id, licencie_id) - meme licencie, 2e role sur le meme match refuse',
  $stmt$insert into public.table_assignments (club_id, match_id, licencie_id, role, created_by) values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000005', 'TIMEKEEPER', 'aaaaaaaa-0000-0000-0000-000000000010')$stmt$
);

reset role;

-- Club B (club_admin DE B) ne voit JAMAIS l'affectation du Club A, meme en
-- connaissant l'UUID exact du club A.
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';
select pg_temp.assert_count('user B (club_admin de B) - affectations Club A invisibles', 0, (select count(*) from public.table_assignments where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
reset role;

-- Un membre du Club A SANS role club_admin/responsable_tables (ici coach,
-- meme utilisateur cccccccc que Scenario 3) ne peut RIEN lire dans
-- table_assignments pour ce club — role generique de membre insuffisant,
-- contrairement a `matches`/`teams` qui sont lisibles par tout membre.
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000001';
select pg_temp.assert_count('user AB (coach sur A, pas club_admin/responsable_tables) - aucune affectation Club A visible', 0, (select count(*) from public.table_assignments where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
reset role;

-- Nettoyage : le reste de la suite (rejouable) ne doit pas dependre de ces
-- inserts locaux au Scenario 8.
delete from public.table_assignments;
delete from public.membership_roles where membership_id = 'aaaaaaaa-0000-0000-0000-000000000011';
delete from public.club_memberships where id = 'aaaaaaaa-0000-0000-0000-000000000011';
delete from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000010';

-- =============================================================
-- Scenario 9 : accès public sans compte (licencie_public_tokens) — retour
-- du club, 2026-09-29 : "je vais envoyer le lien à tout le monde... si le
-- token est tjr actif, sinon faut faire une demande admin". Cette table
-- gère UNIQUEMENT la gestion admin des jetons (club_admin) ; le flux
-- public lui-même passe par le rôle service côté API, jamais par cette
-- RLS (voir modules/public-tables/routes.ts) — ce scénario vérifie donc
-- que la RLS reste bien réservée à club_admin, plus stricte que
-- table_assignments (jamais responsable_tables ici : gestion d'identité).
-- =============================================================

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';

insert into public.licencie_public_tokens (club_id, licencie_id, token_hash, email)
values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000005', 'fake-hash-thomas', 'thomas@example.test');

select pg_temp.assert_count('club_admin A - peut creer et lire un jeton public', 1, (select count(*) from public.licencie_public_tokens where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));

-- UNIQUE PARTIEL (club_id, licencie_id) WHERE revoked_at IS NULL : un 2e
-- jeton ACTIF pour le MEME licencie refuse (§"une fois qu'un nom est
-- choisi, il peut plus être choisi").
select pg_temp.assert_unique_violation(
  'UNIQUE PARTIEL (club_id, licencie_id) actifs - 2e jeton actif pour le meme licencie refuse',
  $stmt$insert into public.licencie_public_tokens (club_id, licencie_id, token_hash) values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000005', 'fake-hash-autre')$stmt$
);

reset role;

-- club_admin de B ne voit jamais les jetons du Club A, meme UUID connu.
set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';
select pg_temp.assert_count('club_admin B - jetons publics Club A invisibles', 0, (select count(*) from public.licencie_public_tokens where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
reset role;

-- Un simple membre (coach sur A, pas club_admin) ne voit RIEN : cette RLS
-- est plus stricte que table_assignments (jamais responsable_tables non
-- plus — gestion d'identité, pas de postes).
set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000001';
select pg_temp.assert_count('user AB (coach sur A, pas club_admin) - aucun jeton public Club A visible', 0, (select count(*) from public.licencie_public_tokens where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
reset role;

delete from public.licencie_public_tokens where club_id = 'aaaaaaaa-0000-0000-0000-000000000000';

-- =============================================================
-- Scenario 10 : demandes de derogation INTERNES (coach -> coordinateur)
-- RLS de lecture : coordinateur (correspondant_club) / club_admin du club,
-- auteur, coach de l'equipe (portee club ou equipe). Aucune ecriture
-- directe pour authenticated (tout passe par l'API, role service).
-- =============================================================
insert into auth.users (id, email) values
  ('dddddddd-0000-0000-0000-000000000001', 'coach-autre-equipe@example.com'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'coordinateur@example.com');
insert into public.teams (id, club_id, name) values ('aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000000', 'Equipe A2');
insert into public.club_memberships (id, club_id, user_id) values
  ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000000', 'dddddddd-0000-0000-0000-000000000001'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000000', 'eeeeeeee-0000-0000-0000-000000000001');
insert into public.membership_roles (membership_id, role, scope_team_id) values
  ('dddddddd-0000-0000-0000-000000000002', 'coach', 'aaaaaaaa-0000-0000-0000-0000000000a2'),
  ('eeeeeeee-0000-0000-0000-000000000002', 'correspondant_club', null);
insert into public.club_venues (id, club_id, name) values ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000000', 'Gymnase A');
insert into public.derogation_requests (id, club_id, match_id, team_id, created_by_user_id, requester_display_name, requested_start_at, requested_club_venue_id)
values ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000001', 'Coach AB', '2026-10-11 13:00+00', 'aaaaaaaa-0000-0000-0000-0000000000f1');
insert into public.derogation_messages (club_id, request_id, author_user_id, author_display_name, body, message_type)
values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'cccccccc-0000-0000-0000-000000000001', 'Coach AB', 'Demande', 'USER');
insert into public.derogation_proposals (club_id, request_id, proposed_by_user_id, proposed_by_display_name, requested_start_at)
values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'cccccccc-0000-0000-0000-000000000001', 'Coach AB', '2026-10-11 13:00+00');

set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.assert_count('DR club_admin A - voit la demande', 1, (select count(*) from public.derogation_requests));
select pg_temp.assert_count('DR club_admin A - voit le message', 1, (select count(*) from public.derogation_messages));
reset role;

set role authenticated;
set request.jwt.claim.sub = 'cccccccc-0000-0000-0000-000000000001';
select pg_temp.assert_count('DR auteur (coach A) - voit sa demande + proposition', 2, (select count(*) from public.derogation_requests) + (select count(*) from public.derogation_proposals));
reset role;

set role authenticated;
set request.jwt.claim.sub = 'eeeeeeee-0000-0000-0000-000000000001';
select pg_temp.assert_count('DR coordinateur A - voit la demande', 1, (select count(*) from public.derogation_requests));
reset role;

set role authenticated;
set request.jwt.claim.sub = 'dddddddd-0000-0000-0000-000000000001';
select pg_temp.assert_count('DR coach d''une AUTRE equipe - ne voit rien', 0, (select count(*) from public.derogation_requests) + (select count(*) from public.derogation_messages));
reset role;

set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-0000-0000-0000-000000000001';
select pg_temp.assert_count('DR club_admin B - rien du Club A meme UUID connu', 0, (select count(*) from public.derogation_requests where id = 'aaaaaaaa-0000-0000-0000-0000000000d1') + (select count(*) from public.derogation_messages) + (select count(*) from public.club_venues where club_id = 'aaaaaaaa-0000-0000-0000-000000000000'));
reset role;

-- Aucune ecriture directe (historique immuable, ecritures via l'API uniquement).
set role authenticated;
set request.jwt.claim.sub = 'aaaaaaaa-0000-0000-0000-000000000001';
do $$
begin
  begin
    insert into public.derogation_messages (club_id, request_id, author_display_name, body, message_type) values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'x', 'x', 'USER');
    raise exception 'ECHEC [DR insert direct message] : aurait du etre refuse';
  exception when insufficient_privilege then raise notice 'OK [DR insert direct message refuse]';
  end;
  begin
    update public.derogation_requests set status = 'COMPLETED';
    raise exception 'ECHEC [DR update direct] : aurait du etre refuse';
  exception when insufficient_privilege then raise notice 'OK [DR update direct refuse]';
  end;
end $$;
reset role;

-- Une seule demande ACTIVE par match (index unique partiel), meme club garanti par trigger.
do $$
begin
  begin
    insert into public.derogation_requests (club_id, match_id, created_by_user_id, requester_display_name, requested_start_at)
    values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'cccccccc-0000-0000-0000-000000000001', 'Coach AB', '2026-10-12 13:00+00');
    raise exception 'ECHEC [DR deuxieme demande active] : aurait du etre refusee';
  exception when unique_violation then raise notice 'OK [DR une seule demande active par match]';
  end;
  begin
    insert into public.derogation_requests (club_id, match_id, created_by_user_id, requester_display_name, requested_start_at)
    values ('aaaaaaaa-0000-0000-0000-000000000000', 'bbbbbbbb-0000-0000-0000-000000000006', 'cccccccc-0000-0000-0000-000000000001', 'Coach AB', '2026-10-12 13:00+00');
    raise exception 'ECHEC [DR match d''un autre club] : aurait du etre refuse';
  exception when raise_exception then
    if sqlerrm like 'ECHEC%' then raise; end if;
    raise notice 'OK [DR match d''un autre club refuse par trigger]';
  end;
end $$;
update public.derogation_requests set status = 'COMPLETED' where id = 'aaaaaaaa-0000-0000-0000-0000000000d1';
insert into public.derogation_requests (club_id, match_id, created_by_user_id, requester_display_name, requested_start_at)
values ('aaaaaaaa-0000-0000-0000-000000000000', 'aaaaaaaa-0000-0000-0000-000000000006', 'cccccccc-0000-0000-0000-000000000001', 'Coach AB', '2026-10-12 13:00+00');
select pg_temp.assert_count('DR apres COMPLETED, nouvelle demande possible', 2, (select count(*) from public.derogation_requests));

do $$ begin raise notice '=== TOUS LES TESTS D''ISOLATION SONT PASSES ==='; end $$;
