/**
 * w3 folder permissions — the central access check (listing, per-folder rights,
 * folder lists, single-folder lookups) and the permission writer (validation,
 * audit, replace / single changes), plus the realtime audience of folder grantees.
 * Run: node --import tsx --test src/folder-access.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FolderPermissionError, accessToFolder, describeFolderPermissions, folderAccessForUser, listFolderGrantMailboxes,
  listVisibleForeignMailboxes, listableFolders, loadMailboxFolderAccess, mergeForeignMailboxes, folderNameCollision,
  planFolderPermissionChanges, readableFolderIds, setFolderPermissions, addsRights, affectsSubfolders, subfolderAuthorizer,
  type FolderPermissionWriteDb,
} from './folder-access.js';
import { ALL_FOLDER_RIGHTS, DEFAULT_GRANTEE_KEY, READ_ONLY_FLOOR, ROLE_RIGHTS, normalizeRights } from './folder-permissions.js';
import type { AccessibleMailbox } from './mailbox-access.js';

// The event and audience modules load @coremail/core (configuration at import).
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as unknown as { __prisma: unknown }).__prisma ??= { $on: () => undefined };
const { folderPermissionAudience } = await import('./permission-events.js');
const { audienceFromRow } = await import('./realtime/audience.js');

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond !== null && typeof cond === 'object') {
      const c = cond as { in?: unknown[]; not?: unknown };
      if ('in' in c) return (c.in ?? []).includes(value);
      if ('not' in c) return value !== c.not;
      throw new Error(`fake: unsupported condition ${key}`);
    }
    return value === cond;
  });
}

/**
 * Fixture: owner alice (mailbox mb-a) with INBOX, Projects, Projects/Sub, Private;
 * team shared mailbox (mb-t) with INBOX; dave (inactive owner, mb-d).
 * bob = grantee, carol = READ_ONLY delegate of alice, erin = other user.
 */
