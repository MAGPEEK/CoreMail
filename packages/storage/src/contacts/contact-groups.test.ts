/**
 * 9.5: contact groups — vCard 4 / Apple spellings, writes that keep the form,
 * expansion (nested, cycles, duplicates) and the storage helpers on a fake DB.
 * Run: node --import tsx --test src/contacts/contact-groups.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

type Row = Record<string, unknown>;
const db = { contact: [] as Row[], contactGroup: [] as Row[] };
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, c]) => (c && typeof c === 'object' && 'in' in (c as Row)
    ? ((c as Row)['in'] as unknown[]).includes(row[k]) : row[k] === c));
}
const fakeTable = (rows: Row[]) => ({
  findMany: async (a: { where: Row }) => rows.filter((r) => matches(r, a.where)),
  update: async (a: { where: Row; data: Row }) => Object.assign(rows.find((r) => matches(r, a.where))!, a.data),
});
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined, contact: fakeTable(db.contact), contactGroup: fakeTable(db.contactGroup),
};

const {
  applyContactGroup, contactGroupFromVcard, expandGroupMembers, isGroupVcard, memberFromUri, membersFromJson,
  detachCardFromGroups, ensureContactUid, expandContactGroup, contactGroupColumns, contactGroupColumnsFromVcard, resolveCards,
  buildContactVcard, finalizeContactCard, emptyContactCard, vcardUidKey,
} = await import('./index.js');

const lines = (v: string): string[] => v.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean);

const APPLE_GROUP = [
  'BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Apple Inc.//Mac OS X//EN', 'N:Team Nord', 'FN:Team Nord',
  'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:AAA-1', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:BBB-2',
  'UID:GROUP-APPLE-1', 'X-CUSTOM:keep', 'END:VCARD', '',
].join('\r\n');

const V4_GROUP = [
  'BEGIN:VCARD', 'VERSION:4.0', 'KIND:group', 'FN:Lieferanten', 'UID:urn:uuid:group-v4-1',
  'MEMBER:urn:uuid:AAA-1', 'MEMBER:mailto:info@lieferant.example', 'MEMBER:mailto:info@lieferant.example', 'END:VCARD', '',
].join('\r\n');

test('both group spellings are read; a contact card is no group', () => {
  assert.deepEqual(contactGroupFromVcard(APPLE_GROUP), {
    uid: 'GROUP-APPLE-1', name: 'Team Nord', members: [{ kind: 'card', uid: 'AAA-1' }, { kind: 'card', uid: 'BBB-2' }],
  });
  assert.deepEqual(contactGroupFromVcard(V4_GROUP), {
    uid: 'group-v4-1', name: 'Lieferanten',
    members: [{ kind: 'card', uid: 'AAA-1' }, { kind: 'address', address: 'info@lieferant.example', name: '' }],
  }, 'duplicate member dropped');
  assert.ok(isGroupVcard(APPLE_GROUP) && isGroupVcard(V4_GROUP));
  assert.equal(isGroupVcard(buildContactVcard(finalizeContactCard({ ...emptyContactCard(), displayName: 'Solo' }))), false);
  assert.equal(contactGroupFromVcard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nEND:VCARD\r\n'), null);
  assert.deepEqual(memberFromUri('mailto:a%40b.example?subject=x'), { kind: 'address', address: 'a@b.example', name: '' });
});

test('writes keep the spelling and every other line; a new group uses the Apple form', () => {
  const apple = lines(applyContactGroup(APPLE_GROUP, { name: 'Team Nord', members: [{ kind: 'card', uid: 'BBB-2' }, { kind: 'card', uid: 'CCC-3' }] }));
  assert.deepEqual(apple.filter((l) => l.includes('MEMBER')), ['X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:BBB-2', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:CCC-3']);
  for (const kept of ['X-CUSTOM:keep', 'UID:GROUP-APPLE-1', 'PRODID:-//Apple Inc.//Mac OS X//EN', 'FN:Team Nord', 'N:Team Nord']) assert.ok(apple.includes(kept), kept);

  const v4 = lines(applyContactGroup(V4_GROUP, { name: 'Lieferanten; neu', members: [{ kind: 'address', address: 'x@y.example', name: 'X' }] }));
  assert.deepEqual(v4.filter((l) => l.startsWith('MEMBER')), ['MEMBER:mailto:x@y.example']);
  assert.ok(v4.includes('FN:Lieferanten\\; neu') && v4.includes('KIND:group'));

  const fresh = applyContactGroup('', { name: 'Neu', members: [{ kind: 'card', uid: 'AAA-1' }] });
  assert.deepEqual(contactGroupFromVcard(fresh)?.members, [{ kind: 'card', uid: 'AAA-1' }]);
  assert.ok(lines(fresh).includes('X-ADDRESSBOOKSERVER-KIND:group'));
  assert.ok(vcardUidKey(fresh));
  assert.equal(applyContactGroup(APPLE_GROUP, { name: 'Team Nord', members: contactGroupFromVcard(APPLE_GROUP)!.members }), lines(APPLE_GROUP).join('\r\n') + '\r\n',
    'unchanged = byte-identical');
});

test('expansion: nested groups, cycles, duplicates, contacts without e-mail, missing cards', () => {
  const cards = new Map<string, Parameters<typeof expandGroupMembers>[1] extends (u: string) => infer R ? R : never>([
    ['a', { kind: 'contact', displayName: 'Anna', email: 'anna@x.example' }],
    ['b', { kind: 'contact', displayName: 'Ben', email: '' }],
    ['g2', { kind: 'group', name: 'Inner', members: [{ kind: 'card', uid: 'a' }, { kind: 'card', uid: 'g1' }, { kind: 'address', address: 'C@x.example', name: 'Cem' }] }],
    ['g1', { kind: 'group', name: 'Outer', members: [{ kind: 'card', uid: 'g2' }] }],
  ]);
  const r = expandGroupMembers(
    [{ kind: 'card', uid: 'a' }, { kind: 'card', uid: 'b' }, { kind: 'card', uid: 'gone' }, { kind: 'card', uid: 'g2' }, { kind: 'address', address: 'c@x.example', name: '' }],
    (uid) => cards.get(uid),
  );
  assert.deepEqual(r.recipients, [{ name: 'Anna', address: 'anna@x.example' }, { name: 'Cem', address: 'C@x.example' }]);
  assert.deepEqual(r.skipped, [{ reason: 'noEmail', name: 'Ben' }, { reason: 'missing', name: '' }]);
});

test('stored members JSON is read tolerantly', () => {
  assert.deepEqual(membersFromJson([{ kind: 'card', uid: 'x' }, { kind: 'card' }, { kind: 'address', address: 'a@b.example' }, 5, null]),
    [{ kind: 'card', uid: 'x' }, { kind: 'address', address: 'a@b.example', name: '' }]);
  assert.deepEqual(membersFromJson('nope'), []);
});

test('CardDAV columns keep the address names the webmail gave', () => {
  const cols = contactGroupColumnsFromVcard(V4_GROUP, [{ kind: 'address', address: 'INFO@lieferant.example', name: 'Info-Team' }]);
  assert.deepEqual(cols?.members[1], { kind: 'address', address: 'info@lieferant.example', name: 'Info-Team' });
  assert.equal(contactGroupColumnsFromVcard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nEND:VCARD\r\n'), null);
});

test('storage: resolve (incl. pre-9.5 rows), expand nested, detach a deleted card, ensure a UID', async () => {
  const legacyCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:legacy-1\r\nFN:Lea\r\nEMAIL:lea@x.example\r\nEND:VCARD\r\n';
  const noUidCard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Old\r\nEMAIL:old@x.example\r\nEND:VCARD\r\n';
  db.contact.push(
    { id: 'c1', userId: 'u1', uid: 'AAA-1', displayName: 'Anna', email: 'anna@x.example', vcardData: '' },
    { id: 'c2', userId: 'u1', uid: '', displayName: 'Lea', email: 'lea@x.example', vcardData: legacyCard },
    { id: 'c3', userId: 'u1', uid: '', displayName: 'Old', email: 'old@x.example', vcardData: noUidCard },
    { id: 'cx', userId: 'u2', uid: 'BBB-2', displayName: 'Foreign', email: 'f@x.example', vcardData: '' },
  );
  const inner = contactGroupColumns('', 'Inner', [{ kind: 'card', uid: 'legacy-1' }, { kind: 'card', uid: 'BBB-2' }]);
  db.contactGroup.push({ id: 'g-in', userId: 'u1', ...inner });
  const outer = contactGroupColumns('', 'Outer', [{ kind: 'card', uid: 'AAA-1' }, { kind: 'card', uid: inner.uid }]);
  db.contactGroup.push({ id: 'g-out', userId: 'u1', ...outer });

  const found = await resolveCards('u1', ['AAA-1', 'legacy-1', 'BBB-2']);
  assert.deepEqual([...found.keys()].sort(), ['AAA-1', 'legacy-1'], 'another user\'s card never resolves');
  assert.equal(db.contact.find((r) => r['id'] === 'c2')!['uid'], 'legacy-1', 'pre-9.5 row: uid column filled by the lookup');
  assert.equal(db.contact.find((r) => r['id'] === 'c3')!['uid'], '', 'a vCard without UID stays as it is');

  const exp = await expandContactGroup('u1', outer.members);
  assert.deepEqual(exp.recipients.map((r) => r.address), ['anna@x.example', 'lea@x.example']);
  assert.deepEqual(exp.skipped, [{ reason: 'missing', name: '' }]);

  assert.deepEqual(await detachCardFromGroups('u1', 'urn:uuid:AAA-1'), ['g-out']);
  const g = db.contactGroup.find((r) => r['id'] === 'g-out')!;
  assert.deepEqual(g['members'], [{ kind: 'card', uid: inner.uid }]);
  assert.ok(!String(g['vcardData']).includes('AAA-1'), 'vCard follows the members');
  assert.deepEqual(await detachCardFromGroups('u2', inner.uid), [], 'other users are not touched');

  assert.equal(await ensureContactUid({ id: 'c2', uid: '', vcardData: legacyCard }), 'legacy-1');
  assert.equal(db.contact.find((r) => r['id'] === 'c2')!['uid'], 'legacy-1');
  const added = await ensureContactUid({ id: 'c3', uid: '', vcardData: noUidCard });
  assert.ok(added);
  assert.equal(vcardUidKey(String(db.contact.find((r) => r['id'] === 'c3')!['vcardData'])), added, 'UID written into the vCard');

  // Review 9.5: a row without a readable vCard keeps its flat columns when it gets a UID
  db.contact.push({ id: 'c4', userId: 'u1', uid: '', displayName: 'Flach', email: 'flach@x.example', phone: '+49 30 1', company: 'F', vcardData: '' });
  const flatUid = await ensureContactUid({ id: 'c4', uid: '', vcardData: '', displayName: 'Flach', email: 'flach@x.example', phone: '+49 30 1', company: 'F' });
  const c4 = db.contact.find((r) => r['id'] === 'c4')!;
  assert.deepEqual([c4['uid'], c4['email'], c4['phone'], c4['company']], [flatUid, 'flach@x.example', '+49 30 1', 'F']);
});

// Review 9.5: a client's mailto: member must never inject vCard lines when the group is written back
test('memberFromUri refuses CR/LF, control characters, blanks and malformed percent-encoding', () => {
  assert.equal(memberFromUri('mailto:a%0D%0AEND:VCARD%0D%0ABEGIN:VCARD@example.com'), null);
  assert.equal(memberFromUri('mailto:a%00b@example.com'), null);
  assert.equal(memberFromUri('mailto:a b@example.com'), null);
  assert.equal(memberFromUri('mailto:no-at-sign'), null);
  assert.equal(memberFromUri('mailto:%E0%A4%A'), null); // would throw URIError
  assert.deepEqual(memberFromUri('mailto:Team%40x@example.com'), null); // two "@"
  assert.deepEqual(memberFromUri('mailto:alex@example.com'), { kind: 'address', address: 'alex@example.com', name: '' });
});

test('a group vCard with an injected mailto member is rewritten without the injection', () => {
  const evil = [
    'BEGIN:VCARD', 'VERSION:4.0', 'KIND:group', 'FN:Evil', 'UID:urn:uuid:EVIL-1',
    'MEMBER:mailto:x%0D%0AEMAIL:attacker@example.com%0D%0AX@example.com', 'MEMBER:mailto:ok@example.com', 'END:VCARD', '',
  ].join('\r\n');
  const data = contactGroupFromVcard(evil)!;
  assert.deepEqual(data.members, [{ kind: 'address', address: 'ok@example.com', name: '' }]);
  const written = applyContactGroup(evil, { name: 'Evil 2', members: data.members });
  assert.ok(!lines(written).some((l) => l.startsWith('EMAIL')), written);
  assert.equal(lines(written).filter((l) => l === 'END:VCARD').length, 1);
});

test('membersFromJson drops stored members with control characters', () => {
  assert.deepEqual(membersFromJson([
    { kind: 'address', address: 'a\r\nEMAIL:x@example.com', name: '' },
    { kind: 'card', uid: 'u\n1' },
    { kind: 'address', address: 'b@example.com', name: 'B\r\nX' },
  ]), [{ kind: 'address', address: 'b@example.com', name: '' }]);
});
