/**
 * SORT / THREAD (RFC 5256) — base subject, sort order, thread algorithms — and
 * the UID range helpers behind QRESYNC VANISHED responses.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseSubject, sortMessages, parseSortCriteria, threadOrderedSubject, threadReferences, formatThreads, msgIds,
  referencesOf, type SortMessage, type ThreadNode,
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

describe('THREAD=REFERENCES with stored References (RFC 5256 §3, v9.1)', () => {
  const T = (list: SortMessage[]): string => formatThreads(threadReferences(list, (m) => m.uid));

  test('RFC 5256 §4 response syntax', () => {
    const n = (id: number | null, ...children: ThreadNode[]): ThreadNode => ({ id, children });
    assert.equal(formatThreads([n(2), n(3, n(6, n(4, n(23)), n(44, n(7, n(96)))))]), '(2)(3 6 (4 23)(44 7 96))');
    assert.equal(formatThreads([n(null, n(1), n(2))]), '((1)(2))');
  });

  test('References chain wins over In-Reply-To and links the whole ancestry', () => {
    const list = [
      msg({ uid: 1, subject: 'Plan', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'Re: Plan', messageId: '<b@x>', references: ['<a@x>'], date: day(2) }),
      // In-Reply-To points at a message we do not have, References at the full chain.
      msg({ uid: 3, subject: 'Re: Plan', messageId: '<c@x>', inReplyTo: '<elsewhere@x>', references: ['<a@x>', '<b@x>'], date: day(3) }),
    ];
    assert.equal(T(list), '(1 2 3)');
  });

  test('In-Reply-To is the fallback when References is empty', () => {
    const list = [
      msg({ uid: 1, subject: 'A', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'B', messageId: '<b@x>', inReplyTo: '<a@x> <zzz@x>', references: [], date: day(2) }),
    ];
    assert.equal(T(list), '(1 2)');
    assert.deepEqual(referencesOf(list[1]!), ['<a@x>']);
  });

  test('a missing parent in the middle becomes a dummy that is pruned (one child)', () => {
    const list = [
      msg({ uid: 1, subject: 'A', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'C', messageId: '<c@x>', references: ['<a@x>', '<gone@x>'], date: day(2) }),
    ];
    assert.equal(T(list), '(1 2)');
  });

  test('a missing parent with two children: its children are promoted below the real parent', () => {
    const list = [
      msg({ uid: 1, subject: 'A', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'C', messageId: '<c@x>', references: ['<a@x>', '<gone@x>'], date: day(2) }),
      msg({ uid: 3, subject: 'D', messageId: '<d@x>', references: ['<a@x>', '<gone@x>'], date: day(3) }),
    ];
    assert.equal(T(list), '(1 (2)(3))');
  });

  test('a missing root with two children stays a dummy root; with one child it is promoted', () => {
    assert.equal(T([
      msg({ uid: 1, subject: 'x1', messageId: '<b@x>', references: ['<root@x>'], date: day(2) }),
      msg({ uid: 2, subject: 'x2', messageId: '<c@x>', references: ['<root@x>'], date: day(1) }),
    ]), '((2)(1))');
    assert.equal(T([msg({ uid: 1, subject: 'x', messageId: '<b@x>', references: ['<root@x>'] })]), '(1)');
  });

  test('reference cycles between messages do not loop and keep every message', () => {
    const list = [
      msg({ uid: 1, subject: 'A', messageId: '<a@x>', references: ['<b@x>'], date: day(1) }),
      msg({ uid: 2, subject: 'B', messageId: '<b@x>', references: ['<a@x>'], date: day(2) }),
      msg({ uid: 3, subject: 'C', messageId: '<c@x>', references: ['<c@x>', '<a@x>', '<c@x>'], date: day(3) }),
    ];
    const out = T(list);
    assert.equal(out, '(2 1 3)');
  });

  test('contradicting References orders keep the first links', () => {
    const list = [
      msg({ uid: 1, subject: 'A', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'B', messageId: '<b@x>', references: ['<a@x>'], date: day(2) }),
      msg({ uid: 3, subject: 'C', messageId: '<c@x>', references: ['<a@x>', '<b@x>'], date: day(3) }),
      msg({ uid: 4, subject: 'D', messageId: '<d@x>', references: ['<b@x>', '<a@x>'], date: day(4) }),
    ];
    // D: the a→b link exists already and b→a would be a loop; D's parent is its last reference (a).
    assert.equal(T(list), '(1 (2 3)(4))');
  });

  test('duplicate Message-IDs: replies attach to the first message, the duplicate is its own root', () => {
    const list = [
      msg({ uid: 1, subject: 'A', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'Other', messageId: '<a@x>', date: day(2) }),
      msg({ uid: 3, subject: 'Re: A', messageId: '<r@x>', references: ['<a@x>'], date: day(3) }),
    ];
    assert.equal(T(list), '(1 3)(2)');
  });

  test('a dummy root and a real root with the same base subject are merged under the dummy', () => {
    const list = [
      msg({ uid: 1, subject: 'Re: Topic', messageId: '<b@x>', references: ['<gone@x>'], date: day(2) }),
      msg({ uid: 2, subject: 'Re: Topic', messageId: '<c@x>', references: ['<gone@x>'], date: day(3) }),
      msg({ uid: 3, subject: 'Topic', messageId: '<d@x>', date: day(1) }),
    ];
    assert.equal(T(list), '((3)(1)(2))');
  });

  test('a reply is put under the original with the same subject; two originals become siblings', () => {
    assert.equal(T([
      msg({ uid: 1, subject: 'Re: News', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'News', messageId: '<b@x>', date: day(2) }),
    ]), '(2 1)');
    assert.equal(T([
      msg({ uid: 1, subject: 'Re: News', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 2, subject: 'Re: News', messageId: '<b@x>', date: day(2) }),
      msg({ uid: 3, subject: 'Re: News', messageId: '<c@x>', date: day(3) }),
    ]), '((1)(2)(3))');
  });

  test('siblings and threads are ordered by sent date, ties by sequence number', () => {
    seqCounter = 0;
    const list = [
      msg({ uid: 10, subject: 'Z', messageId: '<z@x>', date: day(5) }),
      msg({ uid: 11, subject: 'Root', messageId: '<a@x>', date: day(1) }),
      msg({ uid: 12, subject: 'r1', messageId: '<b@x>', references: ['<a@x>'], date: day(3) }),
      msg({ uid: 13, subject: 'r2', messageId: '<c@x>', references: ['<a@x>'], date: day(2) }),
      msg({ uid: 14, subject: 'r3', messageId: '<d@x>', references: ['<a@x>'], date: day(2) }),
    ];
    assert.equal(T(list), '(11 (13)(14)(12))(10)');
  });

  test('a 20 000 message reply chain neither overflows the stack nor goes quadratic', () => {
    const n = 20_000;
    const list: SortMessage[] = [];
    for (let i = 1; i <= n; i++) {
      const refs: string[] = [];
      if (i > 1) { refs.push('<m1@x>'); for (let k = Math.max(2, i - 99); k < i; k++) refs.push(`<m${k}@x>`); }
      list.push(msg({ uid: i, subject: i === 1 ? 'Chain' : 'Re: Chain', messageId: `<m${i}@x>`, references: refs, date: new Date(Date.UTC(2026, 0, 1) + i * 1000) }));
    }
    const started = Date.now();
    const out = T(list.reverse());
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    assert.equal(out, `(${Array.from({ length: n }, (_, i) => i + 1).join(' ')})`);
  });

  test('100 000 unrelated roots are threaded in reasonable time', () => {
    const list = Array.from({ length: 100_000 }, (_, i) => msg({ uid: i + 1, subject: `s${i}`, messageId: `<u${i}@x>`, date: new Date(Date.UTC(2026, 0, 1) + i) }));
    const started = Date.now();
    const roots = threadReferences(list, (m) => m.uid);
    assert.equal(roots.length, 100_000);
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
  });

  test('msg-id extraction skips garbage', () => {
    assert.deepEqual(msgIds('<a b@x>'), []);
    assert.deepEqual(msgIds('<<a@x>>'), ['<a@x>']);
    assert.deepEqual(msgIds('garbage here'), []);
  });
});
