/**
 * Review tests (RFC 8620 / 8621 conformance) for the pure parts of the JMAP server:
 * request validation, result references, createdIds, PatchObject, /query paging,
 * keywords, Email/query filter + sort translation, Email mapper, blob ids.
 *
 * Tests named "BUG:" are expected to FAIL against the current code — they document
 * a real deviation (RFC section in the name). Everything else is a regression guard.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, processRequest, registerMethod } from './dispatcher.js';
import { MethodError, RequestError } from './errors.js';
import { CAP_CORE, CAP_MAIL } from './capabilities.js';
import { LIMITS } from './limits.js';
import { applyPatch, paginate } from './methods/common.js';
import { flagsToKeywords, isValidKeyword, keywordsToFlags } from './mail/keywords.js';
import { filterToWhere, parseSort } from './methods/email-query.js';
import { buildStructure, invalidEmailProperties, toJmapEmail, type MappableMessage, type MapOptions } from './mail/email-mapper.js';
import { buildRfc822 } from './mail/raw.js';
import { resolveBlob } from './blobs.js';
import type { AccountContext, JmapUser, JsonObject } from './types.js';

const user: JmapUser = { userId: 'u1', email: 'a@b.de', displayName: 'A', domainId: 'd', role: 'USER' };
const acc: AccountContext = {
  accountId: 'u1', mailboxId: 'm1', ownerUserId: 'u1', sharedMailboxId: null, name: 'A', email: 'a@b.de',
  readOnly: false, isPersonal: true, maySend: true,
};
const accounts = new Map([['u1', acc]]);

registerMethod('Review/echo', CAP_CORE, async (args) => args);
registerMethod('Review/list', CAP_CORE, async () => ({ list: [{ id: 'x', n: { a: 1 } }, { id: 'y', n: { a: 2 } }], nested: [[1, 2], [3]] }));
registerMethod('Review/create', CAP_CORE, async (_a, ctx) => { ctx.createdIds.set('k1', 'real-1'); return { created: { k1: { id: 'real-1' } } }; });
registerMethod('Review/useId', CAP_CORE, async (args, ctx) => ({ id: ctx.resolveId(String(args['id'])) }));
registerMethod('Review/mailOnly', CAP_MAIL, async () => ({ ok: true }));

const run = (methodCalls: unknown[], extra: JsonObject = {}) =>
  processRequest(parseRequest({ using: [CAP_CORE], methodCalls, ...extra }), user, accounts, 's0');

const isReqErr = (type: string) => (e: unknown) => e instanceof RequestError && e.type === type;
const isMethodErr = (type: string) => (e: unknown) => e instanceof MethodError && e.type === type;

// ── RFC 8620 §3.3 / §3.6.1 request validation ───────────────────────────────

describe('RFC 8620 §3.6.1 request-level errors', () => {
  const cases: Array<[string, unknown, string]> = [
    ['array body', [], 'notRequest'],
    ['null body', null, 'notRequest'],
    ['using not array', { using: 'x', methodCalls: [] }, 'notRequest'],
    ['using with non-string', { using: [1], methodCalls: [] }, 'notRequest'],
    ['methodCalls not array', { using: [CAP_CORE], methodCalls: {} }, 'notRequest'],
    ['invocation too short', { using: [CAP_CORE], methodCalls: [['A/b', {}]] }, 'notRequest'],
    ['invocation args array', { using: [CAP_CORE], methodCalls: [['A/b', [], 'c']] }, 'notRequest'],
    ['invocation id not string', { using: [CAP_CORE], methodCalls: [['A/b', {}, 1]] }, 'notRequest'],
    ['createdIds array', { using: [CAP_CORE], methodCalls: [], createdIds: [] }, 'notRequest'],
    ['unknown capability', { using: [CAP_CORE, 'urn:example:nope'], methodCalls: [] }, 'unknownCapability'],
    ['too many calls', { using: [CAP_CORE], methodCalls: Array.from({ length: LIMITS.maxCallsInRequest + 1 }, (_, i) => ['Core/echo', {}, `c${i}`]) }, 'limit'],
  ];
  for (const [name, body, type] of cases) {
    test(`${name} → ${type}`, () => assert.throws(() => parseRequest(body), isReqErr(type)));
  }

  test('limit error names the limit and serializes as problem+json type URN', () => {
    try {
      parseRequest({ using: [CAP_CORE], methodCalls: Array.from({ length: 65 }, (_, i) => ['Core/echo', {}, `c${i}`]) });
      assert.fail('expected throw');
    } catch (e) {
      const j = (e as RequestError).toJson();
      assert.equal(j['type'], 'urn:ietf:params:jmap:error:limit');
      assert.equal(j['limit'], 'maxCallsInRequest');
      assert.equal(j['status'], 400);
    }
  });

  test('method whose capability is not in "using" → unknownMethod (RFC 8620 §3.6.2)', async () => {
    const r = await run([['Review/mailOnly', {}, 'c0']]);
    assert.deepEqual(r.methodResponses[0], ['error', { type: 'unknownMethod' }, 'c0']);
  });
});

// ── RFC 8620 §3.7 result references ────────────────────────────────────────

describe('RFC 8620 §3.7 result references', () => {
  const ref = (path: string, resultOf = 'c0', name = 'Review/list') => ({ resultOf, name, path });

  const ok: Array<[string, string, unknown]> = [
    ['whole result with empty path', '', { list: [{ id: 'x', n: { a: 1 } }, { id: 'y', n: { a: 2 } }], nested: [[1, 2], [3]] }],
    ['array index', '/list/1/id', 'y'],
    ['wildcard', '/list/*/id', ['x', 'y']],
    ['wildcard into object', '/list/*/n/a', [1, 2]],
    ['wildcard flattens nested arrays (§3.7)', '/nested/*', [1, 2, 3]],
  ];
  for (const [name, path, expected] of ok) {
    test(name, async () => {
      const r = await run([['Review/list', {}, 'c0'], ['Review/echo', { '#v': ref(path) }, 'c1']]);
      assert.deepEqual(r.methodResponses[1], ['Review/echo', { v: expected }, 'c1']);
    });
  }

  const bad: Array<[string, unknown]> = [
    ['unknown resultOf', ref('/list', 'nope')],
    ['name mismatch', ref('/list', 'c0', 'Other/get')],
    ['index out of range', ref('/list/5')],
    ['missing key', ref('/missing')],
    ['wildcard on object', ref('/list/0/*')],
    ['not an object', 'string-ref'],
    ['missing fields', { resultOf: 'c0' }],
  ];
  for (const [name, r0] of bad) {
    test(`${name} → invalidResultReference`, async () => {
      const r = await run([['Review/list', {}, 'c0'], ['Review/echo', { '#v': r0 }, 'c1']]);
      assert.equal(r.methodResponses[1]![0], 'error');
      assert.equal((r.methodResponses[1]![1] as JsonObject)['type'], 'invalidResultReference');
    });
  }

  test('reference to an error response → invalidResultReference', async () => {
    const r = await run([['Nope/get', {}, 'c0'], ['Review/echo', { '#v': ref('', 'c0', 'Nope/get') }, 'c1']]);
    assert.equal((r.methodResponses[1]![1] as JsonObject)['type'], 'invalidResultReference');
  });

  test('BUG: path through Object.prototype member resolves instead of invalidResultReference (§3.7 / RFC 6901)', async () => {
    // evalPointer() uses `t in value` → inherited members such as "constructor" are "found"
    const r = await run([['Review/list', {}, 'c0'], ['Review/echo', { '#v': ref('/list/0/constructor') }, 'c1']]);
    assert.equal(r.methodResponses[1]![0], 'error');
    assert.equal((r.methodResponses[1]![1] as JsonObject)['type'], 'invalidResultReference');
  });
});

