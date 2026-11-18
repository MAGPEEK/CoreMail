/**
 * 9.4: assigning categories to messages is a message change — the rows get a
 * new modSeq (message store touch) and one `mailbox:changes` event goes out
 * after the commit; editing the category list is a `settings` user event.
 * Prisma faked via globalThis.__prisma, realtime transport via __realtimeRedis.
 * Run: node --import tsx --test --test-force-exit src/routes/categories.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const published: Array<{ channel: string; message: Row }> = [];
const touched: Row[] = [];
let modSeq = 10n;

globalThis.__realtimeRedis = {
  publish: async (channel: string, message: string) => { published.push({ channel, message: JSON.parse(message) as Row }); },
};

installFakePrisma({
  user: { findUnique: () => ({ role: 'USER', active: true }) },
  message: {
    findFirst: () => ({ id: 'm1', folderId: 'inbox' }),
    findMany: (a) => {
      const sel = (a as { select?: Row }).select ?? {};
      if ('folder' in sel) return [{ id: 'm1', folderId: 'inbox', folder: { mailboxId: 'mb1' } }, { id: 'm2', folderId: 'archive', folder: { mailboxId: 'mb1' } }];
      return [{ id: 'm1' }, { id: 'm2' }];
    },
    aggregate: () => ({ _max: { modSeq: null, uid: null } }),
    updateMany: (a) => { touched.push((a as { data: Row }).data); return { count: 1 }; },
  },
  mailbox: { update: () => ({ uidNext: 1, highestModSeq: ++modSeq }) },
  category: {
    findMany: () => [{ id: 'c1' }],
    findFirst: () => null,
    create: (a) => ({ id: 'c2', ...(a as { data: Row }).data }),
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { categoriesRouter } = await import('./categories.js');

const token = core.signAccessToken({ sub: 'alice', email: 'alice@ex.com', role: 'USER', domainId: 'd1', sessionId: 's-alice', mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/categories', categoriesRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); globalThis.__realtimeRedis = null; });
beforeEach(() => { published.length = 0; touched.length = 0; });

const post = (path: string, body: unknown) => fetch(`${base}/api/v1/categories${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

// the shared fake client ignores installChangeScope (its $transaction is a getter), so the
// changes take the outside-a-transaction path: published 100 ms after the write
const settle = () => new Promise((r) => setTimeout(r, 200));

test('setting the categories of a message touches it and announces a message change', async () => {
  const res = await post('/messages/m1', { categoryIds: ['c1'] });
  assert.equal(res.status, 200);
  await settle();
  assert.equal(touched.length, 1);
  assert.equal(touched[0]!['changeKey'], '11');
  assert.deepEqual(published, [{
    channel: 'mailbox:changes',
    message: { mailboxId: 'mb1', kinds: ['messages'], folderIds: ['inbox', 'archive'], modSeq: '11' },
  }], 'one mailbox change — no settings event for message tagging');
});

test('bulk assignment touches all owned messages in one change', async () => {
  const res = await post('/messages/bulk', { messageIds: ['m1', 'm2'], action: 'add', categoryIds: ['c1'] });
  assert.equal(res.status, 200);
  await settle();
  assert.equal(published.length, 1);
  assert.equal(published[0]!.channel, 'mailbox:changes');
});

test('creating a category is a settings event of the acting user', async () => {
  const res = await post('/', { name: 'Projekt', color: '#112233' });
  assert.ok(res.status < 400, `status ${res.status}`);
  await settle();
  assert.deepEqual(published, [{ channel: 'user:alice:events', message: { type: 'settings', section: 'categories' } }]);
});
