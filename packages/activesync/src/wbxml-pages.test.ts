/**
 * WBXML code pages Move (5), MeetingResponse (8), ResolveRecipients (10),
 * Search (15), GAL (16) and Settings (18) per [MS-ASWBXML] 2.1.2.1 (EAS 14.1):
 * every token encodes to the spec byte on its own page and decodes back to the
 * same name, plus parent-page resolution of shared names in real responses.
 * Run: node --import tsx --test src/wbxml-pages.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWbxml, encodeWbxml, el } from './wbxml.js';
import { wbxmlTags } from './test-support/fake-db.js';

/** [MS-ASWBXML] token tables (transcribed independently of wbxml.ts). */
const SPEC: Record<string, [number, Record<string, number>]> = {
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

for (const [ns, [page, tokens]] of Object.entries(SPEC)) {
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
