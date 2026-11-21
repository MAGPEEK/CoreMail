/**
 * 10.6: self-registration — the public routes (/auth/register) and the BCP
 * routes (/api/v1/admin/self-registration). Off → 404, allowed domains,
 * uniform answer for reserved and taken addresses, per-IP budget, honeypot,
 * form token (minimum fill time), approval vs immediate, invite codes (expiry,
 * uses, revoke), role USER only, audit rows, shared lockout, admin approve /
 * reject / scope.
 * Express app on an ephemeral loopback port; Prisma via globalThis.__prisma
 * (storage auth/testing fakes), Redis via globalThis.__authRedis.
 * Run: node --import tsx --test --test-force-exit src/routes/self-registration.test.ts  (in packages/api-gateway)
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

const testing = await import('@coremail/storage/auth/testing');
const { createFakePrisma, createFakeRedis, FakeTable } = testing;
const db = createFakePrisma();
const redis = createFakeRedis();
Object.assign(redis, { publish: async () => 1 });
const t = db as unknown as Record<string, unknown>;
t['sharedMailbox'] = new FakeTable(() => ({}), ['id', 'email']);
t['emailAlias'] = new FakeTable(() => ({}), ['id', 'address']);
t['selfRegistration'] = new FakeTable(() => ({ status: 'PENDING', ipAddress: '', inviteId: null, createdAt: new Date(), decidedAt: null, decidedBy: null }), ['id', 'userId']);
t['selfRegistrationInvite'] = new FakeTable(() => ({
  label: '', codeHint: '', expiresAt: null, maxUses: 1, uses: 0, revokedAt: null, createdById: null, createdBy: '', createdAt: new Date(),
}), ['id', 'codeHash']);
const auditRows: Record<string, unknown>[] = [];
t['auditLog'] = { create: async (a: { data: Record<string, unknown> }) => { auditRows.push(a.data); return a.data; } };
t['$transaction'] = (fn: (tx: unknown) => unknown) => fn(db);
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const securityEvents: Array<{ type: string; ip: string; detail: Record<string, unknown> }> = [];
const storage = await import('@coremail/storage');
storage.setSecurityEventRecorder(storage.createSecurityEventRecorder({
  perIpPerMinute: 100_000, globalPerMinute: 100_000,
  sink: { write: async (row) => { securityEvents.push(row); } },
}));
// a quick IP lock (3 failures) and no attack-protection side effects
storage.configureMailAuth({ limits: { ipMaxFailures: 3 }, onLockoutEvent: () => undefined });

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { selfRegistrationRouter, REGISTER_LIMITS } = await import('./self-registration.js');
const { adminSelfRegistrationRouter } = await import('./admin/self-registration.js');
const lib = await import('../lib/self-registration.js');
const notify = await import('../lib/self-registration-notify.js');
const { clearCurrentRoleCache } = await import('../middleware/auth.js');

const notices: Array<{ email: string; domain: string }> = [];
notify.setRegistrationNotifier(async (n) => { notices.push(n); });

const PW = 'a long enough password';
let server: Server;
let base = '';
let ipSeq = 0;
let ip = '203.0.113.1';

before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/auth/register', selfRegistrationRouter);
  app.use('/api/v1/admin/self-registration', adminSelfRegistrationRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

beforeEach(async () => {
  for (const name of ['user', 'serverSettings', 'domain', 'mailbox', 'folder', 'calendar', 'adminScope', 'session',
    'sharedMailbox', 'emailAlias', 'selfRegistration', 'selfRegistrationInvite'] as const) {
    (t[name] as { rows: unknown[] }).rows = [];
  }
  redis.store.clear();
  auditRows.length = 0;
  securityEvents.length = 0;
  notices.length = 0;
  clearCurrentRoleCache();
  ip = `203.0.113.${++ipSeq}`;
  await db.domain.create({ data: { id: 'dA', name: 'a.example', primary: true } });
  await db.domain.create({ data: { id: 'dB', name: 'b.example' } });
  await db.domain.create({ data: { id: 'dC', name: 'c.example' } });
  await db.user.create({ data: { id: 'org', email: 'org@a.example', role: 'ORGANIZATION_MANAGEMENT', domainId: 'dA' } });
  await db.user.create({ data: { id: 'rmA', email: 'rm@a.example', role: 'RECIPIENT_MANAGEMENT', domainId: 'dA' } });
  await db.user.create({ data: { id: 'hd', email: 'hd@a.example', role: 'HELP_DESK', domainId: 'dA' } });
  await db.adminScope.create({ data: { userId: 'rmA', domainId: 'dA', domain: { id: 'dA', name: 'a.example' } } });
});

async function enable(over: Record<string, unknown> = {}): Promise<void> {
  await db.serverSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', allowSelfRegistration: true, selfRegistrationDomainIds: ['dA', 'dB'], selfRegistrationMode: 'approval', selfRegistrationInviteOnly: false, ...over },
    update: { allowSelfRegistration: true, selfRegistrationDomainIds: ['dA', 'dB'], selfRegistrationMode: 'approval', selfRegistrationInviteOnly: false, ...over },
  });
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json', 'X-Forwarded-For': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** A form token issued 10 s ago (passes the minimum fill time). */
const oldToken = (): string => lib.issueFormToken(Date.now() - 10_000);

