-- Lien personnel de « Camille DEMO » (club de démo de la revue App Store).
-- À exécuter APRÈS demo_review_club.sql, dans le SQL Editor de Supabase.
-- Le jeton est généré ICI, en base : seul son hash est stocké (comme les
-- vrais liens) ; le lien complet n'apparaît que dans le résultat de cette
-- requête. Il va UNIQUEMENT dans les notes de revue App Store Connect —
-- ne jamais le commiter. Ré-exécuter = nouveau lien, l'ancien est révoqué
-- (un seul lien actif par licencié).

update public.licencie_public_tokens set revoked_at = now()
where club_id = 'd0000000-0000-4000-8000-000000000001' and licencie_id = 'd0000000-0000-4000-8000-000000000201' and revoked_at is null;

with token as (
  select translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_') as raw
), inserted as (
  insert into public.licencie_public_tokens (club_id, licencie_id, token_hash)
  select 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000201',
         encode(extensions.digest(token.raw, 'sha256'), 'hex')
  from token
  returning id
)
select 'https://www.ball-manager.fr/public/club-demo/accueil?token=' || token.raw as lien_demo_apple
from token, inserted;
