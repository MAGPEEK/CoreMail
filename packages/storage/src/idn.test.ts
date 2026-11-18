/**
 * 9.4 review: internationalized domains in address comparisons — the shared
 * canonical form and the mail-flow accept / reject lists.
 * Run: node --import tsx --test src/idn.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAddress, canonicalDomain, addressVariants, domainVariants } from './idn.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
(globalThis as unknown as { __prisma: unknown }).__prisma ??= { $on: () => undefined };
const { normalizeSenderPattern, parseSenderList, senderMatches, senderRefusal, SENDER_REFUSED_REPLY } = await import('./mail-flow.js');

const U = 'bücher.example';
const A = 'xn--bcher-kva.example';

test('canonical form: lower case, A-label, brackets dropped; wildcard labels converted one by one', () => {
  assert.equal(canonicalDomain('BÜCHER.Example.'), A);
  assert.equal(canonicalDomain(A.toUpperCase()), A);
  assert.equal(canonicalAddress(' <Info@Bücher.Example> '), `info@${A}`);
  assert.equal(canonicalAddress('no-at-sign'), 'no-at-sign');
  assert.equal(canonicalDomain(`*.${U}`), `*.${A}`);
  assert.deepEqual(new Set(domainVariants(A)), new Set([A, U]));
  assert.deepEqual(new Set(addressVariants(`a@${U}`)), new Set([`a@${U}`, `a@${A}`]));
});

test('mail flow lists: a Unicode entry is stored as A-label and is no longer refused as invalid', () => {
  assert.equal(normalizeSenderPattern(U), A);
  assert.equal(normalizeSenderPattern(`@${U}`), A);
  assert.equal(normalizeSenderPattern(`Info@${U}`), `info@${A}`);
  const parsed = parseSenderList([U, A, `x@${U}`]);
  assert.deepEqual(parsed, { ok: true, values: [A, `x@${A}`] }, 'both spellings are one entry');
});

test('mail flow lists: Unicode and punycode spellings match each other (entries and senders, subdomains)', () => {
  for (const pattern of [A, U]) {
    assert.equal(senderMatches(pattern, `x@${U}`), true);
    assert.equal(senderMatches(pattern, `x@${A}`), true);
    assert.equal(senderMatches(pattern, `x@mail.${U}`), true);
    assert.equal(senderMatches(pattern, 'x@other.example'), false);
  }
  assert.equal(senderMatches(`x@${U}`, `X@${A.toUpperCase()}`), true);
  assert.equal(senderRefusal({ acceptFrom: [], rejectFrom: [A] }, [`spam@${U}`]), SENDER_REFUSED_REPLY);
  assert.equal(senderRefusal({ acceptFrom: [U], rejectFrom: [] }, [`ok@${A}`]), null);
});