function form(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { domainId: 'dA', displayName: 'Erika Muster', localPart: 'erika', password: PW, website: '', formToken: oldToken(), ...over };
}

const tok = (id: string) => {
  const u = db.user.rows.find((r) => r['id'] === id)!;
  return core.signAccessToken({
    sub: id, email: String(u['email']), role: u['role'] as Parameters<typeof core.signAccessToken>[0]['role'],
    domainId: String(u['domainId']), sessionId: `${id}-s`, mfaVerified: true,
  });
};

// ── switched off ─────────────────────────────────────────────────────────────

test('off (default, also on existing installs): config and register answer 404', async () => {
  assert.equal((await call('GET', '/auth/register/config')).status, 404);
  assert.equal((await call('POST', '/auth/register', form())).status, 404);
  await db.serverSettings.create({ data: { id: 'singleton' } });
  assert.equal((await call('GET', '/auth/register/config')).status, 404, 'a settings row without the new columns is off');
  assert.equal(db.user.rows.length, 3, 'nothing created');
});

test('on without an allowed domain: still 404 (registration impossible)', async () => {
  await enable({ selfRegistrationDomainIds: [] });
  assert.equal((await call('GET', '/auth/register/config')).status, 404);
  assert.equal((await call('POST', '/auth/register', form())).status, 404);
  // an allowed domain that is inactive does not count either
  await enable({ selfRegistrationDomainIds: ['dA'] });
  await db.domain.update({ where: { id: 'dA' }, data: { active: false } });
  assert.equal((await call('GET', '/auth/register/config')).status, 404);
});

test('config lists only the allowed active domains and what the form needs', async () => {
  await enable({ selfRegistrationInviteOnly: true });
  const r = await call('GET', '/auth/register/config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body['domains'], [{ id: 'dA', name: 'a.example' }, { id: 'dB', name: 'b.example' }]);
  assert.equal(r.body['inviteRequired'], true);
  assert.equal(r.body['mode'], 'approval');
  assert.equal(typeof r.body['formToken'], 'string');
  assert.equal(r.body['minPasswordLength'], 8);
  assert.equal(Object.keys(r.body).sort().join(','), 'domains,enabled,formToken,inviteRequired,minPasswordLength,mode');
});

// ── approval vs immediate ────────────────────────────────────────────────────

test('approval mode: inactive USER account, mailbox provisioned, audit + one admin notice', async () => {
  await enable();
  const r = await call('POST', '/auth/register', form());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body, { status: 'pending', email: 'erika@a.example' });
  const u = db.user.rows.find((x) => x['email'] === 'erika@a.example')!;
  assert.equal(u['active'], false);
  assert.equal(u['role'], 'USER');
  assert.equal(u['authSource'], 'LOCAL');
  assert.equal(u['domainId'], 'dA');
  assert.ok(typeof u['passwordHash'] === 'string' && u['passwordHash'] !== PW);
  assert.ok(await core.verifyPassword(PW, String(u['passwordHash'])), 'hashed with hashPassword (pepper)');
  assert.equal(db.mailbox.rows.filter((m) => m['userId'] === u['id']).length, 1);
  assert.equal(db.folder.rows.length, 6);
  assert.equal(db.calendar.rows.length, 1);
  const reg = (t['selfRegistration'] as { rows: Record<string, unknown>[] }).rows[0]!;
  assert.equal(reg['status'], 'PENDING');
  assert.equal(reg['ipAddress'], ip);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(auditRows.map((a) => a['action']), ['auth.register.pending']);
  assert.equal(auditRows[0]!['targetName'], 'erika@a.example');
  assert.deepEqual(notices, [{ email: 'erika@a.example', domain: 'a.example' }]);
  // a second registration within 15 minutes sends no second notice
  await call('POST', '/auth/register', form({ localPart: 'max' }));
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(notices.length, 1);
});

