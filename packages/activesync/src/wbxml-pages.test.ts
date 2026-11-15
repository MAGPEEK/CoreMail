/**
 * WBXML code pages per [MS-ASWBXML] 2.1.2.1 (EAS 14.1):
 *  - GetItemEstimate (6), AirSyncBase (17), ItemOperations (20), Email2 (22):
 *    explicit-page encoding (`pel`) and byte-exact string / OPAQUE content
 *    (MIME bodies, binary ConversationId);
 *  - Move (5), MeetingResponse (8), ResolveRecipients (10), Search (15), GAL (16),
 *    Settings (18): every token encodes to the spec byte on its own page via a
 *    qualified `Namespace:Name` and decodes back, plus parent-page resolution of
 *    shared names in real responses;
 *  - both page-pinning mechanisms coexist and agree.
 * Run: node --import tsx --test src/wbxml-pages.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWbxml, decodeWbxml, el, pel, CP, type WbxmlElement } from './wbxml.js';
import { clientWbxml, find } from './commands/test-fixtures.js';
import { wbxmlTags } from './test-support/fake-db.js';

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

/** [MS-ASWBXML] token tables (transcribed independently of wbxml.ts). */
const SPEC_NS: Record<string, [number, Record<string, number>]> = {
  Move: [5, {
    MoveItems: 0x05, Move: 0x06, SrcMsgId: 0x07, SrcFldId: 0x08, DstFldId: 0x09,
    Response: 0x0a, Status: 0x0b, DstMsgId: 0x0c,
  }],
  MeetingResponse: [8, {
    CalendarId: 0x05, CollectionId: 0x06, MeetingResponse: 0x07, RequestId: 0x08, Request: 0x09,
    Result: 0x0a, Status: 0x0b, UserResponse: 0x0c, InstanceId: 0x0e,
    ProposedStartTime: 0x10, ProposedEndTime: 0x11, SendResponse: 0x12,
  }],
  ResolveRecipients: [10, {
    ResolveRecipients: 0x05, Response: 0x06, Status: 0x07, Type: 0x08, Recipient: 0x09,
    DisplayName: 0x0a, EmailAddress: 0x0b, Certificates: 0x0c, Certificate: 0x0d,
    MiniCertificate: 0x0e, Options: 0x0f, To: 0x10, CertificateRetrieval: 0x11,
    RecipientCount: 0x12, MaxCertificates: 0x13, MaxAmbiguousRecipients: 0x14,
    CertificateCount: 0x15, Availability: 0x16, StartTime: 0x17, EndTime: 0x18,
    MergedFreeBusy: 0x19, Picture: 0x1a, MaxSize: 0x1b, Data: 0x1c, MaxPictures: 0x1d,
  }],
  Search: [15, {
    Search: 0x05, Store: 0x07, Name: 0x08, Query: 0x09, Options: 0x0a, Range: 0x0b,
    Status: 0x0c, Response: 0x0d, Result: 0x0e, Properties: 0x0f, Total: 0x10,
    EqualTo: 0x11, Value: 0x12, And: 0x13, Or: 0x14, FreeText: 0x15, DeepTraversal: 0x17,
    LongId: 0x18, RebuildResults: 0x19, LessThan: 0x1a, GreaterThan: 0x1b,
    UserName: 0x1e, Password: 0x1f, ConversationId: 0x20, Picture: 0x21, MaxSize: 0x22, MaxPictures: 0x23,
  }],
  GAL: [16, {
    DisplayName: 0x05, Phone: 0x06, Office: 0x07, Title: 0x08, Company: 0x09, Alias: 0x0a,
    FirstName: 0x0b, LastName: 0x0c, HomePhone: 0x0d, MobilePhone: 0x0e, EmailAddress: 0x0f,
    Picture: 0x10, Status: 0x11, Data: 0x12,
  }],
  Settings: [18, {
    Settings: 0x05, Status: 0x06, Get: 0x07, Set: 0x08, Oof: 0x09, OofState: 0x0a,
    StartTime: 0x0b, EndTime: 0x0c, OofMessage: 0x0d, AppliesToInternal: 0x0e,
    AppliesToExternalKnown: 0x0f, AppliesToExternalUnknown: 0x10, Enabled: 0x11,
    ReplyMessage: 0x12, BodyType: 0x13, DevicePassword: 0x14, Password: 0x15,
    DeviceInformation: 0x16, Model: 0x17, IMEI: 0x18, FriendlyName: 0x19, OS: 0x1a,
    OSLanguage: 0x1b, PhoneNumber: 0x1c, UserInformation: 0x1d, EmailAddresses: 0x1e,
    SmtpAddress: 0x1f, UserAgent: 0x20, EnableOutboundSMS: 0x21, MobileOperator: 0x22,
    PrimarySmtpAddress: 0x23, Accounts: 0x24, Account: 0x25, AccountId: 0x26,
    AccountName: 0x27, UserDisplayName: 0x28, SendDisabled: 0x29, RightsManagementInformation: 0x2b,
  }],
};

