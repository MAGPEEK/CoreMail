/**
 * EAS 12.1 / 14.0 / 14.1 per command: every command answers a request of the negotiated
 * version with tags that version defines ([MS-ASWBXML], `tagsNewerThan`), plus the
 * version-specific content: 12.1 gets no Email2 conversation properties, no body Preview,
 * no recipient Availability, no Accounts form and no RightsManagementInformation;
 * GetItemEstimate keeps the 12.1 request form (Class + FilterType directly in the
 * Collection) and echoes the Class; Provision registers the device with its version,
 * ignores DeviceInformation before 14.1 and answers a blocked 12.1 device with HTTP 403.
 * Run: node --import tsx --test src/version-matrix.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installFakeDb, clientWbxml, type WNode } from './test-support/fake-db.js';
import { RAW_MESSAGE } from './commands/test-fixtures.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const VERSIONS = ['12.1', '14.0', '14.1'] as const;
type V = (typeof VERSIONS)[number];
const dev = (v: V) => `dev-${v}`;

const db = installFakeDb({
  user: [
    { id: 'u1', email: 'bob@example.com', displayName: 'Bob B', domainId: 'dom1', active: true },
    { id: 'u2', email: 'carol@example.com', displayName: 'Carol C', domainId: 'dom1', active: true },
  ],
  emailAlias: [{ address: 'info@example.com', targetUserId: 'u1', active: true }],
  userSettings: [], sharedMailbox: [], contact: [], attachment: [], activeSyncItem: [],
  mailbox: [{ id: 'mb1', userId: 'u1', uidNext: 10, highestModSeq: 5n }],
  folder: [
    { id: 'inbox', mailboxId: 'mb1', name: 'INBOX', displayName: 'Inbox', parentId: null },
    { id: 'sent', mailboxId: 'mb1', name: 'Sent', displayName: 'Sent', parentId: null },
    { id: 'trash', mailboxId: 'mb1', name: 'Trash', displayName: 'Trash', parentId: null },
  ],
  message: [{
    id: 'm1', folderId: 'inbox', uid: 1, modSeq: 3n, flags: [], subject: 'Quarterly report',
    fromAddr: 'alice@example.test', fromName: 'Alice', toAddrs: ['bob@example.com'], ccAddrs: [], replyTo: null,
    messageId: '<q3@example.test>', inReplyTo: null, threadId: 't1', date: new Date('2026-11-14T08:00:00Z'),
    bodyText: 'Report attached', bodyHtml: '<p>Report attached</p>', storagePath: 'raw/m1', smimeMeta: null, deletedAt: null,
  }],
  activeSyncDevice: VERSIONS.map((v) => ({ id: `d-${v}`, userId: 'u1', deviceId: dev(v), status: 'OK', policyKey: '7', protocolVersion: v, syncKeys: {} })),
});

const { handleProvision } = await import('./commands/provision.js');
const { handleFolderSync } = await import('./commands/folder-sync.js');
const { handleSync } = await import('./commands/sync.js');
const { handleGetItemEstimate } = await import('./commands/get-item-estimate.js');
const { handleItemOperations, prismaItemOperationsDeps } = await import('./commands/item-operations.js');
const { handleSettings } = await import('./commands/settings.js');
const { handleSearch } = await import('./commands/search.js');
const { handleResolveRecipients } = await import('./commands/resolve-recipients.js');
const { handleMoveItems } = await import('./commands/move-items.js');
const { handleMeetingResponse } = await import('./commands/meeting-response.js');
const { handlePing } = await import('./commands/ping.js');
const { EasHttpError } = await import('./http-error.js');
const { decodeWbxml, tagsNewerThan, CP } = await import('./wbxml.js');
type E = import('./wbxml.js').WbxmlElement;

const req = (node: WNode) => decodeWbxml(clientWbxml(node));
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
const kids = (e: E | undefined, name: string): E[] => (e?.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === name);
function find(e: E, pred: (x: E) => boolean): E | undefined {
  if (pred(e)) return e;
  for (const c of e.children ?? []) { if (typeof c === 'string') continue; const hit = find(c, pred); if (hit) return hit; }
  return undefined;
}
/** The response only carries tags `v` defines; returns the decoded tree. */
function valid(buf: Buffer, v: V): E {
  assert.deepEqual(tagsNewerThan(buf, v), [], `tags newer than ${v}`);
  return decodeWbxml(buf);
}
const onPage = (tree: E, page: number) => find(tree, (x) => x.page === page);
const device = (deviceId: string) => db.tables['activeSyncDevice']!.find((d) => d['deviceId'] === deviceId)!;

