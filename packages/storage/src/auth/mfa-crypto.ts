/**
 * TOTP secret encryption at rest (v7.0.0): AES-256-GCM.
 *
 * Key: `MFA_ENCRYPTION_KEY` (64 hex chars or base64 of 32 bytes are used as-is,
 * any other string is stretched with HKDF-SHA256). Without the variable the key
 * is derived via HKDF-SHA256 from `JWT_SECRET` + `PEPPER`, so existing installs
 * keep working without new configuration. Note: rotating JWT_SECRET or PEPPER
 * without MFA_ENCRYPTION_KEY makes stored TOTP secrets unreadable — set
 * MFA_ENCRYPTION_KEY explicitly before rotating those.
 *
 * Stored format: `v1:<iv>:<tag>:<ciphertext>` (base64url). Values without the
 * `v1:` prefix are the legacy pre-v6 format (plain base64 of the base32 secret);
 * they are read transparently and re-encrypted on the next successful use.
 * If MFA_ENCRYPTION_KEY is introduced later, secrets encrypted with the derived
 * fallback key are still readable and are re-encrypted with the new key.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const PREFIX = 'v1:';
const SALT = 'coremail-mfa';
const INFO = 'totp-secret-v1';

function hkdf(ikm: string | Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, SALT, INFO, 32));
}

function explicitKey(): Buffer | null {
  const raw = process.env['MFA_ENCRYPTION_KEY']?.trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(raw)) {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  }
  return hkdf(raw);
}

function fallbackKey(): Buffer {
  const secret = process.env['JWT_SECRET'] ?? '';
  const pepper = process.env['PEPPER'] ?? '';
  if (!secret || !pepper) throw new Error('MFA key derivation needs JWT_SECRET and PEPPER');
  return hkdf(`${secret}\0${pepper}`);
}

/** Primary key used for new encryptions. */
function primaryKey(): Buffer {
  return explicitKey() ?? fallbackKey();
}

export function encryptMfaSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', primaryKey(), iv);
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
  const primary = primaryKey();
  const viaPrimary = tryDecrypt(primary, iv, tag, ct);
  if (viaPrimary !== null) return { secret: viaPrimary, needsReencrypt: false };
  if (explicitKey()) {
    const viaFallback = tryDecrypt(fallbackKey(), iv, tag, ct);
    if (viaFallback !== null) return { secret: viaFallback, needsReencrypt: true };
  }
  return null;
}
