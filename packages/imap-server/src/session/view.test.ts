/**
 * v7.1.0: per-session sequence map (session/view.ts) and mailbox-name codec.
 *  - sequence sets resolve through the session's view; "*" and "$" work
 *  - very large folders: no "Maximum call stack size exceeded" from Math.max(...uids)
 *  - modified UTF-7 round trip, INBOX case-insensitivity
 * Run: node --import tsx --test src/session/view.test.ts (in packages/imap-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
// No database: @coremail/storage uses this stand-in instead of a real PrismaClient.
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const { createView, resolveSet, seqOf, isValidSequenceSet, reportExpunged } = await import('./view.js');
const { encodeMutf7, decodeMutf7, canonicalInbox } = await import('../commands/mailbox-name.js');

const folder = { id: 'f1', name: 'INBOX', uidValidity: 1 };
const rows = (uids: number[]) => uids.map((uid) => ({ uid, flags: [], modSeq: 1n }));

test('sequence numbers and UIDs resolve through the view', () => {
  const view = createView(folder, rows([5, 9, 12]), false);
  assert.deepEqual(resolveSet(view, '1', false), [5]);
  assert.deepEqual(resolveSet(view, '2:*', false), [9, 12]);
  assert.deepEqual(resolveSet(view, '*:2', false), [9, 12]);
  assert.deepEqual(resolveSet(view, '5', false), [], 'sequence number 5 does not exist (UID 5 does)');
  assert.deepEqual(resolveSet(view, '9:12', true), [9, 12]);
  assert.deepEqual(resolveSet(view, '13:*', true), [12], '"*" is the highest UID of the view');
  assert.deepEqual(resolveSet(view, '6', true), []);
  view.searchRes = [12, 9, 99];
  assert.deepEqual(resolveSet(view, '$', false), [9, 12], '"$" is limited to messages of the view');
  assert.equal(isValidSequenceSet('$'), true);
  assert.equal(isValidSequenceSet('1,$'), false);
  assert.equal(seqOf(view, 12), 3);
  assert.equal(seqOf(view, 6), 0);
});

test('EXPUNGE responses renumber the following messages', () => {
  const view = createView(folder, rows([5, 9, 12, 20]), false);
  const sent: string[] = [];
  const session = { socket: { write: (s: string) => { sent.push(s.trim()); return true; } } };
  reportExpunged(session as never, view, new Set([9, 12]));
  assert.deepEqual(sent, ['* 2 EXPUNGE', '* 2 EXPUNGE']);
  assert.deepEqual(view.uids, [5, 20]);
  assert.equal(seqOf(view, 20), 2);
});

test('UID sets work in folders with more than 200 000 messages', () => {
  // Math.max(...uids) used to throw a RangeError above ~150k elements.
  const uids = Array.from({ length: 250_000 }, (_, i) => i + 1);
  const view = createView(folder, rows(uids), false);
  assert.deepEqual(resolveSet(view, '249999:*', true), [249_999, 250_000]);
  assert.deepEqual(resolveSet(view, '*', true), [250_000]);
  assert.equal(resolveSet(view, '1:*', false).length, 250_000);
});

test('modified UTF-7 (RFC 3501 §5.1.3)', () => {
  assert.equal(encodeMutf7('Entwürfe'), 'Entw&APw-rfe');
  assert.equal(encodeMutf7('A&B'), 'A&-B');
  assert.equal(encodeMutf7('日本語'), '&ZeVnLIqe-');
  assert.equal(decodeMutf7('Entw&APw-rfe'), 'Entwürfe');
  assert.equal(decodeMutf7('A&-B'), 'A&B');
  assert.equal(decodeMutf7('&ZeVnLIqe-'), '日本語');
  for (const name of ['Café', 'Ünïcödé.Sub', 'R&D', '😀 fun']) assert.equal(decodeMutf7(encodeMutf7(name)), name);
  assert.equal(decodeMutf7('A&B'), null, 'unterminated shift sequence');
});

test('INBOX is case-insensitive, also as the first hierarchy level', () => {
  assert.equal(canonicalInbox('inbox'), 'INBOX');
  assert.equal(canonicalInbox('Inbox.Sub'), 'INBOX.Sub');
  assert.equal(canonicalInbox('Inboxes'), 'Inboxes');
  assert.equal(canonicalInbox('Sent'), 'Sent');
});

// ─── v8.0 pre-release review fixes ──────────────────────────────────────────

const { patternMatcher, wildcardMatch } = await import('../commands/list.js');
const { legacyDecoded, displayName, displayNames, storedCandidates } = await import('../commands/mailbox-name.js');

test('LIST patterns: "*" crosses the delimiter, "%" does not, INBOX in any case', () => {
  const m = (p: string, n: string): boolean => patternMatcher(p)(n);
  assert.ok(m('*', 'Archive.2025'));
  assert.ok(m('%', 'Archive') && !m('%', 'Archive.2025'));
  assert.ok(m('Archive.%', 'Archive.2025') && !m('Archive.%', 'Archive.2025.Q1'));
  assert.ok(m('A*5', 'Archive.2025') && !m('A%5', 'Archive.2025'));
  assert.ok(m('*.%', 'a.b.c') && m('%.*', 'a.b.c'));
  assert.ok(m('%%*%', 'x.y'), 'a run of wildcards with a "*" is "*"');
  assert.ok(!m('%%', 'x.y'), 'a run of "%" is "%"');
  assert.ok(m('a.b', 'a.b') && !m('a.b', 'aXb'), '"." is a literal, not a regex dot');
  assert.ok(m('(x)[y]+$', '(x)[y]+$') && !m('Arch', 'Archive'));
  assert.ok(m('in%', 'INBOX') && !m('in%', 'Inbound'));
  assert.ok(wildcardMatch('', '') && !wildcardMatch('', 'a') && wildcardMatch('*', ''));
});

test('LIST pattern matching is linear: no catastrophic backtracking (ReDoS)', () => {
  // The former regex translation needed minutes for this (12+ wildcards, 40-char name).
  const evil = `${'*a'.repeat(40)}X`;
  const evilPct = `${'%a'.repeat(40)}X`;
  const names = ['a'.repeat(40), 'a'.repeat(255), `${'a'.repeat(500)}.${'a'.repeat(500)}`];
  const started = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) {
    for (const name of names) {
      assert.equal(patternMatcher(evil)(name), false);
      assert.equal(patternMatcher(evilPct)(name), false);
    }
  }
  // Maximum pattern length against a long name, too.
  assert.equal(patternMatcher(`${'*a'.repeat(511)}X`)('a'.repeat(1000)), false);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000, `pattern matching took ${ms.toFixed(0)} ms`);
});

test('legacy folder rows stored in modified UTF-7 (<= 7.0.0) keep their name and display decoded', () => {
  assert.equal(legacyDecoded('Entw&APw-rfe'), 'Entwürfe');
  assert.equal(displayName('Entw&APw-rfe'), 'Entwürfe');
  assert.equal(encodeMutf7(displayName('Entw&APw-rfe')), 'Entw&APw-rfe', 'a rev1 client sees the octets it saw before');
  assert.equal(legacyDecoded('Entw&APw-rfe.Sub'), 'Entwürfe.Sub');
  assert.equal(legacyDecoded('A&-B'), 'A&B');
  // Not the canonical encoding of a different name ("&AGE-" = "a" is never produced by an encoder).
  for (const plain of ['Entwürfe', 'R&D', 'Tom&Jerry-x', 'Sent', 'A&B', 'x&AGE-', '&AEE-']) {
    assert.equal(legacyDecoded(plain), null, plain);
    assert.equal(displayName(plain), plain);
  }
  assert.deepEqual(storedCandidates('Entwürfe'), ['Entwürfe', 'Entw&APw-rfe']);
  assert.deepEqual(storedCandidates('Sent'), ['Sent']);
  assert.deepEqual(storedCandidates('A&B'), ['A&B', 'A&-B']);
  // A legacy row next to a UTF-8 row of the same name keeps its stored name (both reachable).
  assert.deepEqual([...displayNames(['Entw&APw-rfe', 'Entwürfe'])], [['Entw&APw-rfe', 'Entw&APw-rfe'], ['Entwürfe', 'Entwürfe']]);
  assert.deepEqual([...displayNames(['Entw&APw-rfe', 'Sent'])], [['Entw&APw-rfe', 'Entwürfe'], ['Sent', 'Sent']]);
});
