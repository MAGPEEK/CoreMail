/**
 * 9.3 — protocol TLS single source of truth:
 *  - PUT assigning SMTP/IMAP/POP3 switches ServerSettings.tlsCert (full chain) and
 *    publishes the reload; the previous certificate loses isActiveProtocol; audited;
 *  - removing the services falls back to the self-signed default for the public host name;
 *  - staging certificates never get mail services (PUT 409, POST /letsencrypt 400,
 *    activate-protocol 409); activate-protocol also sets the services;
 *  - startup reconciliation repairs the exact test-server state (LE cert with the
 *    services, self-signed mail.localhost still active) and is idempotent;
 *  - the self-signed default for mail.localhost is regenerated for the public host name
 *    (a trusted certificate is never replaced);
 *  - ACME completion auto-assigns a certificate for the public host name while the mail
 *    protocols use the self-signed default (and activates HTTPS without a trusted one).
 * In-memory Prisma + Redis, no network.
 * Run: node --import tsx --test --test-force-exit src/lib/protocol-cert-assign.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';
import { makeTestCertPem } from '../test-support/fake-acme.js';

setTestEnv();

type Row = Record<string, unknown>;
const certs = new Map<string, Row>();
let settings: Row = {};
const audits: Row[] = [];
let nextId = 1;
let failCertFindMany = false;

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
      if (failCertFindMany) throw new Error('db down');
      const { where, select } = (a ?? {}) as { where?: Row; select?: Row };
      return [...certs.values()].filter((r) => matches(r, where)).map((r) => applySelect(r, select));
    },
    create: (a) => {
      const { data, select } = a as { data: Row; select?: Row };
      const row: Row = {
        id: `gen${nextId++}`, isActiveProtocol: false, isActiveHttps: false, acmeStaging: false, chainPem: null,
        createdAt: new Date(), updatedAt: new Date(), ...data,
      };
      certs.set(String(row['id']), row);
      return applySelect(row, select);
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
      for (const r of certs.values()) if (matches(r, where)) { Object.assign(r, data); count++; }
      return { count };
    },
    delete: (a) => { certs.delete((a as { where: { id: string } }).where.id); return {}; },
  },
  serverSettings: {
    findUnique: (a) => applySelect({ ...settings }, (a as { select?: Row }).select),
    upsert: (a) => { Object.assign(settings, (a as { update: Row }).update); return settings; },
    update: (a) => { Object.assign(settings, (a as { data: Row }).data); return settings; },
  },
  auditLog: { create: (a) => { audits.push((a as { data: Row }).data); return {}; } },
  domain: { findFirst: () => ({ name: 'heybuddies.de' }) },
});

const published: Array<[string, string]> = [];
(globalThis as Record<string, unknown>)['__certAcmeRedis'] = {
  async publish(channel: string, msg: string) { published.push([channel, msg]); return 1; },
};

const core = await import('@coremail/core');
const pca = await import('./protocol-cert-assign.js');
const express = (await import('express')).default;
const { requireAuth } = await import('../middleware/auth.js');
const { adminCertificatesRouter } = await import('../routes/admin/certificates.js');
const { decryptPrivateKey } = await import('@coremail/storage');

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
beforeEach(() => {
  certs.clear(); audits.length = 0; published.length = 0;
  settings = { id: 'singleton', publicHostname: 'mail.heybuddies.de', tlsCert: null, tlsKey: null };
});

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

const PEM_LE = makeTestCertPem(['mail.heybuddies.de']);
const PEM_SELF_LOCALHOST = makeTestCertPem(['mail.localhost']);

function addCert(id: string, over: Row = {}): Row {
  const row: Row = {
    id, name: id, type: 'LETSENCRYPT', status: 'ACTIVE', domains: ['mail.heybuddies.de'], services: [],
    acmeEmail: 'admin@heybuddies.de', autoRenew: true, acmeStaging: false, certPem: PEM_LE, keyPem: 'KEY-LE',
    chainPem: null, acmeAccount: null, isActiveProtocol: false, isActiveHttps: false,
    lastError: null, lastErrorCode: null, updatedAt: new Date(), createdAt: new Date(), ...over,
  };
  certs.set(id, row);
  return row;
}
/** The verified test-server state (BCP showed SMTP/IMAP/POP3 on LE, ports served mail.localhost). */
function testServerState(): { le: Row; self: Row } {
  const self = addCert('self', {
    name: 'mail.localhost', type: 'SELF_SIGNED', domains: ['mail.localhost'], services: [], autoRenew: false,
    certPem: PEM_SELF_LOCALHOST, keyPem: 'KEY-SELF', isActiveProtocol: true, acmeEmail: null,
  });
  const le = addCert('le', { name: 'mail.heybuddies.de', services: ['SMTP', 'IMAP', 'POP3'] });
  settings['tlsCert'] = PEM_SELF_LOCALHOST;
  settings['tlsKey'] = 'KEY-SELF';
  return { le, self };
}
const settingsReloads = () => published.filter(([c]) => c === core.CHANNEL_SETTINGS_RELOAD);
const tick = () => new Promise((r) => setTimeout(r, 30));

