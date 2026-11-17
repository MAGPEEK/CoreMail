/**
 * v7.1.0: GET /api/v1/events (SSE) is a live connection — a credential change
 * or session revocation ends the stream (same rules as JMAP Bearer push);
 * unrelated events and other users leave it open; a closed stream is
 * unregistered. requireAuth carries the token's iat + check start time.
 * 9.4: the Webmail switch — requireAuth answers 403 PROTOCOL_DISABLED on the
 * webmail API, admin accounts keep the admin surface and their stream.
 * Run: node --import tsx --test --test-force-exit src/lib/live-sse.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
const fakeDb = installFakePrisma({});

const { createSseHandler } = await import('../sse.js');
const { sseLiveConnections, registerSseConnection } = await import('./live-sse.js');
const { requireAuth } = await import('../middleware/auth.js');
const { signAccessToken } = await import('@coremail/core');
import type { Request, Response } from 'express';
import type { ApiUser } from '../middleware/auth.js';

const nowS = () => Math.floor(Date.now() / 1000);

class FakeRes {
  chunks: string[] = [];
  ended = false;
  headers: Record<string, string> = {};
  setHeader(k: string, v: string) { this.headers[k] = v; }
  flushHeaders() { /* noop */ }
  write(s: string) { if (this.ended) throw new Error('write after end'); this.chunks.push(s); return true; }
  end() { this.ended = true; }
}

function open(user: ApiUser) {
  const clients = new Set<object>();
  const handler = createSseHandler({
    start: () => undefined,
    addClient: (c) => { clients.add(c); return () => clients.delete(c); },
    register: registerSseConnection,
    heartbeatMs: 60_000,
  });
  const req = Object.assign(new EventEmitter(), { apiUser: user }) as unknown as Request;
  const res = new FakeRes();
  void handler(req, res as unknown as Response);
  return { req, res, clients };
}

const user = (id: string, sessionId: string, iat = nowS() - 10): ApiUser =>
  ({ userId: id, email: `${id}@ex.test`, role: 'USER', sessionId, issuedAt: iat, authStartedAt: Date.now() - 5 });

test('password change ("revoke all except current") ends the stream of other sessions only', () => {
  const a = open(user('u1', 's-other'));
  const b = open(user('u1', 's-current'));
  assert.equal(sseLiveConnections.count('u1'), 2);
  const n = sseLiveConnections.terminateAffected({
    userId: 'u1', reason: 'password-change', revokeBefore: { before: nowS() + 1, except: 's-current', expires: nowS() + 900 },
  });
  assert.equal(n, 1);
  assert.equal(a.res.ended, true);
  assert.ok(a.res.chunks.some((c) => c.startsWith('event: session-ended')), 'client is told why');
  assert.equal(a.clients.size, 0, 'removed from the SSE hub');
  assert.equal(b.res.ended, false);
  assert.equal(sseLiveConnections.count('u1'), 1);
  (b.req as unknown as EventEmitter).emit('close');
  assert.equal(sseLiveConnections.count('u1'), 0, 'closed streams are unregistered');
});

test('single session revocation ends exactly that session; other users untouched', () => {
  const mine = open(user('u2', 's1'));
  const other = open(user('u2', 's2'));
  const stranger = open(user('u3', 's1'));
  sseLiveConnections.terminateAffected({ userId: 'u2', reason: 'sessions-revoked', sessionIds: ['s1'] });
  assert.equal(mine.res.ended, true);
  assert.equal(other.res.ended, false);
  assert.equal(stranger.res.ended, false);
  for (const s of [other, stranger]) (s.req as unknown as EventEmitter).emit('close');
});

test('events that do not affect web sessions keep the stream (app password revoked / created)', () => {
  const s = open(user('u4', 's1'));
  sseLiveConnections.terminateAffected({ userId: 'u4', reason: 'app-password-revoked', appPasswordId: 'ap1' });
  sseLiveConnections.terminateAffected({ userId: 'u4', reason: 'app-password-created' });
  assert.equal(s.res.ended, false);
  sseLiveConnections.terminateAffected({ userId: 'u4', reason: 'deactivated' });
  assert.equal(s.res.ended, true, 'deactivation ends every stream');
});

