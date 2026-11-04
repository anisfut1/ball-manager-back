import type { DbClient } from "../../db/client.js";
import { unauthorized } from "../../api-error.js";
import { hashPublicToken, isPersonalLinkExpired, PERSONAL_LINK_EXPIRED_CODE } from "../public-tables/token.js";

/**
 * Résout l'identité depuis `?token=` — la SEULE preuve d'identité de ce
 * flux (retour du club : "si le token est tjr actif"). 401 si absent,
 * inconnu, ou révoqué par un admin — jamais une distinction plus fine
 * (§"sinon faut faire une demande admin", jamais un message qui aiderait à
 * deviner un jeton valide). Seul un jeton CONNU mais échu (7 jours) renvoie
 * `PERSONAL_LINK_EXPIRED`, pour que le web et l'app proposent d'en redemander un.
 */
export async function licencieFromToken(supabase: DbClient, clubId: string, token: string): Promise<{ id: string; first_name: string; last_name: string; team_id: string | null }> {
  const tokenHash = hashPublicToken(token);
  const { data: claim } = await supabase.from("licencie_public_tokens").select("licencie_id, expires_at").eq("club_id", clubId).eq("token_hash", tokenHash).is("revoked_at", null).maybeSingle();
  if (!claim) throw unauthorized("Lien personnel invalide ou révoqué — demande à un·e responsable du club de réinitialiser ton profil.");

  if (isPersonalLinkExpired(claim.expires_at)) throw unauthorized("Lien personnel expiré — demande-en un nouveau.", PERSONAL_LINK_EXPIRED_CODE);

  const { data: licencie } = await supabase.from("licencies").select("id, first_name, last_name, team_id").eq("id", claim.licencie_id).eq("club_id", clubId).maybeSingle();
  if (!licencie) throw unauthorized("Lien personnel invalide.");
  return licencie;
}

