/**
 * 10.5 attack protection in the shared lockout (mail-auth-core.ts):
 *  - E: known clients (network /24 or /56, ActiveSync device) may still log in
 *    while the ACCOUNT is locked; strangers get `locked`; failures keep counting;
 *    the IP lock is never bypassed; MAIL_AUTH_KNOWN_CLIENT_DAYS=0 switches it off
 *  - lock info records (hash → e-mail), the 7-day IP lock counter (G), events
 *  - exemptions (exempt IPs never IP-locked), fail open without Redis unchanged
 *  - the web login front door (createLoginLockout) applies the same rules
 * Infra-free. Run: node --import tsx --test src/mail-auth-protection.test.ts  (in packages/storage)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createMailCredentialVerifier, createLoginLockout, createMemoryAuthRedis, clientNetworkOf, ipv6Groups,
  accountLockId, LOCKOUT_KEYS, REPEAT_LOCK_WINDOW_SEC, LOGIN_SUCCESS_IP_TTL_SEC, ipLockIdOf, safeAccountLabel,
  clientIpInfoFromRequest,
  type LockoutEvent, type MailAuthDeps, type MailAuthPrisma, type MailAuthRedis,
} from './mail-auth-core.js';

function fixture(extra: Partial<MailAuthDeps> = {}, now: () => number = Date.now) {
  const users = [
    { id: 'u-alice', email: 'alice@example.test', displayName: 'Alice', domainId: 'd1', role: 'USER', active: true,
      passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: null, mailbox: { id: 'mb-a' } },
  ];
  const prisma: MailAuthPrisma = {
    user: { async findFirst(args) { const w = (args as { where: { email: string } }).where; return users.find((u) => u.email === w.email) ?? null; } },
    appPassword: { async findMany() { return []; }, async update() { return {}; } },
    domain: { async findFirst() { return { name: 'example.test' }; } },
  };
  const redis = createMemoryAuthRedis(now);
  const events: LockoutEvent[] = [];
  const deps: MailAuthDeps = {
    prisma, redis,
    verifyPassword: async (p, h) => h === `hash:${p}`,
    dummyHash: async () => 'hash:\0dummy',
    limits: { ipMaxFailures: 5, accountMaxFailures: 3, ipLockBaseSec: 60, accountLockBaseSec: 30 },
    onLockoutEvent: (e) => events.push(e),
    ...extra,
  };
  return { redis, events, deps, verifier: createMailCredentialVerifier(deps) };
}

const imap = (ip: string, deviceId?: string) => ({ ip, protocol: 'imap' as const, ...(deviceId ? { deviceId } : {}) });
const eas = (ip: string, deviceId?: string) => ({ ip, protocol: 'activesync' as const, ...(deviceId ? { deviceId } : {}) });

/** Locks alice's account with failures from the stranger network 198.51.100.0/24. */
async function lockAccountFromStrangers(verifier: ReturnType<typeof fixture>['verifier']) {
  for (let i = 0; i < 3; i++) assert.equal((await verifier.verify('alice@example.test', 'wrong', imap(`198.51.100.${10 + i}`))).status, 'invalid');
  const r = await verifier.verify('alice@example.test', 'wrong', imap('198.51.100.50'));
  assert.ok(r.status === 'locked' && r.scope === 'account', JSON.stringify(r));
}

