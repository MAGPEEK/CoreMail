/**
 * 8.0.0 review: the WebSocket Origin check must not be lifted by an (empty or
 * dummy) `?access_token=` while the handshake authenticates with an ambient
 * Authorization header (Basic credentials cached by the browser).
 * Loopback HTTP server, fake Prisma, no Redis.
 * Run: node --import tsx --import ./src/test-env.ts --test src/push/ws-origin.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

process.env['LOG_LEVEL'] ??= 'error';

const user = {
  id: 'u1', email: 'bob@example.com', displayName: 'b', domainId: 'd1', role: 'USER', active: true,
  passwordHash: 'hash:secret', authSource: 'LOCAL', mailbox: null, mfa: null,
};
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: { findFirst: async () => user },
  appPassword: { findMany: async () => [], update: async () => ({}) },
  domain: { findFirst: async () => ({ name: 'example.com' }) },
  serverSettings: { findUnique: async () => ({ jmapEnabled: true }) },
  mailbox: { findFirst: async () => null },
  sharedMailboxPerm: { findMany: async () => [] },
  mailboxDelegate: { findMany: async () => [] },
};
(globalThis as Record<string, unknown>)['__authRedis'] = {
  async get() { return null; },
  async setex() { return 'OK'; },
};

const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
  limits: { accountMaxFailures: 1000, ipMaxFailures: 1000 },
});
const { WebSocket } = await import('ws');
const { attachWebSocket } = await import('./websocket.js');

const server = http.createServer((_q, s) => { s.statusCode = 404; s.end(); });
attachWebSocket(server, async () => ['https://mail.example.com']);
server.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = (server.address() as AddressInfo).port;
after(() => { server.closeAllConnections(); server.close(); });

const basic = 'Basic ' + Buffer.from('bob@example.com:secret').toString('base64');
const jwt = core.signAccessToken({
  sub: 'u1', email: 'bob@example.com', role: 'USER', domainId: 'd1', sessionId: 's1', mfaVerified: false,
});

async function handshake(query: string, headers: Record<string, string>): Promise<string> {
  return new Promise<string>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/jmap/ws${query}`, 'jmap', { headers });
    ws.once('open', () => { ws.close(); resolve('OPEN'); });
    ws.once('unexpected-response', (_r, res) => { resolve(`HTTP ${res.statusCode}`); res.resume(); });
    ws.once('error', (e: Error) => resolve(`error ${e.message}`));
  });
}

const evil = 'https://evil.example';

test('foreign Origin + Basic header, no token → 403', async () => {
  assert.equal(await handshake('', { authorization: basic, origin: evil }), 'HTTP 403');
});

test('foreign Origin + Basic header + empty ?access_token= → 403 (was: authenticated)', async () => {
  assert.equal(await handshake('?access_token=', { authorization: basic, origin: evil }), 'HTTP 403');
  assert.equal(await handshake('?token=', { authorization: basic, origin: evil }), 'HTTP 403');
});

test('foreign Origin + Basic header + dummy ?access_token=x → 403 (was: authenticated)', async () => {
  assert.equal(await handshake('?access_token=x', { authorization: basic, origin: evil }), 'HTTP 403');
});

test('foreign Origin + valid query token and no header → accepted', async () => {
  assert.equal(await handshake(`?access_token=${encodeURIComponent(jwt)}`, { origin: evil }), 'OPEN');
});

test('foreign Origin + invalid query token and no header → 401, not 403', async () => {
  assert.equal(await handshake('?access_token=garbage', { origin: evil }), 'HTTP 401');
});

test('own Origin + Basic header → accepted; no Origin (native client) + Basic → accepted', async () => {
  assert.equal(await handshake('', { authorization: basic, origin: 'https://mail.example.com' }), 'OPEN');
  assert.equal(await handshake('?access_token=', { authorization: basic }), 'OPEN');
});
