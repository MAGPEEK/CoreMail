/**
 * Search command: Store=Mailbox (FreeText/And/EqualTo CollectionId, Range,
 * DeepTraversal, BodyPreference) scoped to the caller's mailbox; Store=GAL
 * limited to the caller's domain.
 * Run: node --import tsx --test src/commands/search.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, clientWbxml, wbxmlTags, type WNode } from '../test-support/fake-db.js';

const d = (s: string) => new Date(s);
const msg = (id: string, folderId: string, subject: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, folderId, subject, fromAddr: 'sender@ext.test', fromName: 'Sender', toAddrs: ['alice@example.com'], ccAddrs: [],
  date: d(date), flags: [], bodyText: `body of ${subject}`, bodyHtml: '', deletedAt: null, ...extra,
});

installFakeDb({
  user: [
    { id: 'u1', email: 'alice@example.com', displayName: 'Alice Anders', domainId: 'd1', active: true },
    { id: 'u2', email: 'bob@example.com', displayName: 'Bob Brown', domainId: 'd1', active: true },
    { id: 'u3', email: 'eve@other.test', displayName: 'Eve Brown', domainId: 'd2', active: true },
    { id: 'u4', email: 'gone@example.com', displayName: 'Gone Brown', domainId: 'd1', active: false },
  ],
  sharedMailbox: [
    { id: 's1', email: 'sales@example.com', displayName: 'Sales Brownies', domainId: 'd1', active: true },
    { id: 's2', email: 'ops@other.test', displayName: 'Ops Brown', domainId: 'd2', active: true },
  ],
  mailbox: [{ id: 'mb1', userId: 'u1' }, { id: 'mb2', userId: 'u2' }],
  folder: [
    { id: 'inbox', mailboxId: 'mb1', name: 'INBOX', parentId: null },
    { id: 'projects', mailboxId: 'mb1', name: 'Projects', parentId: 'inbox' },
    { id: 'sent', mailboxId: 'mb1', name: 'Sent', parentId: null },
    { id: 'bob-inbox', mailboxId: 'mb2', name: 'INBOX', parentId: null },
  ],
  message: [
    msg('m1', 'inbox', 'Quarterly report', '2026-11-01T10:00:00Z', { bodyHtml: '<p>The <b>report</b> is attached</p>' }),
    msg('m2', 'projects', 'Report draft', '2026-11-02T10:00:00Z', { flags: ['\\Seen'] }),
    msg('m3', 'sent', 'Lunch', '2026-11-03T10:00:00Z'),
    msg('m4', 'inbox', 'Old report', '2025-01-01T10:00:00Z'),
    msg('m5', 'inbox', 'Deleted report', '2026-11-04T10:00:00Z', { deletedAt: d('2026-11-05T00:00:00Z') }),
    msg('b1', 'bob-inbox', 'Report for Bob', '2026-11-05T10:00:00Z'),
  ],
});

const { handleSearch } = await import('./search.js');
const { decodeWbxml } = await import('../wbxml.js');
type E = import('../wbxml.js').WbxmlElement;

const Q = (t: number, k?: WNode[] | string): WNode => [15, t, k];
const A = (t: number, k?: WNode[] | string): WNode => [0, t, k];
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
const all = (e: E | undefined, name: string): E[] => (e?.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === name);

function mailboxReq(query: WNode[], options: WNode[] = [Q(0x0b, '0-9')]): WNode {
  return Q(0x05, [Q(0x07, [Q(0x08, 'Mailbox'), Q(0x09, [Q(0x13, query)]), Q(0x0a, options)])]);
}
async function run(req: WNode, userId = 'u1'): Promise<{ store: E; buf: Buffer }> {
  const buf = await handleSearch(decodeWbxml(clientWbxml(req)), userId);
  const res = decodeWbxml(buf);
  assert.equal(kid(res, 'Status')?.text, '1');
  return { store: kid(kid(res, 'Response'), 'Store')!, buf };
}
const ids = (store: E) => all(store, 'Result').map((r) => kid(r, 'LongId')?.text).filter(Boolean);

test('Mailbox: FreeText in a collection (no DeepTraversal) — own folder only, newest first', async () => {
  const { store, buf } = await run(mailboxReq([A(0x12, 'inbox'), Q(0x15, 'report')]));
  assert.equal(kid(store, 'Status')?.text, '1');
  assert.deepEqual(ids(store), ['m1', 'm4']);
  assert.equal(kid(store, 'Total')?.text, '2');
  assert.equal(kid(store, 'Range')?.text, '0-1');
  const r = all(store, 'Result')[0]!;
  assert.equal(kid(r, 'Class')?.text, 'Email');
  assert.equal(kid(r, 'CollectionId')?.text, 'inbox');
  assert.equal(kid(kid(r, 'Properties'), 'Subject')?.text, 'Quarterly report');
  // Class/CollectionId on AirSync (0), Subject on Email (2), no AirSyncBase body without BodyPreference
  const tags = wbxmlTags(buf);
  assert.ok(tags.some(([p, t]) => p === 0 && t === 0x10) && tags.some(([p, t]) => p === 2 && t === 0x14));
  assert.ok(!tags.some(([p]) => p === 17));
});

test('Mailbox: DeepTraversal includes subfolders; EqualTo CollectionId works as well', async () => {
  const deep = await run(mailboxReq([A(0x12, 'inbox'), Q(0x15, 'report')], [Q(0x0b, '0-9'), Q(0x17)]));
  assert.deepEqual(ids(deep.store), ['m2', 'm1', 'm4']);
  const eq = await run(mailboxReq([Q(0x11, [A(0x12), Q(0x12, 'projects')]), Q(0x15, 'report')]));
  assert.deepEqual(ids(eq.store), ['m2']);
});

test('Mailbox: without CollectionId every own folder is searched, never other mailboxes', async () => {
  const { store } = await run(mailboxReq([Q(0x15, 'report')], [Q(0x0b, '0-99'), Q(0x19), Q(0x17)]));
  assert.deepEqual(ids(store), ['m2', 'm1', 'm4']); // not b1 (Bob), not m5 (deleted)
});

test('Mailbox: a foreign or unknown CollectionId is refused alike (Store Status 2, no results)', async () => {
  for (const cid of ['bob-inbox', 'nope']) {
    const { store } = await run(mailboxReq([A(0x12, cid), Q(0x15, 'report')]));
    assert.equal(kid(store, 'Status')?.text, '2', cid);
    assert.equal(all(store, 'Result').length, 0);
  }
});

test('Mailbox: Range pages the result; GreaterThan DateReceived filters', async () => {
  const p2 = await run(mailboxReq([Q(0x15, 'report')], [Q(0x0b, '1-1'), Q(0x17)]));
  assert.deepEqual(ids(p2.store), ['m1']);
  assert.equal(kid(p2.store, 'Range')?.text, '1-1');
  assert.equal(kid(p2.store, 'Total')?.text, '3');
  const recent = await run(mailboxReq([Q(0x15, 'report'), Q(0x1b, [[2, 0x0f], Q(0x12, '2026-01-01T00:00:00Z')])], [Q(0x0b, '0-9'), Q(0x17)]));
  assert.deepEqual(ids(recent.store), ['m2', 'm1']);
});

test('Mailbox: BodyPreference returns an AirSyncBase body (text from HTML, truncated)', async () => {
  const { store } = await run(mailboxReq([A(0x12, 'inbox'), Q(0x15, 'quarterly')], [Q(0x0b, '0-9'), [17, 0x05, [[17, 0x06, '1'], [17, 0x07, '7']]]]));
  const body = kid(kid(all(store, 'Result')[0], 'Properties'), 'Body')!;
  assert.equal(kid(body, 'Type')?.text, '1');
  assert.equal(kid(body, 'Data')?.text, 'body of');
  assert.equal(kid(body, 'Truncated')?.text, '1');
});

test('Mailbox: no hit → empty Result, Total 0', async () => {
  const { store } = await run(mailboxReq([Q(0x15, 'zzz')]));
  assert.equal(kid(store, 'Status')?.text, '1');
  assert.equal(all(store, 'Result').length, 1);
  assert.equal(kid(all(store, 'Result')[0], 'Properties'), undefined);
  assert.equal(kid(store, 'Total')?.text, '0');
});

test('Mailbox: unsupported query element → Status 8 (too complex)', async () => {
  const { store } = await run(mailboxReq([Q(0x14, [Q(0x15, 'a')])]));
  assert.equal(kid(store, 'Status')?.text, '8');
});

test('GAL: users + shared mailboxes of the own domain only (active), GAL page properties', async () => {
  const req = Q(0x05, [Q(0x07, [Q(0x08, 'GAL'), Q(0x09, 'brown'), Q(0x0a, [Q(0x0b, '0-9')])])]);
  const { store, buf } = await run(req);
  const rows = all(store, 'Result').map((r) => kid(kid(r, 'Properties'), 'EmailAddress')?.text);
  assert.deepEqual(rows, ['bob@example.com', 'sales@example.com']);
  assert.equal(kid(store, 'Total')?.text, '2');
  const props = kid(all(store, 'Result')[0], 'Properties')!;
  assert.equal(kid(props, 'DisplayName')?.text, 'Bob Brown');
  assert.equal(kid(props, 'Alias')?.text, 'bob');
  assert.ok(wbxmlTags(buf).some(([p, t]) => p === 16 && t === 0x0f), 'GAL:EmailAddress on page 16');
  assert.ok(!JSON.stringify(decodeWbxml(buf)).includes('other.test'));
});

test('GAL: Range slices, empty query → Status 2', async () => {
  const req = Q(0x05, [Q(0x07, [Q(0x08, 'GAL'), Q(0x09, 'example.com'), Q(0x0a, [Q(0x0b, '1-1')])])]);
  const { store } = await run(req);
  assert.equal(all(store, 'Result').length, 1);
  assert.equal(kid(store, 'Range')?.text, '1-1');
  assert.equal(kid(store, 'Total')?.text, '3');
  const empty = await run(Q(0x05, [Q(0x07, [Q(0x08, 'GAL'), Q(0x09, ' ')])]));
  assert.equal(kid(empty.store, 'Status')?.text, '2');
});
