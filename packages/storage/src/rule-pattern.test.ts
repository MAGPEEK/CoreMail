/**
 * Mail-rule regex conditions run on the SMTP delivery path: they must match
 * like the JS engine for the supported subset, refuse the non-linear features
 * and finish in linear time on classic ReDoS patterns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchRulePattern, validateRulePattern, MAX_RULE_PATTERN_LENGTH, MAX_RULE_MATCH_INPUT,
  createRulePatternBudget, rulePatternStepBudget, DEFAULT_RULE_PATTERN_STEP_BUDGET,
  countRegexConditions, MAX_REGEX_CONDITIONS_PER_USER,
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

// ── v8.1 review: negated classes under case folding ─────────────────────────

test('negated classes fold the positive set first: [^a-z] does not match "HELLO"', () => {
  assert.equal(matchRulePattern('[^a-z]', 'HELLO'), false);
  assert.equal(new RegExp('[^a-z]', 'i').test('HELLO'), false);
  assert.equal(matchRulePattern('^[^A-Z]+$', 'hello'), false);
  assert.equal(matchRulePattern('[^a-z]', 'HELLO!'), true);
});

/** Deterministic PRNG (mulberry32) — the property loop is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: character classes (incl. negated) agree with native RegExp /i on every probe character', () => {
  const classes = [
    '[a-z]', '[^a-z]', '[A-Z]', '[^A-Z]', '[^a-zA-Z]', '[^0-9]', '[^\\d]', '[^\\w]', '[^\\W]', '[\\W]', '[^\\s]',
    '[^aeiou]', '[^K]', '[^k]', '[^ß]', '[^ẞ]', '[^ÿ]', '[^Ÿ]', '[^µ]', '[^Μ]', '[^ſ]', '[^s]', '[^ı]', '[^İ]', '[^i]',
    '[^ǅ]', '[^Ǆ]', '[^ǆ]', '[^Ω]', '[^ω]', '[^Ω]', '[^K]', '[^Å]', '[^å]', '[^ä-ö]', '[À-Þ]', '[^À-Þ]', '[^\\u0100-\\u017f]',
    '[^_]', '[^\\x41-\\x5a]', '[^a-c\\d]', '[^-]', '[^\\-z]', '[^A-z]', '[^[-`]', '[^\\]]', '[^.]', '[^ΣσςΣ]', '[^σ]', '[^ς]',
    '\\W', '\\D', '\\S', '.', '[^]', '[]', 'k', 'K', 'ß', 'ſ', 'ς', 'Σ', 'ǅ', '\\u212a', 'å',
  ];
  // every ASCII + Latin-1 unit plus the interesting case-folding specials
  const probes: number[] = [];
  for (let c = 0; c < 0x250; c++) probes.push(c);
  probes.push(0x212a, 0x212b, 0x2126, 0x1e9e, 0x3a3, 0x3c3, 0x3c2, 0x39c, 0x3bc, 0x130, 0x131, 0x17f, 0x1c4, 0x1c5, 0x1c6,
    0x10400, 0xd801, 0xdc00, 0x2028, 0xfb00, 0x345, 0x399, 0x3b9, 0x1fbe);
  let checked = 0;
  for (const cls of classes) {
    const re = new RegExp(`^${cls}$`, 'i');
    for (const c of probes) {
      const s = String.fromCharCode(c);
      assert.equal(matchRulePattern(`^${cls}$`, s), re.test(s), `${cls} on U+${c.toString(16).padStart(4, '0')}`);
      checked++;
    }
  }
  assert.ok(checked > 30_000);
});

test('property: random patterns over a small alphabet agree with native RegExp /i on random inputs', () => {
  const r = rng(0xc0ffee);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const atoms = ['a', 'B', 'k', 'ſ', 'K', 'ä', 'Ä', '.', '\\w', '\\W', '\\d', '[^a-c]', '[^B]', '[a-cK]', '[^ä]', '[^\\W]', '[^k]', '[^\\s\\d]', '[X-Z]', '[^x-z]'];
  const quants = ['', '', '', '?', '*', '+', '{2}', '{1,3}'];
  const alphabet = ['a', 'A', 'b', 'B', 'c', 'k', 'K', 'K', 'ſ', 's', 'S', 'ä', 'Ä', '1', ' ', '-', 'x', 'Z', 'é'];
  let checked = 0;
  for (let i = 0; i < 600; i++) {
    const len = 1 + Math.floor(r() * 4);
    let p = r() < 0.2 ? '^' : '';
    for (let j = 0; j < len; j++) {
      const atom = r() < 0.15 ? `(?:${pick(atoms)}|${pick(atoms)})` : pick(atoms);
      p += atom + pick(quants);
    }
    if (r() < 0.2) p += '$';
    const re = new RegExp(p, 'i');
    for (let k = 0; k < 25; k++) {
      let input = '';
      const n = Math.floor(r() * 8);
      for (let m = 0; m < n; m++) input += pick(alphabet);
      assert.equal(matchRulePattern(p, input), re.test(input), `${p} on ${JSON.stringify(input)}`);
      checked++;
    }
  }
  assert.equal(checked, 15_000);
});

// ── v8.1 review: performance + step budget ──────────────────────────────────

test('(?:[a-z]?){99}[a-z]{99}x on 64 KB stays fast and is cut off by the per-message step budget', () => {
  const p = '(?:[a-z]?){99}[a-z]{99}x';
  const input = 'a'.repeat(MAX_RULE_MATCH_INPUT);
  const budget = createRulePatternBudget({ steps: DEFAULT_RULE_PATTERN_STEP_BUDGET });
  let logged = 0;
  budget.onExhausted = () => { logged++; };
  const t0 = performance.now();
  assert.equal(matchRulePattern(p, input, budget), false);
  const ms = performance.now() - t0;
  assert.equal(budget.exhausted, true);
  assert.equal(logged, 1);
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  // the remaining patterns of this message do not match — even trivial ones — and are not logged again
  assert.equal(matchRulePattern('a', 'a', budget), false);
  assert.equal(logged, 1);
  // a fresh budget: a cheap pattern still matches
  assert.equal(matchRulePattern('a', 'a'), true);
});

test('the budget is shared: steps of earlier patterns count against later ones', () => {
  const budget = createRulePatternBudget({ steps: 1000 });
  assert.equal(matchRulePattern('needle', 'x'.repeat(100) + 'needle', budget), true);
  const left = budget.remaining;
  assert.ok(left < 1000 && left > 0);
  assert.equal(matchRulePattern('needle', 'x'.repeat(5000) + 'needle', budget), false);
  assert.equal(budget.exhausted, true);
  assert.equal(rulePatternStepBudget({ RULE_PATTERN_STEP_BUDGET: '1234' }), 1234);
  assert.equal(rulePatternStepBudget({ RULE_PATTERN_STEP_BUDGET: 'x' }), DEFAULT_RULE_PATTERN_STEP_BUDGET);
  assert.equal(rulePatternStepBudget({}), DEFAULT_RULE_PATTERN_STEP_BUDGET);
});

test('regex conditions are counted for the per-user cap', () => {
  assert.equal(MAX_REGEX_CONDITIONS_PER_USER, 20);
  assert.equal(countRegexConditions([
    [{ operator: 'regex', value: 'a' }, { operator: 'contains', value: 'b' }],
    [{ op: 'REGEX', value: 'c' }], null, undefined,
  ]), 2);
});

test('input beyond 64 KB is not inspected', () => {
  assert.equal(matchRulePattern('needle', 'x'.repeat(MAX_RULE_MATCH_INPUT) + 'needle'), false);
  assert.equal(matchRulePattern('needle', 'x'.repeat(MAX_RULE_MATCH_INPUT - 6) + 'needle'), true);
});
