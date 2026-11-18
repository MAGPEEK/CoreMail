/**
 * 9.4: configurable API rate limit — per user for signed-in requests, per IP otherwise,
 * static assets and the live-event stream exempt, environment override.
 * Run: node --import tsx --test --test-force-exit src/lib/api-rate-limit.test.ts
 */
import { test, before, after } from 'node:test';
import type { Server } from 'node:http';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma();
const express = (await import('express')).default;
const { resolveApiRateLimit, classifyRequest, createApiRateLimit, FixedWindowCounter, API_RATE_LIMIT_DEFAULTS } = await import('./api-rate-limit.js');

const verify = (t: string) => (t.startsWith('ok-') ? t.slice(3) : null);

test('defaults sized for webmail; BCP columns apply; a set environment variable overrides (clamped)', () => {
  assert.deepEqual(resolveApiRateLimit(null, {}), { enabled: true, windowMs: 15 * 60_000, perIp: 500, perUser: 3000, envOverrides: [] });
  assert.equal(API_RATE_LIMIT_DEFAULTS.perUser, 3000);
  const row = { apiRateLimitEnabled: true, apiRateLimitWindowMin: 5, apiRateLimitPerIp: 100, apiRateLimitPerUser: 900 };
  assert.deepEqual(resolveApiRateLimit(row, {}), { enabled: true, windowMs: 5 * 60_000, perIp: 100, perUser: 900, envOverrides: [] });
  const env = resolveApiRateLimit(row, { API_RATE_LIMIT_ENABLED: 'off', API_RATE_LIMIT_PER_USER: '5', API_RATE_LIMIT_PER_IP: 'lots', API_RATE_LIMIT_WINDOW_MIN: '' });
  assert.equal(env.enabled, false);
  assert.equal(env.perUser, 10, 'clamped to the minimum');
  assert.equal(env.perIp, 100, 'invalid number ignored');
  assert.deepEqual(env.envOverrides, ['apiRateLimitEnabled', 'apiRateLimitPerUser']);
});

test('classification: static assets exempt, Bearer → user, anonymous → IP, SSE special, tickets counted', () => {
  const c = (method: string, path: string, authorization?: string) => classifyRequest({ method, path, authorization }, verify);
  assert.deepEqual(c('GET', '/assets/index-abc.js'), { kind: 'exempt' });
  assert.deepEqual(c('GET', '/bcp/assets/x.css'), { kind: 'exempt' });
  assert.deepEqual(c('GET', '/mail/inbox'), { kind: 'exempt' }, 'SPA route');
  assert.deepEqual(c('POST', '/mail/inbox'), { kind: 'ip' }, 'only reads of static paths are exempt');
  assert.deepEqual(c('GET', '/api/v1/mail/folders', 'Bearer ok-u1'), { kind: 'user', userId: 'u1' });
  assert.deepEqual(c('GET', '/api/v1/mail/folders', 'Bearer forged'), { kind: 'ip' });
  assert.deepEqual(c('POST', '/auth/login'), { kind: 'ip' });
  assert.deepEqual(c('GET', '/jmap/session'), { kind: 'ip' });
  assert.deepEqual(c('GET', '/Microsoft-Server-ActiveSync'), { kind: 'ip' });
  assert.deepEqual(c('GET', '/api/v1/events'), { kind: 'sse' });
  // review fix: tickets count per user — each stream needs one, so streams per token are bounded
  assert.deepEqual(c('POST', '/api/v1/events/ticket', 'Bearer ok-u1'), { kind: 'user', userId: 'u1' });
  assert.deepEqual(c('POST', '/api/v1/events/ticket'), { kind: 'ip' });
});

test('FixedWindowCounter: new window after reset, expired windows pruned', () => {
  const k = new FixedWindowCounter();
  assert.equal(k.hit('a', 1000, 0).count, 1);
  assert.equal(k.hit('a', 1000, 500).count, 2);
  assert.equal(k.peek('a', 999), 2);
  assert.equal(k.hit('a', 1000, 1000).count, 1, 'window rolled over');
  k.hit('b', 1000, 1000);
  k.hit('c', 1000, 2500);
  assert.equal(k.size, 1, 'a and b pruned');
});

// ── middleware on a real express app ─────────────────────────────────────────

let cfg = { enabled: true, windowMs: 60_000, perIp: 3, perUser: 5 };
let now = 0;
const limited: string[] = [];
const app = express();
app.set('trust proxy', false);
app.use(createApiRateLimit({
  config: () => cfg, verifyUser: verify, isLoopback: (req) => req.headers['x-test-loopback'] === '1',
  now: () => now, onLimited: ({ kind }) => limited.push(kind),
}));
app.get('/api/v1/events', (req, res) => { res.status(req.query['ticket'] === 'good' ? 200 : 401).end(); });
app.use((_req, res) => { res.json({ ok: true }); });
let server: Server;
let base = '';
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });

test('anonymous requests share the IP budget; signed-in users have their own; 429 with Retry-After', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await get('/api/v1/x')).status, 200);
  const r = await get('/api/v1/x');
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  assert.deepEqual(await r.json(), { error: 'Too many requests. Please try again later.' });
  // the same address, signed in: per-user budget (5)
  for (let i = 0; i < 5; i++) assert.equal((await get('/api/v1/x', { authorization: 'Bearer ok-alice' })).status, 200);
  assert.equal((await get('/api/v1/x', { authorization: 'Bearer ok-alice' })).status, 429);
  assert.equal((await get('/api/v1/x', { authorization: 'Bearer ok-bob' })).status, 200, 'another user behind the same NAT');
  // static assets and loopback never count
  assert.equal((await get('/assets/app.js')).status, 200);
  assert.equal((await get('/api/v1/x', { 'x-test-loopback': '1' })).status, 200);
  assert.deepEqual(limited, ['ip', 'user']);
  // next window
  now += 60_000;
  assert.equal((await get('/api/v1/x')).status, 200);
});

test('live-event stream: valid tickets never count, refused ones use the IP budget; disabled limit', async () => {
  now += 120_000;
  for (let i = 0; i < 10; i++) assert.equal((await get('/api/v1/events?ticket=good')).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await get('/api/v1/events?ticket=bad')).status, 401);
  assert.equal((await get('/api/v1/events?ticket=good')).status, 429, 'budget used up by refused tickets');
  assert.equal((await get('/api/v1/x')).status, 429);
  cfg = { ...cfg, enabled: false };
  assert.equal((await get('/api/v1/x')).status, 200, 'switched off in the BCP');
});

test('review fix: ticket requests use the per-user budget (streams per token are bounded)', async () => {
  cfg = { ...cfg, enabled: true };
  now += 600_000;
  const ticket = () => fetch(`${base}/api/v1/events/ticket`, { method: 'POST', headers: { authorization: 'Bearer ok-carol' } });
  for (let i = 0; i < 5; i++) assert.equal((await ticket()).status, 200);
  assert.equal((await ticket()).status, 429);
});
