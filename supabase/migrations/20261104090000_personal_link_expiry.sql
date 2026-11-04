-- =============================================================================
-- Lot 5b — expiration à 7 jours des liens personnels (audit sécurité 2026-11).
--
-- Un lien personnel est la seule preuve d'identité du flux public : il ne doit
-- plus être valable indéfiniment. Chaque jeton reçoit une échéance ; passé ce
-- délai, le licencié en redemande un (aucun envoi automatique).
--
-- ORDRE DE DÉPLOIEMENT : appliquer cette migration AVANT de déployer le back
-- (le back lit `expires_at`). Les liens déjà diffusés expirent 7 jours après
-- l'application de la migration (défaut now() + 7 jours sur les lignes
-- existantes) : c'est la date butoir pour que le web et l'app affichent
-- « Lien expiré » sur le code d'erreur PERSONAL_LINK_EXPIRED.
-- =============================================================================

alter table public.licencie_public_tokens
  add column if not exists expires_at timestamptz not null default (now() + interval '7 days');

comment on column public.licencie_public_tokens.expires_at is
  'Échéance du lien personnel (7 jours après émission). Au-delà, le back répond 401 PERSONAL_LINK_EXPIRED. Les liens antérieurs à la migration expirent 7 jours après son application.';

-- Le contrôle d'expiration est fait par le back ; l'index sert au nettoyage éventuel des jetons échus.
create index if not exists licencie_public_tokens_expires_at_idx on public.licencie_public_tokens (expires_at) where revoked_at is null;