// ── PUT = the switch ─────────────────────────────────────────────────────────

test('PUT services on a trusted cert applies it: tlsCert switched, reload published, previous cert inactive, audited', async () => {
  const { le, self } = testServerState();
  le['services'] = [];
  const r = await call('PUT', '/le', { services: ['SMTP'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json['protocolApplied'], true);
  assert.deepEqual(r.json['services'], ['SMTP', 'IMAP', 'POP3'], 'one protocol cert serves all three');
  assert.equal(settings['tlsCert'], PEM_LE);
  assert.match(String(settings['tlsKey']), /^enc:v1:/, 'tlsKey stored encrypted');
  assert.equal(decryptPrivateKey(String(settings['tlsKey'])), 'KEY-LE');
  assert.equal(le['isActiveProtocol'], true);
  assert.equal(self['isActiveProtocol'], false, 'previous cert loses isActiveProtocol');
  assert.deepEqual(self['services'], []);
  assert.equal(settingsReloads().length, 1, 'CHANNEL_SETTINGS_RELOAD published');
  assert.ok(published.some(([c]) => c === 'coremail:tls:reload'));
  await tick();
  const a = audits.find((x) => x['action'] === 'certificate.protocol.switch');
  assert.ok(a, 'switch audited');
  assert.equal(a!['targetId'], 'le');
  assert.equal(a!['actorEmail'], 'admin@example.com');
  assert.deepEqual((a!['changes'] as Row)['from'], [{ id: 'self', name: 'mail.localhost' }]);
});

test('PUT with the full chain: chainPem is appended to the served PEM', async () => {
  const chain = makeTestCertPem(['Intermediate CA']);
  addCert('c1', { type: 'CUSTOM', chainPem: chain });
  const r = await call('PUT', '/c1', { services: ['IMAP', 'POP3', 'SMTP'] });
  assert.equal(r.status, 200);
  assert.ok(String(settings['tlsCert']).includes(chain.trim().split('\n')[1]!), 'intermediate served');
  assert.ok(String(settings['tlsCert']).startsWith(PEM_LE.trim().split('\n')[0]!));
});

test('PUT removing the services from the protocol cert → self-signed default for the public host name', async () => {
  const le = addCert('le', { services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true });
  settings['tlsCert'] = PEM_LE;
  const r = await call('PUT', '/le', { services: [] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(le['services'], []);
  assert.equal(le['isActiveProtocol'], false);
  const fallback = [...certs.values()].find((c) => c['type'] === 'SELF_SIGNED')!;
  assert.ok(fallback, 'self-signed default created');
  assert.deepEqual(fallback['domains'], ['mail.heybuddies.de']);
  assert.equal(fallback['isActiveProtocol'], true);
  assert.deepEqual(fallback['services'], ['SMTP', 'IMAP', 'POP3']);
  assert.equal(settings['tlsCert'], fallback['certPem']);
  assert.match(new X509Certificate(String(settings['tlsCert'])).subject, /CN=mail\.heybuddies\.de/);
  assert.equal(settingsReloads().length, 1);

  // the self-signed default itself cannot be left without the services
  const refused = await call('PUT', `/${String(fallback['id'])}`, { services: [] });
  assert.equal(refused.status, 409);
  assert.equal(refused.json['code'], 'PROTOCOL_CERT_REQUIRED');
});

test('a not-yet-issued certificate keeps the assignment pending; nothing switches', async () => {
  testServerState();
  addCert('pending', { status: 'PENDING', certPem: null, keyPem: null });
  const r = await call('PUT', '/pending', { services: ['SMTP', 'IMAP', 'POP3'] });
  assert.equal(r.status, 200);
  assert.equal(r.json['protocolApplied'], false);
  assert.equal(r.json['protocolPending'], 'no-pem');
  assert.equal(settings['tlsCert'], PEM_SELF_LOCALHOST, 'protocol TLS unchanged');
  assert.equal(settingsReloads().length, 0);
});

test('PUT assigning the mail services to an expired certificate is refused; no stale label, nothing switches', async () => {
  const { le } = testServerState();
  const expired = addCert('old', { type: 'CUSTOM', status: 'EXPIRED', certPem: makeTestCertPem(['mail.heybuddies.de'], -1) });
  const r = await call('PUT', '/old', { services: ['SMTP', 'IMAP', 'POP3'] });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json['code'], 'CERT_NOT_VALID');
  assert.deepEqual(expired['services'], [], 'label not stored');
  assert.deepEqual(le['services'], ['SMTP', 'IMAP', 'POP3'], 'holder unchanged');
  assert.equal(settingsReloads().length, 0);
  // renaming a certificate that (legacy) already carries the label stays possible
  expired['services'] = ['SMTP', 'IMAP', 'POP3'];
  assert.equal((await call('PUT', '/old', { name: 'renamed', services: ['SMTP', 'IMAP', 'POP3'] })).status, 200);
});

test('staging certificates never get mail services (PUT 409, POST 400, activate-protocol 409)', async () => {
  const trusted = addCert('trusted', { type: 'CUSTOM', services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true });
  addCert('stg', { acmeStaging: true });
  const put = await call('PUT', '/stg', { services: ['SMTP'] });
  assert.equal(put.status, 409);
  assert.equal(put.json['code'], 'STAGING_NO_MAIL_SERVICES');
  assert.deepEqual(trusted['services'], ['SMTP', 'IMAP', 'POP3']);
  // switching a pending cert with mail services to staging is refused as well
  addCert('p2', { status: 'PENDING', certPem: null, keyPem: null, services: ['SMTP', 'IMAP', 'POP3'] });
  assert.equal((await call('PUT', '/p2', { acmeStaging: true })).status, 409);

  const post = await call('POST', '/letsencrypt', {
    name: 'stg', domains: ['mail.heybuddies.de'], email: 'a@heybuddies.de', staging: true, services: ['IMAP'],
  });
  assert.equal(post.status, 400);
  assert.equal(post.json['code'], 'STAGING_NO_MAIL_SERVICES');

  const act = await call('POST', '/stg/activate-protocol');
  assert.equal(act.status, 409);
  assert.equal(settingsReloads().length, 0);
});

test('activate-protocol (API compatibility) also sets SMTP/IMAP/POP3 as services', async () => {
  const { le, self } = testServerState();
  le['services'] = [];
  self['services'] = ['SMTP', 'IMAP', 'POP3'];
  const r = await call('POST', '/le/activate-protocol');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(le['services'], ['SMTP', 'IMAP', 'POP3']);
  assert.deepEqual(self['services'], []);
  assert.equal(le['isActiveProtocol'], true);
  assert.equal(settings['tlsCert'], PEM_LE);
  assert.equal((await call('POST', '/nope/activate-protocol')).status, 404);
});

test('DELETE of the protocol cert falls back to an existing self-signed default for the host name', async () => {
  const selfPem = makeTestCertPem(['mail.heybuddies.de']);
  const self = addCert('self', { type: 'SELF_SIGNED', domains: ['mail.heybuddies.de'], certPem: selfPem, keyPem: 'K' });
  addCert('le', { services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true });
  const r = await call('DELETE', '/le');
  assert.equal(r.status, 204);
  assert.equal(certs.has('le'), false);
  assert.equal(self['isActiveProtocol'], true, 'existing self-signed default reused');
  assert.equal(settings['tlsCert'], selfPem);
  assert.equal([...certs.values()].filter((c) => c['type'] === 'SELF_SIGNED').length, 1, 'no extra self-signed row');
});

// ── Startup reconciliation ───────────────────────────────────────────────────

test('startup reconciliation repairs the test-server state and is idempotent', async () => {
  const { le, self } = testServerState();
  const r = await pca.reconcileProtocolCertState();
  assert.equal(r.action, 'applied', JSON.stringify(r));
  assert.equal(r.certId, 'le');
  assert.equal(settings['tlsCert'], PEM_LE, 'server_settings.tlsCert now the LE cert');
  assert.equal(le['isActiveProtocol'], true);
  assert.equal(self['isActiveProtocol'], false);
  assert.equal(settingsReloads().length, 1);
  assert.equal(settings['publicHostname'], 'mail.heybuddies.de', 'host name untouched');
  assert.ok(certs.has('self'), 'the self-signed cert is kept (inactive)');

  published.length = 0;
  const again = await pca.reconcileProtocolCertState();
  assert.equal(again.action, 'consistent');
  assert.equal(published.length, 0, 'second run changes nothing');
});

test('reconciliation: isActiveProtocol and services disagree → services win', async () => {
  // A holds the services, B is flagged active and served
  const a = addCert('a', { type: 'CUSTOM', services: ['SMTP', 'IMAP', 'POP3'] });
  const b = addCert('b', { type: 'CUSTOM', certPem: makeTestCertPem(['mail.heybuddies.de']), isActiveProtocol: true });
  settings['tlsCert'] = b['certPem'];
  await pca.reconcileProtocolCertState();
  assert.equal(a['isActiveProtocol'], true);
  assert.equal(b['isActiveProtocol'], false);
  assert.equal(settings['tlsCert'], a['certPem']);
});

test('reconciliation: legacy activate-protocol install (no services anywhere) keeps serving its cert', async () => {
  const le = addCert('le', { isActiveProtocol: true });
  settings['tlsCert'] = PEM_LE;
  const r = await pca.reconcileProtocolCertState();
  assert.equal(r.certId, 'le');
  assert.equal(settings['tlsCert'], PEM_LE);
  assert.deepEqual(le['services'], ['SMTP', 'IMAP', 'POP3'], 'services aligned with what is served');
});

test('reconciliation: staging certs lose mail services; a pending LE keeps its pending assignment', async () => {
  const stg = addCert('stg', { acmeStaging: true, services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true });
  const pending = addCert('pend', { status: 'PENDING', certPem: null, keyPem: null, services: ['SMTP', 'IMAP', 'POP3'] });
  const r = await pca.reconcileProtocolCertState();
  assert.deepEqual(stg['services'], []);
  assert.equal(stg['isActiveProtocol'], false);
  assert.equal(r.action, 'fallback-self-signed');
  assert.deepEqual(pending['services'], ['SMTP', 'IMAP', 'POP3'], 'pending assignment kept');
  const self = [...certs.values()].find((c) => c['type'] === 'SELF_SIGNED')!;
  assert.equal(self['isActiveProtocol'], true);
  assert.deepEqual(self['domains'], ['mail.heybuddies.de']);
});

test('self-signed default for mail.localhost is regenerated for the public host name; a trusted cert never', async () => {
  const self = addCert('self', {
    name: 'mail.localhost', type: 'SELF_SIGNED', domains: ['mail.localhost'], services: ['SMTP', 'IMAP', 'POP3'],
    certPem: PEM_SELF_LOCALHOST, keyPem: 'KEY-SELF', isActiveProtocol: true,
  });
  settings['tlsCert'] = PEM_SELF_LOCALHOST;
  const r = await pca.reconcileProtocolCertState();
  assert.equal(r.action, 'regenerated-self-signed', JSON.stringify(r));
  assert.deepEqual(self['domains'], ['mail.heybuddies.de']);
  assert.equal(pca.certCommonName(String(self['certPem'])), 'mail.heybuddies.de');
  assert.equal(settings['tlsCert'], self['certPem']);
  assert.equal(self['isActiveProtocol'], true);

  // a trusted active certificate is never replaced, even with publicHostname set
  certs.clear(); published.length = 0;
  const le = addCert('le', { services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true, certPem: makeTestCertPem(['mail.localhost']) });
  settings['tlsCert'] = le['certPem'];
  const r2 = await pca.reconcileProtocolCertState();
  assert.equal(r2.action, 'consistent');
  assert.equal(settings['tlsCert'], le['certPem']);

  // no public host name configured → mail.localhost stays
  certs.clear();
  settings['publicHostname'] = 'mail.local';
  const s2 = addCert('s2', { type: 'SELF_SIGNED', domains: ['mail.localhost'], certPem: PEM_SELF_LOCALHOST, services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true });
  settings['tlsCert'] = PEM_SELF_LOCALHOST;
  assert.equal((await pca.reconcileProtocolCertState()).action, 'consistent');
  assert.equal(s2['certPem'], PEM_SELF_LOCALHOST);
});

test('reconciliation without any certificate: self-signed default for the host name is created and applied', async () => {
  settings['tlsCert'] = PEM_SELF_LOCALHOST; // generated by a protocol server, no row
  const r = await pca.reconcileProtocolCertState();
  assert.equal(r.action, 'fallback-self-signed');
  const self = [...certs.values()][0]!;
  assert.equal(self['type'], 'SELF_SIGNED');
  assert.equal(settings['tlsCert'], self['certPem']);
  assert.equal(pca.certCommonName(String(self['certPem'])), 'mail.heybuddies.de');
});

// ── Startup reconciliation lock ──────────────────────────────────────────────

function fakeLockRedis() {
  const kv = new Map<string, string>();
  return {
    kv,
    async set(k: string, v: string, _px: 'PX', _ttl: number, nx?: 'NX') {
      if (nx === 'NX' && kv.has(k)) return null;
      kv.set(k, v); return 'OK' as const;
    },
    async eval(_s: string, _n: number, ...args: string[]) {
      const [k, token] = args as [string, string];
      if (kv.get(k) === token) { kv.delete(k); return 1; }
      return 0;
    },
  };
}

test('startup reconciliation under the Redis lock: held lock → skipped silently, nothing written', async () => {
  const r = fakeLockRedis();
  r.kv.set(pca.RECONCILE_LOCK_KEY, 'other-instance');
  const res = await pca.reconcileProtocolCertStateLocked(new Date(), r);
  assert.equal(res, null);
  assert.equal(certs.size, 0, 'no self-signed row created');
  assert.equal(published.length, 0);
  assert.equal(r.kv.get(pca.RECONCILE_LOCK_KEY), 'other-instance', 'foreign lock untouched');
});

test('startup reconciliation under the Redis lock: concurrent instances create exactly one self-signed default', async () => {
  const r = fakeLockRedis();
  const results = await Promise.all([
    pca.reconcileProtocolCertStateLocked(new Date(), r),
    pca.reconcileProtocolCertStateLocked(new Date(), r),
    pca.reconcileProtocolCertStateLocked(new Date(), r),
  ]);
  assert.equal(results.filter((x) => x !== null).length, 1, 'one instance repairs');
  assert.equal(results.find((x) => x)!.action, 'fallback-self-signed');
  assert.equal([...certs.values()].filter((c) => c['type'] === 'SELF_SIGNED').length, 1, 'no duplicate rows');
  assert.equal(r.kv.has(pca.RECONCILE_LOCK_KEY), false, 'lock released after the run');
  // a later start finds the state consistent (idempotent) and takes the free lock
  const again = await pca.reconcileProtocolCertStateLocked(new Date(), r);
  assert.equal(again?.action, 'consistent');
});

test('startup reconciliation under the Redis lock: Redis unavailable → skipped, lock released on failure', async () => {
  const broken = { set: async () => { throw new Error('ECONNREFUSED'); }, eval: async () => 0 };
  assert.equal(await pca.reconcileProtocolCertStateLocked(new Date(), broken), null);
  assert.equal(certs.size, 0);

  // a failing repair still releases the lock
  const r = fakeLockRedis();
  failCertFindMany = true;
  try {
    await assert.rejects(pca.reconcileProtocolCertStateLocked(new Date(), r), /db down/);
  } finally {
    failCertFindMany = false;
  }
  assert.equal(r.kv.has(pca.RECONCILE_LOCK_KEY), false);
});

// ── ACME completion ──────────────────────────────────────────────────────────

test('ACME completion: a cert for the public host name is auto-assigned while self-signed is in use (+ HTTPS)', async () => {
  const self = addCert('self', { type: 'SELF_SIGNED', domains: ['mail.heybuddies.de'], certPem: makeTestCertPem(['mail.heybuddies.de']), services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true, isActiveHttps: true });
  const le = addCert('le', { domains: ['mail.heybuddies.de', 'autodiscover.heybuddies.de'] });
  assert.equal(await pca.afterAcmeIssued('le', { isRenewal: false }), 'auto-assigned');
  assert.equal(le['isActiveProtocol'], true);
  assert.deepEqual(le['services'], ['SMTP', 'IMAP', 'POP3']);
  assert.equal(self['isActiveProtocol'], false);
  assert.equal(le['isActiveHttps'], true, 'HTTPS activated (only a self-signed one was active)');
  assert.equal(self['isActiveHttps'], false);
  assert.equal(settings['tlsCert'], PEM_LE);
});

test('ACME completion: no auto-assign when a trusted cert serves the mail protocols or the name differs', async () => {
  const other = addCert('other', { type: 'CUSTOM', services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true, isActiveHttps: true });
  const le = addCert('le');
  assert.equal(await pca.afterAcmeIssued('le', { isRenewal: false }), 'none');
  assert.equal(le['isActiveProtocol'], false);
  assert.equal(other['isActiveProtocol'], true);

  certs.clear();
  addCert('self', { type: 'SELF_SIGNED', domains: ['mail.heybuddies.de'], services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true });
  addCert('www', { domains: ['www.heybuddies.de'] });
  assert.equal(await pca.afterAcmeIssued('www', { isRenewal: false }), 'none');
});

test('ACME completion: a renewal of the protocol cert re-applies it (host name kept); trusted HTTPS untouched', async () => {
  settings['publicHostname'] = 'mail.local';
  const https = addCert('https', { type: 'CUSTOM', domains: ['www.heybuddies.de'], isActiveHttps: true });
  const le = addCert('le', { services: ['SMTP', 'IMAP', 'POP3'], isActiveProtocol: true });
  assert.equal(await pca.afterAcmeIssued('le', { isRenewal: true }), 'applied');
  assert.equal(settings['tlsCert'], PEM_LE);
  assert.equal(settings['publicHostname'], 'mail.local', 'renewal never changes the host name');
  assert.equal(https['isActiveHttps'], true);
  assert.equal(le['isActiveHttps'], false);
});

test('selfSignedHostnameFor: real public host names only (strict, shell-safe)', () => {
  assert.equal(pca.selfSignedHostnameFor('Mail.Example.com'), 'mail.example.com');
  assert.equal(pca.selfSignedHostnameFor('mail.local'), 'mail.localhost');
  assert.equal(pca.selfSignedHostnameFor(''), 'mail.localhost');
  assert.equal(pca.selfSignedHostnameFor('mail.example.com"; rm -rf /'), 'mail.localhost');
  assert.equal(pca.selfSignedHostnameFor('localhost'), 'mail.localhost');
});
