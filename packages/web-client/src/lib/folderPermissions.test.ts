import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FolderRight, ALL_FOLDER_RIGHTS, FOLDER_ROLES, ROLE_RIGHTS, ROLE_LABELS, NEW_GRANTEE_ROLE,
  normalizeRights, roleOf, roleLabel, roleChoices, formFromRights, rightsFromForm,
  granteeLabel, isFixedEntry, isRemovableEntry, addGrantee, removeGrantee, hasGrantee,
  setEntryRights, setEntryRole, setEntryApplyToSubfolders, granteeOf, buildPermissionsBody,
  permissionsChanged, inheritedFromLabel, folderMenuAccess, directorySuggestions,
  READ_OPTIONS, WRITE_OPTIONS, DELETE_OPTIONS, OTHER_OPTIONS,
  type PermissionEntry, type FolderMyRights,
} from './folderPermissions.ts';

const entry = (over: Partial<PermissionEntry>): PermissionEntry => ({
  granteeKey: 'default', user: null, rights: 0, role: 'none', applyToSubfolders: false, ...over,
});

const loaded = (): PermissionEntry[] => [
  entry({}),
  entry({ granteeKey: 'anonymous', fixed: true }),
  entry({ granteeKey: 'user:u1', user: { id: 'u1', email: 'max@example.test', displayName: 'Max Muster' }, rights: 0x401, role: 'reviewer' }),
];

test('rights bits and roles match the storage model', () => {
  assert.equal(ALL_FOLDER_RIGHTS, 0x7fb);
  assert.deepEqual([...FOLDER_ROLES], ['owner', 'publishingEditor', 'editor', 'publishingAuthor', 'author', 'nonEditingAuthor', 'reviewer', 'contributor', 'none']);
  assert.deepEqual(
    FOLDER_ROLES.map((r) => ROLE_RIGHTS[r]),
    [0x7fb, 0x4fb, 0x47b, 0x49b, 0x41b, 0x413, 0x401, 0x402, 0],
  );
  assert.equal(FolderRight.FolderVisible, 0x400);
  for (const r of FOLDER_ROLES) assert.equal(roleOf(ROLE_RIGHTS[r]), r);
});

test('German role labels in the Outlook order, custom last', () => {
  assert.deepEqual(roleChoices('reviewer').map(roleLabel), [
    'Besitzer', 'Veröffentlichender Bearbeiter', 'Bearbeiter', 'Veröffentlichender Autor', 'Autor',
    'Nicht bearbeitender Autor', 'Prüfer', 'Mitwirkender', 'Keine',
  ]);
  assert.deepEqual(roleChoices('custom').at(-1), 'custom');
  assert.equal(ROLE_LABELS.custom, 'Benutzerdefiniert');
  const texts = [...Object.values(ROLE_LABELS), ...READ_OPTIONS.map((o) => o.label), ...WRITE_OPTIONS.map((o) => o.label),
    ...DELETE_OPTIONS.map((o) => o.label), ...OTHER_OPTIONS.map((o) => o.label)];
  for (const t of texts) assert.doesNotMatch(t, /Exchange|RFC/);
});

test('normalisation: unknown bits dropped, all implies own', () => {
  assert.equal(normalizeRights(0x20), 0x28);
  assert.equal(normalizeRights(0x40), 0x50);
  assert.equal(normalizeRights(0x4 | 0x800 | 0x1), 0x1);
  assert.equal(normalizeRights(-1), 0);
  assert.equal(normalizeRights(1.5), 0);
  assert.equal(roleOf(0x1), 'custom');
  assert.equal(roleOf(0x20 | 0x401 | 0x40 | 0x3 | 0x80 | 0x100 | 0x200), 'owner');
});

test('checkbox model round-trips every role', () => {
  for (const r of FOLDER_ROLES) assert.equal(rightsFromForm(formFromRights(ROLE_RIGHTS[r])), ROLE_RIGHTS[r], r);
  const author = formFromRights(ROLE_RIGHTS.author);
  assert.deepEqual(author, {
    readAll: true, createItems: true, createSubfolders: false, editOwn: true, editAll: false,
    deleteLevel: 'own', folderOwner: false, folderContact: false, folderVisible: true,
  });
  assert.equal(formFromRights(ROLE_RIGHTS.owner).deleteLevel, 'all');
  assert.equal(formFromRights(0).deleteLevel, 'none');
  // "Alle bearbeiten" implies "Eigene bearbeiten"
  assert.equal(rightsFromForm({ ...formFromRights(0), editAll: true }), 0x28);
});

test('changing a checkbox switches to the matching role or custom', () => {
  const list = loaded();
  const reviewerPlusCreate = rightsFromForm({ ...formFromRights(0x401), createItems: true });
  const custom = setEntryRights(list, 'user:u1', reviewerPlusCreate);
  assert.equal(custom[2]!.role, 'custom');
  const back = setEntryRights(custom, 'user:u1', rightsFromForm({ ...formFromRights(reviewerPlusCreate), createItems: false }));
  assert.equal(back[2]!.role, 'reviewer');
  const editor = setEntryRole(list, 'user:u1', 'editor');
  assert.equal(editor[2]!.rights, 0x47b);
  assert.equal(editor[2]!.role, 'editor');
  assert.deepEqual(setEntryRole(list, 'user:u1', 'custom'), list);
  // Anonymous stays "Keine"
  assert.deepEqual(setEntryRole(list, 'anonymous', 'owner')[1], list[1]);
  assert.equal(setEntryApplyToSubfolders(list, 'default', true)[0]!.applyToSubfolders, true);
  assert.equal(setEntryApplyToSubfolders(list, 'anonymous', true)[1]!.applyToSubfolders, false);
});

