/**
 * Retention worker: pure tag resolution + full runs
 * over in-memory mailboxes (storage test-support fake behind globalThis.__prisma,
 * real message store, real purge path).
 * Run: node --import tsx --import ../storage/src/test-support/realtime-off.ts --test src/retention/worker.test.ts
 *      (in packages/backup-service)
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { EffectiveTag, FolderNode, PolicyRow } from './worker.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';
delete process.env['DELETED_ITEM_RETENTION_DAYS'];
delete process.env['RETENTION_DRY_RUN'];

type Row = Record<string, unknown>;

const { createFake, emptyDb } = await import('../../../storage/src/test-support/mailbox-fake.js');
const db = emptyDb();
const fake = createFake(db) as Record<string, Record<string, unknown>>;
const extra = { policies: [] as Row[], tags: [] as Row[], domains: [] as Row[], runs: [] as Row[] };
fake['retentionPolicy'] = { findMany: async ({ where }: { where?: Row } = {}) => extra.policies.filter((p) => where?.['enabled'] === undefined || p['enabled'] === where['enabled']) };
fake['retentionTag'] = { findMany: async () => extra.tags.map((t) => ({ ...t })) };
fake['domain'] = { findUnique: async ({ where }: { where: Row }) => extra.domains.find((d) => d['name'] === where['name']) ?? null };
fake['managedFolderRun'] = {
  create: async ({ data }: { data: Row }) => { const r = { id: `run${extra.runs.length + 1}`, ...data }; extra.runs.push(r); return r; },
  update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(extra.runs.find((r) => r['id'] === where['id'])!, data),
};
fake['activeSyncItem'] = { deleteMany: async () => ({ count: 0 }) };
(globalThis as Record<string, unknown>)['__prisma'] = fake;

const { setMailboxChangePublisher } = await import('@coremail/storage');
const {
  runRetentionPolicies, mergePolicyTags, legacyTag, folderRules, itemTag, policyTagsOf,
} = await import('./worker.js');

const DAY = 86_400_000;
const events: Row[] = [];
setMailboxChangePublisher(async (c) => { events.push(c as unknown as Row); });

// ── builders ────────────────────────────────────────────────────────────────

function tag(id: string, type: 'DPT' | 'RPT' | 'PERSONAL', action: string, retentionDays: number, folderTarget: string | null = null, enabled = true): Row {
  return { id, name: id, type, action, retentionDays, folderTarget: type === 'DPT' ? 'ALL_OTHER' : folderTarget, enabled };
}
function policy(id: string, tags: Row[], assignments: Array<{ target: string; targetId?: string }>, legacy: Partial<Row> = {}): Row {
  return {
    id, name: id, enabled: true, retentionDays: 0, action: 'ARCHIVE', targetFolder: null, scope: 'ALL_ITEMS',
    ...legacy,
    assignments: assignments.map((a) => ({ target: a.target, targetId: a.targetId ?? '' })),
    policyTags: tags.map((t) => ({ tag: t })),
  };
}
let uid = 0;
function mailbox(id: string, owner: { userId?: string; sharedBoxId?: string }): void {
  db.mailboxes.push({ id, userId: owner.userId ?? null, sharedBoxId: owner.sharedBoxId ?? null, uidNext: 10_000, highestModSeq: 100n });
}
function folder(id: string, mailboxId: string, name: string, parentId: string | null = null, retentionTagId: string | null = null): void {
  db.folders.push({ id, mailboxId, name, displayName: name, parentId, retentionTagId, totalCount: 0, unreadCount: 0 });
}
function msg(id: string, folderId: string, ageDays: number, more: Row = {}): void {
  db.messages.push({
    id, folderId, uid: ++uid, modSeq: 1n, flags: [], subject: id, rawSize: 10, storagePath: null, flagStatus: 'none',
    createdAt: new Date(Date.now() - ageDays * DAY),
    date: new Date('1999-01-01T00:00:00Z'), // forged Date header — never the age basis
    deletedAt: null, softDeletedAt: null, restoredAt: null, retentionTagId: null, retentionExpiresAt: null,
    ...more,
  });
}
const row = (id: string) => db.messages.find((m) => m['id'] === id);
const folderOf = (id: string) => row(id)?.['folderId'] as string | undefined;
const folderByName = (mailboxId: string, name: string) => db.folders.find((f) => f['mailboxId'] === mailboxId && f['name'] === name);
const modSeqOf = (mailboxId: string) => db.mailboxes.find((m) => m['id'] === mailboxId)!['highestModSeq'] as bigint;

function reset(): void {
  for (const list of Object.values(db)) (list as Row[]).length = 0;
  for (const list of Object.values(extra)) list.length = 0;
  events.length = 0;
  delete process.env['DELETED_ITEM_RETENTION_DAYS'];
}

// ── pure: tag resolution ────────────────────────────────────────────────────

const T = (id: string, type: EffectiveTag['type'], days: number, folderTarget: string | null = null, action: EffectiveTag['action'] = 'DELETE_AND_ALLOW_RECOVERY'): EffectiveTag =>
  ({ id, name: id, type, action, retentionDays: days, enabled: true, folderTarget });

describe('mergePolicyTags', () => {
  test('the most specific assignment wins a slot, independent of the order', () => {
    const globalJunk = T('g-junk', 'RPT', 14, 'JUNK_EMAIL', 'PERMANENTLY_DELETE');
    const userJunk = T('u-junk', 'RPT', 365, 'JUNK_EMAIL');
    const globalDpt = T('g-dpt', 'DPT', 1825, 'ALL_OTHER');
    for (const entries of [
      [{ rank: 0, tags: [globalJunk, globalDpt] }, { rank: 2, tags: [userJunk] }],
      [{ rank: 2, tags: [userJunk] }, { rank: 0, tags: [globalJunk, globalDpt] }],
    ]) {
      const m = mergePolicyTags(entries);
      assert.equal(m.rpt.get('JUNK_EMAIL')?.id, 'u-junk');
      assert.equal(m.dpt?.id, 'g-dpt', 'other slots still merge');
    }
  });

  test('same specificity: the longer retention period wins, then the smaller id', () => {
    const a = T('b-3y', 'DPT', 1095, 'ALL_OTHER', 'MOVE_TO_ARCHIVE');
    const b = T('a-5y', 'DPT', 1825, 'ALL_OTHER');
    assert.equal(mergePolicyTags([{ rank: 0, tags: [a] }, { rank: 0, tags: [b] }]).dpt?.id, 'a-5y');
    assert.equal(mergePolicyTags([{ rank: 0, tags: [b] }, { rank: 0, tags: [a] }]).dpt?.id, 'a-5y');
    const c = T('c', 'DPT', 1825, 'ALL_OTHER');
    assert.equal(mergePolicyTags([{ rank: 1, tags: [c] }, { rank: 1, tags: [b] }]).dpt?.id, 'a-5y');
  });

  test('policyTagsOf: disabled and PERSONAL tags do not fill policy slots', () => {
    const p = policy('p', [tag('off', 'DPT', 'PERMANENTLY_DELETE', 1, null, false), tag('pers', 'PERSONAL', 'PERMANENTLY_DELETE', 1)], []) as unknown as PolicyRow;
    assert.deepEqual(policyTagsOf(p), []);
  });
});

describe('legacyTag (policies without tags)', () => {
  const base = { id: 'p', name: 'p', targetFolder: null, policyTags: [] as PolicyRow['policyTags'] };
  test('the scope is kept: JUNK → RPT of the Junk folder, ALL_ITEMS → DPT', () => {
    assert.deepEqual(
      [legacyTag({ ...base, retentionDays: 14, action: 'DELETE', scope: 'JUNK' })?.type, legacyTag({ ...base, retentionDays: 14, action: 'DELETE', scope: 'JUNK' })?.folderTarget],
      ['RPT', 'JUNK_EMAIL'],
    );
    assert.equal(legacyTag({ ...base, retentionDays: 30, action: 'ARCHIVE', scope: 'INBOX' })?.folderTarget, 'INBOX');
    assert.equal(legacyTag({ ...base, retentionDays: 30, action: 'ARCHIVE', scope: 'ALL_ITEMS' })?.type, 'DPT');
    assert.equal(legacyTag({ ...base, retentionDays: 30, action: 'DELETE', scope: 'ALL_ITEMS' })?.action, 'PERMANENTLY_DELETE');
  });
  test('no legacy tag: tagged policy, 0 days, unknown scope, MOVE_TO_FOLDER without folder', () => {
    assert.equal(legacyTag({ ...base, policyTags: [{ tag: tag('x', 'DPT', 'MOVE_TO_ARCHIVE', 1) as never }], retentionDays: 30, action: 'ARCHIVE', scope: 'ALL_ITEMS' }), null);
    assert.equal(legacyTag({ ...base, retentionDays: 0, action: 'ARCHIVE', scope: 'ALL_ITEMS' }), null);
    assert.equal(legacyTag({ ...base, retentionDays: 30, action: 'ARCHIVE', scope: 'CALENDAR' }), null);
    assert.equal(legacyTag({ ...base, retentionDays: 30, action: 'MOVE_TO_FOLDER', scope: 'ALL_ITEMS' }), null);
    assert.equal(legacyTag({ ...base, targetFolder: 'Ablage', retentionDays: 30, action: 'MOVE_TO_FOLDER', scope: 'ALL_ITEMS' })?.targetFolder, 'Ablage');
  });
});

describe('folderRules (inheritance and precedence)', () => {
  const inboxRpt = T('rpt-inbox', 'RPT', 365, 'INBOX', 'MOVE_TO_ARCHIVE');
  const junkRpt = T('rpt-junk', 'RPT', 14, 'JUNK_EMAIL', 'PERMANENTLY_DELETE');
  const dpt = T('dpt', 'DPT', 1825, 'ALL_OTHER');
  const personal = T('pers', 'PERSONAL', 30);
  const legacyMarkedDpt = T('dpt-old', 'DPT', 2555, 'ALL_OTHER', 'MARK_AS_PAST_RETENTION_LIMIT');
  const tags = new Map([personal, inboxRpt, junkRpt, dpt, legacyMarkedDpt].map((t) => [t.id, t]));
  const merged = { dpt, rpt: new Map([['INBOX', inboxRpt], ['JUNK_EMAIL', junkRpt]]) };
  const f = (id: string, name: string, parentId: string | null = null, retentionTagId: string | null = null): FolderNode =>
    ({ id, name, displayName: name, parentId, retentionTagId });
  const folders = [
    f('inbox', 'INBOX'), f('proj', 'Projekte', 'inbox'), f('proj2', 'Unterordner', 'proj'),
    f('imap', 'INBOX.Kunden'), f('spam-sub', 'Spam', 'inbox'), f('junk', 'Junk'),
    f('mine', 'Meins', null, 'pers'), f('mine-sub', 'Alt', 'mine'), f('inbox-tagged-sub', 'Wichtig', 'inbox', 'pers'),
    f('ri', 'Recoverable Items'), f('ri-del', 'Recoverable Items/Deletions', 'ri'), f('other', 'Sonstiges'),
    f('wrongtype', 'Falsch', null, 'dpt-old'),
  ];
  const rules = folderRules(folders, tags, merged);
  const tagOf = (id: string) => rules.get(id)!.tag?.id ?? null;

  test('subfolders inherit the RPT of their default folder (webmail parentId and IMAP "." names)', () => {
    assert.equal(tagOf('inbox'), 'rpt-inbox');
    assert.equal(tagOf('proj'), 'rpt-inbox');
    assert.equal(tagOf('proj2'), 'rpt-inbox');
    assert.equal(tagOf('imap'), 'rpt-inbox');
  });
  test('a subfolder named like a default folder is not that default folder', () => {
    assert.equal(tagOf('spam-sub'), 'rpt-inbox', 'INBOX/Spam must not get the 14-day Junk purge');
    assert.equal(tagOf('junk'), 'rpt-junk');
  });
  test('personal folder tags beat RPT/DPT and are inherited; other folders get the DPT', () => {
    assert.equal(tagOf('mine'), 'pers');
    assert.equal(tagOf('mine-sub'), 'pers');
    assert.equal(tagOf('inbox-tagged-sub'), 'pers');
    assert.equal(tagOf('other'), 'dpt');
    assert.equal(tagOf('wrongtype'), 'dpt', 'a non-PERSONAL tag id on a folder is ignored');
  });
  test('Recoverable Items and below are skipped', () => {
    assert.equal(rules.get('ri')!.skip, true);
    assert.equal(rules.get('ri-del')!.skip, true);
  });
  test('item: own personal tag first; a DPT id written by an old MARK run is ignored', () => {
    assert.equal(itemTag('pers', rules.get('junk')!, tags)?.id, 'pers');
    assert.equal(itemTag('dpt-old', rules.get('junk')!, tags)?.id, 'rpt-junk');
    assert.equal(itemTag(null, rules.get('proj')!, tags)?.id, 'rpt-inbox');
  });
});

// ── full runs ───────────────────────────────────────────────────────────────

describe('runRetentionPolicies — full pass over in-memory mailboxes', () => {
  beforeEach(reset);

  function orgFixture(): void {
    extra.domains.push({ id: 'd1', name: 'example.com' }, { id: 'd2', name: 'other.org' });
    db.users.push(
      { id: 'alice', email: 'alice@example.com', domainId: 'd1', active: true },
      { id: 'bob', email: 'bob@example.com', domainId: 'd1', active: true },
      { id: 'carol', email: 'carol@other.org', domainId: 'd2', active: false },
    );
    db.sharedMailboxes.push({ id: 'team', email: 'team@example.com', domainId: 'd1', active: true });
    mailbox('mb-alice', { userId: 'alice' });
    mailbox('mb-bob', { userId: 'bob' });
    mailbox('mb-carol', { userId: 'carol' });
    mailbox('mb-team', { sharedBoxId: 'team' });
    for (const mb of ['alice', 'bob', 'carol', 'team']) {
      for (const name of ['INBOX', 'Sent', 'Trash', 'Junk', 'Drafts', 'Archive']) folder(`${mb}-${name}`, `mb-${mb}`, name);
    }
    const dpt = tag('dpt-5y', 'DPT', 'DELETE_AND_ALLOW_RECOVERY', 1825);
    const inbox = tag('rpt-inbox-1y', 'RPT', 'MOVE_TO_ARCHIVE', 365, 'INBOX');
    const junk = tag('rpt-junk-14', 'RPT', 'PERMANENTLY_DELETE', 14, 'JUNK_EMAIL');
    const junkKeep = tag('rpt-junk-keep', 'RPT', 'PERMANENTLY_DELETE', 365, 'JUNK_EMAIL');
    extra.tags.push(dpt, inbox, junk, junkKeep);
    extra.policies.push(
      policy('org', [dpt, inbox, junk], [{ target: 'GLOBAL' }]),
      policy('bob-legal', [junkKeep], [{ target: 'USER', targetId: 'bob' }]),
    );
  }

  test('actions, scopes, inheritance and the recoverable window', async () => {
    orgFixture();
    folder('alice-Proj', 'mb-alice', 'Projekte', 'alice-INBOX');
    folder('alice-Arch2020', 'mb-alice', '2020', 'alice-Archive');
    msg('a-inbox-old', 'alice-INBOX', 400);
    msg('a-inbox-new', 'alice-INBOX', 10);
    msg('a-proj-old', 'alice-Proj', 400);
    msg('a-junk-old', 'alice-Junk', 20);
    msg('a-junk-new', 'alice-Junk', 5);
    msg('a-arch-old', 'alice-Arch2020', 400); // MOVE_TO_ARCHIVE never flattens the archive
    msg('a-arch-ancient', 'alice-Archive', 2000); // DPT applies in the archive too
    msg('a-trash-ancient', 'alice-Trash', 2000);
    msg('a-trash-tomb', 'alice-Trash', 2000, { deletedAt: new Date() }); // tombstone: not the MFA's business
    msg('b-junk-old', 'bob-Junk', 20); // USER policy keeps bob's junk for a year
    msg('c-junk-old', 'carol-Junk', 20); // inactive user: GLOBAL does not reach her
    msg('t-junk-old', 'team-Junk', 20); // GLOBAL reaches shared mailboxes
    msg('t-inbox-old', 'team-INBOX', 400);
    const aliceBefore = modSeqOf('mb-alice');

    const r = await runRetentionPolicies();

    const archive = 'alice-Archive';
    assert.equal(folderOf('a-inbox-old'), archive);
    assert.equal(folderOf('a-inbox-new'), 'alice-INBOX');
    assert.equal(folderOf('a-proj-old'), archive, 'subfolder of INBOX inherits the Inbox RPT');
    assert.equal(row('a-junk-old'), undefined, 'permanently deleted');
    assert.equal(folderOf('a-junk-new'), 'alice-Junk');
    assert.equal(folderOf('a-arch-old'), 'alice-Arch2020');
    const deletions = folderByName('mb-alice', 'Recoverable Items/Deletions');
    assert.ok(deletions, 'Deletions folder created on demand');
    assert.equal(folderOf('a-arch-ancient'), deletions['id']);
    assert.equal(folderOf('a-trash-ancient'), deletions['id']);
    assert.ok(row('a-trash-ancient')!['softDeletedAt'] instanceof Date);
    assert.equal(folderOf('a-trash-tomb'), 'alice-Trash');
    assert.equal(folderOf('b-junk-old'), 'bob-Junk');
    assert.equal(folderOf('c-junk-old'), 'carol-Junk');
    assert.equal(row('t-junk-old'), undefined);
    assert.equal(folderOf('t-inbox-old'), 'team-Archive');
    assert.equal(folderByName('mb-bob', 'Recoverable Items'), undefined, 'no Recoverable Items folders where nothing was deleted');

    // message store: moved rows got new UIDs and a new modSeq of their own mailbox
    assert.ok(modSeqOf('mb-alice') > aliceBefore);
    assert.ok((row('a-inbox-old')!['uid'] as number) >= 10_000);
    assert.ok((row('a-inbox-old')!['modSeq'] as bigint) > aliceBefore);
    assert.equal(modSeqOf('mb-carol'), 100n, 'untouched mailbox: no write');
    // folder counters follow the moves
    assert.equal(db.folders.find((f) => f['id'] === archive)!['totalCount'], 2);
    // realtime: the writes published mailbox changes
    assert.ok(events.some((e) => e['mailboxId'] === 'mb-alice'));

    assert.equal(r.itemsArchived, 3);
    assert.equal(r.itemsSoftDeleted, 2);
    assert.equal(r.itemsHardDeleted, 2);
    assert.equal(r.mailboxesScanned, 3, 'alice, bob, team');
    assert.deepEqual(r.errors, []);
    const run = extra.runs[0]!;
    assert.ok(run['completedAt'] instanceof Date);
    assert.equal(run['itemsArchived'], 3);

    // idempotent: a second run changes nothing
    const seqAfter = modSeqOf('mb-alice');
    const again = await runRetentionPolicies();
    assert.equal(again.itemsArchived + again.itemsSoftDeleted + again.itemsHardDeleted + again.itemsMarked, 0);
    assert.equal(modSeqOf('mb-alice'), seqAfter);
  });

  test('recoverable items: purged only after DELETED_ITEM_RETENTION_DAYS (30), never with 0', async () => {
    orgFixture();
    folder('alice-RI', 'mb-alice', 'Recoverable Items');
    folder('alice-RID', 'mb-alice', 'Recoverable Items/Deletions', 'alice-RI');
    folder('alice-RIP', 'mb-alice', 'Recoverable Items/Purges', 'alice-RI');
    msg('del-20', 'alice-RID', 4000, { softDeletedAt: new Date(Date.now() - 20 * DAY) });
    msg('del-31', 'alice-RID', 4000, { softDeletedAt: new Date(Date.now() - 31 * DAY) });
    msg('del-manual', 'alice-RID', 4000); // moved there by a client: no softDeletedAt, kept
    msg('purge-legacy', 'alice-RIP', 1);

    process.env['DELETED_ITEM_RETENTION_DAYS'] = '0';
    await runRetentionPolicies();
    assert.ok(row('del-31'), '0 = keep until purged by hand');
    assert.equal(row('purge-legacy'), undefined, 'Purges is emptied');

    delete process.env['DELETED_ITEM_RETENTION_DAYS'];
    const r = await runRetentionPolicies();
    assert.ok(row('del-20'), 'within the 30-day window the webmail shows');
    assert.equal(row('del-31'), undefined);
    assert.ok(row('del-manual'));
    assert.equal(r.itemsHardDeleted, 1);
    assert.equal(folderOf('del-20'), 'alice-RID', 'the tag pass never touches Recoverable Items');
  });

  test('MARK_AS_PAST_RETENTION_LIMIT marks once and keeps the item tag', async () => {
    db.users.push({ id: 'u', email: 'u@example.com', domainId: 'd1', active: true });
    mailbox('mb-u', { userId: 'u' });
    folder('u-INBOX', 'mb-u', 'INBOX');
    const mark = tag('mark-7y', 'DPT', 'MARK_AS_PAST_RETENTION_LIMIT', 2555);
    extra.tags.push(mark);
    extra.policies.push(policy('p', [mark], [{ target: 'GLOBAL' }]));
    msg('old', 'u-INBOX', 3000);
    msg('young', 'u-INBOX', 10);

    const r1 = await runRetentionPolicies();
    assert.equal(r1.itemsMarked, 1);
    assert.equal(folderOf('old'), 'u-INBOX');
    const expires = row('old')!['retentionExpiresAt'] as Date;
    assert.equal(expires.getTime(), (row('old')!['createdAt'] as Date).getTime() + 2555 * DAY);
    assert.equal(row('old')!['retentionTagId'], null, 'the DPT is not pinned on the item');
    assert.equal(row('young')!['retentionExpiresAt'], null);

    const seq = modSeqOf('mb-u');
    const r2 = await runRetentionPolicies();
    assert.equal(r2.itemsMarked, 0);
    assert.equal(modSeqOf('mb-u'), seq, 'no daily modSeq churn for marked items');
  });

  test('personal tags apply without a policy and beat the RPT; disabled personal tag = not processed', async () => {
    db.users.push({ id: 'dave', email: 'dave@example.com', domainId: 'd1', active: true });
    mailbox('mb-dave', { userId: 'dave' });
    const pers = tag('pers-30', 'PERSONAL', 'DELETE_AND_ALLOW_RECOVERY', 30);
    const persOff = tag('pers-off', 'PERSONAL', 'PERMANENTLY_DELETE', 1, null, false);
    extra.tags.push(pers, persOff);
    folder('dave-INBOX', 'mb-dave', 'INBOX', null, 'pers-30');
    folder('dave-Sub', 'mb-dave', 'Alt', 'dave-INBOX');
    folder('dave-Other', 'mb-dave', 'Sonstiges');
    msg('d-inbox', 'dave-INBOX', 40);
    msg('d-sub', 'dave-Sub', 40);
    msg('d-other', 'dave-Other', 4000); // no policy, no tag: untouched
    msg('d-item-off', 'dave-INBOX', 4000, { retentionTagId: 'pers-off' });

    const r = await runRetentionPolicies();
    const del = folderByName('mb-dave', 'Recoverable Items/Deletions')!['id'];
    assert.equal(folderOf('d-inbox'), del);
    assert.equal(folderOf('d-sub'), del, 'subfolder inherits the personal folder tag');
    assert.equal(folderOf('d-other'), 'dave-Other');
    assert.equal(folderOf('d-item-off'), 'dave-INBOX');
    assert.equal(r.mailboxesScanned, 1);
  });

  test('legacy policy keeps its scope; DOMAIN assignment reaches users and shared mailboxes of that domain only', async () => {
    orgFixture();
    extra.policies.length = 0;
    extra.policies.push(policy('legacy-junk', [], [{ target: 'DOMAIN', targetId: 'other.org' }], { retentionDays: 14, action: 'DELETE', scope: 'JUNK' }));
    msg('c-junk', 'carol-Junk', 20); // domain assignment: inactive users too (as before)
    msg('c-inbox', 'carol-INBOX', 4000);
    msg('a-junk', 'alice-Junk', 20);

    await runRetentionPolicies();
    assert.equal(row('c-junk'), undefined);
    assert.equal(folderOf('c-inbox'), 'carol-INBOX', 'a "Junk" legacy policy never acts on the whole mailbox');
    assert.equal(folderOf('a-junk'), 'alice-Junk', 'other domain untouched');
  });

  test('one failing mailbox does not stop the others; a lost lock stops the run', async () => {
    orgFixture();
    msg('a-junk', 'alice-Junk', 20);
    msg('t-junk', 'team-Junk', 20);
    const folderModel = fake['folder'] as { findMany: (a?: { where?: Row }) => Promise<unknown> };
    const orig = folderModel.findMany;
    folderModel.findMany = async (args) => {
      if (args?.where?.['mailboxId'] === 'mb-alice') throw new Error('boom');
      return orig(args);
    };
    try {
      const r = await runRetentionPolicies();
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0]!, /mb-alice: boom/);
      assert.ok(row('a-junk'));
      assert.equal(row('t-junk'), undefined);
    } finally {
      folderModel.findMany = orig;
    }

    msg('a-junk-2', 'alice-Junk', 20);
    const ac = new AbortController();
    ac.abort();
    const stopped = await runRetentionPolicies(ac.signal);
    assert.ok(row('a-junk-2'));
    assert.ok(stopped.errors.some((e) => /lock lost/.test(e)));
  });

  test('RETENTION_DRY_RUN counts but writes nothing', async () => {
    orgFixture();
    msg('a-junk', 'alice-Junk', 20);
    msg('a-inbox', 'alice-INBOX', 400);
    process.env['RETENTION_DRY_RUN'] = 'true';
    try {
      const before = modSeqOf('mb-alice');
      const r = await runRetentionPolicies();
      assert.equal(r.itemsHardDeleted, 1);
      assert.equal(r.itemsArchived, 1);
      assert.ok(row('a-junk'));
      assert.equal(folderOf('a-inbox'), 'alice-INBOX');
      assert.equal(modSeqOf('mb-alice'), before);
    } finally {
      delete process.env['RETENTION_DRY_RUN'];
    }
  });
});
