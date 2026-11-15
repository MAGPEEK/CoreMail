/**
 * LDAP login + sync tests (infra-free): fake Prisma/Redis from
 * @coremail/storage/auth/testing and a fake ldapts client backed by an
 * in-memory directory with a small RFC 4515 filter evaluator.
 * Run: node --import tsx --test src/ldap.test.ts  (in packages/auth-ldap)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const { createFakePrisma, createFakeRedis } = await import('@coremail/storage/auth/testing');
const db = createFakePrisma();
const redis = createFakeRedis();
(globalThis as Record<string, unknown>)['__prisma'] = db;
(globalThis as Record<string, unknown>)['__authRedis'] = redis;

const ldap = await import('./index.js');
const sauth = await import('@coremail/storage/auth');
type LdapEntry = import('./client.js').LdapEntry;

// ── Fake directory ────────────────────────────────────────────────────────────

interface DirUser { entry: LdapEntry; password: string }
const SERVICE_DN = 'cn=svc,dc=example,dc=com';
const SERVICE_PW = 'svc-secret';
let directory: DirUser[] = [];
const filtersSeen: string[] = [];
const binds: { dn: string; password: string }[] = [];

function unescape(v: string): string {
  return v.replace(/\\([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Minimal RFC 4515 evaluator: &, |, !, equality, presence and `*` substrings. */
function evalFilter(f: string, e: LdapEntry): boolean {
  let i = 0;
  const parse = (): boolean => {
    assert.equal(f[i], '(', `bad filter ${f}`); i++;
    const op = f[i];
    if (op === '&' || op === '|') {
      i++;
      const parts: boolean[] = [];
      while (f[i] === '(') parts.push(parse());
      i++;
      return op === '&' ? parts.every(Boolean) : parts.some(Boolean);
    }
    if (op === '!') { i++; const r = !parse(); i++; return r; }
    const end = f.indexOf(')', i);
    const item = f.slice(i, end); i = end + 1;
    const eqAt = item.indexOf('=');
    const attr = item.slice(0, eqAt).toLowerCase();
    const raw = item.slice(eqAt + 1);
    const key = Object.keys(e).find((k) => k.toLowerCase() === attr);
    const vals = key ? (Array.isArray(e[key]) ? (e[key] as string[]) : [String(e[key])]) : [];
    if (raw === '*') return vals.length > 0;
    const parts = raw.split('*').map(unescape); // unescaped `*` = wildcard
    if (parts.length === 1) return vals.some((v) => v.toLowerCase() === parts[0]!.toLowerCase());
    const re = new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    return vals.some((v) => re.test(v));
  };
  return parse();
}

const fakeFactory = () => ({
  async startTLS() { /* no-op */ },
  async bind(dn: string, password: string) {
    binds.push({ dn, password });
    if (dn === SERVICE_DN && password === SERVICE_PW) return;
    const u = directory.find((d) => d.entry.dn === dn);
    if (!u || password === '' || u.password !== password) throw Object.assign(new Error('Invalid credentials'), { code: 49 });
  },
  async search(_base: string, opts: { filter: string; sizeLimit?: number }) {
    filtersSeen.push(opts.filter);
    const hits = directory.filter((d) => evalFilter(opts.filter, d.entry)).map((d) => ({ ...d.entry }));
    if (opts.sizeLimit && hits.length > opts.sizeLimit) throw Object.assign(new Error('Size limit exceeded'), { name: 'SizeLimitExceededError' });
    return { searchEntries: hits };
  },
  async unbind() { /* no-op */ },
});
ldap.setLdapClientFactory(fakeFactory);

function person(uid: string, mail: string | string[], password: string, extra: Record<string, string> = {}): DirUser {
  return {
    entry: { dn: `uid=${uid},ou=people,dc=example,dc=com`, sAMAccountName: uid, mail, displayName: `User ${uid}`, objectGUID: `guid-${uid}`, objectClass: 'person', ...extra },
    password,
  };
}

let domainId = '';

