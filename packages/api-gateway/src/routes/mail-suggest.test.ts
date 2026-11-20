/**
 * 10.2: GET /api/v1/mail/search/suggest — own mailbox: the folder scope, bounded
 * queries, the contacts-module gate and the per-user rate limit (Prisma faked via
 * globalThis.__prisma, rate-limit counters via globalThis.__rateLimitRedis).
 * Shared / delegated mailboxes: foreign-suggest.test.ts.
 * Run: node --import tsx --test --test-force-exit src/routes/mail-suggest.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
process.env['MAIL_SUGGEST_RATE_LIMIT'] = '8';
process.env['MAIL_SUGGEST_RATE_WINDOW_SEC'] = '60';
const counters = new Map<string, number>();
(globalThis as Record<string, unknown>)['__rateLimitRedis'] = {
  incr: async (k: string) => { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n; },
  expire: async () => 1,
};

type Row = Record<string, unknown>;
const MAILBOXES: Record<string, string> = { u1: 'mb1', u2: 'mb2', u3: 'mb3' };
const FOLDERS: Record<string, Row[]> = {
  mb1: [
    { id: 'inbox', name: 'INBOX', displayName: 'Posteingang' },
    { id: 'sent', name: 'Sent', displayName: 'Gesendet' },
    { id: 'trash', name: 'Trash', displayName: 'Papierkorb' },
  ],
  mb2: [{ id: 'inbox2', name: 'INBOX', displayName: 'Posteingang' }],
  mb3: [{ id: 'inbox3', name: 'INBOX', displayName: 'Posteingang' }],
};
const calls: Array<{ model: string; args: Row }> = [];
const raw: unknown[][] = [];
installFakePrisma({
  mailbox: {
    findFirst: (a) => {
      const id = MAILBOXES[String(((a as { where: Row }).where)['userId'])];
      return id ? { id } : null;
    },
  },
  folder: { findMany: (a) => FOLDERS[String(((a as { where: Row }).where)['mailboxId'])] ?? [] },
  message: {
    findMany: (a) => {
      const args = a as Row;
      calls.push({ model: 'message', args });
      if ('subject' in (args['select'] as Row)) {
        return [{ id: 'm1', folderId: 'inbox', subject: 'Angebot', fromName: 'Anna Koch', fromAddr: 'anna@kunde.de', date: new Date('2026-03-01T10:00:00Z') }];
      }
      return [{ fromName: 'Anna Koch', fromAddr: 'anna@kunde.de' }];
    },
  },
  contact: {
    findMany: (a) => {
      calls.push({ model: 'contact', args: a as Row });
      return [{ displayName: 'Anna Privat', email: 'anna@privat.de', email2: '' }];
    },
  },
  // u2: the contacts module is switched off for the user (webmail policy)
  webmailPolicy: { findMany: () => [{ id: 'p-u2', userId: 'u2', domainId: null, contacts: 'OFF' }] },
  $raw: {
    queryRaw: (...a) => { raw.push(a); return [{ address: 'anna.weber@partner.de' }]; },
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mailRouter } = await import('./mail.js');

const tok = (sub: string) => core.signAccessToken({ sub, email: `${sub}@ex.com`, role: 'USER', domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: false });

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

async function suggest(qs: string, user = 'u1'): Promise<{ status: number; json: Row }> {
  const r = await fetch(`${base}/api/v1/mail/search/suggest?${qs}`, { headers: { authorization: `Bearer ${tok(user)}` } });
  return { status: r.status, json: await r.json() as Row };
}

test('people + messages from every own folder, bounded, no bodies', async () => {
  calls.length = 0; raw.length = 0;
  const r = await suggest('q=anna');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    people: [
      { name: 'Anna Koch', address: 'anna@kunde.de' },
      { name: '', address: 'anna.weber@partner.de' },
      { name: 'Anna Privat', address: 'anna@privat.de' },
    ],
    messages: [{ id: 'm1', folderId: 'inbox', folderName: 'Posteingang', subject: 'Angebot', fromName: 'Anna Koch', fromAddr: 'anna@kunde.de', date: '2026-03-01T10:00:00.000Z' }],
  });
  const msgQueries = calls.filter((c) => c.model === 'message');
  assert.equal(msgQueries.length, 2);
  for (const q of msgQueries) {
    // same scope as /search: every own folder (Trash included), live messages only
    assert.deepEqual((q.args['where'] as Row)['folderId'], { in: ['inbox', 'sent', 'trash'] });
    assert.equal((q.args['where'] as Row)['deletedAt'], null);
    assert.ok(typeof q.args['take'] === 'number' && (q.args['take'] as number) <= 40);
    assert.doesNotMatch(JSON.stringify(q.args), /bodyText|bodyHtml/);
  }
  assert.deepEqual((calls.find((c) => c.model === 'contact')!.args['where'] as Row)['userId'], 'u1');
  assert.equal(raw.length, 1);
  assert.equal(raw[0]![1], 'sent', 'recipients only from the own Sent folder');
});

test('too short / missing query: empty answer without any database query', async () => {
  calls.length = 0; raw.length = 0;
  for (const qs of ['q=a', 'q=', '', 'q=%20%20b%20', 'q=ab&q=cd']) {
    const r = await suggest(qs);
    assert.equal(r.status, 200, qs);
    assert.deepEqual(r.json, { people: [], messages: [] }, qs);
  }
  assert.equal(calls.length + raw.length, 0);
});

test('contacts module off: no contact query, the mailbox still suggests', async () => {
  calls.length = 0; raw.length = 0;
  const r = await suggest('q=anna', 'u2');
  assert.equal(r.status, 200);
  assert.ok(!calls.some((c) => c.model === 'contact'));
  assert.deepEqual((r.json['people'] as Row[]).map((p) => p['address']), ['anna@kunde.de']);
  assert.equal(raw.length, 0, 'no Sent folder in this mailbox');
});

test('no mailbox → empty; no token → 401', async () => {
  assert.deepEqual((await suggest('q=anna', 'nobody')).json, { people: [], messages: [] });
  const r = await fetch(`${base}/api/v1/mail/search/suggest?q=anna`);
  assert.equal(r.status, 401);
});

test('per-user rate limit: 429 RATE_LIMITED with Retry-After once the window is used up', async () => {
  counters.clear();
  for (let i = 0; i < 8; i++) assert.equal((await suggest('q=anna', 'u3')).status, 200, `request ${i + 1}`);
  const r = await fetch(`${base}/api/v1/mail/search/suggest?q=anna`, { headers: { authorization: `Bearer ${tok('u3')}` } });
  assert.equal(r.status, 429);
  assert.equal((await r.json() as Row)['code'], 'RATE_LIMITED');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  // another user is not affected
  assert.equal((await suggest('q=anna', 'u1')).status, 200);
});
