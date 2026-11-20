/**
 * 10.5 attack protection (attack-protection.ts):
 *  - lockout event handler: security events, notice queue, failure threshold,
 *    G escalation (threshold, switch off), notifications off
 *  - automatic block list entry (fake Prisma): created once, audit row, never
 *    for exceptions, manual entries kept, list cap
 *  - notice aggregation (one mail listing IPs / accounts / protocols) and the
 *    flush (at most one per 15 minutes, disabled, no recipient, Redis lock)
 *  - lock view / release over the lockout's Redis keys
 * Run: node --import tsx --test src/attack-protection.test.ts  (in packages/storage)
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

type Row = Record<string, unknown>;
const db = { rules: [] as Row[], audits: [] as Row[], failCreate: false };
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  ipAccessRule: {
    findUnique: async (a: { where: { kind_cidr: { kind: string; cidr: string } } }) =>
      db.rules.find((r) => r['kind'] === a.where.kind_cidr.kind && r['cidr'] === a.where.kind_cidr.cidr) ?? null,
    count: async (a: { where: { kind: string } }) => db.rules.filter((r) => r['kind'] === a.where.kind).length,
    create: async (a: { data: Row }) => {
      if (db.failCreate) throw Object.assign(new Error('unique'), { code: 'P2002' });
      const row = { id: `r${db.rules.length + 1}`, ...a.data };
      db.rules.push(row);
      return row;
    },
    findMany: async () => db.rules,
  },
  auditLog: { create: async (a: { data: Row }) => { db.audits.push(a.data); return a.data; } },
};
// security events of the production recorder go here
const sunk: Row[] = [];
(globalThis as Record<string, unknown>)['__securityEventSink'] = { write: async (r: Row) => { sunk.push(r); } };

const ap = await import('./attack-protection.js');
const { createMemoryAuthRedis, LOCKOUT_KEYS, accountLockId } = await import('./mail-auth-core.js');
const { setIpAccessRulesForTests } = await import('./ip-access.js');

after(() => setIpAccessRulesForTests(null));

/** In-memory Redis with the list / scan / NX commands used here. */
function memRedis(now: () => number = Date.now) {
  const kv = new Map<string, { v: string; exp: number | null }>();
  const lists = new Map<string, string[]>();
  const live = (k: string) => { const e = kv.get(k); if (e && e.exp !== null && e.exp <= now()) { kv.delete(k); return undefined; } return e; };
  return {
    kv, lists,
    async get(k: string) { return live(k)?.v ?? null; },
    async set(k: string, v: string, _m: 'EX', sec: number, flag?: 'NX') {
      if (flag === 'NX' && live(k)) return null;
      kv.set(k, { v, exp: now() + sec * 1000 }); return 'OK' as const;
    },
    async ttl(k: string) { const e = live(k); if (!e) return -2; return e.exp === null ? -1 : Math.ceil((e.exp - now()) / 1000); },
    async del(...ks: string[]) { let n = 0; for (const k of ks) { if (kv.delete(k)) n++; if (lists.delete(k)) n++; } return n; },
    async incr(k: string) { const e = live(k); const n = (e ? Number(e.v) : 0) + 1; kv.set(k, { v: String(n), exp: e?.exp ?? null }); return n; },
    async expire(k: string, sec: number) { const e = live(k); if (e) e.exp = now() + sec * 1000; return e ? 1 : 0; },
    async rpush(k: string, ...vs: string[]) { const l = lists.get(k) ?? []; l.push(...vs); lists.set(k, l); return l.length; },
    async lrange(k: string, s: number, e: number) { const l = lists.get(k) ?? []; return l.slice(s, e === -1 ? undefined : e + 1); },
    async ltrim(k: string, s: number, e: number) {
      const l = lists.get(k) ?? [];
      const start = s < 0 ? Math.max(0, l.length + s) : s;
      const end = e < 0 ? l.length + e : e;
      lists.set(k, l.slice(start, end + 1)); return 'OK';
    },
    async scan(_c: string, _m: 'MATCH', pattern: string) {
      const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return ['0', [...kv.keys()].filter((k) => live(k) && re.test(k))] as [string, string[]];
    },
  };
}

