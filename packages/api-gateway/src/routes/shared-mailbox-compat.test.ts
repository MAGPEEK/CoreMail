/**
 * SemVer compat (9.3): the pre-9.3 routes /api/v1/user/shared-mailboxes/:id/… keep
 * their 9.2 request / response shapes and status codes (routes/user.ts, "compat");
 * the 9.3 webmail contract lives under /api/v1/mail/shared-mailboxes/:id/…
 * (routes/foreign-mailbox.ts). Asserted here against the 9.2 handlers:
 *  - GET folders → plain array (no isSystem); no access → 403 without `code`;
 *  - GET folders/:folderId/messages → { total, messages } (no limit/offset), bodyText selected;
 *  - GET messages/:messageId → includes `folder`, does NOT mark the message read;
 *  - POST folders {displayName} → 201, "/" in the name replaced by "_", foreign parent 400;
 *  - PATCH: protected folder 403, Archive renamable, foreign parent 400;
 *  - DELETE: protected 403, children 409, non-empty folder without ?force → 204;
 *  - POST empty → { deleted } (expunge → tombstones, also outside Trash);
 *  - routes that only exist in the 9.3 API are 404 on the old path.
 * Deviations (safety fixes, documented in CHANGELOG): DELETE moves the folder's mail to
 * Trash through the message store instead of the Prisma cascade; writes are audited.
 * Run: node --import tsx --test --test-force-exit src/routes/shared-mailbox-compat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  messages, writes, auditRows, messageFindFirstArgs, addFolder, addMessage, msg, folderById,
  tok, call, OLD, S, flush, type Row,
} from '../test-support/foreign-mailbox-fixture.js';

test('compat reads: folder array, {total, messages}, message with folder, no mark-as-read', async () => {
  const t = tok('alice');
  const f = await call('GET', `${OLD('sm1')}/folders`, t);
  assert.equal(f.status, 200);
  assert.ok(Array.isArray(f.json));
  assert.ok(f.json.every((x) => !('isSystem' in x)), 'no 9.3 isSystem field');

  const list = await call('GET', `${OLD('sm1')}/folders/f-sm1-inbox/messages?limit=10`, t);
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.json).sort(), ['messages', 'total']);
  assert.deepEqual([list.json['total'], (list.json['messages'] as Row[]).map((m) => m['id'])], [1, ['m-sm1']]);
  assert.equal((list.json['messages'] as Row[])[0]!['bodyText'], 'hi', 'bodyText still in the list');
  assert.equal((await call('GET', `${OLD('sm1')}/folders/f-sm2-inbox/messages`, t)).status, 404);

  const open = await call('GET', `${OLD('sm1')}/messages/m-sm1`, t);
  assert.equal(open.status, 200);
  const include = messageFindFirstArgs.at(-1)!['include'] as Row;
  assert.ok(include['folder'], 'message includes its folder');
  assert.deepEqual(msg('m-sm1')['flags'], [], 'opening does not mark read (9.2 behaviour)');
  assert.ok(!writes.length, 'no write on read');

  // READ_ONLY may read; no access → 403 with the 9.2 body (no code)
  assert.equal((await call('GET', `${OLD('sm2')}/folders`, t)).status, 200);
  const denied = await call('GET', `${OLD('sm1')}/folders`, tok('bob'));
  assert.deepEqual([denied.status, denied.json['error'], denied.json['code']], [403, 'Kein Lese-Zugriff auf diese Mailbox', undefined]);
});

test('compat folder writes: 9.2 codes and shapes', async () => {
  const t = tok('alice');
  const created = await call('POST', `${OLD('sm1')}/folders`, t, { displayName: 'A/B' });
  assert.equal(created.status, 201);
  assert.ok(!('isSystem' in created.json));
  assert.deepEqual([folderById(String(created.json['id']))!['name'], folderById(String(created.json['id']))!['displayName']], ['A_B', 'A/B']);
  assert.equal((await call('POST', `${OLD('sm1')}/folders`, t, {})).status, 400, 'displayName required');
  assert.equal((await call('POST', `${OLD('sm1')}/folders`, t, { displayName: 'X', parentId: 'f-alice-inbox' })).status, 400, 'foreign parent → 400');
  assert.equal((await call('POST', `${OLD('sm1')}/folders`, t, { displayName: 'Shared/x' })).json['code'], 'RESERVED_FOLDER_NAME');
  const ro = await call('POST', `${OLD('sm2')}/folders`, t, { displayName: 'nope' });
  assert.deepEqual([ro.status, ro.json['error']], [403, 'Vollzugriff erforderlich']);

  assert.equal((await call('PATCH', `${OLD('sm1')}/folders/f-sm1-inbox`, t, { displayName: 'Eingang' })).status, 403, 'protected → 403');
  assert.equal((await call('PATCH', `${OLD('sm1')}/folders/f-sm1-archive`, t, { displayName: 'Ablage' })).status, 200, 'Archive is not protected in 9.2');
  assert.equal((await call('PATCH', `${OLD('sm1')}/folders/f-sm1-proj`, t, { parentId: 'f-alice-inbox' })).status, 400, 'foreign parent → 400');

  assert.equal((await call('DELETE', `${OLD('sm1')}/folders/f-sm1-inbox`, t)).status, 403, 'protected → 403');
  addFolder('f-sm1-child', 'mb-sm1', 'Kind', 'f-sm1-proj');
  assert.equal((await call('DELETE', `${OLD('sm1')}/folders/f-sm1-proj`, t)).status, 409, 'children → 409');
});

test('compat DELETE: non-empty folder without ?force → 204, mail moved to Trash (no cascade), audited', async () => {
  const t = tok('alice');
  addMessage('m-proj', 'f-sm1-proj');
  addMessage('m-proj-dead', 'f-sm1-proj', { deletedAt: new Date(1_000) });
  const r = await call('DELETE', `${OLD('sm1')}/folders/f-sm1-proj`, t);
  assert.equal(r.status, 204);
  assert.equal(folderById('f-sm1-proj'), undefined);
  assert.equal(msg('m-proj')['folderId'], 'f-sm1-trash');
  assert.equal(msg('m-proj')['deletedAt'], null);
  assert.equal(msg('m-proj-dead')['folderId'], 'f-sm1-trash');
  assert.ok(msg('m-proj-dead')['deletedAt'] instanceof Date);
  await flush();
  const a = auditRows.find((x) => x['action'] === 'mailbox.foreign.folder.delete')!;
  assert.deepEqual([a['targetType'], a['targetId'], (a['changes'] as Row)['movedToTrash']], ['sharedMailbox', 'sm1', 2]);
});

test('compat empty: { deleted } with tombstones (9.2 behaviour), audited', async () => {
  const t = tok('alice');
  addMessage('m-proj-1', 'f-sm1-proj');
  addMessage('m-proj-2', 'f-sm1-proj');
  const r = await call('POST', `${OLD('sm1')}/folders/f-sm1-proj/empty`, t);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { deleted: 2 });
  for (const id of ['m-proj-1', 'm-proj-2']) {
    assert.equal(msg(id)['folderId'], 'f-sm1-proj');
    assert.ok(msg(id)['deletedAt'] instanceof Date, 'expunged → recoverable tombstone');
  }
  await flush();
  const a = auditRows.find((x) => x['action'] === 'mailbox.foreign.folder.empty')!;
  assert.deepEqual([a['targetType'], a['targetId'], (a['changes'] as Row)['expunged']], ['sharedMailbox', 'sm1', 2]);
  assert.equal((await call('POST', `${OLD('sm2')}/folders/f-sm2-proj/empty`, t)).status, 403, 'READ_ONLY');
});

test('routes that only exist in the 9.3 API are not served on the old path; the new path serves them', async () => {
  const t = tok('alice');
  for (const [method, path, body] of [
    ['GET', `${OLD('sm1')}/search?q=x`, undefined],
    ['GET', `${OLD('sm1')}/messages/m-sm1/raw`, undefined],
    ['PATCH', `${OLD('sm1')}/messages/m-sm1`, { read: true }],
    ['DELETE', `${OLD('sm1')}/messages/m-sm1`, undefined],
    ['POST', `${OLD('sm1')}/messages/bulk`, { ids: ['m-sm1'], action: 'read' }],
  ] as Array<[string, string, unknown]>) {
    assert.equal((await call(method, path, t, body)).status, 404, `${method} ${path}`);
  }
  assert.equal((await call('GET', `${S('sm1')}/search?q=x`, t)).status, 200);
  assert.equal(messages.find((m) => m['id'] === 'm-sm1')!['folderId'], 'f-sm1-inbox');
});
