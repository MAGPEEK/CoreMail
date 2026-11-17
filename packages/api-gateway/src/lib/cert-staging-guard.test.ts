/**
 * 9.2.x review fixes for Let's Encrypt certificates:
 *  1. staging never replaces a trusted certificate — no auto-activation / protocol
 *     re-apply, claimServices keeps services on trusted certs, PUT acmeStaging:true
 *     is refused (409) once a trusted PEM was issued;
 *  2. a renew lock whose holder died (no heartbeat) does not block "Retry"; a live
 *     holder gives a "noch gesperrt bis HH:MM" 409; delayed stale repair after the TTL;
 *  3. the public pre-flight fetch never touches private / internal addresses, goes to
 *     the vetted IP with the Host header and never echoes the Location header;
 * 12. the pre-flight ACME account key is stored encrypted in Redis.
 * No network (fake CA / resolver / serving, in-memory Prisma + Redis).
 * Run: node --import tsx --test --test-force-exit src/lib/cert-staging-guard.test.ts  (in packages/api-gateway)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';
import { makeFakeCa, makeFakeServing } from '../test-support/fake-acme.js';
import type { AcmeClientLike, HttpTextResult } from './acme-flow.js';

setTestEnv();

type Row = Record<string, unknown>;
const certs = new Map<string, Row>();
const settingsUpserts: Row[] = [];

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const cond = v as { in?: unknown[]; not?: unknown };
      if (cond.in && !cond.in.includes(row[k])) return false;
      if ('not' in cond && row[k] === cond.not) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

installFakePrisma({
  user: { findUnique: () => ({ role: 'ORGANIZATION_MANAGEMENT', active: true }) },
  certificate: {
    findUnique: (a) => {
      const { where, select } = a as { where: { id: string }; select?: Row };
      return applySelect(certs.get(where.id) ?? null, select);
    },
    findMany: (a) => {
      const { where, select } = (a ?? {}) as { where?: Row; select?: Row };
      return [...certs.values()].filter(r => matches(r, where)).map(r => applySelect(r, select));
    },
    update: (a) => {
      const { where, data, select } = a as { where: { id: string }; data: Row; select?: Row };
      const row = certs.get(where.id);
      if (!row) throw new Error('Record to update not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return applySelect(row, select);
    },
    updateMany: (a) => {
      const { where, data } = a as { where?: Row; data: Row };
      let count = 0;
      for (const r of certs.values()) if (matches(r, where)) { Object.assign(r, data, { updatedAt: new Date() }); count++; }
      return { count };
    },
  },
  serverSettings: {
    findUnique: () => ({ publicHostname: 'mail.example.com' }),
    upsert: (a) => { settingsUpserts.push(a as Row); return {}; },
  },
});

/** In-memory Redis: SET [NX] PX/EX, GET, DEL, EXISTS, SETEX, PTTL, compare-and-delete EVAL, PUBLISH. */
const redisStore = new Map<string, string>();
const pttls = new Map<string, number>();
const fakeRedis = {
  async set(k: string, v: string, _mode: string, _ttl: number, nx?: string) {
    if (nx === 'NX' && redisStore.has(k)) return null;
    redisStore.set(k, v); return 'OK';
  },
  async get(k: string) { return redisStore.get(k) ?? null; },
  async setex(k: string, _s: number, v: string) { redisStore.set(k, v); return 'OK'; },
  async del(k: string) { return redisStore.delete(k) ? 1 : 0; },
  async exists(k: string) { return redisStore.has(k) ? 1 : 0; },
  async pttl(k: string) { return redisStore.has(k) ? (pttls.get(k) ?? 300_000) : -2; },
  async eval(_s: string, _n: number, key: string, token: string) {
    if (redisStore.get(key) === token) { redisStore.delete(key); return 1; }
    return 0;
  },
  async publish() { return 1; },
};
(globalThis as Record<string, unknown>)['__certRenewRedis'] = fakeRedis;
(globalThis as Record<string, unknown>)['__certAcmeRedis'] = fakeRedis;

const servingFake = makeFakeServing({ public: 'refused' });
(globalThis as Record<string, unknown>)['__acmeChallengeServing'] = servingFake.serving;
const accountKeys: string[] = [];
(globalThis as Record<string, unknown>)['__acmeClientFactory'] = (_dir: string, key: string): AcmeClientLike => {
  accountKeys.push(key);
  return makeFakeCa({ served: servingFake.served }).client;
};
const noData = () => Promise.reject(Object.assign(new Error('no data'), { code: 'ENODATA' }));
(globalThis as Record<string, unknown>)['__acmeResolver'] = {
  resolve4: () => Promise.resolve(['93.184.216.34']), resolve6: noData, resolveCaa: noData,
};

