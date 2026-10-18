-- Suppression de l'ACCÈS d'un licencié (guideline Apple 5.1.1(v), RGPD) :
-- l'identité d'accès disparaît, la fiche sportive (nom, numéro de licence,
-- équipe, historiques) reste au club.
--
-- Une seule fonction = une seule transaction : tout est supprimé ou rien.
-- Appelée par club-manager-api (rôle service) via RPC ; voir
-- src/modules/account-deletion/.
--
-- Chaque opération filtre sur club_id ET licencie_id : un identifiant d'un
-- autre club ne touche rien.
--
-- Sessions d'appareil : on retire les droits (grants) des licenciés ciblés
-- dans TOUTES les sessions ; une session n'est supprimée (avec son jeton
-- push, en cascade) que lorsqu'elle n'a plus aucun droit. Une session
-- partagée avec un autre enfant garde donc cet autre enfant.
--
-- Renvoie les anciennes `photo_url` : l'API en tire le chemin du bucket
-- (storedPhotoPath) et supprime les fichiers APRÈS la transaction.

create or replace function public.delete_licencie_access(p_club_id uuid, p_licencie_ids uuid[])
returns text[]
language plpgsql
set search_path = public
as $$
declare
  v_ids uuid[] := coalesce(p_licencie_ids, '{}');
  v_token_ids uuid[];
  v_session_ids uuid[];
  v_photos text[];
begin
  if cardinality(v_ids) = 0 then
    return '{}';
  end if;

  select coalesce(array_agg(id), '{}') into v_token_ids
    from public.licencie_public_tokens
   where club_id = p_club_id and licencie_id = any (v_ids);

  -- Sessions qui donnent accès à ces licenciés (par droit direct ou par jeton).
  select coalesce(array_agg(distinct session_id), '{}') into v_session_ids
    from public.device_session_grants
   where club_id = p_club_id and (licencie_id = any (v_ids) or token_id = any (v_token_ids));

  delete from public.device_session_grants
   where club_id = p_club_id and (licencie_id = any (v_ids) or token_id = any (v_token_ids));

  -- Sessions sans plus aucun droit : supprimées (device_push_tokens en cascade).
  delete from public.device_sessions s
   where s.club_id = p_club_id
     and s.id = any (v_session_ids)
     and not exists (select 1 from public.device_session_grants g where g.session_id = s.id);

  delete from public.licencie_public_tokens
   where club_id = p_club_id and licencie_id = any (v_ids);

  delete from public.licencie_claim_requests
   where club_id = p_club_id and licencie_id = any (v_ids);

  select coalesce(array_agg(photo_url) filter (where photo_url is not null), '{}') into v_photos
    from public.licencies
   where club_id = p_club_id and id = any (v_ids);

  update public.licencies
     set email = null,
         phone = null,
         photo_url = null,
         public_admin = false,
         public_coach = false,
         public_coordinator = false,
         updated_at = now()
   where club_id = p_club_id and id = any (v_ids);

  return v_photos;
end;
$$;

comment on function public.delete_licencie_access(uuid, uuid[]) is
  'Supprime l''accès d''un ou plusieurs licenciés (jetons, droits de session, contact, photo, demandes de lien) en une transaction ; la fiche sportive est conservée. Renvoie les anciennes photo_url. Rôle service uniquement.';

revoke execute on function public.delete_licencie_access(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.delete_licencie_access(uuid, uuid[]) to service_role;