const HEADER = [0x03, 0x01, 0x6a, 0x00];

for (const [ns, [page, tokens]] of Object.entries(SPEC_NS)) {
  test(`${ns} (page ${page}): every token round-trips byte-exactly`, () => {
    for (const [name, token] of Object.entries(tokens)) {
      const bytes = Buffer.from([...HEADER, 0x00, page, token | 0x40, 0x03, 0x78, 0x00, 0x01]);
      assert.deepEqual(encodeWbxml(el(`${ns}:${name}`, 'x')), bytes, `encode ${ns}:${name}`);
      const back = decodeWbxml(bytes);
      assert.equal(back.name, name, `decode ${page}/0x${token.toString(16)}`);
      assert.equal(back.text, 'x');
      // empty element: no content bit
      assert.deepEqual(encodeWbxml(el(`${ns}:${name}`)), Buffer.from([...HEADER, 0x00, page, token]));
    }
  });
}

test('qualified names reject unknown namespaces and names', () => {
  assert.throws(() => encodeWbxml(el('Nope:Status', '1')), /Unknown EAS element/);
  assert.throws(() => encodeWbxml(el('GAL:Subject', '1')), /Unknown EAS element/);
});

test('MoveItems response: all tags on page 5', () => {
  const buf = encodeWbxml(el('MoveItems', undefined, [el('Response', undefined, [
    el('SrcMsgId', 'm1'), el('Status', '3'), el('DstMsgId', 'm1'),
  ])]));
  assert.deepEqual(wbxmlTags(buf), [[5, 0x05], [5, 0x0a], [5, 0x07], [5, 0x0b], [5, 0x0c]]);
});

test('Settings response: Status/Get/StartTime on page 18 (not AirSync/Email)', () => {
  const buf = encodeWbxml(el('Settings', undefined, [el('Status', '1'), el('Oof', undefined, [
    el('Status', '1'), el('Get', undefined, [el('OofState', '2'), el('StartTime', 'a'), el('EndTime', 'b'),
      el('OofMessage', undefined, [el('AppliesToInternal'), el('Enabled', '1'), el('ReplyMessage', 'r'), el('BodyType', 'Text')])]),
  ])]));
  assert.ok(wbxmlTags(buf).every(([p]) => p === 18), JSON.stringify(wbxmlTags(buf)));
});

test('Search GAL response: Search page wraps GAL properties on page 16', () => {
  const buf = encodeWbxml(el('Search', undefined, [el('Status', '1'), el('Response', undefined, [el('Store', undefined, [
    el('Status', '1'),
    el('Result', undefined, [el('Properties', undefined, [el('GAL:DisplayName', 'A'), el('GAL:EmailAddress', 'a@x')])]),
    el('Range', '0-0'), el('Total', '1'),
  ])])]));
  assert.deepEqual(wbxmlTags(buf), [
    [15, 0x05], [15, 0x0c], [15, 0x0d], [15, 0x07], [15, 0x0c], [15, 0x0e], [15, 0x0f],
    [16, 0x05], [16, 0x0f], [15, 0x0b], [15, 0x10],
  ]);
});

