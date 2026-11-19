/**
 * w3: the Contacts class over ActiveSync against the in-memory Prisma fake — FolderSync (type 9,
 * webmail module policy), Sync both ways through the storage contact writer (vCard source of
 * truth, derived columns, CardDAV properties and values the device could not see survive a
 * device edit, a deleted contact leaves its groups), ClientId retries, no echo, normalised
 * items, GetItemEstimate, ItemOperations Fetch, MoveItems refused across classes, Ping, 12.1.
 * Run: node --import tsx --test src/pim/contacts-sync.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installFakeDb, clientWbxml, type WNode } from '../test-support/fake-db.js';

const NOW = new Date('2026-11-18T12:00:00Z');
const db = installFakeDb({
  user: [
    { id: 'u1', email: 'bob@example.com', displayName: 'Bob B', domainId: 'dom1', active: true },
    { id: 'u2', email: 'carol@example.com', displayName: 'Carol', domainId: 'dom1', active: true },
  ],
  emailAlias: [],
  userSettings: [{ userId: 'u1', preferences: { regional: { timeZone: 'Europe/Berlin' } } }],
  webmailPolicy: [],
  mailbox: [{ id: 'mb1', userId: 'u1', uidNext: 10, highestModSeq: 5n }],
  folder: [{ id: 'inbox', mailboxId: 'mb1', name: 'INBOX', displayName: 'Posteingang', parentId: null }],
  message: [], calendar: [], calendarEvent: [], task: [], note: [], contact: [], contactGroup: [],
  activeSyncDevice: [
    { id: 'd1', userId: 'u1', deviceId: 'dev1', status: 'OK', policyKey: '42', protocolVersion: '14.1', syncKeys: {} },
    { id: 'd12', userId: 'u1', deviceId: 'dev12', status: 'OK', policyKey: '42', protocolVersion: '12.1', syncKeys: {} },
  ],
  activeSyncItem: [],
});

const storage = await import('@coremail/storage');
const { handleSync } = await import('../commands/sync.js');
const { handleFolderSync } = await import('../commands/folder-sync.js');
const { handleGetItemEstimate } = await import('../commands/get-item-estimate.js');
const { handleMoveItems } = await import('../commands/move-items.js');
const { handleItemOperations, prismaItemOperationsDeps } = await import('../commands/item-operations.js');
const { handlePing } = await import('../commands/ping.js');
const { decodeWbxml, tagsNewerThan } = await import('../wbxml.js');
const { PICTURE_MAX_BYTES } = await import('./contacts-codec.js');
type E = import('../wbxml.js').WbxmlElement;
type V = '12.1' | '14.0' | '14.1';

const A = (t: number, k?: WNode[] | string): WNode => [0, t, k];
const Ct = (t: number, k?: WNode[] | string): WNode => [1, t, k];
const kid = (e: E | undefined, n: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === n);
const kids = (e: E | undefined, n: string): E[] => (e?.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === n);
const rows = (table: string) => db.tables[table]!;
const row = (table: string, id: string) => rows(table).find((r) => r['id'] === id);
const lines = (v: unknown): string[] => String(v).replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);

const BIG_PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(PICTURE_MAX_BYTES + 100, 1)]).toString('base64');
/** What a CardDAV client stored: more e-mails than slots, an X- property, a photo over the picture bound. */
const CARDDAV_VCARD = [
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:uid-c1', 'N:Muster;Erika;;;', 'FN:Erika Muster', 'ORG:Beispiel GmbH;Vertrieb;Nord',
  'item1.EMAIL;type=INTERNET;type=WORK;type=pref:erika@firma.example', 'item1.X-ABLabel:Büro',
  'EMAIL;type=INTERNET;type=HOME:erika@privat.example', 'EMAIL;type=INTERNET:e3@example.org', 'EMAIL;type=INTERNET:e4@example.org',
  'TEL;type=CELL:+49 170 1', 'TEL;type=WORK;type=VOICE:+49 30 2', 'X-CUSTOM:kept', `PHOTO;ENCODING=b;TYPE=JPEG:${BIG_PHOTO}`,
  'X-RELATED;TYPE=SPOUSE:Max Muster', 'RELATED;TYPE=spouse:urn:uuid:ref-1', 'X-RELATED;TYPE=CHILD:Lena', 'X-PHONETIC-FIRST-NAME:エリカ',
  'TEL;TYPE=X-MMS:+49 170 3',
  'END:VCARD', '',
].join('\r\n');
const contactRow = (id: string, userId: string, vcardData: string) => ({
  id, userId, vcardData, ...storage.contactRowData(storage.contactColumnsFromVcard(vcardData)), updatedAt: new Date('2026-11-01T00:00:00Z'),
});
rows('contact').push(
  contactRow('c1', 'u1', CARDDAV_VCARD),
  // stored before 9.5 without a vCard: read from the flat columns
  { id: 'c2', userId: 'u1', vcardData: '', uid: '', displayName: 'Alt Kontakt', email: 'alt@example.org', email2: '', phone: '+49 89 1', mobile: '',
    company: '', department: '', jobTitle: '', notes: 'alte Notiz', updatedAt: new Date('2026-11-01T00:00:00Z') },
  contactRow('cX', 'u2', 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:uid-x\r\nFN:Fremd\r\nN:Fremd;;;;\r\nEND:VCARD\r\n'),
);
const GROUP_VCARD = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:g1\r\nFN:Team\r\nN:Team\r\nX-ADDRESSBOOKSERVER-KIND:group\r\nX-ADDRESSBOOKSERVER-MEMBER:urn:uuid:uid-c1\r\nEND:VCARD\r\n';
rows('contactGroup').push({ id: 'g1', userId: 'u1', uid: 'g1', name: 'Team', vcardData: GROUP_VCARD, members: [{ kind: 'card', uid: 'uid-c1' }] });

interface SyncOpts { dev?: string; version?: V; commands?: WNode[]; extra?: WNode[] }
async function sync(key: string, o: SyncOpts = {}) {
  const version = o.version ?? '14.1';
  const col: WNode[] = [A(0x0b, key), A(0x12, 'contacts:default'), ...(o.extra ?? []), ...(o.commands?.length ? [A(0x16, o.commands)] : [])];
  const buf = await handleSync(decodeWbxml(clientWbxml(A(0x05, [A(0x1c, [A(0x0f, col)])]))), 'u1', o.dev ?? 'dev1', { now: () => NOW }, version);
  assert.deepEqual(tagsNewerThan(buf, version), [], `tags newer than ${version}`);
  const c = kid(kid(decodeWbxml(buf), 'Collections'), 'Collection')!;
  const cmds = kid(c, 'Commands');
  const ids = (n: string) => kids(cmds, n).map((x) => kid(x, 'ServerId')!.text!);
  return {
    cls: kid(c, 'Class')?.text, key: kid(c, 'SyncKey')!.text!, status: kid(c, 'Status')!.text!,
    adds: ids('Add'), changes: ids('Change'), deletes: ids('Delete'),
    data: (id: string) => kid([...kids(cmds, 'Add'), ...kids(cmds, 'Change')].find((x) => kid(x, 'ServerId')!.text === id), 'ApplicationData'),
    responses: [...kids(kid(c, 'Responses'), 'Add'), ...kids(kid(c, 'Responses'), 'Change'), ...kids(kid(c, 'Responses'), 'Delete')],
  };
}
/** Re-encode a received ApplicationData as the device's own Change data (page 1 / 12 / 17 elements). */
const asNodes = (data: E, replace: Record<string, string> = {}): WNode[] => (data.children ?? []).filter((c): c is E => typeof c !== 'string')
  .map((c) => [c.page ?? 0, tokenOf(c), c.children?.some((x) => typeof x !== 'string') ? asNodes(c) : (replace[c.name] ?? c.text ?? '')] as WNode);
const TOKENS: Record<number, Record<string, number>> = {
  12: { MMS: 0x0e },
  1: { Spouse: 0x34, YomiFirstName: 0x39, Children: 0x17, Child: 0x18,
    Email1Address: 0x1b, Email2Address: 0x1c, Email3Address: 0x1d, FileAs: 0x1e, FirstName: 0x1f, LastName: 0x29, CompanyName: 0x19,
    Department: 0x1a, MobilePhoneNumber: 0x2b, BusinessPhoneNumber: 0x13, Categories: 0x15, Category: 0x16, HomePhoneNumber: 0x27 },
  17: { Body: 0x0a, Type: 0x06, EstimatedDataSize: 0x0c, Truncated: 0x0d, Data: 0x0b },
};
const tokenOf = (e: E): number => { const t = TOKENS[e.page ?? 0]?.[e.name]; assert.ok(t, `token of ${e.name}`); return t; };

async function setPolicy(feature: string | null) {
  db.tables['webmailPolicy'] = feature ? [{ id: 'p1', domainId: 'dom1', userId: null, [feature]: 'OFF' }] : [];
  storage.invalidateWebmailPolicyCache();
}

test('FolderSync: the contacts folder (type 9) for 12.1 and 14.1; contacts module off → not announced, Sync Status 12', async () => {
  for (const [dev, version] of [['dev1', '14.1'], ['dev12', '12.1']] as const) {
    const t = decodeWbxml(await handleFolderSync(decodeWbxml(clientWbxml([7, 0x16, [[7, 0x12, '0']]])), 'u1', dev, version));
    const adds = kids(kid(t, 'Changes'), 'Add').map((a) => `${kid(a, 'ServerId')!.text}=${kid(a, 'DisplayName')!.text}/${kid(a, 'Type')!.text}`);
    assert.ok(adds.includes('contacts:default=Kontakte/9'), adds.join(', '));
  }
  await setPolicy('contacts');
  try {
    const t = decodeWbxml(await handleFolderSync(decodeWbxml(clientWbxml([7, 0x16, [[7, 0x12, '0']]])), 'u1', 'dev1', '14.1'));
    assert.ok(!kids(kid(t, 'Changes'), 'Add').some((a) => kid(a, 'ServerId')!.text === 'contacts:default'));
    assert.equal((await sync('0')).status, '12');
  } finally {
    await setPolicy(null);
  }
});

let key = '';
test('Sync: priming, then the own contacts as Adds — a CardDAV card (slots, no oversized picture) and a pre-9.5 row', async () => {
  const p = await sync('0');
  assert.deepEqual([p.cls, p.key, p.status, p.adds], ['Contacts', '1', '1', []]);
  const first = await sync('1');
  assert.deepEqual(first.adds.sort(), ['c1', 'c2'], 'not the other user\'s contact');
  const c1 = first.data('c1');
  assert.deepEqual(['Email1Address', 'Email2Address', 'Email3Address', 'MobilePhoneNumber', 'BusinessPhoneNumber', 'CompanyName', 'Department', 'FileAs']
    .map((n) => kid(c1, n)?.text), ['erika@firma.example', 'erika@privat.example', 'e3@example.org', '+49 170 1', '+49 30 2', 'Beispiel GmbH', 'Vertrieb', 'Muster, Erika']);
  assert.equal(kid(c1, 'Picture'), undefined, 'a photo over the bound is not sent');
  const c2 = first.data('c2');
  assert.deepEqual(['FirstName', 'LastName', 'Email1Address', 'CompanyMainPhone'].map((n) => kid(c2, n)?.text), ['Alt', 'Kontakt', 'alt@example.org', '+49 89 1']);
  assert.equal(kid(kid(c2, 'Body'), 'Data')?.text, 'alte Notiz');
  key = (await sync(first.key)).key;
});

test('device Change of the CardDAV card: only the values it saw change — 4th e-mail, X- property, labels, ORG unit, photo, groups survive; no echo', async () => {
  const first = await sync('0', { dev: 'dev12', version: '12.1' }); // a second device just to read the item
  const got = (await sync(first.key, { dev: 'dev12', version: '12.1' })).data('c1')!;
  assert.deepEqual(['Spouse', 'YomiFirstName', 'MMS'].map((n) => kid(got, n)?.text), ['Max Muster', 'エリカ', '+49 170 3']);
  assert.deepEqual(kids(kid(got, 'Children'), 'Child').map((c) => c.text), ['Lena']);
  const change = A(0x08, [A(0x0d, 'c1'), A(0x1d, asNodes(got, { Email1Address: 'erika@neu.example', FirstName: 'Erika-Maria', Spouse: 'Maximilian Muster' }))]);
  const r = await sync(key, { commands: [change] });
  assert.deepEqual([r.status, r.responses], ['1', []]);
  assert.deepEqual(r.changes, ['c1'], 'the derived FileAs changed with the name: the same response sends it');
  assert.equal(kid(r.data('c1'), 'FileAs')?.text, 'Muster, Erika-Maria');
  const stored = row('contact', 'c1')!;
  const vcard = lines(stored['vcardData']);
  assert.ok(vcard.includes('X-RELATED;TYPE=SPOUSE:Maximilian Muster'), 'the spouse changed in its line');
  for (const kept of ['X-CUSTOM:kept', 'item1.X-ABLabel:Büro', 'EMAIL;type=INTERNET:e4@example.org', 'ORG:Beispiel GmbH;Vertrieb;Nord', 'UID:uid-c1',
    'RELATED;TYPE=spouse:urn:uuid:ref-1', 'X-RELATED;TYPE=CHILD:Lena', 'X-PHONETIC-FIRST-NAME:エリカ', 'TEL;TYPE=X-MMS:+49 170 3']) {
    assert.ok(vcard.includes(kept), `lost ${kept}`);
  }
  assert.ok(vcard.includes('item1.EMAIL;type=INTERNET;type=WORK;type=pref:erika@neu.example'), 'the changed address keeps its line head');
  assert.ok(vcard.some((l) => l.startsWith('PHOTO;ENCODING=b;TYPE=JPEG:') && l.endsWith(BIG_PHOTO.slice(-20))), 'the hidden photo stays');
  assert.deepEqual([stored['email'], stored['givenName'], stored['displayName']], ['erika@neu.example', 'Erika-Maria', 'Erika-Maria Muster'], 'derived columns follow');
  assert.deepEqual((stored['emails'] as Array<{ value: string }>).map((e) => e.value), ['erika@neu.example', 'erika@privat.example', 'e3@example.org', 'e4@example.org']);
  assert.deepEqual(row('contactGroup', 'g1')!['members'], [{ kind: 'card', uid: 'uid-c1' }]);
  const next = await sync(r.key);
  assert.deepEqual([next.adds, next.changes, next.deletes], [[], [], []], 'no echo');
  key = next.key;
});

test('a phone that lists only some elements as Supported: its edit keeps spouse, children, Yomi names and the MMS number', async () => {
  rows('activeSyncDevice').push({ id: 'd3', userId: 'u1', deviceId: 'dev3', status: 'OK', policyKey: '42', protocolVersion: '14.1', syncKeys: {} });
  const p = await sync('0', { dev: 'dev3', extra: [A(0x20, [Ct(0x1f), Ct(0x29), Ct(0x1b)])] });
  const first = await sync(p.key, { dev: 'dev3' });
  assert.ok(first.adds.includes('c1'));
  const change = A(0x08, [A(0x0d, 'c1'), A(0x1d, [Ct(0x1f, 'Erika'), Ct(0x29, 'Muster'), Ct(0x1b, 'erika@ghost.example')])]);
  const r = await sync(first.key, { dev: 'dev3', commands: [change] });
  assert.equal(r.status, '1');
  const vcard = lines(row('contact', 'c1')!['vcardData']);
  assert.ok(vcard.some((l) => l.endsWith(':erika@ghost.example')), 'the Supported element changed');
  for (const kept of ['X-RELATED;TYPE=SPOUSE:Maximilian Muster', 'RELATED;TYPE=spouse:urn:uuid:ref-1', 'X-RELATED;TYPE=CHILD:Lena',
    'X-PHONETIC-FIRST-NAME:エリカ', 'TEL;TYPE=X-MMS:+49 170 3', 'TEL;type=CELL:+49 170 1']) {
    assert.ok(vcard.includes(kept), `lost ${kept}`);
  }
  key = (await sync(key)).key; // dev1 takes the change
});

let added = '';
test('device Add: a contact row with vCard + derived columns; a retry gets the same ServerId; a radio number keeps its slot (no echo)', async () => {
  const add = A(0x07, [A(0x0c, 'client-1'), A(0x1d, [Ct(0x1f, 'Alex'), Ct(0x29, 'Beispiel'), Ct(0x1b, 'alex@example.org'), Ct(0x33, '+49 40 9')])]);
  const r = await sync(key, { commands: [add] });
  added = kid(r.responses[0], 'ServerId')!.text!;
  assert.equal(kid(r.responses[0], 'Status')?.text, '1');
  const count = rows('contact').length;
  const retry = await sync(key, { commands: [add] });
  assert.equal(kid(retry.responses[0], 'ServerId')?.text, added);
  assert.equal(rows('contact').length, count, 'nothing created twice');
  const c = row('contact', added)!;
  assert.deepEqual([c['userId'], c['displayName'], c['email'], c['familyName'], c['phone']], ['u1', 'Alex Beispiel', 'alex@example.org', 'Beispiel', '+49 40 9']);
  assert.equal(storage.contactCardFromVcard(String(c['vcardData'])).emails[0]?.value, 'alex@example.org', 'the vCard is the source of truth');
  assert.ok(storage.vcardUidKey(String(c['vcardData'])), 'with a UID (groups reference it)');
  assert.ok(lines(c['vcardData']).includes('TEL;TYPE=X-RADIO,VOICE:+49 40 9'), 'the kind is kept in the vCard');
  assert.deepEqual(r.changes, [], 'shown as RadioPhoneNumber again: nothing to send back');
  const other = await sync((await sync('0', { dev: 'dev12', version: '12.1' })).key, { dev: 'dev12', version: '12.1' });
  assert.deepEqual(['RadioPhoneNumber', 'CompanyMainPhone'].map((n) => kid(other.data(added), n)?.text), ['+49 40 9', undefined], 'another device sees it in the same slot');
  const next = await sync(retry.key);
  assert.deepEqual(next.changes, []);
  key = next.key;
});

test('a change on the server (REST / CardDAV writer) reaches the device as a Change; a device Delete removes the contact from its groups', async () => {
  const c = row('contact', 'c1')!;
  await storage.updateContactRow('c1', String(c['vcardData']).replace('END:VCARD', 'TITLE:Leitung\r\nEND:VCARD'));
  const r = await sync(key);
  assert.deepEqual(r.changes, ['c1']);
  assert.equal(kid(r.data('c1'), 'JobTitle')?.text, 'Leitung');
  const d = await sync(r.key, { commands: [A(0x09, [A(0x0d, 'c1')])] });
  assert.equal(d.status, '1');
  assert.equal(row('contact', 'c1'), undefined);
  assert.deepEqual(row('contactGroup', 'g1')!['members'], [], 'the group lost its member');
  const unknown = await sync(d.key, { commands: [A(0x09, [A(0x0d, 'cX')])] });
  assert.equal(kid(unknown.responses[0], 'Status')?.text, '8', 'another user\'s contact is unknown');
  assert.ok(row('contact', 'cX'));
  key = unknown.key;
});

test('GetItemEstimate, ItemOperations Fetch (Class Contacts), MoveItems refused across classes', async () => {
  const gie = async (k: string) => {
    const req = [6, 0x05, [[6, 0x07, [[6, 0x08, [[0, 0x0b, k], [6, 0x0a, 'contacts:default']]]]]]] as WNode;
    const resp = kid(decodeWbxml(await handleGetItemEstimate(decodeWbxml(clientWbxml(req)), 'u1', 'dev1', () => NOW, '14.1')), 'Response')!;
    return `${kid(resp, 'Status')?.text}:${kid(kid(resp, 'Collection'), 'Estimate')?.text ?? '-'}`;
  };
  assert.equal(await gie(key), '1:0');
  await storage.createContactRow('u1', storage.buildContactVcard(storage.finalizeContactCard({ ...storage.emptyContactCard(), displayName: 'Neu' })));
  assert.equal(await gie(key), '1:1');
  const fetchReq = [20, 0x05, [[20, 0x06, [[20, 0x07, 'Mailbox'], [0, 0x12, 'contacts:default'], [0, 0x0d, added]]]]] as WNode;
  const f = kid(kid(decodeWbxml(await handleItemOperations(decodeWbxml(clientWbxml(fetchReq)), 'u1', prismaItemOperationsDeps(), '14.1')), 'Response'), 'Fetch')!;
  assert.deepEqual([kid(f, 'Status')?.text, kid(f, 'Class')?.text, kid(kid(f, 'Properties'), 'LastName')?.text], ['1', 'Contacts', 'Beispiel']);
  const move = async (src: string, dst: string) => {
    const req = [5, 0x05, [[5, 0x06, [[5, 0x07, added], [5, 0x08, src], [5, 0x09, dst]]]]] as WNode;
    return kid(kid(decodeWbxml(await handleMoveItems(decodeWbxml(clientWbxml(req)), 'u1', 'dev1', '14.1')), 'Response'), 'Status')?.text;
  };
  assert.equal(await move('contacts:default', 'tasks:default'), '2');
  assert.equal(await move('contacts:default', 'inbox'), '2');
  assert.equal(await move('inbox', 'contacts:default'), '2');
});

class FakeRes extends EventEmitter {
  statusCode = 0; body: Buffer | null = null; writableEnded = false; headers: Record<string, string> = {};
  set(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; }
  setHeader(k: string, v: string) { return this.set(k, v); }
  removeHeader(k: string) { delete this.headers[k.toLowerCase()]; }
  status(c: number) { this.statusCode = c; return this; }
  send(b: Buffer | string) { this.body = Buffer.isBuffer(b) ? b : Buffer.from(b); this.writableEnded = true; this.emit('finish'); return this; }
}

test('Ping: a contact written after the last Sync is reported for the contacts folder', async () => {
  const P = (t: number, k?: WNode[] | string): WNode => [13, t, k];
  // the last FolderSync of this device ran with the contacts module off: refresh the hierarchy first
  await handleFolderSync(decodeWbxml(clientWbxml([7, 0x16, [[7, 0x12, '0']]])), 'u1', 'dev1', '14.1');
  const res = new FakeRes();
  await handlePing(decodeWbxml(clientWbxml(P(0x05, [P(0x08, '1'), P(0x09, [P(0x0a, [P(0x0b, 'contacts:default'), P(0x0c, 'Contacts')])])]))),
    'u1', res as never, {}, { deviceId: 'dev1', pollIntervalMs: 5, minHeartbeatSec: 1, version: '14.1' });
  const t = decodeWbxml(res.body!);
  assert.deepEqual([kid(t, 'Status')?.text, kids(kid(t, 'Folders'), 'Folder').map((x) => x.text)], ['2', ['contacts:default']]);
});