const SETTINGS = { ...ap.DEFAULT_ATTACK_PROTECTION_SETTINGS };

beforeEach(() => { db.rules = []; db.audits = []; db.failCreate = false; sunk.length = 0; setIpAccessRulesForTests([]); });

describe('settings', () => {
  test('defaults and clamping', () => {
    assert.deepEqual(ap.settingsFromRow(null), SETTINGS);
    const s = ap.settingsFromRow({ autoBlockThreshold: 1, autoBlockDays: 99_999, failureAlertThreshold: -5, notifyRecipient: '  sec@example.test ' });
    assert.equal(s.autoBlockThreshold, 2);
    assert.equal(s.autoBlockDays, 3650);
    assert.equal(s.failureAlertThreshold, 0);
    assert.equal(s.notifyRecipient, 'sec@example.test');
  });
});

describe('lockout event handler', () => {
  function handler(over: Partial<typeof SETTINGS> = {}, redis = memRedis()) {
    const recorded: Row[] = [];
    const blocked: Array<{ ip: string; locks: number }> = [];
    const h = ap.createLockoutEventHandler({
      record: (e) => recorded.push(e as unknown as Row),
      settings: async () => ({ ...SETTINGS, ...over }),
      notifyRedis: () => redis as unknown as import('./attack-protection.js').NotifyRedis,
      autoBlock: async (ip, locks) => { blocked.push({ ip, locks }); },
      now: () => 1_700_000_000_000,
    });
    return { h, recorded, blocked, redis };
  }
  const lock = (locksInWindow: number, scope: 'ip' | 'account' = 'ip') => ({
    kind: 'lock' as const, scope, protocol: 'imap' as const, ip: '198.51.100.7', account: 'alice@example.test',
    strikes: 1, lockSec: 900, failures: 50, locksInWindow,
  });

  test('a failure is recorded (sampled by the recorder) — no notice below the threshold', async () => {
    const { h, recorded, redis } = handler();
    await h({ kind: 'failure', protocol: 'pop3', ip: '198.51.100.7', account: 'a@example.test', status: 'invalid' });
    assert.equal(recorded[0]!['type'], 'AUTH_BRUTE_FORCE');
    assert.equal(recorded[0]!['protocol'], 'pop3');
    assert.equal((redis.lists.get(ap.NOTIFY_KEYS.pending) ?? []).length, 0);
  });

  test('the failure threshold queues exactly one notice per window', async () => {
    const { h, redis } = handler({ failureAlertThreshold: 3 });
    for (let i = 0; i < 6; i++) await h({ kind: 'failure', protocol: 'imap', ip: `198.51.100.${i}`, account: null, status: 'invalid' });
    const items = (redis.lists.get(ap.NOTIFY_KEYS.pending) ?? []).map((s) => JSON.parse(s) as Row);
    assert.deepEqual(items.map((i) => i['kind']), ['failures']);
    assert.equal(items[0]!['count'], 3);
  });

  test('a lock is recorded as important and queued; the 3rd IP lock in 7 days escalates (G)', async () => {
    const { h, recorded, blocked, redis } = handler();
    await h(lock(1));
    await h(lock(2));
    assert.equal(blocked.length, 0);
    await h(lock(3));
    assert.deepEqual(blocked, [{ ip: '198.51.100.7', locks: 3 }]);
    assert.ok(recorded.every((r) => r['type'] === 'AUTH_LOCKOUT' && r['important'] === true));
    assert.equal((redis.lists.get(ap.NOTIFY_KEYS.pending) ?? []).length, 3);
  });

  test('account locks never escalate; escalation and notices can be switched off', async () => {
    const a = handler();
    await a.h(lock(5, 'account'));
    assert.equal(a.blocked.length, 0);
    const off = handler({ autoBlockEnabled: false, notifyEnabled: false });
    await off.h(lock(9));
    assert.equal(off.blocked.length, 0);
    assert.equal((off.redis.lists.get(ap.NOTIFY_KEYS.pending) ?? []).length, 0);
    const t5 = handler({ autoBlockThreshold: 5 });
    await t5.h(lock(4));
    assert.equal(t5.blocked.length, 0);
    await t5.h(lock(5));
    assert.equal(t5.blocked.length, 1);
  });

  test('refusals are recorded, known-client logins are not', async () => {
    const { h, recorded } = handler();
    await h({ kind: 'refused', scope: 'account', protocol: 'web', ip: '198.51.100.7', account: 'a@example.test', retryAfterSec: 30 });
    await h({ kind: 'known_client', protocol: 'web', ip: '203.0.113.5', account: 'a@example.test', via: 'network' });
    assert.deepEqual(recorded.map((r) => r['type']), ['AUTH_LOCKED']);
  });
});

