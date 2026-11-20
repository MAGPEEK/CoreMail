/**
 * 10.5 attack protection admin API — /api/v1/admin/security/protection:
 *  - RBAC: HYGIENE_MANAGEMENT writes, VIEW_ONLY_ORG reads only, USER / other
 *    areas 403, a domain-scoped admin 403 (organisation-wide only)
 *  - locks: list (e-mail of account locks), release + audit security.lock.release
 *  - rules: validation (CIDR, too broad, loopback, own IP needs confirmation,
 *    duplicates), create / delete + audit, reload signal
 *  - settings: read with the effective recipient, validated update + audit
 * Run: node --import tsx --test --test-force-exit src/routes/admin/security-protection.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const audits: Row[] = [];
let rules: Row[] = [];
let settingsRow: Row | null = null;
installFakePrisma({
  user: {
    findUnique: (a) => {
      const id = String((a as { where: Row }).where['id']);
      return id.startsWith('actor-') ? { id, role: id.slice(6).replace(/-scoped$/, ''), active: true } : null;
    },
    findMany: () => [{ email: 'boss@ex.com' }],
  },
  adminScope: {
    findMany: (a) => String((a as { where: Row }).where['userId']).endsWith('-scoped')
      ? [{ domain: { id: 'd1', name: 'ex.com' } }] : [],
  },
  serverSettings: { findUnique: () => ({ id: 'singleton', requireMfaForAdmins: false, adminEmail: '' }) },
  auditLog: { create: (a) => { audits.push((a as { data: Row }).data); return {}; } },
  ipAccessRule: {
    findMany: () => rules,
    count: (a) => rules.filter((r) => r['kind'] === (a as { where: Row }).where['kind']).length,
    findUnique: (a) => {
      const w = (a as { where: Row }).where;
      if (w['id']) return rules.find((r) => r['id'] === w['id']) ?? null;
      const kc = w['kind_cidr'] as Row;
      return rules.find((r) => r['kind'] === kc['kind'] && r['cidr'] === kc['cidr']) ?? null;
    },
    create: (a) => {
      const row = { id: `c${String(rules.length + 1).padStart(24, '0')}`, createdAt: new Date(), ...(a as { data: Row }).data };
      rules.push(row);
      return row;
    },
    delete: (a) => { const id = (a as { where: Row }).where['id']; rules = rules.filter((r) => r['id'] !== id); return {}; },
  },
  attackProtectionSettings: {
    findUnique: () => settingsRow,
    upsert: (a) => { const x = a as { create: Row; update: Row }; settingsRow = { ...(settingsRow ?? x.create), ...x.update }; return settingsRow; },
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const storage = await import('@coremail/storage');
const { adminSecurityProtectionRouter, setProtectionRedisForTests } = await import('./security-protection.js');

const tok = (role: string, actor = role) => core.signAccessToken({
  sub: `actor-${actor}`, email: `${role}@ex.com`, role: role as Parameters<typeof core.signAccessToken>[0]['role'],
  domainId: 'd1', sessionId: 's', mfaVerified: true,
});

/** In-memory Redis with the commands of the lockout and the lock view. */
function memRedis() {
  const kv = new Map<string, { v: string; exp: number | null }>();
  const live = (k: string) => { const e = kv.get(k); if (e && e.exp !== null && e.exp <= Date.now()) { kv.delete(k); return undefined; } return e; };
  return {
    kv,
    async get(k: string) { return live(k)?.v ?? null; },
    async set(k: string, v: string, _m: 'EX', sec: number) { kv.set(k, { v, exp: Date.now() + sec * 1000 }); return 'OK'; },
    async ttl(k: string) { const e = live(k); if (!e) return -2; return e.exp === null ? -1 : Math.ceil((e.exp - Date.now()) / 1000); },
    async del(...ks: string[]) { let n = 0; for (const k of ks) if (kv.delete(k)) n++; return n; },
    async incr(k: string) { const e = live(k); const n = (e ? Number(e.v) : 0) + 1; kv.set(k, { v: String(n), exp: e?.exp ?? null }); return n; },
    async expire(k: string, sec: number) { const e = live(k); if (e) e.exp = Date.now() + sec * 1000; return e ? 1 : 0; },
    async scan(_c: string, _m: 'MATCH', pattern: string) {
      const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return ['0', [...kv.keys()].filter((k) => live(k) && re.test(k))] as [string, string[]];
    },
  };
}
let redis = memRedis();

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.set('trust proxy', true); // the tests choose the caller IP via X-Forwarded-For
  app.use(express.json());
  app.use('/api/v1/admin/security/protection', adminSecurityProtectionRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/admin/security/protection`;
});
after(() => { setProtectionRedisForTests(null); server?.close(); });
beforeEach(() => { audits.length = 0; rules = []; settingsRow = null; redis = memRedis(); setProtectionRedisForTests(redis as never); });

async function call(method: string, path: string, role: string, body?: unknown, opts: { actor?: string; ip?: string } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${tok(role, opts.actor ?? role)}`,
      'x-forwarded-for': opts.ip ?? '198.51.100.50',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* empty */ }
  return { status: r.status, json };
}

