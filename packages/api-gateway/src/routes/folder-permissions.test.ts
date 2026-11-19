/**
 * w3 folder permissions over REST:
 *  - own folders: GET/PUT /mail/folders/:id/permissions (Default + Anonymous fixed,
 *    users by id or e-mail, validation, audit, events);
 *  - foreign folders: a grantee sees only the granted folders (+ path), reads and
 *    writes exactly what the role allows (Reviewer, Editor, Author own items,
 *    READ_ONLY floor + grant), the "folder owner" right administers permissions,
 *    a revocation ends access at once;
 *  - admin: overview + per-folder routes, admin mailboxes ORGANIZATION_MANAGEMENT-only;
 *  - pure helpers: body parsing, SSE folder filter, webmail module gate.
 * Fixture: test-support/foreign-mailbox-fixture.ts (mailbox mb-erin of erin; hank,
 * bob = other users; frank = READ_ONLY delegate of erin).
 * Run: node --import tsx --test --test-force-exit src/routes/folder-permissions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  folders, messages, folderPerms, auditRows, writes, addFolder, addMessage, addFolderPerm, msg, tok, call, D, flush, type Row,
} from '../test-support/foreign-mailbox-fixture.js';

const { ROLE_RIGHTS } = await import('@coremail/storage');
const { parsePermissionBody, withFixedEntries } = await import('../lib/folder-permissions-api.js');
const { visibleFolderIds } = await import('../lib/sse-hub.js');
const { featuresForRequest } = await import('../lib/webmail-features.js');
const { canReadFolderOf } = await import('../lib/mailbox-access.js');

const OWN = (folderId: string) => `/api/v1/mail/folders/${folderId}/permissions`;
const ERIN = D('mb-erin');

/** erin's mailbox: INBOX (m-erin), Trash, Projekte (m-p1, m-p2) with Sub (m-s1), Privat (m-x). */
function erinTree(): void {
  addFolder('f-erin-proj', 'mb-erin', 'Projekte');
  addFolder('f-erin-sub', 'mb-erin', 'Sub', 'f-erin-proj');
  addFolder('f-erin-priv', 'mb-erin', 'Privat');
  addMessage('m-p1', 'f-erin-proj');
  addMessage('m-p2', 'f-erin-proj', { createdBy: 'hank' });
  addMessage('m-s1', 'f-erin-sub');
  addMessage('m-x', 'f-erin-priv');
}

