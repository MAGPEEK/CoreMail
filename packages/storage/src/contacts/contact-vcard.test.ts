/**
 * 9.5: structured contacts — vCard 3/4 mapping, round trips, flat columns, patches.
 * Run: node --import tsx --test src/contacts/contact-vcard.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyContactPatch, contactListsFromRow, emptyContactCard, finalizeContactCard, flatContactColumns, fileAsOf,
  isContactDate, normalizeContactDate, photoMediaType, type ContactCard,
} from './contact-card.js';
import {
  applyContactCard, buildContactVcard, contactCardFromVcard, contactColumnsFromVcard, setVcardPhoto, setVcardText, uidKey, vcardPhoto,
  vcardPhoneKinds, vcardSaysCard, vcardText, OFFICE_LOCATION_PROPERTY,
} from './contact-vcard.js';

const lines = (vcard: string): string[] => vcard.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);

/** What iOS / macOS Contacts stores (vCard 3.0, grouped labels, escaped URL colon). */
const APPLE = [
  'BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Apple Inc.//iOS 18//EN', 'UID:5A1E7C2B-0000-4000-8000-ABCDEF012345',
  'N:Muster;Erika;Maria;Dr.;MBA', 'FN:Dr. Erika Maria Muster MBA', 'NICKNAME:Riki', 'ORG:Beispiel GmbH;Vertrieb;Nord',
  'TITLE:Leitung', 'item1.EMAIL;type=INTERNET;type=WORK;type=pref:erika@firma.example',
  'EMAIL;type=INTERNET;type=HOME:erika@privat.example',
  'TEL;type=CELL;type=VOICE;type=pref:+49 170 1111111', 'TEL;type=WORK;type=VOICE:+49 30 2222222',
  'TEL;type=WORK;type=FAX:+49 30 2222299',
  'item2.ADR;type=WORK;type=pref:;Haus B;Hauptstr. 1;Berlin;BE;10115;Deutschland', 'item2.X-ABADR:de',
  'item3.URL;type=pref:https\\://firma.example/team', 'item3.X-ABLabel:_$!<HomePage>!$_',
  'IMPP;X-SERVICE-TYPE=Jabber;type=HOME:xmpp:erika@chat.example',
  'BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-17',
  'item4.X-ABDATE;type=pref:2010-06-12', 'item4.X-ABLabel:_$!<Anniversary>!$_',
  'CATEGORIES:Kunden,VIP', 'CATEGORIES:Messe 2026',
  'X-EVOLUTION-FILE-AS:Muster\\, Erika', 'NOTE:Zeile 1\\nZeile 2',
  'PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==', 'X-SOCIALPROFILE;type=twitter:https://x.example/erika', 'END:VCARD', '',
].join('\r\n');

const V4 = [
  'BEGIN:VCARD', 'VERSION:4.0', 'UID:urn:uuid:0f0e0d0c-0000-4000-8000-000000000001', 'KIND:individual',
  'FN:Max Beispiel', 'N:Beispiel;Max;;;', 'EMAIL;TYPE=work;PREF=1:max@firma.example',
  'TEL;VALUE=uri;TYPE="voice,cell":tel:+49-170-3333333', 'TEL;VALUE=uri;TYPE=home:tel:+49-30-4444444',
  'ADR;TYPE=home:;;Ringstr. 5;Hamburg;;20095;DE', 'URL:https://max.example', 'IMPP;TYPE=work:sip:max@voip.example',
  'BDAY:--0229', 'ANNIVERSARY:20040612', 'END:VCARD', '',
].join('\r\n');