test('immediate mode: the account is active at once, no admin notice', async () => {
  await enable({ selfRegistrationMode: 'immediate' });
  const r = await call('POST', '/auth/register', form({ domainId: 'dB', localPart: 'Max.Mustermann' }));
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { status: 'active', email: 'max.mustermann@b.example' });
  const u = db.user.rows.find((x) => x['email'] === 'max.mustermann@b.example')!;
  assert.equal(u['active'], true);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(auditRows.map((a) => a['action']), ['auth.register.active']);
  assert.equal(notices.length, 0);
});

test('no admin role, quota, auth source or state from the request body', async () => {
  await enable();
  const r = await call('POST', '/auth/register', form({
    role: 'ORGANIZATION_MANAGEMENT', active: true, quotaBytes: 1e15, authSource: 'LDAP', email: 'root@a.example',
  }));
  assert.equal(r.status, 201);
  const u = db.user.rows.find((x) => x['email'] === 'erika@a.example')!;
  assert.equal(u['role'], 'USER');
  assert.equal(u['active'], false, 'approval mode stays inactive');
  assert.equal(u['authSource'], 'LOCAL');
  assert.equal(u['quotaBytes'], undefined, 'quota = schema / server default');
  assert.ok(!db.user.rows.some((x) => x['email'] === 'root@a.example'));
});

// ── refusals ─────────────────────────────────────────────────────────────────

test('domain not allowed → 400 DOMAIN_NOT_ALLOWED, counted as abuse', async () => {
  await enable();
  const r = await call('POST', '/auth/register', form({ domainId: 'dC' }));
  assert.equal(r.status, 400);
  assert.equal(r.body['code'], 'DOMAIN_NOT_ALLOWED');
  assert.equal(db.user.rows.length, 3);
  assert.ok(securityEvents.some((e) => e.type === 'REGISTRATION_ABUSE' && e.detail['reason'] === 'domain-not-allowed'));
});

test('reserved and taken addresses get the same answer', async () => {
  await enable();
  await db.user.create({ data: { email: 'taken@a.example', domainId: 'dA' } });
  await (t['sharedMailbox'] as InstanceType<typeof FakeTable>).create({ data: { email: 'team@a.example', domainId: 'dA' } });
  await (t['emailAlias'] as InstanceType<typeof FakeTable>).create({ data: { address: 'alias@a.example', domainId: 'dA' } });
  const answers = [];
  for (const lp of ['postmaster', 'Admin', 'no.reply', 'mailer-daemon', 'taken', 'TEAM', 'alias']) {
    const r = await call('POST', '/auth/register', form({ localPart: lp }));
    answers.push(JSON.stringify([r.status, r.body]));
  }
  assert.equal(new Set(answers).size, 1, answers.join('\n'));
  assert.equal(JSON.parse(answers[0]!)[0], 409);
  assert.equal(JSON.parse(answers[0]!)[1]['code'], 'ADDRESS_UNAVAILABLE');
  assert.equal(db.user.rows.length, 4, 'nothing created');
});

test('invalid local part, name and password policy are refused before the address check', async () => {
  await enable();
  for (const lp of ['', 'a b', 'x+y', '.dot', 'dot.', 'a..b', 'ümlaut', 'x'.repeat(65), 'a@b']) {
    const r = await call('POST', '/auth/register', form({ localPart: lp }));
    assert.equal(r.body['code'], 'INVALID_LOCAL_PART', lp);
  }
  ip = '198.51.100.30'; // fresh hourly budget
  assert.equal((await call('POST', '/auth/register', form({ displayName: '  ' }))).body['code'], 'INVALID_NAME');
  assert.equal((await call('POST', '/auth/register', form({ password: 'short' }))).body['code'], 'PASSWORD_POLICY');
});

