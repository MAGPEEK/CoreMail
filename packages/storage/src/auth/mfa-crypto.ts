/**
 * TOTP secret encryption at rest (v7.0.0): AES-256-GCM.
 *
 * Key: `MFA_ENCRYPTION_KEY`, or derived from `JWT_SECRET` + `PEPPER` when it is
 * not set (../secret-keys.ts — shared with the certificate private keys).
 *
 * Stored format: `v1:<iv>:<tag>:<ciphertext>` (base64url). Values without the
 * `v1:` prefix are the legacy pre-v6 format (plain base64 of the base32 secret);
 * they are read transparently and re-encrypted on the next successful use.
 * If MFA_ENCRYPTION_KEY is introduced later, secrets encrypted with the derived
 * fallback key are still readable and are re-encrypted with the new key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { explicitSecretKey, fallbackSecretKey, primarySecretKey } from '../secret-keys.js';

const PREFIX = 'v1:';

export function encryptMfaSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', primarySecretKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

function tryDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): string | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface DecryptedSecret {
  secret: string;
  /** true when the stored value should be rewritten with encryptMfaSecret(). */
  needsReencrypt: boolean;
}

/** Returns null when the value cannot be decrypted (wrong key / corrupt). */
export function decryptMfaSecret(stored: string): DecryptedSecret | null {
  if (!stored.startsWith(PREFIX)) {
    const legacy = Buffer.from(stored, 'base64').toString('utf8').trim();
    if (!/^[A-Z2-7]+=*$/i.test(legacy)) return null;
    return { secret: legacy, needsReencrypt: true };
  }
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return null;
  const [ivS, tagS, ctS] = parts as [string, string, string];
  const iv = Buffer.from(ivS, 'base64url');
  const tag = Buffer.from(tagS, 'base64url');
  const ct = Buffer.from(ctS, 'base64url');
  const primary = primarySecretKey();
  const viaPrimary = tryDecrypt(primary, iv, tag, ct);
  if (viaPrimary !== null) return { secret: viaPrimary, needsReencrypt: false };
  if (explicitSecretKey()) {
    const viaFallback = tryDecrypt(fallbackSecretKey(), iv, tag, ct);
    if (viaFallback !== null) return { secret: viaFallback, needsReencrypt: true };
  }
  return null;
}
