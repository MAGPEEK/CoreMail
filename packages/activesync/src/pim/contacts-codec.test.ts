/**
 * w3: Contacts class codec ([MS-ASCNTC], code pages 1 Contacts and 12 Contacts2) — the code
 * page token tables, byte fixtures of a server contact, client items written with the
 * [MS-ASWBXML] tokens, the mapping round trip (card → Sync item → device echo → unchanged
 * card), the fixed-slot overflow rules (values the device could not see survive its edits),
 * ghosting, dates, pictures and the derived "file as" / display name.
 * Run: node --import tsx --test src/pim/contacts-codec.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyContactCard, finalizeContactCard, sameContactCard, type ContactCard } from '@coremail/storage/contact-card';
import { clientWbxml, type WNode } from '../test-support/fake-db.js';
import { decodeWbxml, encodeWbxml, el, pel, tagsNewerThan, type WbxmlElement } from '../wbxml.js';
import { DEFAULT_BODY_PREFERENCE } from '../commands/body.js';
import {
  contactChange, emailOf, formatContactDate, parseContactDate, parsePicture, renderContact, EMPTY_CONTACT, PICTURE_MAX_BYTES,
} from './contacts-codec.js';
import { contactView, type ContactItem } from './contacts-view.js';
import type { PimUser, RenderContext, WriteContext } from './types.js';

const USER: PimUser = { id: 'u1', email: 'bob@example.com', displayName: 'Bob', addresses: ['bob@example.com'], timeZone: 'Europe/Berlin', domainId: null };
const UTC_USER: PimUser = { ...USER, timeZone: null };
const render = (version: '12.1' | '14.1' = '14.1', user = USER): RenderContext => ({ version, bodyPref: DEFAULT_BODY_PREFERENCE, user });
const write = (over: Partial<WriteContext> = {}): WriteContext => ({ version: '14.1', user: USER, now: new Date('2026-11-18T12:00:00Z'), supported: null, ...over });
const s = (t: string) => [0x03, ...Buffer.from(t), 0x00, 0x01];
const appData = (children: WNode[]): WbxmlElement => decodeWbxml(clientWbxml([0, 0x1d, children]));
const kid = (e: WbxmlElement | undefined, n: string) => e?.children?.find((c): c is WbxmlElement => typeof c !== 'string' && c.name === n);
const Ct = (t: number, k?: WNode[] | string): WNode => [1, t, k];
const C2 = (t: number, k?: WNode[] | string): WNode => [12, t, k];
const B = (t: number, k?: WNode[] | string): WNode => [17, t, k];
const card = (over: Partial<ContactCard>): ContactCard => finalizeContactCard({ ...emptyContactCard(), ...over });
const item = (over: Partial<ContactCard>, extra: Partial<ContactItem> = {}): ContactItem => ({ card: card(over), officeLocation: '', picture: '', ...extra });
/** The Sync item the device got, decoded the way the device sends it back. */
const echo = (it: ContactItem, user = USER): WbxmlElement => decodeWbxml(encodeWbxml(el('ApplicationData', undefined, renderContact(it, render('14.1', user)))));
const JPEG = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 7)]);

// [MS-ASWBXML] 2.1.2.1.2 (Contacts, without the 2.5-only body tokens and the 16.0 Alias / WeightedRank) and 2.1.2.1.13 (Contacts2)
const SPEC: Record<number, Record<number, string>> = {
  1: {
    0x05: 'Anniversary', 0x06: 'AssistantName', 0x07: 'AssistantPhoneNumber', 0x08: 'Birthday', 0x0c: 'Business2PhoneNumber',
    0x0d: 'BusinessAddressCity', 0x0e: 'BusinessAddressCountry', 0x0f: 'BusinessAddressPostalCode', 0x10: 'BusinessAddressState',
    0x11: 'BusinessAddressStreet', 0x12: 'BusinessFaxNumber', 0x13: 'BusinessPhoneNumber', 0x14: 'CarPhoneNumber',
    0x15: 'Categories', 0x16: 'Category', 0x17: 'Children', 0x18: 'Child', 0x19: 'CompanyName', 0x1a: 'Department',
    0x1b: 'Email1Address', 0x1c: 'Email2Address', 0x1d: 'Email3Address', 0x1e: 'FileAs', 0x1f: 'FirstName',
    0x20: 'Home2PhoneNumber', 0x21: 'HomeAddressCity', 0x22: 'HomeAddressCountry', 0x23: 'HomeAddressPostalCode',
    0x24: 'HomeAddressState', 0x25: 'HomeAddressStreet', 0x26: 'HomeFaxNumber', 0x27: 'HomePhoneNumber', 0x28: 'JobTitle',
    0x29: 'LastName', 0x2a: 'MiddleName', 0x2b: 'MobilePhoneNumber', 0x2c: 'OfficeLocation', 0x2d: 'OtherAddressCity',
    0x2e: 'OtherAddressCountry', 0x2f: 'OtherAddressPostalCode', 0x30: 'OtherAddressState', 0x31: 'OtherAddressStreet',
    0x32: 'PagerNumber', 0x33: 'RadioPhoneNumber', 0x34: 'Spouse', 0x35: 'Suffix', 0x36: 'Title', 0x37: 'WebPage',
    0x38: 'YomiCompanyName', 0x39: 'YomiFirstName', 0x3a: 'YomiLastName', 0x3c: 'Picture',
  },
  12: {
    0x05: 'CustomerId', 0x06: 'GovernmentId', 0x07: 'IMAddress', 0x08: 'IMAddress2', 0x09: 'IMAddress3',
    0x0a: 'ManagerName', 0x0b: 'CompanyMainPhone', 0x0c: 'AccountName', 0x0d: 'NickName', 0x0e: 'MMS',
  },
};

