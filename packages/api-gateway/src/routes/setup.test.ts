/**
 * v6 setup wizard hardening: one-time token, atomic one-shot claim under
 * concurrency, persistent "completed" flag (deleting users never reopens
 * setup), lowercase admin email, legacy backfill.
 * Run: node --import tsx --test --test-force-exit src/routes/setup.test.ts
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
delete process.env['SETUP_TOKEN'];
// 10.4: never touch a real /secrets — default to a directory that does not exist
const scratchRoot = mkdtempSync(join(tmpdir(), 'cm-setup-'));
process.env['COREMAIL_SECRETS_DIR'] = join(scratchRoot, 'absent');
for (const k of ['COREMAIL_SECRETS_FILE_IN_USE', 'COREMAIL_SECRETS_GENERATED', 'COREMAIL_SECRETS_HOST_PATH']) delete process.env[k];

type Row = Record<string, unknown>;
let settings: Row = {};
let users: Row[] = [];

function matchWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v || (v === null && (row[k] === null || row[k] === undefined)));
}

installFakePrisma({
  serverSettings: {
    upsert: (a) => { const q = a as { update: Row; create: Row }; settings = { ...settings, ...(settings['id'] ? q.update : q.create) }; return settings; },
    findUnique: () => (settings['id'] ? { ...settings } : null),
    update: (a) => { settings = { ...settings, ...(a as { data: Row }).data }; return settings; },
    updateMany: async (a) => {
      const q = a as { where: Row; data: Row };
      await new Promise((r) => setTimeout(r, 5)); // widen the race window
      if (!settings['id'] || !matchWhere(settings, q.where)) return { count: 0 };
      settings = { ...settings, ...q.data };
      return { count: 1 };
    },
  },
  user: {
    count: () => users.length,
    create: (a) => { const u = { id: `u${users.length + 1}`, ...(a as { data: Row }).data }; users.push(u); return u; },
  },
  domain: { create: (a) => ({ id: 'd1', ...(a as { data: Row }).data }) },
  mailbox: { create: () => ({ id: 'mb1' }) },
  folder: { create: () => ({}) },
  certificate: { create: () => ({}) },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { setupRouter } = await import('./setup.js');
const { initSetupToken, hashSetupToken, verifySetupToken } = await import('../lib/setup-token.js');

const quietLog = { info: () => undefined, warn: () => undefined };
let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/setup', setupRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server?.close();
  rmSync(scratchRoot, { recursive: true, force: true });
});
beforeEach(() => { settings = {}; users = []; });

const body = (token?: string) => ({ domain: 'Example.COM', email: 'Admin@Example.com', password: 'supersecret1', ...(token !== undefined ? { setupToken: token } : {}) });
async function complete(b: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}/api/v1/setup/complete`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
  return { status: r.status, json: await r.json() as Row };
}

test('a token is generated at start and stored only as a hash', async () => {
  const token = await initSetupToken(quietLog);
  assert.ok(token && token.length >= 30);
  assert.equal(settings['setupTokenHash'], hashSetupToken(token!));
  assert.ok(!JSON.stringify(settings).includes(token!));
  const status = await (await fetch(`${base}/api/v1/setup/status`)).json() as Row;
  assert.deepEqual(status, { setupRequired: true, setupTokenRequired: true, secretsFile: null, secretsGenerated: false });
});

test('setup without / with a wrong token is rejected', async () => {
  await initSetupToken(quietLog);
  assert.equal((await complete(body())).status, 403);
  assert.equal((await complete(body('wrong-token-wrong-token'))).status, 403);
  assert.equal(users.length, 0);
});

test('correct token → admin created (lowercased), token cleared, one-shot', async () => {
  const token = (await initSetupToken(quietLog))!;
  const ok = await complete(body(token));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(users.length, 1);
  assert.equal(users[0]!['email'], 'admin@example.com');
  assert.equal(users[0]!['role'], 'ORGANIZATION_MANAGEMENT');
  assert.ok(settings['setupCompletedAt'] instanceof Date);
  assert.equal(settings['setupTokenHash'], null);
  assert.equal((await complete(body(token))).status, 409);
});

test('header X-Setup-Token is accepted', async () => {
  const token = (await initSetupToken(quietLog))!;
  assert.equal((await complete(body(), { 'X-Setup-Token': token })).status, 200);
});

test('two concurrent setups → exactly one succeeds', async () => {
  const token = (await initSetupToken(quietLog))!;
  const results = await Promise.all([complete(body(token)), complete(body(token)), complete(body(token))]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409]);
  assert.equal(users.length, 1);
});

test('deleting all users never reopens setup', async () => {
  const token = (await initSetupToken(quietLog))!;
  assert.equal((await complete(body(token))).status, 200);
  users = [];
  const status = await (await fetch(`${base}/api/v1/setup/status`)).json() as Row;
  assert.equal(status['setupRequired'], false);
  assert.equal(await initSetupToken(quietLog), null, 'no new token once completed');
  assert.equal((await complete(body(token))).status, 409);
});

test('legacy installation (users, no flag) is backfilled as completed', async () => {
  users = [{ id: 'old', email: 'x@y.z' }];
  assert.equal(await initSetupToken(quietLog), null);
  assert.ok(settings['setupCompletedAt'] instanceof Date);
});

test('SETUP_TOKEN env replaces the generated token', async () => {
  const env = { SETUP_TOKEN: 'env-token-env-token-1234' };
  assert.equal(await initSetupToken(quietLog, env), null);
  assert.equal(await verifySetupToken('env-token-env-token-1234', env), true);
  assert.equal(await verifySetupToken('nope', env), false);
  assert.equal(await verifySetupToken(undefined, env), false);
});

// ── 10.4: wizard additions ──────────────────────────────────────────────────

async function verify(b: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}/api/v1/setup/verify-token`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
  return { status: r.status, text: await r.text() };
}

test('verify-token: missing / wrong token 403, right token 200, nothing changes', async () => {
  const token = (await initSetupToken(quietLog))!;
  const snapshot = JSON.stringify(settings);
  assert.equal((await verify({})).status, 403);
  assert.equal((await verify({ setupToken: 'wrong-token-wrong-token' })).status, 403);
  const ok = await verify({ setupToken: token });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { valid: true });
  assert.ok(!ok.text.includes(token), 'the token is never echoed');
  assert.equal((await verify({}, { 'X-Setup-Token': token })).status, 200, 'header accepted');
  assert.equal(JSON.stringify(settings), snapshot, 'verification is read-only (token stays usable)');
  assert.equal(users.length, 0);
  assert.equal((await complete(body(token))).status, 200, 'token still works for /complete');
});

test('verify-token is closed after completion (409), also for the old token', async () => {
  const token = (await initSetupToken(quietLog))!;
  assert.equal((await complete(body(token))).status, 200);
  assert.equal((await verify({ setupToken: token })).status, 409);
});

test('complete: host name, organisation and admin name are stored', async () => {
  const token = (await initSetupToken(quietLog))!;
  const r = await complete({ ...body(token), hostname: 'MX1.Example.com.', organizationName: '  Example GmbH ', displayName: 'Erika Admin' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(settings['publicHostname'], 'mx1.example.com');
  assert.equal(settings['imapHost'], 'mx1.example.com', 'derived URLs follow the host name');
  assert.equal(settings['orgName'], 'Example GmbH');
  assert.equal(users[0]!['displayName'], 'Erika Admin');
  assert.equal(r.json['hostname'], 'mx1.example.com');
  assert.equal(r.json['domain'], 'example.com');
  const raw = JSON.stringify(r.json);
  assert.ok(!raw.includes('supersecret1') && !raw.includes(token), 'no password / token in the answer');
});

test('complete: without host name → mail.<domain>, admin name defaults to Administrator', async () => {
  const token = (await initSetupToken(quietLog))!;
  assert.equal((await complete(body(token))).status, 200);
  assert.equal(settings['publicHostname'], 'mail.example.com');
  assert.equal(users[0]!['displayName'], 'Administrator');
  assert.equal(settings['orgName'], undefined, 'organisation name untouched when not given');
});

test('complete: an invalid host name is refused before anything is written', async () => {
  const token = (await initSetupToken(quietLog))!;
  for (const hostname of ['localhost', 'mail_x.example.com', 'http://mail.example.com', '-a.example.com']) {
    assert.equal((await complete({ ...body(token), hostname })).status, 400, hostname);
  }
  assert.equal(users.length, 0);
  assert.equal(settings['setupCompletedAt'], undefined, 'setup not claimed');
});

// ── 10.4: setup token file in the secrets directory + status fields ──────────

const posixModes = process.platform !== 'win32';
function capturingLog() {
  const lines: { obj: unknown; msg: string }[] = [];
  const push = (obj: unknown, msg?: string) => { lines.push({ obj, msg: msg ?? (typeof obj === 'string' ? obj : '') }); };
  return { lines, log: { info: push, warn: push } };
}
/** Points the route (process.env) and initSetupToken at a fresh secrets directory. */
function withSecretsDir(): { dir: string; env: NodeJS.ProcessEnv; restore: () => void } {
  const dir = mkdtempSync(join(scratchRoot, 'secrets-'));
  const prev = process.env['COREMAIL_SECRETS_DIR'];
  process.env['COREMAIL_SECRETS_DIR'] = dir;
  return { dir, env: { COREMAIL_SECRETS_DIR: dir }, restore: () => { process.env['COREMAIL_SECRETS_DIR'] = prev; } };
}