describe('client network helpers', () => {
  test('IPv4 → /24, IPv6 → /56, mapped IPv4 normalised, garbage → null', () => {
    assert.equal(clientNetworkOf('203.0.113.77'), '203.0.113.0/24');
    assert.equal(clientNetworkOf('::ffff:203.0.113.77'), '203.0.113.0/24');
    assert.equal(clientNetworkOf('2001:db8:1:2345:6789::1'), '2001:db8:1:2300:0:0:0:0/56');
    assert.equal(clientNetworkOf('2001:db8:1:23ff::'), clientNetworkOf('2001:db8:1:2300::9'));
    assert.notEqual(clientNetworkOf('2001:db8:1:2400::1'), clientNetworkOf('2001:db8:1:2300::1'));
    assert.equal(clientNetworkOf('nope'), null);
    assert.equal(clientNetworkOf(''), null);
  });

  test('ipv6Groups expands ::, embedded IPv4 and rejects IPv4', () => {
    assert.deepEqual(ipv6Groups('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual(ipv6Groups('2001:db8::'), [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(ipv6Groups('64:ff9b::192.0.2.33'), [0x64, 0xff9b, 0, 0, 0, 0, 0xc000, 0x221]);
    assert.equal(ipv6Groups('192.0.2.1'), null);
  });
});

describe('E — no lockout of victims by strangers', () => {
  test('a known network may log in while the account is locked; a stranger is refused', async () => {
    const { verifier } = fixture();
    // alice logged in before from her office network
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    await lockAccountFromStrangers(verifier);
    // another address of the same /24 → still allowed
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.99'))).status, 'ok');
    // a stranger with the RIGHT password is refused (no password check)
    const r = await verifier.verify('alice@example.test', 'secret', imap('192.0.2.1'));
    assert.ok(r.status === 'locked' && r.scope === 'account');
  });

  test('known clients still count failures (per IP and per account)', async () => {
    const { verifier, redis } = fixture();
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    await lockAccountFromStrangers(verifier);
    assert.equal((await verifier.verify('alice@example.test', 'typo', imap('203.0.113.5'))).status, 'invalid');
    const keys = redis.keys();
    assert.ok(keys.includes(LOCKOUT_KEYS.fail('ip', '203.0.113.5')), 'per-IP failure counted');
    assert.ok(keys.includes(LOCKOUT_KEYS.fail('acct', accountLockId('alice@example.test'))), 'account failure counted');
  });

  test('the IP lock is never bypassed for a known network', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    for (let i = 0; i < 5; i++) await verifier.verify(`nobody${i}@example.test`, 'x', imap('203.0.113.5'));
    const r = await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'));
    assert.ok(r.status === 'locked' && r.scope === 'ip', JSON.stringify(r));
  });

  test('10.5 review: a (client-chosen) ActiveSync DeviceId alone never grants the exception', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('alice@example.test', 'secret', eas('203.0.113.5', 'DEV-PHONE-1'))).status, 'ok');
    await lockAccountFromStrangers(verifier);
    // the known device id from an unknown network: refused (an attacker can send any DeviceId)
    const r = await verifier.verify('alice@example.test', 'secret', eas('192.0.2.200', 'DEV-PHONE-1'));
    assert.ok(r.status === 'locked' && r.scope === 'account', JSON.stringify(r));
    // known network + known device: allowed
    assert.equal((await verifier.verify('alice@example.test', 'secret', eas('203.0.113.77', 'DEV-PHONE-1'))).status, 'ok');
    // known network + a device id the account never used: refused (with a device id both must be known)
    assert.equal((await verifier.verify('alice@example.test', 'secret', eas('203.0.113.78', 'DEV-OTHER'))).status, 'locked');
  });

  test('10.5 review: each (account, known network) has its own failure budget that suspends the exception', async () => {
    const { verifier, redis } = fixture({ limits: { ipMaxFailures: 50, accountMaxFailures: 3, accountLockBaseSec: 30 } });
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    await lockAccountFromStrangers(verifier);
    // an attacker in the victim's /24 keeps guessing: allowed to try (exception) …
    for (let i = 0; i < 3; i++) {
      assert.equal((await verifier.verify('alice@example.test', `guess${i}`, imap(`203.0.113.${100 + i}`))).status, 'invalid');
    }
    // … until the network's own budget (accountMaxFailures) is used up: now refused like a stranger
    const r = await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'));
    assert.ok(r.status === 'locked' && r.scope === 'account', JSON.stringify(r));
    assert.ok(redis.keys().some((k) => k.startsWith(`mailauth:acct:knownfail:${accountLockId('alice@example.test')}:`)));
  });

  test('10.5 review: the known-network budget expires with the account window', async () => {
    let now = 7_000_000;
    const { verifier } = fixture({ limits: { ipMaxFailures: 50, accountMaxFailures: 3, accountLockBaseSec: 30, accountLockMaxSec: 10 * 86_400, accountWindowSec: 600 } }, () => now);
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    await lockAccountFromStrangers(verifier);
    for (let i = 0; i < 3; i++) await verifier.verify('alice@example.test', 'x', imap('203.0.113.5'));
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'locked');
    now += 601_000; // budget window over; lock the account again from strangers
    await lockAccountFromStrangers(verifier);
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
  });

  test('10.5 review: an unverified forwarded IP is never learned, never exempt, its locks are never escalated', async () => {
    const { verifier, redis, events } = fixture();
    const fwd = (ip: string) => ({ ip, protocol: 'jmap' as const, ipTrusted: false });
    // a success through an unverified header does not make the network known
    assert.equal((await verifier.verify('alice@example.test', 'secret', fwd('203.0.113.5'))).status, 'ok');
    assert.ok(!redis.keys().some((k) => k.includes(':known:') || k.startsWith('mailauth:ip:ok:')));
    // and a known network claimed through an unverified header grants nothing
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    await lockAccountFromStrangers(verifier);
    assert.equal((await verifier.verify('alice@example.test', 'secret', fwd('203.0.113.6'))).status, 'locked');
    // still counted per IP; the lock event says "not trusted"
    for (let i = 0; i < 5; i++) await verifier.verify(`u${i}@example.test`, 'x', fwd('192.0.2.44'));
    const lock = events.find((e) => e.kind === 'lock' && e.scope === 'ip');
    assert.ok(lock && lock.kind === 'lock' && lock.ipTrusted === false && lock.ipLockId === '192.0.2.44');
  });

  test('known clients are bound to the account (no cross-account reuse)', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    for (let i = 0; i < 3; i++) await verifier.verify('ghost@example.test', 'x', imap(`198.51.100.${i}`));
    assert.equal((await verifier.verify('ghost@example.test', 'x', imap('203.0.113.5'))).status, 'locked');
  });

  test('a known network expires after knownClientTtlSec', async () => {
    let now = 5_000_000;
    const { verifier } = fixture({ limits: { ipMaxFailures: 5, accountMaxFailures: 3, accountLockBaseSec: 30, accountLockMaxSec: 10 * 86_400, knownClientTtlSec: 3600 } }, () => now);
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    now += 3601 * 1000;
    await lockAccountFromStrangers(verifier);
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'locked');
  });

  test('knownClientTtlSec 0 switches the exception off (pre-10.5 behaviour)', async () => {
    const { verifier } = fixture({ limits: { ipMaxFailures: 5, accountMaxFailures: 3, accountLockBaseSec: 30, knownClientTtlSec: 0 } });
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    await lockAccountFromStrangers(verifier);
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'locked');
  });

  test('a known-client login is reported, a refusal is reported', async () => {
    const { verifier, events } = fixture();
    await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'));
    await lockAccountFromStrangers(verifier);
    events.length = 0;
    await verifier.verify('alice@example.test', 'secret', imap('203.0.113.6'));
    await verifier.verify('alice@example.test', 'secret', imap('192.0.2.1'));
    assert.deepEqual(events.map((e) => e.kind), ['known_client', 'refused']);
    assert.ok(events[0]!.kind === 'known_client' && events[0]!.via === 'network');
  });
});

