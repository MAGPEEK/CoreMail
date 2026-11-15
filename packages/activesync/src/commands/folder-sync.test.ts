/**
 * Review 7.1.0: FolderSync accepted any SyncKey and an incremental FolderSync never reported
 * server-side folder add/rename/delete. Now: per-device snapshot, Add/Update/Delete deltas,
 * Status 9 for an unknown key, the previous key works for a retry.
 * Run: node --import tsx --test src/commands/folder-sync.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, clientWbxml, wbxmlTags } from '../test-support/fake-db.js';

const db = installFakeDb({
  mailbox: [{ id: 'mb1', userId: 'u1' }],
  folder: [
    { id: 'inbox', mailboxId: 'mb1', name: 'INBOX', displayName: 'Inbox', parentId: null },
    { id: 'sent', mailboxId: 'mb1', name: 'Sent', displayName: 'Sent Items', parentId: null },
    { id: 'proj', mailboxId: 'mb1', name: 'Projects', displayName: 'Projects', parentId: null },
  ],
  activeSyncDevice: [{ id: 'd1', userId: 'u1', deviceId: 'dev1', status: 'OK', policyKey: '42', folderSyncKey: '1731600000000', syncKeys: {} }],
});

const { handleFolderSync } = await import('./folder-sync.js');
const { decodeWbxml } = await import('../wbxml.js');
type E = import('../wbxml.js').WbxmlElement;
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
const kids = (e: E | undefined, name: string): E[] => (e?.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === name);

async function folderSync(key: string) {
  const buf = await handleFolderSync(decodeWbxml(clientWbxml([7, 0x16, [[7, 0x12, key]]])), 'u1', 'dev1');
  assert.ok(wbxmlTags(buf).every(([p]) => p === 7));
  const t = decodeWbxml(buf);
  const changes = kid(t, 'Changes');
  const list = (n: string) => kids(changes, n).map((c) => `${kid(c, 'ServerId')!.text}${kid(c, 'DisplayName') ? `=${kid(c, 'DisplayName')!.text}/${kid(c, 'Type')!.text}` : ''}`);
  return { status: kid(t, 'Status')!.text, key: kid(t, 'SyncKey')?.text ?? '', count: kid(changes, 'Count')?.text, add: list('Add'), update: list('Update'), del: list('Delete') };
}

test('devices synced before v7.1 keep their key (no snapshot yet → no changes)', async () => {
  const r = await folderSync('1731600000000');
  assert.deepEqual([r.status, r.count, r.key], ['1', '0', '1731600000000']);
});

test('initial sync lists all folders; incremental sync reports add / rename / delete; unknown key → 9', async () => {
  const init = await folderSync('0');
  assert.equal(init.status, '1');
  assert.deepEqual(init.add.sort(), ['inbox=Inbox/2', 'proj=Projects/12', 'sent=Sent Items/5']);
  const k1 = init.key;

  const none = await folderSync(k1);
  assert.deepEqual([none.count, none.key], ['0', k1], 'no changes → same key');

  db.tables['folder']!.push({ id: 'new', mailboxId: 'mb1', name: 'Receipts', displayName: 'Receipts', parentId: 'proj' });
  Object.assign(db.tables['folder']!.find((f) => f['id'] === 'proj')!, { displayName: 'Projects 2026' });
  db.tables['folder'] = db.tables['folder']!.filter((f) => f['id'] !== 'sent');
  const delta = await folderSync(k1);
  assert.equal(delta.status, '1');
  assert.deepEqual([delta.add, delta.update, delta.del], [['new=Receipts/12'], ['proj=Projects 2026/12'], ['sent']]);
  assert.equal(delta.count, '3');
  assert.notEqual(delta.key, k1);

  // the response got lost: the device retries with the previous key → same delta
  const retry = await folderSync(k1);
  assert.deepEqual([retry.add, retry.update, retry.del], [['new=Receipts/12'], ['proj=Projects 2026/12'], ['sent']]);
  const after = await folderSync(retry.key);
  assert.equal(after.count, '0');

  const bad = await folderSync('12345');
  assert.deepEqual([bad.status, bad.key], ['9', '']);
});
