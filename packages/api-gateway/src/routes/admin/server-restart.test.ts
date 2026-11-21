/**
 * 10.4.2 container restart — POST/GET /api/v1/admin/servers/restart:
 *  - RBAC: ORGANIZATION_MANAGEMENT + SERVER_MANAGEMENT only; VIEW_ONLY_ORG /
 *    HELP_DESK / USER → 403; a scoped admin → 403; admin MFA enforced
 *  - the audit row `server.restart` is written BEFORE the 202; no audit row → 503, no trigger
 *  - the trigger runs only after the response was sent, after the delay
 *  - cooldown: second request → 429 + Retry-After; gateway outside supervisord → 409
 *  - lib: token line, availability from the supervisord env, cooldown (Redis + fallback)
 * Run: node --import tsx --test --test-force-exit src/routes/admin/server-restart.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let requireMfa = false;
installFakePrisma({
  user: {
    findUnique: (a) => {
      const id = String((a as { where: Row }).where['id']);
      return id.startsWith('actor-') ? { id, role: id.slice(6).replace(/-scoped$/, ''), active: true } : null;
    },
  },
  // "actor-<ROLE>-scoped" admins have a domain scope row
  adminScope: {
    findMany: (a) => String((a as { where: Row }).where['userId']).endsWith('-scoped')
      ? [{ domain: { id: 'd1', name: 'ex.com' } }] : [],
  },
  serverSettings: { findUnique: () => ({ id: 'singleton', requireMfaForAdmins: requireMfa }) },
  userMfa: {
    findFirst: () => ({ totpEnabled: true, webAuthnCredentials: [] }),
    findUnique: () => ({ totpEnabled: true, webAuthnCredentials: [] }), // 10.6: the policy model reads findUnique
  },
  auditLog: { create: () => ({}) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const storageAuth = await import('@coremail/storage/auth');
const { adminServersRouter, setServerRestartDeps } = await import('./servers.js');
const lib = await import('../../lib/server-restart.js');

const tok = (role: string, actor = role, mfaVerified = true) => core.signAccessToken({
  sub: `actor-${actor}`, email: `${role}@ex.com`, role: role as Parameters<typeof core.signAccessToken>[0]['role'],
  domainId: 'd1', sessionId: 's', mfaVerified,
});

// ── injected restart dependencies ──
const events: string[] = [];
let audits: Row[] = [];
let auditFails = false;
let slotTaken = false;
let available = true;
let sentAt = 0;
let triggeredAt = 0;

beforeEach(() => {
  events.length = 0; audits = []; auditFails = false; slotTaken = false; available = true;
  sentAt = 0; triggeredAt = 0; requireMfa = false;
  storageAuth.invalidateMfaEnforcementCache(); // 10.6: the MFA policy is cached 15 s
  setServerRestartDeps({
    availability: () => (available ? { available: true } : { available: false, reason: 'not-supervised' }),
    claim: async () => { events.push('claim'); if (slotTaken) return { ok: false, retryAfterSec: 77 }; slotTaken = true; return { ok: true }; },
    release: async () => { events.push('release'); slotTaken = false; },
    writeAudit: async (e) => {
      events.push('audit');
      await new Promise((r) => setTimeout(r, 20)); // a slow DB write must still finish first
      if (auditFails) throw new Error('db down');
      audits.push(e as unknown as Row);
    },
    trigger: () => { events.push('trigger'); triggeredAt = Date.now(); },
    delayMs: 50,
    schedule: (fn, ms) => { events.push(`schedule:${ms}`); setTimeout(fn, ms); },
  });
});

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.once('finish', () => { sentAt = Date.now(); events.push('sent'); }); next(); });
  app.use('/api/v1/admin/servers', adminServersRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { setServerRestartDeps(); server?.close(); });

async function call(method: string, role: string, opts: { actor?: string; mfaVerified?: boolean } = {}) {
  const r = await fetch(`${base}/api/v1/admin/servers/restart`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(role, opts.actor ?? role, opts.mfaVerified ?? true)}` },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* not JSON */ }
  return { status: r.status, json, headers: r.headers };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('ORGANIZATION_MANAGEMENT: 202, audit row written before the response, trigger after it', async () => {
  const r = await call('POST', 'ORGANIZATION_MANAGEMENT');
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { restarting: true, expectedDowntimeSeconds: lib.EXPECTED_DOWNTIME_SECONDS });
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!['action'], 'server.restart');
  assert.equal(audits[0]!['actorEmail'], 'ORGANIZATION_MANAGEMENT@ex.com');
  assert.ok(!events.includes('trigger'), 'not triggered while the response is in flight');
  await wait(150);
  assert.deepEqual(events.filter((e) => e !== 'release'), ['claim', 'audit', 'sent', 'schedule:50', 'trigger']);
  assert.ok(triggeredAt - sentAt >= 45, 'trigger waits for the delay after the response');
});