describe('lock records, events and the repeat-offender counter', () => {
  test('an account lock stores the e-mail next to the hashed key (same TTL)', async () => {
    const { verifier, redis } = fixture();
    await lockAccountFromStrangers(verifier);
    const id = accountLockId('alice@example.test');
    const lockTtl = await redis.ttl(LOCKOUT_KEYS.lock('acct', id));
    const infoTtl = await redis.ttl(LOCKOUT_KEYS.info('acct', id));
    assert.ok(lockTtl > 0 && infoTtl === lockTtl, `${lockTtl} vs ${infoTtl}`);
    assert.ok(redis.keys().includes(LOCKOUT_KEYS.info('acct', id)));
  });

  test('every failure and the lock are reported with protocol, IP and account', async () => {
    const { verifier, events } = fixture();
    await lockAccountFromStrangers(verifier);
    const failures = events.filter((e) => e.kind === 'failure');
    assert.equal(failures.length, 3);
    assert.ok(failures.every((e) => e.kind === 'failure' && e.protocol === 'imap' && e.account === 'alice@example.test'));
    const lock = events.find((e) => e.kind === 'lock');
    assert.ok(lock && lock.kind === 'lock' && lock.scope === 'account' && lock.strikes === 1 && lock.lockSec === 30 && lock.failures === 3);
  });

  test('IP locks are counted in a 7-day window (G): 1, 2, 3 …', async () => {
    let now = 9_000_000;
    const { verifier, events, redis } = fixture({}, () => now);
    const lockIp = async () => {
      for (let i = 0; i < 5; i++) await verifier.verify(`u${i}@example.test`, 'x', imap('192.0.2.66'));
      const lock = [...events].reverse().find((e) => e.kind === 'lock' && e.scope === 'ip');
      assert.ok(lock && lock.kind === 'lock');
      const ttl = await redis.ttl(LOCKOUT_KEYS.lock('ip', '192.0.2.66'));
      now += (ttl + 1) * 1000; // wait the lock out
      return lock.locksInWindow;
    };
    assert.equal(await lockIp(), 1);
    assert.equal(await lockIp(), 2);
    assert.equal(await lockIp(), 3);
    const windowTtl = await redis.ttl(LOCKOUT_KEYS.locks('192.0.2.66'));
    assert.ok(windowTtl > 0 && windowTtl <= REPEAT_LOCK_WINDOW_SEC);
  });

  test('10.5 review: IPv6 failures are counted per /64 — a fresh address in the same /64 is still locked', async () => {
    const { verifier, events } = fixture();
    for (let i = 0; i < 5; i++) await verifier.verify(`u${i}@example.test`, 'x', imap(`2001:db8:1:2::${(i + 1).toString(16)}`));
    const lock = events.find((e) => e.kind === 'lock' && e.scope === 'ip');
    assert.ok(lock && lock.kind === 'lock' && lock.ipLockId === '2001:db8:1:2::/64', JSON.stringify(lock));
    const r = await verifier.verify('alice@example.test', 'secret', imap('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    assert.ok(r.status === 'locked' && r.scope === 'ip', JSON.stringify(r));
    assert.ok((await verifier.ipLockedFor('2001:db8:1:2:aaaa::1')) > 0);
    // the neighbouring /64 is a different subscriber
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('2001:db8:1:3::1'))).status, 'ok');
  });

  test('10.5 review: lock ids, account labels', () => {
    assert.equal(ipLockIdOf('198.51.100.7'), '198.51.100.7');
    assert.equal(ipLockIdOf('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(ipLockIdOf('2001:db8:0:0:1::9'), '2001:db8::/64');
    assert.equal(ipLockIdOf('2001:db8:1:2::/64'), '2001:db8:1:2::/64');
    assert.equal(ipLockIdOf('2001:db8:1:2:3::/64'), '2001:db8:1:2::/64');
    assert.equal(ipLockIdOf('nope'), '');
    assert.equal(safeAccountLabel('alice@example.test'), 'alice@example.test');
    assert.equal(safeAccountLabel('jörg@müller.example'), 'jörg@müller.example');
    assert.equal(safeAccountLabel('https://evil.example/?a=@b.example'), '(ungültige Eingabe, 34 Zeichen)');
    assert.equal(safeAccountLabel('x\u0000y'), '(ungültige Eingabe, 3 Zeichen)');
    assert.equal(safeAccountLabel(''), null);
    assert.equal(safeAccountLabel(null), null);
  });

  test('10.5 review: raw login text never reaches events or lock records', async () => {
    const { verifier, events, redis } = fixture({ limits: { ipMaxFailures: 50, accountMaxFailures: 2, accountLockBaseSec: 30 } });
    const evil = 'Visit http://phish.example now';
    for (let i = 0; i < 2; i++) await verifier.verify(evil, 'x', imap('198.51.100.9'));
    assert.ok(events.length > 0);
    for (const e of events) {
      assert.ok(e.account === null || !e.account.includes('phish'), JSON.stringify(e));
    }
    const lock = events.find((e) => e.kind === 'lock');
    assert.ok(lock && lock.account === `(ungültige Eingabe, ${evil.length} Zeichen)`);
    const infoKey = redis.keys().find((k) => k.startsWith('mailauth:acct:info:'));
    assert.ok(infoKey && !(await redis.get!(infoKey))!.includes('phish'));
  });

  test('10.5 review: a successful login records its IP (account + admin flag) for the escalation', async () => {
    const { verifier, redis } = fixture();
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    const key = LOCKOUT_KEYS.ipOk('203.0.113.5', accountLockId('alice@example.test'));
    assert.equal(await redis.get!(key), 'u');
    const ttl = await redis.ttl(key);
    assert.ok(ttl > LOGIN_SUCCESS_IP_TTL_SEC - 5 && ttl <= LOGIN_SUCCESS_IP_TTL_SEC);
    const web = createLoginLockout({ redis });
    await web.success('boss@example.test', '2001:db8:5:6::7', { admin: true });
    assert.equal(await redis.get!(LOCKOUT_KEYS.ipOk('2001:db8:5:6::/64', accountLockId('boss@example.test'))), 'a');
  });

  test('a throwing event hook never breaks a login', async () => {
    const { verifier } = fixture({ onLockoutEvent: () => { throw new Error('boom'); } });
    assert.equal((await verifier.verify('alice@example.test', 'wrong', imap('203.0.113.5'))).status, 'invalid');
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
  });
});

describe('exemptions and fail-open', () => {
  test('exempt IPs (exceptions) are never IP-locked and still count per account', async () => {
    const exempt = (ip: string) => ip.startsWith('10.1.');
    const { verifier, redis } = fixture({ isExemptIp: exempt });
    for (let i = 0; i < 8; i++) await verifier.verify(`u${i}@example.test`, 'x', imap('10.1.2.3'));
    assert.equal(await verifier.ipLockedFor('10.1.2.3'), 0);
    assert.ok(!redis.keys().some((k) => k.startsWith('mailauth:ip:')), 'no per-IP keys for an exempt IP');
    for (let i = 0; i < 3; i++) await verifier.verify('alice@example.test', 'x', imap('10.1.2.3'));
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('10.1.2.3'))).status, 'locked');
  });

  test('without Redis nothing is locked and the hooks still see failures', async () => {
    const { verifier, events } = fixture({ redis: null });
    for (let i = 0; i < 20; i++) assert.equal((await verifier.verify('alice@example.test', 'x', imap('192.0.2.9'))).status, 'invalid');
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('192.0.2.9'))).status, 'ok');
    assert.equal(events.filter((e) => e.kind === 'lock').length, 0);
    assert.equal(events.filter((e) => e.kind === 'failure').length, 20);
  });

  test('Redis errors fail open — also in the known-client check', async () => {
    const broken: MailAuthRedis = {
      incr: async () => { throw new Error('down'); },
      expire: async () => { throw new Error('down'); },
      ttl: async () => { throw new Error('down'); },
      set: async () => { throw new Error('down'); },
      del: async () => { throw new Error('down'); },
    };
    const { verifier } = fixture({ redis: broken });
    assert.equal((await verifier.verify('alice@example.test', 'secret', imap('203.0.113.5'))).status, 'ok');
    assert.equal((await verifier.verify('alice@example.test', 'x', imap('203.0.113.5'))).status, 'invalid');
  });
});