const PV = (t: number, k?: WNode[] | string): WNode => [14, t, k];
const provisionReq = (key?: string): WNode => PV(0x05, [
  [18, 0x16, [[18, 0x08, [[18, 0x19, 'Test phone']]]]], // settings:DeviceInformation (14.1+)
  PV(0x06, [PV(0x07, [PV(0x08, 'MS-EAS-Provisioning-WBXML'), ...(key ? [PV(0x09, key), PV(0x0b, '1')] : [])])]),
]);

for (const v of VERSIONS) {
  test(`${v} Provision: registers the device with its version; DeviceInformation only from 14.1; policy doc valid`, async () => {
    const id = `new-${v}`;
    const p1 = valid(await handleProvision(req(provisionReq()), 'u1', id, 'TestPhone', v), v);
    assert.equal(device(id)['protocolVersion'], v);
    const temp = kid(kid(kid(p1, 'Policies'), 'Policy'), 'PolicyKey')?.text;
    assert.ok(temp && kid(kid(kid(kid(p1, 'Policies'), 'Policy'), 'Data'), 'EASProvisionDoc'));
    assert.equal(!!kid(p1, 'DeviceInformation'), v === '14.1');
    assert.equal(device(id)['deviceFriendlyName'], v === '14.1' ? 'Test phone' : undefined);
    const p2 = valid(await handleProvision(req(provisionReq(temp)), 'u1', id, 'TestPhone', v), v);
    assert.equal(kid(kid(kid(p2, 'Policies'), 'Policy'), 'Status')?.text, '1');
  });
}

test('blocked device: Provision Status 129 from 14.0, HTTP 403 for 12.1 (no global status codes)', async () => {
  device(dev('14.0'))['status'] = 'BLOCKED';
  device(dev('12.1'))['status'] = 'BLOCKED';
  try {
    const t = decodeWbxml(await handleProvision(req(provisionReq()), 'u1', dev('14.0'), 'TestPhone', '14.0'));
    assert.equal(kid(t, 'Status')?.text, '129');
    await assert.rejects(handleProvision(req(provisionReq()), 'u1', dev('12.1'), 'TestPhone', '12.1'),
      (err: unknown) => err instanceof EasHttpError && err.httpStatus === 403);
  } finally {
    device(dev('14.0'))['status'] = 'OK';
    device(dev('12.1'))['status'] = 'OK';
  }
});

test('remote wipe is the same for every version: Provision answers <RemoteWipe/> (byte fixture)', async () => {
  for (const v of VERSIONS) {
    device(dev(v))['status'] = 'WIPED';
    try {
      const plain = PV(0x05, [PV(0x06, [PV(0x07, [PV(0x08, 'MS-EAS-Provisioning-WBXML')])])]);
      const buf = await handleProvision(req(plain), 'u1', dev(v), 'TestPhone', v);
      assert.deepEqual([...buf], [0x03, 0x01, 0x6a, 0x00, 0x00, 0x0e, 0x45, 0x4b, 0x03, 0x31, 0x00, 0x01, 0x0c, 0x01], v);
    } finally {
      device(dev(v))['status'] = 'OK';
    }
  }
});

for (const v of VERSIONS) {
  test(`${v} FolderSync: hierarchy with the version's tags; the Notes folder only from 14.0 (w3)`, async () => {
    const tree = valid(await handleFolderSync(req([7, 0x16, [[7, 0x12, '0']]]), 'u1', dev(v), v), v);
    const pim = kids(kid(tree, 'Changes'), 'Add').map((a) => `${kid(a, 'ServerId')?.text}/${kid(a, 'Type')?.text}`).filter((x) => x.includes(':'));
    assert.deepEqual(pim, v === '12.1' ? ['tasks:default/7'] : ['tasks:default/7', 'notes:default/10']);
    assert.equal(kid(kid(tree, 'Changes'), 'Count')?.text, String(3 + pim.length));
  });
}

const A = (t: number, k?: WNode[] | string): WNode => [0, t, k];
/** Sync of the inbox: priming request, then GetChanges with an HTML BodyPreference asking for a Preview. */
async function syncInbox(v: V): Promise<Buffer> {
  const run = (col: WNode[]) => handleSync(req(A(0x05, [A(0x1c, [A(0x0f, col)])])), 'u1', dev(v), { loadRaw: async () => RAW_MESSAGE, now: () => NOW }, v);
  const primed = decodeWbxml(await run([A(0x10, 'Email'), A(0x0b, '0'), A(0x12, 'inbox')]));
  const key = kid(kid(kid(primed, 'Collections'), 'Collection'), 'SyncKey')!.text!;
  return run([A(0x10, 'Email'), A(0x0b, key), A(0x12, 'inbox'), A(0x13), A(0x17, [[17, 0x05, [[17, 0x06, '2'], [17, 0x18, '50']]]])]);
}

