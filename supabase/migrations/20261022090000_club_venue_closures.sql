-- Indisponibilités des gymnases du club (demande du club, 2026-10-22 :
-- « ajouter les créneaux, par journée ou demi-journée, où les gymnases sont
-- indisponibles, afin de voir les conflits sur match ou entraînement »).
-- Une ligne = une période de jours (du/au inclus), journée entière, matin
-- (avant 13 h) ou après-midi (à partir de 13 h), heure du club.
--
-- Accès uniquement par l'API (rôle service) : RLS activée, aucune policy.

create table public.club_venue_closures (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  club_venue_id uuid not null references public.club_venues (id) on delete cascade,
  start_date date not null,
  end_date date not null,
  period text not null default 'day' check (period in ('day', 'morning', 'afternoon')),
  reason text check (reason is null or char_length(reason) <= 200),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date <= 366)
);
create index club_venue_closures_club_dates on public.club_venue_closures (club_id, end_date);
alter table public.club_venue_closures enable row level security;
