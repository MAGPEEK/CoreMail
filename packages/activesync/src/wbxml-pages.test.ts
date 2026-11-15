/**
 * WBXML code pages GetItemEstimate (6), AirSyncBase (17), ItemOperations (20) and
 * Email2 (22) per [MS-ASWBXML] (EAS 14.1), explicit-page encoding, and byte-exact
 * string / OPAQUE content (MIME bodies, binary ConversationId).
 * Run: node --import tsx --test src/wbxml-pages.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWbxml, decodeWbxml, el, pel, CP, type WbxmlElement } from './wbxml.js';
import { clientWbxml, find } from './commands/test-fixtures.js';

const hex = (b: Buffer) => b.toString('hex');
const kids = (e: WbxmlElement): WbxmlElement[] => (e.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');

// [MS-ASWBXML] 2.1.2.1 token tables (EAS 14.1)
const SPEC: Record<number, Record<number, string>> = {
  6: {
    0x05: 'GetItemEstimate', 0x06: 'Version', 0x07: 'Collections', 0x08: 'Collection', 0x09: 'Class',
    0x0a: 'CollectionId', 0x0b: 'DateTime', 0x0c: 'Estimate', 0x0d: 'Response', 0x0e: 'Status',
  },
  17: {
    0x05: 'BodyPreference', 0x06: 'Type', 0x07: 'TruncationSize', 0x08: 'AllOrNone', 0x0a: 'Body',
    0x0b: 'Data', 0x0c: 'EstimatedDataSize', 0x0d: 'Truncated', 0x0e: 'Attachments', 0x0f: 'Attachment',
    0x10: 'DisplayName', 0x11: 'FileReference', 0x12: 'Method', 0x13: 'ContentId', 0x14: 'ContentLocation',
    0x15: 'IsInline', 0x16: 'NativeBodyType', 0x17: 'ContentType', 0x18: 'Preview',
    0x19: 'BodyPartPreference', 0x1a: 'BodyPart', 0x1b: 'Status',
  },
  20: {
    0x05: 'ItemOperations', 0x06: 'Fetch', 0x07: 'Store', 0x08: 'Options', 0x09: 'Range', 0x0a: 'Total',
    0x0b: 'Properties', 0x0c: 'Data', 0x0d: 'Status', 0x0e: 'Response', 0x0f: 'Version', 0x10: 'Schema',
    0x11: 'Part', 0x12: 'EmptyFolderContents', 0x13: 'DeleteSubFolders', 0x14: 'UserName', 0x15: 'Password',
    0x16: 'Move', 0x17: 'DstFldId', 0x18: 'ConversationId', 0x19: 'MoveAlways',
  },
  22: {
    0x05: 'UmCallerID', 0x06: 'UmUserNotes', 0x07: 'UmAttDuration', 0x08: 'UmAttOrder', 0x09: 'ConversationId',
    0x0a: 'ConversationIndex', 0x0b: 'LastVerbExecuted', 0x0c: 'LastVerbExecutionTime', 0x0d: 'ReceivedAsBcc',
    0x0e: 'Sender', 0x0f: 'CalendarType', 0x10: 'IsLeapMonth', 0x11: 'AccountId', 0x12: 'FirstDayOfWeek',
    0x13: 'MeetingMessageType',
  },
};

test('code pages 6/17/20/22 are complete: every spec token encodes and decodes', () => {
  for (const [page, table] of Object.entries(SPEC)) {
    for (const [tok, name] of Object.entries(table)) {
      const buf = encodeWbxml(pel(Number(page), name));
      assert.equal(hex(buf), hex(Buffer.from([0x03, 0x01, 0x6a, 0x00, 0x00, Number(page), Number(tok)])), `${page}/${name}`);
      const back = decodeWbxml(buf);
      assert.equal(back.name, name);
      assert.equal(back.page, Number(page));
    }
  }
});

test('fixture: GetItemEstimate response bytes', () => {
  const G = CP.GetItemEstimate;
  const buf = encodeWbxml(pel(G, 'GetItemEstimate', [pel(G, 'Response', [
    pel(G, 'Status', '1'),
    pel(G, 'Collection', [pel(G, 'CollectionId', 'c1'), pel(G, 'Estimate', '7')]),
  ])]));
  assert.equal(hex(buf),
    '03016a00' + '0006' + '45' + '4d' + '4e03310001' + '48' + '4a0363310001' + '4c03370001' + '01' + '01' + '01');
  const back = decodeWbxml(buf);
  assert.equal(find(back, 'Estimate')?.text, '7');
});

test('fixture: ItemOperations attachment Fetch response bytes (FileReference/ContentType on page 17)', () => {
  const I = CP.ItemOperations, A = CP.AirSyncBase;
  const buf = encodeWbxml(pel(I, 'ItemOperations', [
    pel(I, 'Status', '1'),
    pel(I, 'Response', [pel(I, 'Fetch', [
      pel(I, 'Status', '1'),
      pel(A, 'FileReference', 'a'),
      pel(I, 'Properties', [pel(A, 'ContentType', 'x'), pel(I, 'Data', 'QQ==')]),
    ])]),
  ]));
  assert.equal(hex(buf),
    '03016a00' + '0014' + '45' + '4d03310001' + '4e' + '46' + '4d03310001' +
    '0011' + '5103610001' + '0014' + '4b' + '0011' + '5703780001' + '0014' + '4c0351513d3d0001' +
    '01' + '01' + '01' + '01');
});

test('fixture: AirSyncBase Body with raw MIME octets + Email2 opaque ConversationId', () => {
  const buf = encodeWbxml(el('ApplicationData', undefined, [
    pel(CP.AirSyncBase, 'Body', [
      pel(CP.AirSyncBase, 'Type', '4'),
      pel(CP.AirSyncBase, 'EstimatedDataSize', '3'),
      pel(CP.AirSyncBase, 'Truncated', '0'),
      pel(CP.AirSyncBase, 'Data', Buffer.from([0x41, 0xe9, 0x42])),
    ]),
    pel(CP.Email2, 'ConversationId', Buffer.from([0x00, 0x01, 0x02]), { opaque: true }),
  ]));
  assert.equal(hex(buf),
    '03016a00' + '0000' + '5d' + '0011' + '4a' + '4603340001' + '4c03330001' + '4d03300001' + '4b0341e9420001' + '01' +
    '0016' + '49c303000102' + '01' + '01');
  const back = decodeWbxml(buf);
  const data = find(back, 'Data', CP.AirSyncBase)!;
  assert.deepEqual(data.bytes, Buffer.from([0x41, 0xe9, 0x42]), 'non-UTF-8 octets survive');
  assert.deepEqual(find(back, 'ConversationId', CP.Email2)!.bytes, Buffer.from([0, 1, 2]));
  assert.equal(find(back, 'Body')!.page, CP.AirSyncBase);
});

test('content with NUL is written as OPAQUE, never as a truncated inline string', () => {
  const data = Buffer.from([0x61, 0x00, 0x62]);
  const buf = encodeWbxml(pel(CP.AirSyncBase, 'Data', data));
  assert.equal(hex(buf), '03016a000011' + '4b' + 'c303610062' + '01');
  assert.deepEqual(decodeWbxml(buf).bytes, data);
});

test('explicit page beats the parent-page / lowest-page resolution', () => {
  // Without a page, Body under ApplicationData would resolve to the EAS 2.5 Email:Body (page 2)
  const legacy = encodeWbxml(el('ApplicationData', undefined, [el('Body', 'x')]));
  assert.ok(hex(legacy).includes('00024c'), hex(legacy));
  const asb = encodeWbxml(el('ApplicationData', undefined, [pel(CP.AirSyncBase, 'Body', [pel(CP.AirSyncBase, 'Type', '1')])]));
  assert.ok(hex(asb).includes('00114a46'), hex(asb));
  assert.throws(() => encodeWbxml(pel(CP.Email2, 'Body')), /on page 22/);
});

test('decodes spec-encoded client requests: ItemOperations Fetch, GetItemEstimate, Sync Options', () => {
  const io = decodeWbxml(clientWbxml([20, 0x05, [
    [20, 0x06, [[20, 0x07, 'Mailbox'], [17, 0x11, 'att-pdf'], [20, 0x08, [[20, 0x09, '0-3']]]]],
    [20, 0x06, [[20, 0x07, 'Mailbox'], [0, 0x12, 'inbox'], [0, 0x0d, 'msg1'],
      [20, 0x08, [[0, 0x22, '2'], [17, 0x05, [[17, 0x06, '4']]]]]]],
    [20, 0x12, [[0, 0x12, 'trash'], [20, 0x08, [[20, 0x13]]]]],
  ]]));
  assert.equal(io.name, 'ItemOperations');
  assert.deepEqual(kids(io).map((c) => c.name), ['Fetch', 'Fetch', 'EmptyFolderContents']);
  assert.deepEqual(kids(kids(io)[0]!).map((c) => c.name), ['Store', 'FileReference', 'Options']);
  assert.equal(find(kids(io)[0]!, 'Range')?.text, '0-3');
  assert.deepEqual(kids(kids(io)[1]!).map((c) => c.name), ['Store', 'CollectionId', 'ServerId', 'Options']);
  assert.equal(find(kids(io)[2]!, 'DeleteSubFolders')?.page, 20);

  const gie = decodeWbxml(clientWbxml([6, 0x05, [[6, 0x07, [[6, 0x08, [[0, 0x0b, '5'], [6, 0x0a, 'inbox'], [0, 0x17, [[0, 0x18, '0']]]]]]]]]));
  const col = find(gie, 'Collection')!;
  assert.deepEqual(kids(col).map((c) => [c.name, c.page]), [['SyncKey', 0], ['CollectionId', 6], ['Options', 0]]);
});