// ── RFC 8620 §3.3/§3.4 createdIds ─────────────────────────────────────────

describe('RFC 8620 §3.3/§3.4 createdIds and #creationId', () => {
  test('creation id is resolvable in a later call of the same request', async () => {
    const r = await run([['Review/create', {}, 'c0'], ['Review/useId', { id: '#k1' }, 'c1']]);
    assert.deepEqual(r.methodResponses[1], ['Review/useId', { id: 'real-1' }, 'c1']);
  });

  test('unknown #creationId → method error (not a crash)', async () => {
    const r = await run([['Review/useId', { id: '#nope' }, 'c0']]);
    assert.equal(r.methodResponses[0]![0], 'error');
  });

  test('request createdIds are merged and returned', async () => {
    const r = await run([['Review/create', {}, 'c0']], { createdIds: { pre: 'real-pre' } });
    assert.deepEqual(r.createdIds, { pre: 'real-pre', k1: 'real-1' });
  });

  test('BUG: createdIds returned although the request had no createdIds argument (§3.4)', async () => {
    // RFC 8620 §3.4: "createdIds … This is only returned if the "createdIds" argument was given in the request."
    const r = await run([['Review/create', {}, 'c0']]);
    assert.equal(r.createdIds, undefined);
  });
});

// ── RFC 8620 §5.3 PatchObject ─────────────────────────────────────────────

