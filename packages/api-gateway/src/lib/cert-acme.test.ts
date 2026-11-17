/**
 * Let's Encrypt issuance end to end against a fake CA (9.2.x fix):
 *  - first issuance and retries go through startRenewal (per-cert lock), use
 *    the stored staging flag and the account key stored before the first CA call;
 *  - a CA failure ends in ERROR with the CA's detail + a classified code, the
 *    lock is released, a retry is possible (PENDING for never-issued certs);
 *  - definite DNS problems fail before the CA is contacted;
 *  - PENDING/RENEWING without a lock holder is repaired to ERROR ("interrupted");
 *  - the 5-minute guard names the last step and frees the lock right away.
 * No network (fake CA / resolver / serving, in-memory Prisma + Redis).
 * Run: node --import tsx --test --test-force-exit src/lib/cert-acme.test.ts  (in packages/api-gateway)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePrisma, applySelect, setTestEnv } from '../test-support/fake-prisma.js';
import { makeFakeCa, makeFakeServing, type FakeCaOptions } from '../test-support/fake-acme.js';
import type { AcmeClientLike } from './acme-flow.js';

setTestEnv();

type Row = Record<string, unknown>;
const certs = new Map<string, Row>();
const settingsUpserts: Row[] = [];

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const cond = v as { in?: unknown[]; notIn?: unknown[]; not?: unknown };
      if (cond.in && !cond.in.includes(row[k])) return false;
      if (cond.notIn && cond.notIn.includes(row[k])) return false;
      if ('not' in cond && row[k] === cond.not) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

installFakePrisma({
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
    upsert: (a) => {
      if (failSettingsUpsert) throw new Error('database unavailable');
      settingsUpserts.push(a as Row); return {};
    },
  },
});
let failSettingsUpsert = false;

/** In-memory Redis (SET NX PX, GET, DEL, EXISTS, SETEX, compare-and-delete EVAL). */
const redisStore = new Map<string, string>();
(globalThis as Record<string, unknown>)['__certRenewRedis'] = {
  async set(k: string, v: string, _px: string, _ttl: number, nx?: string) {
    if (nx === 'NX' && redisStore.has(k)) return null;
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
};

// Reload notifications (publish) go to a no-op Redis.
const published: string[] = [];
(globalThis as Record<string, unknown>)['__certAcmeRedis'] = {
  async publish(channel: string, msg: string) { published.push(`${channel}:${msg}`); return 1; },
};

// Fake CA, serving and resolver through the cert-acme seams.
let caOptions: FakeCaOptions = {};
let lastCa: ReturnType<typeof makeFakeCa> | null = null;
const directories: string[] = [];
const servingFake = makeFakeServing({ public: 'refused' });
(globalThis as Record<string, unknown>)['__acmeChallengeServing'] = servingFake.serving;
const accountKeysUsed: string[] = [];
(globalThis as Record<string, unknown>)['__acmeClientFactory'] = (dir: string, accountKeyPem: string): AcmeClientLike => {
  directories.push(dir);
  accountKeysUsed.push(accountKeyPem);
  lastCa = makeFakeCa({ served: servingFake.served, ...caOptions });
  return lastCa.client;
};
const nxdomain = new Set<string>();
const noData = () => Promise.reject(Object.assign(new Error('no data'), { code: 'ENODATA' }));
(globalThis as Record<string, unknown>)['__acmeResolver'] = {
  resolve4: (n: string) => nxdomain.has(n) ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) : Promise.resolve(['203.0.113.10']),
  resolve6: (n: string) => nxdomain.has(n) ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) : noData(),
  resolveCaa: () => noData(),
};

const { startRenewal, repairStaleAcmeStates, isRenewLockHeld, INTERRUPTED_MESSAGE } = await import('./cert-renewal.js');
const { runAcmeIssuance, AcmeTimeoutError, LE_DIRECTORY } = await import('./cert-acme.js');
const { encryptPrivateKey, decryptPrivateKey, isEncryptedPrivateKey } = await import('@coremail/storage');
const renewRedis = (globalThis as Record<string, unknown>)['__certRenewRedis'] as Parameters<typeof isRenewLockHeld>[0];

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

beforeEach(() => {
  caOptions = {}; lastCa = null; directories.length = 0; accountKeysUsed.length = 0; settingsUpserts.length = 0; nxdomain.clear();
  failSettingsUpsert = false;
});

