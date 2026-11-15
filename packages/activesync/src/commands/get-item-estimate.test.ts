/**
 * GetItemEstimate: per-collection counts over the Sync window's modSeq range,
 * Status 2 for foreign/unknown collections, 3 for SyncKey 0, 4 for invalid keys,
 * all tags on the GetItemEstimate code page (6). Before, the command answered an
 * empty 200 and clients showed no unread/pending counts.
 * Run: node --import tsx --test src/commands/get-item-estimate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { find, findAll, clientWbxml, testEnv, type ClientNode } from './test-fixtures.js';

testEnv();
const MSGS = [
  { folderId: 'inbox', modSeq: 1n, deletedAt: null }, { folderId: 'inbox', modSeq: 2n, deletedAt: null },
  { folderId: 'inbox', modSeq: 4n, deletedAt: null }, { folderId: 'inbox', modSeq: 5n, deletedAt: new Date() },
  { folderId: 'sent', modSeq: 3n, deletedAt: null },
];
type Where = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  folder: {
    findFirst: async ({ where }: { where: Where }) =>
      (['inbox', 'sent'].includes(where['id']) && where['mailbox']?.userId === 'u1' ? { id: where['id'], mailboxId: 'mb1' } : null),
  },
  mailbox: { findUnique: async () => ({ highestModSeq: 5n }), updateMany: async () => ({ count: 0 }) },
  message: {
    aggregate: async () => ({ _max: { modSeq: 5n, uid: 5 } }),
    count: async ({ where }: { where: Where }) => MSGS.filter((m) => m.folderId === where['folderId'] && m.deletedAt === where['deletedAt']
      && m.modSeq >= where['modSeq'].gte && m.modSeq < where['modSeq'].lt).length,
  },
};

const { handleGetItemEstimate } = await import('./get-item-estimate.js');
const { decodeWbxml, CP } = await import('../wbxml.js');

const col = (key: string, id: string): ClientNode => [6, 0x08, [[0, 0x0b, key], [6, 0x0a, id], [0, 0x17, [[0, 0x18, '0']]]]];

test('estimates per collection with Status per collection', async () => {
  const req = decodeWbxml(clientWbxml([6, 0x05, [[6, 0x07, [
    col('1', 'inbox'), col('3', 'inbox'), col('1', 'sent'), col('0', 'inbox'), col('999', 'inbox'), col('1', 'not-mine'),
  ]]]]));
  const out = await handleGetItemEstimate(req, 'u1');
  const tree = decodeWbxml(out);
  assert.equal(tree.name, 'GetItemEstimate');
  const rows = findAll(tree, 'Response').map((r) => [
    find(r, 'Status')?.text, find(r, 'CollectionId')?.text, find(r, 'Estimate')?.text,
  ]);
  assert.deepEqual(rows, [
    ['1', 'inbox', '3'],     // modSeq 1,2,4 (5 is deleted)
    ['1', 'inbox', '1'],     // since key 3: modSeq 4
    ['1', 'sent', '1'],
    ['3', 'inbox', undefined], // SyncKey 0: not primed
    ['4', 'inbox', undefined], // key beyond the counter
    ['2', 'not-mine', undefined],
  ]);
  // every tag of the response is on the GetItemEstimate page
  const pages = new Set<number>();
  const walk = (e: ReturnType<typeof decodeWbxml>) => { pages.add(e.page!); for (const c of e.children ?? []) if (typeof c !== 'string') walk(c); };
  walk(tree);
  assert.deepEqual([...pages], [CP.GetItemEstimate]);
});