function fakeDb() {
  const db = {
    users: [
      { id: 'alice', email: 'alice@example.test', displayName: 'Alice', active: true },
      { id: 'bob', email: 'bob@example.test', displayName: null, active: true },
      { id: 'carol', email: 'carol@example.test', displayName: 'Carol', active: true },
      { id: 'dave', email: 'dave@example.test', displayName: 'Dave', active: false },
      { id: 'erin', email: 'erin@example.test', displayName: 'Erin', active: true },
    ],
    shared: [{ id: 's-team', email: 'team@example.test', displayName: 'Team', active: true }],
    mailboxes: [
      { id: 'mb-a', userId: 'alice', sharedBoxId: null },
      { id: 'mb-b', userId: 'bob', sharedBoxId: null },
      { id: 'mb-d', userId: 'dave', sharedBoxId: null },
      { id: 'mb-t', userId: null, sharedBoxId: 's-team' },
    ],
    folders: [
      { id: 'a-inbox', mailboxId: 'mb-a', name: 'INBOX', parentId: null },
      { id: 'a-proj', mailboxId: 'mb-a', name: 'Projects', parentId: null },
      { id: 'a-sub', mailboxId: 'mb-a', name: 'Sub', parentId: 'a-proj' },
      { id: 'a-priv', mailboxId: 'mb-a', name: 'Private', parentId: null },
      { id: 'b-inbox', mailboxId: 'mb-b', name: 'INBOX', parentId: null },
      { id: 'd-inbox', mailboxId: 'mb-d', name: 'INBOX', parentId: null },
      { id: 't-inbox', mailboxId: 'mb-t', name: 'INBOX', parentId: null },
    ],
    perms: [] as Array<{ folderId: string; mailboxId: string; granteeKey: string; granteeId: string | null; rights: number; applyToSubfolders: boolean; grantedBy?: string }>,
    delegates: [{ mailboxId: 'mb-a', granteeId: 'carol', permission: 'READ_ONLY' }],
    audit: [] as Row[],
  };
  const grant = (folderId: string, granteeKey: string, rights: number, applyToSubfolders = false) => {
    const folder = db.folders.find((f) => f.id === folderId)!;
    db.perms.push({ folderId, mailboxId: folder.mailboxId, granteeKey, granteeId: granteeKey.startsWith('user:') ? granteeKey.slice(5) : null, rights, applyToSubfolders });
  };
  const prisma = {
    sharedMailboxPerm: { findMany: async () => [] },
    mailboxDelegate: {
      findMany: async ({ where }: { where: { granteeId: string } }) => db.delegates.filter((d) => d.granteeId === where.granteeId).map((d) => {
        const owner = db.users.find((u) => db.mailboxes.find((m) => m.id === d.mailboxId)?.userId === u.id)!;
        return { permission: d.permission, autoMap: true, mailbox: { id: d.mailboxId, user: owner } };
      }),
    },
    folderPermission: {
      findMany: async ({ where }: { where: Row }) => db.perms.filter((p) => matches(p as Row, where)).map((p) => ({ ...p })),
      upsert: async ({ where, create, update }: { where: { folderId_granteeKey: { folderId: string; granteeKey: string } }; create: Row; update: Row }) => {
        const k = where.folderId_granteeKey;
        const existing = db.perms.find((p) => p.folderId === k.folderId && p.granteeKey === k.granteeKey);
        if (existing) Object.assign(existing, update); else db.perms.push(create as never);
        return {};
      },
      deleteMany: async ({ where }: { where: Row }) => { db.perms = db.perms.filter((p) => !matches(p as Row, where)); return {}; },
    },
    folder: {
      findMany: async ({ where }: { where: Row }) => db.folders.filter((f) => matches(f as Row, where)),
      findUnique: async ({ where }: { where: { id: string } }) => db.folders.find((f) => f.id === where.id) ?? null,
    },
    mailbox: {
      findMany: async ({ where }: { where: Row }) => db.mailboxes.filter((m) => matches(m as Row, where)),
      findUnique: async ({ where }: { where: { id: string } }) => db.mailboxes.find((m) => m.id === where.id) ?? null,
    },
    user: { findMany: async ({ where }: { where: Row }) => db.users.filter((u) => matches(u as Row, where)) },
    sharedMailbox: { findMany: async ({ where }: { where: Row }) => db.shared.filter((s) => matches(s as Row, where)) },
    auditLog: { create: async ({ data }: { data: Row }) => { db.audit.push(data); return {}; } },
  };
  return { db, grant, prisma: prisma as unknown as FolderPermissionWriteDb };
}

test('folder grants make a mailbox visible: only with a visible folder, never the own one, never with an inactive owner', async () => {
  const { grant, prisma } = fakeDb();
  grant('a-proj', 'user:bob', ROLE_RIGHTS.reviewer);
  grant('b-inbox', DEFAULT_GRANTEE_KEY, ROLE_RIGHTS.reviewer); // bob's own mailbox
  grant('d-inbox', 'user:bob', ROLE_RIGHTS.owner);            // inactive owner
  grant('t-inbox', DEFAULT_GRANTEE_KEY, ROLE_RIGHTS.reviewer); // shared mailbox via Default
  const list = await listFolderGrantMailboxes(prisma, 'bob');
  assert.deepEqual(list.map((a) => [a.kind, a.email, a.readOnly, a.folderScoped, a.autoMap]), [
    ['delegated', 'alice@example.test', true, true, true],
    ['shared', 'team@example.test', true, true, false], // Default only → added by the user
  ]);
  assert.equal(list[1]!.sharedMailboxId, 's-team');
});

test('read without "folder visible" lists nothing; an explicit None excludes the user from Default', async () => {
  const { grant, prisma } = fakeDb();
  grant('a-proj', 'user:bob', 0x1); // ReadAny, not visible
  grant('a-inbox', DEFAULT_GRANTEE_KEY, ROLE_RIGHTS.reviewer);
  grant('a-inbox', 'user:erin', ROLE_RIGHTS.none);
  assert.deepEqual(await listFolderGrantMailboxes(prisma, 'erin'), [], 'erin is excluded from Default');
  assert.equal((await listFolderGrantMailboxes(prisma, 'bob')).length, 1, 'bob sees INBOX through Default');
});