test('SERVER_MANAGEMENT may restart', async () => {
  assert.equal((await call('POST', 'SERVER_MANAGEMENT')).status, 202);
  await wait(100);
  assert.ok(events.includes('trigger'));
});

for (const role of ['VIEW_ONLY_ORG', 'HELP_DESK', 'RECIPIENT_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'USER']) {
  test(`${role}: 403, nothing claimed, audited or triggered`, async () => {
    const r = await call('POST', role);
    assert.equal(r.status, 403);
    await wait(80);
    assert.deepEqual(events.filter((e) => e !== 'sent'), []);
  });
}

test('scoped admin (domain scope): 403', async () => {
  const r = await call('POST', 'VIEW_ONLY_ORG', { actor: 'VIEW_ONLY_ORG-scoped' });
  assert.equal(r.status, 403);
  // a scope row on a SERVER_MANAGEMENT account (not assignable, defence in depth) is refused too
  const s = await call('POST', 'SERVER_MANAGEMENT', { actor: 'SERVER_MANAGEMENT-scoped' });
  assert.equal(s.status, 403);
  await wait(80);
  assert.ok(!events.includes('trigger'));
});

test('requireMfaForAdmins: a session without MFA → 403 MFA_NOT_VERIFIED', async () => {
  requireMfa = true;
  storageAuth.invalidateMfaEnforcementCache();
  const r = await call('POST', 'ORGANIZATION_MANAGEMENT', { mfaVerified: false });
  assert.equal(r.status, 403);
  assert.equal(r.json['code'], 'MFA_NOT_VERIFIED');
  await wait(80);
  assert.ok(!events.includes('trigger'));
});

test('cooldown: a second request → 429 with Retry-After, no second audit or trigger', async () => {
  assert.equal((await call('POST', 'ORGANIZATION_MANAGEMENT')).status, 202);
  const r = await call('POST', 'SERVER_MANAGEMENT');
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '77');
  assert.equal(r.json['code'], 'RATE_LIMITED');
  await wait(120);
  assert.equal(audits.length, 1);
  assert.equal(events.filter((e) => e === 'trigger').length, 1);
});

test('audit write fails → 503, slot released, nothing triggered', async () => {
  auditFails = true;
  const r = await call('POST', 'ORGANIZATION_MANAGEMENT');
  assert.equal(r.status, 503);
  assert.equal(r.json['code'], 'AUDIT_UNAVAILABLE');
  await wait(120);
  assert.ok(events.includes('release'));
  assert.ok(!events.includes('trigger'));
});

test('gateway outside the container (no supervisord) → 409, GET reports it', async () => {
  available = false;
  const r = await call('POST', 'ORGANIZATION_MANAGEMENT');
  assert.equal(r.status, 409);
  assert.equal(r.json['code'], 'RESTART_UNAVAILABLE');
  const g = await call('GET', 'VIEW_ONLY_ORG');
  assert.equal(g.status, 200);
  assert.equal(g.json['available'], false);
  assert.equal(g.json['expectedDowntimeSeconds'], lib.EXPECTED_DOWNTIME_SECONDS);
  await wait(80);
  assert.ok(!events.includes('claim') && !events.includes('trigger'));
});

test('GET /restart: readable for VIEW_ONLY_ORG, not for USER', async () => {
  assert.equal((await call('GET', 'VIEW_ONLY_ORG')).json['available'], true);
  assert.equal((await call('GET', 'USER')).status, 403);
});

