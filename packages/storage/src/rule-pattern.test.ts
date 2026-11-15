/**
 * Mail-rule regex conditions run on the SMTP delivery path: they must match
 * like the JS engine for the supported subset, refuse the non-linear features
 * and finish in linear time on classic ReDoS patterns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchRulePattern, validateRulePattern, MAX_RULE_PATTERN_LENGTH, MAX_RULE_MATCH_INPUT,
} from './rule-pattern.js';

const SAME_AS_NATIVE: Array<[string, string[]]> = [
  ['invoice', ['Your INVOICE 42', 'nothing', '']],
  ['^re:', ['re: hi', 'fw: re: hi', 'RE: x']],
  ['urgent$', ['very urgent', 'urgent!', 'URGENT']],
  ['\\binv\\b', ['an inv here', 'invoice', 'inv', 'x-inv-y']],
  ['\\Bvoice', ['invoice', 'voice']],
  ['a.c', ['abc', 'a\nc', 'ac']],
  ['[a-c]+x', ['zzbcax', 'x', 'ABCX']],
  ['[^0-9]{3}', ['12a45', 'ab1cd', 'abc']],
  ['\\d{2,4}-\\d+', ['call 123-4', '1-2', '12345-']],
  ['(foo|bar)baz', ['xbarbaz', 'foobaz', 'fobaz']],
  ['(?:ab)*c', ['ababc', 'c', 'abab']],
  ['colou?r', ['color', 'colour', 'colouur']],
  ['x{2}', ['xx', 'x', 'axxb']],
  ['a{2,}', ['a', 'aa', 'baaab']],
  ['\\s+offer', ['great   offer', 'offer', 'special\toffer']],
  ['[\\w.]+@example\\.com', ['john.doe@example.com', 'x@exampleXcom']],
  ['\\x41\\u0042', ['ab', 'xABy', 'a b']],
  ['[a\\-z]', ['-', 'b', 'z']],
  ['[\\d-x]', ['-', '5', 'x', 'y']],
  ['a|', ['zzz', '']],
  ['()', ['x']],
  ['[]', ['x']],
  ['[^]', ['x', '']],
  ['a{,2}', ['a{,2}', 'a']],
  ['ä', ['Ä', 'a']],
  ['(a|b)*?c', ['ababc', 'abab']],
  ['\\.\\*', ['.*', 'x']],
];

test('the linear-time matcher agrees with the JS engine on the supported subset', () => {
  for (const [pattern, inputs] of SAME_AS_NATIVE) {
    assert.deepEqual(validateRulePattern(pattern), { ok: true }, pattern);
    const re = new RegExp(pattern, 'i');
    for (const input of inputs) {
      assert.equal(matchRulePattern(pattern, input), re.test(input), `${pattern} on ${JSON.stringify(input)}`);
    }
  }
});

test('backreferences, lookarounds, named groups and oversized patterns are refused', () => {
  for (const p of ['(a)\\1', '(?<n>a)\\k<n>', 'a(?=b)', 'a(?!b)', '(?<=a)b', '(?<!a)b', '\\p{L}', '\\cA', 'a{1,500}',
    '(', 'a**', '*a', '[z-a]', 'x'.repeat(MAX_RULE_PATTERN_LENGTH + 1)]) {
    const v = validateRulePattern(p);
    assert.equal(v.ok, false, p);
    assert.equal(matchRulePattern(p, 'aab'), false, p);
  }
  assert.equal(validateRulePattern(42).ok, false);
  assert.equal(validateRulePattern('x'.repeat(MAX_RULE_PATTERN_LENGTH)).ok, true);
});

test('classic ReDoS patterns finish in linear time on hostile input', () => {
  const hostile = 'a'.repeat(MAX_RULE_MATCH_INPUT - 1) + '!';
  for (const p of ['^(a+)+$', '^(a|a)*$', '(a*)*b', '.*.*.*x', '^(\\w+\\s?)*$', '^(a|aa)+$', '(x+x+)+y']) {
    const t0 = Date.now();
    assert.equal(matchRulePattern(p, hostile), false, p);
    assert.equal(new RegExp(p, 'i').test('aaaa!'), false, p); // same verdict as the JS engine
    assert.ok(Date.now() - t0 < 2000, `${p} took ${Date.now() - t0} ms`);
  }
  // matches still work on long inputs
  assert.equal(matchRulePattern('(a+)+!', 'b' + 'a'.repeat(1000) + '!'), true);
});

test('input beyond 64 KB is not inspected', () => {
  assert.equal(matchRulePattern('needle', 'x'.repeat(MAX_RULE_MATCH_INPUT) + 'needle'), false);
  assert.equal(matchRulePattern('needle', 'x'.repeat(MAX_RULE_MATCH_INPUT - 6) + 'needle'), true);
});
