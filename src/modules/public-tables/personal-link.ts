import type { DbClient } from "../../db/client.js";
import { decryptSecret, encryptSecret, type EncryptedPayload } from "../../security/crypto.js";
import { generatePublicToken, hashPublicToken } from "./token.js";
import { links, type PersonalLinkTarget } from "../../links/links.js";

/**
 * Lien personnel (espace public sans compte). Le jeton est HACHÉ pour
 * l'authentification et CHIFFRÉ pour qu'un club_admin puisse réafficher le
 * lien existant (retour du club, 2026-10-01 : « l'admin doit avoir accès au
 * lien unique par joueur au cas où il a besoin de l'envoyer »).
 */
const aad = (clubId: string, licencieId: string) => `licencie-public-token:${clubId}:${licencieId}`;

export function encryptPublicToken(token: string, clubId: string, licencieId: string): EncryptedPayload {
  return encryptSecret(token, aad(clubId, licencieId));
}

export function decryptPublicToken(payload: EncryptedPayload, clubId: string, licencieId: string): string {
  return decryptSecret(payload, aad(clubId, licencieId));
}

export function personalLinkUrl(baseUrl: string, clubSlug: string, target: PersonalLinkTarget, token: string): string {
  return links(baseUrl).personalLink(clubSlug, target, token);
}

/**
 * Lien du licencié pour un club_admin : réaffiche le jeton ACTIF s'il est
 * déchiffrable (le lien déjà utilisé reste valable) ; sinon (aucun lien, ou
 * lien émis avant le chiffrement) émet un nouveau jeton — l'éventuel ancien
 * est alors révoqué (seul cas où le lien change).
 */
export async function revealOrIssueToken(db: DbClient, params: { clubId: string; licencieId: string; email: string | null; adminUserId: string }): Promise<{ token: string; created: boolean }> {
  const { data: active } = await db.from("licencie_public_tokens").select("id, token_ciphertext").eq("club_id", params.clubId).eq("licencie_id", params.licencieId).is("revoked_at", null).maybeSingle();
  if (active?.token_ciphertext) {
    try {
      return { token: decryptPublicToken(active.token_ciphertext as EncryptedPayload, params.clubId, params.licencieId), created: false };
    } catch {
      // Clé changée / donnée altérée : on retombe sur une nouvelle émission.
    }
  }
  if (active) await db.from("licencie_public_tokens").update({ revoked_at: new Date().toISOString(), revoked_by: params.adminUserId }).eq("id", active.id).is("revoked_at", null);

  const token = generatePublicToken();
  const { error } = await db.from("licencie_public_tokens").insert({
    club_id: params.clubId,
    licencie_id: params.licencieId,
    token_hash: hashPublicToken(token),
    token_ciphertext: encryptPublicToken(token, params.clubId, params.licencieId),
    email: params.email,
  });
  if (error) throw new Error(`Création du lien personnel échouée : ${error.message}`);
  return { token, created: true };
}
