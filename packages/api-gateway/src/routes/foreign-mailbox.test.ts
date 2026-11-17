/**
 * 9.3: webmail operations on shared / delegated mailboxes (routes/foreign-mailbox.ts)
 * and the folder-pane visibility API (GET/PATCH /user/accessible-mailboxes).
 *  - access = listAccessibleMailboxes(): FULL_ACCESS read+write, READ_ONLY read only,
 *    SEND_AS alone / inactive shared mailbox / deactivated owner / unknown id → 403;
 *  - READ_ONLY: every write → 403 READ_ONLY without touching a row, opening a mail
 *    does not mark it read;
 *  - every lookup is scoped to the resolved mailbox (no cross-mailbox move / IDOR);
 *  - hide / show persists per user, needs access to hide, prunes stale entries;
 *  - review fixes: DELETE ?force=true moves the folder's mail (live + tombstones) to
 *    Trash through the message store instead of the Prisma cascade (A1, also the own
 *    /mail/folders route); /messages/:id/raw ignores tombstones (A2); writes in a
 *    foreign mailbox are audited as mailbox.foreign.* (A3).
 * Fixture: test-support/foreign-mailbox-fixture.ts.
 * Loopback Express app (same mount order as server.ts), Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test --test-force-exit src/routes/foreign-mailbox.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  folders, messages, settings, writes, summarySelects, auditRows, seed, addFolder, addMessage, msg, folderById,
  tok, call, S, D, flush, type Row,
} from '../test-support/foreign-mailbox-fixture.js';

void seed;

/** Every write route of the API with a body that would be valid for `prefix`'s mailbox. */
function writeCalls(prefix: string, folderId: string, messageId: string): Array<[string, string, unknown]> {
  return [
    ['POST', `${prefix}/folders`, { name: 'Neu' }],
    ['PATCH', `${prefix}/folders/${folderId}`, { name: 'Umbenannt' }],
    ['DELETE', `${prefix}/folders/${folderId}?force=true`, undefined],
    ['POST', `${prefix}/folders/${folderId}/empty`, {}],
    ['PATCH', `${prefix}/messages/${messageId}`, { read: true }],
    ['DELETE', `${prefix}/messages/${messageId}`, undefined],
    ['POST', `${prefix}/messages/bulk`, { ids: [messageId], action: 'flag' }],
  ];
}

