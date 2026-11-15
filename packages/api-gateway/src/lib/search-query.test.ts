/**
 * Mail search operators (lib/search-query.ts).
 * Run: node --import tsx --test src/lib/search-query.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, parseSearchQuery, parseDay, parseAge, buildSearchConditions, resolveFolderScope,
  matchFolders, searchChips, hasCriteria, MAX_QUERY_LENGTH,
} from './search-query.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const ci = (v: string) => ({ contains: v, mode: 'insensitive' });
const text = (v: string) => ({ OR: [{ subject: ci(v) }, { fromAddr: ci(v) }, { fromName: ci(v) }, { bodyText: ci(v) }] });

test('plain free text is matched exactly as before (whole trimmed query, one substring)', () => {
  const p = parseSearchQuery('  invoice  march  ', NOW);
  assert.equal(p.freeText, 'invoice  march');
  assert.deepEqual(p.clauses, []);
  assert.deepEqual(buildSearchConditions(p), [text('invoice  march')]);
  // "re:" / URLs / times are not operators
  assert.equal(parseSearchQuery('re: hello', NOW).freeText, 're: hello');
  assert.equal(parseSearchQuery('https://x.test/a', NOW).freeText, 'https://x.test/a');
  assert.equal(parseSearchQuery('meeting 12:30', NOW).freeText, 'meeting 12:30');
});

test('tokenizer: quotes, quoted operator values, negation', () => {
  const t = tokenize('from:"Max Mustermann" -"out of office" -spam subject:hi');
  assert.deepEqual(t.map((x) => [x.key, x.value, x.negate, x.quoted]), [
    ['from', 'Max Mustermann', false, true],
    [null, 'out of office', true, true],
    [null, 'spam', true, false],
    ['subject', 'hi', false, false],
  ]);
  // unterminated quote runs to the end; a lone "-" is a word
  assert.deepEqual(tokenize('"abc def').map((x) => x.value), ['abc def']);
  assert.deepEqual(tokenize('a - b').map((x) => [x.value, x.negate]), [['a', false], ['-', false], ['b', false]]);
});

test('operators map onto Prisma conditions', () => {
  const p = parseSearchQuery('from:alice to:Bob@X.test cc:c@x.test subject:Report has:attachment is:unread is:flagged report', NOW);
  assert.equal(p.freeText, 'report');
  assert.deepEqual(buildSearchConditions(p), [
    text('report'),
    { OR: [{ fromAddr: ci('alice') }, { fromName: ci('alice') }] },
    { toAddrs: { hasSome: ['Bob@X.test', 'bob@x.test'] } },
    { ccAddrs: { hasSome: ['c@x.test'] } },
    { subject: ci('Report') },
    { attachments: { some: {} } },
    { NOT: { flags: { has: '\\Seen' } } },
    { flags: { has: '\\Flagged' } },
  ]);
  assert.deepEqual(buildSearchConditions(parseSearchQuery('hasattachment:yes is:read', NOW)), [
    { attachments: { some: {} } }, { flags: { has: '\\Seen' } },
  ]);
  assert.deepEqual(buildSearchConditions(parseSearchQuery('hasattachment:no is:starred', NOW)), [
    { attachments: { none: {} } }, { flags: { has: '\\Flagged' } },
  ]);
});

test('quoted phrases are AND terms, -negation excludes (free text and operators)', () => {
  const p = parseSearchQuery('budget "q3 plan" -draft -from:noreply', NOW);
  assert.deepEqual(buildSearchConditions(p), [
    text('budget'),
    text('q3 plan'),
    { NOT: text('draft') },
    { NOT: { OR: [{ fromAddr: ci('noreply') }, { fromName: ci('noreply') }] } },
  ]);
});

test('dates: before/after/received are validated UTC days', () => {
  assert.equal(parseDay('2026-02-28')?.toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(parseDay('2026/2/3')?.toISOString(), '2026-02-03T00:00:00.000Z');
  for (const bad of ['2026-02-30', '2026-13-01', '1969-12-31', '26-01-01', '2026-01-01T00:00', 'yesterday', '2026-01-01; DROP']) {
    assert.equal(parseDay(bad), null, bad);
  }
  const p = parseSearchQuery('after:2026-01-01 before:2026-02-01 received:2026-01-15', NOW);
  assert.deepEqual(buildSearchConditions(p), [
    { date: { gte: new Date('2026-01-01T00:00:00Z') } },
    { date: { lt: new Date('2026-02-01T00:00:00Z') } },
    { date: { gte: new Date('2026-01-15T00:00:00Z'), lt: new Date('2026-01-16T00:00:00Z') } },
  ]);
  // invalid dates are ignored (reported as invalid chips), never passed on
  const bad = parseSearchQuery('before:2026-02-30 hello', NOW);
  assert.deepEqual(bad.invalid, ['before:2026-02-30']);
  assert.deepEqual(buildSearchConditions(bad), [text('hello')]);
});

test('relative ages: older_than / newer_than with d/w/m/y, capped', () => {
  assert.equal(parseAge('7d'), 7);
  assert.equal(parseAge('2w'), 14);
  assert.equal(parseAge('3m'), 90);
  assert.equal(parseAge('1Y'), 365);
  assert.equal(parseAge('0d'), null);
  assert.equal(parseAge('999999y'), null);
  assert.equal(parseAge('7'), null);
  assert.equal(parseAge('-7d'), null);
  const p = parseSearchQuery('older_than:7d newer_than:1y', NOW);
  assert.deepEqual(buildSearchConditions(p), [
    { date: { lt: new Date('2026-11-08T12:00:00Z') } },
    { date: { gte: new Date('2025-11-15T12:00:00Z') } },
  ]);
});

test('unknown is:/has: values are invalid, not silently matched', () => {
  const p = parseSearchQuery('is:important has:pdf from:', NOW);
  assert.deepEqual(p.invalid, ['is:important', 'has:pdf', 'from:']);
  assert.equal(hasCriteria(p), false);
  assert.equal(hasCriteria(parseSearchQuery('a', NOW)), false, 'single char stays below the minimum');
  assert.equal(hasCriteria(parseSearchQuery('is:unread', NOW)), true);
});

test('in:<folder> resolves aliases / names and overrides the folder scope', () => {
  const folders = [
    { id: 'i', name: 'INBOX', displayName: 'Posteingang' },
    { id: 's', name: 'Sent', displayName: 'Gesendete Elemente' },
    { id: 'p', name: 'projects', displayName: 'Projekte 2026' },
  ];
  assert.deepEqual(matchFolders('inbox', folders), ['i']);
  assert.deepEqual(matchFolders('Posteingang', folders), ['i']);
  assert.deepEqual(matchFolders('projekte 2026', folders), ['p']);
  assert.deepEqual(matchFolders('nope', folders), []);
  // explicit in: wins over the list scope (inbox)
  assert.deepEqual(resolveFolderScope(parseSearchQuery('in:sent x', NOW), ['i'], folders), ['s']);
  assert.deepEqual(resolveFolderScope(parseSearchQuery('in:"Projekte 2026"', NOW), ['i'], folders), ['p']);
  // negated in: only narrows the current scope
  assert.deepEqual(resolveFolderScope(parseSearchQuery('-in:sent x', NOW), ['i', 's', 'p'], folders), ['i', 'p']);
  // unknown folder → empty scope (no results), not "everything"
  assert.deepEqual(resolveFolderScope(parseSearchQuery('in:nope', NOW), ['i'], folders), []);
  // in: produces no where-condition of its own
  assert.deepEqual(buildSearchConditions(parseSearchQuery('in:sent', NOW)), []);
});

test('chips: recognised and invalid operators with their raw token', () => {
  const chips = searchChips(parseSearchQuery('hello from:"A B" -is:read before:2026-99-01', NOW));
  assert.deepEqual(chips, [
    { key: 'from', value: 'A B', negate: false, valid: true, raw: 'from:"A B"' },
    { key: 'is', value: 'read', negate: true, valid: true, raw: '-is:read' },
    { key: 'before', value: '2026-99-01', negate: false, valid: false, raw: 'before:2026-99-01' },
  ]);
});

test('query length and clause count are bounded', () => {
  const long = 'x'.repeat(MAX_QUERY_LENGTH + 100);
  assert.equal(parseSearchQuery(long, NOW).freeText.length, MAX_QUERY_LENGTH);
  const many = Array.from({ length: 100 }, (_, i) => `subject:s${i}`).join(' ');
  assert.ok(parseSearchQuery(many, NOW).clauses.length <= 30);
});