test('per-IP budget: the 11th attempt in an hour is 429', async () => {
  await enable();
  for (let i = 0; i < REGISTER_LIMITS.perIpPerHour; i++) {
    const r = await call('POST', '/auth/register', form({ localPart: `user${i}` }));
    assert.equal(r.status, 201, `attempt ${i}`);
  }
  const r = await call('POST', '/auth/register', form({ localPart: 'one-more' }));
  assert.equal(r.status, 429);
  assert.equal(r.body['code'], 'RATE_LIMITED');
  assert.ok(securityEvents.some((e) => e.detail['reason'] === 'rate-limit'));
  ip = '203.0.113.250';
  assert.equal((await call('POST', '/auth/register', form({ localPart: 'other-ip' }))).status, 201, 'another IP has its own budget');
});

test('honeypot filled → 400 INVALID_FORM, nothing created, counted for the IP', async () => {
  await enable();
  const r = await call('POST', '/auth/register', form({ website: 'http://spam.test' }));
  assert.equal(r.status, 400);
  assert.equal(r.body['code'], 'INVALID_FORM');
  assert.equal(db.user.rows.length, 3);
  assert.ok(securityEvents.some((e) => e.detail['reason'] === 'honeypot'));
});

test('form token: too fast, forged and missing are refused', async () => {
  await enable();
  const fast = await call('POST', '/auth/register', form({ formToken: lib.issueFormToken(Date.now() + 60_000) }));
  assert.equal(fast.body['code'], 'INVALID_FORM');
  assert.ok(securityEvents.some((e) => e.detail['reason'] === 'form-too-fast'));
  const old = oldToken(); const cut = old.lastIndexOf('.') + 1;
  const forged = old.slice(0, cut) + (old[cut] === 'A' ? 'B' : 'A') + old.slice(cut + 1); // first signature char: never only padding bits
  assert.equal((await call('POST', '/auth/register', form({ formToken: forged }))).body['code'], 'INVALID_FORM');
  const expired = lib.issueFormToken(Date.now() - lib.FORM_TOKEN_TTL_MS - 1000);
  assert.equal((await call('POST', '/auth/register', form({ formToken: expired }))).body['code'], 'INVALID_FORM');
  assert.equal(lib.checkFormToken('x.y.z'), 'invalid');
  assert.equal(lib.checkFormToken(undefined), 'invalid');
});

test('abuse signals lock the client IP through the shared lockout (429 before any work)', async () => {
  await enable();
  for (let i = 0; i < 3; i++) await call('POST', '/auth/register', form({ website: 'bot' }));
  const r = await call('POST', '/auth/register', form({ localPart: 'legit' }));
  assert.equal(r.status, 429);
  assert.equal(r.body['code'], 'RATE_LIMITED');
  assert.equal(db.user.rows.length, 3);
  assert.ok(securityEvents.some((e) => e.detail['reason'] === 'ip-locked'));
});

// ── invite codes ─────────────────────────────────────────────────────────────

