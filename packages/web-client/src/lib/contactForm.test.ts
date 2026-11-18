import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addRow, addressLines, contactPayload, effectiveDisplayName, emptyContactForm, formFromContact, formatGermanDate, MAX_ROWS,
  parseGermanDate, removeRow, updateRow, validateContactForm, type ContactDetail,
} from './contactForm.ts';
import {
  addMember, addressMember, expansionNotice, groupIdOfSuggestion, memberInput, memberKey, memberLabel, recipientEntries, removeMember,
  type GroupMember,
} from './contactGroups.ts';
import { categoryColor, categoryOptions, isSelected, toggleCategory } from './itemCategories.ts';

const DETAIL: ContactDetail = {
  id: 'c1', displayName: 'Dr. Erika Muster', company: 'Beispiel GmbH', department: '', jobTitle: 'Leitung', notes: 'n',
  email: 'erika@firma.example', email2: '', phone: '+49 30 2', mobile: '',
  name: { prefix: 'Dr.', given: 'Erika', middle: '', family: 'Muster', suffix: '' },
  emails: [{ type: 'work', value: 'erika@firma.example' }],
  phones: [{ type: 'work', value: '+49 30 2' }],
  addresses: [{ type: 'home', street: 'Ringstr. 5', city: 'Hamburg', region: '', postalCode: '20095', country: 'DE', poBox: '', extended: '' }],
  birthday: '--05-17', anniversary: '2010-06-12', categories: ['VIP'],
};

test('German dates: with and without year, impossible dates refused', () => {
  assert.equal(parseGermanDate('17.05.1980'), '1980-05-17');
  assert.equal(parseGermanDate('7.5.'), '--05-07');
  assert.equal(parseGermanDate('29.02.'), '--02-29', 'leap day without year');
  assert.equal(parseGermanDate('29.02.2023'), null);
  assert.equal(parseGermanDate('31.04.2020'), null);
  assert.equal(parseGermanDate('morgen'), null);
  assert.equal(parseGermanDate(' '), '');
  assert.equal(formatGermanDate('1980-05-17'), '17.05.1980');
  assert.equal(formatGermanDate('--05-17'), '17.05.');
  assert.equal(formatGermanDate(undefined), '');
});

test('form round trip: contact → form → payload keeps every field; empty rows dropped', () => {
  let form = formFromContact(DETAIL);
  assert.equal(form.birthday, '17.05.');
  form = addRow(form, 'emails');
  form = updateRow(form, 'emails', form.emails[1]!.key, { type: 'home', value: ' privat@x.example ' });
  form = addRow(form, 'urls');
  const p = contactPayload(form);
  assert.deepEqual(p['emails'], [{ type: 'work', value: 'erika@firma.example' }, { type: 'home', value: 'privat@x.example' }]);
  assert.deepEqual(p['urls'], [], 'empty row not sent');
  assert.deepEqual(p['addresses'], DETAIL.addresses);
  assert.equal(p['birthday'], '--05-17');
  assert.equal(p['anniversary'], '2010-06-12');
  assert.deepEqual(p['categories'], ['VIP']);
  assert.equal(JSON.stringify(p).includes('"key"'), false, 'row keys never sent');
  form = removeRow(form, 'emails', form.emails[0]!.key);
  assert.equal(form.emails.length, 1);
});

test('a pre-9.5 contact (flat fields only) fills the typed rows', () => {
  const form = formFromContact({ ...DETAIL, emails: undefined, phones: undefined, email2: 'b@x.example', mobile: '+49 170 1' } as ContactDetail);
  assert.deepEqual(form.emails.map((e) => e.value), ['erika@firma.example', 'b@x.example']);
  assert.deepEqual(form.phones.map((e) => [e.type, e.value]), [['other', '+49 30 2'], ['mobile', '+49 170 1']]);
});

