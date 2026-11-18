/**
 * 9.4: sender-list validation and CSV import/export (pure).
 * Run: node --import tsx --test src/lib/sender-lists.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma();
const { normalizeEntry, patternError, toCsv, parseCsvRows, parseSenderListCsv, entryKey } = await import('./sender-lists.js');

test('normalizeEntry: defaults, upper-cased enums, lower-cased EXACT/WILDCARD, REGEX kept as written', () => {
  const r = normalizeEntry({ pattern: ' Spam@Example.TEST ' });
  assert.deepEqual(r, { ok: true, entry: { listType: 'BLOCK', scope: 'GLOBAL', target: '', patternType: 'EXACT', pattern: 'spam@example.test', comment: '', active: true } });
  const re = normalizeEntry({ listType: 'allow', patternType: 'regex', pattern: '^\\D+@News\\.example$', scope: 'user', target: 'Bob@Corp.Test', active: 'false' });
  assert.ok(re.ok);
  assert.equal(re.ok && re.entry.pattern, '^\\D+@News\\.example$');
  assert.equal(re.ok && re.entry.target, 'bob@corp.test');
  assert.equal(re.ok && re.entry.active, false);
});

test('normalizeEntry refuses unknown enums, missing/extra targets and invalid patterns', () => {
  const err = (raw: Record<string, unknown>) => { const r = normalizeEntry(raw); return r.ok ? null : r.error; };
  assert.match(err({ listType: 'MAYBE', pattern: 'a@b.c' })!, /listType/);
  assert.match(err({ scope: 'PLANET', pattern: 'a@b.c' })!, /scope/);
  assert.match(err({ scope: 'DOMAIN', pattern: 'a@b.c' })!, /need a target/);
  assert.match(err({ scope: 'GLOBAL', target: 'corp.test', pattern: 'a@b.c' })!, /no target/);
  assert.match(err({ pattern: '*@spam.example' })!, /complete address/);
  assert.match(err({ patternType: 'WILDCARD', pattern: 'spam.example' })!, /at least one \*/);
  assert.match(err({ patternType: 'REGEX', pattern: '(a)\\1' })!, /regular expression/);
  assert.match(err({ pattern: 'a b@c.d' })!, /never occur/);
  assert.match(err({ pattern: '' })!, /1–254/);
  assert.match(err({ pattern: 'a@b.c', comment: 'x'.repeat(501) })!, /comment/);
  assert.equal(patternError('WILDCARD', '*@spam.example'), null);
});

test('CSV round trip with quoting and spreadsheet formula protection', () => {
  const entries = [
    { listType: 'BLOCK' as const, scope: 'GLOBAL' as const, target: '', patternType: 'WILDCARD' as const, pattern: '*@spam.example', comment: 'bulk, "promo"', active: true },
    { listType: 'ALLOW' as const, scope: 'USER' as const, target: 'bob@corp.test', patternType: 'REGEX' as const, pattern: '-?boss@ex\\.test', comment: '=HYPERLINK("x")', active: false },
  ];
  const csv = toCsv(entries);
  assert.match(csv, /^listType,scope,target,patternType,pattern,comment,active\r\n/);
  assert.ok(csv.includes(`"bulk, ""promo"""`));
  assert.ok(csv.includes(`'-?boss@ex\\.test`), 'a cell starting with - is prefixed');
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'formula neutralised');
  const back = parseSenderListCsv(csv);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.entries.map(({ line: _l, ...e }) => e), entries);
  assert.deepEqual(back.entries.map((e) => e.line), [2, 3]);
});

test('parseCsvRows: CRLF/LF, quoted newlines, blank lines skipped', () => {
  assert.deepEqual(parseCsvRows('a,b\n"x\ny",z\r\n\r\nlast,'), [['a', 'b'], ['x\ny', 'z'], ['last', '']]);
});

test('import: header required, per-line errors with line numbers, row limit', () => {
  assert.match(parseSenderListCsv('foo,bar\n1,2\n').errors[0]!.error, /header line/);
  const r = parseSenderListCsv('pattern,scope,target\nok@x.example,GLOBAL,\n*bad,GLOBAL,\nb@x.example,DOMAIN,\n');
  assert.equal(r.entries.length, 1);
  assert.deepEqual(r.errors.map((e) => e.line), [3, 4]);
  const many = `pattern\n${'a@b.c\n'.repeat(5001)}`;
  assert.match(parseSenderListCsv(many).errors[0]!.error, /at most 5000/);
  assert.match(parseSenderListCsv('x'.repeat(1_000_001)).errors[0]!.error, /larger than/);
  // BOM of spreadsheet exports
  assert.equal(parseSenderListCsv('﻿pattern\na@b.c\n').entries.length, 1);
});

test('entryKey identifies list type, scope, owner and pattern', () => {
  const a = { listType: 'BLOCK', scope: 'USER', scopeId: 'u1', patternType: 'EXACT', pattern: 'a@b.c' };
  assert.equal(entryKey(a), entryKey({ ...a }));
  assert.notEqual(entryKey(a), entryKey({ ...a, listType: 'ALLOW' }));
  assert.notEqual(entryKey(a), entryKey({ ...a, scopeId: 'u2' }));
});