test('FULL_ACCESS shared mailbox: folders, list, search, open (marks read), write ops scoped to it', async () => {
  const t = tok('alice');
  const f = await call('GET', `${S('sm1')}/folders`, t);
  assert.equal(f.status, 200);
  assert.deepEqual(f.json.map((x) => x['id']).sort(), ['f-sm1-archive', 'f-sm1-inbox', 'f-sm1-proj', 'f-sm1-trash']);
  assert.equal(f.json.find((x) => x['name'] === 'INBOX')!['isSystem'], true);
  assert.equal(f.json.find((x) => x['name'] === 'Projekte')!['isSystem'], false);

  const list = await call('GET', `${S('sm1')}/folders/f-sm1-inbox/messages?limit=10`, t);
  assert.equal(list.status, 200);
  assert.deepEqual([list.json['total'], (list.json['messages'] as Row[]).map((m) => m['id'])], [1, ['m-sm1']]);
  assert.deepEqual((list.json['messages'] as Row[])[0]!['categories'], [], 'personal categories never leak');
  assert.ok(summarySelects.every((s) => !('categories' in s)), 'categories relation not even selected');
  // a folder of another mailbox through this mailbox's path → 404
  assert.equal((await call('GET', `${S('sm1')}/folders/f-sm2-inbox/messages`, t)).status, 404);

  const search = await call('GET', `${S('sm1')}/search?q=hello`, t);
  assert.equal(search.status, 200);
  assert.ok(Array.isArray(search.json['chips']));

  const open = await call('GET', `${S('sm1')}/messages/m-sm1`, t);
  assert.equal(open.status, 200);
  assert.ok((messages.find((m) => m['id'] === 'm-sm1')!['flags'] as string[]).includes('\\Seen'), 'opened with FULL_ACCESS → read');
  assert.equal((await call('GET', `${S('sm1')}/messages/m-sm2`, t)).status, 404, 'message of another mailbox');

  // bulk move inside the mailbox
  const mv = await call('POST', `${S('sm1')}/messages/bulk`, t, { ids: ['m-sm1', 'm-sm2', 'm-alice'], action: 'move', folderId: 'f-sm1-proj' });
  assert.deepEqual([mv.status, mv.json['affected']], [200, 1], 'only the message of THIS mailbox');
  assert.equal(messages.find((m) => m['id'] === 'm-sm1')!['folderId'], 'f-sm1-proj');
  assert.equal(messages.find((m) => m['id'] === 'm-sm2')!['folderId'], 'f-sm2-inbox');
  assert.equal(messages.find((m) => m['id'] === 'm-alice')!['folderId'], 'f-alice-inbox');
  // a target folder in another mailbox → 404, nothing moved
  const cross = await call('POST', `${S('sm1')}/messages/bulk`, t, { ids: ['m-sm1'], action: 'move', folderId: 'f-alice-inbox' });
  assert.equal(cross.status, 404);
  const crossPatch = await call('PATCH', `${S('sm1')}/messages/m-sm1`, t, { folderId: 'f-sm2-inbox' });
  assert.equal(crossPatch.status, 404);
  assert.equal(messages.find((m) => m['id'] === 'm-sm1')!['folderId'], 'f-sm1-proj');

  // flag + delete (→ Trash of the shared mailbox)
  assert.equal((await call('PATCH', `${S('sm1')}/messages/m-sm1`, t, { flagged: true })).status, 200);
  assert.ok((messages.find((m) => m['id'] === 'm-sm1')!['flags'] as string[]).includes('\\Flagged'));
  assert.equal((await call('DELETE', `${S('sm1')}/messages/m-sm1`, t)).status, 200);
  assert.equal(messages.find((m) => m['id'] === 'm-sm1')!['folderId'], 'f-sm1-trash');

  // folder CRUD (pre-9.3 body {displayName} still accepted)
  const created = await call('POST', `${S('sm1')}/folders`, t, { displayName: 'Rechnungen', parentId: 'f-sm1-inbox' });
  assert.equal(created.status, 201);
  assert.equal(folders.find((x) => x['id'] === created.json['id'])!['mailboxId'], 'mb-sm1');
  assert.equal((await call('POST', `${S('sm1')}/folders`, t, { name: 'X', parentId: 'f-alice-inbox' })).status, 404, 'parent of another mailbox');
  assert.equal((await call('POST', `${S('sm1')}/folders`, t, { name: 'Shared/x' })).json['code'], 'RESERVED_FOLDER_NAME');
  assert.equal((await call('POST', `${S('sm1')}/folders`, t, { name: 'Projekte' })).status, 409);
  assert.equal((await call('PATCH', `${S('sm1')}/folders/f-sm1-inbox`, t, { name: 'Eingang' })).status, 400, 'system folder');
  assert.equal((await call('PATCH', `${S('sm1')}/folders/f-sm1-proj`, t, { parentId: 'f-alice-inbox' })).status, 404, 'reparent across mailboxes');
  assert.equal((await call('PATCH', `${S('sm1')}/folders/${created.json['id']}`, t, { name: 'Belege' })).status, 200);
  assert.equal((await call('DELETE', `${S('sm1')}/folders/f-sm1-trash`, t)).status, 400, 'system folder');
  assert.equal((await call('DELETE', `${S('sm1')}/folders/${created.json['id']}`, t)).status, 200);
  assert.equal((await call('DELETE', `${S('sm1')}/folders/f-alice-inbox`, t)).status, 404, 'folder of the own mailbox via the shared path');
});

test('READ_ONLY (shared + delegated): reads work, opening does not mark read, every write → 403 READ_ONLY', async () => {
  for (const [token, prefix, folderId, messageId] of [
    [tok('alice'), S('sm2'), 'f-sm2-proj', 'm-sm2'],
    [tok('frank'), D('mb-erin'), 'f-erin-inbox', 'm-erin'],
  ] as const) {
    assert.equal((await call('GET', `${prefix}/folders`, token)).status, 200);
    const inbox = folders.find((f) => f['name'] === 'INBOX' && f['mailboxId'] === (prefix.includes('sm2') ? 'mb-sm2' : 'mb-erin'))!;
    assert.equal((await call('GET', `${prefix}/folders/${inbox['id']}/messages`, token)).status, 200);
    const open = await call('GET', `${prefix}/messages/${messageId}`, token);
    assert.equal(open.status, 200);
    assert.deepEqual(messages.find((m) => m['id'] === messageId)!['flags'], [], 'READ_ONLY does not mark read');
    for (const [method, path, body] of writeCalls(prefix, folderId, messageId)) {
      const r = await call(method, path, token, body);
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.json['code'], 'READ_ONLY', `${method} ${path}`);
    }
  }
  assert.deepEqual(writes, [], 'no row was written');
});

