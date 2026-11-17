/**
 * Protocol TLS cert loader: an uploaded certificate with a separate chain is
 * served as leaf + intermediates on SMTP/IMAP/POP3 (9.2.x fix).
 * Run: node --import tsx --test src/protocol-cert.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
const LEAF = '-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n';
const INTER = '-----BEGIN CERTIFICATE-----\nINTER\n-----END CERTIFICATE-----\n';
let row: Record<string, unknown> | null = null;
let settings: Record<string, unknown> | null = null;
type Where = { NOT?: Record<string, unknown>; type?: unknown; acmeStaging?: unknown; certPem?: unknown };
/** Minimal matcher: the NOT clause and plain equality on type / acmeStaging / certPem (string). */
function matches(r: Record<string, unknown>, where: Where): boolean {
  if (where.NOT && Object.entries(where.NOT).every(([k, v]) => r[k] === v)) return false;
  for (const k of ['type', 'acmeStaging'] as const) if (k in where && r[k] !== where[k]) return false;
  if (typeof where.certPem === 'string' && r['certPem'] !== where.certPem) return false;
  return true;
}
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  certificate: { findFirst: async (a: { where: Where }) => (row && matches(row, a.where) ? row : null) },
  serverSettings: { findUnique: async () => settings },
};
const { loadProtocolCert, pemWithChain } = await import('./protocol-cert.js');

test('pemWithChain appends missing chain certificates once', () => {
  assert.equal(pemWithChain(LEAF, null), LEAF);
  const full = pemWithChain(LEAF, INTER);
  assert.equal((full.match(/BEGIN CERTIFICATE/g) ?? []).length, 2);
  assert.ok(full.startsWith('-----BEGIN CERTIFICATE-----\nLEAF'));
  assert.equal(pemWithChain(full, INTER), full);
});

test('loadProtocolCert returns leaf + chain for the active protocol certificate', async () => {
  row = { id: 'c1', name: 'upload', certPem: LEAF, keyPem: 'KEY', chainPem: INTER };
  const cert = await loadProtocolCert('smtp');
  assert.equal(cert?.source, 'protocol-cert');
  assert.match(cert!.certPem, /LEAF[\s\S]*INTER/);
  row = null;
  assert.equal(await loadProtocolCert('imap'), null);
});

test('9.2.x review: a Let\'s Encrypt staging certificate is never served on SMTP/IMAP/POP3', async () => {
  row = { id: 's1', name: 'staging', type: 'LETSENCRYPT', acmeStaging: true, certPem: LEAF, keyPem: 'KEY', chainPem: null };
  assert.equal(await loadProtocolCert('smtp'), null, 'active staging cert ignored');
  // legacy ServerSettings copy of the staging PEM is ignored as well
  settings = { tlsCert: LEAF, tlsKey: 'KEY' };
  assert.equal(await loadProtocolCert('smtp'), null, 'legacy copy of a staging PEM ignored');
  // a production Let's Encrypt cert is served; a legacy copy of another PEM still works
  row = { id: 'p1', name: 'prod', type: 'LETSENCRYPT', acmeStaging: false, certPem: LEAF, keyPem: 'KEY', chainPem: null };
  assert.equal((await loadProtocolCert('smtp'))?.certId, 'p1');
  row = { id: 's1', name: 'staging', type: 'LETSENCRYPT', acmeStaging: true, certPem: INTER, keyPem: 'KEY', chainPem: null };
  assert.equal((await loadProtocolCert('imap'))?.source, 'legacy-server-settings');
  row = null; settings = null;
});