describe('automatic block list entry (G)', () => {
  test('creates one entry with expiry, audit row and security event', async () => {
    const ok = await ap.addAutoBlock('::ffff:198.51.100.7', 3, { ...SETTINGS, autoBlockDays: 30 });
    assert.equal(ok, true);
    assert.equal(db.rules.length, 1);
    const r = db.rules[0]!;
    assert.equal(r['cidr'], '198.51.100.7/32');
    assert.equal(r['kind'], 'BLOCK');
    assert.equal(r['auto'], true);
    assert.equal(r['note'], ap.AUTO_BLOCK_NOTE);
    const days = ((r['expiresAt'] as Date).getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30);
    assert.equal(db.audits[0]!['action'], 'security.ip.autoblock');
    assert.equal(db.audits[0]!['actorEmail'], 'system');
    await new Promise((r2) => setImmediate(r2));
    assert.ok(sunk.some((e) => e['type'] === 'IP_AUTO_BLOCKED'));
    // second time: already on the list
    assert.equal(await ap.addAutoBlock('198.51.100.7', 4, SETTINGS), false);
    assert.equal(db.rules.length, 1);
  });

  test('0 days = permanent; exceptions are never blocked; a full list is respected; races are quiet', async () => {
    assert.equal(await ap.addAutoBlock('198.51.100.8', 3, { ...SETTINGS, autoBlockDays: 0 }), true);
    assert.equal(db.rules[0]!['expiresAt'], null);
    setIpAccessRulesForTests([{ kind: 'ALLOW', cidr: '203.0.113.0/24' }]);
    assert.equal(await ap.addAutoBlock('203.0.113.9', 3, SETTINGS), false);
    assert.equal(await ap.addAutoBlock('127.0.0.1', 3, SETTINGS), false);
    db.rules = Array.from({ length: ap.MAX_IP_RULES_PER_KIND }, (_, i) => ({ kind: 'BLOCK', cidr: `x${i}` }));
    assert.equal(await ap.addAutoBlock('198.51.100.20', 3, SETTINGS), false);
    db.rules = []; db.failCreate = true;
    assert.equal(await ap.addAutoBlock('198.51.100.21', 3, SETTINGS), false);
  });
});