beforeEach(async () => {
  for (const t of ['user', 'userMfa', 'session', 'appPassword', 'domain', 'ldapConfig', 'mailbox', 'folder', 'calendar'] as const) db[t].rows = [];
  redis.store.clear();
  filtersSeen.length = 0;
  binds.length = 0;
  const d = await db.domain.create({ data: { name: 'example.com' } });
  domainId = d['id'] as string;
  await db.domain.create({ data: { name: 'other.org' } });
  await db.ldapConfig.create({
    data: {
      domainId, host: 'dc.example.com', port: 636, ssl: true, baseDN: 'dc=example,dc=com', userDN: 'ou=people,dc=example,dc=com',
      bindDN: SERVICE_DN, bindPassword: SERVICE_PW, userFilter: '(sAMAccountName={{username}})',
    },
  });
  directory = [person('alice', 'alice@example.com', 'alice-pw'), person('bob', 'bob@example.com', 'bob-pw')];
});

// ── Filter escaping ───────────────────────────────────────────────────────────

test('RFC 4515 escaping: special characters are escaped, not stripped', () => {
  assert.equal(ldap.escapeLdapFilterValue('a*b(c)\\d\0e'), 'a\\2ab\\28c\\29\\5cd\\00e');
  assert.equal(ldap.escapeLdapFilterValue('müller.o\'neil'), 'müller.o\'neil');
  assert.equal(ldap.buildUserFilter('(sAMAccountName={{username}})', '*)(uid=*@example.com'),
    '(sAMAccountName=\\2a\\29\\28uid=\\2a)');
  assert.equal(ldap.buildUserFilter('(&(mail={{email}})(dom={{domain}}))', 'a*@x.org'), '(&(mail=a\\2a@x.org)(dom=x.org))');
  assert.equal(ldap.buildUserFilter('uid={{username}}', 'bob@x.org'), '(uid=bob)');
  assert.equal(ldap.buildSyncFilter('mail', '(memberOf=cn=mail,dc=x)'), '(&(objectClass=person)(mail=*)(memberOf=cn=mail,dc=x))');
  assert.equal(ldap.buildSyncFilter('mail', null), '(&(objectClass=person)(mail=*))');
});

test('wildcard login does not match other directory users', async () => {
  const d = await ldap.ldapAuthDecision('*@example.com', 'alice-pw');
  assert.deepEqual(d, { ok: false, reason: 'not_found' });
  assert.equal(filtersSeen.at(-1), '(sAMAccountName=\\2a)');
});

// ── Auth decision table ───────────────────────────────────────────────────────

test('first login creates the user and provisions the mailbox', async () => {
  const d = await ldap.ldapAuthDecision('Alice@Example.com', 'alice-pw');
  assert.equal(d.ok, true);
  assert.ok(d.ok && d.created);
  const u = db.user.rows.find((r) => r['email'] === 'alice@example.com')!;
  assert.equal(u['authSource'], 'LDAP');
  assert.equal(u['passwordHash'], null);
  assert.equal(u['externalId'], 'ldap:guid-alice');
  assert.equal(u['displayName'], 'User alice');
  assert.equal(u['domainId'], domainId);
  const mb = db.mailbox.rows.find((r) => r['userId'] === u['id']);
  assert.ok(mb, 'mailbox provisioned');
  assert.deepEqual(db.folder.rows.filter((f) => f['mailboxId'] === mb!['id']).map((f) => f['name']).sort(),
    ['Archive', 'Drafts', 'INBOX', 'Junk', 'Sent', 'Trash']);
  assert.equal(db.calendar.rows.filter((c) => c['userId'] === u['id']).length, 1);
  // service bind first, then the user DN bind
  assert.deepEqual(binds.map((b) => b.dn), [SERVICE_DN, 'uid=alice,ou=people,dc=example,dc=com']);

  // Second login: same account, no duplicate provisioning
  const again = await ldap.ldapAuthDecision('alice@example.com', 'alice-pw');
  assert.ok(again.ok && !again.created && again.userId === u['id']);
  assert.equal(db.mailbox.rows.length, 1);
  assert.equal(db.folder.rows.length, 6);
});

test('decision table: refusals', async () => {
  const cases: [string, string, string][] = [
    ['alice@example.com', 'wrong', 'wrong_password'],
    ['alice@example.com', '', 'empty_password'],
    ['nobody@example.com', 'x', 'not_found'],
    ['alice@unknown.net', 'alice-pw', 'unknown_domain'],
    ['alice@other.org', 'alice-pw', 'not_configured'],
    ['not-an-email', 'x', 'invalid_email'],
  ];
  for (const [email, pw, reason] of cases) {
    assert.deepEqual(await ldap.ldapAuthDecision(email, pw), { ok: false, reason }, `${email}/${pw}`);
  }
  assert.equal(db.user.rows.length, 0, 'no account created on refusal');
  // empty password never reaches the directory
  assert.ok(!binds.some((b) => b.password === ''));
});