describe('RFC 8620 §5.3 PatchObject (applyPatch)', () => {
  const base = { keywords: { $seen: true }, mailboxIds: { a: true }, name: 'x', arr: [1, 2] };
  const ok: Array<[string, JsonObject, JsonObject]> = [
    ['replace top-level', { name: 'y' }, { ...base, name: 'y' }],
    ['add nested key', { 'keywords/$flagged': true }, { ...base, keywords: { $seen: true, $flagged: true } }],
    ['remove nested key with null', { 'keywords/$seen': null }, { ...base, keywords: {} }],
    ['move between mailboxes', { 'mailboxIds/a': null, 'mailboxIds/b': true }, { ...base, mailboxIds: { b: true } }],
    ['~1 decodes to /', { 'keywords/a~1b': true }, { ...base, keywords: { $seen: true, 'a/b': true } }],
    ['~0 decodes to ~', { 'keywords/a~0b': true }, { ...base, keywords: { $seen: true, 'a~b': true } }],
    ['~01 decodes to ~1 (order of unescaping, RFC 6901 §4)', { 'keywords/a~01': true }, { ...base, keywords: { $seen: true, 'a~1': true } }],
  ];
  for (const [name, patch, expected] of ok) {
    test(name, () => assert.deepEqual(applyPatch(base, patch), expected));
  }
  test('base object is not mutated', () => {
    const b = structuredClone(base);
    applyPatch(b, { 'keywords/$x': true });
    assert.deepEqual(b, base);
  });

  const bad: Array<[string, JsonObject]> = [
    ['missing intermediate', { 'nope/x': true }],
    ['pointer into array', { 'arr/0': 5 }],
    ['intermediate is scalar', { 'name/x': true }],
  ];
  for (const [name, patch] of bad) {
    test(`${name} → invalidPatch`, () => assert.throws(() => applyPatch(base, patch), isMethodErr('invalidPatch')));
  }

  test('BUG: one pointer is a prefix of another → must be invalidPatch (§5.3)', () => {
    // "There MUST NOT be two patches in the PatchObject where the pointer of one is the prefix of the pointer of the other"
    assert.throws(() => applyPatch(base, { keywords: { $draft: true }, 'keywords/$seen': null }), isMethodErr('invalidPatch'));
  });

  test('BUG: "__proto__/…" pollutes Object.prototype instead of invalidPatch', () => {
    const probe = 'jmapReviewPolluted';
    try {
      let threw = false;
      try { applyPatch({}, { [`__proto__/${probe}`]: true }); } catch { threw = true; }
      const polluted = (({}) as JsonObject)[probe] === true;
      assert.equal(polluted, false, 'Object.prototype was polluted via PatchObject');
      assert.equal(threw, true, 'expected invalidPatch');
    } finally {
      delete (Object.prototype as JsonObject)[probe];
    }
  });
});