test('no read access → 403 on every route (SEND_AS only, inactive, deactivated owner, other mailbox, unknown)', async () => {
  const cases: Array<[string, string, string, string]> = [
    ['bob', S('sm1'), 'f-sm1-inbox', 'm-sm1'],      // SEND_AS only
    ['carol', S('sm3'), 'f-sm1-inbox', 'm-sm1'],    // inactive shared mailbox
    ['nobody', S('sm1'), 'f-sm1-inbox', 'm-sm1'],
    ['alice', S('nope'), 'f-sm1-inbox', 'm-sm1'],
    ['dave', D('mb-gina'), 'f-gina-inbox', 'm-erin'], // owner deactivated
    ['alice', D('mb-erin'), 'f-erin-inbox', 'm-erin'], // no delegation
    ['dave', D('mb-sm1'), 'f-sm1-inbox', 'm-sm1'],   // a shared mailbox id is no delegation
  ];
  for (const [user, prefix, folderId, messageId] of cases) {
    const reads: Array<[string, string, unknown]> = [
      ['GET', `${prefix}/folders`, undefined],
      ['GET', `${prefix}/folders/${folderId}/messages`, undefined],
      ['GET', `${prefix}/search?q=x`, undefined],
      ['GET', `${prefix}/messages/${messageId}`, undefined],
      ['GET', `${prefix}/messages/${messageId}/raw`, undefined],
    ];
    for (const [method, path, body] of [...reads, ...writeCalls(prefix, folderId, messageId)]) {
      const r = await call(method, path, tok(user), body);
      assert.equal(r.status, 403, `${user} ${method} ${path}`);
      assert.equal(r.json['code'], 'NO_ACCESS');
    }
  }
  assert.deepEqual(writes, []);
  assert.equal((await call('GET', `${S('sm1')}/folders`)).status, 401, 'unauthenticated');
});

test('FULL_ACCESS delegation: same API on the delegated mailbox', async () => {
  const t = tok('dave');
  const f = await call('GET', `${D('mb-erin')}/folders`, t);
  assert.deepEqual(f.json.map((x) => x['id']).sort(), ['f-erin-inbox', 'f-erin-trash']);
  const r = await call('POST', `${D('mb-erin')}/messages/bulk`, t, { ids: ['m-erin'], action: 'read' });
  assert.deepEqual([r.status, r.json['affected']], [200, 1]);
  assert.ok((messages.find((m) => m['id'] === 'm-erin')!['flags'] as string[]).includes('\\Seen'));
  // the list route of /mail stays the delegation list (not swallowed by the :id mount)
  assert.equal((await call('GET', '/api/v1/mail/delegated-mailboxes', t)).status, 200);
});

test('accessible mailboxes: list with permissions; hide / show persists per user', async () => {
  const t = tok('alice');
  const list = await call('GET', '/api/v1/user/accessible-mailboxes', t);
  assert.equal(list.status, 200);
  // sorted by kind, then address (sales@ < team@)
  assert.deepEqual(list.json.map((x) => [x['ref'], x['readOnly'], x['permissions'], x['hidden']]), [
    ['shared:sm2', true, ['READ_ONLY'], false],
    ['shared:sm1', false, ['FULL_ACCESS', 'SEND_AS'], false],
  ]);

  const hide = await call('PATCH', `/api/v1/user/accessible-mailboxes/${encodeURIComponent('shared:sm2')}`, t, { hidden: true });
  assert.deepEqual([hide.status, hide.json['hidden']], [200, true]);
  assert.deepEqual(settings.get('alice')!['hiddenSharedMailboxes'], ['shared:sm2']);
  const again = await call('GET', '/api/v1/user/accessible-mailboxes', t);
  assert.equal(again.json.find((x) => x['ref'] === 'shared:sm2')!['hidden'], true);
  assert.equal(again.json.find((x) => x['ref'] === 'shared:sm1')!['hidden'], false);

  // hiding a mailbox without access → 404; bad ref / body → 400
  assert.equal((await call('PATCH', '/api/v1/user/accessible-mailboxes/shared:sm3', t, { hidden: true })).status, 404);
  assert.equal((await call('PATCH', '/api/v1/user/accessible-mailboxes/team', t, { hidden: true })).status, 400);
  assert.equal((await call('PATCH', '/api/v1/user/accessible-mailboxes/shared:sm1', t, { hidden: 'yes' })).status, 400);

  // stale entries (access lost) are pruned on the next write; showing works
  settings.set('alice', { userId: 'alice', hiddenSharedMailboxes: ['shared:sm2', 'shared:gone', 'delegated:mb-x'] });
  const show = await call('PATCH', '/api/v1/user/accessible-mailboxes/shared:sm2', t, { hidden: false });
  assert.deepEqual([show.status, show.json['hidden']], [200, false]);
  assert.deepEqual(settings.get('alice')!['hiddenSharedMailboxes'], []);

  // delegated entries: ref = delegated:<mailboxId>, permission from the delegation
  const d = await call('GET', '/api/v1/user/accessible-mailboxes', tok('frank'));
  assert.deepEqual(d.json.map((x) => [x['ref'], x['kind'], x['id'], x['readOnly'], x['permissions']]),
    [['delegated:mb-erin', 'delegated', 'mb-erin', true, ['READ_ONLY']]]);
  // bob holds SEND_AS only → nothing to show
  assert.deepEqual((await call('GET', '/api/v1/user/accessible-mailboxes', tok('bob'))).json, []);
});