test('mail attribute must equal the login e-mail', async () => {
  directory.push(person('carol', 'carol.smith@example.com', 'carol-pw'));
  assert.deepEqual(await ldap.ldapAuthDecision('carol@example.com', 'carol-pw'), { ok: false, reason: 'mail_mismatch' });
  // a mail in a foreign domain cannot log in as a CoreMail address either
  directory.push(person('dave', 'dave@evil.org', 'dave-pw'));
  assert.deepEqual(await ldap.ldapAuthDecision('dave@example.com', 'dave-pw'), { ok: false, reason: 'mail_mismatch' });
  // multi-valued mail with a match is fine
  directory.push(person('erin', ['erin.x@example.com', 'erin@example.com'], 'erin-pw'));
  assert.equal((await ldap.ldapAuthDecision('erin@example.com', 'erin-pw')).ok, true);
});

test('ambiguous search result is refused', async () => {
  directory.push(person('alice', 'alice@example.com', 'alice-pw'));
  directory[2]!.entry.dn = 'uid=alice,ou=other,dc=example,dc=com';
  assert.deepEqual(await ldap.ldapAuthDecision('alice@example.com', 'alice-pw'), { ok: false, reason: 'ambiguous' });
});

test('LOCAL account is never converted silently; opt-in takeover works', async () => {
  const local = await db.user.create({ data: { email: 'alice@example.com', authSource: 'LOCAL', passwordHash: 'x', domainId } });
  assert.deepEqual(await ldap.ldapAuthDecision('alice@example.com', 'alice-pw'), { ok: false, reason: 'local_account' });
  assert.equal(binds.length, 0, 'directory not even contacted');
  assert.equal(db.user.rows[0]!['authSource'], 'LOCAL');

  await db.ldapConfig.update({ where: { domainId }, data: { allowLocalTakeover: true } });
  const d = await ldap.ldapAuthDecision('alice@example.com', 'alice-pw');
  assert.ok(d.ok && d.userId === local['id']);
  assert.equal(db.user.rows[0]!['authSource'], 'LDAP');
  assert.equal(db.user.rows[0]!['passwordHash'], null);

  // OIDC accounts are never taken over
  await db.user.create({ data: { email: 'bob@example.com', authSource: 'OIDC', domainId } });
  assert.deepEqual(await ldap.ldapAuthDecision('bob@example.com', 'bob-pw'), { ok: false, reason: 'local_account' });
});

test('takeover of a LOCAL account with a legacy SSO binding (externalId oidc:…) migrates it to oidcSubject', async () => {
  await db.ldapConfig.update({ where: { domainId }, data: { allowLocalTakeover: true } });
  // login takeover
  const alice = await db.user.create({ data: { email: 'alice@example.com', authSource: 'LOCAL', passwordHash: 'x', domainId, externalId: 'oidc:p1:sub-alice' } });
  const d = await ldap.ldapAuthDecision('alice@example.com', 'alice-pw');
  assert.ok(d.ok && d.userId === alice['id'], `not refused as external_id_mismatch: ${JSON.stringify(d)}`);
  const a = db.user.rows.find((u) => u['id'] === alice['id'])!;
  assert.equal(a['authSource'], 'LDAP');
  assert.equal(a['externalId'], 'ldap:guid-alice', 'LDAP sets its directory id');
  assert.equal(a['oidcSubject'], 'oidc:p1:sub-alice', 'SSO binding kept');

  // sync takeover (bound oidcSubject already present → not overwritten)
  const bob = await db.user.create({ data: { email: 'bob@example.com', authSource: 'LOCAL', passwordHash: 'x', domainId, externalId: 'oidc:p1:sub-bob', oidcSubject: 'oidc:p1:sub-bob' } });
  const r = await ldap.syncLdapUsers(domainId);
  assert.deepEqual(r.conflicts, []);
  const b = db.user.rows.find((u) => u['id'] === bob['id'])!;
  assert.equal(b['authSource'], 'LDAP');
  assert.equal(b['externalId'], 'ldap:guid-bob');
  assert.equal(b['oidcSubject'], 'oidc:p1:sub-bob');
  assert.deepEqual(ldap.legacyOidcBinding({ externalId: 'ldap:x' }), { directoryId: 'ldap:x', migrate: {} });
});