test('secrets directory: token goes to setup-token (0600), the log names the file and omits the token', async () => {
  const s = withSecretsDir();
  try {
    const { lines, log } = capturingLog();
    const token = (await initSetupToken(log, s.env))!;
    const file = join(s.dir, 'setup-token');
    assert.equal(readFileSync(file, 'utf8'), `${token}\n`);
    if (posixModes) assert.equal(statSync(file).mode & 0o777, 0o600);
    const logged = JSON.stringify(lines);
    assert.ok(!logged.includes(token), 'token not in the log');
    assert.match(logged, /CoreMail setup: open https:\/\/<host>\/setup — token in \.\/secrets\/setup-token/);
    assert.match(logged, /setup token/i, 'still found by grep -i "setup token"');
    assert.deepEqual(readdirSync(s.dir), ['setup-token'], 'no temp file left behind');
  } finally { s.restore(); }
});

test('secrets directory: a restart while pending replaces the file; completing the setup deletes it', async () => {
  const s = withSecretsDir();
  try {
    const first = (await initSetupToken(quietLog, s.env))!;
    const second = (await initSetupToken(quietLog, s.env))!;
    assert.notEqual(first, second);
    const file = join(s.dir, 'setup-token');
    assert.equal(readFileSync(file, 'utf8').trim(), second);
    assert.equal((await complete(body(first))).status, 403, 'the old token is dead');
    assert.equal(existsSync(file), true);
    assert.equal((await complete(body(second))).status, 200);
    assert.equal(existsSync(file), false, 'deleted after the setup');
  } finally { s.restore(); }
});

