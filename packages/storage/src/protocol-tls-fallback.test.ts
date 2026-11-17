/**
 * Unreadable certificate private key (w1 integration): the mail servers keep TLS
 * with the self-signed replacement for the public host name instead of dropping
 * TLS (implicit-TLS ports used to fall back to plaintext), and the BCP can list
 * the certificates in use whose key cannot be read.
 * Run: node --import tsx --test src/protocol-tls-fallback.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const LEAF = '-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n';
const KEY = '-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n';
/** Encrypted with a key that is not configured — what a lost MFA_ENCRYPTION_KEY looks like. */
const LOST = 'enc:v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA';

type Row = Record<string, unknown>;
let protocolRow: Row | null = null;
let settings: Row | null = null;
let selfSignedRows: Row[] = [];
let inUseRows: Row[] = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  certificate: {
    findFirst: async () => protocolRow,
    findMany: async (a: { where: Row }) => (a.where['type'] === 'SELF_SIGNED' ? selfSignedRows : inUseRows),
  },
  serverSettings: { findUnique: async (a: { select?: Row }) => (a.select?.['publicHostname'] ? { publicHostname: 'mail.example.com' } : settings) },
};
const {
  loadProtocolCert, loadProtocolTls, selfSignedReplacement, unreadableInUseCertKeys, UnreadableCertKeyError, LEGACY_SERVER_CERT_NAME,
} = await import('./protocol-cert.js');
const { encryptPrivateKey, PrivateKeyDecryptError } = await import('./private-key-crypto.js');

let generated: string[] = [];
const fakeGenerate = (hostname: string) => {
  generated.push(hostname);
  return { certPem: `-----BEGIN CERTIFICATE-----\nSELF ${hostname}\n-----END CERTIFICATE-----\n`, keyPem: KEY };
};
const reset = () => { protocolRow = null; settings = null; selfSignedRows = []; inUseRows = []; generated = []; };

test('loadProtocolCert names the certificate whose key is unreadable (still a PrivateKeyDecryptError)', async () => {
  reset();
  protocolRow = { id: 'c1', name: 'Firmenzertifikat', certPem: LEAF, keyPem: LOST, chainPem: null };
  const err = await loadProtocolCert('smtp').catch((e: unknown) => e);
  assert.ok(err instanceof UnreadableCertKeyError);
  assert.ok(err instanceof PrivateKeyDecryptError, 'existing callers keep matching');
  assert.deepEqual(err.cert, { certId: 'c1', certName: 'Firmenzertifikat' });
  assert.match(err.message, /Firmenzertifikat/);
  assert.doesNotMatch(err.message, /AAAA/, 'no stored key material in the message');
  // legacy ServerSettings pair
  protocolRow = null;
  settings = { tlsCert: LEAF, tlsKey: LOST };
  const legacy = await loadProtocolCert('imap').catch((e: unknown) => e);
  assert.ok(legacy instanceof UnreadableCertKeyError);
  assert.equal(legacy.cert.certName, LEGACY_SERVER_CERT_NAME);
});

test('loadProtocolTls: unreadable key → generated self-signed replacement for the public host name, TLS stays on', async () => {
  reset();
  protocolRow = { id: 'c1', name: 'Firmenzertifikat', certPem: LEAF, keyPem: LOST, chainPem: null };
  for (const service of ['SMTP', 'IMAP', 'POP3']) {
    const tls = await loadProtocolTls(service, fakeGenerate);
    assert.ok(tls, `${service}: never null (null would mean plaintext on the implicit-TLS port)`);
    assert.equal(tls.source, 'self-signed-replacement');
    assert.match(tls.certPem, /SELF mail\.example\.com/);
    assert.equal(tls.keyPem, KEY);
    assert.deepEqual(tls.unreadable, { certId: 'c1', certName: 'Firmenzertifikat' });
  }
  assert.deepEqual(generated, ['mail.example.com'], 'generated once per process and host name (no rotation on every reload)');
});

test('loadProtocolTls: the readable self-signed default row is preferred over a generated certificate', async () => {
  reset();
  protocolRow = { id: 'c1', name: 'Firmenzertifikat', certPem: LEAF, keyPem: LOST, chainPem: null };
  selfSignedRows = [
    { id: 'ss-broken', name: 'mail.example.com (alt)', certPem: LEAF, keyPem: LOST },
    { id: 'ss1', name: 'mail.example.com', certPem: LEAF, keyPem: encryptPrivateKey(KEY) },
  ];
  const tls = await loadProtocolTls('SMTP', fakeGenerate);
  assert.equal(tls?.certId, 'ss1');
  assert.equal(tls?.keyPem, KEY);
  assert.equal(tls?.unreadable?.certName, 'Firmenzertifikat');
  assert.deepEqual(generated, []);
});

test('loadProtocolTls: readable and missing certificates behave as before', async () => {
  reset();
  protocolRow = { id: 'c1', name: 'ok', certPem: LEAF, keyPem: encryptPrivateKey(KEY), chainPem: null };
  const ok = await loadProtocolTls('SMTP', fakeGenerate);
  assert.equal(ok?.source, 'protocol-cert');
  assert.equal(ok?.unreadable, undefined);
  protocolRow = null;
  assert.equal(await loadProtocolTls('IMAP', fakeGenerate), null, 'first start: the server generates and stores its default');
});

test('selfSignedReplacement: generated material is stable per host name', async () => {
  reset();
  const a = await selfSignedReplacement(fakeGenerate);
  const b = await selfSignedReplacement(fakeGenerate);
  assert.equal(a.hostname, 'mail.example.com');
  assert.equal(a.certPem, b.certPem);
});

test('unreadableInUseCertKeys: lists in-use certificates whose key cannot be read, without key data', async () => {
  reset();
  inUseRows = [
    { id: 'p1', name: 'Mail', keyPem: LOST, services: ['SMTP', 'IMAP', 'POP3', 'HTTPS'], isActiveProtocol: true, isActiveHttps: false },
    { id: 'h1', name: 'Web', keyPem: LOST, services: [], isActiveProtocol: false, isActiveHttps: true },
    { id: 'ok', name: 'Readable', keyPem: encryptPrivateKey(KEY), services: ['SMTP'], isActiveProtocol: true, isActiveHttps: true },
  ];
  const list = await unreadableInUseCertKeys();
  assert.deepEqual(list, [
    { id: 'p1', name: 'Mail', services: ['SMTP', 'IMAP', 'POP3'], https: false },
    { id: 'h1', name: 'Web', services: [], https: true },
  ]);
});