// ── review fixes ──────────────────────────────────────────────────────────────

test('A1: DELETE ?force=true moves live mail + tombstones to Trash via the message store, then deletes the folder', async () => {
  const t = tok('alice');
  addMessage('m-proj-live', 'f-sm1-proj', { uid: 3, flags: ['\\Seen'] });
  addMessage('m-proj-dead', 'f-sm1-proj', { uid: 4, deletedAt: new Date(1_000) });
  // without force: 409 with the live count (tombstones do not count)
  const refused = await call('DELETE', `${S('sm1')}/folders/f-sm1-proj`, t);
  assert.deepEqual([refused.status, refused.json['count']], [409, 1]);
  assert.ok(folderById('f-sm1-proj'));

  const r = await call('DELETE', `${S('sm1')}/folders/f-sm1-proj?force=true`, t);
  assert.equal(r.status, 200);
  assert.equal(folderById('f-sm1-proj'), undefined, 'folder deleted');
  assert.equal(msg('m-proj-live')['folderId'], 'f-sm1-trash');
  assert.equal(msg('m-proj-live')['deletedAt'], null, 'live mail stays live (in Trash)');
  assert.equal(msg('m-proj-dead')['folderId'], 'f-sm1-trash');
  assert.ok(msg('m-proj-dead')['deletedAt'] instanceof Date, 'tombstone stays recoverable');
  // message store: new UID / modSeq from the mailbox counter (mailbox.update), rows updated
  assert.ok(writes.includes('mailbox.update') && writes.includes('message.update'));
  assert.ok(writes.indexOf('message.update') < writes.indexOf('folder.delete'), 'messages moved before the folder row goes');
  assert.notEqual(msg('m-proj-live')['modSeq'], undefined, 'modSeq assigned');
});

test('A1: a subfolder of Trash — live mail is expunged (tombstone) and kept in Trash', async () => {
  addFolder('f-sm1-trash-sub', 'mb-sm1', 'Alt', 'f-sm1-trash');
  addMessage('m-sub', 'f-sm1-trash-sub');
  const r = await call('DELETE', `${S('sm1')}/folders/f-sm1-trash-sub?force=true`, tok('alice'));
  assert.equal(r.status, 200);
  assert.equal(folderById('f-sm1-trash-sub'), undefined);
  assert.equal(msg('m-sub')['folderId'], 'f-sm1-trash');
  assert.ok(msg('m-sub')['deletedAt'] instanceof Date, 'expunged → recoverable tombstone');
});

test('A1: no Trash folder → 409, nothing deleted (delegated mailbox)', async () => {
  const trash = folderById('f-erin-trash')!;
  folders.splice(folders.indexOf(trash), 1);
  addFolder('f-erin-x', 'mb-erin', 'X');
  addMessage('m-erin-x', 'f-erin-x');
  const r = await call('DELETE', `${D('mb-erin')}/folders/f-erin-x?force=true`, tok('dave'));
  assert.equal(r.status, 409);
  assert.ok(folderById('f-erin-x'));
  assert.equal(msg('m-erin-x')['folderId'], 'f-erin-x');
  assert.ok(!writes.includes('folder.delete'));
});

test('A1: own mailbox DELETE /mail/folders/:id?force=true moves the mail to Trash too', async () => {
  const t = tok('alice');
  addFolder('f-alice-trash', 'mb-alice', 'Trash');
  addFolder('f-alice-proj', 'mb-alice', 'Projekt');
  addMessage('m-alice-proj', 'f-alice-proj');
  const r = await call('DELETE', '/api/v1/mail/folders/f-alice-proj?force=true', t);
  assert.equal(r.status, 200);
  assert.equal(folderById('f-alice-proj'), undefined);
  assert.equal(msg('m-alice-proj')['folderId'], 'f-alice-trash');
  assert.equal(msg('m-alice-proj')['deletedAt'], null);
  // another user's folder → 404
  assert.equal((await call('DELETE', '/api/v1/mail/folders/f-sm1-inbox?force=true', t)).status, 404);
});

