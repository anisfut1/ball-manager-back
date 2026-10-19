-- Anomalies écartées à la main par un admin du club (bouton « Retirer » de la
-- page Anomalies). La clé identifie l'anomalie ET son état : si la situation
-- change (match déplacé, autre conflit), la clé change et l'anomalie revient.
--
-- Accès uniquement par l'API (rôle service) : RLS activée, aucune policy.

create table public.issue_dismissals (
  club_id uuid not null references public.clubs (id) on delete cascade,
  issue_key text not null,
  dismissed_by uuid references auth.users (id) on delete set null,
  dismissed_at timestamptz not null default now(),
  primary key (club_id, issue_key)
);
alter table public.issue_dismissals enable row level security;