// ── RFC 8620 §5.5 /query paging ───────────────────────────────────────────

describe('RFC 8620 §5.5 paginate()', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const cases: Array<[string, JsonObject, { position: number; ids: string[] }]> = [
    ['default', {}, { position: 0, ids }],
    ['position + limit', { position: 2, limit: 3 }, { position: 2, ids: ['c', 'd', 'e'] }],
    ['negative position from end', { position: -3 }, { position: 7, ids: ['h', 'i', 'j'] }],
    ['negative position beyond start → 0', { position: -30, limit: 2 }, { position: 0, ids: ['a', 'b'] }],
    ['position beyond end → empty', { position: 50 }, { position: 10, ids: [] }],
    ['anchor', { anchor: 'd', limit: 2 }, { position: 3, ids: ['d', 'e'] }],
    ['anchor + positive offset', { anchor: 'd', anchorOffset: 2, limit: 2 }, { position: 5, ids: ['f', 'g'] }],
    ['anchor + negative offset inside list', { anchor: 'd', anchorOffset: -2, limit: 2 }, { position: 1, ids: ['b', 'c'] }],
    ['limit 0', { limit: 0 }, { position: 0, ids: [] }],
  ];
  for (const [name, args, exp] of cases) {
    test(name, () => {
      const p = paginate(ids, args);
      assert.equal(p.position, exp.position);
      assert.deepEqual(p.ids, exp.ids);
      assert.equal(p.total, ids.length);
    });
  }
  test('anchor not found → anchorNotFound', () => assert.throws(() => paginate(ids, { anchor: 'zz' }), isMethodErr('anchorNotFound')));
  test('negative limit → invalidArguments', () => assert.throws(() => paginate(ids, { limit: -1 }), isMethodErr('invalidArguments')));

  test('BUG: anchor + negative offset past start must clamp to 0 (§5.5), not wrap to the end', () => {
    // "If the index is now negative, it is clamped to 0." — code treats it like a negative position
    const p = paginate(ids, { anchor: 'b', anchorOffset: -5, limit: 2 });
    assert.equal(p.position, 0);
    assert.deepEqual(p.ids, ['a', 'b']);
  });

  test('BUG: server-imposed default limit must be reported in "limit" (§5.5)', () => {
    const many = Array.from({ length: 300 }, (_, i) => `id${i}`);
    const p = paginate(many, {});
    assert.equal(p.ids.length, 256);
    assert.equal(p.limit, 256, 'server truncated to 256 without telling the client');
  });
});

// ── RFC 8621 §4.1.1 keywords ──────────────────────────────────────────────

