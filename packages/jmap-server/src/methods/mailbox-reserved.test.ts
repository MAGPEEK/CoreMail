/**
 * 9.1: Mailbox/set refuses names under an IMAP namespace prefix ("Shared/",
 * "Other Users/", any case) on create and on rename — such a personal folder
 * could never be selected over IMAP. Only rejections are exercised here (a
 * successful set publishes to Redis). In-memory Prisma stand-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
const folders: Row[] = [
  { id: 'f-inbox', mailboxId: 'mb1', name: 'INBOX', displayName: 'INBOX', parentId: null, sortOrder: 0, totalCount: 0, unreadCount: 0, subscribed: true, createdAt: new Date(0) },
  { id: 'f-work', mailboxId: 'mb1', name: 'Work', displayName: 'Work', parentId: null, sortOrder: 0, totalCount: 0, unreadCount: 0, subscribed: true, createdAt: new Date(0) },
];
const writes: string[] = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  folder: {
    findMany: async () => folders.map((f) => ({ ...f })),
    findFirst: async () => null,
    create: async () => { writes.push('create'); return {}; },
    update: async () => { writes.push('update'); return {}; },
  },
};

const { parseRequest, processRequest } = await import('../dispatcher.js');
const { CAP_CORE, CAP_MAIL } = await import('../capabilities.js');
await import('./mailbox.js');
import type { AccountContext, JmapUser } from '../types.js';

const user: JmapUser = { userId: 'u1', email: 'a@ex.com', displayName: 'A', domainId: 'd', role: 'USER' };
const account: AccountContext = {
  accountId: 'u1', mailboxId: 'mb1', ownerUserId: 'u1', sharedMailboxId: null, name: 'a@ex.com', email: 'a@ex.com',
  readOnly: false, isPersonal: true, maySend: true,
};

async function set(args: Row): Promise<Row> {
  const res = await processRequest(
    parseRequest({ using: [CAP_CORE, CAP_MAIL], methodCalls: [['Mailbox/set', { accountId: 'u1', ...args }, 'c0']] }),
    user, new Map([['u1', account]]), 's',
  );
  const [name, out] = res.methodResponses[0]!;
  assert.equal(name, 'Mailbox/set', JSON.stringify(out));
  return out as Row;
}

test('Mailbox/set create: names under "Shared/" and "Other Users/" (any case) are reserved', async () => {
  const out = await set({ create: { a: { name: 'Shared/x' }, b: { name: 'other users/bob@ex.com' }, c: { name: 'SHARED/y' } } });
  const nc = out['notCreated'] as Record<string, { type: string; description: string; properties: string[] }>;
  for (const k of ['a', 'b', 'c']) {
    assert.equal(nc[k]?.type, 'invalidProperties', k);
    assert.match(nc[k]!.description, /reserved for shared and delegated mailboxes/, k);
    assert.deepEqual(nc[k]!.properties, ['name']);
  }
  assert.match(nc['b']!.description, /"Other Users\/"/);
  assert.deepEqual(writes, []);
});

test('Mailbox/set update: renaming into a reserved prefix is refused', async () => {
  const out = await set({ update: { 'f-work': { name: 'Shared/Work' } } });
  const nu = out['notUpdated'] as Record<string, { type: string; description: string }>;
  assert.equal(nu['f-work']?.type, 'invalidProperties');
  assert.match(nu['f-work']!.description, /"Shared\/" are reserved/);
  assert.deepEqual(writes, []);
});
