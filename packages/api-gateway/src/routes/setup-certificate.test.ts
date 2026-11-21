/**
 * 10.6: the setup wizard's certificate step (routes/setup-followup.ts
 * /certificate/*, lib/setup-certificate.ts, lib/acme-order.ts).
 *
 *  - auth: anonymous 401, other roles 403; the wizard's admin session works
 *    without MFA (requireMfaForAdmins on) — the admin certificate routes do not;
 *  - window: setup not completed / wizard finished / > 24 h → 404 (POSTs audited);
 *  - local / private host name → not eligible, POSTs 409 LOCAL_HOSTNAME;
 *  - contact e-mail validation, terms of service required;
 *  - the order goes through the real ACME code path against a fake CA: names =
 *    host name + autodiscover. (DNS points here) but not autoconfig. (no DNS),
 *    the contact reaches the account registration, SMTP/IMAP/POP3 then HTTPS
 *    are assigned, everything audited as setup.certificate.*;
 *  - failure → status ERROR with the reason; a retry reuses the row;
 *  - terms of service URL from the ACME directory, fallback to the repository page;
 *  - own rate limits.
 * No network (fake CA / resolver / challenge serving, in-memory Prisma + Redis).
 * Run: node --import tsx --test --test-force-exit src/routes/setup-certificate.test.ts  (in packages/api-gateway)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';
import { makeFakeCa, makeFakeServing, type FakeCaOptions } from '../test-support/fake-acme.js';
import type { AcmeClientLike } from '../lib/acme-flow.js';

setTestEnv();

type Row = Record<string, unknown>;
let settings: Row = {};
let audits: Row[] = [];
const certs = new Map<string, Row>();
let certSeq = 0;
const settingsUpserts: Row[] = [];

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const c = v as { in?: unknown[]; not?: unknown; has?: unknown; gte?: Date };
      if (c.in && !c.in.includes(row[k])) return false;
      if ('not' in c && row[k] === c.not) return false;
      if ('has' in c && !((row[k] as unknown[] | undefined) ?? []).includes(c.has)) return false;
      if (c.gte && !((row[k] as Date).getTime() >= c.gte.getTime())) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

installFakePrisma({
  user: {
    findUnique: (a) => {
      const q = a as { where: Row; select?: Row };
      const id = String(q.where['id']);
      return applySelect({ id, email: `${id}@example.com`, role: id.replace(/^actor-/, ''), active: true }, q.select);
    },
  },
  serverSettings: {
    findUnique: (a) => applySelect({ id: 'singleton', auditLogEnabled: false, ...settings }, (a as { select?: Row }).select),
    upsert: (a) => { settingsUpserts.push(a as Row); return {}; },
    update: () => ({}),
  },
  domain: { findFirst: () => ({ name: 'example.com' }) },
  adminScope: { findMany: () => [] },
  auditLog: { create: (a) => { audits.push((a as { data: Row }).data); return {}; } },
  certificate: {
    create: (a) => {
      const data = (a as { data: Row }).data;
      const id = `cert-${++certSeq}`;
      const row: Row = {
        id, certPem: null, keyPem: null, chainPem: null, acmeAccount: null, isActiveProtocol: false, isActiveHttps: false,
        lastError: null, lastErrorCode: null, expiresAt: null, issuedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data,
      };
      certs.set(id, row);
      return { ...row };
    },
    findUnique: (a) => {
      const { where, select } = a as { where: { id: string }; select?: Row };
      return applySelect(certs.get(where.id) ?? null, select);
    },
    findFirst: (a) => {
      const { where, select } = (a ?? {}) as { where?: Row; select?: Row };
      const rows = [...certs.values()].filter((r) => matches(r, where))
        .sort((x, y) => (y['createdAt'] as Date).getTime() - (x['createdAt'] as Date).getTime());
      return applySelect(rows[0] ?? null, select);
    },
    findMany: (a) => {
      const { where, select } = (a ?? {}) as { where?: Row; select?: Row };
      return [...certs.values()].filter((r) => matches(r, where)).map((r) => applySelect(r, select));
    },
    update: (a) => {
      const { where, data, select } = a as { where: { id: string }; data: Row; select?: Row };
      const row = certs.get(where.id);
      if (!row) throw new Error('Record to update not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return applySelect(row, select);
    },
    updateMany: (a) => {
      const { where, data } = (a ?? {}) as { where?: Row; data: Row };
      let count = 0;
      for (const r of certs.values()) if (matches(r, where)) { Object.assign(r, data, { updatedAt: new Date() }); count++; }
      return { count };
    },
  },
});

// In-memory Redis for the renewal lock, the pre-flight lock and reload notifications.
const redisStore = new Map<string, string>();
const fakeRedis = {
  async set(k: string, v: string, ...rest: unknown[]) {
    if (rest.includes('NX') && redisStore.has(k)) return null;
    redisStore.set(k, v); return 'OK';
  },
  async get(k: string) { return redisStore.get(k) ?? null; },
  async setex(k: string, _s: number, v: string) { redisStore.set(k, v); return 'OK'; },
  async del(k: string) { return redisStore.delete(k) ? 1 : 0; },
  async exists(k: string) { return redisStore.has(k) ? 1 : 0; },
  async eval(_s: string, _n: number, key: string, token: string) {
    if (redisStore.get(key) === token) { redisStore.delete(key); return 1; }
    return 0;
  },
  async publish() { return 1; },
};
const g = globalThis as Record<string, unknown>;
g['__certRenewRedis'] = fakeRedis;
g['__certAcmeRedis'] = fakeRedis;

// Fake CA (records the account contact, the directory and the ordered names).
let caOptions: FakeCaOptions = {};
const directories: string[] = [];
const accounts: Array<{ contact?: string[] }> = [];
const orders: string[][] = [];
const servingFake = makeFakeServing({ public: 'refused' });
g['__acmeChallengeServing'] = servingFake.serving;
g['__acmeClientFactory'] = (dir: string): AcmeClientLike => {
  directories.push(dir);
  const ca = makeFakeCa({ served: servingFake.served, ...caOptions });
  return {
    ...ca.client,
    async createAccount(data) { accounts.push({ ...(data.contact ? { contact: data.contact } : {}) }); return ca.client.createAccount(data); },
    async createOrder(o) { orders.push(o.identifiers.map((i) => i.value)); return ca.client.createOrder(o); },
  };
};
const noData = () => Promise.reject(Object.assign(new Error('no data'), { code: 'ENODATA' }));
const nx = () => Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
g['__acmeResolver'] = {
  resolve4: (n: string) => (n === 'autoconfig.example.com' ? nx() : Promise.resolve(['203.0.113.10'])),
  resolve6: (n: string) => (n === 'autoconfig.example.com' ? nx() : noData()),
  resolveCaa: () => noData(),
};

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { createSetupFollowUpRouter } = await import('./setup-followup.js');
const { setupCertificateRateLimit, setupCertificateStatusRateLimit } = await import('../middleware/security.js');
const { acmeTermsOfServiceUrl, LE_REPOSITORY_URL } = await import('../lib/acme-order.js');
const { LE_DIRECTORY } = await import('../lib/cert-acme.js');
const { requireArea } = await import('../middleware/auth.js');

let clock = new Date('2026-11-20T10:00:00Z');
let directoryAnswer: unknown = { meta: { termsOfService: 'https://letsencrypt.org/documents/LE-SA-v1.5-February-24-2025.pdf' } };
const directoryUrls: string[] = [];

const token = (role: string, mfaVerified = true) => core.signAccessToken({
  sub: `actor-${role}`, email: `actor-${role}@example.com`, role: role as never, domainId: 'd1', sessionId: `s-${role}`, mfaVerified,
});
const ADMIN = 'ORGANIZATION_MANAGEMENT';

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  const pass = (_q: unknown, _s: unknown, next: () => void) => next();
  app.use('/api/v1/setup', createSetupFollowUpRouter({
    log: { info: () => undefined, warn: () => undefined },
    now: () => clock,
    rateLimit: pass, certificateRateLimit: pass, certificateStatusRateLimit: pass,
    fetchDirectory: async (url) => {
      directoryUrls.push(url);
      if (directoryAnswer instanceof Error) throw directoryAnswer;
      return directoryAnswer;
    },
  }));
  // the BCP certificate routes keep the admin-MFA rule
  app.get('/api/v1/admin/certificates', requireArea('servers'), (_q, res) => { res.json([]); });
  const limited = express.Router();
  limited.post('/cert', setupCertificateRateLimit, (_q, res) => { res.json({ ok: true }); });
  limited.get('/status', setupCertificateStatusRateLimit, (_q, res) => { res.json({ ok: true }); });
  app.use('/limited', limited);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server?.close(); });

beforeEach(() => {
  clock = new Date('2026-11-20T10:00:00Z');
  settings = {
    setupCompletedAt: new Date('2026-11-20T09:00:00Z'), setupWizardFinishedAt: null, publicHostname: 'mail.example.com',
    requireMfaForAdmins: true, mfaAdminPolicy: 'REQUIRED', mfaAdminGraceDays: 0, adminEmail: '',
  };
  audits = [];
  certs.clear();
  redisStore.clear();
  caOptions = {};
  directories.length = 0; accounts.length = 0; orders.length = 0; directoryUrls.length = 0; settingsUpserts.length = 0;
  directoryAnswer = { meta: { termsOfService: 'https://letsencrypt.org/documents/LE-SA-v1.5-February-24-2025.pdf' } };
});

const flush = () => new Promise((r) => setTimeout(r, 30));

async function call(method: 'GET' | 'POST', path: string, opts: { role?: string | null; mfa?: boolean; body?: unknown } = {}) {
  const role = opts.role === undefined ? ADMIN : opts.role;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (role) headers['authorization'] = `Bearer ${token(role, opts.mfa ?? false)}`;
  const r = await fetch(`${base}${path}`, { method, headers, ...(opts.body !== undefined && method !== 'GET' ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, json };
}

const STATUS = '/api/v1/setup/certificate/status';
const PREFLIGHT = '/api/v1/setup/certificate/preflight';
const ISSUE = '/api/v1/setup/certificate/issue';
const GOOD = { email: 'admin@example.com', termsAccepted: true };

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('authentication: anonymous 401, other roles 403 on every certificate route', async () => {
  for (const [m, p] of [['GET', STATUS], ['POST', PREFLIGHT], ['POST', ISSUE]] as const) {
    assert.equal((await call(m, p, { role: null, body: GOOD })).status, 401, `${m} ${p}`);
    for (const role of ['USER', 'HELP_DESK', 'SERVER_MANAGEMENT', 'VIEW_ONLY_ORG']) {
      assert.equal((await call(m, p, { role, body: GOOD })).status, 403, `${role} ${m} ${p}`);
    }
  }
  assert.equal(certs.size, 0, 'nothing ordered');
});

test('the wizard session without MFA reaches the setup routes; the admin certificate API still answers MFA_REQUIRED', async () => {
  const s = await call('GET', STATUS, { mfa: false });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const admin = await call('GET', '/api/v1/admin/certificates', { mfa: false });
  assert.equal(admin.status, 403);
  assert.equal(admin.json['code'], 'MFA_REQUIRED', 'the admin-MFA rule is not weakened');
});

test('status: names (host + autodiscover. pointing here, not autoconfig. without DNS), contact default, terms of service', async () => {
  const r = await call('GET', STATUS);
  assert.equal(r.status, 200);
  assert.equal(r.json['eligible'], true);
  assert.equal(r.json['hostname'], 'mail.example.com');
  assert.deepEqual(r.json['domains'], ['mail.example.com', 'autodiscover.example.com']);
  const sans = r.json['sans'] as Array<{ name: string; resolvesHere: boolean }>;
  assert.deepEqual(sans.map((s) => [s.name, s.resolvesHere]), [['autodiscover.example.com', true], ['autoconfig.example.com', false]]);
  assert.equal(r.json['contactEmail'], `actor-${ADMIN}@example.com`, 'no adminEmail set → the admin\'s own address');
  assert.equal(r.json['termsOfServiceUrl'], 'https://letsencrypt.org/documents/LE-SA-v1.5-February-24-2025.pdf');
  assert.equal(r.json['termsOfServiceFromDirectory'], true);
  assert.deepEqual(directoryUrls, [LE_DIRECTORY.production], 'the production directory decides');
  assert.equal(r.json['certificate'], null);

  settings = { ...settings, adminEmail: 'it@example.com' };
  assert.equal((await call('GET', STATUS)).json['contactEmail'], 'it@example.com', 'ServerSettings.adminEmail wins');
});

test('terms of service: unreadable directory or a non-https value falls back to the repository page', async () => {
  directoryAnswer = new Error('ECONNREFUSED');
  let r = await call('GET', STATUS);
  assert.equal(r.json['termsOfServiceUrl'], LE_REPOSITORY_URL);
  assert.equal(r.json['termsOfServiceFromDirectory'], false);
  directoryAnswer = { meta: { termsOfService: 'javascript:alert(1)' } };
  r = await call('GET', STATUS);
  assert.equal(r.json['termsOfServiceUrl'], LE_REPOSITORY_URL);
  assert.equal(await acmeTermsOfServiceUrl({ fetchDirectory: async () => ({ meta: {} }) }), null);
});

test('local / private host name: not eligible, pre-flight and order refused with LOCAL_HOSTNAME', async () => {
  for (const host of ['mail.example.local', 'mail.firma.lan', '192.168.1.10', 'mailserver']) {
    settings = { ...settings, publicHostname: host };
    const s = await call('GET', STATUS);
    assert.equal(s.status, 200);
    assert.equal(s.json['eligible'], false, host);
    assert.deepEqual(s.json['domains'], []);
    const p = await call('POST', PREFLIGHT, { body: {} });
    assert.equal(p.status, 409, host);
    assert.equal(p.json['code'], 'LOCAL_HOSTNAME');
    const i = await call('POST', ISSUE, { body: GOOD });
    assert.equal(i.status, 409, host);
  }
  assert.equal(certs.size, 0);
  assert.equal(directoryUrls.length, 0, 'no directory request for a local name');
});

test('window closed (not completed, wizard finished, > 24 h) → 404, POSTs audited as refused', async () => {
  const cases: Row[] = [
    { setupCompletedAt: null },
    { setupWizardFinishedAt: new Date('2026-11-20T09:30:00Z') },
  ];
  for (const c of cases) {
    settings = { ...settings, ...c };
    assert.equal((await call('GET', STATUS)).status, 404);
    assert.equal((await call('POST', PREFLIGHT, { body: {} })).status, 404);
    assert.equal((await call('POST', ISSUE, { body: GOOD })).status, 404);
  }
  settings = { ...settings, setupCompletedAt: new Date('2026-11-20T09:00:00Z'), setupWizardFinishedAt: null };
  clock = new Date('2026-11-21T09:00:01Z');
  assert.equal((await call('POST', ISSUE, { body: GOOD })).status, 404);
  await flush();
  assert.equal(certs.size, 0);
  const refused = audits.filter((a) => String(a['action']).startsWith('setup.certificate.'));
  assert.ok(refused.length >= 5, `refused attempts audited (${refused.length})`);
  assert.ok(refused.every((a) => a['success'] === false));
});

test('order input: invalid contact e-mail → INVALID_EMAIL, missing terms → TERMS_REQUIRED', async () => {
  for (const email of ['', 'admin', 'admin@', 'a b@example.com', `${'x'.repeat(250)}@example.com`]) {
    const r = await call('POST', ISSUE, { body: { email, termsAccepted: true } });
    assert.equal(r.status, 400, email);
    assert.equal(r.json['code'], 'INVALID_EMAIL', email);
  }
  for (const termsAccepted of [false, undefined, 'true', 1]) {
    const r = await call('POST', ISSUE, { body: { email: 'admin@example.com', termsAccepted } });
    assert.equal(r.status, 400, String(termsAccepted));
    assert.equal(r.json['code'], 'TERMS_REQUIRED');
  }
  assert.equal(certs.size, 0);
});

test('pre-flight: the shared checks for the planned names, staging test, audited', async () => {
  const r = await call('POST', PREFLIGHT, { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json['domains'], ['mail.example.com', 'autodiscover.example.com']);
  const report = r.json['report'] as { ok: boolean; domains: Array<{ domain: string; checks: Array<{ id: string; status: string }> }>; external: { status: string } };
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.domains.map((d) => d.domain), ['mail.example.com', 'autodiscover.example.com']);
  assert.ok(report.domains[0]!.checks.some((c) => c.id === 'local' && c.status === 'ok'));
  assert.equal(report.external.status, 'ok');
  assert.deepEqual(directories, [LE_DIRECTORY.staging], 'the external test uses the staging CA');
  await flush();
  const a = audits.find((x) => x['action'] === 'setup.certificate.preflight');
  assert.ok(a, 'audited');
  assert.equal(a['success'], true);
  assert.equal(a['actorId'], `actor-${ADMIN}`);
  assert.equal(certs.size, 0, 'the pre-flight orders nothing');
});

test('pre-flight failure (CA cannot reach port 80) → ok false with the reason', async () => {
  caOptions = { outcome: () => ({ status: 'invalid', type: 'urn:ietf:params:acme:error:connection', detail: '203.0.113.10: Fetching http://mail.example.com/.well-known/acme-challenge/x: Connection refused' }) };
  const r = await call('POST', PREFLIGHT, { body: {} });
  const report = r.json['report'] as { ok: boolean; external: { status: string; code?: string; message: string } };
  assert.equal(report.ok, false);
  assert.equal(report.external.status, 'error');
  assert.equal(report.external.code, 'connection');
  await flush();
  assert.equal(audits.find((x) => x['action'] === 'setup.certificate.preflight')?.['success'], false);
});

test('order: production CA, contact on the account, names, SMTP/IMAP/POP3 then HTTPS; audited', async () => {
  const r = await call('POST', ISSUE, { body: { email: ' Admin@Example.com ', termsAccepted: true } });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const view = r.json['certificate'] as { id: string; status: string };
  assert.ok(view.id);
  const row = certs.get(view.id)!;
  assert.equal(row['type'], 'LETSENCRYPT');
  assert.equal(row['acmeStaging'], false);
  assert.equal(row['acmeEmail'], 'admin@example.com', 'contact stored where renewals use it');
  assert.deepEqual(row['domains'], ['mail.example.com', 'autodiscover.example.com']);
  assert.deepEqual(row['services'], ['SMTP', 'IMAP', 'POP3']);
  assert.equal(row['autoRenew'], true);

  await waitFor(() => row['isActiveHttps'] === true);
  assert.equal(row['status'], 'ACTIVE', String(row['lastError']));
  assert.equal(row['isActiveProtocol'], true, 'SMTP/IMAP/POP3 assigned by the issuance');
  assert.ok(settingsUpserts.length > 0, 'protocol TLS written');
  assert.deepEqual(directories, [LE_DIRECTORY.production]);
  assert.deepEqual(accounts, [{ contact: ['mailto:admin@example.com'] }]);
  assert.deepEqual(orders, [['mail.example.com', 'autodiscover.example.com']]);

  const st = await call('GET', `${STATUS}?view=certificate`);
  const c = st.json['certificate'] as { status: string; httpsActive: boolean; protocolActive: boolean };
  assert.equal(c.status, 'ACTIVE');
  assert.equal(c.httpsActive, true);
  assert.equal(c.protocolActive, true);
  assert.equal(st.json['domains'], undefined, 'the polling view skips the DNS look-ups');

  await flush();
  const issue = audits.find((a) => a['action'] === 'setup.certificate.issue');
  assert.ok(issue);
  assert.equal(issue['success'], true);
  assert.equal(issue['targetId'], view.id);
  const https = audits.find((a) => a['action'] === 'setup.certificate.https');
  assert.ok(https, 'HTTPS assignment audited');
  assert.equal(https['success'], true);
  assert.equal(https['actorId'], `actor-${ADMIN}`);

  // idempotent: a second order only confirms HTTPS, nothing new is ordered
  const again = await call('POST', ISSUE, { body: GOOD });
  assert.equal(again.status, 200);
  assert.equal(certs.size, 1);
  assert.equal(orders.length, 1);
});

test('issuance failure → ERROR with the reason, no HTTPS; the retry reuses the row with the new contact', async () => {
  caOptions = { outcome: () => ({ status: 'invalid', type: 'urn:ietf:params:acme:error:connection', detail: '203.0.113.10: Connection refused' }) };
  const r = await call('POST', ISSUE, { body: GOOD });
  const id = (r.json['certificate'] as { id: string }).id;
  const row = certs.get(id)!;
  await waitFor(() => row['status'] === 'ERROR' && !redisStore.has(`cert:renew:lock:${id}`));
  await flush();
  assert.equal(row['isActiveHttps'], false);
  assert.equal(row['lastErrorCode'], 'connection');
  const st = await call('GET', `${STATUS}?view=certificate`);
  const c = st.json['certificate'] as { status: string; lastErrorCode: string; lastError: string };
  assert.equal(c.status, 'ERROR');
  assert.equal(c.lastErrorCode, 'connection');
  assert.match(c.lastError, /Connection refused/);
  assert.equal(audits.some((a) => a['action'] === 'setup.certificate.https'), false);

  caOptions = {};
  const retry = await call('POST', ISSUE, { body: { email: 'ops@example.com', termsAccepted: true } });
  assert.equal(retry.status, 202, JSON.stringify(retry.json));
  assert.equal((retry.json['certificate'] as { id: string }).id, id, 'same row');
  assert.equal(certs.size, 1);
  assert.equal(row['acmeEmail'], 'ops@example.com');
  await waitFor(() => row['isActiveHttps'] === true);
  assert.equal(row['status'], 'ACTIVE');
});

test('an order of an earlier setup run is not picked up (created before setupCompletedAt)', async () => {
  certs.set('old', {
    id: 'old', type: 'LETSENCRYPT', acmeStaging: false, status: 'ERROR', domains: ['mail.example.com'],
    createdAt: new Date('2026-11-19T09:00:00Z'), isActiveHttps: false, isActiveProtocol: false,
    lastError: 'x', lastErrorCode: 'dns', expiresAt: null, certPem: null, keyPem: null, acmeEmail: 'x@example.com',
  });
  const s = await call('GET', `${STATUS}?view=certificate`);
  assert.equal(s.json['certificate'], null);
});

test('own rate limits: 20 certificate actions per hour, 300 status polls per 15 minutes', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await fetch(`${base}/limited/cert`, { method: 'POST' })).status, 200, `request ${i + 1}`);
  assert.equal((await fetch(`${base}/limited/cert`, { method: 'POST' })).status, 429);
  for (let i = 0; i < 300; i++) assert.equal((await fetch(`${base}/limited/status`)).status, 200, `poll ${i + 1}`);
  assert.equal((await fetch(`${base}/limited/status`)).status, 429);
});