test('mailbox-level grants win the merge; listVisibleForeignMailboxes combines both', async () => {
  const { grant, prisma } = fakeDb();
  grant('a-proj', 'user:carol', ROLE_RIGHTS.editor);
  const list = await listVisibleForeignMailboxes(prisma, 'carol');
  assert.equal(list.length, 1);
  assert.equal(list[0]!.folderScoped, undefined, 'the READ_ONLY delegation is the entry');
  const merged = mergeForeignMailboxes(
    [{ mailboxId: 'm1', kind: 'shared', email: 'z@x.test' } as AccessibleMailbox],
    [{ mailboxId: 'm1', kind: 'shared', email: 'z@x.test', folderScoped: true } as AccessibleMailbox, { mailboxId: 'm2', kind: 'delegated', email: 'a@x.test', folderScoped: true } as AccessibleMailbox],
  );
  assert.deepEqual(merged.map((m) => [m.mailboxId, m.folderScoped ?? false]), [['m2', true], ['m1', false]]);
});

test('per-folder rights: READ_ONLY floor + folder grant; folder-only access has no floor; full access is everything', async () => {
  const { grant, prisma } = fakeDb();
  grant('a-proj', 'user:carol', ROLE_RIGHTS.editor, true);
  grant('a-proj', 'user:bob', ROLE_RIGHTS.reviewer, true);
  const carol = await loadMailboxFolderAccess(prisma, 'carol', { mailboxId: 'mb-a', readOnly: true });
  assert.equal(accessToFolder(carol, 'a-sub').rights, normalizeRights(ROLE_RIGHTS.editor | READ_ONLY_FLOOR));
  assert.equal(accessToFolder(carol, 'a-priv').rights, READ_ONLY_FLOOR);
  const bob = await loadMailboxFolderAccess(prisma, 'bob', { mailboxId: 'mb-a', readOnly: true, folderScoped: true });
  assert.equal(accessToFolder(bob, 'a-sub').rights, ROLE_RIGHTS.reviewer);
  assert.equal(accessToFolder(bob, 'a-priv').rights, 0);
  assert.equal(accessToFolder(bob, 'unknown').rights, 0);
  assert.deepEqual(readableFolderIds(bob, ['a-inbox', 'a-proj', 'a-sub', 'a-priv']), ['a-proj', 'a-sub']);
  const full = await loadMailboxFolderAccess(prisma, 'x', { mailboxId: 'mb-a', readOnly: false });
  assert.deepEqual(accessToFolder(full, 'a-priv'), { level: 'full', rights: ALL_FOLDER_RIGHTS });
});

test('folder lists: visible folders, their ancestors as non-selectable path, nothing else', async () => {
  const { db, grant, prisma } = fakeDb();
  grant('a-sub', 'user:bob', ROLE_RIGHTS.reviewer);
  const bob = await loadMailboxFolderAccess(prisma, 'bob', { mailboxId: 'mb-a', readOnly: true, folderScoped: true });
  const folders = db.folders.filter((f) => f.mailboxId === 'mb-a');
  assert.deepEqual(listableFolders(folders, bob), [{ id: 'a-proj', noSelect: true }, { id: 'a-sub', noSelect: false }]);
  grant('a-proj', 'user:bob', 0x400); // visible only
  const again = await loadMailboxFolderAccess(prisma, 'bob', { mailboxId: 'mb-a', readOnly: true, folderScoped: true });
  assert.deepEqual(listableFolders(folders, again), [{ id: 'a-proj', noSelect: true }, { id: 'a-sub', noSelect: false }]);
  assert.equal(listableFolders(folders, { mailboxId: 'mb-a', level: 'full', rights: null }).length, 4);
});

test('w3 scope leaks: folderNameCollision — a name taken by a folder the user cannot list is "hidden"', async () => {
  const { db, grant, prisma } = fakeDb();
  grant('a-sub', 'user:bob', ROLE_RIGHTS.reviewer);
  const bob = await loadMailboxFolderAccess(prisma, 'bob', { mailboxId: 'mb-a', readOnly: true, folderScoped: true });
  const folders = db.folders.filter((f) => f.mailboxId === 'mb-a');
  const hidden = folders.find((f) => f.id !== 'a-sub' && f.id !== 'a-proj')!.id;
  assert.equal(folderNameCollision(folders, bob, []), 'free');
  assert.equal(folderNameCollision(folders, bob, ['a-sub']), 'visible');
  assert.equal(folderNameCollision(folders, bob, ['a-proj']), 'visible', 'a path entry is listed (its name is known)');
  assert.equal(folderNameCollision(folders, bob, [hidden]), 'hidden');
  assert.equal(folderNameCollision(folders, bob, [hidden, 'a-sub']), 'visible');
  assert.equal(folderNameCollision(folders, { mailboxId: 'mb-a', level: 'full', rights: null }, [hidden]), 'visible', 'mailbox-level access');
});