test('code pages 1 (Contacts) and 12 (Contacts2): every token encodes on its page and decodes back; all exist in 12.1', () => {
  for (const [page, table] of Object.entries(SPEC)) {
    for (const [tok, name] of Object.entries(table)) {
      const buf = encodeWbxml(pel(Number(page), name));
      assert.deepEqual([...buf], [0x03, 0x01, 0x6a, 0x00, 0x00, Number(page), Number(tok)], `${page}/${name}`);
      const back = decodeWbxml(buf);
      assert.deepEqual([back.name, back.page], [name, Number(page)]);
      assert.deepEqual(tagsNewerThan(buf, '12.1'), [], `${name} is a 12.1 token`);
    }
  }
});

const BODY_EMPTY = [0x00, 0x11, 0x4a, 0x46, ...s('1'), 0x4c, ...s('0'), 0x4d, ...s('0'), 0x01];

test('byte fixture: a contact on code pages 1 and 12 (Body after Birthday, FileAs 0x1E, FirstName 0x1F, LastName 0x29, NickName 0x0D)', () => {
  const buf = encodeWbxml(el('ApplicationData', undefined, renderContact(item({ name: { prefix: '', given: 'Erika', middle: '', family: 'Muster', suffix: '' }, nickname: 'Riki' }), render())));
  assert.deepEqual([...buf], [
    0x03, 0x01, 0x6a, 0x00, 0x00, 0x00, 0x5d, ...BODY_EMPTY,
    0x00, 0x01, 0x5e, ...s('Muster, Erika'), 0x5f, ...s('Erika'), 0x69, ...s('Muster'),
    0x00, 0x0c, 0x4d, ...s('Riki'), 0x01,
  ]);
  assert.deepEqual(tagsNewerThan(buf, '12.1'), []);
});

/** A contact using every mapped field, with more values than ActiveSync has slots for. */
const RICH: ContactItem = item({
  displayName: 'Dr. Erika Maria Muster MBA',
  name: { prefix: 'Dr.', given: 'Erika', middle: 'Maria', family: 'Muster', suffix: 'MBA' },
  nickname: 'Riki', fileAs: 'Muster (Vertrieb)', company: 'Beispiel GmbH', department: 'Vertrieb', jobTitle: 'Leitung',
  emails: [{ type: 'work', value: 'erika@firma.example' }, { type: 'home', value: 'erika@privat.example' },
    { type: 'other', value: 'e3@example.org' }, { type: 'other', value: 'e4@example.org' }],
  phones: [{ type: 'mobile', value: '+49 170 1' }, { type: 'work', value: '+49 30 2' }, { type: 'work', value: '+49 30 3' },
    { type: 'work', value: '+49 30 4' }, { type: 'home', value: '+49 30 5' }, { type: 'fax', value: '+49 30 6' },
    { type: 'pager', value: '777' }, { type: 'other', value: '+49 30 8' }, { type: 'mobile', value: '+49 171 9' }],
  addresses: [
    { type: 'work', street: 'Hauptstr. 1', city: 'Berlin', region: 'BE', postalCode: '10115', country: 'Deutschland', poBox: 'PF 12', extended: 'Haus B' },
    { type: 'home', street: 'Gartenweg 2', city: 'Potsdam', region: '', postalCode: '14467', country: '', poBox: '', extended: '' },
    { type: 'work', street: 'Zweitbüro 3', city: 'Hamburg', region: '', postalCode: '', country: '', poBox: '', extended: '' },
  ],
  urls: [{ type: 'work', value: 'https://firma.example' }, { type: 'home', value: 'https://privat.example' }],
  ims: [{ type: 'home', value: 'xmpp:erika@chat.example' }],
  birthday: '1980-05-17', anniversary: '--06-12', categories: ['Kunden', 'VIP'], notes: 'Zeile 1\nZeile 2',
}, { officeLocation: 'Raum 4.12', picture: JPEG(64).toString('base64') });

