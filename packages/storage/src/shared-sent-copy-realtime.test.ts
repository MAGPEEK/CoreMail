/**
 * 9.4 integration (mailbox management × realtime): the Sent copy stored in a
 * Shared Mailbox for a send as / on behalf is announced once, after its
 * attachment rows and the folder counter are written (deferMailboxChanges) —
 * a client that re-reads on the event sees the finished message.
 * In-memory Prisma fake + object-store seam.
 * Run: node --import tsx --import ./src/test-support/realtime-off.ts --test src/shared-sent-copy-realtime.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

const { emptyDb, createFake } = await import('./test-support/mailbox-fake.js');
const db = emptyDb();
const fake = createFake(db) as Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>>;
const order: string[] = [];
for (const [model, method, label] of [['attachment', 'create', 'attachment'], ['folder', 'update', 'counter']] as const) {
  const original = fake[model]![method]!;
  fake[model]![method] = async (...args: unknown[]) => { const r = await original(...args); order.push(label); return r; };
}
(globalThis as unknown as { __prisma: unknown }).__prisma = fake;
const objects = new Map<string, Buffer>();
(globalThis as unknown as { __objectStore: unknown }).__objectStore = {
  driver: 'memory', location: 'memory',
  exists: async (k: string) => objects.has(k),
  put: async (k: string, d: Buffer) => { objects.set(k, d); },
};

const { storeRawInSentFolder } = await import('./shared-sent-copy.js');
const { setMailboxChangePublisher } = await import('./realtime/change-scope.js');

const RAW = Buffer.from([
  'From: Team <team@example.test>',
  'Sender: bob@example.test',
  'To: carol@ext.test',
  'Subject: Report',
  'Date: Wed, 18 Nov 2026 08:00:00 +0000',
  'Message-ID: <r1@example.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain',
  '',
  'see attached',
  '--b',
  'Content-Type: application/pdf; name="r.pdf"',
  'Content-Disposition: attachment; filename="r.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQK',
  '--b--',
  '',
].join('\r\n'));

test('shared Sent copy: one announcement, after the attachment rows and the folder counter', async () => {
  db.mailboxes.push({ id: 'mb-team', sharedBoxId: 's1', uidNext: 1, highestModSeq: 0n, uidValidity: 1 });
  db.folders.push({ id: 'sent', mailboxId: 'mb-team', name: 'Sent', displayName: 'Sent', totalCount: 0, unreadCount: 0 });
  const seen: Array<Record<string, unknown>> = [];
  setMailboxChangePublisher(async (e) => { order.push('publish'); seen.push(e as unknown as Record<string, unknown>); });
  try {
    const id = await storeRawInSentFolder('mb-team', RAW);
    assert.ok(id, 'copy stored');
    assert.deepEqual(order, ['attachment', 'counter', 'publish'], 'announced once the copy is complete');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!['mailboxId'], 'mb-team');
    assert.deepEqual(seen[0]!['folderIds'], ['sent']);
    assert.equal(db.folders.find((f) => f['id'] === 'sent')!['totalCount'], 1);
  } finally {
    setMailboxChangePublisher(null);
  }
});