describe('RFC 8621 §4.1.1 keywords', () => {
  const valid = ['$seen', '$Forwarded', 'Projekt-X', 'a.b', '!#&\'+,-./:;<=>?@^_`|~', 'x'.repeat(255)];
  const invalid = ['', ' ', 'a b', 'a(b', 'a)b', 'a{b', 'a]b', 'a%b', 'a*b', 'a"b', 'a\\b', 'x'.repeat(256), 'a\tb'];
  for (const k of valid) test(`valid: ${JSON.stringify(k.slice(0, 20))}`, () => assert.ok(isValidKeyword(k)));
  for (const k of invalid) test(`invalid: ${JSON.stringify(k.slice(0, 20))}`, () => assert.ok(!isValidKeyword(k)));

  test('BUG: non-ASCII / control characters accepted (§4.1.1: only %x21-%x7E)', () => {
    for (const k of ['ümlaut', 'a\u0000b', 'a\u007fb', ' ']) assert.ok(!isValidKeyword(k), JSON.stringify(k));
  });

  const mapping: Array<[string[], Record<string, true>]> = [
    [['\\Seen'], { $seen: true }],
    [['\\Flagged', '\\Answered', '\\Draft'], { $flagged: true, $answered: true, $draft: true }],
    [['$Forwarded'], { $forwarded: true }],
    [['$Junk', '$NotJunk', '$Phishing'], { $junk: true, $notjunk: true, $phishing: true }],
    [['\\Recent', '\\Deleted', '\\Unknown'], {}],
    [['MyLabel'], { mylabel: true }],
  ];
  for (const [flags, kw] of mapping) {
    test(`flags ${flags.join(',')} → keywords`, () => assert.deepEqual(flagsToKeywords(flags), kw));
  }
  test('$seen ↔ \\Seen round trip (any case)', () => {
    assert.deepEqual(keywordsToFlags({ $SEEN: true }), ['\\Seen']);
    assert.deepEqual(flagsToKeywords(keywordsToFlags({ $seen: true, $flagged: true })), { $seen: true, $flagged: true });
  });

  test('BUG: keywords are case-insensitive — {Foo, foo} must map to a single flag', () => {
    assert.equal(keywordsToFlags({ Foo: true, foo: true }).length, 1);
  });

  test('BUG: patch "keywords/Foo": null does not remove keyword stored as IMAP flag "Foo" (case-insensitivity)', () => {
    // Email/set update path: applyPatch({keywords: flagsToKeywords(flags)}, patch) → keywordsToFlags
    const current = { keywords: flagsToKeywords(['Foo', '\\Seen']) };          // → { foo: true, $seen: true }
    const next = applyPatch(current, { 'keywords/Foo': null });               // client uses original case
    assert.ok(!keywordsToFlags(next['keywords'] as JsonObject).includes('foo'), 'custom keyword survived removal');
  });
});

// ── RFC 8621 §4.4 Email/query filter + sort ────────────────────────────────

describe('RFC 8621 §4.4.1 FilterCondition → Prisma WHERE', () => {
  test('operators AND/OR/NOT', () => {
    assert.deepEqual(filterToWhere({ operator: 'AND', conditions: [{ hasKeyword: '$seen' }, { minSize: 10 }] }),
      { AND: [{ flags: { has: '\\Seen' } }, { rawSize: { gte: 10 } }] });
    assert.deepEqual(filterToWhere({ operator: 'NOT', conditions: [{ inMailbox: 'f1' }] }), { NOT: [{ folderId: 'f1' }] });
    assert.throws(() => filterToWhere({ operator: 'XOR', conditions: [] }), isMethodErr('unsupportedFilter'));
  });
  test('before is exclusive, after inclusive on receivedAt (createdAt)', () => {
    assert.deepEqual(filterToWhere({ before: '2026-01-01T00:00:00Z' }), { createdAt: { lt: new Date('2026-01-01T00:00:00Z') } });
    assert.deepEqual(filterToWhere({ after: '2026-01-01T00:00:00Z' }), { createdAt: { gte: new Date('2026-01-01T00:00:00Z') } });
  });
  test('unknown / unsupported conditions → unsupportedFilter', () => {
    for (const f of [{ header: ['X-A'] }, { allInThreadHaveKeyword: '$seen' }, { bogus: 1 }]) {
      assert.throws(() => filterToWhere(f), isMethodErr('unsupportedFilter'));
    }
  });
  test('BUG: invalid date in before/after must be invalidArguments, not an Invalid Date passed to the DB', () => {
    assert.throws(() => filterToWhere({ before: 'not-a-date' }), isMethodErr('invalidArguments'));
  });
  test('BUG: "text" must also look at To/Cc/Bcc and HTML body (§4.4.1)', () => {
    const w = JSON.stringify(filterToWhere({ text: 'bob' }));
    for (const field of ['toAddrs', 'ccAddrs', 'bccAddrs', 'bodyHtml']) assert.ok(w.includes(field), `text filter ignores ${field}`);
  });
  test('BUG: "to" filter is an exact array-element match, RFC requires substring ("contains") semantics', () => {
    // { to: 'bob' } compiles to { toAddrs: { hasSome: ['bob'] } } → never matches "bob@example.com"
    const w = filterToWhere({ to: 'bob' }) as { toAddrs?: { hasSome?: string[] } };
    assert.equal(w.toAddrs?.hasSome, undefined, 'exact-match only');
  });
});