test('contact → Sync item: every slot, dates as local midnights, Contacts2 fields, 12.1 tags only', () => {
  const tree = echo(RICH);
  const v = (n: string) => kid(tree, n)?.text;
  assert.deepEqual(['FirstName', 'MiddleName', 'LastName', 'Title', 'Suffix', 'NickName', 'FileAs', 'CompanyName', 'Department', 'JobTitle', 'OfficeLocation'].map(v),
    ['Erika', 'Maria', 'Muster', 'Dr.', 'MBA', 'Riki', 'Muster (Vertrieb)', 'Beispiel GmbH', 'Vertrieb', 'Leitung', 'Raum 4.12']);
  assert.deepEqual(['Email1Address', 'Email2Address', 'Email3Address'].map(v), ['erika@firma.example', 'erika@privat.example', 'e3@example.org']);
  assert.deepEqual(['BusinessPhoneNumber', 'Business2PhoneNumber', 'HomePhoneNumber', 'Home2PhoneNumber', 'MobilePhoneNumber', 'BusinessFaxNumber', 'PagerNumber', 'CompanyMainPhone', 'CarPhoneNumber'].map(v),
    ['+49 30 2', '+49 30 3', '+49 30 5', undefined, '+49 170 1', '+49 30 6', '777', '+49 30 8', undefined]);
  assert.deepEqual(['BusinessAddressStreet', 'BusinessAddressCity', 'BusinessAddressState', 'BusinessAddressPostalCode', 'BusinessAddressCountry', 'HomeAddressCity', 'OtherAddressCity'].map(v),
    ['Hauptstr. 1', 'Berlin', 'BE', '10115', 'Deutschland', 'Potsdam', undefined]);
  assert.deepEqual(['WebPage', 'IMAddress', 'IMAddress2'].map(v), ['https://firma.example', 'xmpp:erika@chat.example', undefined]);
  // Berlin is UTC+2 on 17 May 1980; 1604 is the year of a date without one
  assert.deepEqual([v('Birthday'), v('Anniversary')], ['1980-05-16T22:00:00.000Z', formatContactDate('--06-12', 'Europe/Berlin')]);
  assert.equal(v('Anniversary')!.slice(0, 4), '1604');
  assert.deepEqual(kid(tree, 'Categories')?.children?.map((c) => (c as WbxmlElement).text), ['Kunden', 'VIP']);
  assert.equal(kid(kid(tree, 'Body'), 'Data')?.text, 'Zeile 1\nZeile 2');
  assert.equal(v('Picture'), RICH.picture);
  assert.deepEqual(tagsNewerThan(encodeWbxml(el('ApplicationData', undefined, renderContact(RICH, render('12.1')))), '12.1'), []);
});

test('round trip: the device sends the item back unchanged → the stored contact stays exactly as it was', () => {
  for (const user of [USER, UTC_USER]) {
    const back = contactChange(echo(RICH, user), RICH, write({ user }));
    assert.equal(back.normalized, false);
    assert.ok(sameContactCard(back.item.card, RICH.card), JSON.stringify(back.item.card));
    assert.deepEqual([back.item.officeLocation, back.item.picture], [RICH.officeLocation, RICH.picture]);
  }
  // as an Add (another device): what it sees is what is stored
  const added = contactChange(echo(RICH), null, write());
  assert.equal(added.normalized, false);
  assert.deepEqual(contactView(added.item), contactView(RICH));
  assert.equal(added.item.card.displayName, 'Dr. Erika Maria Muster MBA');
});

