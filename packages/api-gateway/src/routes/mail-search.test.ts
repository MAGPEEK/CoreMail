/**
 * GET /api/v1/mail/search with operators — the parsed query reaches Prisma as
 * a where-object scoped to the caller's folders (Prisma faked via globalThis.__prisma).
 * Run: node --import tsx --test --test-force-exit src/routes/mail-search.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const FOLDERS = [
  { id: 'inbox', name: 'INBOX', displayName: 'Posteingang' },
  { id: 'sent', name: 'Sent', displayName: 'Gesendet' },
];
const seen: Row[] = [];
installFakePrisma({
  mailbox: { findFirst: (a) => ((a as { where: { userId: string } }).where.userId === 'u1' ? { id: 'mb1' } : null) },
  folder: { findMany: () => FOLDERS },
  message: {
    findMany: (a) => { seen.push((a as { where: Row }).where); return []; },
    count: () => 0,
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mailRouter } = await import('./mail.js');

const tok = core.signAccessToken({ sub: 'u1', email: 'u1@ex.com', role: 'USER', domainId: 'd1', sessionId: 's-u1', mfaVerified: false });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/mail', mailRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function search(qs: string): Promise<{ status: number; json: Row }> {
  const r = await fetch(`${base}/api/v1/mail/search?${qs}`, { headers: { authorization: `Bearer ${tok}` } });
  return { status: r.status, json: await r.json() as Row };
}

test('plain text keeps the legacy OR-where over all own folders', async () => {
  seen.length = 0;
  const r = await search('q=invoice');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json['chips'], []);
  assert.deepEqual(JSON.parse(JSON.stringify(seen[0])), {
    folderId: { in: ['inbox', 'sent'] },
    deletedAt: null,
    OR: [
      { subject: { contains: 'invoice', mode: 'insensitive' } },
      { fromAddr: { contains: 'invoice', mode: 'insensitive' } },
      { fromName: { contains: 'invoice', mode: 'insensitive' } },
      { bodyText: { contains: 'invoice', mode: 'insensitive' } },
    ],
  });
});

test('operators become an AND list; in: overrides the folderId scope', async () => {
  seen.length = 0;
  const r = await search(`q=${encodeURIComponent('in:sent is:unread from:bob -"weekly digest"')}&folderId=inbox`);
  assert.equal(r.status, 200);
  const w = JSON.parse(JSON.stringify(seen[0])) as Row;
  assert.deepEqual(w['folderId'], { in: ['sent'] });
  assert.equal((w['AND'] as unknown[]).length, 3);
  assert.deepEqual((r.json['chips'] as Row[]).map((c) => c['key']), ['in', 'is', 'from', 'text']);
});

test('only-invalid operators return an empty result without querying', async () => {
  seen.length = 0;
  const r = await search(`q=${encodeURIComponent('before:2026-02-31')}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json['messages'], []);
  assert.equal(seen.length, 0);
  assert.equal((r.json['chips'] as Row[])[0]!['valid'], false);
});

test('unknown in: folder or foreign folderId', async () => {
  seen.length = 0;
  assert.deepEqual((await search(`q=${encodeURIComponent('in:nowhere hello')}`)).json['messages'], []);
  assert.equal(seen.length, 0);
  assert.equal((await search('q=hello&folderId=foreign')).status, 404);
});