test('folderAccessForUser: own folder, foreign folder through a grant, no access', async () => {
  const { grant, prisma } = fakeDb();
  grant('a-proj', 'user:bob', ROLE_RIGHTS.reviewer);
  assert.deepEqual(await folderAccessForUser(prisma, 'alice', 'a-priv'), { mailboxId: 'mb-a', access: { level: 'owner', rights: ALL_FOLDER_RIGHTS } });
  assert.deepEqual(await folderAccessForUser(prisma, 'bob', 'a-proj'), { mailboxId: 'mb-a', access: { level: 'grants', rights: ROLE_RIGHTS.reviewer } });
  assert.equal((await folderAccessForUser(prisma, 'bob', 'a-priv'))?.access.rights, 0);
  assert.equal(await folderAccessForUser(prisma, 'erin', 'a-proj'), null);
  assert.equal(await folderAccessForUser(prisma, 'bob', 'missing'), null);
});

test('planFolderPermissionChanges: replace removes absent grantees, Default without rights is no entry, user None stays', () => {
  const current = [
    { folderId: 'f', granteeKey: DEFAULT_GRANTEE_KEY, rights: ROLE_RIGHTS.reviewer, applyToSubfolders: false },
    { folderId: 'f', granteeKey: 'user:a', rights: ROLE_RIGHTS.editor, applyToSubfolders: false },
  ];
  assert.deepEqual(planFolderPermissionChanges(current, [
    { granteeKey: DEFAULT_GRANTEE_KEY, rights: 0, applyToSubfolders: false },
    { granteeKey: 'user:b', rights: 0, applyToSubfolders: false },
  ], true), [
    { granteeKey: DEFAULT_GRANTEE_KEY, before: { rights: ROLE_RIGHTS.reviewer, applyToSubfolders: false }, after: null },
    { granteeKey: 'user:a', before: { rights: ROLE_RIGHTS.editor, applyToSubfolders: false }, after: null },
    { granteeKey: 'user:b', before: null, after: { rights: 0, applyToSubfolders: false } },
  ]);
  assert.deepEqual(planFolderPermissionChanges(current, [{ granteeKey: 'user:a', rights: ROLE_RIGHTS.editor, applyToSubfolders: false }], false), [], 'no-op');
  assert.deepEqual(planFolderPermissionChanges(current, [{ granteeKey: 'user:a', remove: true }], false).map((c) => c.after), [null]);
});