test('secrets directory: stale token files are removed (setup completed, legacy backfill, SETUP_TOKEN)', async () => {
  const s = withSecretsDir();
  try {
    const file = join(s.dir, 'setup-token');
    writeFileSync(file, 'stale\n');
    settings = { id: 'singleton', setupCompletedAt: new Date(), setupTokenHash: null };
    assert.equal(await initSetupToken(quietLog, s.env), null);
    assert.equal(existsSync(file), false);

    settings = {};
    users = [{ id: 'old', email: 'x@y.z' }];
    writeFileSync(file, 'stale\n');
    assert.equal(await initSetupToken(quietLog, s.env), null);
    assert.equal(existsSync(file), false);

    settings = {};
    users = [];
    writeFileSync(file, 'stale\n');
    assert.equal(await initSetupToken(quietLog, { ...s.env, SETUP_TOKEN: 'env-token-env-token-1234' }), null);
    assert.equal(existsSync(file), false, 'an env token replaces a file from an earlier start');
  } finally { s.restore(); }
});

test('without a secrets directory the token is logged as before', async () => {
  const { lines, log } = capturingLog();
  const token = (await initSetupToken(log))!;
  assert.match(JSON.stringify(lines), new RegExp(`"setupToken":"${token}"`));
  assert.equal(existsSync(join(process.env['COREMAIL_SECRETS_DIR']!, 'setup-token')), false);
});

test('status: secretsFile / secretsGenerated follow the entrypoint markers, never a value', async () => {
  const get = async () => (await (await fetch(`${base}/api/v1/setup/status`)).json()) as Row;
  try {
    process.env['COREMAIL_SECRETS_FILE_IN_USE'] = 'true';
    process.env['COREMAIL_SECRETS_GENERATED'] = 'true';
    let st = await get();
    assert.deepEqual(Object.keys(st).sort(), ['secretsFile', 'secretsGenerated', 'setupRequired', 'setupTokenRequired']);
    assert.equal(st['secretsFile'], './secrets/coremail.env');
    assert.equal(st['secretsGenerated'], true);

    process.env['COREMAIL_SECRETS_GENERATED'] = 'false';
    process.env['COREMAIL_SECRETS_HOST_PATH'] = '/volume1/docker/coremail/secrets/';
    st = await get();
    assert.equal(st['secretsFile'], '/volume1/docker/coremail/secrets/coremail.env');
    assert.equal(st['secretsGenerated'], false);

    process.env['COREMAIL_SECRETS_FILE_IN_USE'] = 'false';
    process.env['COREMAIL_SECRETS_GENERATED'] = 'true';
    st = await get();
    assert.equal(st['secretsFile'], null);
    assert.equal(st['secretsGenerated'], false, 'no file in use → nothing generated');
    assert.ok(!JSON.stringify(st).includes(process.env['JWT_SECRET']!));
  } finally {
    for (const k of ['COREMAIL_SECRETS_FILE_IN_USE', 'COREMAIL_SECRETS_GENERATED', 'COREMAIL_SECRETS_HOST_PATH']) delete process.env[k];
  }
});