test('overflow: a device edit changes only the values it saw — the 4th e-mail, 3rd work phone, 2nd mobile, 2nd work address, PO box, 2nd web page survive', () => {
  const data = appData([
    Ct(0x1f, 'Erika'), Ct(0x29, 'Muster'),
    Ct(0x1b, 'neu@firma.example'), Ct(0x1d, 'e3@example.org'), // Email2 left out → cleared
    Ct(0x13, '+49 30 20'), Ct(0x2b, '+49 170 1'), // Business2, Home, fax, pager, CompanyMain left out → cleared
    Ct(0x11, 'Neue Str. 5'), Ct(0x0d, 'Berlin'), // the rest of the business address cleared
    Ct(0x37, 'https://neu.example'),
  ]);
  const { item: out } = contactChange(data, RICH, write());
  const c = out.card;
  assert.deepEqual(c.emails, [{ type: 'work', value: 'neu@firma.example' }, { type: 'other', value: 'e3@example.org' }, { type: 'other', value: 'e4@example.org' }]);
  assert.deepEqual(c.phones, [{ type: 'mobile', value: '+49 170 1' }, { type: 'work', value: '+49 30 20' }, { type: 'work', value: '+49 30 4' }, { type: 'mobile', value: '+49 171 9' }],
    'the 3rd work phone and the 2nd mobile were never on the device');
  assert.deepEqual(c.addresses.map((a) => [a.type, a.street, a.city, a.region, a.poBox, a.extended]), [
    ['work', 'Neue Str. 5', 'Berlin', '', 'PF 12', 'Haus B'], ['work', 'Zweitbüro 3', 'Hamburg', '', '', ''],
  ], 'the home address was cleared; PO box / extended part and the 2nd work address stay');
  assert.deepEqual(c.urls, [{ type: 'work', value: 'https://neu.example' }, { type: 'home', value: 'https://privat.example' }]);
  assert.deepEqual([c.ims, c.categories, c.notes, c.birthday, out.officeLocation, out.picture], [[], [], '', '', '', ''], 'no Supported list: absent = cleared');
});

test('ghosting: elements outside the priming Supported list keep their values', () => {
  const supported = new Set(['FirstName', 'LastName', 'Email1Address', 'MobilePhoneNumber']);
  const { item: out, normalized } = contactChange(appData([Ct(0x1f, 'Erika'), Ct(0x29, 'Muster'), Ct(0x2b, '+49 170 99')]), RICH, write({ supported }));
  assert.deepEqual(out.card.emails.map((e) => e.value), ['erika@privat.example', 'e3@example.org', 'e4@example.org'], 'Email1 listed and absent → cleared');
  assert.equal(normalized, true, 'the next address moves up into Email1: the device gets it');
  assert.equal(out.card.phones.find((p) => p.type === 'mobile')?.value, '+49 170 99');
  assert.deepEqual([out.card.name.prefix, out.card.birthday, out.card.anniversary, out.card.categories, out.card.notes, out.officeLocation, out.picture],
    ['Dr.', '1980-05-17', '--06-12', ['Kunden', 'VIP'], 'Zeile 1\nZeile 2', 'Raum 4.12', RICH.picture],
    'Title, dates, categories, body, office and picture are ghosted');
});

test('device Add: new entries get the slot type; kinds without a CoreMail type are `other` and the device gets the stored layout back', () => {
  const add = contactChange(appData([
    Ct(0x1f, 'Alex'), Ct(0x29, 'Beispiel'), Ct(0x1b, '"Alex B" <alex@example.org>'), Ct(0x27, '+49 40 1'), Ct(0x12, '+49 40 2'),
    Ct(0x21, 'Hamburg'), Ct(0x2d, 'Kiel'), C2(0x07, 'sip:alex@voip.example'), Ct(0x15, [Ct(0x16, 'Team'), Ct(0x16, 'team')]),
    B(0x0a, [B(0x06, '1'), B(0x0b, 'Notiz')]), Ct(0x08, '1990-01-02T00:00:00.000Z'),
  ]), null, write());
  const c = add.item.card;
  assert.equal(c.displayName, 'Alex Beispiel');
  assert.deepEqual(c.emails, [{ type: 'other', value: 'alex@example.org' }]);
  assert.deepEqual(c.phones, [{ type: 'home', value: '+49 40 1' }, { type: 'fax', value: '+49 40 2' }]);
  assert.deepEqual(c.addresses.map((a) => [a.type, a.city]), [['home', 'Hamburg'], ['other', 'Kiel']]);
  assert.deepEqual([c.ims, c.categories, c.notes, c.birthday], [[{ type: 'other', value: 'sip:alex@voip.example' }], ['Team'], 'Notiz', '1990-01-02']);
  assert.equal(add.normalized, false, 'the merged duplicate category is not part of the slot view');
  const radio = contactChange(appData([Ct(0x1f, 'R'), Ct(0x33, '+49 1')]), null, write());
  assert.deepEqual(radio.item.card.phones, [{ type: 'other', value: '+49 1' }]);
  assert.equal(contactView(radio.item)['CompanyMainPhone'], '+49 1');
  assert.equal(radio.normalized, true, 'RadioPhone → stored as `other` → shown as CompanyMainPhone: the device gets it back');
  const nameless = contactChange(appData([Ct(0x2b, '+49 170 5')]), null, write());
  assert.equal(nameless.item.card.displayName, '+49 170 5', 'a contact with only a number is named after it');
});