test('vCard 3 (Apple): names, typed lists, Apple dates/labels, categories, file-as', () => {
  const c = contactCardFromVcard(APPLE);
  assert.deepEqual(c.name, { prefix: 'Dr.', given: 'Erika', middle: 'Maria', family: 'Muster', suffix: 'MBA' });
  assert.equal(c.displayName, 'Dr. Erika Maria Muster MBA');
  assert.equal(c.nickname, 'Riki');
  assert.deepEqual([c.company, c.department, c.jobTitle], ['Beispiel GmbH', 'Vertrieb', 'Leitung']);
  assert.deepEqual(c.emails, [{ type: 'work', value: 'erika@firma.example' }, { type: 'home', value: 'erika@privat.example' }]);
  assert.deepEqual(c.phones, [
    { type: 'mobile', value: '+49 170 1111111' }, { type: 'work', value: '+49 30 2222222' }, { type: 'fax', value: '+49 30 2222299' },
  ]);
  assert.deepEqual(c.addresses, [{ type: 'work', poBox: '', extended: 'Haus B', street: 'Hauptstr. 1', city: 'Berlin', region: 'BE', postalCode: '10115', country: 'Deutschland' }]);
  assert.deepEqual(c.urls, [{ type: 'other', value: 'https://firma.example/team' }]);
  assert.deepEqual(c.ims, [{ type: 'home', value: 'xmpp:erika@chat.example' }]);
  assert.equal(c.birthday, '--05-17', 'Apple year-less birthday');
  assert.equal(c.anniversary, '2010-06-12', 'X-ABDATE labelled Anniversary');
  assert.deepEqual(c.categories, ['Kunden', 'VIP', 'Messe 2026']);
  assert.equal(c.fileAs, 'Muster, Erika');
  assert.equal(c.notes, 'Zeile 1\nZeile 2');
});

test('vCard 4: tel: URIs, quoted TYPE lists, year-less and basic dates', () => {
  const c = contactCardFromVcard(V4);
  assert.deepEqual(c.phones, [{ type: 'mobile', value: '+49-170-3333333' }, { type: 'home', value: '+49-30-4444444' }]);
  assert.deepEqual(c.emails, [{ type: 'work', value: 'max@firma.example' }]);
  assert.equal(c.birthday, '--02-29');
  assert.equal(c.anniversary, '2004-06-12');
  assert.deepEqual(c.ims, [{ type: 'work', value: 'sip:max@voip.example' }]);
  const cols = contactColumnsFromVcard(V4);
  assert.equal(cols.uid, '0f0e0d0c-0000-4000-8000-000000000001', 'uid without urn:uuid:');
  assert.equal(cols.mobile, '+49-170-3333333');
  assert.equal(cols.phone, '+49-30-4444444');
  assert.match(cols.searchText, /4930444444/, 'phone digits are searchable');
});

test('an unchanged card rewrites nothing; a change keeps every line it does not touch', () => {
  const card = contactCardFromVcard(APPLE);
  assert.equal(applyContactCard(APPLE, card).replace(/\r\n /g, ''), lines(APPLE).join('\r\n') + '\r\n');
  assert.ok(vcardSaysCard(APPLE, card));

  const changed: ContactCard = {
    ...card,
    emails: [card.emails[0]!, { type: 'other', value: 'neu@example.org' }],
    phones: card.phones.filter((p) => p.type !== 'fax'),
    urls: [],
    jobTitle: 'Geschäftsführung',
    categories: ['VIP'],
  };
  const out = lines(applyContactCard(APPLE, changed));
  for (const kept of ['item1.EMAIL;type=INTERNET;type=WORK;type=pref:erika@firma.example', 'TEL;type=CELL;type=VOICE;type=pref:+49 170 1111111',
    'item2.ADR;type=WORK;type=pref:;Haus B;Hauptstr. 1;Berlin;BE;10115;Deutschland', 'item2.X-ABADR:de', 'PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==',
    'X-SOCIALPROFILE;type=twitter:https://x.example/erika', 'BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-17', 'item4.X-ABDATE;type=pref:2010-06-12',
    'NICKNAME:Riki', 'UID:5A1E7C2B-0000-4000-8000-ABCDEF012345', 'PRODID:-//Apple Inc.//iOS 18//EN']) {
    assert.ok(out.includes(kept), `lost ${kept}`);
  }
  assert.ok(out.includes('EMAIL;TYPE=INTERNET:neu@example.org'));
  assert.ok(!out.some((l) => l.includes('erika@privat.example')));
  assert.ok(!out.some((l) => l.includes('FAX')));
  assert.ok(!out.some((l) => l.startsWith('item3.')), 'URL and its orphaned label are gone');
  assert.ok(out.includes('TITLE:Geschäftsführung'));
  assert.deepEqual(out.filter((l) => l.startsWith('CATEGORIES')), ['CATEGORIES:VIP'], 'several CATEGORIES lines merged');
  assert.deepEqual(contactCardFromVcard(out.join('\r\n')).emails.map((e) => e.value), ['erika@firma.example', 'neu@example.org'], 'order kept');
});

