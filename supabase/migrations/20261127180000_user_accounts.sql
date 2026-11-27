-- Comptes utilisateurs (email + mot de passe) pour l'espace licencié, web et
-- app iOS. Voir docs/ACCOUNTS.md.
--
-- Un compte (auth.users) peut suivre plusieurs licenciés (parent de deux
-- enfants), et un licencié peut être suivi par plusieurs comptes (le père, la
-- mère, l'enfant). Tous les comptes liés ont les mêmes droits sur la fiche ;
-- les droits staff (coach, admin…) restent dans membership_roles.
--
-- Accès uniquement par l'API (rôle service), sauf la lecture de ses propres
-- liens par un compte connecté.

create table public.account_licencie_links (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  -- pending : en attente d'un admin du club ; refused : refusé (le compte peut redemander plus tard).
  status text not null check (status in ('active', 'pending', 'refused')),
  -- Comment le lien a été prouvé : email déjà connu sur la fiche, lien personnel ou session d'appareil, invitation d'un proche, admin.
  source text not null check (source in ('email_match', 'personal_link', 'device_session', 'invite', 'admin', 'request')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  unique (user_id, licencie_id)
);
create index account_licencie_links_licencie on public.account_licencie_links (licencie_id) where status = 'active';
create index account_licencie_links_club_pending on public.account_licencie_links (club_id, created_at) where status = 'pending';
alter table public.account_licencie_links enable row level security;
create policy account_licencie_links_select_own on public.account_licencie_links
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.account_licencie_links from anon;
revoke insert, update, delete, truncate on public.account_licencie_links from authenticated;

-- Invitation d'un proche par un compte déjà lié (lien à partager, usage unique).
-- Seul le hash du code est stocké.
create table public.account_invites (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  invited_by uuid references auth.users (id) on delete set null,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null
);
create index account_invites_licencie on public.account_invites (licencie_id);
alter table public.account_invites enable row level security;
revoke all on public.account_invites from anon, authenticated;

-- Jetons APNs d'un COMPTE sur un iPhone, pour un club. Les destinataires des
-- notifications restent des licenciés : ils sont résolus à l'envoi via les
-- liens actifs (le père et la mère reçoivent tous les deux la convocation).
create table public.account_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  club_id uuid not null references public.clubs (id) on delete cascade,
  token text not null,
  platform text not null default 'ios' check (platform in ('ios')),
  environment text not null check (environment in ('development', 'production')),
  app_version text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text,
  unique (user_id, club_id, token)
);
create index account_push_tokens_user on public.account_push_tokens (user_id, club_id) where revoked_at is null;
create index account_push_tokens_token on public.account_push_tokens (token);
alter table public.account_push_tokens enable row level security;
revoke all on public.account_push_tokens from anon, authenticated;
