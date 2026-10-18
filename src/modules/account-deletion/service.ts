import type { DbClient } from "../../db/client.js";
import { logError } from "../../logger.js";
import { removeStoredLicenciePhoto, storedPhotoPath } from "../../storage/licencie-photos.js";

/**
 * Suppression de l'ACCÈS d'un licencié (guideline Apple 5.1.1(v), RGPD) : jetons
 * de lien, droits et sessions d'appareil, jetons push, contact, drapeaux
 * d'accès, photo et demandes de lien. La fiche sportive (nom, licence, équipe,
 * historiques) reste au club. Voir docs/MOBILE_AUTH.md.
 *
 * Les écritures en base sont UNE transaction (fonction SQL
 * `delete_licencie_access`, rôle service) ; les fichiers photo ne sont
 * supprimés qu'ensuite : un échec du stockage est journalisé, jamais remonté.
 */
export async function deleteLicencieAccess(db: DbClient, clubId: string, licencieIds: readonly string[]): Promise<void> {
  const ids = [...new Set(licencieIds)];
  if (ids.length === 0) return;

  const { data, error } = await db.rpc("delete_licencie_access", { p_club_id: clubId, p_licencie_ids: ids });
  if (error) throw new Error(`Suppression de l'accès du licencié échouée : ${error.message}`);

  for (const photoUrl of data ?? []) {
    await removeStoredLicenciePhoto(db, photoUrl, clubId).catch((storageError: unknown) =>
      logError("Photo de licencié non supprimée du stockage", storageError, { clubId, path: storedPhotoPath(photoUrl, clubId) }),
    );
  }
}
