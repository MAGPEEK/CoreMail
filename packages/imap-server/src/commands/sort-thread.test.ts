/**
 * SORT / THREAD (RFC 5256) — base subject, sort order, thread algorithms — and
 * the UID range helpers behind QRESYNC VANISHED responses.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseSubject, sortMessages, parseSortCriteria, threadOrderedSubject, threadReferences, formatThreads, msgIds,
  type SortMessage,
} from './sort-thread.js';
import { tokenize } from '../server/tokenizer.js';
import {
  parseUidRanges, subtractUids, clampRanges, chunkRanges, formatRanges, rangesOf,
} from '../session/uid-set.js';

let seqCounter = 0;
const msg = (over: Partial<SortMessage> & { uid: number }): SortMessage => ({
  seq: ++seqCounter,
  subject: '',
  fromAddr: '',
  toAddrs: [],
  ccAddrs: [],
  date: new Date('2026-01-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  rawSize: 100,
  messageId: null,
  inReplyTo: null,
  ...over,
});
const day = (d: number): Date => new Date(Date.UTC(2026, 0, d));

describe('base subject (RFC 5256 §2.1)', () => {
  const cases: Array<[string, string, boolean]> = [
    ['Hello', 'Hello', false],
    ['Re: Hello', 'Hello', true],
    ['RE: re: Fwd: Hello', 'Hello', true],
    ['Fw: Hello', 'Hello', true],
    ['Re[2]: Hello', 'Hello', true],
    ['[list] Re: Hello', 'Hello', true],
    ['[list] Hello', 'Hello', false],
    ['[only a blob]', '[only a blob]', false],
    ['Hello (fwd)', 'Hello', true],
    ['Hello (fwd) (FWD)  ', 'Hello', true],
    ['[Fwd: Re: Hello]', 'Hello', true],
    ['  Hello \t  World  ', 'Hello World', false],
    ['Re:', '', true],
    ['Reply to this', 'Reply to this', false],
  ];
  for (const [input, base, reply] of cases) {
    test(JSON.stringify(input), () => {
      assert.deepEqual(baseSubject(input), { base, isReplyOrForward: reply });
    });
  }
});

describe('SORT order (RFC 5256 §3)', () => {
  const a = msg({ uid: 10, subject: 'Re: banana', fromAddr: 'zed@x.test', toAddrs: ['b@x.test'], date: day(3), createdAt: day(1), rawSize: 300 });
  const b = msg({ uid: 11, subject: 'apple', fromAddr: 'Amy@x.test', toAddrs: ['a@x.test'], date: day(1), createdAt: day(3), rawSize: 100 });
  const c = msg({ uid: 12, subject: 'Cherry', fromAddr: 'mike@x.test', ccAddrs: ['c@x.test'], date: day(2), createdAt: day(2), rawSize: 200 });
  const order = (keys: string): number[] => sortMessages([a, b, c], parseSortCriteria(tokenize([keys])[0])).map((m) => m.uid);

  test('SUBJECT compares base subjects case-insensitively', () => assert.deepEqual(order('(SUBJECT)'), [11, 10, 12]));
  test('DATE uses the sent date, ARRIVAL the internal date', () => {
    assert.deepEqual(order('(DATE)'), [11, 12, 10]);
    assert.deepEqual(order('(ARRIVAL)'), [10, 12, 11]);
  });
  test('REVERSE applies to the following key only', () => assert.deepEqual(order('(REVERSE SIZE)'), [10, 12, 11]));
  test('FROM compares the mailbox part (i;ascii-casemap)', () => assert.deepEqual(order('(FROM)'), [11, 12, 10]));
  test('a missing address sorts first (TO, CC)', () => {
    assert.deepEqual(order('(TO)'), [12, 11, 10]);
    assert.deepEqual(order('(CC)'), [10, 11, 12]);
  });
  test('ties fall back to the sequence number', () => {
    const x = msg({ uid: 1, subject: 'same' });
    const y = msg({ uid: 2, subject: 'Re: same' });
    assert.deepEqual(sortMessages([y, x], [{ key: 'SUBJECT', reverse: false }]).map((m) => m.uid), [1, 2]);
  });
  test('unknown keys and a dangling REVERSE are rejected', () => {
    assert.throws(() => parseSortCriteria(tokenize(['(DISPLAYFROM)'])[0]));
    assert.throws(() => parseSortCriteria(tokenize(['(DATE REVERSE)'])[0]));
    assert.throws(() => parseSortCriteria(tokenize(['()'])[0]));
  });
});

describe('THREAD=ORDEREDSUBJECT', () => {
  test('groups by base subject, earliest message is the parent of the others', () => {
    const list = [
      msg({ uid: 1, subject: 'Topic', date: day(1) }),
      msg({ uid: 2, subject: 'Other', date: day(2) }),
      msg({ uid: 3, subject: 'Re: Topic', date: day(3) }),
      msg({ uid: 4, subject: 'RE: topic', date: day(4) }),
      msg({ uid: 5, subject: 'Re: Other', date: day(5) }),
    ];
    assert.equal(formatThreads(threadOrderedSubject(list, (m) => m.uid)), '(1 (3)(4))(2 5)');
  });
});

describe('THREAD=REFERENCES', () => {
  test('follows In-Reply-To chains and sorts by date', () => {
    const list = [
      msg({ uid: 1, subject: 'Plan', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'Re: Plan', messageId: '<b@x>', inReplyTo: '<a@x>', date: day(2) }),
      msg({ uid: 3, subject: 'Unrelated', messageId: '<c@x>', date: day(3) }),
      msg({ uid: 4, subject: 'Re: Plan', messageId: '<d@x>', inReplyTo: '<b@x>', date: day(4) }),
      msg({ uid: 5, subject: 'Re: Plan', messageId: '<e@x>', inReplyTo: '<a@x>', date: day(5) }),
    ];
    assert.equal(formatThreads(threadReferences(list, (m) => m.uid)), '(1 (2 4)(5))(3)');
  });

  test('a reply whose parent is missing is grouped by subject under the original', () => {
    const list = [
      msg({ uid: 1, subject: 'Lunch', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'Re: Lunch', messageId: '<b@x>', inReplyTo: '<gone@x>', date: day(2) }),
    ];
    assert.equal(formatThreads(threadReferences(list, (m) => m.uid)), '(1 2)');
  });

  test('two originals with the same subject become siblings under a dummy', () => {
    const list = [
      msg({ uid: 1, subject: 'Report', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'Report', messageId: '<b@x>', date: day(2) }),
    ];
    assert.equal(formatThreads(threadReferences(list, (m) => m.uid)), '((1)(2))');
  });

  test('duplicate and missing Message-IDs and self references do not loop', () => {
    const list = [
      msg({ uid: 1, subject: 'A', messageId: '<a@x>', inReplyTo: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'B', messageId: '<a@x>', date: day(2) }),
      msg({ uid: 3, subject: 'C', messageId: null, date: day(3) }),
    ];
    assert.equal(formatThreads(threadReferences(list, (m) => m.uid)), '(1)(2)(3)');
  });

  test('msg-id extraction', () => {
    assert.deepEqual(msgIds('<a@x> <b@x>'), ['<a@x>', '<b@x>']);
    assert.deepEqual(msgIds('bare@x'), ['<bare@x>']);
    assert.deepEqual(msgIds(null), []);
  });
});

describe('UID ranges (QRESYNC)', () => {
  test('parse, clamp and subtract stay on ranges', () => {
    const ranges = parseUidRanges('1:*,20', 4_000_000_000);
    assert.deepEqual(ranges, [[1, 4_000_000_000]]);
    assert.deepEqual(subtractUids(clampRanges(ranges!, 1, 13), [5, 12, 13]), [[1, 4], [6, 11]]);
    assert.equal(parseUidRanges('0', 10), null);
    assert.equal(parseUidRanges('1:99999999999', 10), null);
  });
  test('formatting and chunking', () => {
    assert.equal(formatRanges(rangesOf([1, 2, 3, 7, 9, 10])), '1:3,7,9:10');
    const many = rangesOf(Array.from({ length: 3000 }, (_, i) => i * 2 + 1));
    const chunks = chunkRanges(many, 100);
    assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 100));
    assert.equal(chunks.join(','), formatRanges(many));
  });
});
