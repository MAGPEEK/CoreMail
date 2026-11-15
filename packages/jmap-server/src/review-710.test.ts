/**
 * Regression tests for the 7.1.0 JMAP protocol review (sender policy, FUTURERELEASE,
 * Email/Thread changes, header forms, keywords, WebSocket origin, session).
 * Infra-free: Prisma is replaced through the globalThis.__prisma seam before any
 * module that imports @coremail/storage is loaded.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
const messages: Row[] = [];
let transactions = 0;
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  $transaction: async () => { transactions++; },
  message: {
    findFirst: async (a: { where: Row }) => messages.find((m) => m['id'] === a.where['id']
      && (!('deletedAt' in a.where) || m['deletedAt'] === a.where['deletedAt'])) ?? null,
  },
};

const { checkSubmissionSenders } = await import('./mail/sender-check.js');
const { parseParams, releaseTime } = await import('./methods/submission.js');
const { computeChanges, parseMaxChanges, existedAt } = await import('./methods/email-changes.js');
const { classifyThreads } = await import('./methods/thread.js');
const { runEmailSet } = await import('./methods/email.js');
const { decodeEmailState, encodeEmailState } = await import('./state-codec.js');
const { isValidHeaderProperty, splitGroupedAddresses, invalidEmailProperties } = await import('./mail/email-mapper.js');
const { keywordsToFlags, flagVariants, hasKeywordFlag } = await import('./mail/keywords.js');
const { isWsOriginAllowed } = await import('./cors.js');
const { buildSession } = await import('./session.js');
const { CAP_PRINCIPALS, CAP_SUBMISSION } = await import('./capabilities.js');
const { MethodError } = await import('./errors.js');
type AccountContext = import('./types.js').AccountContext;
type EmailStateParts = import('./state-codec.js').EmailStateParts;

const raw = (headers: string): Buffer => Buffer.from(`${headers}\r\nSubject: x\r\n\r\nbody\r\n`, 'latin1');
const allowed = ['me@corp.de', 'alias@corp.de', 'team@corp.de'];
const onBehalf = ['boss-team@corp.de'];

describe('EmailSubmission sender policy (RFC 8621 §7.5)', () => {
  const verdict = (h: string, identity = 'me@corp.de') => checkSubmissionSenders(raw(h), identity, allowed, onBehalf);
  const cases: Array<[string, string, string | true, string?]> = [
    ['own address', 'From: Me <me@corp.de>', true],
    ['alias identity', 'From: alias@corp.de', true, 'alias@corp.de'],
    ['second From address not allowed', 'From: me@corp.de, ceo@corp.de', 'forbiddenFrom'],
    ['foreign From', 'From: ceo@corp.de', 'forbiddenFrom'],
    ['two From fields', 'From: me@corp.de\r\nFrom: ceo@corp.de', 'invalidEmail'],
    ['no From field', 'To: x@y.de', 'invalidEmail'],
    ['From without address', 'From: undisclosed-recipients:;', 'invalidEmail'],
    ['From with a bare word', 'From: undisclosed', 'invalidEmail'],
    ['Sender not allowed', 'From: me@corp.de\r\nSender: ceo@corp.de', 'forbiddenFrom'],
    ['two Sender fields', 'From: me@corp.de\r\nSender: me@corp.de\r\nSender: me@corp.de', 'invalidEmail'],
    ['on behalf with own Sender', 'From: boss-team@corp.de\r\nSender: me@corp.de', true],
    ['on behalf without Sender', 'From: boss-team@corp.de', 'forbiddenFrom'],
    ['identity not in From/Sender', 'From: team@corp.de', 'forbiddenFrom', 'me@corp.de'],
  ];
  for (const [name, h, want, identity] of cases) {
    test(name, () => {
      const v = verdict(h, identity);
      if (want === true) assert.deepEqual(v, { ok: true });
      else assert.equal(v.ok ? 'ok' : v.type, want, JSON.stringify(v));
    });
  }
});

describe('FUTURERELEASE (RFC 4865 / RFC 8621 §7)', () => {
  const now = new Date('2026-11-15T10:00:00Z');
  const setErr = (type: string) => (e: unknown) => (e as { type?: string }).type === type;
  test('HOLDFOR delays the release', () => {
    assert.equal(releaseTime(parseParams({ holdfor: '3600' }, new Set(['HOLDFOR', 'HOLDUNTIL'])), now).toISOString(), '2026-11-15T11:00:00.000Z');
  });
  test('HOLDUNTIL in the past releases immediately', () => {
    assert.equal(releaseTime({ HOLDUNTIL: '2026-01-01T00:00:00Z' }, now).getTime(), now.getTime());
  });
  test('beyond maxDelayedSend → invalidProperties', () => {
    assert.throws(() => releaseTime({ HOLDFOR: String(31 * 24 * 3600) }, now), setErr('invalidProperties'));
  });
  test('both parameters / garbage → invalidProperties', () => {
    assert.throws(() => releaseTime({ HOLDFOR: '1', HOLDUNTIL: '2026-12-01T00:00:00Z' }, now), setErr('invalidProperties'));
    assert.throws(() => releaseTime({ HOLDFOR: 'soon' }, now), setErr('invalidProperties'));
  });
  test('unsupported envelope parameter is rejected, not dropped', () => {
    assert.throws(() => parseParams({ NOTIFY: 'SUCCESS' }, new Set(['HOLDFOR'])), setErr('invalidProperties'));
    assert.equal(parseParams(null, new Set()), null);
  });
});

describe('Email/changes (RFC 8620 §5.2)', () => {
  const st = (p: Partial<EmailStateParts>): EmailStateParts => ({
    maxModSeq: 10n, highestModSeq: 10n, maxCreatedMs: Date.parse('2026-11-01T00:00:00Z'), count: 5, createdBase: 10n, ...p,
  });
  const row = (id: string, modSeq: bigint, extra: Partial<Row> = {}) => ({
    id, modSeq, createdAt: new Date('2026-10-01T00:00:00Z'), createdModSeq: 1n, deletedAt: null, ...extra,
  }) as never;

  test('backdated import is "created" (createdModSeq), expunge is "destroyed"', () => {
    const old = st({});
    const now = st({ maxModSeq: 12n, highestModSeq: 12n, count: 5 });
    const r = computeChanges([
      row('imp', 11n, { createdModSeq: 11n, createdAt: new Date('2020-01-01T00:00:00Z') }),
      row('gone', 12n, { deletedAt: new Date() }),
    ], old, now, 100);
    assert.deepEqual([r.created, r.updated, r.destroyed, r.hasMoreChanges], [['imp'], [], ['gone'], false]);
  });

  test('created and destroyed inside the window is left out', () => {
    const r = computeChanges([row('tmp', 11n, { createdModSeq: 11n, deletedAt: new Date() })], st({}), st({ highestModSeq: 11n }), 100);
    assert.deepEqual([r.created, r.destroyed], [[], []]);
  });

  test('hard delete (no tombstone) → cannotCalculateChanges', () => {
    assert.throws(() => computeChanges([], st({}), st({ highestModSeq: 11n, count: 4 }), 100),
      (e: unknown) => e instanceof MethodError && e.type === 'cannotCalculateChanges');
  });

  test('maxChanges pages on modSeq boundaries with an intermediate state', () => {
    const old = st({});
    const now = st({ maxModSeq: 14n, highestModSeq: 14n, count: 8 });
    const rows = [11n, 12n, 13n].map((m, i) => row(`n${i}`, m, { createdModSeq: m })).concat([row('u', 14n)]);
    const p1 = computeChanges(rows, old, now, 2);
    assert.deepEqual([p1.created, p1.hasMoreChanges], [['n0', 'n1'], true]);
    // state string round trip keeps the creation base of the original state
    const mid = decodeEmailState(encodeEmailState(p1.newState))!;
    assert.equal(mid.createdBase, 10n);
    const p2 = computeChanges(rows, mid, now, 2);
    assert.deepEqual([p2.created, p2.updated, p2.hasMoreChanges], [['n2'], ['u'], false]);
    assert.equal(encodeEmailState(p2.newState), encodeEmailState(now));
  });

  test('a single change set larger than maxChanges → cannotCalculateChanges', () => {
    const rows = ['a', 'b', 'c'].map((id) => row(id, 11n));
    assert.throws(() => computeChanges(rows, st({}), st({ highestModSeq: 11n }), 2),
      (e: unknown) => e instanceof MethodError && e.type === 'cannotCalculateChanges');
  });

  test('maxChanges must be a positive integer', () => {
    for (const v of [0, -1, 1.5, '3']) assert.throws(() => parseMaxChanges(v), (e: unknown) => e instanceof MethodError && e.type === 'invalidArguments');
    assert.equal(parseMaxChanges(7), 7);
  });

  test('rows without createdModSeq (pre-7.1) fall back to createdAt', () => {
    const old = st({});
    assert.equal(existedAt(row('x', 11n, { createdModSeq: null, createdAt: new Date('2026-12-01T00:00:00Z') }), old), false);
    assert.equal(existedAt(row('y', 11n, { createdModSeq: null }), old), true);
  });
});

test('Thread/changes: new thread → created, thread losing its last member → destroyed', () => {
  const old: EmailStateParts = { maxModSeq: 10n, highestModSeq: 10n, maxCreatedMs: 0, count: 2, createdBase: 10n };
  const m = (id: string, threadId: string, extra: Row = {}) => ({
    id, threadId, modSeq: 11n, createdAt: new Date(0), createdModSeq: 1n, deletedAt: null, ...extra,
  }) as never;
  const r = classifyThreads(['A', 'N', 'D'], [
    m('A', 'A', { modSeq: 5n }), m('B', 'A', { createdModSeq: 11n }),
    m('N', 'N', { createdModSeq: 11n }),
    m('D', 'D', { deletedAt: new Date() }),
  ], old);
  assert.deepEqual(r, { created: ['N'], updated: ['A'], destroyed: ['D'] });
});

test('Email/set destroy of an already expunged message → notFound, nothing written', async () => {
  messages.splice(0, messages.length, { id: 'x', folderId: 'f', flags: [], deletedAt: new Date() });
  const acc = { accountId: 'u1', mailboxId: 'm1' } as AccountContext;
  const r = await runEmailSet(acc, { resolveId: (i: string) => i, createdIds: new Map() }, {}, {}, ['x']);
  assert.equal((r.notDestroyed['x'] as Row)['type'], 'notFound');
  assert.equal(transactions, 0);
});

describe('header:* forms (RFC 8621 §4.1.2)', () => {
  test('form allow-list', () => {
    for (const ok of ['header:Subject:asText', 'header:From:asAddresses:all', 'header:X-Foo:asURLs', 'header:Date:asDate', 'header:List-Post:asURLs']) {
      assert.ok(isValidHeaderProperty(ok), ok);
    }
    for (const bad of ['header:Subject:asDate', 'header:From:asText', 'header:X:asFoo', 'header:Received:asText', 'header:a b']) {
      assert.ok(!isValidHeaderProperty(bad), bad);
    }
    assert.deepEqual(invalidEmailProperties(['subject', 'header:To:asMessageIds']), ['header:To:asMessageIds']);
  });
  test('asGroupedAddresses keeps groups', () => {
    assert.deepEqual(splitGroupedAddresses('Team: a@x.de, "B" <b@x.de>;, c@y.de').map((g) => [g.name, g.addresses.map((a) => a.email)]),
      [['Team', ['a@x.de', 'b@x.de']], [null, ['c@y.de']]]);
  });
});

test('keywords: case-insensitive, unchanged custom flags keep their IMAP spelling', () => {
  assert.deepEqual(keywordsToFlags({ 'projekt-x': true, Neu: true }, ['Projekt-X']).sort(), ['Projekt-X', 'neu']);
  assert.ok(flagVariants('$mdnsent').includes('$MDNSent'));
  assert.deepEqual(flagVariants('$SEEN'), ['\\Seen']);
  assert.ok(hasKeywordFlag(['Projekt-X'], 'projekt-x'));
});

test('WebSocket upgrade: foreign Origin needs an explicit token', () => {
  const allowedOrigins = ['https://mail.corp.de'];
  assert.equal(isWsOriginAllowed(undefined, allowedOrigins, false), true);          // non-browser client
  assert.equal(isWsOriginAllowed('https://mail.corp.de', allowedOrigins, false), true);
  assert.equal(isWsOriginAllowed('https://evil.example', allowedOrigins, false), false);
  assert.equal(isWsOriginAllowed('https://evil.example', allowedOrigins, true), true);
});

test('Session: principals account capability + FUTURERELEASE advertised', () => {
  const own = { accountId: 'u1', mailboxId: 'm', ownerUserId: 'u1', sharedMailboxId: null, name: 'A', email: 'a@b.de', readOnly: false, isPersonal: true, maySend: true };
  const s = buildSession({ userId: 'u1', email: 'a@b.de', displayName: 'A', domainId: 'd', role: 'USER' } as never, new Map([['u1', own]]), 'https://mail.b.de');
  const caps = ((s['accounts'] as Row)['u1'] as Row)['accountCapabilities'] as Row;
  assert.deepEqual(caps[CAP_PRINCIPALS], { currentUserPrincipalId: 'u1' });
  assert.equal((s['primaryAccounts'] as Row)[CAP_PRINCIPALS], 'u1');
  const ext = (caps[CAP_SUBMISSION] as Row)['submissionExtensions'] as Record<string, string[]>;
  assert.equal(ext['FUTURERELEASE']![0], String(30 * 24 * 3600));
});