test('inactive LDAP account and directory-id mismatch are refused', async () => {
  await db.user.create({ data: { email: 'alice@example.com', authSource: 'LDAP', active: false, domainId } });
  assert.deepEqual(await ldap.ldapAuthDecision('alice@example.com', 'alice-pw'), { ok: false, reason: 'inactive' });
  await db.user.create({ data: { email: 'bob@example.com', authSource: 'LDAP', externalId: 'ldap:guid-someone-else', domainId } });
  assert.deepEqual(await ldap.ldapAuthDecision('bob@example.com', 'bob-pw'), { ok: false, reason: 'external_id_mismatch' });
});

test('plain LDAP without TLS is refused; StartTLS is accepted', async () => {
  await db.ldapConfig.update({ where: { domainId }, data: { ssl: false, port: 389 } });
  assert.deepEqual(await ldap.ldapAuthDecision('alice@example.com', 'alice-pw'), { ok: false, reason: 'error' });
  await db.ldapConfig.update({ where: { domainId }, data: { startTls: true } });
  assert.equal((await ldap.ldapAuthDecision('alice@example.com', 'alice-pw')).ok, true);
  assert.equal(ldap.toLdapSettings(db.ldapConfig.rows[0] as never).tlsVerify, true, 'certificate verification on by default');
});

test('disabled LDAP config does not authenticate', async () => {
  await db.ldapConfig.update({ where: { domainId }, data: { enabled: false } });
  assert.deepEqual(await ldap.ldapAuthDecision('alice@example.com', 'alice-pw'), { ok: false, reason: 'not_configured' });
});

test('hooks: verifyLdapMailPassword and the login-service step', async () => {
  assert.equal(await ldap.verifyLdapMailPassword('alice@example.com', 'nope'), false);
  const ok = await ldap.verifyLdapMailPassword('alice@example.com', 'alice-pw');
  assert.ok(ok && typeof ok.userId === 'string');

  for (const n of sauth.listAuthenticators()) sauth.unregisterAuthenticator(n);
  sauth.registerAuthenticator(ldap.ldapAuthenticator());
  assert.equal(await sauth.authenticatePassword('bob@example.com', 'wrong'), null);
  const u = await sauth.authenticatePassword('bob@example.com', 'bob-pw');
  assert.equal(u?.source, 'ldap');
  assert.equal(u?.email, 'bob@example.com');
});

// ── Sync ──────────────────────────────────────────────────────────────────────