describe('RFC 8621 §4.4.2 sort', () => {
  test('default receivedAt desc', () => assert.deepEqual(parseSort(undefined), [{ field: 'createdAt', asc: false }]));
  test('mapping', () => assert.deepEqual(parseSort([{ property: 'sentAt' }, { property: 'size', isAscending: false }]),
    [{ field: 'date', asc: true }, { field: 'rawSize', asc: false }]));
  test('to / unknown → unsupportedSort', () => {
    assert.throws(() => parseSort([{ property: 'to' }]), isMethodErr('unsupportedSort'));
    assert.throws(() => parseSort([{ property: 'nope' }]), isMethodErr('unsupportedSort'));
  });
  test('hasKeyword needs keyword', () => assert.throws(() => parseSort([{ property: 'hasKeyword' }]), isMethodErr('invalidArguments')));
  test('BUG: allInThreadHaveKeyword is not advertised in emailQuerySortOptions but silently treated as per-message hasKeyword', () => {
    assert.throws(() => parseSort([{ property: 'allInThreadHaveKeyword', keyword: '$flagged' }]), isMethodErr('unsupportedSort'));
  });
});

// ── RFC 8621 §4.1.4 body structure / §4.2 Email/get ───────────────────────

function msg(over: Partial<MappableMessage> = {}): MappableMessage {
  return {
    id: 'msg1', folderId: 'f1', flags: ['\\Seen'], createdAt: new Date('2026-03-01T10:00:00.000Z'), rawSize: 1234, threadId: 't1',
    subject: 'Hi', fromAddr: 'a@b.de', fromName: 'A', toAddrs: ['c@d.de'], ccAddrs: [], bccAddrs: [], replyTo: null,
    messageId: '<m1@b.de>', inReplyTo: null, date: new Date('2026-03-01T09:00:00.000Z'),
    bodyText: 'hello', bodyHtml: '', storagePath: null, attachments: [], ...over,
  };
}
const opts = (o: Partial<MapOptions> = {}): MapOptions => ({
  properties: null, bodyProperties: null, fetchTextBodyValues: false, fetchHTMLBodyValues: false,
  fetchAllBodyValues: false, maxBodyValueBytes: 0, ...o,
});

describe('RFC 8621 §4.1.4 textBody/htmlBody/attachments derivation', () => {
  const cases: Array<[string, Partial<MappableMessage>, string[], string[], string]> = [
    ['text only', { bodyText: 't', bodyHtml: '' }, ['text/plain'], ['text/plain'], 'text/plain'],
    ['html only', { bodyText: '', bodyHtml: '<p>h</p>' }, ['text/html'], ['text/html'], 'text/html'],
    ['both', { bodyText: 't', bodyHtml: '<p>h</p>' }, ['text/plain'], ['text/html'], 'multipart/alternative'],
    ['empty', { bodyText: '', bodyHtml: '' }, ['text/plain'], ['text/plain'], 'text/plain'],
  ];
  for (const [name, over, tb, hb, root] of cases) {
    test(name, () => {
      const s = buildStructure(msg(over));
      assert.deepEqual(s.textBody.map((p) => p.type), tb);
      assert.deepEqual(s.htmlBody.map((p) => p.type), hb);
      assert.equal(s.root.type, root);
    });
  }
  test('attachments → multipart/mixed; inline cid image is not hasAttachment', () => {
    const s = buildStructure(msg({ attachments: [{ id: 'a1', filename: 'i.png', mimeType: 'image/png', storagePath: 'x', contentId: '<c1>', inline: true, size: 3 }] }));
    assert.equal(s.root.type, 'multipart/mixed');
    assert.equal(s.attachments[0]!.blobId, 'a-a1');
    assert.equal(s.attachments[0]!.cid, 'c1');
    assert.equal(s.hasAttachment, false);
  });
});

