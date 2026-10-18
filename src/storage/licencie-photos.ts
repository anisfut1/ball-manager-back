import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/client.js";

/**
 * Photos de fiches joueurs (retour du club, 2026-10-08 : "insérer des
 * photos png/jpeg, compressées au max, stockées"). Bucket PUBLIC en lecture
 * (affichage direct), écrit uniquement par l'API (rôle service). Chemin
 * aléatoire `club/licencié/uuid.ext` : jamais devinable.
 */
export const LICENCIE_PHOTOS_BUCKET = "licencie-photos";

/** Une photo déjà compressée côté navigateur (WebP 512 px ≈ 30-60 Ko) : 512 Ko suffit largement. */
export const MAX_LICENCIE_PHOTO_BYTES = 512 * 1024;

export const LICENCIE_PHOTO_TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" } as const;
export type LicenciePhotoType = keyof typeof LICENCIE_PHOTO_TYPES;

export async function uploadLicenciePhoto(supabase: DbClient, clubId: string, licencieId: string, content: Buffer, contentType: LicenciePhotoType): Promise<string> {
  const path = `${clubId}/${licencieId}/${randomUUID()}.${LICENCIE_PHOTO_TYPES[contentType]}`;
  const { error } = await supabase.storage.from(LICENCIE_PHOTOS_BUCKET).upload(path, content, { contentType, upsert: false, cacheControl: "31536000" });
  if (error) throw new Error(`Enregistrement de la photo échoué : ${error.message}`);
  return supabase.storage.from(LICENCIE_PHOTOS_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Chemin dans le bucket d'une URL de photo stockée par nous, sinon `null` (URL externe saisie à la main : jamais touchée). */
export function storedPhotoPath(url: string | null, clubId: string): string | null {
  if (!url) return null;
  const marker = `/storage/v1/object/public/${LICENCIE_PHOTOS_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  const path = decodeURIComponent(url.slice(index + marker.length).split("?")[0]!);
  return path.startsWith(`${clubId}/`) ? path : null;
}

export async function removeStoredLicenciePhoto(supabase: DbClient, url: string | null, clubId: string): Promise<void> {
  const path = storedPhotoPath(url, clubId);
  if (!path) return;
  const { error } = await supabase.storage.from(LICENCIE_PHOTOS_BUCKET).remove([path]);
  // Supabase Storage renvoie l'erreur au lieu de la lever : sans ceci, un échec serait invisible pour les appelants qui journalisent.
  if (error) throw new Error(`Suppression de la photo échouée : ${error.message}`);
}