/** Locks an account and an IP through the real lockout core on the in-memory Redis. */
async function lockSomething() {
  const lockout = storage.createLoginLockout({ redis: redis as never, limits: { accountMaxFailures: 2, ipMaxFailures: 2 }, protocol: 'imap' });
  await lockout.fail('alice@ex.com', '192.0.2.10');
  await lockout.fail('alice@ex.com', '192.0.2.10');
}

// ── RBAC ────────────────────────────────────────────────────────────────────

test('RBAC: USER and other admin areas 403; VIEW_ONLY_ORG reads but cannot write; scoped admins 403', async () => {
  for (const role of ['USER', 'HELP_DESK', 'RECIPIENT_MANAGEMENT', 'COMPLIANCE_MANAGEMENT']) {
    assert.equal((await call('GET', '/rules', role)).status, 403, role);
  }
  assert.equal((await call('GET', '/rules', 'VIEW_ONLY_ORG')).status, 200);
  assert.equal((await call('GET', '/locks', 'VIEW_ONLY_ORG')).status, 200);
  assert.equal((await call('POST', '/rules', 'VIEW_ONLY_ORG', { kind: 'BLOCK', cidr: '203.0.113.9' })).status, 403);
  assert.equal((await call('POST', '/locks/release', 'VIEW_ONLY_ORG', { scope: 'ip', id: '192.0.2.10' })).status, 403);
  assert.equal((await call('PUT', '/settings', 'VIEW_ONLY_ORG', { notifyEnabled: false })).status, 403);
  assert.equal((await call('GET', '/rules', 'HYGIENE_MANAGEMENT', undefined, { actor: 'HYGIENE_MANAGEMENT-scoped' })).status, 403);
  assert.equal((await call('POST', '/rules', 'ORGANIZATION_MANAGEMENT', { kind: 'BLOCK', cidr: '203.0.113.9' })).status, 201);
  assert.equal(rules.length, 1);
});

// ── Locks ───────────────────────────────────────────────────────────────────