test('issued certificate stays ACTIVE when applying it to SMTP/IMAP/POP3 fails (no ERROR over a valid PEM)', async () => {
  const row = addCert('c-apply-fail', { services: ['SMTP', 'IMAP', 'POP3'] });
  failSettingsUpsert = true;
  assert.deepEqual(await startRenewal('c-apply-fail', 'issue'), { started: true });
  await waitFor(settled('c-apply-fail'));
  assert.equal(row['status'], 'ACTIVE', String(row['lastError']));
  assert.match(String(row['certPem']), /BEGIN CERTIFICATE/);
  assert.equal(row['lastError'], null);
  assert.equal(row['lastErrorCode'], null);
});

test('first issuance: staging directory, account key stored before the CA call, ACTIVE; staging never activates protocol TLS', async () => {
  const row = addCert('c1', { acmeStaging: true, services: ['SMTP'] });
  const r = await startRenewal('c1', 'issue');
  assert.deepEqual(r, { started: true });
  assert.equal(await isRenewLockHeld(renewRedis, 'c1'), true, 'the run holds the per-certificate lock');
  await waitFor(settled('c1'));
  assert.equal(row['status'], 'ACTIVE', String(row['lastError']));
  assert.match(String(row['certPem']), /BEGIN CERTIFICATE/);
  assert.match(String(row['keyPem']), /^enc:v1:/, 'issued private key stored encrypted at rest');
  assert.ok(row['acmeAccount'], 'account key persisted');
  assert.match(String(row['acmeAccount']), /^enc:v1:/, 'account key stored encrypted at rest');
  assert.equal(decryptPrivateKey(String(row['acmeAccount'])), accountKeysUsed[0], 'the CA client got the plain key');
  assert.equal(row['lastErrorCode'], null);
  assert.deepEqual(directories, [LE_DIRECTORY.staging]);
  // 9.2.x review: a staging (untrusted) certificate is never auto-activated
  // (production with SMTP assigned: see cert-staging-guard.test.ts).
  assert.equal(settingsUpserts.length, 0, 'staging issuance with SMTP assigned leaves protocol TLS untouched');
  assert.equal(row['isActiveProtocol'], false);
  assert.equal(await isRenewLockHeld(renewRedis, 'c1'), false, 'lock released after the run');
});

test('CA reports "connection refused" → ERROR with the detail and code; retry restarts as PENDING and succeeds', async () => {
  const row = addCert('c2', { status: 'PENDING' });
  caOptions = { outcome: () => ({ status: 'invalid', type: 'urn:ietf:params:acme:error:connection',
    detail: '84.247.191.198: Fetching http://mail.example.com/.well-known/acme-challenge/x: Connection refused' }) };
  assert.deepEqual(await startRenewal('c2', 'issue'), { started: true });
  await waitFor(settled('c2'));
  assert.equal(row['status'], 'ERROR');
  assert.equal(row['lastErrorCode'], 'connection');
  assert.match(String(row['lastError']), /Connection refused/);
  assert.match(String(row['lastError']), /port 80/);
  const accountKey = row['acmeAccount'];
  assert.ok(accountKey, 'account key kept for the retry');
  assert.deepEqual(directories, [LE_DIRECTORY.production]);

  // retry — never issued → PENDING (first issuance semantics), same account key
  caOptions = {};
  const statusDuringRun: string[] = [];
  const res = await startRenewal('c2', 'manual');
  statusDuringRun.push(String(row['status']));
  assert.deepEqual(res, { started: true });
  assert.deepEqual(statusDuringRun, ['PENDING']);
  assert.equal(row['lastError'], null, 'previous error cleared while the new attempt runs');
  await waitFor(settled('c2'));
  assert.equal(row['status'], 'ACTIVE', String(row['lastError']));
  assert.equal(row['acmeAccount'], accountKey);
});

test('no A/AAAA record → ERROR "dns" before Let\'s Encrypt is contacted', async () => {
  const row = addCert('c3', { domains: ['missing.example.com'] });
  nxdomain.add('missing.example.com');
  await startRenewal('c3', 'issue');
  await waitFor(settled('c3'));
  assert.equal(row['status'], 'ERROR');
  assert.equal(row['lastErrorCode'], 'dns');
  assert.match(String(row['lastError']), /missing\.example\.com/);
  assert.equal(directories.length, 0, 'the CA was not contacted');
});