for (const v of VERSIONS) {
  test(`${v} Sync: Add with AirSyncBase body; Email2 + Preview only from 14.0`, async () => {
    const tree = valid(await syncInbox(v), v);
    const add = find(tree, (x) => x.name === 'Add');
    assert.ok(add, 'Add expected');
    assert.equal(find(add, (x) => x.name === 'Body' && x.page === CP.AirSyncBase) !== undefined, true);
    assert.equal(onPage(add, CP.Email2) !== undefined, v !== '12.1', 'Email2 ConversationId');
    assert.equal(find(add, (x) => x.name === 'Preview') !== undefined, v !== '12.1', 'airsyncbase:Preview');
  });
}

const G = (t: number, k?: WNode[] | string): WNode => [6, t, k];
/** Re-primes the inbox of the version's device (it holds nothing) and returns the new SyncKey. */
async function primeInbox(v: V): Promise<string> {
  const primed = decodeWbxml(await handleSync(req(A(0x05, [A(0x1c, [A(0x0f, [A(0x0b, '0'), A(0x12, 'inbox')])])])), 'u1', dev(v), {}, v));
  return kid(kid(kid(primed, 'Collections'), 'Collection'), 'SyncKey')!.text!;
}

test('12.1 GetItemEstimate: Class + FilterType directly in the Collection; Class echoed (byte fixture)', async () => {
  const key = await primeInbox('12.1');
  const run = async (filterType: string) => handleGetItemEstimate(req(G(0x05, [G(0x07, [G(0x08, [
    G(0x09, 'Email'), G(0x0a, 'inbox'), A(0x18, filterType), A(0x0b, key),
  ])])])), 'u1', dev('12.1'), () => NOW, '12.1');
  const s = (x: string) => [0x03, ...Buffer.from(x), 0x00, 0x01];
  const bytes = (n: string) => [0x03, 0x01, 0x6a, 0x00, 0x00, 0x06,
    0x45, 0x4d, 0x4e, ...s('1'), 0x48, 0x49, ...s('Email'), 0x4a, ...s('inbox'), 0x4c, ...s(n), 0x01, 0x01, 0x01];
  // FilterType 1 (one day): m1 (28 h old) is outside the window; 0 = no filter
  assert.deepEqual([...await run('1')], bytes('0'));
  assert.deepEqual([...await run('0')], bytes('1'));
});

test('14.0 GetItemEstimate: FilterType inside airsync:Options, no Class in the response', async () => {
  const key = await primeInbox('14.0');
  const run = async (filterType: string) => valid(await handleGetItemEstimate(req(G(0x05, [G(0x07, [G(0x08, [
    A(0x0b, key), G(0x0a, 'inbox'), A(0x17, [A(0x18, filterType)]),
  ])])])), 'u1', dev('14.0'), () => NOW, '14.0'), '14.0');
  const one = await run('1');
  const col = kid(kid(one, 'Response'), 'Collection');
  assert.equal(kid(col, 'Class'), undefined);
  assert.equal(kid(col, 'Estimate')?.text, '0');
  assert.equal(kid(kid(kid(await run('0'), 'Response'), 'Collection'), 'Estimate')?.text, '1');
});

for (const v of VERSIONS) {
  test(`${v} ItemOperations Fetch: full item, Email2 only from 14.0`, async () => {
    const r = req([20, 0x05, [[20, 0x06, [[20, 0x07, 'Mailbox'], A(0x12, 'inbox'), A(0x0d, 'm1'), [20, 0x08, [[17, 0x05, [[17, 0x06, '2']]]]]]]]]);
    const tree = valid(await handleItemOperations(r, 'u1', { ...prismaItemOperationsDeps(), loadRaw: async () => RAW_MESSAGE }, v), v);
    const props = find(tree, (x) => x.name === 'Properties');
    assert.ok(props && find(props, (x) => x.name === 'Body'));
    assert.equal(onPage(props, CP.Email2) !== undefined, v !== '12.1');
  });
}

const S = (t: number, k?: WNode[] | string): WNode => [18, t, k];
for (const v of VERSIONS) {
  test(`${v} Settings: Oof Get, UserInformation form, RightsManagementInformation only from 14.1`, async () => {
    const tree = valid(await handleSettings(req(S(0x05, [
      S(0x09, [S(0x07, [S(0x13, 'Text')])]),
      S(0x1d, [S(0x07)]),
      S(0x2b, [S(0x07)]),
    ])), 'u1', dev(v), v), v);
    assert.equal(kid(kid(tree, 'Oof'), 'Status')?.text, '1');
    const get = kid(kid(tree, 'UserInformation'), 'Get');
    assert.equal(!!kid(get, 'Accounts'), v === '14.1');
    if (v !== '14.1') assert.deepEqual(kids(kid(get, 'EmailAddresses'), 'SmtpAddress').map((x) => x.text), ['bob@example.com', 'info@example.com']);
    assert.equal(!!kid(tree, 'RightsManagementInformation'), v === '14.1');
  });
}

