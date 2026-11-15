/**
 * Sync delivers EAS 14.1 bodies: airsyncbase:Body per BodyPreference (plain / HTML /
 * MIME byte-exact / truncation / AllOrNone / preview), MIMESupport semantics,
 * airsyncbase:Attachments, NativeBodyType, Email2 conversation properties and
 * sticky Sync Options. Before, Sync sent the EAS 2.5 Email:Body (page 2), cut at
 * 4096 chars and ignored BodyPreference, so 14.1 clients showed empty bodies.
 * Run: node --import tsx --test src/commands/sync-body.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RAW_MESSAGE, messageRow, ATTACHMENT_ROWS, find, findAll, clientWbxml, testEnv, type ClientNode } from './test-fixtures.js';

testEnv();
let device: { id: string; syncKeys: Record<string, string> };
let transactions = 0;
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  $transaction: async () => { transactions++; },
  folder: { findFirst: async ({ where }: { where: { id: string; mailbox: { userId: string } } }) =>
    (where.id === 'inbox' && where.mailbox.userId === 'u1' ? { id: 'inbox', mailboxId: 'mb1' } : null) },
  activeSyncDevice: {
    findUnique: async () => ({ ...device, syncKeys: { ...device.syncKeys } }),
    update: async ({ data }: { data: { syncKeys: Record<string, string> } }) => { device.syncKeys = data.syncKeys; return {}; },
  },
  mailbox: { findUnique: async () => ({ highestModSeq: 5n }), updateMany: async () => ({ count: 0 }) },
  // per-device item state: the device holds nothing (every message is an Add)
  activeSyncItem: { findMany: async () => [], deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
  message: {
    aggregate: async () => ({ _max: { modSeq: 5n, uid: 1 } }),
    findMany: async () => [messageRow()],
    findFirst: async () => messageRow(),
  },
  attachment: {
    findMany: async ({ where }: { where: { messageId: { in: string[] } } }) =>
      ATTACHMENT_ROWS.filter((a) => where.messageId.in.includes(a.messageId)),
  },
};

const { handleSync } = await import('./sync.js');
const { decodeWbxml, CP } = await import('../wbxml.js');
const { parseBodyOptions, chooseBodyPreference, htmlToText } = await import('./body.js');

const loadRaw = async () => RAW_MESSAGE;
const PREF = (type: string, extra: ClientNode[] = []): ClientNode => [17, 0x05, [[17, 0x06, type], ...extra]];
/** Sync request as a device encodes it: SyncKey 1, inbox, Options(MIMESupport?, BodyPreference…). */
function syncReq(options: ClientNode[] | null, extra: ClientNode[] = []) {
  const col: ClientNode[] = [[0, 0x0b, '1'], [0, 0x12, 'inbox'], [0, 0x13], ...extra];
  if (options) col.push([0, 0x17, options]);
  return decodeWbxml(clientWbxml([0, 0x05, [[0, 0x1c, [[0, 0x0f, col]]]]]));
}
async function sync(options: ClientNode[] | null, extra: ClientNode[] = []) {
  return decodeWbxml(await handleSync(syncReq(options, extra), 'u1', 'dev1', { loadRaw }));
}
function body(tree: ReturnType<typeof decodeWbxml>) {
  const b = find(tree, 'Body', CP.AirSyncBase);
  assert.ok(b, `no airsyncbase:Body in ${JSON.stringify(tree)}`);
  const get = (n: string) => find(b, n, CP.AirSyncBase);
  return { b, type: get('Type')?.text, size: get('EstimatedDataSize')?.text, truncated: get('Truncated')?.text, data: get('Data'), preview: get('Preview')?.text };
}

beforeEach(() => { device = { id: 'd1', syncKeys: {} }; transactions = 0; });

test('Type 1 (plain): full UTF-8 text, EstimatedDataSize in bytes, no EAS 2.5 Email:Body', async () => {
  const t = await sync([PREF('1')]);
  const r = body(t);
  const text = messageRow().bodyText;
  assert.equal(r.type, '1');
  assert.equal(r.data?.text, text);
  assert.equal(r.size, String(Buffer.byteLength(text)));
  assert.equal(r.truncated, '0');
  assert.equal(find(t, 'Body', CP.Email), undefined, 'legacy Email:Body must not be sent');
  assert.equal(find(t, 'BodyTruncated'), undefined);
});

test('Type 2 (HTML) when the message has HTML', async () => {
  const r = body(await sync([PREF('1'), PREF('2')]));
  assert.equal(r.type, '2');
  assert.equal(r.data?.text, messageRow().bodyHtml);
});

test('Type 4 (MIME) with MIMESupport 2: loadRawMessage octets byte-exact', async () => {
  const r = body(await sync([[0, 0x22, '2'], PREF('4')]));
  assert.equal(r.type, '4');
  assert.equal(r.size, String(RAW_MESSAGE.length));
  assert.ok(r.data?.bytes?.equals(RAW_MESSAGE), 'MIME must be the stored raw message, byte for byte');
});

