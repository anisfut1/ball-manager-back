-- Rattachement direct (décision du club pilote) : plus de validation préalable.
-- Les demandes encore en attente deviennent actives ; le club peut ensuite
-- retirer un rattachement ou un compte (docs/ACCOUNTS.md).
update public.account_licencie_links
set status = 'active', decided_at = now()
where status = 'pending';