describe('notices', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 14, m)).toISOString();
  const items: import('./attack-protection.js').AttackNoticeItem[] = [
    { kind: 'lock', scope: 'ip', ip: '198.51.100.7', account: 'x@example.test', protocol: 'imap', strikes: 1, lockSec: 900, at: at(1) },
    { kind: 'lock', scope: 'ip', ip: '198.51.100.7', account: 'y@example.test', protocol: 'smtp', strikes: 2, lockSec: 1800, at: at(5) },
    { kind: 'lock', scope: 'ip', ip: '2001:db8::66', account: null, protocol: 'web', strikes: 1, lockSec: 900, at: at(3) },
    { kind: 'lock', scope: 'account', ip: '198.51.100.7', account: 'alice@example.test', protocol: 'activesync', strikes: 1, lockSec: 300, at: at(2) },
    { kind: 'autoblock', ip: '198.51.100.7/32', locks: 3, days: 30, at: at(6) },
    { kind: 'failures', count: 200, windowMin: 15, at: at(7) },
    { kind: 'lock', scope: 'account', ip: null, account: '<script>@evil', protocol: 'pop3', strikes: 1, lockSec: 300, at: at(8) },
  ];

  test('one aggregated notice lists IPs, accounts, protocols, automatic blocks and alerts', () => {
    const n = ap.buildAttackNotice(items, { host: 'mail.example.test', product: 'CoreMail' });
    assert.equal(n.subject, '[CoreMail] Angriffsschutz: 2 IP-Sperren, 2 Konto-Sperren, 1 dauerhaft gesperrt, viele Fehlanmeldungen');
    assert.match(n.text, /198\.51\.100\.7 — 2× gesperrt \(IMAP, SMTP\), zuletzt 2026-11-20 14:05 UTC, Stufe 2, 30 min/);
    assert.match(n.text, /2001:db8::66 — 1× gesperrt \(Webmail\/API\)/);
    assert.match(n.text, /alice@example\.test — 1× gesperrt \(ActiveSync\)/);
    assert.match(n.text, /198\.51\.100\.7\/32 — 3 Sperren in 7 Tagen, 30 Tage/);
    assert.match(n.text, /200 fehlgeschlagene Anmeldungen innerhalb von 15 Minuten/);
    assert.match(n.text, /https:\/\/mail\.example\.test\/bcp\/attack-protection/);
    assert.ok(n.html.includes('&lt;script&gt;@evil') && !n.html.includes('<script>'), 'attacker text is escaped');
  });

  function flushDeps(redis: ReturnType<typeof memRedis>, over: Partial<typeof SETTINGS> = {}, recipients = ['admin@example.test']) {
    const sent: Array<{ rcpt: string; subject: string }> = [];
    return {
      sent,
      deps: {
        redis: redis as unknown as import('./attack-protection.js').NotifyRedis,
        settings: async () => ({ ...SETTINGS, ...over }),
        recipients: async () => recipients,
        deliver: async (rcpt: string, n: { subject: string }) => { sent.push({ rcpt, subject: n.subject }); },
        host: async () => 'mail.example.test',
        product: async () => 'CoreMail',
      },
    };
  }

  test('flush: one mail for everything queued, then at most one per 15 minutes', async () => {
    let now = 1_700_000_000_000;
    const redis = memRedis(() => now);
    const { deps, sent } = flushDeps(redis);
    assert.deepEqual(await ap.flushAttackNotifications(deps), { status: 'idle' });
    for (const it of items.slice(0, 3)) await ap.queueAttackNotice(deps.redis, it);
    const r = await ap.flushAttackNotifications(deps);
    assert.equal(r.status, 'sent');
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.subject, /2 IP-Sperren/);
    // more locks within 15 minutes: they aggregate, no second mail
    for (const it of items.slice(3)) await ap.queueAttackNotice(deps.redis, it);
    now += 5 * 60_000;
    assert.deepEqual(await ap.flushAttackNotifications(deps), { status: 'throttled' });
    assert.equal(sent.length, 1);
    now += 11 * 60_000;
    const r2 = await ap.flushAttackNotifications(deps);
    assert.ok(r2.status === 'sent' && r2.items === items.length - 3);
    assert.equal(sent.length, 2);
    assert.deepEqual(await ap.flushAttackNotifications(deps), { status: 'idle' });
  });

  test('flush: disabled / no recipient drop the queue; a held lock means busy', async () => {
    const redis = memRedis();
    const off = flushDeps(redis, { notifyEnabled: false });
    await ap.queueAttackNotice(off.deps.redis, items[0]!);
    assert.deepEqual(await ap.flushAttackNotifications(off.deps), { status: 'disabled', dropped: 1 });
    const none = flushDeps(redis, {}, []);
    await ap.queueAttackNotice(none.deps.redis, items[0]!);
    assert.deepEqual(await ap.flushAttackNotifications(none.deps), { status: 'no-recipient', dropped: 1 });
    assert.equal((redis.lists.get(ap.NOTIFY_KEYS.pending) ?? []).length, 0);
    await redis.set(ap.NOTIFY_KEYS.lock, '1', 'EX', 60);
    assert.deepEqual(await ap.flushAttackNotifications(flushDeps(redis).deps), { status: 'busy' });
  });

  test('the pending queue is bounded', async () => {
    const redis = memRedis();
    for (let i = 0; i < ap.MAX_PENDING_NOTICES + 20; i++) await ap.queueAttackNotice(redis as never, items[0]!);
    assert.equal((redis.lists.get(ap.NOTIFY_KEYS.pending) ?? []).length, ap.MAX_PENDING_NOTICES);
  });
});

