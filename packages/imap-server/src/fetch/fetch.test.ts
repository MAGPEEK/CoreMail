/**
 * FETCH from the raw message: item parser, sections (byte-exact), partial fetches,
 * BODYSTRUCTURE of nested multiparts, ENVELOPE quoting (CR/LF injection → literal),
 * and handleFetch end-to-end with fake Prisma + fake object storage.
 * Run: node --import tsx --test src/fetch/fetch.test.ts  (in packages/imap-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

// ── Fakes: object storage + Prisma ──────────────────────────────────────────
const objects = new Map<string, Buffer>();
(globalThis as unknown as { __minioClient: unknown }).__minioClient = {
  getObject: async (_b: string, key: string) => {
    const data = objects.get(key);
    if (!data) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' });
    return Readable.from([data]);
  },
  putObject: async (_b: string, key: string, data: Buffer) => { objects.set(key, Buffer.from(data)); return {}; },
  statObject: async (_b: string, key: string) => {
    if (!objects.has(key)) throw Object.assign(new Error('NotFound'), { code: 'NotFound' });
    return { size: objects.get(key)!.length };
  },
};

interface Row { id: string; uid: number; modSeq: bigint; flags: string[]; storagePath: string | null; rawSize: number; [k: string]: unknown }
let rows: Row[] = [];
const prismaFake = {
  $on: () => undefined,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(prismaFake),
  message: {
    findMany: async () => rows.map((r) => ({ ...r, flags: [...r.flags] })),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    },
    updateMany: async ({ where, data }: { where: { id: string; storagePath?: null }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === where.id && (where.storagePath !== null || x.storagePath === null));
      if (r) Object.assign(r, data);
      return { count: r ? 1 : 0 };
    },
    aggregate: async () => ({ _max: { modSeq: 1n, uid: 1 } }),
    count: async () => rows.length,
  },
  // view sync stamp (session/view.ts syncStampOf)
  folder: { findFirst: async () => ({ mailbox: { highestModSeq: 50n } }) },
  mailbox: {
    update: async () => ({ uidNext: 10, highestModSeq: 50n }),
    updateMany: async () => ({ count: 0 }),
  },
  attachment: { findMany: async () => [] },
};
(globalThis as unknown as { __prisma: unknown }).__prisma = prismaFake;

const { NESTED_MESSAGE, SIMPLE_MESSAGE } = await import('../../../storage/src/mime/fixtures.js');
const { parseMimeTree, storeRawMessage } = await import('@coremail/storage');
const { parseFetchItems, parseSection, sectionLabel, FetchParseError } = await import('./fetch-items.js');
const { extractSection, applyPartial, renderBodyStructure, renderEnvelope, envelopeFromDb, envelopeFromHeaders } = await import('./render.js');
const { toBuffer, imapString, flagList, mailboxName } = await import('./imap-string.js');
const { handleFetch } = await import('../commands/index.js');

const str = (chunks: Array<string | Buffer>): string => toBuffer(chunks).toString('utf8');
const section = (spec: string): string => {
  const out = extractSection(NESTED_MESSAGE, parseMimeTree(NESTED_MESSAGE), parseSection(spec));
  return out === null ? '<NIL>' : out.toString('utf8');
};

// ── Item parser ──────────────────────────────────────────────────────────────

test('FETCH items: macros, sections, partials, errors', () => {
  assert.deepEqual(parseFetchItems('FAST').map((i) => i.kind), ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE']);
  const items = parseFetchItems('(UID BODY.PEEK[1.HEADER.FIELDS.NOT (Subject "From")]<5.10> body[] RFC822.SIZE)');
  assert.equal(items.length, 4);
  const sec = items[1]!;
  assert.ok(sec.kind === 'SECTION');
  assert.equal(sec.peek, true);
  assert.deepEqual(sec.section, { path: [1], kind: 'HEADER.FIELDS.NOT', fields: ['SUBJECT', 'FROM'] });
  assert.deepEqual(sec.partial, { origin: 5, length: 10 });
  assert.equal(sectionLabel(sec.section), '1.HEADER.FIELDS.NOT (SUBJECT FROM)');
  assert.equal(sectionLabel(parseSection('2.MIME')), '2.MIME');
  for (const bad of ['(FLAGS BOGUS)', '(ALL FLAGS)', 'BODY[MIME]', 'BODY[0]', 'BODY[]<1>', 'BODY[1.FOO]', '']) {
    assert.throws(() => parseFetchItems(bad), FetchParseError, bad);
  }
});

// ── Sections (byte-exact against the raw fixture) ────────────────────────────

test('BODY[] / HEADER / TEXT / n / n.MIME / message/rfc822 sub-sections are byte-exact', () => {
  const raw = NESTED_MESSAGE.toString('utf8');
  const blank = raw.indexOf('\r\n\r\n') + 4;
  assert.equal(section(''), raw);
  assert.equal(section('HEADER'), raw.slice(0, blank));
  assert.equal(section('TEXT'), raw.slice(blank));
  assert.equal(section('1.1'), 'Hello Bob,\r\nsee attached.');
  assert.equal(section('1.2.MIME'), 'Content-Type: text/html; charset=utf-8\r\n\r\n');
  assert.match(section('2.MIME'), /^Content-Type: application\/pdf; name="report.pdf"\r\n[\s\S]*\r\n\r\n$/);
  assert.equal(section('3.HEADER.FIELDS (SUBJECT)'), 'Subject: Original\r\n\r\n');
  assert.equal(section('3.TEXT').startsWith('--inner\r\n'), true);
  assert.equal(section('3.1'), 'Inner text');
  assert.equal(section('3.2'), 'iVBORw0KGgo=');
  assert.equal(section('HEADER.FIELDS (TO CC)'), 'To: Bob <bob@example.test>, carol@example.test\r\nCc: Team: dave@example.test, erin@example.test;\r\n\r\n');
  assert.equal(section('9'), '<NIL>');
  assert.equal(section('2.HEADER'), '<NIL>');
  // partial: origin and length in octets; origin beyond the end → empty
  const data = Buffer.from('0123456789');
  assert.equal(applyPartial(data, { origin: 2, length: 3 }).toString(), '234');
  assert.equal(applyPartial(data, { origin: 8, length: 100 }).toString(), '89');
  assert.equal(applyPartial(data, { origin: 20, length: 1 }).length, 0);
});

test('BODYSTRUCTURE of multipart/mixed(alternative, attachment, message/rfc822(mixed))', () => {
  const tree = parseMimeTree(NESTED_MESSAGE);
  const bs = str(renderBodyStructure(NESTED_MESSAGE, tree, true));
  assert.equal(bs,
    '(('
    + '("text" "plain" ("charset" "utf-8") NIL NIL "QUOTED-PRINTABLE" 25 2 NIL NIL NIL NIL)'
    + '("text" "html" ("charset" "utf-8") NIL NIL "7BIT" 34 1 NIL NIL NIL NIL)'
    + ' "alternative" ("boundary" "alt") NIL NIL NIL)'
    + '("application" "pdf" ("name" "report.pdf") NIL "The report" "BASE64" 72 NIL ("attachment" ("filename" "report.pdf")) NIL NIL)'
    + '("message" "rfc822" NIL NIL NIL "7BIT" 429 '
    + '("Mon, 02 Feb 2026 09:00:00 +0000" "Original" (("Frank" NIL "frank" "example.test")) (("Frank" NIL "frank" "example.test")) (("Frank" NIL "frank" "example.test")) ((NIL NIL "alice" "example.test")) NIL NIL NIL "<inner-1@example.test>") '
    + '(("text" "plain" ("charset" "us-ascii") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)'
    + '("image" "png" NIL "<logo@example.test>" NIL "BASE64" 12 NIL ("inline" NIL) NIL NIL) "mixed" ("boundary" "inner") NIL NIL NIL) 20'
    + ' NIL NIL NIL NIL)'
    + ' "mixed" ("boundary" "outer") NIL NIL NIL)');
  // BODY (non-extensible) omits the extension data
  const body = str(renderBodyStructure(SIMPLE_MESSAGE, parseMimeTree(SIMPLE_MESSAGE), false));
  assert.equal(body, '("text" "plain" ("charset" "us-ascii") NIL NIL "7BIT" 31 3)');
});

test('ENVELOPE from headers: groups and Cc', () => {
  const env = str(renderEnvelope(envelopeFromHeaders(parseMimeTree(NESTED_MESSAGE).headers)));
  assert.match(env, /^\("Tue, 03 Feb 2026 10:20:30 \+0000" "Quarterly report" \(\("Alice Example" NIL "alice" "example.test"\)\)/);
  assert.match(env, / \(\("Bob" NIL "bob" "example.test"\)\(NIL NIL "carol" "example.test"\)\) /);
  assert.match(env, / \(\(NIL NIL "Team" NIL\)\(NIL NIL "dave" "example.test"\)\(NIL NIL "erin" "example.test"\)\(NIL NIL NIL NIL\)\) NIL NIL "<nested-1@example.test>"\)$/);
});

test('ENVELOPE: CR/LF in subject or name never ends the response line', () => {
  // Raw header bytes with a bare CR are possible on the wire; they must become a literal.
  const fromHeaders = str(renderEnvelope({
    date: null, subject: 'x\r\n* OK [ALERT] pwned', from: '"Eve\r\nA1 OK" <eve@evil.test>', sender: null,
    replyTo: null, to: null, cc: null, bcc: null, inReplyTo: null, messageId: null,
  }));
  assert.ok(!/\r\n\* OK/.test(fromHeaders.replace(/\{\d+\}\r\n/g, '')) || /\{\d+\}\r\nx\r\n\* OK/.test(fromHeaders));
  assert.match(fromHeaders, /\{21\}\r\nx\r\n\* OK \[ALERT\] pwned/);
  assert.match(fromHeaders, /\(\(\{10\}\r\nEve\r\nA1 OK NIL "eve" "evil.test"\)\)/);
  // From the database: sanitized and RFC 2047-encoded → quoted, single line
  const fromDb = str(renderEnvelope(envelopeFromDb({
    date: new Date('2026-02-03T10:20:30Z'), subject: 'Hi\r\n* OK [ALERT] pwned', fromAddr: 'eve@evil.test',
    fromName: 'Eve\r\nA1 OK', toAddrs: ['bob@example.test'], ccAddrs: ['carol@example.test'], bccAddrs: [],
    replyTo: null, messageId: '<m@x>\r\n* BYE', inReplyTo: null,
  })));
  assert.ok(!fromDb.includes('\r') && !fromDb.includes('\n'), fromDb);
  assert.match(fromDb, /"Hi \* OK \[ALERT\] pwned"/);
  assert.match(fromDb, /\(\("Eve A1 OK" NIL "eve" "evil.test"\)\)/);
  assert.match(fromDb, /\(\(NIL NIL "carol" "example.test"\)\)/);
});

test('strings, flags and mailbox names are rendered safely', () => {
  assert.equal(str(imapString('a"b\\c')), '"a\\"b\\\\c"');
  assert.equal(str(imapString('Grüße')), '{7}\r\nGrüße');
  assert.equal(flagList(['\\Seen', '$Label', 'bad flag', 'x\r\n* BYE', '(paren']), '(\\Seen $Label)');
  assert.equal(mailboxName('Work "x"'), '"Work \\"x\\""');
  assert.equal(mailboxName('A\r\nB'), '{4}\r\nA\r\nB');
});

// ── handleFetch end to end ───────────────────────────────────────────────────

function session() {
  const out: Buffer[] = [];
  return {
    out,
    text: () => Buffer.concat(out).toString('utf8'),
    s: {
      id: 's1', state: 'SELECTED', userId: 'u1', mailboxId: 'mb1', condstoreEnabled: false,
      // v7.1.0: the session's sequence map is built from the rows of the test
      selected: {
        folderId: 'f1', folderName: 'INBOX', uidValidity: 1, readOnly: false,
        uids: rows.map((r) => r.uid).sort((a, b) => a - b),
        known: new Map(rows.map((r) => [r.uid, r.modSeq])),
        searchRes: [],
      },
      socket: { write: (d: string | Buffer) => { out.push(Buffer.isBuffer(d) ? d : Buffer.from(d)); return true; } },
    },
  };
}

const baseRow = (over: Partial<Row>): Row => ({
  id: 'm1', uid: 7, modSeq: 5n, flags: [], storagePath: null, rawSize: 0, subject: 'S', fromAddr: 'a@x.test',
  fromName: '', toAddrs: ['b@x.test'], ccAddrs: [], bccAddrs: [], replyTo: null, messageId: '<m1@x.test>',
  inReplyTo: null, date: new Date('2026-02-03T10:20:30Z'), createdAt: new Date('2026-02-03T10:20:31Z'),
  bodyText: 'legacy body', bodyHtml: '', attachments: [], ...over,
});

test('handleFetch serves the stored raw message byte-exactly and RFC822.SIZE matches', async () => {
  const { storagePath, size } = await storeRawMessage(NESTED_MESSAGE);
  rows = [baseRow({ storagePath, rawSize: size, flags: ['\\Seen'] })];
  const { s, text } = session();
  await handleFetch(s as never, 'A1', ['1', '(RFC822.SIZE BODY.PEEK[3.1] BODY.PEEK[]<0.20> BODY.PEEK[HEADER.FIELDS (SUBJECT)])'], false);
  const t = text();
  assert.match(t, new RegExp(`^\\* 1 FETCH \\(UID 7 RFC822\\.SIZE ${NESTED_MESSAGE.length} BODY\\[3\\.1\\] \\{10\\}\\r\\nInner text BODY\\[\\]<0> \\{20\\}\\r\\nReturn-Path: <alice@ BODY\\[HEADER\\.FIELDS \\(SUBJECT\\)\\] \\{31\\}\\r\\nSubject: Quarterly\\r\\n report\\r\\n\\r\\n\\)\\r\\nA1 OK`));
});

test('handleFetch: legacy row is reconstructed, persisted, and BODY[] sets \\Seen', async () => {
  rows = [baseRow({ subject: 'Hi\r\nX-Injected: 1', bodyText: 'line\r\n.dot' })];
  const { s, text } = session();
  await handleFetch(s as never, 'A2', ['7', '(RFC822.SIZE BODY[])'], true);
  const t = text();
  const size = Number(/RFC822\.SIZE (\d+)/.exec(t)?.[1]);
  const lit = /BODY\[\] \{(\d+)\}\r\n/.exec(t);
  assert.equal(size, Number(lit?.[1]));
  assert.ok(!/\r\nX-Injected: 1\r\n/.test(t), 'CR/LF in the stored subject must not create a header');
  assert.match(t, /FLAGS \(\\Seen\)/);
  assert.deepEqual(rows[0]!.flags, ['\\Seen']);
  assert.ok(rows[0]!.storagePath?.startsWith('raw/'), 'reconstruction persisted (lazy migration)');
  assert.equal(objects.get(rows[0]!.storagePath!)!.length, size);
});

test('handleFetch: missing object → NO, unknown item → BAD', async () => {
  rows = [baseRow({ storagePath: 'raw/zz/missing.eml', rawSize: 10 })];
  let sess = session();
  await handleFetch(sess.s as never, 'A3', ['1', 'BODY.PEEK[]'], false);
  assert.match(sess.text(), /^A3 NO \[UNAVAILABLE\]/);
  sess = session();
  await handleFetch(sess.s as never, 'A4', ['1', '(FLAGS FOO)'], false);
  assert.match(sess.text(), /^A4 BAD /);
});

test('handleFetch: BODYSTRUCTURE and CHANGEDSINCE', async () => {
  const { storagePath, size } = await storeRawMessage(SIMPLE_MESSAGE);
  rows = [baseRow({ storagePath, rawSize: size, modSeq: 3n }), baseRow({ id: 'm2', uid: 8, storagePath, rawSize: size, modSeq: 9n })];
  const { s, text } = session();
  await handleFetch(s as never, 'A5', ['1:*', '(BODYSTRUCTURE)', '(CHANGEDSINCE 5)'], false);
  assert.equal(text(), '* 2 FETCH (UID 8 BODYSTRUCTURE ("text" "plain" ("charset" "us-ascii") NIL NIL "7BIT" 31 3 NIL NIL NIL NIL) MODSEQ (9))\r\nA5 OK FETCH completed\r\n');
});
