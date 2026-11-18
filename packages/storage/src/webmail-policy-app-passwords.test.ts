/**
 * Webmail policy (9.4), module "App-Passwörter" switched off: existing app
 * passwords stop working on every mail protocol (answered like a wrong
 * password — no oracle), the change ends live app-password connections, the
 * primary password and web sessions are not affected.
 * Infra-free (globalThis.__prisma / __authRedis).
 * Run: node --import tsx --import ./src/test-support/realtime-off.ts --test src/webmail-policy-app-passwords.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

const { createFakePrisma, createFakeRedis } = await import('./auth/testing.js');
const db = createFakePrisma();
const redis = createFakeRedis();
Object.assign(redis, { publish: async () => 1 });
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = null;

const core = await import('@coremail/core');
const wp = await import('./webmail-policy.js');
const pa = await import('./protocol-access.js');
const mailAuth = await import('./mail-auth.js');

const events: Array<{ userId: string; reason: string; appPasswordId?: string }> = [];
core.onAuthInvalidation((e) => { events.push(e); });
mailAuth.configureMailAuth({ redis: null });

const PW = 'correct horse battery';
const APP = 'abcd-efgh-ijkl-mnop';
const ctx = (protocol: 'imap' | 'smtp' | 'activesync' | 'caldav' = 'imap') => ({ ip: '203.0.113.9', protocol });

beforeEach(async () => {
  for (const t of ['user', 'domain', 'webmailPolicy', 'protocolPolicy', 'appPassword'] as const) db[t].rows = [];
  wp.invalidateWebmailPolicyCache();
  pa.invalidateProtocolAccessCache();
  events.length = 0;
  await db.domain.create({ data: { id: 'd1', name: 'one.test' } });
  await db.domain.create({ data: { id: 'd2', name: 'two.test' } });
  const [pwHash, appHash] = await Promise.all([core.hashPassword(PW), core.hashPassword(APP)]);
  for (const [id, email, domainId] of [['u1', 'a@one.test', 'd1'], ['u2', 'p@one.test', 'd1'], ['u3', 'b@two.test', 'd2']] as const) {
    await db.user.create({ data: { id, email, domainId, passwordHash: pwHash, displayName: email } });
    await db.appPassword.create({ data: { id: `ap-${id}`, userId: id, name: 'phone', hash: appHash } });
  }
});

test('module on (default): an app password logs in on the mail protocols', async () => {
  const r = await mailAuth.verifyMailCredentials('a@one.test', APP, ctx());
  assert.equal(r.status, 'ok');
  assert.equal(r.status === 'ok' && r.method, 'app_password');
});

test('module off: the app password is refused like a wrong password on every protocol, the primary password still works', async () => {
  await wp.updateWebmailPolicy({ level: 'user', userId: 'u1' }, { features: { appPasswords: 'off' } });
  const wrong = await mailAuth.verifyMailCredentials('a@one.test', 'not-the-password', ctx());
  for (const protocol of ['imap', 'smtp', 'activesync', 'caldav'] as const) {
    assert.deepEqual(await mailAuth.verifyMailCredentials('a@one.test', APP, ctx(protocol)), wrong, `${protocol}: same answer as a wrong password`);
  }
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', PW, ctx())).status, 'ok', 'primary password unaffected');
  assert.equal((await mailAuth.verifyMailCredentials('p@one.test', APP, ctx())).status, 'ok', 'other accounts unaffected');
});

test('no oracle: with the protocol switched off too, a disabled app password still reads as invalid', async () => {
  await db.protocolPolicy.create({ data: { userId: 'u1', imap: 'OFF' } });
  await wp.updateWebmailPolicy({ level: 'user', userId: 'u1' }, { features: { appPasswords: 'off' } });
  assert.deepEqual(await mailAuth.verifyMailCredentials('a@one.test', APP, ctx('imap')), { status: 'invalid' });
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', PW, ctx('imap'))).status, 'protocol_disabled');
});

test('an unreadable policy is a temporary failure for app passwords, never "allowed"', async () => {
  const original = db.webmailPolicy.findMany.bind(db.webmailPolicy);
  db.webmailPolicy.findMany = async () => { throw new Error('db down'); };
  try {
    assert.equal((await mailAuth.verifyMailCredentials('a@one.test', APP, ctx())).status, 'error');
  } finally {
    db.webmailPolicy.findMany = original;
  }
});

test('switching the module off ends live app-password connections of exactly the affected accounts', async () => {
  await db.webmailPolicy.create({ data: { userId: 'u2', appPasswords: 'ON' } });
  const r = await wp.updateWebmailPolicy({ level: 'domain', domainId: 'd1' }, { features: { appPasswords: 'off' } });
  assert.equal(r?.appPasswordsDisabled, 1);
  assert.deepEqual(events.map((e) => [e.userId, e.reason, e.appPasswordId]), [['u1', wp.APP_PASSWORDS_DISABLED_REASON, undefined]],
    'u2 keeps the module (user level on), u3 is in another domain');

  const event = events[0]!;
  const conn = (credential: 'app_password' | 'password' | 'token') =>
    ({ userId: 'u1', credential, appPasswordId: credential === 'app_password' ? 'ap-u1' : undefined, sessionId: 's1', issuedAt: 1, terminate: () => undefined });
  assert.equal(core.connectionAffected(event as never, conn('app_password') as never), true, 'app-password IMAP/SMTP/EAS sessions end');
  assert.equal(core.connectionAffected(event as never, conn('password') as never), false, 'primary-password sessions stay');
  assert.equal(core.connectionAffected(event as never, conn('token') as never), false, 'web sessions stay');

  events.length = 0;
  const again = await wp.updateWebmailPolicy({ level: 'domain', domainId: 'd1' }, { features: { appPasswords: 'off' } });
  assert.equal(again?.appPasswordsDisabled, 0);
  assert.equal(events.length, 0, 'no event without a change');
});

test('switching the module on again: no event, app passwords work again at once', async () => {
  await wp.updateWebmailPolicy({ level: 'global' }, { features: { appPasswords: 'off' } });
  assert.deepEqual(events.map((e) => e.userId).sort(), ['u1', 'u2', 'u3'], 'server level reaches every account');
  assert.equal((await mailAuth.verifyMailCredentials('b@two.test', APP, ctx())).status, 'invalid');
  events.length = 0;
  await wp.updateWebmailPolicy({ level: 'global' }, { features: { appPasswords: 'on' } });
  assert.equal(events.length, 0);
  assert.equal((await mailAuth.verifyMailCredentials('b@two.test', APP, ctx())).status, 'ok');
});

test('other module changes send no auth event', async () => {
  await wp.updateWebmailPolicy({ level: 'global' }, { features: { calendar: 'off' }, content: { blockedExtensions: ['exe'] } });
  assert.equal(events.length, 0);
});

test('appPasswordsSwitchedOff (pure): only on → off counts', () => {
  const p = (on: boolean) => ({ features: { ...wp.FEATURE_DEFAULTS, appPasswords: on }, content: { ...wp.CONTENT_DEFAULTS } }) as never;
  const users = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const before = new Map([['a', p(true)], ['b', p(false)], ['c', p(true)]]);
  const after = new Map([['a', p(false)], ['b', p(false)], ['c', p(true)], ['d', p(false)]]);
  assert.deepEqual(wp.appPasswordsSwitchedOff(users, before, after), ['a']);
});
