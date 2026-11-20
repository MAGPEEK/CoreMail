/**
 * 10.2: search suggestions — query normalisation, the bounded where-objects,
 * people de-duplication / ranking and the query runner with a fake client.
 * Run: node --import tsx --test src/lib/search-suggest.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSuggestQuery, likeContains, suggestMessageWhere, suggestSenderWhere, suggestContactWhere,
  mergePeople, wordStartMatch, toMessageSuggestions, sentFolderOf, loadSuggestions,
  MAX_MESSAGES, MAX_PEOPLE, SENDER_SCAN, CONTACT_SCAN, RECIPIENT_SCAN, RECIPIENT_WINDOW, SUGGEST_MAX_LENGTH,
  type SuggestDb,
} from './search-suggest.js';

type Row = Record<string, unknown>;

test('query: 2–100 characters, whitespace collapsed, control characters dropped, one string only', () => {
  assert.equal(normalizeSuggestQuery('  an  na '), 'an na');
  assert.equal(normalizeSuggestQuery('a'), null);
  assert.equal(normalizeSuggestQuery(' a '), null);
  assert.equal(normalizeSuggestQuery(''), null);
  assert.equal(normalizeSuggestQuery(undefined), null);
  assert.equal(normalizeSuggestQuery(['ab', 'cd']), null);
  assert.equal(normalizeSuggestQuery({ q: 'ab' }), null);
  assert.equal(normalizeSuggestQuery('a\u0000b'), 'a b');
  assert.equal(normalizeSuggestQuery('x'.repeat(500))!.length, SUGGEST_MAX_LENGTH);
  // characters, not UTF-16 units: an emoji is not cut in half
  const emoji = '😀'.repeat(150);
  assert.equal([...normalizeSuggestQuery(emoji)!].length, SUGGEST_MAX_LENGTH);
  assert.equal(normalizeSuggestQuery('ü'), null);
  assert.equal(normalizeSuggestQuery('üb'), 'üb');
});

test('LIKE pattern escapes the wildcards and the escape character', () => {
  assert.equal(likeContains('anna'), '%anna%');
  assert.equal(likeContains('50%_off\\x'), '%50\\%\\_off\\\\x%');
  // Prisma does not escape `contains` — the builders do (a typed "_" is no wildcard)
  assert.deepEqual((suggestMessageWhere(['f1'], 'a_b%') as { OR: Array<Record<string, { contains: string }>> }).OR[0]!['subject']!.contains, 'a\\_b\\%');
  assert.deepEqual((suggestSenderWhere(['f1'], 'x\\y') as { OR: Array<Record<string, { contains: string }>> }).OR[1]!['fromAddr']!.contains, 'x\\\\y');
  assert.deepEqual((suggestContactWhere('u', '1_0') as { OR: Array<Record<string, { contains: string }>> }).OR[1]!['email']!.contains, '1\\_0');
});

test('where-objects: only the given folders, live messages, subject / sender — never the body', () => {
  const w = suggestMessageWhere(['f1', 'f2'], 'Rech');
  assert.deepEqual(w, {
    folderId: { in: ['f1', 'f2'] },
    deletedAt: null,
    OR: [
      { subject: { contains: 'Rech', mode: 'insensitive' } },
      { fromName: { contains: 'Rech', mode: 'insensitive' } },
      { fromAddr: { contains: 'Rech', mode: 'insensitive' } },
    ],
  });
  assert.doesNotMatch(JSON.stringify(w), /bodyText|bodyHtml/);
  assert.deepEqual(suggestSenderWhere(['f1'], 'an'), {
    folderId: { in: ['f1'] },
    deletedAt: null,
    OR: [{ fromName: { contains: 'an', mode: 'insensitive' } }, { fromAddr: { contains: 'an', mode: 'insensitive' } }],
  });
  assert.deepEqual(suggestContactWhere('u1', 'an'), {
    userId: 'u1',
    OR: [
      { displayName: { contains: 'an', mode: 'insensitive' } },
      { email: { contains: 'an', mode: 'insensitive' } },
      { email2: { contains: 'an', mode: 'insensitive' } },
    ],
  });
});

test('people: de-duplicated by address (case-insensitive), a later source fills a missing name', () => {
  const people = mergePeople([
    { name: '', address: 'Anna.Koch@ex.com' },
    { name: 'Anna Koch', address: 'anna.koch@ex.com' },
    { name: 'Other Name', address: 'ANNA.KOCH@EX.COM' },
  ], 'anna');
  assert.deepEqual(people, [{ name: 'Anna Koch', address: 'Anna.Koch@ex.com' }]);
});

test('people: word-start matches first, then the source order; at most 4; junk addresses dropped', () => {
  const people = mergePeople([
    { name: 'Johanna Berg', address: 'jb@ex.com' },          // "anna" inside a word
    { name: 'Bernd', address: 'bernd@hannahs.de' },          // inside a word
    { name: 'Anna Weber', address: 'aw@ex.com' },             // name word start
    { name: '', address: 'not an address' },
    { name: 'x', address: '' },
    { name: 'y', address: 'a@b@c' },
    { name: 'Max', address: 'anna.max@ex.com' },              // address start
    { name: 'Z', address: 'z.anna@ex.com' },                  // local-part word start
    { name: 'Q', address: 'q@anna.org' },                     // domain word start
  ], 'anna');
  assert.deepEqual(people.map((p) => p.address), ['aw@ex.com', 'anna.max@ex.com', 'z.anna@ex.com', 'q@anna.org']);
  assert.equal(mergePeople(Array.from({ length: 10 }, (_, i) => ({ name: `Anna ${i}`, address: `a${i}@ex.com` })), 'anna').length, MAX_PEOPLE);
  assert.equal(wordStartMatch({ name: 'Johanna', address: 'j@ex.com' }, 'anna'), false);
  assert.equal(wordStartMatch({ name: 'Müller, Anna', address: 'm@ex.com' }, 'anna'), true);
});

test('people: names are trimmed and capped; addresses keep their spelling', () => {
  const [p] = mergePeople([{ name: `  ${'N'.repeat(300)}  `, address: ' Mixed@Ex.com ' }], 'mixed');
  assert.equal(p!.name.length, 200);
  assert.equal(p!.address, 'Mixed@Ex.com');
});

test('message suggestions carry the folder display name and an ISO date', () => {
  const folders = [{ id: 'f1', name: 'INBOX', displayName: 'Posteingang' }, { id: 'f2', name: 'Projekte', displayName: '' }];
  assert.deepEqual(toMessageSuggestions([
    { id: 'm1', folderId: 'f1', subject: 'Hi', fromName: 'A', fromAddr: 'a@ex.com', date: new Date('2026-01-02T03:04:05Z') },
    { id: 'm2', folderId: 'f2', subject: null, fromName: null, fromAddr: null, date: '2026-01-01T00:00:00Z' },
  ], folders), [
    { id: 'm1', folderId: 'f1', folderName: 'Posteingang', subject: 'Hi', fromName: 'A', fromAddr: 'a@ex.com', date: '2026-01-02T03:04:05.000Z' },
    { id: 'm2', folderId: 'f2', folderName: 'Projekte', subject: '', fromName: '', fromAddr: '', date: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(sentFolderOf(folders), null);
  assert.equal(sentFolderOf([...folders, { id: 'f3', name: 'Sent', displayName: 'Gesendet' }]), 'f3');
});

/** A fake client recording every call. */
function fakeDb(rows: { messages?: Row[]; senders?: Row[]; recipients?: Row[]; contacts?: Row[] } = {}) {
  const calls: Array<{ kind: string; args: unknown }> = [];
  const db: SuggestDb = {
    message: {
      findMany: async (args) => {
        const a = args as { select: Row };
        const senderQuery = !('subject' in a.select);
        calls.push({ kind: senderQuery ? 'senders' : 'messages', args });
        return (senderQuery ? rows.senders : rows.messages) ?? [];
      },
    },
    contact: { findMany: async (args) => { calls.push({ kind: 'contacts', args }); return rows.contacts ?? []; } },
    $queryRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ kind: 'recipients', args: { sql: strings.join('?'), values } });
      return rows.recipients ?? [];
    }) as SuggestDb['$queryRaw'],
  };
  return { db, calls };
}

