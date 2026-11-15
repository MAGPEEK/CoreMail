/**
 * Settings command: Oof Get/Set on UserSettings.oof* (the MWA fields),
 * DeviceInformation Set, UserInformation Get (primary + aliases),
 * RightsManagementInformation Get.
 * Run: node --import tsx --test src/commands/settings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, clientWbxml, type WNode } from '../test-support/fake-db.js';

const db = installFakeDb({
  user: [{ id: 'u1', email: 'Alice@Example.com', displayName: 'Alice A', domainId: 'd1' }],
  emailAlias: [
    { id: 'a1', address: 'info@example.com', targetUserId: 'u1', active: true },
    { id: 'a2', address: 'old@example.com', targetUserId: 'u1', active: false },
    { id: 'a3', address: 'bob@example.com', targetUserId: 'u2', active: true },
  ],
  userSettings: [],
  activeSyncDevice: [{ id: 'dev', userId: 'u1', deviceId: 'D1', deviceFriendlyName: '' }],
});

const { handleSettings } = await import('./settings.js');
const { decodeWbxml } = await import('../wbxml.js');
type E = import('../wbxml.js').WbxmlElement;

const S = (t: number, k?: WNode[] | string): WNode => [18, t, k];
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
const all = (e: E | undefined, name: string): E[] => (e?.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === name);

async function run(req: WNode, version = '14.1'): Promise<E> {
  return decodeWbxml(await handleSettings(decodeWbxml(clientWbxml(req)), 'u1', 'D1', version));
}

const oofGet = (bodyType = 'Text') => S(0x05, [S(0x09, [S(0x07, [S(0x13, bodyType)])])]);

test('Oof Get without stored settings → state 0, defaults', async () => {
  const res = await run(oofGet());
  assert.equal(kid(res, 'Status')?.text, '1');
  const get = kid(kid(res, 'Oof'), 'Get');
  assert.equal(kid(get, 'OofState')?.text, '0');
  assert.equal(all(get, 'OofMessage').length, 3);
});

test('Oof Set (time based) → MWA fields; Get returns the same values', async () => {
  const set = S(0x05, [S(0x09, [S(0x08, [
    S(0x0a, '2'), S(0x0b, '2026-12-20T08:00:00.000Z'), S(0x0c, '2027-01-06T18:00:00.000Z'),
    S(0x0d, [S(0x0e), S(0x11, '1'), S(0x12, 'Back on Jan 6'), S(0x13, 'Text')]),
    S(0x0d, [S(0x0f), S(0x11, '1'), S(0x12, 'Out of office'), S(0x13, 'Text')]),
    S(0x0d, [S(0x10), S(0x11, '0'), S(0x13, 'Text')]),
  ])])]);
  const res = await run(set);
  assert.equal(kid(kid(res, 'Oof'), 'Status')?.text, '1');
  const row = db.tables['userSettings']![0]!;
  assert.equal(row['userId'], 'u1');
  assert.equal(row['oofEnabled'], true);
  assert.equal(row['oofUseTimeRange'], true);
  assert.equal((row['oofStart'] as Date).toISOString(), '2026-12-20T08:00:00.000Z');
  assert.equal((row['oofEnd'] as Date).toISOString(), '2027-01-06T18:00:00.000Z');
  assert.equal(row['oofInternal'], 'Back on Jan 6');
  assert.equal(row['oofExternal'], 'Out of office');
  assert.equal(row['oofExternalEnabled'], true);
  assert.equal(row['oofExternalOnlyContacts'], true); // known on, unknown off

  const get = kid(kid(await run(oofGet()), 'Oof'), 'Get');
  assert.equal(kid(get, 'OofState')?.text, '2');
  assert.equal(kid(get, 'StartTime')?.text, '2026-12-20T08:00:00.000Z');
  assert.equal(kid(get, 'EndTime')?.text, '2027-01-06T18:00:00.000Z');
  const msgs = all(get, 'OofMessage');
  const byKind = (k: string) => msgs.find((m) => kid(m, k))!;
  assert.equal(kid(byKind('AppliesToInternal'), 'ReplyMessage')?.text, 'Back on Jan 6');
  assert.equal(kid(byKind('AppliesToExternalKnown'), 'Enabled')?.text, '1');
  assert.equal(kid(byKind('AppliesToExternalUnknown'), 'Enabled')?.text, '0');
});

test('Oof written by the MWA (HTML) is returned as text or HTML on request', async () => {
  const row = db.tables['userSettings']![0]!;
  Object.assign(row, { oofEnabled: true, oofUseTimeRange: false, oofInternal: '<p>Hello<br>team</p>', oofExternal: '', oofExternalEnabled: false });
  const text = kid(kid(await run(oofGet('Text')), 'Oof'), 'Get');
  assert.equal(kid(text, 'OofState')?.text, '1');
  assert.equal(kid(text, 'StartTime'), undefined);
  const internal = all(text, 'OofMessage').find((m) => kid(m, 'AppliesToInternal'))!;
  assert.equal(kid(internal, 'ReplyMessage')?.text, 'Hello\nteam');
  const html = kid(kid(await run(oofGet('HTML')), 'Oof'), 'Get');
  const internalHtml = all(html, 'OofMessage').find((m) => kid(m, 'AppliesToInternal'))!;
  assert.equal(kid(internalHtml, 'ReplyMessage')?.text, '<p>Hello<br>team</p>');
  assert.equal(kid(internalHtml, 'BodyType')?.text, 'HTML');
  const unknown = all(html, 'OofMessage').find((m) => kid(m, 'AppliesToExternalUnknown'))!;
  assert.equal(kid(unknown, 'Enabled')?.text, '0');
});

test('Oof Set state 0 disables but keeps texts; state 2 without times → Status 2', async () => {
  await run(S(0x05, [S(0x09, [S(0x08, [S(0x0a, '0')])])]));
  const row = db.tables['userSettings']![0]!;
  assert.equal(row['oofEnabled'], false);
  assert.equal(row['oofInternal'], '<p>Hello<br>team</p>');
  const bad = await run(S(0x05, [S(0x09, [S(0x08, [S(0x0a, '2')])])]));
  assert.equal(kid(kid(bad, 'Oof'), 'Status')?.text, '2');
  assert.equal(row['oofEnabled'], false);
});

test('DeviceInformation Set stores the friendly name on the own device only', async () => {
  const res = await run(S(0x05, [S(0x16, [S(0x08, [S(0x17, 'iPhone15,2'), S(0x19, "Alice's iPhone"), S(0x1a, 'iOS 18.1'), S(0x20, 'Apple-iPhone/2201')])])]));
  assert.equal(kid(kid(res, 'DeviceInformation'), 'Status')?.text, '1');
  assert.equal(db.tables['activeSyncDevice']![0]!['deviceFriendlyName'], "Alice's iPhone");
  const call = db.calls.find((c) => c.model === 'activeSyncDevice' && c.op === 'updateMany')!;
  assert.deepEqual(call.args['where'], { userId: 'u1', deviceId: 'D1' });
});

test('UserInformation Get: 14.1 Accounts form with primary + active aliases', async () => {
  const res = await run(S(0x05, [S(0x1d, [S(0x07)])]));
  const ui = kid(res, 'UserInformation');
  assert.equal(kid(ui, 'Status')?.text, '1');
  const account = kid(kid(kid(ui, 'Get'), 'Accounts'), 'Account');
  assert.equal(kid(account, 'UserDisplayName')?.text, 'Alice A');
  const addrs = kid(account, 'EmailAddresses');
  assert.equal(kid(addrs, 'PrimarySmtpAddress')?.text, 'alice@example.com');
  assert.deepEqual(all(addrs, 'SmtpAddress').map((a) => a.text), ['info@example.com']);
});

test('UserInformation Get: 14.0 EmailAddresses/SmtpAddress form', async () => {
  const res = await run(S(0x05, [S(0x1d, [S(0x07)])]), '14.0');
  const addrs = kid(kid(kid(res, 'UserInformation'), 'Get'), 'EmailAddresses');
  assert.deepEqual(all(addrs, 'SmtpAddress').map((a) => a.text), ['alice@example.com', 'info@example.com']);
});

test('RightsManagementInformation Get → Status 1, empty Get; byte fixture of the response', async () => {
  const buf = await handleSettings(decodeWbxml(clientWbxml(S(0x05, [S(0x2b, [S(0x07)])]))), 'u1', 'D1');
  assert.deepEqual([...buf], [
    0x03, 0x01, 0x6a, 0x00, 0x00, 18,
    0x45, 0x46, 0x03, 0x31, 0x00, 0x01, // Settings > Status 1
    0x6b, 0x46, 0x03, 0x31, 0x00, 0x01, 0x07, 0x01, // RightsManagementInformation > Status 1, Get
    0x01,
  ]);
});
