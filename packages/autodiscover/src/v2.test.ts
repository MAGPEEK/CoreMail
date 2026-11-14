import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

// No database: the settings lookup falls back to its environment defaults.
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  serverSettings: { findUnique: async () => null, findFirst: async () => null },
};

const { default: express } = await import('express');
const { handleAutodiscoverV2 } = await import('./v2.js');

// Same route as server.ts, on an ephemeral loopback port.
const app = express();
app.get('/autodiscover/autodiscover.json/v1.0/:email', handleAutodiscoverV2);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/autodiscover/autodiscover.json/v1.0/`;
after(() => server.close());

// A crashed handler never answers; fail fast instead of hanging.
const fetch = (url: string) => globalThis.fetch(url, { signal: AbortSignal.timeout(5_000) });

test('a malformed double-encoded address no longer crashes the handler', async () => {
  // Express decodes this to "%E0%A4%A"; the old second decodeURIComponent threw URIError.
  const res = await fetch(`${base}%25E0%25A4%25A?Protocol=IMAP`);
  assert.equal(res.status, 400);
});

test('the server keeps answering after the malformed request', async () => {
  await fetch(`${base}%25E0%25A4%25A?Protocol=IMAP`);
  const res = await fetch(`${base}user%40example.com?Protocol=IMAP`);
  assert.equal(res.status, 200);
  const body = await res.json() as { Protocol: string };
  assert.equal(body.Protocol, 'IMAP');
});

test('a percent-encoded @ in the address is still understood', async () => {
  const res = await fetch(`${base}user%40example.com?Protocol=AutodiscoverV1`);
  assert.equal(res.status, 200);
});

test('an address without @ is rejected with 400', async () => {
  const res = await fetch(`${base}not-an-address?Protocol=IMAP`);
  assert.equal(res.status, 400);
});