test('round trip: every field written to a new vCard 3.0 reads back the same', () => {
  const card: ContactCard = finalizeContactCard({
    ...emptyContactCard(),
    name: { prefix: 'Prof.', given: 'Ada', middle: 'B.', family: 'Lovelace; King', suffix: 'Jr.' },
    displayName: 'Ada Lovelace', nickname: 'Countess', fileAs: 'Lovelace, Ada', company: 'Analytical, Ltd', department: 'R&D',
    jobTitle: 'CTO', notes: 'line1\nEMAIL:evil@x.example',
    emails: [{ type: 'work', value: 'ada@work.example' }, { type: 'home', value: 'ada@home.example' }, { type: 'other', value: 'ada@other.example' }],
    phones: [{ type: 'work', value: '+44 20 1' }, { type: 'home', value: '+44 20 2' }, { type: 'mobile', value: '+44 7700 3' },
      { type: 'fax', value: '+44 20 4' }, { type: 'pager', value: '555' }, { type: 'other', value: '+44 20 6' }],
    addresses: [{ type: 'home', street: 'St James\'s Sq 12\n2nd floor', city: 'London', region: '', postalCode: 'SW1Y', country: 'UK', poBox: '', extended: '' }],
    urls: [{ type: 'work', value: 'https://analytical.example/?a=1,2;b' }],
    ims: [{ type: 'other', value: 'xmpp:ada@chat.example' }],
    birthday: '1815-12-10', anniversary: '--07-08', categories: ['Familie', 'Mathe, Logik'],
  });
  const vcard = buildContactVcard(card);
  assert.deepEqual(contactCardFromVcard(vcard), card);
  const ls = lines(vcard);
  assert.ok(ls.includes('NOTE:line1\\nEMAIL:evil@x.example'), 'no property injection');
  assert.ok(!ls.some((l) => l.startsWith('EMAIL:evil')));
  assert.ok(ls.includes('X-FILE-AS:Lovelace\\, Ada'));
  assert.ok(ls.includes('X-ANNIVERSARY;X-APPLE-OMIT-YEAR=1604:1604-07-08'));
  assert.ok(ls.includes('CATEGORIES:Familie,Mathe\\, Logik'));
  assert.ok(ls.some((l) => /^UID:urn:uuid:[0-9a-f-]{36}$/.test(l)));

  const v4 = applyContactCard('BEGIN:VCARD\r\nVERSION:4.0\r\nEND:VCARD\r\n', card);
  assert.deepEqual(contactCardFromVcard(v4), card, 'vCard 4 round trip');
  assert.ok(lines(v4).includes('ANNIVERSARY:--0708'));
  assert.ok(lines(v4).includes('BDAY:18151210'));
  assert.ok(lines(v4).includes('TEL;TYPE=cell:+44 7700 3'));
});

test('flat columns: first two e-mails, first voice number, first mobile', () => {
  const card = finalizeContactCard({
    ...emptyContactCard(), displayName: 'X',
    emails: [{ type: 'home', value: 'a@x.example' }, { type: 'work', value: 'b@x.example' }, { type: 'other', value: 'c@x.example' }],
    phones: [{ type: 'fax', value: '1' }, { type: 'mobile', value: '2' }, { type: 'home', value: '3' }],
  });
  const f = flatContactColumns(card);
  assert.deepEqual([f.email, f.email2, f.phone, f.mobile], ['a@x.example', 'b@x.example', '3', '2']);
  assert.equal(fileAsOf({ ...card, name: { ...card.name, given: 'Eva', family: 'Zett' } }), 'Zett, Eva');
});

