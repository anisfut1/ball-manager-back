import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "../config/env.js";

/**
 * Copié depuis ball-manager-web src/lib/security/crypto.ts (seul changement : la clé
 * vient de `getEnv()` au lieu du `serverEnv` couplé Next.js — la logique
 * de chiffrement elle-même est inchangée). Voir docs/AUTH.md.
 */
const ALGORITHM = "aes-256-gcm";
/** Taille recommandée pour l'IV en mode GCM (96 bits). */
const IV_LENGTH_BYTES = 12;

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export class DecryptionError extends Error {
  constructor(cause?: unknown) {
    super("Déchiffrement impossible (clé incorrecte ou données corrompues)");
    this.name = "DecryptionError";
    this.cause = cause;
  }
}

function getKey(): Buffer {
  return Buffer.from(getEnv().FBI_CREDENTIALS_ENCRYPTION_KEY, "base64");
}

/**
 * Chiffre un secret (ex: mot de passe FBI) avec AES-256-GCM. La clé vient
 * uniquement de `FBI_CREDENTIALS_ENCRYPTION_KEY` — jamais stockée en base.
 *
 * `aad` (Additional Authenticated Data, le club_id propriétaire du secret)
 * est authentifié par le tag GCM sans être chiffré : un ciphertext déplacé
 * vers un autre club ne pourra plus être déchiffré en fournissant l'AAD du
 * club d'origine.
 */
export function encryptSecret(plaintext: string, aad?: string): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Déchiffre un secret. Lève `DecryptionError` (jamais le détail natif de
 * `node:crypto`) si la clé est incorrecte, les données corrompues/altérées,
 * ou si `aad` ne correspond pas à celui utilisé au chiffrement.
 */
export function decryptSecret(payload: EncryptedPayload, aad?: string): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(payload.iv, "base64"));
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (error) {
    throw new DecryptionError(error);
  }
}
