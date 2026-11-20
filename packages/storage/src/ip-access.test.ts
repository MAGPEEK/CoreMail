/**
 * 10.5 block list / exceptions (ip-access.ts): CIDR parsing (IPv4/IPv6), the
 * matcher (exceptions win, expiry), the connect verdict (loopback and
 * MAIL_AUTH_EXEMPT_CIDRS are never blocked) and the lockout exemption.
 * Run: node --import tsx --test src/ip-access.test.ts  (in packages/storage)
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['MAIL_AUTH_EXEMPT_CIDRS'] = '10.9.0.0/16';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const {
  parseCidr, compressIpv6, cidrContains, buildIpAccessMatcher, ipAccessVerdict, isAllowListed,
  setIpAccessRulesForTests, isIpAccessReload,
} = await import('./ip-access.js');
const { connectGuard, OPEN_CONNECT_GUARD } = await import('./connect-guard.js');

after(() => setIpAccessRulesForTests(null));

describe('parseCidr', () => {
  test('single addresses become /32 and /128, host bits are cleared', () => {
    assert.deepEqual(parseCidr('203.0.113.7'), { cidr: '203.0.113.7/32', address: '203.0.113.7', prefix: 32, family: 4 });
    assert.equal(parseCidr(' 203.0.113.9/24 ')?.cidr, '203.0.113.0/24');
    assert.equal(parseCidr('10.255.255.255/8')?.cidr, '10.0.0.0/8');
    assert.equal(parseCidr('0.0.0.0/0')?.cidr, '0.0.0.0/0');
    assert.equal(parseCidr('::ffff:198.51.100.4')?.cidr, '198.51.100.4/32');
    assert.equal(parseCidr('2001:DB8::1')?.cidr, '2001:db8::1/128');
    assert.equal(parseCidr('2001:db8:abcd:12ff::1/56')?.cidr, '2001:db8:abcd:1200::/56');
    assert.equal(parseCidr('2001:db8::/32')?.cidr, '2001:db8::/32');
    assert.equal(parseCidr('fe80::1%eth0')?.cidr, 'fe80::1/128');
  });

  test('invalid input → null', () => {
    for (const bad of ['', 'x', '1.2.3', '1.2.3.4/33', '1.2.3.4/', '1.2.3.4/-1', '1.2.3.4/a', '::1/129', '300.1.1.1', '1.2.3.4/08x', 'a'.repeat(80)]) {
      assert.equal(parseCidr(bad), null, bad);
    }
  });

  test('compressIpv6 follows RFC 5952 (longest zero run, not a single zero group)', () => {
    assert.equal(compressIpv6([0x2001, 0xdb8, 0, 0, 1, 0, 0, 1]), '2001:db8::1:0:0:1');
    assert.equal(compressIpv6([0x2001, 0xdb8, 0, 1, 1, 1, 1, 1]), '2001:db8:0:1:1:1:1:1');
    assert.equal(compressIpv6([0, 0, 0, 0, 0, 0, 0, 0]), '::');
    assert.equal(compressIpv6([0, 0, 0, 0, 0, 0, 0, 1]), '::1');
  });

  test('cidrContains (IPv4, IPv6, mapped IPv4)', () => {
    assert.equal(cidrContains('203.0.113.0/24', '203.0.113.200'), true);
    assert.equal(cidrContains('203.0.113.0/24', '203.0.114.1'), false);
    assert.equal(cidrContains('203.0.113.0/24', '::ffff:203.0.113.5'), true);
    assert.equal(cidrContains('2001:db8::/32', '2001:db8:ffff::1'), true);
    assert.equal(cidrContains('2001:db8::/32', '2001:db9::1'), false);
    assert.equal(cidrContains('2001:db8::/32', '203.0.113.5'), false);
    assert.equal(cidrContains('bogus', '203.0.113.5'), false);
  });
});

describe('matcher', () => {
  test('BLOCK matches its range, exceptions win, expired rules are ignored', () => {
    const now = Date.now();
    const m = buildIpAccessMatcher([
      { kind: 'BLOCK', cidr: '198.51.100.0/24' },
      { kind: 'ALLOW', cidr: '198.51.100.7' },
      { kind: 'BLOCK', cidr: '2001:db8:bad::/48' },
      { kind: 'BLOCK', cidr: '192.0.2.0/24', expiresAt: new Date(now - 1000) },
      { kind: 'BLOCK', cidr: 'not-a-cidr' },
    ], now);
    assert.equal(m.blocks, 2);
    assert.equal(m.allows, 1);
    assert.equal(m.verdict('198.51.100.8'), 'block');
    assert.equal(m.verdict('::ffff:198.51.100.8'), 'block');
    assert.equal(m.verdict('198.51.100.7'), 'allow');
    assert.equal(m.verdict('2001:db8:bad:1::9'), 'block');
    assert.equal(m.verdict('2001:db8:bae::1'), 'none');
    assert.equal(m.verdict('192.0.2.1'), 'none', 'expired');
    assert.equal(m.verdict(''), 'none');
    assert.equal(m.verdict('garbage'), 'none');
  });
});

describe('connect verdict', () => {
  test('loopback and MAIL_AUTH_EXEMPT_CIDRS are always allowed, even when a rule covers them', () => {
    setIpAccessRulesForTests([{ kind: 'BLOCK', cidr: '10.0.0.0/8' }, { kind: 'BLOCK', cidr: '198.51.100.0/24' }]);
    assert.equal(ipAccessVerdict('127.0.0.1'), 'allow');
    assert.equal(ipAccessVerdict('::1'), 'allow');
    assert.equal(ipAccessVerdict('10.9.1.1'), 'allow', 'env exemption');
    assert.equal(ipAccessVerdict('10.8.1.1'), 'block');
    assert.equal(ipAccessVerdict('198.51.100.20'), 'block');
    assert.equal(ipAccessVerdict('203.0.113.1'), 'none');
    assert.equal(connectGuard.isBlocked('198.51.100.20'), true);
    assert.equal(connectGuard.isBlocked('127.0.0.1'), false);
    assert.equal(connectGuard.isBlocked(undefined), false);
    assert.equal(OPEN_CONNECT_GUARD.isBlocked('198.51.100.20'), false);
  });

  test('isAllowListed = the BCP exceptions only (the lockout exemption)', () => {
    setIpAccessRulesForTests([{ kind: 'ALLOW', cidr: '2001:db8:1::/48' }, { kind: 'BLOCK', cidr: '2001:db8::/32' }]);
    assert.equal(isAllowListed('2001:db8:1::5'), true);
    assert.equal(isAllowListed('2001:db8:2::5'), false);
    assert.equal(ipAccessVerdict('2001:db8:1::5'), 'allow');
    assert.equal(ipAccessVerdict('2001:db8:2::5'), 'block');
  });

  test('the guard reports no lock until startAttackProtection() ran (tests / tools never touch Redis)', async () => {
    assert.equal(await connectGuard.lockedFor('198.51.100.20'), 0);
  });

  test('reload messages are recognised', () => {
    assert.equal(isIpAccessReload(JSON.stringify({ type: 'ip-access' })), true);
    assert.equal(isIpAccessReload(JSON.stringify({ type: 'webmail-policy' })), false);
    assert.equal(isIpAccessReload('{'), false);
  });
});