describe('RFC 8621 §4.2 Email/get value formatting', () => {
  test('bodyValues truncation at maxBodyValueBytes keeps whole code points and flags isTruncated', async () => {
    const e = await toJmapEmail(msg({ bodyText: 'äöü' }), 't1', opts({ properties: ['id', 'bodyValues'], fetchTextBodyValues: true, maxBodyValueBytes: 3 }));
    assert.deepEqual(e['bodyValues'], { 1: { value: 'ä', isEncodingProblem: false, isTruncated: true } });
  });
  test('fetchHTMLBodyValues on a text-only message returns the text part (htmlBody falls back)', async () => {
    const e = await toJmapEmail(msg(), 't1', opts({ properties: ['id', 'bodyValues'], fetchHTMLBodyValues: true }));
    assert.deepEqual(Object.keys(e['bodyValues'] as JsonObject), ['1']);
  });
  test('receivedAt is UTCDate without fraction', async () => {
    const e = await toJmapEmail(msg(), 't1', opts({ properties: ['receivedAt'] }));
    assert.equal(e['receivedAt'], '2026-03-01T10:00:00Z');
  });
  test('BUG: sentAt has ".000" — RFC 8620 §1.4: time-secfrac MUST be omitted if zero', async () => {
    const e = await toJmapEmail(msg(), 't1', opts({ properties: ['sentAt'] }));
    assert.doesNotMatch(String(e['sentAt']), /\.000/);
  });
  test('BUG: header:X:asFoo (unknown parsed form) must be rejected as invalidArguments (§4.1.3)', () => {
    assert.deepEqual(invalidEmailProperties(['header:Subject:asFoo']), ['header:Subject:asFoo']);
  });
  test('BUG: header:Subject:asAddresses (form not allowed for Subject) must be rejected (§4.1.3)', () => {
    assert.deepEqual(invalidEmailProperties(['header:Subject:asAddresses']), ['header:Subject:asAddresses']);
  });
});

// ── RFC 8621 §7.5: Bcc must not reach recipients ──────────────────────────

describe('RFC 8621 §7.5 Bcc handling (evidence)', () => {
  test('draft raw built by Email/set create keeps the Bcc header (nodemailer streamTransport keepBcc=true)', async () => {
    const raw = (await buildRfc822({
      from: { name: null, email: 'a@b.de' }, to: [{ name: null, email: 'c@d.de' }], cc: [],
      bcc: [{ name: null, email: 'secret@x.de' }], replyTo: [], subject: 's', date: new Date(0),
      messageId: null, inReplyTo: [], references: [], text: 'x', html: '', attachments: [], extraHeaders: [],
    })).toString();
    // EmailSubmission/set enqueues exactly this buffer as rawMessage (submission.ts enqueue) and the
    // smtp-server worker sends rawMessage verbatim (outbound/queue.ts:193-194) → the Bcc header is
    // delivered to every To/Cc recipient. RFC 8621 §7.5: "the server MUST remove any Bcc header".
    assert.match(raw, /^Bcc: secret@x\.de/m);
  });
});

// ── RFC 8620 §6 blob ids (no DB/Redis needed for these) ────────────────────

describe('Blob id parsing (resolveBlob pre-DB rejection)', () => {
  for (const id of ['', '../etc/passwd', 'a/b', 'x'.repeat(256), 'zz-unknown', 'p-', 'pp-text', 'ppzz-text']) {
    test(`unknown/invalid blob id ${JSON.stringify(id.slice(0, 20))} → null`, async () => {
      assert.equal(await resolveBlob(acc, id), null);
    });
  }
});