const FOLDERS = [
  { id: 'inbox', name: 'INBOX', displayName: 'Posteingang' },
  { id: 'sent', name: 'Sent', displayName: 'Gesendet' },
];

test('runner: every query bounded and scoped to the folders; recipients only from the Sent folder', async () => {
  const { db, calls } = fakeDb({
    messages: [{ id: 'm1', folderId: 'inbox', subject: 'Angebot Anna', fromName: 'Anna Koch', fromAddr: 'anna@ex.com', date: new Date(0) }],
    senders: [{ fromName: 'Anna Koch', fromAddr: 'anna@ex.com' }, { fromName: 'Anna Koch', fromAddr: 'Anna@Ex.com' }],
    recipients: [{ address: 'anna.weber@kunde.de' }],
    contacts: [{ displayName: 'Hanna Contact', email: 'hanna@ex.com', email2: 'private@home.de' }],
  });
  const r = await loadSuggestions(db, { q: 'anna', folders: FOLDERS, contactsOwnerId: 'u1' });
  const by = (k: string) => calls.find((c) => c.kind === k)!.args as Row;
  assert.deepEqual([by('messages')['take'], by('senders')['take'], by('contacts')['take']], [MAX_MESSAGES, SENDER_SCAN, CONTACT_SCAN]);
  assert.deepEqual(by('messages')['orderBy'], { date: 'desc' });
  assert.deepEqual((by('messages')['where'] as Row)['folderId'], { in: ['inbox', 'sent'] });
  assert.deepEqual(by('messages')['select'], { id: true, folderId: true, subject: true, fromName: true, fromAddr: true, date: true });
  assert.deepEqual((by('contacts')['where'] as Row)['userId'], 'u1');
  const raw = by('recipients') as { sql: string; values: unknown[] };
  assert.deepEqual(raw.values, ['sent', RECIPIENT_WINDOW, '%anna%', RECIPIENT_SCAN]);
  assert.match(raw.sql, /"folderId" = \?/);
  assert.match(raw.sql, /ORDER BY "date" DESC LIMIT \?/);
  assert.match(raw.sql, /ILIKE \?/);
  assert.deepEqual(r.people, [
    { name: 'Anna Koch', address: 'anna@ex.com' },
    { name: '', address: 'anna.weber@kunde.de' },
    // "Hanna" matches inside the word; its non-matching second address is not suggested
    { name: 'Hanna Contact', address: 'hanna@ex.com' },
  ]);
  assert.deepEqual(r.messages.map((m) => [m.id, m.folderName]), [['m1', 'Posteingang']]);
});

test('runner: no contacts without the contacts module, no raw query without a Sent folder, nothing without folders', async () => {
  const a = fakeDb();
  await loadSuggestions(a.db, { q: 'an', folders: [FOLDERS[0]!], contactsOwnerId: null });
  assert.deepEqual(a.calls.map((c) => c.kind).sort(), ['messages', 'senders']);
  const b = fakeDb({ contacts: [{ displayName: 'Anna', email: 'anna@ex.com', email2: '' }] });
  const r = await loadSuggestions(b.db, { q: 'an', folders: [], contactsOwnerId: 'u1' });
  assert.deepEqual(b.calls.map((c) => c.kind), ['contacts'], 'no message query over an empty folder list');
  assert.deepEqual(r, { people: [{ name: 'Anna', address: 'anna@ex.com' }], messages: [] });
  const c = fakeDb();
  assert.deepEqual(await loadSuggestions(c.db, { q: 'an', folders: [], contactsOwnerId: null }), { people: [], messages: [] });
  assert.equal(c.calls.length, 0);
});
