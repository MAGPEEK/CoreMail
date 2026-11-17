/**
 * Certificate private keys at rest: `Certificate.keyPem` and
 * `ServerSettings.tlsKey` are stored as `enc:v1:<iv>:<tag>:<ciphertext>`
 * (base64url, AES-256-GCM) in the same columns.
 *
 * Key: a sub-key (HKDF-SHA256, own salt/info) of the master key for secrets at
 * rest — MFA_ENCRYPTION_KEY or its JWT_SECRET + PEPPER fallback (secret-keys.ts).
 * Values written before encryption existed (plain PEM) are still accepted on read
 * (`needsReencrypt`) and encrypted on the next write; the api-gateway encrypts all
 * of them once at startup (private-key-migration.ts). A value encrypted with the
 * fallback key stays readable after MFA_ENCRYPTION_KEY is introduced.
 *
 * Losing the key (MFA_ENCRYPTION_KEY, or JWT_SECRET/PEPPER without it) makes the
 * stored keys unreadable: decryptPrivateKey() then throws PrivateKeyDecryptError
 * and the certificates must be re-uploaded or re-issued (docs/certificates.md).
 * Key material never appears in errors or logs.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { explicitSecretKey, fallbackSecretKey, primarySecretKey } from './secret-keys.js';

export const PRIVATE_KEY_PREFIX = 'enc:v1:';
const SALT = 'coremail-cert-key';
const INFO = 'private-key-v1';

export class PrivateKeyDecryptError extends Error {
  constructor(reason: 'wrong-key' | 'malformed') {
    super(reason === 'wrong-key'
      ? 'Stored certificate private key cannot be decrypted with the configured key '
        + '(MFA_ENCRYPTION_KEY, or JWT_SECRET/PEPPER without it, changed) — re-upload or re-issue the certificate'
      : 'Stored certificate private key is malformed (neither a PEM key nor enc:v1)');
    this.name = 'PrivateKeyDecryptError';
  }
}

function subKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, SALT, INFO, 32));
}

export function isEncryptedPrivateKey(stored: string): boolean {
  return stored.startsWith(PRIVATE_KEY_PREFIX);
}

/** Encrypts a PEM private key. An already encrypted value is returned unchanged. */
export function encryptPrivateKey(value: string): string {
  if (isEncryptedPrivateKey(value)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', subKey(primarySecretKey()), iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${PRIVATE_KEY_PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

function tryDecrypt(master: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): string | null {
  try {
    const d = createDecipheriv('aes-256-gcm', subKey(master), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface ReadPrivateKey {
  pem: string;
  /** true for a plaintext value or one encrypted with the fallback key while MFA_ENCRYPTION_KEY is set. */
  needsReencrypt: boolean;
}

/** Decrypts a stored value; plain PEM (written before encryption) is accepted. Throws PrivateKeyDecryptError. */
export function readPrivateKey(stored: string): ReadPrivateKey {
  if (!isEncryptedPrivateKey(stored)) {
    if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(stored.trimStart())) throw new PrivateKeyDecryptError('malformed');
    return { pem: stored, needsReencrypt: true };
  }
  const parts = stored.slice(PRIVATE_KEY_PREFIX.length).split(':');
  if (parts.length !== 3) throw new PrivateKeyDecryptError('malformed');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  const viaPrimary = tryDecrypt(primarySecretKey(), iv, tag, ct);
  if (viaPrimary !== null) return { pem: viaPrimary, needsReencrypt: false };
  if (explicitSecretKey()) {
    const viaFallback = tryDecrypt(fallbackSecretKey(), iv, tag, ct);
    if (viaFallback !== null) return { pem: viaFallback, needsReencrypt: true };
  }
  throw new PrivateKeyDecryptError('wrong-key');
}

/** The plain PEM of a stored private key (see readPrivateKey). */
export function decryptPrivateKey(stored: string): string {
  return readPrivateKey(stored).pem;
}
