/**
 * Backup export of ORIGINAL messages (mboxrd + EML) and the MBOX restore round trip.
 * Fake Prisma + fake object storage, temp files only.
 * Run: node --import tsx --test src/export/mbox.test.ts  (in packages/backup-service)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

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
    return {};
  },
};

let rows: Array<Record<string, unknown>> = [];
const created: Array<Record<string, unknown>> = [];
const attachmentsCreated: Array<Record<string, unknown>> = [];
const prismaFake = {
  $on: () => undefined,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(prismaFake),
  mailbox: {
    findFirst: async () => ({ id: 'mb1' }),
    update: async () => ({ uidNext: 2, highestModSeq: 1n }),
    updateMany: async () => ({ count: 0 }),
  },
  folder: {
    findMany: async () => [{ id: 'f1' }],
    findUnique: async () => ({ name: 'INBOX' }),
    findFirst: async () => ({ id: 'f1', mailboxId: 'mb1' }),
    update: async () => ({}),
  },
  message: {
    findMany: async ({ skip }: { skip: number }) => (skip === 0 ? rows : []),
    aggregate: async () => ({ _max: { modSeq: null, uid: null } }),
    findFirst: async () => null, // 9.3: restore dedupe lookup (nothing restored yet)
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `new-${created.length + 1}`, ...data };
      created.push(row);
      return row;
    },
  },
  attachment: { create: async ({ data }: { data: Record<string, unknown> }) => { attachmentsCreated.push(data); return data; } },
};
(globalThis as unknown as { __prisma: unknown }).__prisma = prismaFake;

const { storeRawMessage } = await import('@coremail/storage');
const { exportMbox, exportEmlStream, mboxEntry, mboxDate } = await import('./mbox.js');
const { importMbox } = await import('../restore/index.js');
const { NESTED_MESSAGE } = await import('../../../storage/src/mime/fixtures.js');

const WITH_FROM_LINES = Buffer.from(
  'From: a@x.test\r\nTo: b@x.test\r\nSubject: quoting\r\n\r\nFrom here on\r\n>From quoted\r\nend\r\n',
);

const legacy = {
  id: 'l1', uid: 3, storagePath: null, subject: 'Legacy', fromAddr: 'old@x.test', fromName: 'Old',
  toAddrs: ['b@x.test'], ccAddrs: [], replyTo: null, messageId: '<l1@x.test>', inReplyTo: null,
  date: new Date('2025-01-01T00:00:00Z'), bodyText: 'legacy text', bodyHtml: '', flags: [],
  attachments: [{ filename: 'n.txt', mimeType: 'text/plain', storagePath: 'attachments/l1/0', contentId: null, inline: false }],
};

test('mboxDate / mboxEntry: asctime separator and mboxrd quoting', () => {
  assert.equal(mboxDate(new Date('2026-02-03T10:20:30Z')), 'Tue Feb  3 10:20:30 2026');
  const entry = mboxEntry(WITH_FROM_LINES, 'a@x.test', new Date('2026-02-03T10:20:30Z')).toString();
  assert.ok(entry.startsWith('From a@x.test Tue Feb  3 10:20:30 2026\r\nFrom: a@x.test\r\n'));
  assert.ok(entry.includes('\r\n>From here on\r\n>>From quoted\r\n'));
  assert.ok(entry.endsWith('end\r\n\r\n'));
});

test('MBOX + EML export contain the original raw messages (attachments, all headers); round trip restores them', async () => {
  objects.set('attachments/l1/0', Buffer.from('legacy attachment'));
  const a = await storeRawMessage(NESTED_MESSAGE);
  const b = await storeRawMessage(WITH_FROM_LINES);
  rows = [
    { ...legacy, id: 'm1', uid: 1, storagePath: a.storagePath, fromAddr: 'alice@example.test', attachments: [] },
    { ...legacy, id: 'm2', uid: 2, storagePath: b.storagePath, fromAddr: 'a@x.test', attachments: [] },
    legacy,
  ];
  const dir = mkdtempSync(join(tmpdir(), 'coremail-mbox-'));
  const out = join(dir, 'export.mbox');
  const { messageCount, sizeBytes } = await exportMbox('u1', null, out);
  const file = readFileSync(out);
  assert.equal(messageCount, 3);
  assert.equal(sizeBytes, file.length);
  const text = file.toString('latin1');
  assert.ok(text.includes(NESTED_MESSAGE.toString('latin1')), 'nested message with attachment exported byte-exactly');
  assert.ok(text.includes('Content-Disposition: attachment; filename="report.pdf"'));
  assert.ok(text.includes(Buffer.from('legacy attachment').toString('base64')), 'legacy attachment content included');

  const eml = [];
  for await (const e of exportEmlStream('u1', null)) eml.push(e);
  assert.deepEqual(eml.map((e) => e.filename), ['INBOX/1.eml', 'INBOX/2.eml', 'INBOX/3.eml']);
  assert.deepEqual(eml[0]!.content, NESTED_MESSAGE);
  assert.deepEqual(eml[1]!.content, WITH_FROM_LINES);

  // Restore: every message comes back as its original raw object.
  writeFileSync(join(dir, 'in.mbox'), file);
  const res = await importMbox('u1', 'f1', join(dir, 'in.mbox'));
  assert.deepEqual(res, { imported: 3, errors: 0, duplicates: 0 });
  assert.deepEqual(objects.get(created[0]!['storagePath'] as string), NESTED_MESSAGE);
  assert.deepEqual(objects.get(created[1]!['storagePath'] as string), WITH_FROM_LINES);
  assert.equal(created[0]!['subject'], 'Quarterly report');
  assert.equal(created[0]!['rawSize'], NESTED_MESSAGE.length);
  assert.ok(attachmentsCreated.some((x) => x['filename'] === 'report.pdf'));
});