test('setFolderPermissions: writes, audits every change, refuses the owner, unknown users and invalid rights', async () => {
  const { db, prisma } = fakeDb();
  const folder = { id: 'a-proj', mailboxId: 'mb-a', name: 'Projects' };
  const actor = { userId: 'alice', email: 'alice@example.test', source: 'webmail' as const };
  const changes = await setFolderPermissions(prisma, {
    folder, mailboxOwnerId: 'alice', replace: true, actor,
    inputs: [{ granteeKey: 'user:bob', rights: ROLE_RIGHTS.reviewer, applyToSubfolders: true }, { granteeKey: DEFAULT_GRANTEE_KEY, rights: ROLE_RIGHTS.contributor, applyToSubfolders: false }],
  });
  assert.equal(changes.length, 2);
  assert.deepEqual(db.perms.map((p) => [p.granteeKey, p.granteeId, p.rights, p.applyToSubfolders, p.mailboxId]).sort(), [
    ['default', null, ROLE_RIGHTS.contributor, false, 'mb-a'], ['user:bob', 'bob', ROLE_RIGHTS.reviewer, true, 'mb-a'],
  ]);
  assert.equal(db.audit.length, 2);
  const bobAudit = db.audit.find((a) => (a['changes'] as Row)['grantee'] === 'user:bob')!;
  assert.equal(bobAudit['action'], 'mailbox.folder.permission.set');
  assert.equal(bobAudit['targetType'], 'folder');
  assert.deepEqual((bobAudit['changes'] as Row)['after'], { rights: ROLE_RIGHTS.reviewer, role: 'reviewer', applyToSubfolders: true });
  assert.equal((bobAudit['changes'] as Row)['source'], 'webmail');

  await setFolderPermissions(prisma, { folder, mailboxOwnerId: 'alice', replace: false, actor, inputs: [{ granteeKey: 'user:bob', remove: true }] });
  assert.deepEqual(db.perms.map((p) => p.granteeKey), ['default']);
  assert.equal(db.audit.at(-1)!['action'], 'mailbox.folder.permission.remove');

  const refused = async (inputs: never[], code: string) => assert.rejects(
    setFolderPermissions(prisma, { folder, mailboxOwnerId: 'alice', replace: false, actor, inputs }),
    (e: unknown) => e instanceof FolderPermissionError && e.code === code,
  );
  await refused([{ granteeKey: 'user:alice', rights: 1, applyToSubfolders: false }] as never[], 'OWNER_GRANTEE');
  await refused([{ granteeKey: 'user:ghost', rights: 1, applyToSubfolders: false }] as never[], 'UNKNOWN_GRANTEE');
  await refused([{ granteeKey: 'user:bob', rights: 0x800, applyToSubfolders: false }] as never[], 'INVALID_RIGHTS');
  await refused([{ granteeKey: 'anonymous', rights: 0, applyToSubfolders: false }] as never[], 'INVALID_RIGHTS');
  assert.equal(db.audit.length, 3, 'refused changes write nothing');
});

test('w3 review: an authorizer refuses before anything is written; addsRights / affectsSubfolders', async () => {
  const { db, prisma } = fakeDb();
  const folder = { id: 'a-proj', mailboxId: 'mb-a', name: 'Projects' };
  const actor = { userId: 'bob', source: 'webmail' as const };
  await assert.rejects(
    setFolderPermissions(prisma, {
      folder, mailboxOwnerId: 'alice', replace: false, actor, authorize: () => 'FORBIDDEN_GRANTEE',
      inputs: [{ granteeKey: 'user:erin', rights: ROLE_RIGHTS.reviewer, applyToSubfolders: false }],
    }),
    (e: unknown) => e instanceof FolderPermissionError && e.code === 'FORBIDDEN_GRANTEE',
  );
  assert.deepEqual([db.perms.length, db.audit.length], [0, 0]);

  const c = (before: { rights: number; applyToSubfolders: boolean } | null, after: { rights: number; applyToSubfolders: boolean } | null) =>
    ({ granteeKey: 'user:x', before, after });
  assert.equal(addsRights(c(null, { rights: 1, applyToSubfolders: false })), true);
  assert.equal(addsRights(c({ rights: 0x401, applyToSubfolders: false }, { rights: 0x1, applyToSubfolders: true })), false);
  assert.equal(addsRights(c({ rights: 0x401, applyToSubfolders: false }, null)), false);
  assert.equal(affectsSubfolders(c(null, { rights: 1, applyToSubfolders: false })), false);
  assert.equal(affectsSubfolders(c({ rights: 0, applyToSubfolders: true }, null)), true, 'removing an inherited None reaches the subfolders');
  assert.equal(affectsSubfolders(c(null, { rights: 1, applyToSubfolders: true })), true);
});