test('sync creates, updates, deactivates and never deletes', async () => {
  // existing LDAP user with old display name, an LDAP user gone from the directory,
  // a LOCAL user with a directory address (conflict) and a manually deactivated LDAP user
  await db.user.create({ data: { email: 'alice@example.com', authSource: 'LDAP', displayName: 'Old', domainId } });
  const gone = await db.user.create({ data: { email: 'gone@example.com', authSource: 'LDAP', domainId } });
  await db.session.create({ data: { userId: gone['id'], tokenHash: 'h1', expiresAt: new Date(Date.now() + 1e6) } });
  await db.user.create({ data: { email: 'loc@example.com', authSource: 'LOCAL', passwordHash: 'x', domainId } });
  const manual = await db.user.create({ data: { email: 'manual@example.com', authSource: 'LDAP', active: false, domainId } });
  directory.push(person('loc', 'loc@example.com', 'x'));
  directory.push(person('manual', 'manual@example.com', 'x'));
  directory.push(person('ext', 'ext@other.org', 'x'));
  directory.push(person('off', 'off@example.com', 'x', { userAccountControl: '514' }));

  const r = await ldap.syncLdapUsers(domainId);
  assert.equal(r.found, 6);
  assert.equal(r.created, 1, 'bob created');
  assert.equal(r.updated, 2, 'alice + manual (attributes only) updated');
  assert.equal(r.deactivated, 1, 'gone deactivated');
  assert.equal(r.reactivated, 0);
  assert.deepEqual(r.conflicts, ['loc@example.com']);
  assert.equal(r.skipped, 2, 'foreign domain + disabled new account');

  const by = (e: string) => db.user.rows.find((u) => u['email'] === e)!;
  assert.equal(by('alice@example.com')['displayName'], 'User alice');
  assert.equal(by('alice@example.com')['externalId'], 'ldap:guid-alice');
  assert.equal(by('bob@example.com')['authSource'], 'LDAP');
  assert.ok(db.mailbox.rows.some((m) => m['userId'] === by('bob@example.com')['id']), 'mailbox for new user');
  assert.ok(db.mailbox.rows.some((m) => m['userId'] === by('alice@example.com')['id']), 'mailbox backfilled');
  assert.equal(by('gone@example.com')['active'], false);
  assert.equal(by('gone@example.com')['deactivatedBySync'], true);
  assert.equal(db.session.rows.filter((s) => s['userId'] === gone['id']).length, 0, 'sessions revoked');
  assert.equal(by('loc@example.com')['authSource'], 'LOCAL', 'LOCAL untouched');
  assert.equal(by('manual@example.com')['active'], false, 'manual deactivation respected');
  assert.equal(db.user.rows.length, 5, 'nothing deleted (4 existing + bob)');
  assert.ok(db.ldapConfig.rows[0]!['lastSyncAt'] instanceof Date);
  void manual;

  // gone comes back → re-activated (sync deactivated it); disabled in AD → deactivated
  directory.push(person('gone', 'gone@example.com', 'x'));
  directory.find((d) => d.entry['sAMAccountName'] === 'bob')!.entry['userAccountControl'] = '514';
  const r2 = await ldap.syncLdapUsers(domainId);
  assert.equal(r2.reactivated, 1);
  assert.equal(by('gone@example.com')['active'], true);
  assert.equal(by('bob@example.com')['active'], false);
  assert.equal(r2.deactivated, 1);
});

test('sync with an empty directory result deactivates nobody', async () => {
  await db.user.create({ data: { email: 'alice@example.com', authSource: 'LDAP', domainId } });
  directory = [];
  const r = await ldap.syncLdapUsers(domainId);
  assert.equal(r.deactivated, 0);
  assert.equal(db.user.rows[0]!['active'], true);
});

test('runLdapSyncLocked: busy lock is refused, lock released after the run', async () => {
  const held = new Set<string>();
  const lock = {
    async acquire(k: string) { if (held.has(k)) return false; held.add(k); return true; },
    async release(k: string) { held.delete(k); },
  };
  held.add(`ldap:sync:lock:${domainId}`);
  await assert.rejects(ldap.runLdapSyncLocked(domainId, lock), ldap.LdapSyncBusyError);
  held.clear();
  const r = await ldap.runLdapSyncLocked(domainId, lock);
  assert.equal(r.created, 2);
  assert.equal(held.size, 0);
});

test('dueLdapSyncs honours syncEnabled and the interval', async () => {
  assert.deepEqual(await ldap.dueLdapSyncs(), [domainId]);
  await db.ldapConfig.update({ where: { domainId }, data: { lastSyncAt: new Date(), syncIntervalMinutes: 60 } });
  assert.deepEqual(await ldap.dueLdapSyncs(), []);
  assert.deepEqual(await ldap.dueLdapSyncs(new Date(Date.now() + 61 * 60_000)), [domainId]);
  await db.ldapConfig.update({ where: { domainId }, data: { syncEnabled: false } });
  assert.deepEqual(await ldap.dueLdapSyncs(new Date(Date.now() + 61 * 60_000)), []);
});

test('connection test binds and searches', async () => {
  const row = db.ldapConfig.rows[0] as never;
  const r = await ldap.testLdapConnection(row, 'alice@example.com');
  assert.equal(r.success, true, r.message);
  assert.equal(r.usersFound, 2);
  assert.deepEqual(r.lookup, { email: 'alice@example.com', found: true, dn: 'uid=alice,ou=people,dc=example,dc=com', mailMatches: true, ambiguous: false });
  const bad = await ldap.testLdapConnection({ ...(db.ldapConfig.rows[0] as object), bindPassword: 'nope' } as never);
  assert.equal(bad.success, false);
});
