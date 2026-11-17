/**
 * Master key for secrets encrypted at rest (TOTP secrets since v7.0.0, certificate
 * private keys): `MFA_ENCRYPTION_KEY` (64 hex chars or base64 of 32 bytes are used
 * as-is, any other string is stretched with HKDF-SHA256). Without the variable the
 * key is derived via HKDF-SHA256 from `JWT_SECRET` + `PEPPER`, so existing installs
 * keep working without new configuration. Rotating JWT_SECRET or PEPPER without
 * MFA_ENCRYPTION_KEY makes the stored secrets unreadable — set MFA_ENCRYPTION_KEY
 * explicitly before rotating those.
 */
import { hkdfSync } from 'node:crypto';

const SALT = 'coremail-mfa';
const INFO = 'totp-secret-v1';

function hkdf(ikm: string | Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, SALT, INFO, 32));
}

/** The key from MFA_ENCRYPTION_KEY, or null when the variable is not set. */
export function explicitSecretKey(): Buffer | null {
  const raw = process.env['MFA_ENCRYPTION_KEY']?.trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(raw)) {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  }
  return hkdf(raw);
}

/** The key derived from JWT_SECRET + PEPPER (used when MFA_ENCRYPTION_KEY is not set). */
export function fallbackSecretKey(): Buffer {
  const secret = process.env['JWT_SECRET'] ?? '';
  const pepper = process.env['PEPPER'] ?? '';
  if (!secret || !pepper) throw new Error('MFA key derivation needs JWT_SECRET and PEPPER');
  return hkdf(`${secret}\0${pepper}`);
}

/** Key used for new encryptions. */
export function primarySecretKey(): Buffer {
  return explicitSecretKey() ?? fallbackSecretKey();
}
