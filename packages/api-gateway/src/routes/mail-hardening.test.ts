/**
 * 8.0.x OWASP wave — route-level regression tests on a loopback Express app:
 *  - requireAuth ignores ?token= (header only); /api/v1/events accepts a
 *    single-use ?ticket= and (deprecated) ?token=
 *  - PATCH /mail/folders/:id: parent in the caller's mailbox, no cycles
 *  - POST /mail/send: recipient count/syntax, per-user rate limit
 *  - GET /mail/image-proxy: authenticated, SSRF-checked
 * Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test --test-force-exit src/routes/mail-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
process.env['MAIL_SEND_RATE_LIMIT'] = '3';

type Row = Record<string, unknown>;
const folders: Record<string, { id: string; name: string; parentId: string | null; mailboxId: string; owner: string }> = {
  inbox: { id: 'inbox', name: 'INBOX', parentId: null, mailboxId: 'mb1', owner: 'u1' },
  a: { id: 'a', name: 'A', parentId: null, mailboxId: 'mb1', owner: 'u1' },
  b: { id: 'b', name: 'B', parentId: 'a', mailboxId: 'mb1', owner: 'u1' },
  other: { id: 'other', name: 'X', parentId: null, mailboxId: 'mb2', owner: 'u2' },
};
const folderUpdates: Row[] = [];
installFakePrisma({
  folder: {
    findFirst: (a) => {
      const q = a as { where: { id?: string; mailbox?: { userId?: string }; mailboxId?: string; name?: string } };
      if (q.where.name) return null;
      const f = q.where.id ? folders[q.where.id] : undefined;
      if (!f) return null;
      if (q.where.mailbox?.userId && f.owner !== q.where.mailbox.userId) return null;
      return f;
    },
    findUnique: (a) => { const f = folders[(a as { where: { id: string } }).where.id]; return f ? { parentId: f.parentId, mailboxId: f.mailboxId } : null; },
    update: (a) => { const q = a as { where: { id: string }; data: Row }; folderUpdates.push(q.data); return { ...folders[q.where.id], ...q.data }; },
  },
  mailbox: { findFirst: () => null },
});

const kv = new Map<string, string>();
(globalThis as Record<string, unknown>)['__ticketRedis'] = {
  setex: async (k: string, _s: number, v: string) => { kv.set(k, v); return 'OK'; },
  get: async (k: string) => kv.get(k) ?? null,
  del: async (k: string) => (kv.delete(k) ? 1 : 0),
};
const counters = new Map<string, number>();
(globalThis as Record<string, unknown>)['__rateLimitRedis'] = {
  incr: async (k: string) => { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n; },
  expire: async () => 1,
};

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { mailRouter } = await import('./mail.js');
const { requireAuth, requireSseAuth } = await import('../middleware/auth.js');
const { eventTicketHandler } = await import('../lib/event-tickets.js');

const tok = (sub: string) => core.signAccessToken({ sub, email: `${sub}@ex.com`, role: 'USER', domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: false });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.post('/api/v1/events/ticket', requireAuth, eventTicketHandler);
  app.get('/api/v1/events', requireSseAuth, (req, res) => { const u = (req as unknown as { apiUser: { userId: string; sessionId?: string } }).apiUser; res.json({ userId: u.userId, sessionId: u.sessionId }); });
  app.use('/api/v1/mail', mailRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: Row }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const r = await fetch(`${base}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json };
}

test('?token= is no longer accepted on regular API routes', async () => {
  const t = tok('u1');
  assert.equal((await call('GET', `/api/v1/mail/folders?token=${encodeURIComponent(t)}`)).status, 401);
  assert.equal((await call('GET', '/api/v1/mail/folders', { token: t })).status, 200);
});

test('SSE: single-use ticket bound to the session; ?token= still works (deprecated)', async () => {
  const t = tok('u1');
  assert.equal((await call('POST', '/api/v1/events/ticket')).status, 401, 'ticket needs the Authorization header');
  const issued = await call('POST', '/api/v1/events/ticket', { token: t });
  assert.equal(issued.status, 200);
  const ticket = String(issued.json['ticket']);
  assert.equal(issued.json['expiresIn'], 60);
  const first = await call('GET', `/api/v1/events?ticket=${ticket}`);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { userId: 'u1', sessionId: 's-u1' });
  assert.equal((await call('GET', `/api/v1/events?ticket=${ticket}`)).status, 401, 'single use');
  assert.equal((await call('GET', '/api/v1/events?ticket=bogus')).status, 401);
  assert.equal((await call('GET', `/api/v1/events?token=${encodeURIComponent(t)}`)).status, 200, 'compat');
  assert.equal((await call('GET', '/api/v1/events')).status, 401);

  // a revoked session also invalidates its unredeemed tickets
  const t2 = tok('u3');
  const tk2 = String((await call('POST', '/api/v1/events/ticket', { token: t2 })).json['ticket']);
  const storage = await import('@coremail/storage/auth');
  await storage.markSessionsRevoked(['s-u3'], 'u3');
  assert.equal((await call('GET', `/api/v1/events?ticket=${tk2}`)).status, 401);
});

test('PATCH /mail/folders/:id: parent must be in the own mailbox, no cycles, system folders stay', async () => {
  const t = tok('u1');
  assert.equal((await call('PATCH', '/api/v1/mail/folders/a', { token: t, body: { parentId: 'other' } })).status, 404, 'foreign parent');
  assert.equal((await call('PATCH', '/api/v1/mail/folders/a', { token: t, body: { parentId: 'b' } })).status, 400, 'cycle');
  assert.equal((await call('PATCH', '/api/v1/mail/folders/a', { token: t, body: { parentId: 'a' } })).status, 400, 'self');
  assert.equal((await call('PATCH', '/api/v1/mail/folders/inbox', { token: t, body: { parentId: 'a' } })).status, 400, 'system folder');
  folderUpdates.length = 0;
  assert.equal((await call('PATCH', '/api/v1/mail/folders/b', { token: t, body: { parentId: null } })).status, 200);
  assert.equal((await call('PATCH', '/api/v1/mail/folders/b', { token: t, body: { parentId: 'a' } })).status, 200);
  assert.deepEqual(folderUpdates, [{ parentId: null }, { parentId: 'a' }]);
});

test('POST /mail/send: recipient limits + per-user rate limit', async () => {
  const t = tok('u4');
  const many = Array.from({ length: 501 }, (_, i) => `r${i}@ex.com`);
  const tooMany = await call('POST', '/api/v1/mail/send', { token: t, body: { to: many.slice(0, 300), cc: many.slice(300), subject: 's' } });
  assert.equal(tooMany.status, 400);
  assert.match(String(tooMany.json['error']), /Too many recipients/);
  const bad = await call('POST', '/api/v1/mail/send', { token: t, body: { to: ['ok@ex.com', 'x@y.z\r\nBcc: v@x.com'], subject: 's' } });
  assert.equal(bad.status, 400);
  // limit 3 per window (MAIL_SEND_RATE_LIMIT=3): the 4th request is refused before any processing
  await call('POST', '/api/v1/mail/send', { token: t, body: { to: [], subject: 's' } });
  const limited = await call('POST', '/api/v1/mail/send', { token: t, body: { to: ['a@ex.com'], subject: 's' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.json['code'], 'RATE_LIMITED');
  // other users are not affected
  assert.equal((await call('POST', '/api/v1/mail/send', { token: tok('u5'), body: { to: [], subject: 's' } })).status, 400);
});

test('GET /mail/image-proxy: authenticated and SSRF-checked', async () => {
  assert.equal((await call('GET', '/api/v1/mail/image-proxy?url=https%3A%2F%2Fexample.com%2Fa.png')).status, 401);
  const t = tok('u1');
  assert.equal((await call('GET', `/api/v1/mail/image-proxy?url=${encodeURIComponent('http://127.0.0.1:3000/api')}`, { token: t })).status, 403);
  assert.equal((await call('GET', `/api/v1/mail/image-proxy?url=${encodeURIComponent('file:///etc/passwd')}`, { token: t })).status, 400);
  assert.equal((await call('GET', '/api/v1/mail/image-proxy', { token: t })).status, 400);
});
