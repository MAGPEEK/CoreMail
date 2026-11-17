/**
 * Certificate private keys at rest (private-key-crypto.ts, private-key-migration.ts):
 * round trip, legacy plain PEM, wrong key → clear error without key material,
 * fallback → MFA_ENCRYPTION_KEY, and the idempotent, locked startup migration.
 * Run: node --import tsx --test src/private-key-crypto.test.ts  (in packages/storage)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
delete process.env['MFA_ENCRYPTION_KEY'];
const JWT_SECRET = process.env['JWT_SECRET'];

type Row = { id: string; keyPem: string | null };
let certs: Row[] = [];
let settings: { tlsKey: string | null } | null = null;
const casMisses: string[] = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  certificate: {
    findMany: async () => certs.filter((c) => c.keyPem !== null).map((c) => ({ ...c })),
    updateMany: async (a: { where: { id: string; keyPem: string }; data: { keyPem: string } }) => {
      const row = certs.find((c) => c.id === a.where.id && c.keyPem === a.where.keyPem);
      if (!row) { casMisses.push(a.where.id); return { count: 0 }; }
      row.keyPem = a.data.keyPem;
      return { count: 1 };
    },
  },
  serverSettings: {
    findUnique: async () => (settings ? { ...settings } : null),
    updateMany: async (a: { where: { tlsKey: string }; data: { tlsKey: string } }) => {
      if (!settings || settings.tlsKey !== a.where.tlsKey) return { count: 0 };
      settings.tlsKey = a.data.tlsKey;
      return { count: 1 };
    },
  },
};

const {
  encryptPrivateKey, decryptPrivateKey, readPrivateKey, isEncryptedPrivateKey, PrivateKeyDecryptError,
} = await import('./private-key-crypto.js');
const {
  migratePrivateKeysAtRest, migratePrivateKeysAtRestLocked, PRIVATE_KEY_MIGRATION_LOCK_KEY,
} = await import('./private-key-migration.js');
const { encryptMfaSecret, decryptMfaSecret } = await import('./auth/mfa-crypto.js');

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
const RSA_PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n';

afterEach(() => {
  delete process.env['MFA_ENCRYPTION_KEY'];
  process.env['JWT_SECRET'] = JWT_SECRET;
  certs = [];
  settings = null;
  casMisses.length = 0;
});

test('round trip: enc:v1 value, random IV, no key material in the stored value', () => {
  const a = encryptPrivateKey(PEM);
  const b = encryptPrivateKey(PEM);
  assert.match(a, /^enc:v1:[\w-]+:[\w-]+:[\w-]+$/);
  assert.notEqual(a, b, 'random IV');
  assert.ok(!a.includes('BEGIN') && !a.includes('MIIEvQ'));
  assert.equal(decryptPrivateKey(a), PEM);
  assert.deepEqual(readPrivateKey(a), { pem: PEM, needsReencrypt: false });
  assert.equal(encryptPrivateKey(a), a, 'encrypting a stored value is a no-op');
  assert.equal(isEncryptedPrivateKey(a), true);
});

test('legacy plain PEM is accepted on read and flagged for re-encryption', () => {
  assert.deepEqual(readPrivateKey(PEM), { pem: PEM, needsReencrypt: true });
  assert.equal(decryptPrivateKey(RSA_PEM), RSA_PEM);
  assert.throws(() => readPrivateKey('not a key'), PrivateKeyDecryptError);
  assert.throws(() => readPrivateKey('enc:v1:only-two:parts'), PrivateKeyDecryptError);
});

test('wrong key → PrivateKeyDecryptError with a clear message and no key material', () => {
  const stored = encryptPrivateKey(PEM);
  process.env['JWT_SECRET'] = 'another-secret-another-secret-12345678';
  let caught: unknown;
  try { decryptPrivateKey(stored); } catch (err) { caught = err; }
  assert.ok(caught instanceof PrivateKeyDecryptError);
  assert.match((caught as Error).message, /cannot be decrypted.*MFA_ENCRYPTION_KEY.*re-upload or re-issue/);
  assert.ok(!(caught as Error).message.includes(stored) && !(caught as Error).message.includes('BEGIN'));
  process.env['MFA_ENCRYPTION_KEY'] = 'b'.repeat(64);
  assert.throws(() => decryptPrivateKey(stored), PrivateKeyDecryptError, 'explicit key + changed fallback');
});

test('fallback-key values stay readable after MFA_ENCRYPTION_KEY is set (and need re-encryption)', () => {
  const viaFallback = encryptPrivateKey(PEM);
  process.env['MFA_ENCRYPTION_KEY'] = 'a'.repeat(64);
  assert.deepEqual(readPrivateKey(viaFallback), { pem: PEM, needsReencrypt: true });
  assert.deepEqual(readPrivateKey(encryptPrivateKey(PEM)), { pem: PEM, needsReencrypt: false });
});

test('a sub-key: the MFA secret format and key cannot read certificate keys and vice versa', () => {
  const mfa = encryptMfaSecret('JBSWY3DPEHPK3PXP');
  assert.throws(() => decryptPrivateKey(`enc:${mfa}`), PrivateKeyDecryptError);
  const cert = encryptPrivateKey(PEM);
  assert.equal(decryptMfaSecret(cert.slice('enc:'.length)), null);
});

test('startup migration encrypts plain keys once, is idempotent and never overwrites unreadable values', async () => {
  const current = encryptPrivateKey(PEM);
  process.env['JWT_SECRET'] = 'old-secret-old-secret-old-secret-123456';
  const unreadable = encryptPrivateKey(PEM);
  process.env['JWT_SECRET'] = JWT_SECRET;
  certs = [
    { id: 'plain', keyPem: PEM }, { id: 'current', keyPem: current },
    { id: 'lost', keyPem: unreadable }, { id: 'pending', keyPem: null },
  ];
  settings = { tlsKey: RSA_PEM };

  assert.deepEqual(await migratePrivateKeysAtRest(), { encrypted: 2, current: 1, unreadable: 1 });
  assert.ok(isEncryptedPrivateKey(certs[0]!.keyPem!));
  assert.equal(decryptPrivateKey(certs[0]!.keyPem!), PEM);
  assert.equal(certs[1]!.keyPem, current, 'already current: untouched');
  assert.equal(certs[2]!.keyPem, unreadable, 'unreadable: left as is');
  assert.equal(decryptPrivateKey(settings.tlsKey!), RSA_PEM);

  const snapshot = JSON.stringify([certs, settings]);
  assert.deepEqual(await migratePrivateKeysAtRest(), { encrypted: 0, current: 3, unreadable: 1 });
  assert.equal(JSON.stringify([certs, settings]), snapshot, 'second run changes nothing');
});

test('startup migration re-encrypts fallback-key values with MFA_ENCRYPTION_KEY', async () => {
  const viaFallback = encryptPrivateKey(PEM);
  certs = [{ id: 'c', keyPem: viaFallback }];
  process.env['MFA_ENCRYPTION_KEY'] = 'c'.repeat(64);
  assert.deepEqual(await migratePrivateKeysAtRest(), { encrypted: 1, current: 0, unreadable: 0 });
  assert.notEqual(certs[0]!.keyPem, viaFallback);
  assert.deepEqual(readPrivateKey(certs[0]!.keyPem!), { pem: PEM, needsReencrypt: false });
});

test('startup migration: a concurrent write wins (compare-and-set on the old value)', async () => {
  certs = [{ id: 'c', keyPem: PEM }];
  const realFind = (globalThis as { __prisma: { certificate: { findMany: () => Promise<Row[]> } } }).__prisma.certificate;
  const findMany = realFind.findMany;
  realFind.findMany = async () => {
    const rows = await findMany();
    certs[0]!.keyPem = encryptPrivateKey(RSA_PEM); // another writer replaces the key meanwhile
    return rows;
  };
  try {
    const r = await migratePrivateKeysAtRest();
    assert.deepEqual(casMisses, ['c']);
    assert.equal(r.encrypted, 0);
    assert.equal(decryptPrivateKey(certs[0]!.keyPem!), RSA_PEM, 'the concurrent value is kept');
  } finally {
    realFind.findMany = findMany;
  }
});

test('locked migration: runs under the Redis lock, skipped while another instance holds it', async () => {
  certs = [{ id: 'c', keyPem: PEM }];
  const calls: string[] = [];
  let held: string | null = null;
  const redis = {
    set: async (key: string, value: string) => {
      calls.push(`set ${key}`);
      if (held) return null;
      held = value;
      return 'OK' as const;
    },
    eval: async (_s: string, _n: number, key: string, token: string | number) => {
      calls.push(`release ${key}`);
      if (held === token) held = null;
      return 1;
    },
  };
  assert.deepEqual(await migratePrivateKeysAtRestLocked(redis), { encrypted: 1, current: 0, unreadable: 0 });
  assert.deepEqual(calls, [`set ${PRIVATE_KEY_MIGRATION_LOCK_KEY}`, `release ${PRIVATE_KEY_MIGRATION_LOCK_KEY}`]);
  assert.equal(held, null, 'lock released');
  held = 'other-instance';
  assert.equal(await migratePrivateKeysAtRestLocked(redis), null);
});