const renewal = await import('./cert-renewal.js');
const acme = await import('./cert-acme.js');
const { runPreflight } = await import('./acme-preflight.js');
const sauth = await import('@coremail/storage/auth');

function addCert(id: string, over: Row = {}): Row {
  const row: Row = {
    id, name: id, type: 'LETSENCRYPT', status: 'PENDING', domains: ['mail.example.com'], services: [],
    acmeEmail: 'admin@example.com', autoRenew: true, acmeStaging: false, certPem: null, keyPem: null,
    chainPem: null, acmeAccount: null, isActiveProtocol: false, isActiveHttps: false,
    lastError: null, lastErrorCode: null, updatedAt: new Date(), createdAt: new Date(), ...over,
  };
  certs.set(id, row);
  return row;
}
async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}
const settled = (id: string) => () => !['PENDING', 'RENEWING'].includes(String(certs.get(id)?.['status'])) && !redisStore.has(`cert:renew:lock:${id}`);

// ── HTTP harness for the admin router ────────────────────────────────────────
const express = (await import('express')).default;
const core = await import('@coremail/core');
const { requireAuth } = await import('../middleware/auth.js');
const { adminCertificatesRouter, claimServices } = await import('../routes/admin/certificates.js');
const tok = core.signAccessToken({ sub: 'admin', email: 'admin@example.com', role: 'ORGANIZATION_MANAGEMENT', domainId: 'd1', sessionId: 's', mfaVerified: true });
let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/certificates', requireAuth, adminCertificatesRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(() => { certs.clear(); settingsUpserts.length = 0; accountKeys.length = 0; });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const r = await fetch(`${base}/api/v1/admin/certificates${path}`, {
    method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: Row = {};
  try { json = JSON.parse(text) as Row; } catch { /* empty */ }
  return { status: r.status, json };
}

// ── 1. staging never replaces a trusted certificate ─────────────────────────

test('production first issuance with SMTP activates protocol TLS; a staging renewal of the active cert does not re-apply it', async () => {
  const prod = addCert('p1', { services: ['SMTP'] });
  await renewal.startRenewal('p1', 'issue');
  await waitFor(settled('p1'));
  assert.equal(prod['status'], 'ACTIVE', String(prod['lastError']));
  assert.equal(settingsUpserts.length, 1, 'production issuance with SMTP auto-activates');
  assert.equal(prod['isActiveProtocol'], true);

  settingsUpserts.length = 0;
  // a staging row that is (still) the active protocol cert: its run must not write ServerSettings
  const stg = addCert('s1', { services: ['SMTP'], acmeStaging: true, isActiveProtocol: true, certPem: 'old', status: 'ACTIVE' });
  await renewal.startRenewal('s1', 'manual');
  await waitFor(settled('s1'));
  assert.equal(stg['status'], 'ACTIVE', String(stg['lastError']));
  assert.equal(settingsUpserts.length, 0, 'staging never re-applies protocol TLS');
  assert.equal(prod['isActiveProtocol'], true, 'the trusted cert stays the protocol cert');
});

test('claimServices: a staging request keeps SMTP/IMAP/POP3 on trusted certificates, a production request takes them', async () => {
  const trusted = addCert('t1', { type: 'CUSTOM', certPem: 'PEM', services: ['SMTP', 'IMAP'] });
  const oldStaging = addCert('t2', { acmeStaging: true, certPem: 'PEM', services: ['POP3'] });
  const unissued = addCert('t3', { services: ['IMAP'] });
  addCert('new-staging', { acmeStaging: true });
  await claimServices('new-staging', ['SMTP', 'IMAP', 'POP3'], { staging: true });
  assert.deepEqual(trusted['services'], ['SMTP', 'IMAP'], 'trusted cert untouched');
  assert.deepEqual(oldStaging['services'], [], 'another staging cert gives them up');
  assert.deepEqual(unissued['services'], [], 'an unissued cert gives them up');

  addCert('new-prod');
  await claimServices('new-prod', ['SMTP'], {});
  assert.deepEqual(trusted['services'], ['IMAP'], 'production request enforces exclusivity');
});