// ── lib ──

test('lib: the request file carries the per-boot secret from restart-watch, nothing else', () => {
  const secret = 'ab'.repeat(32);
  const files = new Map<string, string>([['/run/sv/restart.token', `${secret}\n`]]);
  const fs = { readFile: (p: string) => { const v = files.get(p); if (v === undefined) throw new Error('ENOENT'); return v; }, writeFile: (p: string, d: string) => { files.set(p, d); } };
  lib.writeRestartRequest(fs, { COREMAIL_RESTART_DIR: '/run/sv' });
  assert.equal(files.get('/run/sv/restart.request'), `${secret}\n`);
  // missing / malformed secret → throws, no request written
  files.clear();
  assert.throws(() => lib.writeRestartRequest(fs, { COREMAIL_RESTART_DIR: '/run/sv' }));
  files.set('/run/sv/restart.token', 'coremail:restart-container');
  assert.throws(() => lib.writeRestartRequest(fs, { COREMAIL_RESTART_DIR: '/run/sv' }), /malformed/);
  assert.equal(files.has('/run/sv/restart.request'), false);
});

test('lib: no stdout channel — restarting never writes supervisor capture markers', async () => {
  const src = await import('node:fs').then((f) => f.readFileSync(new URL('../../lib/server-restart.ts', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /process\.stdout\.write/);
  const conf = await import('node:fs').then((f) => f.readFileSync(new URL('../../../../../infra/docker/supervisord-app.conf', import.meta.url), 'utf8'));
  assert.doesNotMatch(conf, /^\s*std(out|err)_capture_maxbytes\s*=/m, 'no program may run in capture mode');
  assert.match(conf, /^events=TICK_5\s*$/m);
});

test('lib: available only as supervisord program api-gateway with the listener secret present', () => {
  const env = { SUPERVISOR_ENABLED: '1', SUPERVISOR_PROCESS_NAME: 'api-gateway' };
  assert.deepEqual(lib.restartAvailability(env, () => true), { available: true });
  assert.deepEqual(lib.restartAvailability(env, () => false), { available: false, reason: 'no-listener' });
  assert.equal(lib.restartAvailability({ SUPERVISOR_ENABLED: '1', SUPERVISOR_PROCESS_NAME: 'smtp-server' }, () => true).available, false);
  assert.equal(lib.restartAvailability({}, () => true).available, false);
});

test('lib: cooldown via Redis SET NX EX; refusal carries the TTL; release deletes the key', async () => {
  const kv = new Map<string, string>();
  const calls: unknown[][] = [];
  const redis = {
    async set(...a: unknown[]) { calls.push(a); const k = String(a[0]); if (kv.has(k)) return null; kv.set(k, String(a[1])); return 'OK'; },
    async ttl() { return 42; },
    async del(k: string) { kv.delete(k); return 1; },
  };
  const c = lib.createRestartCooldown({ seconds: 120, redis: () => redis });
  assert.deepEqual(await c.claim(), { ok: true });
  assert.deepEqual(calls[0]!.slice(2), ['EX', 120, 'NX']);
  // another gateway instance (fresh in-process state) sees the Redis key
  const other = lib.createRestartCooldown({ seconds: 120, redis: () => redis });
  assert.deepEqual(await other.claim(), { ok: false, retryAfterSec: 42 });
  await c.release();
  assert.deepEqual(await other.claim(), { ok: true });
});

test('lib: Redis down → in-process cooldown, never unlimited', async () => {
  let t = 1_000_000;
  const broken = { async set(): Promise<unknown> { throw new Error('down'); }, async ttl() { return -2; }, async del() { throw new Error('down'); } };
  const c = lib.createRestartCooldown({ seconds: 120, redis: () => broken, now: () => t });
  assert.deepEqual(await c.claim(), { ok: true });
  t += 60_000;
  assert.deepEqual(await c.claim(), { ok: false, retryAfterSec: 60 });
  t += 61_000;
  assert.deepEqual(await c.claim(), { ok: true });
});