test('locks: account locks are listed with the e-mail; release removes them and is audited', async () => {
  await lockSomething();
  const list = await call('GET', '/locks', 'HYGIENE_MANAGEMENT');
  assert.equal(list.status, 200);
  const ips = list.json['ips'] as Row[];
  const accounts = list.json['accounts'] as Row[];
  assert.equal(ips.length, 1);
  assert.equal(ips[0]!['id'], '192.0.2.10');
  assert.equal(ips[0]!['protocol'], 'imap');
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]!['account'], 'alice@ex.com');
  assert.ok(Number(accounts[0]!['remainingSec']) > 0);

  const rel = await call('POST', '/locks/release', 'HYGIENE_MANAGEMENT', { scope: 'account', id: accounts[0]!['id'], resetStrikes: true });
  assert.equal(rel.status, 200);
  assert.equal(rel.json['released'], true);
  await new Promise((r) => setTimeout(r, 30));
  const a = audits.find((x) => x['action'] === 'security.lock.release');
  assert.ok(a, JSON.stringify(audits));
  assert.equal(a['targetName'], 'alice@ex.com');
  assert.equal(a['actorEmail'], 'HYGIENE_MANAGEMENT@ex.com');
  assert.equal(((await call('GET', '/locks', 'HYGIENE_MANAGEMENT')).json['accounts'] as Row[]).length, 0);

  // release by IP; invalid ids are refused
  assert.equal((await call('POST', '/locks/release', 'HYGIENE_MANAGEMENT', { scope: 'ip', id: '192.0.2.10' })).json['released'], true);
  assert.equal((await call('POST', '/locks/release', 'HYGIENE_MANAGEMENT', { scope: 'ip', id: 'mailauth:*' })).status, 400);
  assert.equal((await call('POST', '/locks/release', 'HYGIENE_MANAGEMENT', { scope: 'nope', id: 'x' })).status, 400);
});

test('locks: Redis down → 503', async () => {
  setProtectionRedisForTests({ scan: async () => { throw new Error('down'); } } as never);
  assert.equal((await call('GET', '/locks', 'HYGIENE_MANAGEMENT')).status, 503);
});

// ── Rules ───────────────────────────────────────────────────────────────────

test('rules: validation — invalid, too broad, loopback, duplicates, note length', async () => {
  const post = (b: Row) => call('POST', '/rules', 'HYGIENE_MANAGEMENT', b);
  assert.equal((await post({ kind: 'BLOCK', cidr: 'not an ip' })).json['code'], 'INVALID_CIDR');
  assert.equal((await post({ kind: 'BLOCK', cidr: '0.0.0.0/0' })).json['code'], 'TOO_BROAD');
  assert.equal((await post({ kind: 'BLOCK', cidr: '10.0.0.0/7' })).json['code'], 'TOO_BROAD');
  assert.equal((await post({ kind: 'ALLOW', cidr: '::/0' })).json['code'], 'TOO_BROAD');
  assert.equal((await post({ kind: 'BLOCK', cidr: '2001:db8::/15' })).json['code'], 'TOO_BROAD');
  assert.equal((await post({ kind: 'BLOCK', cidr: '127.0.0.0/8' })).json['code'], 'LOOPBACK');
  assert.equal((await post({ kind: 'BLOCK', cidr: '::1' })).json['code'], 'LOOPBACK');
  assert.equal((await post({ kind: 'BLOCK', cidr: '203.0.113.0/24', note: 'x'.repeat(201) })).status, 400);
  assert.equal((await post({ kind: 'MAYBE', cidr: '203.0.113.0/24' })).status, 400);
  const ok = await post({ kind: 'BLOCK', cidr: '203.0.113.77/24', note: 'Botnetz', expiresInDays: 7 });
  assert.equal(ok.status, 201);
  assert.equal(ok.json['cidr'], '203.0.113.0/24');
  assert.ok(ok.json['expiresAt']);
  assert.equal((await post({ kind: 'BLOCK', cidr: '203.0.113.0/24' })).json['code'], 'DUPLICATE');
  // the same range as an exception is a different list
  assert.equal((await post({ kind: 'ALLOW', cidr: '203.0.113.0/24' })).status, 201);
});

test('rules: blocking the own IP needs an explicit confirmation', async () => {
  const r = await call('POST', '/rules', 'HYGIENE_MANAGEMENT', { kind: 'BLOCK', cidr: '198.51.100.0/24' }, { ip: '198.51.100.50' });
  assert.equal(r.status, 409);
  assert.equal(r.json['code'], 'BLOCKS_OWN_IP');
  assert.equal(r.json['callerIp'], '198.51.100.50');
  assert.equal(rules.length, 0);
  const c = await call('POST', '/rules', 'HYGIENE_MANAGEMENT', { kind: 'BLOCK', cidr: '198.51.100.0/24', confirmOwnIp: true }, { ip: '198.51.100.50' });
  assert.equal(c.status, 201);
  // an exception for the own IP needs no confirmation
  assert.equal((await call('POST', '/rules', 'HYGIENE_MANAGEMENT', { kind: 'ALLOW', cidr: '198.51.100.50' }, { ip: '198.51.100.50' })).status, 201);
});