describe('lock view and release', () => {
  async function lockedState() {
    const redis = memRedis();
    const { createMailCredentialVerifier } = await import('./mail-auth-core.js');
    const verifier = createMailCredentialVerifier({
      prisma: {
        user: { findFirst: async () => null },
        appPassword: { findMany: async () => [], update: async () => ({}) },
        domain: { findFirst: async () => null },
      },
      redis: redis as never,
      verifyPassword: async () => false,
      dummyHash: async () => 'x',
      limits: { ipMaxFailures: 4, accountMaxFailures: 3 },
    });
    for (let i = 0; i < 3; i++) await verifier.verify('alice@example.test', 'x', { ip: `198.51.100.${i}`, protocol: 'imap' });
    for (let i = 0; i < 4; i++) await verifier.verify(`u${i}@example.test`, 'x', { ip: '192.0.2.99', protocol: 'pop3' });
    return redis;
  }

  test('lists locked IPs and accounts with e-mail, protocol, strikes and remaining time', async () => {
    const redis = await lockedState();
    const r = await ap.listActiveLocks(redis as never);
    assert.equal(r.truncated, false);
    assert.equal(r.ips.length, 1);
    assert.equal(r.ips[0]!.id, '192.0.2.99');
    assert.equal(r.ips[0]!.protocol, 'pop3');
    assert.equal(r.ips[0]!.strikes, 1);
    assert.equal(r.ips[0]!.locksInWindow, 1);
    assert.ok(r.ips[0]!.remainingSec > 0);
    const acct = r.accounts.find((a) => a.account === 'alice@example.test');
    assert.ok(acct, JSON.stringify(r.accounts));
    assert.equal(acct.id, accountLockId('alice@example.test'));
    assert.equal(acct.protocol, 'imap');
  });

  test('release deletes lock + counters; resetStrikes also the backoff and repeat counter', async () => {
    const redis = await lockedState();
    const id = accountLockId('alice@example.test');
    const r = await ap.releaseLock(redis as never, 'account', id);
    assert.equal(r.released, true);
    assert.equal(r.info?.account, 'alice@example.test');
    assert.equal(await redis.get(LOCKOUT_KEYS.lock('acct', id)), null);
    assert.notEqual(await redis.get(LOCKOUT_KEYS.strikes('acct', id)), null, 'strikes kept without resetStrikes');
    const ip = await ap.releaseLock(redis as never, 'ip', '192.0.2.99', { resetStrikes: true });
    assert.equal(ip.released, true);
    for (const k of [LOCKOUT_KEYS.lock('ip', '192.0.2.99'), LOCKOUT_KEYS.strikes('ip', '192.0.2.99'), LOCKOUT_KEYS.locks('192.0.2.99'), LOCKOUT_KEYS.fail('ip', '192.0.2.99')]) {
      assert.equal(await redis.get(k), null, k);
    }
    assert.equal((await ap.listActiveLocks(redis as never)).ips.length, 0);
    assert.equal((await ap.releaseLock(redis as never, 'ip', '192.0.2.99')).released, false);
  });

  test('lockIdOf validates IPs, account hashes and e-mails', () => {
    assert.equal(ap.lockIdOf('ip', '::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(ap.lockIdOf('ip', 'nope'), null);
    assert.equal(ap.lockIdOf('account', 'Alice@Example.test'), accountLockId('alice@example.test'));
    assert.equal(ap.lockIdOf('account', 'a'.repeat(32).replace(/a/g, 'f')), 'f'.repeat(32));
    assert.equal(ap.lockIdOf('account', 'mailauth:*'), null);
  });

  test('the memory lockout Redis (mail-auth-core) is compatible with the view', async () => {
    const r = createMemoryAuthRedis();
    assert.equal(typeof r.ttl, 'function');
  });
});