test('legacy patch fields address one slot each; an unchanged display name keeps the name parts', () => {
  const base = contactCardFromVcard(APPLE);
  const p = applyContactPatch(base, { email: 'x@new.example', mobile: '', phone: '+49 30 9' });
  assert.deepEqual(p.emails.map((e) => [e.type, e.value]), [['work', 'x@new.example'], ['home', 'erika@privat.example']]);
  assert.deepEqual(p.phones, [{ type: 'work', value: '+49 30 9' }, { type: 'fax', value: '+49 30 2222299' }]);
  assert.deepEqual(applyContactPatch(base, { displayName: base.displayName }).name, base.name);
  assert.deepEqual(applyContactPatch(base, { displayName: 'Anna Maria Schmidt' }).name,
    { prefix: '', given: 'Anna Maria', middle: '', family: 'Schmidt', suffix: '' });
  const fresh = applyContactPatch(emptyContactCard(), { displayName: 'N', email: '', email2: 'only@x.example' });
  assert.deepEqual(fresh.emails, [{ type: 'other', value: 'only@x.example' }]);
  assert.equal(applyContactPatch(emptyContactCard(), { emails: [{ type: 'home', value: 'h@x.example' }] }).displayName, 'h@x.example',
    'display name falls back to the e-mail');
});

test('dates: vCard spellings normalised, impossible dates refused', () => {
  const table: Array<[string, string]> = [
    ['1980-05-17', '1980-05-17'], ['19800517', '1980-05-17'], ['--0517', '--05-17'], ['--05-17', '--05-17'],
    ['1980-05-17T00:00:00Z', '1980-05-17'], ['--0229', '--02-29'], ['2023-02-29', ''], ['2024-02-29', '2024-02-29'],
    ['1980-13-01', ''], ['tomorrow', ''], ['', ''],
  ];
  for (const [raw, want] of table) assert.equal(normalizeContactDate(raw), want, raw);
  assert.ok(isContactDate('') && isContactDate('--12-24') && !isContactDate('19800517'));
});

test('stored JSON lists are read tolerantly', () => {
  const r = contactListsFromRow({
    emails: [{ type: 'work', value: 'a@x.example' }, { type: 'bogus', value: 'b@x.example' }, { value: '' }, 'junk', null],
    phones: 'not a list',
    addresses: [{ type: 'home', city: 'Köln' }, { type: 'work' }],
  });
  assert.deepEqual(r.emails, [{ type: 'work', value: 'a@x.example' }, { type: 'other', value: 'b@x.example' }]);
  assert.deepEqual(r.phones, []);
  assert.equal(r.addresses.length, 1);
  assert.equal(r.addresses[0]!.city, 'Köln');
});

test('a patch of the legacy fields keeps every untouched line; text is escaped (no property injection)', () => {
  const CARD = [
    'BEGIN:VCARD', 'VERSION:3.0', 'UID:urn:uuid:keep-me', 'FN:Jane Doe', 'N:Doe;Jane;;Dr.;',
    'item1.EMAIL;TYPE=INTERNET,pref:jane@example.com', 'item1.X-ABLabel:Work',
    'TEL;TYPE=WORK;TYPE=VOICE:+49 30 1', 'TEL;TYPE=CELL:+49 170 2',
    'ADR;TYPE=HOME:;;Main St 1;Berlin;;10115;DE', 'PHOTO;ENCODING=b;TYPE=JPEG:AAAABBBBCCCC',
    'ORG:ACME\\; Inc;Sales;EMEA', 'NOTE:line1\\nline2', 'X-CUSTOM;FOO="a:b":value', 'END:VCARD', '',
  ].join('\r\n');
  const patched = applyContactPatch(contactCardFromVcard(CARD), {
    displayName: 'Jane Q. Public', email: 'jq@example.com', mobile: '', department: 'R&D', jobTitle: 'CTO, Ops; Lead\nX-EVIL:1',
  });
  const out = lines(applyContactCard(CARD, patched));
  for (const kept of ['UID:urn:uuid:keep-me', 'TEL;TYPE=WORK;TYPE=VOICE:+49 30 1', 'ADR;TYPE=HOME:;;Main St 1;Berlin;;10115;DE',
    'PHOTO;ENCODING=b;TYPE=JPEG:AAAABBBBCCCC', 'NOTE:line1\\nline2', 'X-CUSTOM;FOO="a:b":value']) {
    assert.ok(out.includes(kept), `lost ${kept}`);
  }
  assert.ok(out.includes('FN:Jane Q. Public'));
  assert.ok(out.includes('N:Public;Jane Q.;;;'));
  assert.ok(out.includes('item1.EMAIL;TYPE=INTERNET,pref:jq@example.com'), 'a changed value keeps group + parameters');
  assert.ok(out.includes('item1.X-ABLabel:Work'), 'and its label');
  assert.ok(out.includes('ORG:ACME\\; Inc;R&D;EMEA'), 'third ORG unit kept');
  assert.ok(!out.some((l) => l.startsWith('TEL;TYPE=CELL')), 'emptied field removed');
  assert.ok(out.includes('TITLE:CTO\\, Ops\\; Lead\\nX-EVIL:1'));
  assert.ok(!out.some((l) => l.startsWith('X-EVIL')));
  assert.equal(contactCardFromVcard(out.join('\r\n')).jobTitle, 'CTO, Ops; Lead\nX-EVIL:1');
});