test('w3 review: subfolderAuthorizer — the folder owner right on one folder does not reach the folders below', async () => {
  const { db, grant, prisma } = fakeDb();
  const folders = db.folders.filter((f) => f.mailboxId === 'mb-a');
  grant('a-proj', 'user:bob', ROLE_RIGHTS.owner); // Projects only, not Sub
  const entry = { mailboxId: 'mb-a', readOnly: true, folderScoped: true };
  const own = await loadMailboxFolderAccess(prisma, 'bob', entry);
  const guard = subfolderAuthorizer(folders, 'a-proj', own);
  const toSub = { granteeKey: 'user:bob', before: { rights: ROLE_RIGHTS.owner, applyToSubfolders: false }, after: { rights: ROLE_RIGHTS.owner, applyToSubfolders: true } };
  assert.equal(guard([toSub]), 'SUBFOLDERS_NOT_ADMINISTERED');
  assert.equal(guard([{ granteeKey: 'user:erin', before: null, after: { rights: ROLE_RIGHTS.reviewer, applyToSubfolders: false } }]), null);
  // with the owner right on the whole subtree (inherited) it may
  db.perms.length = 0;
  grant('a-proj', 'user:bob', ROLE_RIGHTS.owner, true);
  assert.equal(subfolderAuthorizer(folders, 'a-proj', await loadMailboxFolderAccess(prisma, 'bob', entry))([toSub]), null);
  // the mailbox owner always may
  assert.equal(subfolderAuthorizer(folders, 'a-proj', await loadMailboxFolderAccess(prisma, 'alice', 'owner', 'mb-a'))([toSub]), null);
});

test('describeFolderPermissions: own entries (Default first) and inherited ones with their source', async () => {
  const { grant, prisma } = fakeDb();
  grant('a-proj', 'user:bob', ROLE_RIGHTS.reviewer, true);
  grant('a-sub', 'user:carol', ROLE_RIGHTS.author);
  grant('a-sub', DEFAULT_GRANTEE_KEY, ROLE_RIGHTS.reviewer);
  const view = await describeFolderPermissions(prisma, { id: 'a-sub', mailboxId: 'mb-a' });
  assert.deepEqual(view.entries.map((e) => [e.granteeKey, e.role, e.user?.email ?? null]), [
    ['default', 'reviewer', null], ['user:carol', 'author', 'carol@example.test'],
  ]);
  assert.deepEqual(view.inherited.map((e) => [e.granteeKey, e.role, e.fromFolderId, e.user?.displayName]), [['user:bob', 'reviewer', 'a-proj', 'bob@example.test']]);
});

test('permission events reach every user grantee; a Default change one fallback user', () => {
  assert.deepEqual(folderPermissionAudience([
    { granteeKey: 'user:a', before: null, after: { rights: 1, applyToSubfolders: false } },
    { granteeKey: DEFAULT_GRANTEE_KEY, before: null, after: { rights: 1, applyToSubfolders: false } },
    { granteeKey: 'user:a', before: null, after: null },
  ], 'owner'), ['a', 'owner']);
});

test('realtime audience: folder grantees hear about their readable folders only', () => {
  const members = audienceFromRow({
    id: 'mb-a', userId: 'alice', sharedBoxId: null, sharedBox: null, user: { active: true },
    delegates: [{ granteeId: 'carol', permission: 'READ_ONLY', grantee: { active: true } }],
    folders: [{ id: 'f1', name: 'INBOX', parentId: null }, { id: 'f2', name: 'Projects', parentId: null }],
    folderPermissions: [
      { folderId: 'f2', granteeKey: 'user:bob', granteeId: 'bob', rights: ROLE_RIGHTS.reviewer, applyToSubfolders: false, grantee: { active: true } },
      { folderId: 'f2', granteeKey: 'user:carol', granteeId: 'carol', rights: ROLE_RIGHTS.editor, applyToSubfolders: false, grantee: { active: true } },
      { folderId: 'f2', granteeKey: 'user:erin', granteeId: 'erin', rights: ROLE_RIGHTS.contributor, applyToSubfolders: false, grantee: { active: true } },
      { folderId: 'f1', granteeKey: 'user:off', granteeId: 'off', rights: ROLE_RIGHTS.reviewer, applyToSubfolders: false, grantee: { active: false } },
    ],
  });
  assert.deepEqual(members, [
    { userId: 'alice', mailboxKey: 'own' },
    { userId: 'carol', mailboxKey: 'delegated:mb-a' }, // mailbox-level: the whole mailbox
    { userId: 'bob', mailboxKey: 'delegated:mb-a', folderIds: ['f2'] },
    // erin (contributor: no read right) and the inactive user hear nothing
  ]);
});
