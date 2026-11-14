import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretDnsblAnswer, normalizeSenderIp, reverseIpForDnsbl, isNonRoutableSender, isNxdomainError } from './answer.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';
// no Prisma engine in unit tests — the stub is picked up by @coremail/storage/prisma
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };
const { queryZone, clearDnsblCache } = await import('./index.js');

test('DNSBL return-code interpretation', () => {
  const t: Array<[string[], boolean, string]> = [
    [[], false, 'clean'],                                   // NXDOMAIN
    [['127.0.0.2'], false, 'listed'],
    [['127.0.0.4', '127.0.0.10'], false, 'listed'],
    [['127.255.255.254'], false, 'refused'],               // Spamhaus: public resolver
    [['127.255.255.252'], false, 'refused'],               // typo
    [['127.255.255.255'], false, 'refused'],               // excessive queries
    [['127.0.0.2', '127.255.255.254'], false, 'refused'],
    [['127.0.0.1'], false, 'refused'],                     // generic "query refused"
    [['93.184.216.34'], false, 'clean'],                   // NXDOMAIN hijacking → ignored
    [['127.0.15.1'], true, 'listed'],                      // DNSWL trust answer
    [['127.0.0.255'], true, 'refused'],                    // DNSWL over limit
    [['127.0.0.255'], false, 'listed'],                    // not an error code for blocklists
  ];
  for (const [addrs, wl, state] of t) {
    assert.equal(interpretDnsblAnswer(addrs, wl).state, state, `${addrs.join(',')} wl=${wl}`);
  }
  assert.deepEqual(interpretDnsblAnswer(['127.0.0.2', '8.8.8.8']).codes, ['127.0.0.2']);
});

test('IPv4-mapped IPv6 senders are queried as IPv4', () => {
  assert.equal(normalizeSenderIp('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(normalizeSenderIp('::FFFF:c000:0201'), '192.0.2.1');
  assert.equal(reverseIpForDnsbl('::ffff:192.0.2.1'), '1.2.0.192');
  assert.equal(reverseIpForDnsbl('2001:db8::1'), '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2');
  assert.equal(reverseIpForDnsbl('nope'), '');
  assert.equal(isNonRoutableSender('::ffff:10.1.2.3'), true);
  assert.equal(isNonRoutableSender('::ffff:8.8.8.8'), false);
  assert.equal(isNonRoutableSender('fe80::1'), true);
  assert.equal(isNxdomainError({ code: 'ENOTFOUND' }), true);
  assert.equal(isNxdomainError({ code: 'ETIMEOUT' }), false);
});

test('queryZone caches positive and NXDOMAIN answers, never timeouts or refusals', async () => {
  clearDnsblCache();
  let n = 0;
  const timeout = async () => { n++; throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); };
  assert.deepEqual(await queryZone('1.2.0.192', 'zen.example', '192.0.2.1', false, timeout), { listed: false });
  await queryZone('1.2.0.192', 'zen.example', '192.0.2.1', false, timeout);
  assert.equal(n, 2, 'timeouts are not cached');

  n = 0;
  const refused = async () => { n++; return ['127.255.255.254']; };
  assert.deepEqual(await queryZone('1.2.0.192', 'zen2.example', '192.0.2.1', false, refused), { listed: false, refused: true });
  await queryZone('1.2.0.192', 'zen2.example', '192.0.2.1', false, refused);
  assert.equal(n, 2, 'refusals are not cached');

  n = 0;
  const listed = async () => { n++; return ['127.0.0.2']; };
  assert.deepEqual(await queryZone('1.2.0.192', 'zen3.example', '192.0.2.1', false, listed), { listed: true, response: '127.0.0.2' });
  await queryZone('1.2.0.192', 'zen3.example', '192.0.2.1', false, listed);
  assert.equal(n, 1, 'positive answers are cached');

  n = 0;
  const nx = async () => { n++; throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); };
  await queryZone('1.2.0.192', 'zen4.example', '192.0.2.1', false, nx);
  await queryZone('1.2.0.192', 'zen4.example', '192.0.2.1', false, nx);
  assert.equal(n, 1, 'NXDOMAIN is cached');
  clearDnsblCache();
});