test('A2: /messages/:id/raw does not serve expunged messages (tombstones)', async () => {
  addMessage('m-sm1-gone', 'f-sm1-inbox', { deletedAt: new Date(1_000) });
  assert.equal((await call('GET', `${S('sm1')}/messages/m-sm1-gone/raw`, tok('alice'))).status, 404, 'tombstone → 404');
  addMessage('m-erin-gone', 'f-erin-inbox', { deletedAt: new Date(1_000) });
  assert.equal((await call('GET', `${D('mb-erin')}/messages/m-erin-gone/raw`, tok('dave'))).status, 404);
  // the other single-message lookups ignore tombstones as well
  assert.equal((await call('GET', `${S('sm1')}/messages/m-sm1-gone`, tok('alice'))).status, 404);
  assert.equal((await call('PATCH', `${S('sm1')}/messages/m-sm1-gone`, tok('alice'), { read: true })).status, 404);
  assert.equal((await call('DELETE', `${S('sm1')}/messages/m-sm1-gone`, tok('alice'))).status, 404);
});

test('A3: writes in a foreign mailbox are audited (shared → sharedMailbox id, delegated → mailbox id)', async () => {
  const t = tok('alice');
  const created = await call('POST', `${S('sm1')}/folders`, t, { name: 'Belege' });
  await call('PATCH', `${S('sm1')}/folders/${created.json['id']}`, t, { name: 'Belege-2' });
  addMessage('m-a3', 'f-sm1-inbox');
  await call('POST', `${S('sm1')}/messages/bulk`, t, { ids: ['m-a3'], action: 'move', folderId: created.json['id'] });
  await call('DELETE', `${S('sm1')}/messages/m-a3`, t);                                    // → Trash
  await call('POST', `${S('sm1')}/messages/bulk`, t, { ids: ['m-a3'], action: 'delete' }); // in Trash → expunge
  await call('POST', `${S('sm1')}/folders/f-sm1-trash/empty`, t);
  await call('DELETE', `${S('sm1')}/folders/${created.json['id']}?force=true`, t);
  await call('POST', `${S('sm1')}/messages/bulk`, t, { ids: ['m-sm1'], action: 'flag' });  // flags: not audited
  await flush();
  assert.deepEqual(auditRows.map((a) => a['action']), [
    'mailbox.foreign.folder.create', 'mailbox.foreign.folder.update', 'mailbox.foreign.message.move',
    'mailbox.foreign.message.delete', 'mailbox.foreign.message.delete', 'mailbox.foreign.folder.empty',
    'mailbox.foreign.folder.delete',
  ]);
  for (const a of auditRows) {
    assert.deepEqual([a['actorId'], a['targetType'], a['targetId'], a['targetName']], ['alice', 'sharedMailbox', 'sm1', 'team@ex.com']);
    assert.equal((a['changes'] as Row)['mailboxId'], 'mb-sm1');
  }
  const del = auditRows.find((a) => a['action'] === 'mailbox.foreign.folder.delete')!;
  assert.equal((del['changes'] as Row)['folderId'], created.json['id']);
  const bulkDel = auditRows.filter((a) => a['action'] === 'mailbox.foreign.message.delete')[1]!;
  assert.deepEqual([(bulkDel['changes'] as Row)['count'], (bulkDel['changes'] as Row)['expunged']], [1, 1]);

  // delegated: targetType mailbox, targetId = Mailbox id; empty of a normal folder → Trash
  auditRows.length = 0;
  await call('POST', `${D('mb-erin')}/folders/f-erin-inbox/empty`, tok('dave'));
  await flush();
  assert.deepEqual(auditRows.map((a) => [a['action'], a['targetType'], a['targetId'], (a['changes'] as Row)['movedToTrash']]),
    [['mailbox.foreign.folder.empty', 'mailbox', 'mb-erin', 1]]);
  // reads and refused READ_ONLY writes are not audited
  auditRows.length = 0;
  await call('GET', `${S('sm1')}/folders`, t);
  await call('POST', `${S('sm2')}/folders`, t, { name: 'nope' });
  await flush();
  assert.deepEqual(auditRows, []);
});