test('12.1 Settings UserInformation Get (byte fixture: EmailAddresses / SmtpAddress)', async () => {
  const buf = await handleSettings(req(S(0x05, [S(0x1d, [S(0x07)])])), 'u1', dev('12.1'), '12.1');
  const s = (x: string) => [0x03, ...Buffer.from(x), 0x00, 0x01];
  assert.deepEqual([...buf], [0x03, 0x01, 0x6a, 0x00, 0x00, 18,
    0x45, 0x46, ...s('1'), 0x5d, 0x46, ...s('1'), 0x47, 0x5e, 0x5f, ...s('bob@example.com'), 0x5f, ...s('info@example.com'),
    0x01, 0x01, 0x01, 0x01]);
});

for (const v of VERSIONS) {
  test(`${v} Search Store=Mailbox: results with the version's tags`, async () => {
    const Q = (t: number, k?: WNode[] | string): WNode => [15, t, k];
    const tree = valid(await handleSearch(req(Q(0x05, [Q(0x07, [
      Q(0x08, 'Mailbox'),
      Q(0x09, [Q(0x13, [A(0x10, 'Email'), A(0x12, 'inbox'), Q(0x15, 'Report')])]),
      Q(0x0a, [Q(0x0b, '0-9'), [17, 0x05, [[17, 0x06, '1'], [17, 0x07, '100']]]]),
    ])])), 'u1'), v);
    assert.equal(kid(find(tree, (x) => x.name === 'Result')!, 'LongId')?.text, 'm1');
  });

  test(`${v} ResolveRecipients: Availability only from 14.0`, async () => {
    const R = (t: number, k?: WNode[] | string): WNode => [10, t, k];
    const tree = valid(await handleResolveRecipients(req(R(0x05, [
      R(0x10, 'carol@example.com'),
      R(0x0f, [R(0x16, [R(0x17, '2026-11-16T00:00:00.000Z'), R(0x18, '2026-11-17T00:00:00.000Z')])]),
    ])), 'u1', v), v);
    const recipient = kid(kid(tree, 'Response'), 'Recipient');
    assert.equal(kid(recipient, 'EmailAddress')?.text, 'carol@example.com');
    assert.equal(!!kid(recipient, 'Availability'), v !== '12.1');
  });

  test(`${v} MeetingResponse: Result with the version's tags`, async () => {
    const M = (t: number, k?: WNode[] | string): WNode => [8, t, k];
    const tree = valid(await handleMeetingResponse(req(M(0x07, [M(0x09, [M(0x0c, '1'), M(0x06, 'inbox'), M(0x08, 'no-such-item')])])), 'u1', undefined, v), v);
    assert.equal(kid(kid(tree, 'Result'), 'Status')?.text, '2');
  });

  test(`${v} Ping: changed folder reported with the version's tags`, async () => {
    device(dev(v))['syncKeys'] = { inbox: '1' }; // the device last saw modSeq < 3
    const res = new FakeRes();
    const P = (t: number, k?: WNode[] | string): WNode => [13, t, k];
    await handlePing(req(P(0x05, [P(0x08, '480'), P(0x09, [P(0x0a, [P(0x0b, 'inbox'), P(0x0c, 'Email')])])])), 'u1', res as never, {},
      { deviceId: dev(v), pollIntervalMs: 5, version: v });
    const tree = valid(res.body!, v);
    assert.equal(kid(tree, 'Status')?.text, '2');
  });

  test(`${v} MoveItems: moves with the version's tags`, async () => {
    const M = (t: number, k?: WNode[] | string): WNode => [5, t, k];
    const move = async (from: string, to: string) => valid(await handleMoveItems(req(M(0x05, [M(0x06, [M(0x07, 'm1'), M(0x08, from), M(0x09, to)])])), 'u1', dev(v), v), v);
    assert.equal(kid(kid(await move('inbox', 'trash'), 'Response'), 'Status')?.text, '3');
    assert.equal(kid(kid(await move('trash', 'inbox'), 'Response'), 'Status')?.text, '3');
  });
}

/** Minimal Express Response stand-in for Ping. */
class FakeRes extends EventEmitter {
  statusCode = 0; body: Buffer | null = null; writableEnded = false; headers: Record<string, string> = {};
  set(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; }
  setHeader(k: string, v: string) { return this.set(k, v); }
  removeHeader(k: string) { delete this.headers[k.toLowerCase()]; }
  status(c: number) { this.statusCode = c; return this; }
  send(b: Buffer | string) { this.body = Buffer.isBuffer(b) ? b : Buffer.from(b); this.writableEnded = true; this.emit('finish'); return this; }
}
