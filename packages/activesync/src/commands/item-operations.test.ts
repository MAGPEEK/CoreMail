/**
 * ItemOperations: Fetch of an attachment (FileReference, Range), Fetch of a full
 * message body (plain / HTML / MIME byte-exact), EmptyFolderContents — with the
 * same ownership filters as Sync/GetAttachment (the Prisma fake evaluates the
 * where clauses of prismaItemOperationsDeps). Before, ItemOperations answered
 * an empty 200, so devices could not download truncated bodies or attachments.
 * Run: node --import tsx --test src/commands/item-operations.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RAW_MESSAGE, PDF_BYTES, PNG_BYTES, messageRow, ATTACHMENT_ROWS, find, findAll, clientWbxml, testEnv, type ClientNode } from './test-fixtures.js';

testEnv();
// Ownership: inbox/msg1/att-* belong to u1; folder 'foreign' + 'att-foreign' to u2.
const FOLDERS = [{ id: 'inbox', mailboxId: 'mb1', userId: 'u1' }, { id: 'foreign', mailboxId: 'mb2', userId: 'u2' }];
const MESSAGES = [{ ...messageRow(), folderId: 'inbox', deletedAt: null }, { ...messageRow({ id: 'msg2' }), folderId: 'foreign', deletedAt: null }];
const ATTS = [
  ...ATTACHMENT_ROWS,
  { id: 'att-foreign', messageId: 'msg2', filename: 'secret.pdf', mimeType: 'application/pdf', size: 9, contentId: null, inline: false, storagePath: 'att/pdf' },
];
const txCalls: unknown[] = [];
type Where = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ownerOfMessage = (id: string) => FOLDERS.find((f) => f.id === MESSAGES.find((m) => m.id === id)?.folderId)?.userId;

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  folder: {
    findFirst: async ({ where }: { where: Where }) => {
      const f = FOLDERS.find((x) => x.id === where['id'] && x.userId === where['mailbox']?.userId);
      return f ? { id: f.id, mailboxId: f.mailboxId } : null;
    },
  },
  $transaction: async (fn: unknown) => { txCalls.push(fn); },
  message: {
    findMany: async ({ where }: { where: Where }) => MESSAGES.filter((m) => m.folderId === where['folderId'] && m.deletedAt === null).map((m) => ({ id: m.id })),
    findFirst: async ({ where }: { where: Where }) => {
      const m = MESSAGES.find((x) => x.id === where['id'] && x.folderId === where['folderId'] && x.deletedAt === null);
      if (!m) return null;
      const { folderId: _f, deletedAt: _d, modSeq: _s, ...cols } = m;
      return cols;
    },
  },
  attachment: {
    findFirst: async ({ where }: { where: Where }) => {
      const a = ATTS.find((x) => x.id === where['id']);
      if (!a || where['message']?.deletedAt !== null) return null;
      if (ownerOfMessage(a.messageId) !== where['message']?.folder?.mailbox?.userId) return null;
      return { mimeType: a.mimeType, size: a.size, storagePath: a.storagePath };
    },
    findMany: async ({ where }: { where: Where }) => ATTS.filter((a) => a.messageId === where['messageId']),
  },
};

const { handleItemOperations, prismaItemOperationsDeps, parseRange } = await import('./item-operations.js');
const { decodeWbxml, CP } = await import('../wbxml.js');

const OBJECTS: Record<string, Buffer> = { 'att/pdf': PDF_BYTES, 'att/logo': PNG_BYTES };
let emptied: string[] = [];
const deps = {
  ...prismaItemOperationsDeps(),
  readAttachment: async (p: string) => { const b = OBJECTS[p]; if (!b) throw new Error('missing'); return b; },
  loadRaw: async () => RAW_MESSAGE,
  emptyFolder: async (folderId: string) => { emptied.push(folderId); return 1; },
};
beforeEach(() => { emptied = []; });

const fetchAtt = (ref: string, range?: string): ClientNode =>
  [20, 0x06, [[20, 0x07, 'Mailbox'], [17, 0x11, ref], ...(range ? [[20, 0x08, [[20, 0x09, range]]] as ClientNode] : [])]];
const fetchItem = (col: string, id: string, options: ClientNode[] = []): ClientNode =>
  [20, 0x06, [[20, 0x07, 'Mailbox'], [0, 0x12, col], [0, 0x0d, id], ...(options.length ? [[20, 0x08, options] as ClientNode] : [])]];
async function run(...ops: ClientNode[]) {
  const req = decodeWbxml(clientWbxml([20, 0x05, ops]));
  const tree = decodeWbxml(await handleItemOperations(req, 'u1', deps));
  assert.equal(tree.name, 'ItemOperations');
  assert.equal(find(tree, 'Status', CP.ItemOperations)?.text, '1');
  const response = find(tree, 'Response', CP.ItemOperations)!;
  return (response.children ?? []).filter((c) => typeof c !== 'string') as ReturnType<typeof decodeWbxml>[];
}
const status = (e: ReturnType<typeof decodeWbxml>) => find(e, 'Status', CP.ItemOperations)?.text;

test('Fetch FileReference → base64 attachment bytes + ContentType', async () => {
  const [f] = await run(fetchAtt('att-pdf'));
  assert.equal(status(f!), '1');
  assert.equal(find(f!, 'FileReference', CP.AirSyncBase)?.text, 'att-pdf');
  assert.equal(find(f!, 'ContentType', CP.AirSyncBase)?.text, 'application/pdf');
  assert.deepEqual(Buffer.from(find(f!, 'Data', CP.ItemOperations)!.text!, 'base64'), PDF_BYTES);
});

test('Fetch FileReference with Range → Range, Total, partial data; bad range → Status 8', async () => {
  const [f] = await run(fetchAtt('att-logo', '0-3'));
  assert.equal(find(f!, 'Range', CP.ItemOperations)?.text, '0-3');
  assert.equal(find(f!, 'Total', CP.ItemOperations)?.text, String(PNG_BYTES.length));
  assert.deepEqual(Buffer.from(find(f!, 'Data', CP.ItemOperations)!.text!, 'base64'), PNG_BYTES.subarray(0, 4));
  const [bad] = await run(fetchAtt('att-logo', '99-100'));
  assert.equal(status(bad!), '8');
  assert.deepEqual(parseRange('5-2'), null);
});

test('Fetch of another user\'s / unknown attachment → Status 15, no data', async () => {
  const res = await run(fetchAtt('att-foreign'), fetchAtt('nope'));
  for (const f of res) {
    assert.equal(status(f), '15');
    assert.equal(find(f, 'Data'), undefined);
  }
});

test('Fetch ServerId with BodyPreference Type 4 + MIMESupport 2 → full MIME byte-exact', async () => {
  const [f] = await run(fetchItem('inbox', 'msg1', [[0, 0x22, '2'], [17, 0x05, [[17, 0x06, '4']]]]));
  assert.equal(status(f!), '1');
  assert.equal(find(f!, 'Class', CP.AirSync)?.text, 'Email');
  const props = find(f!, 'Properties', CP.ItemOperations)!;
  assert.equal(find(props, 'Subject', CP.Email)?.text, 'Quarterly report');
  assert.equal(find(props, 'Type', CP.AirSyncBase)?.text, '4');
  assert.equal(find(props, 'Truncated', CP.AirSyncBase)?.text, '0');
  assert.ok(find(props, 'Data', CP.AirSyncBase)?.bytes?.equals(RAW_MESSAGE));
  assert.equal(findAll(props, 'Attachment').length, 2);
});

test('Fetch ServerId with HTML preference → untruncated HTML; without Options → plain text', async () => {
  const [html] = await run(fetchItem('inbox', 'msg1', [[17, 0x05, [[17, 0x06, '2']]]]));
  assert.equal(find(html!, 'Data', CP.AirSyncBase)?.text, messageRow().bodyHtml);
  const [plain] = await run(fetchItem('inbox', 'msg1'));
  assert.equal(find(plain!, 'Type', CP.AirSyncBase)?.text, '1');
  assert.equal(find(plain!, 'Data', CP.AirSyncBase)?.text, messageRow().bodyText);
});

test('Fetch of another user\'s message / folder → Status 6, no properties', async () => {
  const res = await run(fetchItem('foreign', 'msg2'), fetchItem('inbox', 'msg2'), fetchItem('inbox', 'missing'));
  for (const f of res) {
    assert.equal(status(f), '6');
    assert.equal(find(f, 'Properties'), undefined);
  }
});

test('EmptyFolderContents: own folder emptied, foreign folder refused (Status 6)', async () => {
  const [own, foreign] = await run([20, 0x12, [[0, 0x12, 'inbox']]], [20, 0x12, [[0, 0x12, 'foreign']]]);
  assert.equal(status(own!), '1');
  assert.equal(find(own!, 'CollectionId', CP.AirSync)?.text, 'inbox');
  assert.equal(status(foreign!), '6');
  assert.deepEqual(emptied, ['inbox']);
});

test('non-mailbox Store → Status 9', async () => {
  const [f] = await run([20, 0x06, [[20, 0x07, 'DocumentLibrary'], [17, 0x11, 'att-pdf']]]);
  assert.equal(status(f!), '9');
});

test('default emptyFolder deletes the folder rows through the message store in one transaction per batch', async () => {
  const n = await prismaItemOperationsDeps().emptyFolder('inbox', 'mb1');
  assert.equal(n, 1);
  assert.equal(txCalls.length, 1);
});