test('role change (all sessions revoked) ends the stream', () => {
  const s = open(user('u5', 's1'));
  sseLiveConnections.terminateAffected({ userId: 'u5', reason: 'role-change', revokeBefore: { before: nowS() + 1, except: null, expires: nowS() + 900 } });
  assert.equal(s.res.ended, true);
});

test('an event between the token check and the stream registration still ends it', async () => {
  const started = Date.now() - 50;
  sseLiveConnections.terminateAffected({ userId: 'u6', reason: 'sessions-revoked', sessionIds: ['late'] });
  const s = open({ ...user('u6', 'late'), authStartedAt: started });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.res.ended, true);
  assert.equal(sseLiveConnections.count('u6'), 0);
});

test('requireAuth exposes iat and the check start for live-connection registration', async () => {
  const token = signAccessToken({ sub: 'u7', email: 'u7@ex.test', role: 'USER', domainId: 'd1', sessionId: 'sess-7' } as Parameters<typeof signAccessToken>[0]);
  const req = { get: (h: string) => (h === 'Authorization' ? `Bearer ${token}` : undefined), query: {} } as unknown as Request;
  const before = Date.now();
  await new Promise<void>((resolve) => requireAuth(req, {} as Response, () => resolve()));
  assert.equal(req.apiUser?.sessionId, 'sess-7');
  assert.equal(typeof req.apiUser?.issuedAt, 'number');
  assert.equal(typeof req.apiUser?.issuedAtMs, 'number');
  assert.ok((req.apiUser?.issuedAtMs ?? Infinity) <= before);
  assert.ok((req.apiUser?.authStartedAt ?? 0) >= before);
});

test('9.4: Webmail switched off ends the stream of a user, an admin keeps it (BCP)', () => {
  const mwa = open(user('u8', 's1'));
  const bcp = open({ ...user('u9', 's1'), role: 'SERVER_MANAGEMENT' });
  for (const userId of ['u8', 'u9']) {
    sseLiveConnections.terminateAffected({ userId, reason: 'protocol-access-change', disabledProtocols: ['webmail', 'mapi'] });
  }
  assert.equal(mwa.res.ended, true);
  assert.equal(bcp.res.ended, false);
  (bcp.req as unknown as EventEmitter).emit('close');
});

test('9.4: requireAuth applies the Webmail switch; admins keep the admin surface', async () => {
  const policies: Array<Record<string, unknown>> = [{ id: 'global', webmail: 'OFF' }];
  fakeDb.models['protocolPolicy'] = { findMany: () => policies };
  const { invalidateProtocolAccessCache } = await import('@coremail/storage');
  invalidateProtocolAccessCache();
  const call = (role: string, originalUrl: string) => new Promise<number>((resolve) => {
    const token = signAccessToken({ sub: `x-${role}`, email: 'x@ex.test', role, domainId: 'd1', sessionId: 's', mfaVerified: false } as Parameters<typeof signAccessToken>[0]);
    const req = { get: (h: string) => (h === 'Authorization' ? `Bearer ${token}` : undefined), query: {}, originalUrl } as unknown as Request;
    const res = { status: (code: number) => ({ json: () => resolve(code) }) } as unknown as Response;
    requireAuth(req, res, () => resolve(200));
  });
  try {
    assert.equal(await call('USER', '/api/v1/mail/folders'), 403);
    assert.equal(await call('USER', '/api/v1/events'), 403);
    assert.equal(await call('ORGANIZATION_MANAGEMENT', '/api/v1/mail/folders'), 403, 'no webmail API for admins either');
    assert.equal(await call('ORGANIZATION_MANAGEMENT', '/api/v1/admin/mailboxes?x=1'), 200);
    assert.equal(await call('HELP_DESK', '/api/v1/events'), 200);
    policies.length = 0;
    invalidateProtocolAccessCache();
    assert.equal(await call('USER', '/api/v1/mail/folders'), 200);
  } finally {
    delete fakeDb.models['protocolPolicy'];
    invalidateProtocolAccessCache();
  }
});
