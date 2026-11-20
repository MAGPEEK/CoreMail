/**
 * 10.5 attack protection at IMAP connect: block list entries and IPs locked by
 * the shared lockout are refused on the raw socket — plaintext listener with a
 * BYE, implicit TLS (993) before the handshake; everybody else gets the greeting.
 * Loopback sockets with an injected guard (loopback itself is never blocked).
 * Run: node --import tsx --test src/server/connect-guard.test.ts (in packages/imap-server)
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
process.env['LOG_LEVEL'] ??= 'error';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const noop = () => undefined;
const core = await import('@coremail/core');
const redisClient = core.getRedisClient();
redisClient.disconnect(); // no reconnect loop in tests
(redisClient as unknown as Record<string, unknown>)['duplicate'] = () => ({ subscribe: async () => 1, on: noop });

const { createImapServer, IMAP_BLOCKED_BYE, IMAP_LOCKED_BYE } = await import('./index.js');
const { selfSignedTestCert } = await import('../test-cert.js');
const CERT = selfSignedTestCert();

type Verdict = { blocked?: boolean; lockedSec?: number };
function guard(v: Verdict) {
  const refused: Array<{ protocol: string; reason: string }> = [];
  return {
    refused,
    guard: {
      isBlocked: () => v.blocked === true,
      lockedFor: async () => v.lockedSec ?? 0,
      refused: (_ip: unknown, protocol: string, reason: 'blocked' | 'locked') => { refused.push({ protocol, reason }); },
    },
  };
}

async function listen(t: TestContext, server: net.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

/** Connects and collects everything until the server closes or `ms` passes. */
function collect(port: number, implicit = false, ms = 1500): Promise<{ data: string; closed: boolean; secure: boolean }> {
  return new Promise((resolve) => {
    const socket = implicit ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
    let data = '';
    let secure = false;
    socket.setEncoding('utf8');
    socket.on('secureConnect', () => { secure = true; });
    socket.on('data', (c: string) => { data += c; });
    socket.on('error', () => undefined);
    const t = setTimeout(() => { socket.destroy(); resolve({ data, closed: false, secure }); }, ms);
    socket.on('close', () => { clearTimeout(t); resolve({ data, closed: true, secure }); });
  });
}

test('plaintext: a blocked IP gets BYE Access denied and the connection closes', async (t) => {
  const g = guard({ blocked: true });
  const port = await listen(t, createImapServer(undefined, { connectGuard: g.guard }));
  const r = await collect(port);
  assert.equal(r.data, IMAP_BLOCKED_BYE);
  assert.equal(r.closed, true);
  assert.deepEqual(g.refused, [{ protocol: 'imap', reason: 'blocked' }]);
});

test('plaintext: an IP locked by the shared lockout gets BYE before any greeting', async (t) => {
  const g = guard({ lockedSec: 600 });
  const port = await listen(t, createImapServer(undefined, { connectGuard: g.guard }));
  const r = await collect(port);
  assert.equal(r.data, IMAP_LOCKED_BYE);
  assert.ok(!r.data.includes('* OK'), 'no greeting');
  assert.equal(r.closed, true);
  assert.deepEqual(g.refused, [{ protocol: 'imap', reason: 'locked' }]);
});

test('plaintext: other clients get the greeting', async (t) => {
  const g = guard({});
  const port = await listen(t, createImapServer(undefined, { connectGuard: g.guard }));
  const r = await collect(port, false, 400);
  assert.match(r.data, /^\* OK \[CAPABILITY /);
  assert.deepEqual(g.refused, []);
});

test('implicit TLS (993): blocked and locked IPs are dropped on the raw socket, no handshake', async (t) => {
  for (const v of [{ blocked: true }, { lockedSec: 60 }] as Verdict[]) {
    const g = guard(v);
    const port = await listen(t, createImapServer({ cert: CERT.cert, key: CERT.key }, { connectGuard: g.guard }));
    const r = await collect(port, true);
    assert.equal(r.closed, true, JSON.stringify(v));
    assert.equal(r.data, '');
    assert.equal(g.refused.length, 1);
    if (v.blocked) assert.equal(r.secure, false, 'blocked before the TLS handshake');
  }
  const ok = guard({});
  const port = await listen(t, createImapServer({ cert: CERT.cert, key: CERT.key }, { connectGuard: ok.guard }));
  const r = await collect(port, true, 800);
  assert.equal(r.secure, true);
  assert.match(r.data, /^\* OK /);
});