test('PUT acmeStaging:true is refused (409, German message) once a trusted PEM was issued; allowed for unissued / failed rows', async () => {
  addCert('i1', { status: 'ACTIVE', certPem: 'PEM' });
  const refused = await call('PUT', '/i1', { acmeStaging: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.json['code'], 'STAGING_NOT_ALLOWED');
  assert.match(String(refused.json['message']), /bereits produktiv/);
  assert.equal(certs.get('i1')!['acmeStaging'], false);

  addCert('i2', { status: 'ERROR', certPem: null });
  const ok = await call('PUT', '/i2', { acmeStaging: true });
  assert.equal(ok.status, 200);
  assert.equal(certs.get('i2')!['acmeStaging'], true);
  // switching back to production is always possible; a staging-issued row may stay staging
  addCert('i3', { status: 'ACTIVE', certPem: 'PEM', acmeStaging: true });
  assert.equal((await call('PUT', '/i3', { acmeStaging: true })).status, 200);
  assert.equal((await call('PUT', '/i3', { acmeStaging: false })).status, 200);

  // 9.3: PUT mail services on a staging cert is refused (409) and takes nothing from a trusted cert
  const trusted = addCert('i4', { type: 'CUSTOM', certPem: 'PEM', services: ['SMTP'] });
  addCert('i5', { acmeStaging: true });
  const stagingPut = await call('PUT', '/i5', { services: ['SMTP'] });
  assert.equal(stagingPut.status, 409);
  assert.equal(stagingPut.json['code'], 'STAGING_NO_MAIL_SERVICES');
  assert.deepEqual(trusted['services'], ['SMTP']);
});

// ── 2. dead lock holders, "locked until" ─────────────────────────────────────

test('dead renew lock (no heartbeat): not counted as held, repaired to ERROR, "Retry" takes the lock over', async () => {
  const old = new Date(Date.now() - 10 * 60_000);
  const row = addCert('d1', { status: 'RENEWING', updatedAt: old });
  redisStore.set('cert:renew:lock:d1', `deadbeef:${randomUUID()}:${Date.now() - 5 * 60_000}`);
  assert.equal(await renewal.isRenewLockHeld(fakeRedis, 'd1'), false);
  assert.equal(await renewal.repairStaleAcmeStates(new Date()), 1);
  assert.equal(row['status'], 'ERROR');
  assert.equal(row['lastErrorCode'], 'interrupted');

  const r = await renewal.startRenewal('d1', 'manual');
  assert.deepEqual(r, { started: true });
  await waitFor(settled('d1'));
  assert.equal(row['status'], 'ACTIVE', String(row['lastError']));
  assert.equal(redisStore.has('cert:renew:hb:d1'), false, 'heartbeat removed on release');
});

test('live renew lock (heartbeat present): refused with lockedUntil; the route says "noch gesperrt bis HH:MM"', async () => {
  addCert('l1', { status: 'RENEWING', certPem: 'PEM', updatedAt: new Date(Date.now() - 10 * 60_000) });
  const value = `cafebabe:${randomUUID()}:${Date.now() - 60_000}`;
  redisStore.set('cert:renew:lock:l1', value);
  redisStore.set('cert:renew:hb:l1', value);
  pttls.set('cert:renew:lock:l1', 120_000);
  try {
    assert.equal(await renewal.isRenewLockHeld(fakeRedis, 'l1'), true);
    assert.equal(await renewal.repairStaleAcmeStates(new Date()), 0, 'a live run is not repaired');
    const r = await renewal.startRenewal('l1', 'manual');
    assert.equal(r.started, false);
    assert.ok(!r.started && r.lockedUntil instanceof Date);
    const res = await call('POST', '/l1/renew');
    assert.equal(res.status, 409);
    assert.match(String(res.json['message']), /noch gesperrt bis \d{2}:\d{2}/);
    assert.ok(typeof res.json['lockedUntil'] === 'string');
    // a lock that is younger than one heartbeat period counts as alive even without heartbeat
    redisStore.delete('cert:renew:hb:l1');
    redisStore.set('cert:renew:lock:l1', `cafebabe:${randomUUID()}:${Date.now()}`);
    assert.equal(await renewal.isRenewLockHeld(fakeRedis, 'l1'), true);
  } finally {
    redisStore.delete('cert:renew:lock:l1'); redisStore.delete('cert:renew:hb:l1'); pttls.clear();
  }
});

test('delayed stale repair runs once after the lock TTL', async () => {
  const row = addCert('r1', { status: 'PENDING', updatedAt: new Date(Date.now() - 10 * 60_000) });
  redisStore.set('cert:renew:lock:r1', `deadbeef:${randomUUID()}:${Date.now() - 10 * 60_000}`);
  assert.ok(renewal.RENEW_LOCK_TTL_MS > renewal.HEARTBEAT_TTL_MS);
  renewal.scheduleStaleRepairAfterLockTtl(5);
  await waitFor(() => row['status'] === 'ERROR', 2_000);
  redisStore.delete('cert:renew:lock:r1');
});

// ── 3. pre-flight SSRF ───────────────────────────────────────────────────────

test('public check: private / internal targets are never fetched ("privat/intern, nicht geprüft")', async () => {
  for (const addrs of [['10.0.0.5'], ['127.0.0.1'], ['169.254.169.254'], ['100.64.1.1'], ['fd00::1'], ['fe80::1'], ['93.184.216.34', '192.168.1.10']]) {
    let fetched = false;
    await assert.rejects(
      acme.checkPublicChallenge('mail.example.com', '/.well-known/acme-challenge/t', {
        lookup: async () => addrs,
        httpGet: async () => { fetched = true; return { status: 200, body: '' }; },
      }),
      (err: unknown) => (err as { code?: string }).code === 'EPRIVATE' && (err as Error).message === acme.PRIVATE_TARGET_MESSAGE,
      addrs.join(','),
    );
    assert.equal(fetched, false, `no request for ${addrs.join(',')}`);
  }
});

test('public check: connects to the vetted IP with the Host header, Location is not returned', async () => {
  const calls: Array<{ url: string; host?: string | undefined }> = [];
  const serving = acme.makeChallengeServing({
    lookup: async () => ['2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34'],
    httpGet: async (url, o) => {
      calls.push({ url, ...(o?.host ? { host: o.host } : {}) });
      return { status: 302, body: '', location: 'http://169.254.169.254/latest/meta-data/' } as HttpTextResult;
    },
  });
  const res = await serving.checkPublic!('mail.example.com', 'tok');
  assert.deepEqual([...calls], [{ url: 'http://93.184.216.34/.well-known/acme-challenge/tok', host: 'mail.example.com' }]);
  assert.deepEqual(res, { status: 302, body: '' });
  assert.equal('location' in res, false);

  // IPv6-only name: bracketed literal
  calls.length = 0;
  const v6 = acme.makeChallengeServing({
    lookup: async () => ['2606:2800:220:1:248:1893:25c8:1946'],
    httpGet: async (url, o) => { calls.push({ url, ...(o?.host ? { host: o.host } : {}) }); return { status: 404, body: '' }; },
  });
  await v6.checkPublic!('mail.example.com', 'tok');
  assert.equal(calls[0]!.url, 'http://[2606:2800:220:1:248:1893:25c8:1946]/.well-known/acme-challenge/tok');
});

test('pre-flight report: a private target is a "skip" with "privat/intern", redirects show no target', async () => {
  const base = makeFakeServing();
  const report = await runPreflight(['mail.example.com'], {
    serving: { ...base.serving, checkPublic: () => Promise.reject(Object.assign(new Error(acme.PRIVATE_TARGET_MESSAGE), { code: 'EPRIVATE' })) },
  });
  const pub = report.domains[0]!.checks.find((c) => c.id === 'public')!;
  assert.equal(pub.status, 'skip');
  assert.match(pub.message, /privat\/intern, nicht geprüft/);

  const redirect = await runPreflight(['mail.example.com'], {
    serving: { ...base.serving, checkPublic: async () => ({ status: 301, body: '', location: 'http://10.0.0.1/secret' }) },
  });
  const r = redirect.domains[0]!.checks.find((c) => c.id === 'public')!;
  assert.equal(r.status, 'warn');
  assert.doesNotMatch(r.message, /10\.0\.0\.1|secret/);
  assert.match(r.message, /HTTP 301 \(redirect\)/);
});

// ── 12. pre-flight account key encrypted ─────────────────────────────────────

test('pre-flight ACME account key is stored encrypted and reused; a plaintext value is replaced', async () => {
  redisStore.delete('acme:preflight:account-key');
  const r1 = await acme.runAcmeValidationTest(['mail.example.com'], 20_000);
  assert.equal(r1.status, 'ok', JSON.stringify(r1));
  const stored = redisStore.get('acme:preflight:account-key')!;
  assert.match(stored, /^v1:/);
  assert.doesNotMatch(stored, /BEGIN/);
  assert.equal(acme.decryptPreflightAccountKey(stored), accountKeys[0]);

  // an encrypted existing key is decrypted and reused
  redisStore.set('acme:preflight:account-key', sauth.encryptMfaSecret('-----BEGIN EXISTING KEY-----'));
  await acme.runAcmeValidationTest(['mail.example.com'], 20_000);
  assert.equal(accountKeys.at(-1), '-----BEGIN EXISTING KEY-----');

  // plaintext (older versions) is not used and is replaced by an encrypted key
  redisStore.set('acme:preflight:account-key', '-----BEGIN PLAINTEXT KEY-----');
  await acme.runAcmeValidationTest(['mail.example.com'], 20_000);
  assert.notEqual(accountKeys.at(-1), '-----BEGIN PLAINTEXT KEY-----');
  assert.match(redisStore.get('acme:preflight:account-key')!, /^v1:/);
});
