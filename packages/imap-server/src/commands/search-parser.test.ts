import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../server/tokenizer.js';
import {
  parseSearch, evaluateSearch, needsBody, formatEsearch, toSequenceSet, inSequenceSet, parseSearchDate,
  SearchSyntaxError, type SearchableMessage, type SearchProgram,
} from './search-parser.js';

const parse = (program: string): SearchProgram => parseSearch(tokenize([`A1 SEARCH ${program}`]).slice(2));

const MESSAGES: SearchableMessage[] = [
  { uid: 5, modSeq: 10n, flags: ['\\Seen'], subject: 'Quarterly report', fromAddr: 'alice@example.test', fromName: 'Alice',
    toAddrs: ['bob@example.test'], ccAddrs: [], bccAddrs: [], date: new Date('2026-02-01T23:30:00Z'),
    createdAt: new Date('2026-02-02T08:00:00Z'), rawSize: 1000, bodyText: 'Numbers attached', bodyHtml: '' },
  { uid: 9, modSeq: 20n, flags: ['\\Seen', '\\Flagged', '$Important'], subject: 'Lunch?', fromAddr: 'carol@example.test',
    fromName: 'Carol', toAddrs: ['bob@example.test'], ccAddrs: ['dave@example.test'], bccAddrs: [],
    date: new Date('2026-02-03T10:00:00Z'), createdAt: new Date('2026-02-03T10:00:01Z'), rawSize: 5000,
    bodyText: 'Pizza today', bodyHtml: '', messageId: '<lunch@example.test>' },
  { uid: 12, modSeq: 30n, flags: [], subject: 'Re: Quarterly report', fromAddr: 'bob@example.test', fromName: '',
    toAddrs: ['alice@example.test'], ccAddrs: [], bccAddrs: ['eve@example.test'], date: new Date('2026-02-05T09:00:00Z'),
    createdAt: new Date('2026-02-05T09:00:00Z'), rawSize: 200, bodyText: 'See attachment', bodyHtml: '<p>Totals</p>' },
];

function run(program: string, byUid = true): number[] {
  const { key } = parse(program);
  const maxUid = MESSAGES[MESSAGES.length - 1]?.uid ?? 0;
  return MESSAGES.flatMap((m, i) =>
    evaluateSearch(key, m, { seq: i + 1, maxSeq: MESSAGES.length, maxUid }) ? [byUid ? m.uid : i + 1] : []);
}

test('ALL and flag keys', () => {
  assert.deepEqual(run('ALL'), [5, 9, 12]);
  assert.deepEqual(run('UNSEEN'), [12]);
  assert.deepEqual(run('FLAGGED'), [9]);
  assert.deepEqual(run('UNFLAGGED SEEN'), [5]);
  assert.deepEqual(run('KEYWORD $important'), [9]);
  assert.deepEqual(run('UNKEYWORD $Important'), [5, 12]);
});

test('multiple keys are ANDed, NOT and OR nest', () => {
  assert.deepEqual(run('SEEN UNFLAGGED'), [5]);
  assert.deepEqual(run('NOT SEEN'), [12]);
  assert.deepEqual(run('OR FLAGGED UNSEEN'), [9, 12]);
  assert.deepEqual(run('NOT OR FLAGGED UNSEEN'), [5]);
  assert.deepEqual(run('(SEEN FLAGGED) OR UID 5 UID 9'), [9]);
});

test('text keys are case-insensitive substring matches', () => {
  assert.deepEqual(run('SUBJECT "quarterly REPORT"'), [5, 12]);
  assert.deepEqual(run('FROM carol'), [9]);
  assert.deepEqual(run('FROM alice'), [5]);
  assert.deepEqual(run('TO alice'), [12]);
  assert.deepEqual(run('CC dave'), [9]);
  assert.deepEqual(run('BCC eve'), [12]);
  assert.deepEqual(run('BODY totals'), [12]);
  assert.deepEqual(run('TEXT pizza'), [9]);
  assert.deepEqual(run('HEADER Message-ID lunch'), [9]);
  assert.deepEqual(run('HEADER X-Unknown ""'), []);
});

test('date keys compare whole days and distinguish internal and sent date', () => {
  assert.deepEqual(run('ON 2-Feb-2026'), [5]);           // internal date (createdAt)
  assert.deepEqual(run('SENTON 1-Feb-2026'), [5]);       // Date header
  assert.deepEqual(run('BEFORE 3-Feb-2026'), [5]);
  assert.deepEqual(run('SINCE 3-Feb-2026'), [9, 12]);
  assert.deepEqual(run('SENTSINCE "05-Feb-2026"'), [12]);
  assert.deepEqual(run('SENTBEFORE 3-Feb-2026'), [5]);
});

test('size, UID, sequence-set and MODSEQ keys', () => {
  assert.deepEqual(run('LARGER 1000'), [9]);
  assert.deepEqual(run('SMALLER 1000'), [12]);
  assert.deepEqual(run('UID 9:*'), [9, 12]);
  assert.deepEqual(run('UID 6:8'), []);
  assert.deepEqual(run('2:*', false), [2, 3]);
  assert.deepEqual(run('1,3', false), [1, 3]);
  assert.deepEqual(run('MODSEQ 20'), [9, 12]);
  assert.deepEqual(run('MODSEQ "/flags/\\\\seen" all 30'), [12]);
});

test('unknown keys and missing arguments are syntax errors', () => {
  assert.throws(() => parse('FROBNICATED'), SearchSyntaxError);
  assert.throws(() => parse('SUBJECT'), SearchSyntaxError);
  assert.throws(() => parse('BEFORE yesterday'), SearchSyntaxError);
  assert.throws(() => parse('UID abc'), SearchSyntaxError);
  assert.throws(() => parse('OR SEEN'), SearchSyntaxError);
  assert.throws(() => parseSearch([]), SearchSyntaxError);
});

test('RETURN and CHARSET prefixes', () => {
  assert.deepEqual(parse('RETURN (MIN COUNT) CHARSET UTF-8 ALL'), { returnOptions: ['MIN', 'COUNT'], charset: 'UTF-8', key: { op: 'all' } });
  assert.deepEqual(parse('RETURN () ALL').returnOptions, ['ALL']);
  assert.throws(() => parse('RETURN (SAVE) ALL'), SearchSyntaxError);
  assert.equal(parse('ALL').returnOptions, null);
});

test('needsBody only for BODY and TEXT', () => {
  assert.equal(needsBody(parse('SUBJECT x FROM y').key), false);
  assert.equal(needsBody(parse('NOT OR SEEN BODY x').key), true);
  assert.equal(needsBody(parse('TEXT x').key), true);
});

test('ESEARCH formatting (RFC 4731)', () => {
  assert.equal(formatEsearch('A1', false, [3, 1, 2, 7], ['MIN', 'MAX', 'COUNT', 'ALL']), '(TAG "A1") MIN 1 MAX 7 COUNT 4 ALL 1:3,7');
  assert.equal(formatEsearch('A2', true, [], ['MIN', 'COUNT', 'ALL']), '(TAG "A2") UID COUNT 0');
});

test('sequence-set helpers', () => {
  assert.equal(toSequenceSet([9, 1, 2, 3, 5]), '1:3,5,9');
  assert.equal(inSequenceSet('*', 7, 7), true);
  assert.equal(inSequenceSet('5:*', 3, 7), false);
  assert.equal(inSequenceSet('*:5', 6, 7), true);
  assert.equal(parseSearchDate('31-Dec-2025'), Date.UTC(2025, 11, 31) / 86_400_000);
  assert.equal(parseSearchDate('2025-12-31'), null);
});
