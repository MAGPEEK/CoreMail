/**
 * One-time encryption of private keys stored before encryption at rest existed
 * (private-key-crypto.ts): every `Certificate.keyPem`, `Certificate.acmeAccount`
 * (ACME account key) and the `ServerSettings.tlsKey` that is still plain PEM — or
 * was encrypted with the fallback key while MFA_ENCRYPTION_KEY is set — is
 * rewritten encrypted with the current key. Idempotent (already current values
 * are skipped) and race-free (compare-and-set on the old value: a concurrent
 * write wins). Values that cannot be decrypted are counted, never overwritten.
 * Runs at api-gateway startup under a cluster-wide Redis lock.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma/index.js';
import { encryptPrivateKey, readPrivateKey, PrivateKeyDecryptError } from './private-key-crypto.js';

export const PRIVATE_KEY_MIGRATION_LOCK_KEY = 'cert:private-key-encryption:lock';
const LOCK_TTL_MS = 5 * 60_000;
const RELEASE_LOCK_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export interface PrivateKeyMigrationResult {
  /** Values rewritten encrypted with the current key. */
  encrypted: number;
  /** Values already encrypted with the current key. */
  current: number;
  /** Values that cannot be decrypted with the configured key (left unchanged). */
  unreadable: number;
}

/** Minimal Redis surface (ioredis-compatible). */
export interface PrivateKeyMigrationRedis {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

type Outcome = 'encrypted' | 'current' | 'unreadable' | 'changed';
type CertificateKeyColumn = 'keyPem' | 'acmeAccount';

/** What to write for a stored value: the re-encrypted value, or the reason to leave it. */
function planPrivateKeyReencrypt(stored: string): { write: string } | { skip: 'current' | 'unreadable' } {
  try {
    const { pem, needsReencrypt } = readPrivateKey(stored);
    if (!needsReencrypt) return { skip: 'current' };
    // encryptPrivateKey() keeps an encrypted value as-is — encrypt the plain PEM.
    return { write: encryptPrivateKey(pem) };
  } catch (err) {
    if (err instanceof PrivateKeyDecryptError) return { skip: 'unreadable' };
    throw err;
  }
}

async function migrateCertificate(id: string, column: CertificateKeyColumn, stored: string): Promise<Outcome> {
  const p = planPrivateKeyReencrypt(stored);
  if ('skip' in p) return p.skip;
  const r = column === 'keyPem'
    ? await prisma.certificate.updateMany({ where: { id, keyPem: stored }, data: { keyPem: p.write } })
    : await prisma.certificate.updateMany({ where: { id, acmeAccount: stored }, data: { acmeAccount: p.write } });
  return r.count === 1 ? 'encrypted' : 'changed';
}

async function migrateServerSettings(stored: string): Promise<Outcome> {
  const p = planPrivateKeyReencrypt(stored);
  if ('skip' in p) return p.skip;
  const r = await prisma.serverSettings.updateMany({ where: { id: 'singleton', tlsKey: stored }, data: { tlsKey: p.write } });
  return r.count === 1 ? 'encrypted' : 'changed';
}

/** Encrypts every stored private key that is not yet encrypted with the current key. */
export async function migratePrivateKeysAtRest(): Promise<PrivateKeyMigrationResult> {
  const result: PrivateKeyMigrationResult = { encrypted: 0, current: 0, unreadable: 0 };
  const count = (o: Outcome) => { if (o !== 'changed') result[o]++; };
  const certs = await prisma.certificate.findMany({
    where: { OR: [{ keyPem: { not: null } }, { acmeAccount: { not: null } }] },
    select: { id: true, keyPem: true, acmeAccount: true },
  });
  for (const c of certs) {
    if (c.keyPem) count(await migrateCertificate(c.id, 'keyPem', c.keyPem));
    if (c.acmeAccount) count(await migrateCertificate(c.id, 'acmeAccount', c.acmeAccount));
  }
  const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { tlsKey: true } });
  if (settings?.tlsKey) count(await migrateServerSettings(settings.tlsKey));
  return result;
}

/**
 * migratePrivateKeysAtRest() under a cluster-wide Redis lock (SET NX PX with a
 * random token, compare-and-delete release). Null when another instance holds it.
 */
export async function migratePrivateKeysAtRestLocked(redis: PrivateKeyMigrationRedis): Promise<PrivateKeyMigrationResult | null> {
  const token = randomUUID();
  const got = await redis.set(PRIVATE_KEY_MIGRATION_LOCK_KEY, token, 'PX', LOCK_TTL_MS, 'NX');
  if (got !== 'OK') return null;
  try {
    return await migratePrivateKeysAtRest();
  } finally {
    // A failed release is harmless: the lock expires after LOCK_TTL_MS.
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, PRIVATE_KEY_MIGRATION_LOCK_KEY, token).catch(() => undefined);
  }
}
