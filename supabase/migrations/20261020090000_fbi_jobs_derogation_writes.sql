-- Écritures FBI (dérogation officielle, réponse à une dérogation) confiées au
-- worker du poste du club quand il tient la session FBI (bail
-- `fbi_paused_until`) — 2026-10-20 : depuis Vercel, FBI coupe l'accès.
-- `payload` porte les champs du formulaire ; une écriture n'est JAMAIS
-- rejouée automatiquement (`max_attempts = 1` à l'insertion).
alter table public.fbi_jobs add column if not exists payload jsonb;

alter table public.fbi_jobs drop constraint fbi_jobs_type_check;
alter table public.fbi_jobs add constraint fbi_jobs_type_check
  check (type in ('test_connection', 'discover_emarque', 'reconcile_schedule', 'check_derogation', 'check_all_derogations', 'import_licences', 'create_derogation', 'respond_derogation'));

comment on column public.fbi_jobs.payload is
  'Données d''une écriture FBI (create_derogation / respond_derogation), jamais d''identifiant ni de mot de passe.';