test('grantee labels, fixed and removable entries', () => {
  const [def, anon, user] = loaded();
  assert.equal(granteeLabel(def!), 'Standard');
  assert.equal(granteeLabel(anon!), 'Anonym');
  assert.equal(granteeLabel(user!), 'Max Muster <max@example.test>');
  assert.equal(granteeLabel(entry({ granteeKey: 'user:u2', user: { id: 'u2', email: 'a@example.test', displayName: '' } })), 'a@example.test');
  assert.ok(isFixedEntry(anon!));
  assert.ok(!isFixedEntry(def!));
  assert.ok(!isRemovableEntry(def!) && !isRemovableEntry(anon!) && isRemovableEntry(user!));
  assert.equal(removeGrantee(loaded(), 'default').length, 3);
  assert.equal(removeGrantee(loaded(), 'user:u1').length, 2);
});

test('adding a user: by address (webmail) or id (BCP), no duplicates', () => {
  const byMail = addGrantee(loaded(), { email: 'Eva@Example.test', displayName: 'Eva' });
  assert.equal(byMail.length, 4);
  assert.equal(byMail[3]!.granteeKey, 'email:eva@example.test');
  assert.equal(byMail[3]!.role, NEW_GRANTEE_ROLE);
  assert.deepEqual(granteeOf(byMail[3]!), { email: 'Eva@Example.test' });
  assert.equal(addGrantee(byMail, { email: 'eva@example.test', displayName: 'Eva' }).length, 4);
  assert.equal(addGrantee(loaded(), { email: 'MAX@example.test', displayName: 'Max' }).length, 3);
  const byId = addGrantee(loaded(), { id: 'u9', email: 'u9@example.test', displayName: 'U9' });
  assert.deepEqual(granteeOf(byId[3]!), { userId: 'u9' });
  assert.ok(hasGrantee(byId, { id: 'u9', email: 'other@example.test' }));
});

test('w3 scope leaks: the grantee picker offers address-list users only, none already listed', () => {
  const found = [
    { id: 'c-1', displayName: 'Privatkontakt', email: 'friend@elsewhere.test' }, // private contact
    { id: 'gal-u1', displayName: 'Max Muster', email: 'max@example.test' }, // already a grantee
    { id: 'gal-u2', displayName: 'Eva', email: 'eva@example.test' },
    { id: 'group-g1', displayName: 'Team', email: '' },
    { id: 'gal-u3', displayName: 'Ute', email: 'ute@example.test' },
  ];
  assert.deepEqual(directorySuggestions(found, loaded(), 8).map((c) => c.id), ['gal-u2', 'gal-u3']);
  assert.deepEqual(directorySuggestions(found, loaded(), 1).map((c) => c.id), ['gal-u2']);
});

test('PUT body: role when it matches, else rights; Anonymous left out', () => {
  let list = addGrantee(loaded(), { email: 'eva@example.test', displayName: 'Eva' });
  list = setEntryRights(list, 'email:eva@example.test', 0x3);
  list = setEntryApplyToSubfolders(list, 'user:u1', true);
  assert.deepEqual(buildPermissionsBody(list), {
    entries: [
      { grantee: 'default', role: 'none', applyToSubfolders: false },
      { grantee: { userId: 'u1' }, role: 'reviewer', applyToSubfolders: true },
      { grantee: { email: 'eva@example.test' }, rights: 0x3, applyToSubfolders: false },
    ],
  });
  assert.equal(granteeOf(entry({ granteeKey: 'group:x' })), null);
});

test('change detection and inherited hint', () => {
  const list = loaded();
  assert.ok(!permissionsChanged(list, loaded()));
  assert.ok(permissionsChanged(list, setEntryRole(list, 'default', 'reviewer')));
  assert.ok(permissionsChanged(list, removeGrantee(list, 'user:u1')));
  assert.equal(inheritedFromLabel('Projekte'), 'Geerbt von „Projekte"');
  assert.equal(inheritedFromLabel(undefined), 'Geerbt von übergeordnetem Ordner');
});

test('folder menu access from myRights, else the mailbox read-only flag', () => {
  const none: FolderMyRights = {
    read: true, createItems: false, editOwn: false, editAll: false, deleteOwn: false, deleteAll: false,
    createSubfolders: false, manageFolder: false, administer: false,
  };
  assert.deepEqual(folderMenuAccess(none, false), { markAllRead: false, createSubfolder: false, manage: false, empty: false, permissions: false });
  assert.deepEqual(
    folderMenuAccess({ ...none, editAll: true, createSubfolders: true, manageFolder: true, deleteAll: true, administer: true }, true),
    { markAllRead: true, createSubfolder: true, manage: true, empty: true, permissions: true },
  );
  assert.deepEqual(folderMenuAccess(undefined, false), { markAllRead: true, createSubfolder: true, manage: true, empty: true, permissions: false });
  assert.deepEqual(folderMenuAccess(undefined, true), { markAllRead: false, createSubfolder: false, manage: false, empty: false, permissions: false });
});