test('invite codes: required, single use, expiry, revoke; created by the BCP and shown once', async () => {
  await enable({ selfRegistrationInviteOnly: true });
  const admin = tok('org');
  const created = await call('POST', '/api/v1/admin/self-registration/invites', { label: 'Team', expiresInDays: 7, maxUses: 1 }, admin);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const code = String(created.body['code']);
  assert.match(code, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  const stored = (t['selfRegistrationInvite'] as { rows: Record<string, unknown>[] }).rows[0]!;
  assert.notEqual(stored['codeHash'], code);
  assert.ok(!JSON.stringify(stored).includes(code), 'the code itself is never stored');
  const list = await call('GET', '/api/v1/admin/self-registration/invites', undefined, admin);
  assert.ok(!JSON.stringify(list.body).includes(code), 'the list never shows the code');
  assert.equal((list.body['invites'] as Array<Record<string, unknown>>)[0]!['status'], 'active');

  // without / with a wrong code
  assert.equal((await call('POST', '/auth/register', form())).body['code'], 'INVITE_INVALID');
  assert.equal((await call('POST', '/auth/register', form({ inviteCode: 'AAAA-BBBB-CCCC-DDDD' }))).body['code'], 'INVITE_INVALID');
  // the code works once (dashes / case do not matter) …
  ip = '198.51.100.7';
  const ok = await call('POST', '/auth/register', form({ inviteCode: code.toLowerCase().replace(/-/g, ' ') }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(stored['uses'], 1);
  // … and not a second time
  const again = await call('POST', '/auth/register', form({ localPart: 'second', inviteCode: code }));
  assert.equal(again.body['code'], 'INVITE_INVALID');
  // an address probe without a valid code never reaches the address check
  assert.equal((await call('POST', '/auth/register', form({ localPart: 'postmaster', inviteCode: code }))).body['code'], 'INVITE_INVALID');

  // expiry
  const c2 = await call('POST', '/api/v1/admin/self-registration/invites', { maxUses: 5 }, admin);
  const row2 = (t['selfRegistrationInvite'] as { rows: Record<string, unknown>[] }).rows[1]!;
  row2['expiresAt'] = new Date(Date.now() - 1000);
  ip = '198.51.100.8';
  assert.equal((await call('POST', '/auth/register', form({ localPart: 'late', inviteCode: c2.body['code'] }))).body['code'], 'INVITE_INVALID');
  // revoke
  const c3 = await call('POST', '/api/v1/admin/self-registration/invites', { maxUses: 5 }, admin);
  const id3 = String((c3.body['invite'] as Record<string, unknown>)['id']);
  assert.equal((await call('DELETE', `/api/v1/admin/self-registration/invites/${id3}`, undefined, admin)).status, 200);
  ip = '198.51.100.9';
  assert.equal((await call('POST', '/auth/register', form({ localPart: 'revoked', inviteCode: c3.body['code'] }))).body['code'], 'INVITE_INVALID');
  await new Promise((res) => setTimeout(res, 20));
  const actions = auditRows.map((a) => a['action']);
  assert.equal(actions.filter((a) => a === 'settings.self-registration.invite.create').length, 3);
  assert.ok(actions.includes('settings.self-registration.invite.revoke'));
  assert.ok(actions.includes('auth.register.pending'));
});

test('invite code helpers', () => {
  const c = lib.generateInviteCode();
  assert.equal(lib.hashInviteCode(c), lib.hashInviteCode(c.toLowerCase().replace(/-/g, '')));
  assert.equal(lib.normalizeInviteCode('a b'), '');
  const base = { id: 'x', expiresAt: null, maxUses: 2, uses: 0, revokedAt: null };
  assert.equal(lib.inviteStatus(base), 'active');
  assert.equal(lib.inviteStatus({ ...base, uses: 2 }), 'used');
  assert.equal(lib.inviteStatus({ ...base, expiresAt: new Date(0) }), 'expired');
  assert.equal(lib.inviteStatus({ ...base, revokedAt: new Date() }), 'revoked');
});

// ── BCP: settings, approvals, scope ──────────────────────────────────────────

test('BCP settings: org-wide recipients admins only, validated, audited under settings.', async () => {
  const admin = tok('org');
  const r0 = await call('GET', '/api/v1/admin/self-registration/settings', undefined, admin);
  assert.equal(r0.status, 200);
  assert.equal(r0.body['enabled'], false, 'default off');
  assert.equal(r0.body['mode'], 'approval');
  assert.equal((await call('PUT', '/api/v1/admin/self-registration/settings', { domainIds: ['nope'] }, admin)).body['code'], 'UNKNOWN_DOMAIN');
  assert.equal((await call('PUT', '/api/v1/admin/self-registration/settings', { mode: 'open' }, admin)).status, 400);
  const r = await call('PUT', '/api/v1/admin/self-registration/settings', { enabled: true, domainIds: ['dA'], mode: 'immediate' }, admin);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body['enabled'], r.body['domainIds'], r.body['mode'], r.body['inviteOnly']], [true, ['dA'], 'immediate', false]);
  await new Promise((res) => setTimeout(res, 20));
  const a = auditRows.find((x) => x['action'] === 'settings.self-registration.update')!;
  assert.ok(a);
  assert.deepEqual(Object.keys(a['changes'] as object).sort(), ['domainIds', 'enabled', 'mode']);
  // a scoped admin and a read-only role
  assert.equal((await call('GET', '/api/v1/admin/self-registration/settings', undefined, tok('rmA'))).status, 403);
  assert.equal((await call('PUT', '/api/v1/admin/self-registration/settings', { enabled: false }, tok('hd'))).status, 403);
  assert.equal((await call('POST', '/api/v1/admin/self-registration/invites', {}, tok('rmA'))).status, 403);
  // a USER account never reaches the router
  await db.user.create({ data: { id: 'plain', email: 'plain@a.example', domainId: 'dA' } });
  assert.equal((await call('GET', '/api/v1/admin/self-registration/pending', undefined, tok('plain'))).status, 403);
});

test('BCP approvals: list filtered by scope, approve activates, reject deletes, both audited', async () => {
  await enable();
  ip = '198.51.100.20';
  await call('POST', '/auth/register', form({ localPart: 'anna' }));
  await call('POST', '/auth/register', form({ localPart: 'bert', domainId: 'dB' }));
  const anna = db.user.rows.find((u) => u['email'] === 'anna@a.example')!;
  const bert = db.user.rows.find((u) => u['email'] === 'bert@b.example')!;

  const all = await call('GET', '/api/v1/admin/self-registration/pending', undefined, tok('org'));
  assert.deepEqual((all.body['pending'] as Array<Record<string, unknown>>).map((p) => p['email']).sort(), ['anna@a.example', 'bert@b.example']);
  const scoped = await call('GET', '/api/v1/admin/self-registration/pending', undefined, tok('rmA'));
  assert.deepEqual((scoped.body['pending'] as Array<Record<string, unknown>>).map((p) => p['email']), ['anna@a.example']);
  // read-only role sees the list but cannot decide
  assert.equal((await call('GET', '/api/v1/admin/self-registration/pending', undefined, tok('hd'))).status, 200);
  assert.equal((await call('POST', `/api/v1/admin/self-registration/pending/${String(anna['id'])}/approve`, {}, tok('hd'))).status, 403);
  // out of scope → 404 like an unknown id
  assert.equal((await call('POST', `/api/v1/admin/self-registration/pending/${String(bert['id'])}/approve`, {}, tok('rmA'))).status, 404);
  assert.equal((await call('POST', '/api/v1/admin/self-registration/pending/unknown/approve', {}, tok('org'))).status, 404);

  const ap = await call('POST', `/api/v1/admin/self-registration/pending/${String(anna['id'])}/approve`, {}, tok('rmA'));
  assert.equal(ap.status, 200);
  assert.equal(anna['active'], true);
  const reg = (t['selfRegistration'] as { rows: Record<string, unknown>[] }).rows.find((r) => r['userId'] === anna['id'])!;
  assert.equal(reg['status'], 'APPROVED');
  assert.equal(reg['decidedBy'], 'rm@a.example');
  assert.equal((await call('POST', `/api/v1/admin/self-registration/pending/${String(anna['id'])}/approve`, {}, tok('org'))).status, 404, 'only once');

  const rj = await call('POST', `/api/v1/admin/self-registration/pending/${String(bert['id'])}/reject`, {}, tok('org'));
  assert.equal(rj.status, 200);
  assert.ok(!db.user.rows.some((u) => u['id'] === bert['id']), 'account deleted');
  // an approved account can no longer be "rejected"
  assert.equal((await call('POST', `/api/v1/admin/self-registration/pending/${String(anna['id'])}/reject`, {}, tok('org'))).status, 404);
  // an admin account is never treated as a pending registration
  (t['selfRegistration'] as InstanceType<typeof FakeTable>).rows.push({ id: 'fake', userId: 'hd', domainId: 'dA', status: 'PENDING' });
  assert.equal((await call('POST', '/api/v1/admin/self-registration/pending/hd/reject', {}, tok('org'))).status, 404);
  assert.ok(db.user.rows.some((u) => u['id'] === 'hd'));

  await new Promise((res) => setTimeout(res, 20));
  const actions = auditRows.map((a) => a['action']);
  assert.ok(actions.includes('auth.register.approve'));
  assert.ok(actions.includes('auth.register.reject'));
});

test('address rules', () => {
  assert.equal(lib.normalizeLocalPart(' Erika.Muster '), 'erika.muster');
  assert.equal(lib.normalizeLocalPart('a'), 'a');
  assert.equal(lib.normalizeLocalPart('a_b-c.d'), 'a_b-c.d');
  for (const bad of ['', '-a', 'a-', 'a.-b', 'a b', 'a+b', 'é']) assert.equal(lib.normalizeLocalPart(bad), null, bad);
  for (const r of ['postmaster', 'abuse', 'admin', 'administrator', 'root', 'hostmaster', 'webmaster', 'noreply', 'no-reply',
    'mailer-daemon', 'security', 'support', 'info', 'no_reply', 'post.master']) {
    assert.equal(lib.isReservedLocalPart(r), true, r);
  }
  assert.equal(lib.isReservedLocalPart('erika'), false);
  assert.equal(lib.normalizeDisplayName('  A   B '), 'A B');
  assert.equal(lib.normalizeDisplayName('<script>'), null);
  assert.deepEqual(lib.settingsFromRow({ allowSelfRegistration: true, selfRegistrationMode: 'weird' }).mode, 'approval');
});