describe('10.5 review: client IP trust of proxied requests', () => {
  test('clientIpInfoFromRequest: socket peer trusted; forwarded IP trusted only with the gateway mark', () => {
    assert.deepEqual(clientIpInfoFromRequest('198.51.100.1', { 'x-forwarded-for': '203.0.113.9' }), { ip: '198.51.100.1', trusted: true });
    assert.deepEqual(clientIpInfoFromRequest('127.0.0.1', {}), { ip: '127.0.0.1', trusted: true });
    assert.deepEqual(clientIpInfoFromRequest('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), { ip: '203.0.113.9', trusted: false });
    assert.deepEqual(
      clientIpInfoFromRequest('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.9', 'x-coremail-ip-verified': '1' }),
      { ip: '203.0.113.9', trusted: true },
    );
  });

  test('web: an unverified forwarded IP is counted but not learned and not exempt', async () => {
    const redis = createMemoryAuthRedis();
    const events: LockoutEvent[] = [];
    const lockout = createLoginLockout({ redis, limits: { accountMaxFailures: 3, ipMaxFailures: 2 }, onLockoutEvent: (e) => events.push(e) });
    await lockout.success('alice@example.test', '203.0.113.5', { ipTrusted: false });
    assert.ok(!redis.keys().some((k) => k.includes(':known:') || k.startsWith('mailauth:ip:ok:')));
    await lockout.success('alice@example.test', '203.0.113.5');
    for (let i = 0; i < 3; i++) await lockout.fail('alice@example.test', `198.51.100.${i}`);
    assert.equal((await lockout.check('alice@example.test', '203.0.113.200', { ipTrusted: false })).locked, true);
    assert.equal((await lockout.check('alice@example.test', '203.0.113.200')).locked, false);
    for (let i = 0; i < 2; i++) await lockout.fail(`x${i}@example.test`, '192.0.2.5', { ipTrusted: false });
    assert.ok(events.some((e) => e.kind === 'lock' && e.scope === 'ip' && e.ipTrusted === false));
  });
});

describe('web login front door (createLoginLockout)', () => {
  test('E applies to the web login: success() remembers the network, check() lets it in while locked', async () => {
    const redis = createMemoryAuthRedis();
    const events: LockoutEvent[] = [];
    const lockout = createLoginLockout({ redis, limits: { accountMaxFailures: 3 }, onLockoutEvent: (e) => events.push(e) });
    await lockout.success('alice@example.test', '203.0.113.5');
    for (let i = 0; i < 3; i++) await lockout.fail('alice@example.test', `198.51.100.${i}`);
    assert.equal((await lockout.check('alice@example.test', '198.51.100.9')).locked, true);
    assert.equal((await lockout.check('alice@example.test', '203.0.113.200')).locked, false);
    assert.equal((await lockout.check('alice@example.test', '192.0.2.1')).scope, 'account');
    assert.ok(events.every((e) => e.protocol === 'web'));
    assert.ok(events.some((e) => e.kind === 'lock' && e.scope === 'account' && e.account === 'alice@example.test'));
  });

  test('success() without an IP does not remember anything; MCP failIp reports protocol mcp', async () => {
    const redis = createMemoryAuthRedis();
    const events: LockoutEvent[] = [];
    const web = createLoginLockout({ redis, limits: { accountMaxFailures: 3 } });
    await web.success('alice@example.test');
    assert.ok(!redis.keys().some((k) => k.includes(':known:')));
    const mcp = createLoginLockout({ redis, limits: { ipMaxFailures: 2 }, protocol: 'mcp', onLockoutEvent: (e) => events.push(e) });
    await mcp.failIp('192.0.2.7');
    await mcp.failIp('192.0.2.7');
    assert.ok((await mcp.ipLockedFor('192.0.2.7')) > 0);
    assert.ok(events.some((e) => e.kind === 'lock' && e.scope === 'ip' && e.protocol === 'mcp' && e.locksInWindow === 1));
  });
});
