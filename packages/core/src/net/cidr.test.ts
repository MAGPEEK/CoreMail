/**
 * Strict CIDR allow-lists (device relay): no implicit loopback, invalid
 * entries never widen the list, IPv4-mapped IPv6 clients match IPv4 ranges.
 * Run: node --import tsx --test src/net/cidr.test.ts  (in packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCidrMatcher, parseCidr } from './cidr.js';

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

test('non-IP client values never match', () => {
  const m = createCidrMatcher(['0.0.0.0/0']);
  assert.equal(m.contains(''), false);
  assert.equal(m.contains(undefined), false);
  assert.equal(m.contains('unknown'), false);
});