test('stale PENDING/RENEWING: repaired to ERROR unless locked or fresh; retry of a stale cert restarts, a locked one is refused', async () => {
  const old = new Date(Date.now() - 10 * 60_000);
  const stale = addCert('s1', { status: 'RENEWING', certPem: 'x', updatedAt: old });
  const locked = addCert('s2', { status: 'RENEWING', updatedAt: old });
  const fresh = addCert('s3', { status: 'PENDING', updatedAt: new Date() });
  redisStore.set('cert:renew:lock:s2', 'other-instance');
  try {
    const n = await repairStaleAcmeStates(new Date());
    assert.equal(n, 1);
    assert.equal(stale['status'], 'ERROR');
    assert.equal(stale['lastErrorCode'], 'interrupted');
    assert.equal(stale['lastError'], INTERRUPTED_MESSAGE);
    assert.equal(locked['status'], 'RENEWING');
    assert.equal(fresh['status'], 'PENDING');

    // a run that still holds the lock is not restarted
    const refused = await startRenewal('s2', 'manual');
    assert.deepEqual(refused, { started: false, reason: 'in-progress', status: 'RENEWING' });
  } finally {
    redisStore.delete('cert:renew:lock:s2');
  }
  // lock free → a manual retry restarts the left-over RENEWING cert
  locked['certPem'] = null;
  const restarted = await startRenewal('s2', 'manual');
  assert.deepEqual(restarted, { started: true });
  await waitFor(settled('s2'));
  assert.equal(locked['status'], 'ACTIVE', String(locked['lastError']));
  // the scheduler never restarts an in-progress cert
  addCert('s4', { status: 'RENEWING', updatedAt: old });
  assert.deepEqual(await startRenewal('s4', 'scheduler'), { started: false, reason: 'in-progress', status: 'RENEWING' });
  certs.delete('s4');
  certs.delete('s3');
});

test('timeout: CA never answers → ERROR "timeout" naming the last step; lock hook runs right away', async () => {
  const row = addCert('t1', { status: 'PENDING' });
  caOptions = { hangComplete: true };
  let settledAt = 0;
  let rejectedAt = 0;
  await assert.rejects(
    runAcmeIssuance('t1', ['mail.example.com'], 'admin@example.com', true, false, {
      timeoutMs: 1_500, onSettled: () => { settledAt = Date.now(); },
    }).finally(() => { rejectedAt = Date.now(); }),
    (err: unknown) => err instanceof AcmeTimeoutError,
  );
  await waitFor(() => settledAt > 0, 2_000);
  assert.ok(settledAt - rejectedAt < 500, `work stopped ${settledAt - rejectedAt} ms after the timeout`);
  assert.equal(row['status'], 'ERROR');
  assert.equal(row['lastErrorCode'], 'timeout');
  assert.match(String(row['lastError']), /last step: waiting for Let's Encrypt to validate mail\.example\.com over port 80/);
  assert.equal(servingFake.served.size, 0, 'challenge token removed');
});

const accountPem = (body: string): string => ['-----BEGIN PRIVATE KEY-----', body, '-----END PRIVATE KEY-----', ''].join('\n');

test('ACME account key: a plain PEM stored before 9.4 is reused and encrypted on use', async () => {
  const legacy = accountPem('LEGACY ACCOUNT');
  const row = addCert('c-acct-legacy', { acmeAccount: legacy });
  await startRenewal('c-acct-legacy', 'issue');
  await waitFor(settled('c-acct-legacy'));
  assert.equal(row['status'], 'ACTIVE', String(row['lastError']));
  assert.deepEqual(accountKeysUsed, [legacy], 'same ACME account');
  assert.ok(isEncryptedPrivateKey(String(row['acmeAccount'])));
  assert.equal(decryptPrivateKey(String(row['acmeAccount'])), legacy);
});

test('ACME account key: an encrypted key is decrypted for the CA client and left as stored', async () => {
  const pem = accountPem('ENCRYPTED ACCOUNT');
  const stored = encryptPrivateKey(pem);
  const row = addCert('c-acct-enc', { acmeAccount: stored });
  await startRenewal('c-acct-enc', 'issue');
  await waitFor(settled('c-acct-enc'));
  assert.equal(row['status'], 'ACTIVE', String(row['lastError']));
  assert.deepEqual(accountKeysUsed, [pem]);
  assert.equal(row['acmeAccount'], stored);
});

test('ACME account key: an unreadable key (key material changed) is replaced by a new account key', async () => {
  const secret = process.env['JWT_SECRET'];
  process.env['JWT_SECRET'] = 'old-secret-old-secret-old-secret-123456';
  const unreadable = encryptPrivateKey(accountPem('LOST'));
  process.env['JWT_SECRET'] = secret;
  const row = addCert('c-acct-lost', { acmeAccount: unreadable });
  await startRenewal('c-acct-lost', 'issue');
  await waitFor(settled('c-acct-lost'));
  assert.equal(row['status'], 'ACTIVE', String(row['lastError']));
  assert.notEqual(row['acmeAccount'], unreadable);
  assert.equal(decryptPrivateKey(String(row['acmeAccount'])), accountKeysUsed[0]);
});
