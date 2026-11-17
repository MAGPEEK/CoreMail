/**
 * Strict CIDR allow-lists (device relay): no implicit loopback, invalid
 * entries never widen the list, IPv4-mapped IPv6 clients match IPv4 ranges.
 * Run: node --import tsx --test src/net/cidr.test.ts  (in packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCidrMatcher, parseCidr, cidrTooBroad, RELAY_NETWORK_MIN_PREFIX } from './cidr.js';

test('parseCidr canonicalises addresses and host routes', () => {
  assert.deepEqual(parseCidr('192.168.10.0/24'), { cidr: '192.168.10.0/24', address: '192.168.10.0', prefix: 24, family: 4 });
  assert.equal(parseCidr('10.0.0.7')?.cidr, '10.0.0.7/32');
  assert.equal(parseCidr('fd00::/8')?.cidr, 'fd00::/8');
  assert.equal(parseCidr('2001:db8::1')?.prefix, 128);
});

test('parseCidr rejects garbage and out-of-range prefixes', () => {
  for (const bad of ['', 'printer.local', '10.0.0.0/33', 'fd00::/129', '10.0.0.0/', '10.0.0.0/-1', '10.0.0/8', '0.0.0.0/abc']) {
    assert.equal(parseCidr(bad), null, bad);
  }
});

test('matcher contains only listed ranges', () => {
  const m = createCidrMatcher(['192.168.10.0/24', '10.1.2.3']);
  assert.equal(m.contains('192.168.10.55'), true);
  assert.equal(m.contains('::ffff:192.168.10.55'), true);
  assert.equal(m.contains('10.1.2.3'), true);
  assert.equal(m.contains('10.1.2.4'), false);
  assert.equal(m.contains('192.168.11.1'), false);
  assert.equal(m.contains('203.0.113.9'), false);
});

test('empty list allows nothing — loopback is not implicit', () => {
  const m = createCidrMatcher([]);
  assert.equal(m.contains('127.0.0.1'), false);
  assert.equal(m.contains('::1'), false);
});

test('invalid entries are reported and ignored', () => {
  const m = createCidrMatcher('10.0.0.0/8, nonsense, 0.0.0.0/99');
  assert.deepEqual(m.entries, ['10.0.0.0/8']);
  assert.deepEqual(m.invalid, ['nonsense', '0.0.0.0/99']);
  assert.equal(m.contains('8.8.8.8'), false);
});

test('IPv4-mapped IPv6 entries are IPv4 entries (hex and dotted, canonical form)', () => {
  assert.deepEqual(parseCidr('::ffff:a00:0/104'), { cidr: '10.0.0.0/8', address: '10.0.0.0', prefix: 8, family: 4 });
  assert.equal(parseCidr('::ffff:10.1.2.3')?.cidr, '10.1.2.3/32');
  assert.equal(parseCidr('0:0:0:0:0:FFFF:C0A8:0/120')?.cidr, '192.168.0.0/24');
  assert.equal(parseCidr('::ffff:0:0/96')?.cidr, '0.0.0.0/0');
  assert.equal(parseCidr('2001:DB8::/32')?.cidr, '2001:db8::/32');
});

test('an IPv6 entry never matches IPv4 clients — not even one containing the mapped range', () => {
  // node's BlockList alone matches every IPv4 address against ::/32 or ::ffff:0:0/80
  for (const entry of ['::/32', '::/80', '::ffff:0:0/80', '::ffff:0:0/95']) {
    const m = createCidrMatcher([entry]);
    assert.equal(m.contains('203.0.113.9'), false, entry);
    assert.equal(m.contains('::ffff:203.0.113.9'), false, `${entry} (mapped client)`);
    assert.equal(m.contains('::ffff:cb00:7109'), false, `${entry} (hex mapped client)`);
  }
  const v6 = createCidrMatcher(['2001:db8::/32']);
  assert.equal(v6.contains('2001:db8::25'), true);
  assert.equal(v6.contains('2001:db9::25'), false);
});

test('mapped clients in hex form match IPv4 entries', () => {
  const m = createCidrMatcher(['10.0.0.0/8']);
  assert.equal(m.contains('::ffff:a01:203'), true);
  assert.equal(m.contains('::FFFF:10.1.2.3%eth0'), true);
});

test('minPrefix: broader entries are ignored and reported (mapped ranges count as IPv4)', () => {
  const m = createCidrMatcher(['0.0.0.0/0', '::ffff:0:0/96', '::ffff:a00:0/100', '2001:db8::/16', '10.0.0.0/8', '2001:db8::/32'], { minPrefix: RELAY_NETWORK_MIN_PREFIX });
  assert.deepEqual(m.tooBroad, ['0.0.0.0/0', '::ffff:0:0/96', '::ffff:a00:0/100', '2001:db8::/16']);
  assert.deepEqual(m.entries, ['10.0.0.0/8', '2001:db8::/32']);
  assert.equal(m.contains('203.0.113.9'), false);
  assert.equal(cidrTooBroad(parseCidr('10.0.0.0/7')!, RELAY_NETWORK_MIN_PREFIX), true);
  assert.equal(cidrTooBroad(parseCidr('10.0.0.0/8')!, RELAY_NETWORK_MIN_PREFIX), false);
});

test('non-IP client values never match', () => {
  const m = createCidrMatcher(['0.0.0.0/0']);
  assert.equal(m.contains(''), false);
  assert.equal(m.contains(undefined), false);
  assert.equal(m.contains('unknown'), false);
});