test('uidKey strips urn:uuid: only', () => {
  assert.equal(uidKey(' urn:uuid:ABC '), 'ABC');
  assert.equal(uidKey('plain-uid'), 'plain-uid');
});

test('vCard text property outside the card: read, set (group + parameters kept, duplicates dropped), removed', () => {
  const v3 = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:A', 'item2.X-OFFICE-LOCATION;X-P=1:Raum 1', 'X-OFFICE-LOCATION:alt', 'NOTE:n', 'END:VCARD', ''].join('\r\n');
  assert.equal(vcardText(v3, OFFICE_LOCATION_PROPERTY), 'Raum 1');
  const set = lines(setVcardText(v3, OFFICE_LOCATION_PROPERTY, 'Raum 2; Süd'));
  assert.deepEqual(set.filter((l) => l.includes('X-OFFICE-LOCATION')), ['item2.X-OFFICE-LOCATION;X-P=1:Raum 2\\; Süd']);
  assert.equal(vcardText(set.join('\r\n'), OFFICE_LOCATION_PROPERTY), 'Raum 2; Süd');
  const removed = lines(setVcardText(v3, OFFICE_LOCATION_PROPERTY, ''));
  assert.ok(!removed.some((l) => l.includes('X-OFFICE-LOCATION')));
  assert.ok(removed.includes('NOTE:n'), 'everything else untouched');
  assert.ok(lines(setVcardText('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:B\r\nEND:VCARD\r\n', OFFICE_LOCATION_PROPERTY, 'R')).includes('X-OFFICE-LOCATION:R'));
});

test('vCard photo: inline v3 / 2.1 / v4 data URI read, URL and non-image ignored, written in the version spelling', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const card = (...l: string[]) => ['BEGIN:VCARD', ...l, 'FN:A', 'END:VCARD', ''].join('\r\n');
  assert.deepEqual(vcardPhoto(card('VERSION:3.0', `PHOTO;ENCODING=b;TYPE=JPEG:${jpeg.toString('base64')}`)), { mediaType: 'image/jpeg', data: jpeg });
  assert.equal(vcardPhoto(card('VERSION:2.1', `PHOTO;ENCODING=BASE64;TYPE=PNG:${png.toString('base64')}`))?.mediaType, 'image/png');
  assert.deepEqual(vcardPhoto(card('VERSION:4.0', `PHOTO:data:image/jpeg;base64,${jpeg.toString('base64')}`))?.data, jpeg);
  assert.equal(vcardPhoto(card('VERSION:3.0', 'PHOTO;VALUE=uri:https://example.org/a.jpg')), null);
  assert.equal(vcardPhoto(card('VERSION:3.0', `PHOTO;ENCODING=b:${Buffer.from('text').toString('base64')}`)), null);
  assert.equal(photoMediaType(Buffer.from('GIF89a')), 'image/gif');
  const v3 = lines(setVcardPhoto(card('VERSION:3.0', 'PHOTO;VALUE=uri:https://example.org/a.jpg', 'X-KEEP:1'), { mediaType: 'image/jpeg', data: jpeg }));
  assert.deepEqual(v3.filter((l) => l.startsWith('PHOTO')), [`PHOTO;ENCODING=b;TYPE=JPEG:${jpeg.toString('base64')}`]);
  assert.ok(v3.includes('X-KEEP:1'));
  const v4 = lines(setVcardPhoto(card('VERSION:4.0'), { mediaType: 'image/png', data: png }));
  assert.ok(v4.includes(`PHOTO:data:image/png;base64,${png.toString('base64')}`));
  const none = lines(setVcardPhoto(card('VERSION:3.0', `PHOTO;ENCODING=b;TYPE=JPEG:${jpeg.toString('base64')}`), null));
  assert.ok(!none.some((l) => l.startsWith('PHOTO')));
});