test('rules: list shows both lists and the caller IP; create and delete are audited', async () => {
  const created = await call('POST', '/rules', 'HYGIENE_MANAGEMENT', { kind: 'BLOCK', cidr: '2001:db8:bad::/48', note: 'scanner' });
  assert.equal(created.status, 201);
  const list = await call('GET', '/rules', 'HYGIENE_MANAGEMENT', undefined, { ip: '203.0.113.5' });
  assert.equal((list.json['block'] as Row[])[0]!['cidr'], '2001:db8:bad::/48');
  assert.deepEqual(list.json['allow'], []);
  assert.equal(list.json['callerIp'], '203.0.113.5');
  assert.equal(list.json['maxEntries'], storage.MAX_IP_RULES_PER_KIND);
  const del = await call('DELETE', `/rules/${String(created.json['id'])}`, 'HYGIENE_MANAGEMENT');
  assert.equal(del.status, 204);
  assert.equal(rules.length, 0);
  assert.equal((await call('DELETE', `/rules/${String(created.json['id'])}`, 'HYGIENE_MANAGEMENT')).status, 404);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(audits.map((a) => a['action']).filter((a) => String(a).startsWith('security.')), ['security.ip-rule.create', 'security.ip-rule.delete']);
  assert.equal(audits[0]!['targetName'], 'BLOCK 2001:db8:bad::/48');
});

test('rules: deleting an automatic entry resets the repeat-offender counter of the IP', async () => {
  rules.push({ id: 'cauto000000000000000000001', kind: 'BLOCK', cidr: '192.0.2.44/32', note: storage.AUTO_BLOCK_NOTE, auto: true, expiresAt: null, createdBy: null, createdAt: new Date() });
  await redis.set(storage.LOCKOUT_KEYS.locks('192.0.2.44'), '3', 'EX', 3600);
  assert.equal((await call('DELETE', '/rules/cauto000000000000000000001', 'HYGIENE_MANAGEMENT')).status, 204);
  assert.equal(await redis.get(storage.LOCKOUT_KEYS.locks('192.0.2.44')), null);
});

// ── Settings ────────────────────────────────────────────────────────────────

test('settings: defaults with the effective recipient; validated update is audited', async () => {
  const g = await call('GET', '/settings', 'VIEW_ONLY_ORG');
  assert.equal(g.status, 200);
  assert.equal(g.json['notifyEnabled'], true);
  assert.equal(g.json['autoBlockThreshold'], 3);
  assert.deepEqual(g.json['effectiveRecipients'], ['boss@ex.com'], 'no adminEmail → the Organization Management admins');
  assert.equal((await call('PUT', '/settings', 'HYGIENE_MANAGEMENT', { autoBlockThreshold: 1 })).status, 400);
  assert.equal((await call('PUT', '/settings', 'HYGIENE_MANAGEMENT', { notifyRecipient: 'not-an-email' })).status, 400);
  assert.equal((await call('PUT', '/settings', 'HYGIENE_MANAGEMENT', { unknown: true })).status, 400);
  const p = await call('PUT', '/settings', 'HYGIENE_MANAGEMENT', { notifyRecipient: 'sec@ex.com', autoBlockDays: 0, autoBlockEnabled: false });
  assert.equal(p.status, 200);
  assert.equal(p.json['notifyRecipient'], 'sec@ex.com');
  assert.equal(p.json['autoBlockDays'], 0);
  assert.equal(p.json['autoBlockEnabled'], false);
  assert.deepEqual(p.json['effectiveRecipients'], ['sec@ex.com']);
  await new Promise((r) => setTimeout(r, 30));
  const a = audits.find((x) => x['action'] === 'security.protection.settings.update');
  assert.ok(a);
  assert.equal(((a['changes'] as Row)['after'] as Row)['autoBlockEnabled'], false);
});