test('owner: GET lists Default and Anonymous first; PUT by e-mail grants, audits and validates', async () => {
  erinTree();
  const t = tok('erin');
  const empty = await call('GET', OWN('f-erin-proj'), t);
  assert.equal(empty.status, 200);
  assert.deepEqual(((empty.json as Row)['entries'] as Row[]).map((e) => [e['granteeKey'], e['rights'], e['fixed'] ?? false]), [['default', 0, false], ['anonymous', 0, true]]);

  const put = await call('PUT', OWN('f-erin-proj'), t, {
    entries: [
      { grantee: 'default', role: 'none' },
      { grantee: 'anonymous', role: 'none' },
      { grantee: { email: 'Hank@ex.com' }, role: 'reviewer', applyToSubfolders: true },
    ],
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual(((put.json as Row)['entries'] as Row[]).map((e) => [e['granteeKey'], e['role']]), [['default', 'none'], ['anonymous', 'none'], ['user:hank', 'reviewer']]);
  assert.deepEqual(folderPerms.map((p) => [p['granteeKey'], p['rights'], p['applyToSubfolders'], p['mailboxId']]), [['user:hank', ROLE_RIGHTS.reviewer, true, 'mb-erin']]);
  await flush();
  const audit = auditRows.filter((a) => a['action'] === 'mailbox.folder.permission.set');
  assert.equal(audit.length, 1);
  assert.deepEqual([audit[0]!['actorId'], audit[0]!['targetId'], (audit[0]!['changes'] as Row)['source']], ['erin', 'f-erin-proj', 'webmail']);

  // the inherited grant shows on the subfolder
  const sub = await call('GET', OWN('f-erin-sub'), t);
  assert.deepEqual((sub.json['inherited'] as Row[]).map((e) => [e['granteeKey'], e['fromFolderId']]), [['user:hank', 'f-erin-proj']]);

  for (const [body, status, code] of [
    [{ entries: [{ grantee: 'anonymous', role: 'reviewer' }] }, 400, undefined],
    [{ entries: [{ grantee: { userId: 'erin' }, role: 'owner' }] }, 400, 'OWNER_GRANTEE'],
    [{ entries: [{ grantee: { email: 'nobody@ex.com' }, role: 'owner' }] }, 400, 'UNKNOWN_GRANTEE'],
    [{ entries: [{ grantee: { userId: 'ghost' }, role: 'owner' }] }, 400, 'UNKNOWN_GRANTEE'],
    [{ entries: [{ grantee: 'default', rights: 0x800 }] }, 400, undefined],
    [{ entries: [{ grantee: 'default' }] }, 400, undefined],
  ] as const) {
    const r = await call('PUT', OWN('f-erin-proj'), t, body);
    assert.equal(r.status, status, JSON.stringify(body));
    if (code) assert.equal(r.json['code'], code);
  }
  assert.equal(folderPerms.length, 1, 'refused requests change nothing');
  // someone else's folder through the own route → 404 (no oracle)
  assert.equal((await call('GET', OWN('f-erin-proj'), tok('hank'))).status, 404);
  assert.equal((await call('PUT', OWN('f-erin-proj'), tok('hank'), { entries: [] })).status, 404);
});

test('Reviewer on a subtree: only those folders (+ path), read without marking read, no writes', async () => {
  erinTree();
  addFolderPerm('f-erin-sub', 'user:hank', ROLE_RIGHTS.reviewer);
  const t = tok('hank');
  const list = await call('GET', '/api/v1/user/accessible-mailboxes', t);
  const entry = (list.json as Row[]).find((e) => e['ref'] === 'delegated:mb-erin')!;
  assert.deepEqual([entry['folderScoped'], entry['permissions'], entry['hidden'], entry['readOnly']], [true, ['FOLDER_PERMISSIONS'], false, true]);

  const f = await call('GET', `${ERIN}/folders`, t);
  assert.equal(f.status, 200);
  assert.deepEqual((f.json as Row[]).map((x) => [x['id'], x['noSelect'], x['unreadCount']]), [['f-erin-proj', true, 0], ['f-erin-sub', false, 0]]);
  assert.equal(((f.json as Row[])[1]!['myRights'] as Row)['read'], true);
  assert.equal(((f.json as Row[])[1]!['myRights'] as Row)['editAll'], false);

  assert.equal((await call('GET', `${ERIN}/folders/f-erin-sub/messages`, t)).status, 200);
  // the path entry (Projekte) is neither visible nor readable → like a missing folder
  for (const folder of ['f-erin-proj', 'f-erin-inbox', 'f-erin-priv']) {
    assert.equal((await call('GET', `${ERIN}/folders/${folder}/messages`, t)).status, 404, folder);
  }
  addFolderPerm('f-erin-priv', 'user:hank', 0x400); // visible only
  assert.equal((await call('GET', `${ERIN}/folders/f-erin-priv/messages`, t)).json['code'], 'NO_ACCESS', 'visible, not readable');
  folderPerms.pop();
  assert.equal((await call('GET', `${ERIN}/messages/m-s1`, t)).status, 200);
  assert.deepEqual(msg('m-s1')['flags'], [], 'a reviewer does not mark read');
  for (const id of ['m-p1', 'm-erin', 'm-x']) assert.equal((await call('GET', `${ERIN}/messages/${id}`, t)).status, 404, id);
  assert.equal((await call('GET', `${ERIN}/messages/m-x/raw`, t)).status, 404);

  const search = await call('GET', `${ERIN}/search?q=hi`, t);
  assert.deepEqual((search.json['messages'] as Row[]).map((m) => m['id']), ['m-s1']);
  assert.equal((await call('GET', `${ERIN}/search?q=hi&folderId=f-erin-priv`, t)).status, 404);

  for (const [method, path, body] of [
    ['PATCH', `${ERIN}/messages/m-s1`, { read: true }],
    ['DELETE', `${ERIN}/messages/m-s1`, undefined],
    ['POST', `${ERIN}/messages/bulk`, { ids: ['m-s1', 'm-erin'], action: 'read' }],
    ['POST', `${ERIN}/folders`, { name: 'Neu', parentId: 'f-erin-sub' }],
    ['DELETE', `${ERIN}/folders/f-erin-sub`, undefined],
  ] as const) {
    const r = await call(method, path, t, body);
    assert.deepEqual([r.status, r.json['code']], [403, 'READ_ONLY'], `${method} ${path}`);
  }
  assert.ok(!writes.some((w) => w.startsWith('message') || w.startsWith('folder.')), 'nothing written');
  assert.equal(await canReadFolderOf('hank', 'f-erin-sub'), true, 'attachments / reply lookups follow the grant');
  assert.equal(await canReadFolderOf('hank', 'f-erin-inbox'), false);
});

test('Editor: edit and delete in the folder, but no subfolders, no folder changes, no move into an ungranted folder', async () => {
  erinTree();
  addFolderPerm('f-erin-proj', 'user:hank', ROLE_RIGHTS.editor);
  const t = tok('hank');
  assert.equal((await call('PATCH', `${ERIN}/messages/m-p1`, t, { flagged: true })).status, 200);
  assert.ok((msg('m-p1')['flags'] as string[]).includes('\\Flagged'));
  const move = await call('PATCH', `${ERIN}/messages/m-p1`, t, { folderId: 'f-erin-inbox' });
  assert.deepEqual([move.status, move.json['code']], [403, 'NO_PERMISSION']);
  assert.equal((await call('POST', `${ERIN}/folders`, t, { name: 'Neu', parentId: 'f-erin-proj' })).json['code'], 'NO_PERMISSION');
  assert.equal((await call('POST', `${ERIN}/folders`, t, { name: 'Oben' })).json['code'], 'NO_PERMISSION', 'top level needs mailbox access');
  assert.equal((await call('PATCH', `${ERIN}/folders/f-erin-proj`, t, { name: 'X' })).json['code'], 'NO_PERMISSION');
  assert.equal((await call('GET', `${ERIN}/folders/f-erin-proj/permissions`, t)).json['code'], 'NO_PERMISSION');
  assert.equal((await call('DELETE', `${ERIN}/messages/m-p1`, t)).status, 200);
  assert.equal(msg('m-p1')['folderId'], 'f-erin-trash', 'deleted into the owner Trash');
  assert.equal((await call('POST', `${ERIN}/folders/f-erin-proj/empty`, t, {})).status, 200);
  assert.equal(msg('m-p2')['folderId'], 'f-erin-trash');
});

test('Author: create items, edit / delete own items only', async () => {
  erinTree();
  addFolderPerm('f-erin-proj', 'user:hank', ROLE_RIGHTS.author);
  const t = tok('hank');
  assert.equal((await call('PATCH', `${ERIN}/messages/m-p2`, t, { flagged: true })).status, 200, 'own item');
  assert.equal((await call('PATCH', `${ERIN}/messages/m-p1`, t, { flagged: true })).json['code'], 'NO_PERMISSION', 'item of the owner');
  const bulk = await call('POST', `${ERIN}/messages/bulk`, t, { ids: ['m-p1', 'm-p2'], action: 'delete' });
  assert.equal(bulk.json['code'], 'NO_PERMISSION', 'all or nothing');
  assert.equal(msg('m-p2')['folderId'], 'f-erin-proj');
  assert.equal((await call('DELETE', `${ERIN}/messages/m-p2`, t)).status, 200);
  assert.equal((await call('DELETE', `${ERIN}/messages/m-p1`, t)).json['code'], 'NO_PERMISSION');
});

test('READ_ONLY delegation stays the floor; a folder grant adds write rights in that folder only', async () => {
  erinTree();
  const t = tok('frank');
  assert.equal((await call('GET', `${ERIN}/messages/m-x`, t)).status, 200, 'READ_ONLY reads every folder');
  addFolderPerm('f-erin-priv', 'user:frank', ROLE_RIGHTS.none);
  assert.equal((await call('GET', `${ERIN}/messages/m-x`, t)).status, 200, 'a folder grant never removes the mailbox-level floor');
  addFolderPerm('f-erin-proj', 'user:frank', ROLE_RIGHTS.editor);
  assert.equal((await call('PATCH', `${ERIN}/messages/m-p1`, t, { read: true })).status, 200);
  const other = await call('PATCH', `${ERIN}/messages/m-erin`, t, { read: true });
  assert.deepEqual([other.status, other.json['code']], [403, 'NO_PERMISSION']);
  const f = await call('GET', `${ERIN}/folders`, t);
  assert.equal((f.json as Row[]).length, 5, 'every folder of the mailbox');
});

test('folder owner right administers the folder; a revocation ends access at once', async () => {
  erinTree();
  addFolderPerm('f-erin-proj', 'user:hank', ROLE_RIGHTS.owner);
  const t = tok('hank');
  assert.equal((await call('GET', `${ERIN}/folders/f-erin-proj/permissions`, t)).status, 200);
  const put = await call('PUT', `${ERIN}/folders/f-erin-proj/permissions`, t, {
    entries: [{ grantee: { userId: 'hank' }, role: 'owner' }, { grantee: { userId: 'bob' }, role: 'reviewer' }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual(folderPerms.map((p) => p['granteeKey']).sort(), ['user:bob', 'user:hank']);
  assert.equal((await call('GET', `${D('mb-erin')}/folders/f-erin-proj/messages`, tok('bob'))).status, 200);
  assert.equal((await call('PATCH', `${ERIN}/folders/f-erin-proj`, t, { color: 'red' })).status, 200, 'owner role manages the folder');

  // erin revokes everything → the next request of hank / bob is refused
  assert.equal((await call('PUT', OWN('f-erin-proj'), tok('erin'), { entries: [] })).status, 200);
  assert.equal(folderPerms.length, 0);
  for (const user of ['hank', 'bob']) {
    assert.equal((await call('GET', `${ERIN}/folders`, tok(user))).json['code'], 'NO_ACCESS', user);
    assert.equal((await call('GET', `${ERIN}/messages/m-p1`, tok(user))).status, 403, user);
  }
});

test('Default: every user gets the folder, not auto-mapped; an explicit None excludes a user', async () => {
  erinTree();
  addFolderPerm('f-erin-proj', 'default', ROLE_RIGHTS.reviewer);
  addFolderPerm('f-erin-proj', 'user:hank', ROLE_RIGHTS.none);
  const bob = await call('GET', '/api/v1/user/accessible-mailboxes', tok('bob'));
  const entry = (bob.json as Row[]).find((e) => e['ref'] === 'delegated:mb-erin')!;
  assert.deepEqual([entry['autoMap'], entry['hidden']], [false, true]);
  assert.equal((await call('GET', `${ERIN}/folders/f-erin-proj/messages`, tok('bob'))).status, 200);
  assert.equal((await call('GET', `${ERIN}/folders`, tok('hank'))).json['code'], 'NO_ACCESS');
  // the owner's own mailbox never appears as a foreign one
  const erin = await call('GET', '/api/v1/user/accessible-mailboxes', tok('erin'));
  assert.ok(!(erin.json as Row[]).some((e) => e['ref'] === 'delegated:mb-erin'));
});

test('admin: overview and per-folder update; admin mailboxes need ORGANIZATION_MANAGEMENT', async () => {
  erinTree();
  addFolderPerm('f-erin-proj', 'user:hank', ROLE_RIGHTS.reviewer);
  addFolder('f-gina-proj', 'mb-gina', 'Projekte');
  const express = (await import('express')).default;
  const { listFolderPermissionsHandler, getFolderPermissionsHandler, putFolderPermissionsHandler } = await import('../lib/folder-permissions-admin.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // x-actor: the admin's user id; x-scope: a domain id → a scoped admin, else organisation-wide
    const scope = req.headers['x-scope'] ? { kind: 'domains', domains: [{ id: String(req.headers['x-scope']), name: 'ex.com' }] } : { kind: 'organisation' };
    (req as unknown as { apiUser: unknown }).apiUser = {
      userId: String(req.headers['x-actor'] ?? 'admin1'), email: 'admin@ex.com', role: String(req.headers['x-role']), adminScope: scope,
    } as never;
    next();
  });
  app.get('/m/:id/folder-permissions', listFolderPermissionsHandler('user'));
  app.get('/m/:id/folders/:folderId/permissions', getFolderPermissionsHandler('user'));
  app.put('/m/:id/folders/:folderId/permissions', putFolderPermissionsHandler('user'));
  app.get('/s/:id/folder-permissions', listFolderPermissionsHandler('shared'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const req = async (method: string, path: string, role: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-role': role, ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, json: await r.json() as Row & Row[] };
  };
  try {
    const overview = await req('GET', '/m/erin/folder-permissions', 'RECIPIENT_MANAGEMENT');
    assert.equal(overview.status, 200);
    const proj = (overview.json as Row[]).find((f) => f['id'] === 'f-erin-proj')!;
    assert.deepEqual((proj['entries'] as Row[]).map((e) => e['granteeKey']), ['default', 'anonymous', 'user:hank']);
    assert.equal((await req('GET', '/m/nobody/folder-permissions', 'RECIPIENT_MANAGEMENT')).status, 404);
    assert.equal((await req('GET', '/s/sm1/folder-permissions', 'RECIPIENT_MANAGEMENT')).status, 200);
    assert.equal((await req('GET', '/m/erin/folders/f-sm1-inbox/permissions', 'RECIPIENT_MANAGEMENT')).status, 404, 'folder of another mailbox');

    // w3 review: an admin below ORGANIZATION_MANAGEMENT never grants to itself — nor to Default (includes it)
    const toDefault = await req('PUT', '/m/erin/folders/f-erin-proj/permissions', 'RECIPIENT_MANAGEMENT', { entries: [{ grantee: 'default', role: 'reviewer' }] });
    assert.deepEqual([toDefault.status, toDefault.json['code']], [403, 'FORBIDDEN_GRANTEE']);
    const toSelf = await req('PUT', '/m/erin/folders/f-erin-proj/permissions', 'RECIPIENT_MANAGEMENT',
      { entries: [{ grantee: { userId: 'hank' }, role: 'reviewer' }, { grantee: { userId: 'frank' }, role: 'owner' }] }, { 'x-actor': 'frank' });
    assert.deepEqual([toSelf.status, toSelf.json['code']], [403, 'FORBIDDEN_GRANTEE']);
    // a scoped admin: grantees of other domains answer like unknown users (no oracle); unchanged entries pass
    const outOfScope = await req('PUT', '/m/erin/folders/f-erin-proj/permissions', 'RECIPIENT_MANAGEMENT',
      { entries: [{ grantee: { userId: 'hank' }, role: 'reviewer' }, { grantee: { email: 'carol@ex.com' }, role: 'reviewer' }] }, { 'x-scope': 'd1' });
    assert.deepEqual([outOfScope.status, outOfScope.json['code']], [400, 'UNKNOWN_GRANTEE']);
    const inScope = await req('PUT', '/m/erin/folders/f-erin-proj/permissions', 'RECIPIENT_MANAGEMENT',
      { entries: [{ grantee: { userId: 'hank' }, role: 'reviewer' }, { grantee: { userId: 'bob' }, role: 'reviewer' }] }, { 'x-scope': 'd1' });
    assert.equal(inScope.status, 200, JSON.stringify(inScope.json));
    assert.deepEqual(folderPerms.map((p) => p['granteeKey']).sort(), ['user:bob', 'user:hank']);

    const put = await req('PUT', '/m/erin/folders/f-erin-proj/permissions', 'ORGANIZATION_MANAGEMENT', { entries: [{ grantee: 'default', role: 'reviewer' }] });
    assert.equal(put.status, 200);
    assert.deepEqual(folderPerms.map((p) => p['granteeKey']), ['default'], 'replaced: hank and bob removed, Default set');
    // lowering / removing is always allowed (also Default, also for a scoped admin)
    assert.equal((await req('PUT', '/m/erin/folders/f-erin-proj/permissions', 'RECIPIENT_MANAGEMENT', { entries: [] }, { 'x-scope': 'd1' })).status, 200);
    assert.equal(folderPerms.length, 0);
    await flush();
    assert.ok(auditRows.some((a) => a['action'] === 'mailbox.folder.permission.remove' && (a['changes'] as Row)['source'] === 'admin'));

    const adminBox = await req('PUT', '/m/gina/folders/f-gina-proj/permissions', 'RECIPIENT_MANAGEMENT', { entries: [] });
    assert.deepEqual([adminBox.status, adminBox.json['code']], [403, 'FORBIDDEN']);
    assert.equal((await req('PUT', '/m/gina/folders/f-gina-proj/permissions', 'ORGANIZATION_MANAGEMENT', { entries: [] })).status, 200);
  } finally {
    server.close();
  }
});

test('w3 review: the folder owner right on one folder never extends to the folders below it', async () => {
  erinTree();
  addFolderPerm('f-erin-proj', 'user:hank', ROLE_RIGHTS.owner); // Projekte only, not Sub
  const t = tok('hank');
  const path = `${ERIN}/folders/f-erin-proj/permissions`;
  for (const entries of [
    [{ grantee: { userId: 'hank' }, role: 'owner', applyToSubfolders: true }], // itself onto Sub
    [{ grantee: { userId: 'hank' }, role: 'owner' }, { grantee: 'default', role: 'reviewer', applyToSubfolders: true }],
    [{ grantee: { userId: 'hank' }, role: 'owner' }, { grantee: { userId: 'bob' }, role: 'reviewer', applyToSubfolders: true }],
  ]) {
    const r = await call('PUT', path, t, { entries });
    assert.deepEqual([r.status, r.json['code']], [403, 'SUBFOLDERS_NOT_ADMINISTERED'], JSON.stringify(entries));
  }
  assert.deepEqual(folderPerms.map((p) => p['granteeKey']), ['user:hank'], 'nothing written');
  assert.equal((await call('GET', `${ERIN}/folders/f-erin-sub/messages`, t)).status, 404);
  // an entry for Projekte alone is fine
  assert.equal((await call('PUT', path, t, { entries: [{ grantee: { userId: 'hank' }, role: 'owner' }, { grantee: { userId: 'bob' }, role: 'reviewer' }] })).status, 200);
  // erin's "None for bob below Projekte" may not be lifted by hank either
  folderPerms.splice(0, folderPerms.length);
  addFolderPerm('f-erin-proj', 'user:hank', ROLE_RIGHTS.owner);
  addFolderPerm('f-erin-proj', 'user:bob', ROLE_RIGHTS.none, true);
  const lift = await call('PUT', path, t, { entries: [{ grantee: { userId: 'hank' }, role: 'owner' }] });
  assert.deepEqual([lift.status, lift.json['code']], [403, 'SUBFOLDERS_NOT_ADMINISTERED']);
  // with the owner right on the whole subtree it may
  folderPerms.splice(0, folderPerms.length);
  addFolderPerm('f-erin-proj', 'user:hank', ROLE_RIGHTS.owner, true);
  assert.equal((await call('PUT', path, t, { entries: [{ grantee: { userId: 'hank' }, role: 'owner', applyToSubfolders: true }, { grantee: 'default', role: 'reviewer', applyToSubfolders: true }] })).status, 200);
});

test('w3 review: a grantee cannot pull other folders below its own by name (create / rename / delete)', async () => {
  erinTree();
  addFolder('f-erin-mr', 'mb-erin', 'Mr. Smith'); // top level, no grants; "." in the name
  addFolder('f-erin-own', 'mb-erin', 'Hank', 'f-erin-proj');
  addFolder('f-erin-old', 'mb-erin', 'Old', 'f-erin-proj');
  addFolder('f-erin-oldsub', 'mb-erin', 'Old.sub'); // IMAP child of "Old"
  addFolderPerm('f-erin-proj', 'user:hank', ROLE_RIGHTS.owner, true);
  const t = tok('hank');
  const create = await call('POST', `${ERIN}/folders`, t, { name: 'Mr', parentId: 'f-erin-proj' });
  assert.deepEqual([create.status, create.json['code']], [403, 'NO_PERMISSION'], '"Mr. Smith" would move below Projekte');
  assert.equal((await call('POST', `${ERIN}/folders`, t, { name: 'Neu', parentId: 'f-erin-proj' })).status, 201);
  const rename = await call('PATCH', `${ERIN}/folders/f-erin-own`, t, { name: 'Mr' });
  assert.deepEqual([rename.status, rename.json['code']], [403, 'NO_PERMISSION']);
  assert.equal((await call('PATCH', `${ERIN}/folders/f-erin-own`, t, { name: 'Hank 2' })).status, 200);
  const del = await call('DELETE', `${ERIN}/folders/f-erin-old`, t);
  assert.deepEqual([del.status, del.json['code']], [403, 'NO_PERMISSION'], '"Old.sub" would lose its parent');
  assert.equal((await call('GET', `${ERIN}/folders/f-erin-mr/messages`, t)).status, 404);
  // the mailbox owner (and full access) is not limited
  assert.equal((await call('POST', `${ERIN}/folders`, tok('dave'), { name: 'Mr', parentId: 'f-erin-proj' })).status, 201);
});

test('w3 review: GET /mail/delegated-mailboxes lists folders only for a read delegation of an active owner', async () => {
  const byMailbox = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r['mailboxId'], (r['folders'] as Row[]).length]));
  const sendAs = await call('GET', '/api/v1/mail/delegated-mailboxes', tok('bob'));
  assert.equal(sendAs.status, 200);
  assert.deepEqual(byMailbox(sendAs.json as Row[]), { 'mb-erin': 0 }, 'SEND_AS only: no folders');
  assert.equal(((sendAs.json as Row[])[0]!['mailboxOwner'] as Row)['active'], undefined, 'shape unchanged');
  assert.deepEqual(byMailbox((await call('GET', '/api/v1/mail/delegated-mailboxes', tok('frank'))).json as Row[]), { 'mb-erin': 2 });
  assert.deepEqual(byMailbox((await call('GET', '/api/v1/mail/delegated-mailboxes', tok('dave'))).json as Row[]), { 'mb-erin': 2, 'mb-gina': 0 }, 'deactivated owner');
});

test('pure: body parsing, fixed entries, SSE folder filter, webmail module gate', () => {
  assert.deepEqual(parsePermissionBody({ entries: [{ grantee: { email: 'a@ex.com' }, role: 'editor' }, { grantee: 'default', rights: 0x401, applyToSubfolders: true }] }), {
    ok: true,
    entries: [
      { grantee: { email: 'a@ex.com' }, rights: ROLE_RIGHTS.editor, applyToSubfolders: false },
      { grantee: 'default', rights: 0x401, applyToSubfolders: true },
    ],
  });
  assert.equal(parsePermissionBody({ entries: [{ grantee: 'default', role: 'none' }, { grantee: 'default', role: 'none' }] }).ok, false, 'duplicate grantee');
  assert.equal(parsePermissionBody({ entries: [{ grantee: 'everyone', role: 'none' }] }).ok, false);
  assert.equal(parsePermissionBody({ entries: [], extra: 1 }).ok, false);
  assert.deepEqual(withFixedEntries([]).map((e) => e.granteeKey), ['default', 'anonymous']);

  assert.deepEqual(visibleFolderIds(['a', 'b'], undefined), ['a', 'b']);
  assert.deepEqual(visibleFolderIds(['a', 'b'], ['b', 'c']), ['b']);
  assert.deepEqual(visibleFolderIds(undefined, ['c']), ['c']);
  assert.deepEqual(visibleFolderIds(['a'], ['c']), []);

  assert.deepEqual(featuresForRequest('PUT', '/api/v1/mail/folders/f1/permissions'), ['sharedMailboxes']);
  assert.deepEqual(featuresForRequest('GET', '/api/v1/mail/folders/f1/messages'), []);
  void folders; void messages;
});
