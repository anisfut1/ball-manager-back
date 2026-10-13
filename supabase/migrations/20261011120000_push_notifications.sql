-- Notifications push de l'app iOS (APNs direct, sans service tiers).
-- Voir SCSB/docs/IOS_PUSH.md.
--
-- Un jeton APNs est rattaché à UNE session d'appareil (donc à un club et aux
-- personnes de cette session) : déconnexion, lien réinitialisé ou session
-- expirée => plus aucune notification, sans autre nettoyage.
--
-- Accès uniquement par l'API (rôle service) : RLS activée, aucune policy.

create table public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.device_sessions (id) on delete cascade,
  club_id uuid not null references public.clubs (id) on delete cascade,
  token text not null,
  platform text not null default 'ios' check (platform in ('ios')),
  -- Jeton d'une build Xcode (development) ou TestFlight / App Store (production).
  environment text not null check (environment in ('development', 'production')),
  app_version text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  -- Ex. « Unregistered » renvoyé par APNs (app supprimée) : jamais réutilisé.
  revoked_reason text
);
create index device_push_tokens_club on public.device_push_tokens (club_id) where revoked_at is null;
create index device_push_tokens_token on public.device_push_tokens (token);
alter table public.device_push_tokens enable row level security;

-- File d'envoi : écrite dans la même requête que l'action (convocation,
-- annulation…), envoyée par /internal/cron/push. Idempotente (dedupe_key).
-- Les destinataires sont des licenciés ; les appareils sont résolus à l'envoi.
create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs (id) on delete cascade,
  kind text not null,
  dedupe_key text not null unique,
  licencie_ids uuid[] not null,
  title text not null,
  body text not null,
  -- Chemin relatif /public/{slug}/… : même routeur que les Universal Links.
  path text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'expired')),
  attempts integer not null default 0,
  last_error text,
  devices_sent integer not null default 0,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notification_outbox_due on public.notification_outbox (next_attempt_at) where status = 'pending';
alter table public.notification_outbox enable row level security;