test('phone kinds (ActiveSync slots): read from TEL TYPE, written in the version spelling, kept by REST / CardDAV edits', () => {
  const card = (...l: string[]) => ['BEGIN:VCARD', ...l, 'FN:A', 'UID:u1', 'END:VCARD', ''].join('\r\n');
  const v3 = card('VERSION:3.0', 'TEL;TYPE=CAR:1', 'TEL;TYPE=X-RADIO,VOICE:2', 'TEL;type=X-ASSISTANT:3', 'TEL;TYPE=X-COMPANY-MAIN:4',
    'TEL;TYPE=WORK,FAX:5', 'TEL;TYPE=HOME;TYPE=FAX:6', 'TEL;TYPE=FAX:7', 'TEL;TYPE=VOICE:8', 'TEL;TYPE=WORK,CAR:9', 'TEL;TYPE=CAR:');
  assert.deepEqual(vcardPhoneKinds(v3), ['car', 'radio', 'assistant', 'company-main', 'work-fax', 'home-fax', '', '', ''],
    'aligned with the card numbers (the empty one is no entry); a work number stays a work number');
  assert.deepEqual(contactCardFromVcard(v3).phones.map((p) => p.type), ['other', 'other', 'other', 'other', 'fax', 'fax', 'fax', 'other', 'work']);
  assert.deepEqual(vcardPhoneKinds('kein vCard'), []);

  const base = card('VERSION:3.0', 'TEL;TYPE=VOICE:8');
  const phones = (...p: Array<[string, string]>) => ({ ...contactCardFromVcard(base), phones: p.map(([type, value]) => ({ type, value })) as ContactCard['phones'] });
  const written = lines(applyContactCard(base, phones(['other', '8'], ['other', '1'], ['fax', '5'], ['fax', '6'], ['other', '4'], ['mobile', '0']),
    { phoneKinds: ['', 'car', 'work-fax', 'home-fax', 'company-main', 'car'] }));
  assert.deepEqual(written.filter((l) => l.startsWith('TEL')),
    ['TEL;TYPE=VOICE:8', 'TEL;TYPE=CAR,VOICE:1', 'TEL;TYPE=WORK,FAX:5', 'TEL;TYPE=HOME,FAX:6', 'TEL;TYPE=X-COMPANY-MAIN,VOICE:4', 'TEL;TYPE=CELL:0'],
    'a kind the type cannot have (a car mobile) is none');
  assert.deepEqual(vcardPhoneKinds(written.join('\r\n')),['', 'car', 'work-fax', 'home-fax', 'company-main', '']);
  const v4 = lines(applyContactCard(card('VERSION:4.0'), phones(['other', '2']), { phoneKinds: ['radio'] }));
  assert.ok(v4.includes('TEL;TYPE=x-radio,voice:2'), v4.join(' | '));

  // only the kind changes (a number moved to another slot): the line is rewritten
  const moved = lines(applyContactCard(v3, contactCardFromVcard(v3), { phoneKinds: ['radio', ...vcardPhoneKinds(v3).slice(1)] }));
  assert.deepEqual(vcardPhoneKinds(moved.join('\r\n')).slice(0, 2), ['radio', 'radio']);
  // a removed plain number does not lend its line to a new car number at its position
  const swapped = lines(applyContactCard(base, phones(['other', '1']), { phoneKinds: ['car'] }));
  assert.deepEqual(swapped.filter((l) => l.startsWith('TEL')), ['TEL;TYPE=CAR,VOICE:1']);
  // REST / CardDAV (no kinds): a changed number keeps its line head and so its kind; kinds stay untouched
  const rest = applyContactCard(v3, { ...contactCardFromVcard(v3), phones: contactCardFromVcard(v3).phones.map((p, i) => (i === 0 ? { ...p, value: '11' } : p)) });
  assert.ok(lines(rest).includes('TEL;TYPE=CAR:11'));
  assert.deepEqual(vcardPhoneKinds(rest), vcardPhoneKinds(v3));
  assert.equal(applyContactCard(v3, contactCardFromVcard(v3), { phoneKinds: vcardPhoneKinds(v3) }), applyContactCard(v3, contactCardFromVcard(v3)),
    'the same kinds: nothing rewritten');
});
