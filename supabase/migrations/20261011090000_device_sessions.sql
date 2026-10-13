-- Application iOS (et, plus tard, web) : session d'APPAREIL dérivée du lien
-- personnel. Voir docs/MOBILE_AUTH.md.
--
-- Pas un nouveau système d'identité : l'identité reste le licencié du lien
-- personnel (licencie_public_tokens). Une session d'appareil est une preuve
-- DÉRIVÉE, révocable, qui évite de garder le jeton permanent sur le
-- téléphone. Chaque droit est adossé au jeton personnel qui l'a prouvé :
-- un lien réinitialisé par un admin coupe aussi l'accès de l'app.
--
-- Accès uniquement par l'API (rôle service) : RLS activée, aucune policy.

create table public.device_sessions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  -- SHA-256 du secret (jamais le secret en clair).
  secret_hash text not null unique,
  platform text not null check (platform in ('ios', 'web')),
  app_version text,
  device_label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  -- Glissant : repoussé à l'usage (voir DEVICE_SESSION_TTL côté API).
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index device_sessions_club on public.device_sessions (club_id);
alter table public.device_sessions enable row level security;

create table public.device_session_grants (
  session_id uuid not null references public.device_sessions (id) on delete cascade,
  club_id uuid not null references public.clubs (id) on delete cascade,
  licencie_id uuid not null references public.licencies (id) on delete cascade,
  -- Lien personnel qui a prouvé l'identité : révoqué => droit perdu.
  token_id uuid not null references public.licencie_public_tokens (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, licencie_id)
);
create index device_session_grants_licencie on public.device_session_grants (club_id, licencie_id);
create index device_session_grants_token on public.device_session_grants (token_id);
alter table public.device_session_grants enable row level security;

-- Codes d'autorisation : courts, à usage unique, hachés.
--  - app_sso    : connexion depuis Safari (ASWebAuthenticationSession), PKCE S256 obligatoire ;
--  - login_link : lien de connexion envoyé par email (si AUTH_LINK_CODES=1).
create table public.auth_codes (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  code_hash text not null unique,
  purpose text not null check (purpose in ('app_sso', 'login_link')),
  token_ids uuid[] not null,
  code_challenge text,
  redirect_path text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index auth_codes_expires on public.auth_codes (expires_at);
alter table public.auth_codes enable row level security;