test('Type 4 without MIMESupport (0) falls back to plain text; MIMESupport 1 only for S/MIME', async () => {
  assert.equal(body(await sync([PREF('4')])).type, '1');
  assert.equal(body(await sync([[0, 0x22, '1'], PREF('4'), PREF('2')])).type, '2');
  const opts = parseBodyOptions(find(syncReq([[0, 0x22, '1'], PREF('4', [[17, 0x07, '500'], [17, 0x08, '1'], [17, 0x18, '300']])]), 'Collection'));
  assert.deepEqual(opts, { prefs: [{ type: 4, truncationSize: 500, allOrNone: true, preview: 255 }], mimeSupport: 1 });
  const smime = { bodyHtml: '', smimeMeta: '{"signed":true}', attachments: [] };
  assert.equal(chooseBodyPreference({ prefs: [{ type: 4, allOrNone: false }], mimeSupport: 1 }, smime).type, 4);
  assert.equal(chooseBodyPreference({ prefs: [{ type: 4, allOrNone: false }], mimeSupport: 1 }, { ...smime, smimeMeta: null }).type, 1);
});

test('TruncationSize: Truncated 1, Data cut on a UTF-8 character boundary', async () => {
  const r = body(await sync([PREF('1', [[17, 0x07, '24']])]));
  assert.equal(r.truncated, '1');
  const full = Buffer.from(messageRow().bodyText, 'utf8');
  assert.equal(r.size, String(full.length));
  assert.ok(r.data!.bytes!.length <= 24 && r.data!.bytes!.length >= 21);
  assert.ok(full.subarray(0, r.data!.bytes!.length).equals(r.data!.bytes!));
  assert.ok(!r.data!.text!.includes('�'), 'no split multi-byte character');
});

test('MIME truncation cuts raw octets; AllOrNone sends no Data when too large', async () => {
  const m = body(await sync([[0, 0x22, '2'], PREF('4', [[17, 0x07, '100']])]));
  assert.equal(m.truncated, '1');
  assert.ok(m.data!.bytes!.equals(RAW_MESSAGE.subarray(0, 100)));
  const a = body(await sync([PREF('2', [[17, 0x07, '10'], [17, 0x08, '1']])]));
  assert.equal(a.truncated, '1');
  assert.equal(a.data, undefined);
  const fits = body(await sync([PREF('2', [[17, 0x07, '100000'], [17, 0x08, '1']])]));
  assert.equal(fits.truncated, '0');
  assert.equal(fits.data?.text, messageRow().bodyHtml);
});

test('Preview: plain-text preview of at most N characters', async () => {
  const r = body(await sync([PREF('2', [[17, 0x18, '12']])]));
  assert.equal(r.preview, 'Café report ');
  assert.equal(htmlToText('<p>a&amp;b<br>c</p><style>x</style>'), 'a&b\nc');
});

test('Attachments, NativeBodyType, MessageClass, InternetCPID, Email2 conversation', async () => {
  const t = await sync([PREF('2')]);
  const atts = findAll(t, 'Attachment').filter((a) => a.page === CP.AirSyncBase);
  assert.equal(atts.length, 2);
  const props = (a: (typeof atts)[number]) => Object.fromEntries((a.children ?? []).map((c) => typeof c === 'string' ? [c, c] : [c.name, c.text]));
  assert.deepEqual(props(atts[0]!), { DisplayName: 'logo.png', FileReference: 'att-logo', Method: '1', EstimatedDataSize: '8', ContentId: 'logo@x', IsInline: '1' });
  assert.deepEqual(props(atts[1]!), { DisplayName: 'report.pdf', FileReference: 'att-pdf', Method: '1', EstimatedDataSize: '9' });
  assert.ok(atts.every((a) => (a.children ?? []).every((c) => typeof c !== 'string' && c.page === CP.AirSyncBase)));
  assert.equal(find(t, 'NativeBodyType', CP.AirSyncBase)?.text, '2');
  assert.equal(find(t, 'MessageClass', CP.Email)?.text, 'IPM.Note');
  assert.equal(find(t, 'InternetCPID', CP.Email)?.text, '65001');
  assert.equal(find(t, 'Read', CP.Email)?.text, '1');
  assert.equal(find(t, 'From', CP.Email)?.text, '"Alice Example" <alice@example.test>');
  assert.equal(find(t, 'ConversationId', CP.Email2)?.bytes?.length, 16);
  assert.equal(find(t, 'ConversationIndex', CP.Email2)?.bytes?.length, 5);
});

test('Sync Options are sticky: a Sync without Options reuses the last BodyPreference', async () => {
  assert.equal(body(await sync([[0, 0x22, '2'], PREF('4')])).type, '4');
  assert.ok(device.syncKeys['opts:inbox']);
  assert.equal(body(await sync(null)).type, '4');
  assert.equal(body(await sync([PREF('1')])).type, '1');
  // no Options ever → server default (plain text)
  device.syncKeys = {};
  assert.equal(body(await sync(null)).type, '1');
});

test('WindowSize and a Change without Read leaves the read state alone', async () => {
  await sync([PREF('1')], [[0, 0x15, '10'], [0, 0x16, [[0, 0x08, [[0, 0x0d, 'msg1'], [0, 0x1d, [[2, 0x3a]]]]]]]]);
  assert.equal(transactions, 0, 'a Flag-only Change must not mark the message unread');
  await sync([PREF('1')], [[0, 0x16, [[0, 0x08, [[0, 0x0d, 'msg1'], [0, 0x1d, [[2, 0x15, '0']]]]]]]]);
  assert.equal(transactions, 1);
});
