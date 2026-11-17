/**
 * Per-protocol access switches (9.4): resolution, caching + invalidation,
 * change events, mail-protocol and web enforcement.
 * Infra-free: Prisma via globalThis.__prisma, Redis via globalThis.__authRedis.
 * Run: node --import tsx --test src/protocol-access.test.ts  (in packages/storage)
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
const published: Array<[string, string]> = [];
Object.assign(redis, { publish: async (channel: string, message: string) => { published.push([channel, message]); return 1; } });
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = null;

const core = await import('@coremail/core');
const pa = await import('./protocol-access.js');
const mailAuth = await import('./mail-auth.js');
const auth = await import('./auth/index.js');

const events: Array<{ userId: string; reason: string; disabledProtocols?: string[] }> = [];
core.onAuthInvalidation((e) => { events.push(e); });

const PW = 'correct horse battery';
let pwHash = '';
mailAuth.configureMailAuth({ redis: null });

async function addUser(email: string, domainId: string, extra: Record<string, unknown> = {}) {
  pwHash ||= await core.hashPassword(PW);
  return db.user.create({ data: { email, domainId, passwordHash: pwHash, displayName: email, ...extra } });
}
const off = (...protocols: string[]) => Object.fromEntries(protocols.map((p) => [p, 'off'])) as Record<string, 'off'>;

beforeEach(async () => {
  for (const t of ['user', 'domain', 'protocolPolicy', 'serverSettings', 'session', 'userMfa', 'appPassword'] as const) db[t].rows = [];
  pa.invalidateProtocolAccessCache();
  events.length = 0;
  published.length = 0;
  await db.domain.create({ data: { id: 'd1', name: 'one.test' } });
  await db.domain.create({ data: { id: 'd2', name: 'two.test' } });
});

// ── Pure resolution ───────────────────────────────────────────────────────────

test('defaults: every existing protocol on, MAPI off', () => {
  const a = pa.resolveProtocolAccess([]);
  assert.deepEqual(pa.disabledProtocols(a), ['mapi']);
  assert.equal(a.imap && a.pop3 && a.smtp && a.activesync && a.jmap && a.dav && a.webmail, true);
});

test('the most specific non-inherit level wins', () => {
  const g = { ...pa.inheritAll(), imap: 'off' as const, mapi: 'on' as const };
  const d = { ...pa.inheritAll(), imap: 'on' as const, pop3: 'off' as const };
  const u = { ...pa.inheritAll(), pop3: 'on' as const, mapi: 'off' as const };
  const a = pa.resolveProtocolAccess([g, d, u]);
  assert.equal(a.imap, true, 'domain on over server off');
  assert.equal(a.pop3, true, 'user on over domain off');
  assert.equal(a.mapi, false, 'user off over server on');
  assert.equal(pa.resolveProtocolAccess([g, d]).pop3, false);
  assert.equal(pa.resolveProtocolAccess([g]).imap, false);
});

test('input guards accept only known protocols and settings', () => {
  assert.equal(pa.isAccessProtocol('imap'), true);
  assert.equal(pa.isAccessProtocol('ews'), false);
  assert.equal(pa.isProtocolSetting('inherit'), true);
  assert.equal(pa.isProtocolSetting('ON'), false);
});

// ── Effective access ──────────────────────────────────────────────────────────

test('effective access: server → domain → user; JMAP server level = ServerSettings.jmapEnabled', async () => {
  const a = await addUser('a@one.test', 'd1');
  const b = await addUser('b@two.test', 'd2');
  await db.serverSettings.create({ data: { id: 'singleton', jmapEnabled: false } });
  await db.protocolPolicy.create({ data: { id: 'global', imap: 'OFF', jmap: 'ON' } });
  await db.protocolPolicy.create({ data: { domainId: 'd1', imap: 'ON' } });
  await db.protocolPolicy.create({ data: { userId: b['id'], jmap: 'ON' } });
  const ea = await pa.effectiveProtocolAccess(String(a['id']));
  const eb = await pa.effectiveProtocolAccess({ id: String(b['id']), domainId: 'd2' });
  assert.equal(ea.imap, true);
  assert.equal(eb.imap, false);
  assert.equal(ea.jmap, false, 'the global row jmap column is ignored — jmapEnabled decides');
  assert.equal(eb.jmap, true, 'a user switch turns JMAP on below a disabled server level');
  assert.deepEqual(pa.disabledProtocols(await pa.effectiveProtocolAccess('nobody')), [...pa.ACCESS_PROTOCOLS]);
});

test('results are cached and dropped on an auth invalidation event of the user', async () => {
  const u = await addUser('a@one.test', 'd1');
  const id = String(u['id']);
  assert.equal(await pa.isProtocolAllowed(id, 'pop3'), true);
  await db.protocolPolicy.create({ data: { userId: id, pop3: 'OFF' } });
  assert.equal(await pa.isProtocolAllowed(id, 'pop3'), true, 'cached');
  await core.publishAuthInvalidation({ userId: id, reason: 'role-change' }, { redis: null });
  assert.equal(await pa.isProtocolAllowed(id, 'pop3'), false);
});

test('domainProtocolAccess (anonymous) uses server + domain level, never a user level', async () => {
  const u = await addUser('a@one.test', 'd1');
  await db.protocolPolicy.create({ data: { domainId: 'd1', activesync: 'OFF' } });
  await db.protocolPolicy.create({ data: { userId: u['id'], imap: 'OFF' } });
  const one = await pa.domainProtocolAccess('One.Test');
  assert.equal(one.activesync, false);
  assert.equal(one.imap, true);
  assert.equal((await pa.domainProtocolAccess('unknown.test')).activesync, true, 'foreign domain → server level');
});

test('domainProtocolAccess: anonymous lookups resolve from one cached index, whatever the domain name', async () => {
  await db.protocolPolicy.create({ data: { domainId: 'd2', pop3: 'OFF' } });
  const reads = { policies: 0, other: 0 };
  const policyFindMany = db.protocolPolicy.findMany;
  const domainFindUnique = db.domain.findUnique;
  db.protocolPolicy.findMany = async (args) => { reads.policies++; return policyFindMany(args); };
  db.domain.findUnique = async (args) => { reads.other++; return domainFindUnique(args); };
  try {
    for (let i = 0; i < 20; i++) await pa.domainProtocolAccess(`random-${i}.example`);
    assert.equal((await pa.domainProtocolAccess('TWO.test')).pop3, false);
    assert.deepEqual(reads, { policies: 1, other: 0 }, 'one index load for every name, no per-name query');

    // A change of the domain level drops the index (other processes: CHANNEL_SETTINGS_RELOAD).
    await pa.updateProtocolSettings({ level: 'domain', domainId: 'd2' }, { pop3: 'inherit' });
    assert.equal((await pa.domainProtocolAccess('two.test')).pop3, true);
  } finally {
    db.protocolPolicy.findMany = policyFindMany;
    db.domain.findUnique = domainFindUnique;
  }
});

test('protocolEnabledAnywhere: server level, else any domain/user switch', async () => {
  await db.serverSettings.create({ data: { id: 'singleton', jmapEnabled: false } });
  assert.equal(await pa.protocolEnabledAnywhere('jmap'), false);
  assert.equal(await pa.protocolEnabledAnywhere('imap'), true);
  await db.protocolPolicy.create({ data: { domainId: 'd2', jmap: 'ON' } });
  assert.equal(await pa.protocolEnabledAnywhere('jmap'), true);
  assert.equal(await pa.protocolEnabledAnywhere('mapi'), false);
});

// ── Changes ───────────────────────────────────────────────────────────────────

test('user level: switching IMAP off publishes protocol-access-change with the disabled protocols', async () => {
  const u = await addUser('a@one.test', 'd1');
  const id = String(u['id']);
  assert.equal(await pa.isProtocolAllowed(id, 'imap'), true);
  const r = await pa.updateProtocolSettings({ level: 'user', userId: id }, off('imap'));
  assert.equal(r?.changedUsers, 1);
  assert.equal(r?.before.imap, 'inherit');
  assert.equal(r?.after.settings.imap, 'off');
  assert.equal(r?.after.inherited.imap, true);
  assert.equal(r?.after.effective.imap, false);
  assert.deepEqual(events.map((e) => [e.userId, e.reason, e.disabledProtocols]), [[id, 'protocol-access-change', ['imap', 'mapi']]]);
  assert.equal(await pa.isProtocolAllowed(id, 'imap'), false, 'the event dropped the cached value');
  assert.ok(published.some(([c]) => c === core.CHANNEL_SETTINGS_RELOAD));

  events.length = 0;
  const same = await pa.updateProtocolSettings({ level: 'user', userId: id }, off('imap'));
  assert.equal(same?.changedUsers, 0);
  assert.equal(events.length, 0, 'no event without a change');

  await pa.updateProtocolSettings({ level: 'user', userId: id }, { imap: 'inherit' });
  assert.deepEqual(events.map((e) => e.disabledProtocols), [['mapi']]);
  assert.equal(await pa.isProtocolAllowed(id, 'imap'), true);
});

test('domain level reaches only the users of that domain whose access changes', async () => {
  const a = await addUser('a@one.test', 'd1');
  const pinned = await addUser('p@one.test', 'd1');
  const b = await addUser('b@two.test', 'd2');
  await db.protocolPolicy.create({ data: { userId: pinned['id'], activesync: 'ON' } });
  const r = await pa.updateProtocolSettings({ level: 'domain', domainId: 'd1' }, off('activesync'));
  assert.equal(r?.changedUsers, 1);
  assert.deepEqual(events.map((e) => e.userId), [a['id']]);
  assert.equal(await pa.isProtocolAllowed(String(b['id']), 'activesync'), true);
  assert.equal(await pa.isProtocolAllowed(String(pinned['id']), 'activesync'), true);
});

test('server level: two-state, JMAP is written to ServerSettings.jmapEnabled, inherit is refused', async () => {
  const u = await addUser('a@one.test', 'd1');
  const fresh = await pa.readProtocolLevel({ level: 'global' });
  assert.deepEqual(fresh?.settings, { imap: 'on', pop3: 'on', smtp: 'on', activesync: 'on', jmap: 'on', dav: 'on', webmail: 'on', mapi: 'off' },
    'never-written server switches show their built-in default');
  assert.deepEqual(fresh?.inherited, pa.PROTOCOL_DEFAULTS);

  await pa.updateProtocolSettings({ level: 'global' }, { jmap: 'off', mapi: 'on' });
  assert.equal(db.serverSettings.rows[0]?.['jmapEnabled'], false);
  assert.equal(db.protocolPolicy.rows.find((r) => r['id'] === 'global')?.['jmap'], 'INHERIT');
  const view = await pa.readProtocolLevel({ level: 'global' });
  assert.equal(view?.settings.jmap, 'off');
  assert.equal(view?.settings.mapi, 'on');
  assert.deepEqual(events.map((e) => e.disabledProtocols), [['jmap']]);
  assert.equal(await pa.isProtocolAllowed(String(u['id']), 'jmap'), false);

  await assert.rejects(pa.updateProtocolSettings({ level: 'global' }, { jmap: 'inherit' }), RangeError);
  assert.equal(db.serverSettings.rows[0]?.['jmapEnabled'], false, 'nothing written');
  await pa.updateProtocolSettings({ level: 'global' }, { jmap: 'on' });
  assert.equal(db.serverSettings.rows[0]?.['jmapEnabled'], true);
  assert.equal((await pa.readProtocolLevel({ level: 'global' }))?.settings.jmap, 'on');
  assert.deepEqual(pa.settingsForLevel('global'), ['on', 'off']);
  assert.deepEqual(pa.settingsForLevel('user'), ['inherit', 'on', 'off']);
});

test('withProtocolAccessChange around a direct jmapEnabled write notifies the affected users', async () => {
  const u = await addUser('a@one.test', 'd1');
  await db.serverSettings.create({ data: { id: 'singleton', jmapEnabled: true } });
  const { changedUsers } = await pa.withProtocolAccessChange({ level: 'global' },
    () => db.serverSettings.update({ where: { id: 'singleton' }, data: { jmapEnabled: false } }));
  assert.equal(changedUsers, 1);
  assert.deepEqual(events[0]?.disabledProtocols, ['jmap', 'mapi']);
  assert.equal(events[0]?.userId, u['id']);
});

test('readProtocolLevel: domain view inherits the server level; unknown scopes → null', async () => {
  await db.protocolPolicy.create({ data: { id: 'global', pop3: 'OFF' } });
  const v = await pa.readProtocolLevel({ level: 'domain', domainId: 'd1' });
  assert.equal(v?.settings.pop3, 'inherit');
  assert.equal(v?.inherited.pop3, false);
  assert.equal(v?.effective.pop3, false);
  assert.equal(await pa.readProtocolLevel({ level: 'domain', domainId: 'nope' }), null);
  assert.equal(await pa.updateProtocolSettings({ level: 'user', userId: 'nope' }, off('imap')), null);
});

// ── Mail-protocol enforcement ─────────────────────────────────────────────────

test('verifyMailCredentials: protocol_disabled only with correct credentials, other protocols unaffected', async () => {
  const u = await addUser('a@one.test', 'd1');
  await db.protocolPolicy.create({ data: { userId: u['id'], imap: 'OFF', dav: 'OFF' } });
  const ctx = (protocol: 'imap' | 'pop3' | 'caldav' | 'autodiscover') => ({ ip: '203.0.113.5', protocol });
  assert.deepEqual(await mailAuth.verifyMailCredentials('a@one.test', PW, ctx('imap')),
    { status: 'protocol_disabled', userId: u['id'], protocol: 'imap' });
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', 'wrong', ctx('imap'))).status, 'invalid',
    'a wrong password never learns the switch');
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', PW, ctx('pop3'))).status, 'ok');
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', PW, ctx('caldav'))).status, 'protocol_disabled');
  assert.equal((await mailAuth.verifyMailCredentials('a@one.test', PW, ctx('autodiscover'))).status, 'ok',
    'Autodiscover is not a switchable protocol');
});

// ── Web enforcement ───────────────────────────────────────────────────────────

test('web access: Webmail off refuses USER logins and refreshes, admins keep the admin surface', async () => {
  assert.equal(auth.webAccessAllowed(false, 'USER', 'admin'), false);
  assert.equal(auth.webAccessAllowed(false, 'HELP_DESK', 'admin'), true);
  assert.equal(auth.webAccessAllowed(false, 'HELP_DESK', 'webmail'), false);
  assert.equal(auth.webAccessAllowed(true, 'USER', 'webmail'), true);

  const client = { ip: '203.0.113.9', userAgent: 'test' };
  const user = await addUser('u@one.test', 'd1');
  await addUser('admin@one.test', 'd1', { role: 'ORGANIZATION_MANAGEMENT' });
  const before = await auth.login('u@one.test', PW, client);
  assert.equal(before.kind, 'tokens');
  await pa.updateProtocolSettings({ level: 'domain', domainId: 'd1' }, off('webmail'));

  const refused = await auth.login('u@one.test', PW, client);
  assert.equal(refused.kind, 'protocol_disabled');
  assert.deepEqual(auth.loginOutcomeToHttp(refused).status, 403);
  assert.equal(auth.loginOutcomeToHttp(refused).body['code'], 'PROTOCOL_DISABLED');
  assert.equal((await auth.login('u@one.test', 'wrong', client)).kind, 'invalid');
  assert.equal((await auth.login('admin@one.test', PW, client)).kind, 'tokens', 'admins keep the BCP');
  if (before.kind === 'tokens') {
    const r = await auth.rotateSession(before.tokens.refreshToken, client);
    assert.deepEqual(r, { ok: false, status: 403, reason: 'protocol_disabled' });
  }
  assert.equal(await auth.webAccessPermitted({ id: String(user['id']), role: 'USER' }, 'webmail'), false);
});

test('web access: the webmail client gets no session for an admin either (no redirect loop), the BCP / CLI do', async () => {
  const mwa = { 'x-coremail-client': 'web' };
  const bcp = { 'x-coremail-client': 'web', 'x-coremail-app': 'bcp' };
  assert.equal(auth.sessionSurfaceOf(mwa), 'webmail');
  assert.equal(auth.sessionSurfaceOf(bcp), 'admin');
  assert.equal(auth.sessionSurfaceOf({}), 'admin', 'admin CLI (no browser header)');
  assert.deepEqual(auth.clientInfoOf({ ip: '203.0.113.7', headers: { ...mwa, 'user-agent': 'UA' } }),
    { ip: '203.0.113.7', userAgent: 'UA', surface: 'webmail' });

  await addUser('admin@one.test', 'd1', { role: 'SERVER_MANAGEMENT' });
  const viaBcp = { ip: '203.0.113.9', userAgent: 'test', surface: 'admin' as const };
  const viaMwa = { ...viaBcp, surface: 'webmail' as const };
  const session = await auth.login('admin@one.test', PW, viaBcp);
  await pa.updateProtocolSettings({ level: 'domain', domainId: 'd1' }, off('webmail'));
  assert.equal((await auth.login('admin@one.test', PW, viaMwa)).kind, 'protocol_disabled');
  assert.equal((await auth.login('admin@one.test', PW, viaBcp)).kind, 'tokens');
  if (session.kind !== 'tokens') throw new Error('admin login failed');
  const refused = await auth.rotateSession(session.tokens.refreshToken, viaMwa);
  assert.deepEqual(refused, { ok: false, status: 403, reason: 'protocol_disabled' });
  assert.equal((await auth.rotateSession(session.tokens.refreshToken, viaBcp)).ok, true, 'the refused refresh did not rotate');
});

test('webAccessRefusal: 403 PROTOCOL_DISABLED, null when allowed, 503 when the switch cannot be read', async () => {
  const user = await addUser('u@one.test', 'd1');
  const subject = { id: String(user['id']), role: 'USER', domainId: 'd1' };
  assert.equal(await auth.webAccessRefusal(subject, 'webmail'), null);
  await db.protocolPolicy.create({ data: { userId: user['id'], webmail: 'OFF' } });
  pa.invalidateProtocolAccessCache();
  assert.deepEqual(await auth.webAccessRefusal(subject, 'webmail'),
    { status: 403, body: { error: 'webmail access is disabled for this account', code: 'PROTOCOL_DISABLED', protocol: 'webmail' } });
  assert.equal(await auth.webAccessRefusal({ ...subject, role: 'HELP_DESK' }, 'admin'), null, 'admin surface for admins');
  const findMany = db.protocolPolicy.findMany;
  db.protocolPolicy.findMany = async () => { throw new Error('db down'); };
  pa.invalidateProtocolAccessCache();
  try {
    assert.equal((await auth.webAccessRefusal(subject, 'webmail'))?.status, 503, 'fails closed');
  } finally {
    db.protocolPolicy.findMany = findMany;
  }
});