test('file as and display name: derived values follow the names; values set apart stay', () => {
  const stored = item({ displayName: 'Erika Muster', name: { prefix: '', given: 'Erika', middle: '', family: 'Muster', suffix: '' } });
  const renamed = contactChange(appData([Ct(0x1f, 'Erika-Maria'), Ct(0x29, 'Muster'), Ct(0x1e, 'Muster, Erika')]), stored, write());
  assert.deepEqual([renamed.item.card.displayName, renamed.item.card.fileAs], ['Erika-Maria Muster', '']);
  assert.equal(renamed.normalized, true, 'the device gets the new derived FileAs');
  const explicit = contactChange(appData([Ct(0x1f, 'Erika'), Ct(0x29, 'Muster'), Ct(0x1e, 'Chefin')]), stored, write());
  assert.deepEqual([explicit.item.card.fileAs, explicit.normalized], ['Chefin', false]);
  const apart = item({ displayName: 'Die Chefin', name: { prefix: '', given: 'Erika', middle: '', family: 'Muster', suffix: '' } });
  assert.equal(contactChange(appData([Ct(0x1f, 'Eri'), Ct(0x29, 'Muster')]), apart, write()).item.card.displayName, 'Die Chefin');
  assert.equal(contactChange(appData([Ct(0x1f, 'Erika'), Ct(0x29, 'Muster')]), stored, write()).normalized, false, 'no FileAs sent: derived, no echo');
});

test('values: e-mail forms, control characters, dates in every spelling, the picture bound', () => {
  assert.deepEqual(['"A, B" <a@b.example>', ' a@b.example ', 'Name <a@b.example>'].map(emailOf), ['a@b.example', 'a@b.example', 'a@b.example']);
  assert.equal(contactChange(appData([Ct(0x19, 'Firma\r\nGmbH')]), null, write()).item.card.company, 'Firma  GmbH');
  assert.equal(formatContactDate('1980-05-17', null), '1980-05-17T00:00:00.000Z');
  assert.equal(formatContactDate('--05-17', null), '1604-05-17T00:00:00.000Z');
  for (const [sent, tz, want] of [
    ['1980-05-17T00:00:00.000Z', 'Europe/Berlin', '1980-05-17'], // UTC midnight
    ['1980-05-16T22:00:00.000Z', 'Europe/Berlin', '1980-05-17'], // local midnight in the user's zone
    ['1980-05-17T07:00:00.000Z', null, '1980-05-17'], // a device west of UTC: nearest midnight
    ['1980-05-16T19:00:00.000Z', null, '1980-05-17'],
    ['1604-05-17T00:00:00.000Z', null, '--05-17'],
    [formatContactDate('--05-17', 'Europe/Berlin'), 'Europe/Berlin', '--05-17'],
    ['19800517T000000Z', null, '1980-05-17'],
  ] as const) assert.equal(parseContactDate(sent, tz), want, `${sent} ${tz}`);
  assert.equal(parseContactDate('gestern', null), undefined);
  assert.equal(parsePicture(JPEG(PICTURE_MAX_BYTES).toString('base64')), JPEG(PICTURE_MAX_BYTES).toString('base64'));
  assert.equal(parsePicture(JPEG(PICTURE_MAX_BYTES + 1).toString('base64')), undefined, 'over the bound');
  assert.equal(parsePicture(Buffer.from('kein Bild').toString('base64')), undefined, 'not an image');
  const refused = contactChange(appData([Ct(0x1f, 'Erika'), Ct(0x3c, JPEG(PICTURE_MAX_BYTES + 1).toString('base64'))]), RICH, write({ supported: new Set(['FirstName', 'Picture']) }));
  assert.deepEqual([refused.item.picture, refused.normalized], [RICH.picture, true], 'a refused picture keeps the stored one and is sent back');
  const removed = contactChange(appData([Ct(0x1f, 'Erika'), Ct(0x3c, '')]), RICH, write({ supported: new Set(['FirstName', 'Picture']) }));
  assert.equal(removed.item.picture, '', 'an empty Picture removes the photo');
});

test('a change of an empty contact item is the empty contact', () => {
  assert.deepEqual(contactView(contactChange(appData([]), null, write()).item), contactView(EMPTY_CONTACT));
});