test('checks mirror the server; display name falls back to the name parts', () => {
  const form = emptyContactForm();
  assert.ok(validateContactForm(form)['displayName']);
  const named = { ...form, name: { ...form.name, given: 'Ada', family: 'Lovelace' } };
  assert.equal(effectiveDisplayName(named), 'Ada Lovelace');
  assert.deepEqual(validateContactForm(named), {});
  const bad = {
    ...named,
    emails: [{ key: 'e', type: 'work' as const, value: 'nope' }],
    phones: [{ key: 'p', type: 'work' as const, value: 'ruf an' }],
    urls: [{ key: 'u', type: 'work' as const, value: 'javascript:alert(1)' }],
    ims: [{ key: 'i', type: 'other' as const, value: 'data:x' }],
    birthday: '31.02.',
  };
  assert.deepEqual(Object.keys(validateContactForm(bad)).sort(), ['birthday', 'emails.e', 'ims.i', 'phones.p', 'urls.u']);
  let many = named;
  for (let i = 0; i < MAX_ROWS + 3; i++) many = addRow(many, 'phones');
  assert.equal(many.phones.length, MAX_ROWS);
  assert.deepEqual(addressLines(DETAIL.addresses![0]!), ['Ringstr. 5', '20095 Hamburg', 'DE']);
});

test('groups: members de-duplicated, labels, request body, expansion to compose entries', () => {
  const anna: GroupMember = { kind: 'contact', contactId: 'c1', uid: 'u1', displayName: 'Anna', email: 'anna@x.example' };
  const ext = addressMember(' extern@partner.example ', 'Partner')!;
  assert.equal(addressMember('kein-mail', ''), null);
  let members = addMember([], anna);
  members = addMember(members, ext);
  members = addMember(members, { kind: 'address', email: 'EXTERN@partner.example', name: '' });
  assert.equal(members.length, 2);
  assert.deepEqual(members.map(memberInput), [{ contactId: 'c1' }, { email: 'extern@partner.example', name: 'Partner' }]);
  assert.deepEqual(memberInput({ kind: 'missing', uid: 'x' }), { uid: 'x' }, 'unresolved references survive a save');
  assert.equal(memberLabel({ kind: 'contact', contactId: 'c2', uid: 'u', displayName: 'Ben', email: '' }), 'Ben (keine E-Mail-Adresse)');
  assert.equal(removeMember(members, memberKey(anna)).length, 1);
  const exp = {
    recipients: [{ name: 'Anna', address: 'anna@x.example' }, { name: 'Doe, John', address: 'j@x.example' }, { name: '', address: 'z@x.example' }],
    skipped: [{ reason: 'noEmail' as const, name: 'Ben' }, { reason: 'noEmail' as const, name: 'Cem' }, { reason: 'missing' as const, name: '' }],
  };
  assert.deepEqual(recipientEntries(exp), ['Anna <anna@x.example>', '"Doe, John" <j@x.example>', 'z@x.example']);
  assert.equal(expansionNotice(exp), 'Übersprungen: 2 Mitglieder ohne E-Mail-Adresse, 1 nicht mehr vorhandener Kontakt.');
  assert.equal(expansionNotice({ recipients: [], skipped: [] }), null);
  assert.equal(groupIdOfSuggestion({ id: 'group-g7', kind: 'group' }), 'g7');
  assert.equal(groupIdOfSuggestion({ id: 'gal-u1' }), null);
});

test('categories: toggle case-insensitively, colour from the list, foreign names kept as options', () => {
  const defs = [{ name: 'VIP', color: '#ff0000' }, { name: 'Kunden', color: '#00ff00' }];
  assert.deepEqual(toggleCategory(['vip'], 'VIP'), []);
  assert.deepEqual(toggleCategory(['VIP'], ' Kunden '), ['VIP', 'Kunden']);
  assert.ok(isSelected(['kunden'], 'Kunden'));
  assert.equal(categoryColor('vip', defs), '#ff0000');
  assert.equal(categoryColor('Golf', defs), null);
  assert.deepEqual(categoryOptions(defs, ['Golf', 'vip']).map((o) => o.name), ['VIP', 'Kunden', 'Golf']);
});