test('Search mailbox result: Class/CollectionId on AirSync, Body on AirSyncBase, Subject on Email', () => {
  const inStore = encodeWbxml(el('Store', undefined, [el('Result', undefined, [
    el('Class', 'Email'), el('LongId', 'm1'), el('CollectionId', 'f1'),
    el('Properties', undefined, [el('Subject', 's'), el('AirSyncBase:Body', undefined, [el('Type', '1'), el('Data', 'd')])]),
  ])]));
  assert.deepEqual(wbxmlTags(inStore), [
    [15, 0x07], [15, 0x0e], [0, 0x10], [15, 0x18], [0, 0x12], [15, 0x0f], [2, 0x14], [17, 0x0a], [17, 0x06], [17, 0x0b],
  ]);
});

test('ResolveRecipients / MeetingResponse responses stay on their pages', () => {
  const rr = encodeWbxml(el('ResolveRecipients', undefined, [el('Status', '1'), el('Response', undefined, [
    el('To', 'a'), el('Status', '1'), el('RecipientCount', '1'),
    el('Recipient', undefined, [el('Type', '1'), el('DisplayName', 'A'), el('EmailAddress', 'a@x'),
      el('Availability', undefined, [el('Status', '163')]),
      el('Certificates', undefined, [el('Status', '7'), el('CertificateCount', '0')])]),
  ])]));
  assert.ok(wbxmlTags(rr).every(([p]) => p === 10), JSON.stringify(wbxmlTags(rr)));
  const mr = encodeWbxml(el('MeetingResponse', undefined, [el('Result', undefined, [el('RequestId', 'r'), el('Status', '1'), el('CalendarId', 'c')])]));
  assert.deepEqual(wbxmlTags(mr), [[8, 0x07], [8, 0x0a], [8, 0x08], [8, 0x0b], [8, 0x05]]);
});

// ─── Both page-pinning mechanisms coexist ─────────────────────────────────────

test('explicit page and Namespace:Name produce identical bytes for every namespace', () => {
  for (const [ns, page] of Object.entries(CP)) {
    const table: Record<number, string> = { ...(SPEC[page] ?? {}), ...Object.fromEntries(Object.entries(SPEC_NS[ns]?.[1] ?? {}).map(([n, t]) => [t, n])) };
    for (const name of Object.values(table)) {
      assert.equal(hex(encodeWbxml(el(`${ns}:${name}`, 'x'))), hex(encodeWbxml(pel(page, name, 'x'))), `${ns}:${name}`);
    }
  }
});

test('qualified names work for the 14.1 body pages, and pel accepts a matching qualified name', () => {
  assert.equal(hex(encodeWbxml(el('GetItemEstimate:Estimate', '7'))), '03016a000006' + '4c03370001');
  assert.equal(hex(encodeWbxml(el('Email2:ConversationId', 'c'))), '03016a000016' + '4903630001');
  assert.equal(hex(encodeWbxml(pel(CP.AirSyncBase, 'AirSyncBase:Body'))), '03016a000011' + '0a');
  assert.throws(() => encodeWbxml(pel(CP.AirSyncBase, 'Email:Body')), /on page 17/);
});

test('mixed tree: Search result with qualified GAL names next to pel-pinned AirSyncBase body', () => {
  const buf = encodeWbxml(el('Search:Properties', undefined, [
    el('GAL:DisplayName', 'A'),
    pel(CP.AirSyncBase, 'Body', [pel(CP.AirSyncBase, 'Type', '1'), pel(CP.AirSyncBase, 'Data', Buffer.from('d'))]),
  ]));
  assert.deepEqual(wbxmlTags(buf), [[15, 0x0f], [16, 0x05], [17, 0x0a], [17, 0x06], [17, 0x0b]]);
  const back = decodeWbxml(buf);
  assert.equal(find(back, 'DisplayName')?.page, CP.GAL);
  assert.equal(find(back, 'Data', CP.AirSyncBase)?.text, 'd');
});