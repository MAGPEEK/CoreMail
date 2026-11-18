/**
 * The Prisma binding of the MailStore against the storage in-memory Prisma
 * fake (globalThis.__prisma seam) and the object-store seam: logon
 * resolution (own / shared / no access), message-store writes (read flag,
 * tombstones, move), drafts and sending (sender identity, quota, queue job,
 * Sent copy, draft removal), realtime announcements (message store,
 * folder list) and the mailbox access audit of foreign logons.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { emptyDb, createFake } = await import('../../../storage/src/test-support/mailbox-fake.js');
const db = emptyDb();
const fake = createFake(db) as Record<string, unknown>;
const perms: Array<Record<string, unknown>> = [];
const logs: unknown[] = [];
fake['sharedMailboxPerm'] = { findMany: async () => perms };
fake['mailboxDelegate'] = { findMany: async () => [] };
fake['systemLog'] = { create: async (a: unknown) => { logs.push(a); return a; } };
(globalThis as unknown as { __prisma: unknown }).__prisma = fake;
const objects = new Map<string, Buffer>();
(globalThis as unknown as { __objectStore: unknown }).__objectStore = {
  driver: 'memory', location: 'memory',
  put: async (k: string, b: Buffer) => { objects.set(k, Buffer.from(b)); },
  get: async (k: string) => { const b = objects.get(k); if (!b) throw new Error(`missing ${k}`); return b; },
  exists: async (k: string) => objects.has(k),
  delete: async (k: string) => { objects.delete(k); },
};

const { createPrismaStore } = await import('./prisma-store.js');
const { resetMessageStoreCache, legacyDnFor, setMailboxChangePublisher } = await import('@coremail/storage');
const { MailboxFullError } = await import('./types.js');
type Job = { messageId: string; from: string; to: string[]; senderUserId: string; rawMessage: string; foreignSendSource?: string; foreignSendAuditOnly?: true };

const USER = { userId: 'u1', email: 'alice@example.test', displayName: 'Alice', domainId: 'd1' };
const OWN = { mailboxId: 'mb1', kind: 'own' as const, email: 'alice@example.test', displayName: 'Alice', readOnly: false, directoryId: 'u1' };
const jobs: Job[] = [];
/** mailbox:changes events (message store + folder announcements). */
const events: Array<Record<string, unknown>> = [];
setMailboxChangePublisher(async (e) => { events.push(e as unknown as Record<string, unknown>); });
const audits: Array<Record<string, unknown>> = [];
const settle = () => new Promise((r) => setTimeout(r, 150));
let writeBlocked = false;
let sendAllowed = true;
let limits = { maxMessageBytes: 1024 * 1024, maxRecipients: 10 };

const store = createPrismaStore({
  enqueue: async (j) => { jobs.push(j); },
  now: () => new Date('2026-11-17T09:00:00Z'),
  sendAllowed: async () => sendAllowed,
  allowedSenders: async () => ['alice@example.test', 'team@example.test'],
  writeBlocked: async () => writeBlocked,
  limits: async () => limits,
  audit: async (e) => { audits.push(e as unknown as Record<string, unknown>); },
});

beforeEach(() => {
  Object.assign(db, emptyDb());
  perms.length = 0; jobs.length = 0; logs.length = 0; events.length = 0; audits.length = 0; objects.clear();
  writeBlocked = false; sendAllowed = true;
  limits = { maxMessageBytes: 1024 * 1024, maxRecipients: 10 };
  resetMessageStoreCache();
  db.users.push({ id: 'u1', email: 'alice@example.test', active: true }, { id: 'u2', email: 'bob@example.test', active: true });
  db.sharedMailboxes.push({ id: 'sm1', email: 'team@example.test', displayName: 'Team', active: true });
  db.mailboxes.push({ id: 'mb1', userId: 'u1', sharedBoxId: null, uidNext: 10, highestModSeq: 5n });
  db.mailboxes.push({ id: 'mb2', userId: null, sharedBoxId: 'sm1', uidNext: 1, highestModSeq: 0n });
  for (const [id, name] of [['inbox', 'INBOX'], ['drafts', 'Drafts'], ['sent', 'Sent'], ['trash', 'Trash'], ['archive', 'Archive']]) {
    db.folders.push({ id, mailboxId: 'mb1', name, displayName: name, parentId: null, totalCount: 0, unreadCount: 0, createdAt: new Date(0), sortOrder: 0 });
  }
});

function addMessage(id: string, folderId: string, uid: number, flags: string[] = []): void {
  db.messages.push({
    id, folderId, uid, modSeq: 3n, flags, subject: `S ${id}`, fromAddr: 'x@example.test', fromName: 'X', toAddrs: ['alice@example.test'],
    ccAddrs: [], bccAddrs: [], messageId: `<${id}@x>`, inReplyTo: null, date: new Date(0), createdAt: new Date(0), rawSize: 100,
    bodyText: 'b', bodyHtml: '', storagePath: null, deletedAt: null, softDeletedAt: null,
  });
  const f = db.folders.find((x) => x['id'] === folderId)!;
  f['totalCount'] = Number(f['totalCount']) + 1;
  if (!flags.includes('\\Seen')) f['unreadCount'] = Number(f['unreadCount']) + 1;
}

const composed = (over: Record<string, unknown> = {}) => ({
  subject: 'Report', bodyText: 'Text', bodyHtml: '', from: null, to: ['bob@example.test'], cc: [], bcc: ['hidden@example.test'],
  inReplyTo: null, attachments: [], ...over,
});

test('resolveLogon: own mailbox (empty Essdn or own DN), shared mailbox with access, none without', async () => {
  assert.deepEqual(await store.resolveLogon(USER, ''), OWN);
  assert.deepEqual(await store.resolveLogon(USER, legacyDnFor('u1')), OWN);
  assert.equal(await store.resolveLogon(USER, legacyDnFor('sm1')), null);
  perms.push({ permission: 'READ_ONLY', sharedMailbox: { id: 'sm1', email: 'team@example.test', displayName: 'Team', active: true, mailbox: { id: 'mb2' } } });
  assert.deepEqual(await store.resolveLogon(USER, legacyDnFor('sm1')), {
    mailboxId: 'mb2', kind: 'shared', email: 'team@example.test', displayName: 'Team', readOnly: true, directoryId: 'sm1',
    actor: { userId: 'u1', email: 'alice@example.test' },
  });
  await settle();
  assert.deepEqual(audits.map((a) => [a['action'], a['source'], (a['target'] as Record<string, unknown>)['sharedMailboxId']]),
    [['mailbox.foreign.open', 'mapi', 'sm1']], 'a foreign logon is audited, the own mailbox never');
  assert.equal(await store.resolveLogon(USER, '/o=Other/cn=u1'), null);
});

test('resolveLegacyDn: users and shared mailboxes by their DN', async () => {
  assert.equal(await store.resolveLegacyDn(legacyDnFor('u2')), 'bob@example.test');
  assert.equal(await store.resolveLegacyDn(legacyDnFor('sm1')), 'team@example.test');
  assert.equal(await store.resolveLegacyDn(legacyDnFor('nobody')), null);
});

test('listMessages: live rows only, with the attachment marker; findMessage by folder + uid', async () => {
  addMessage('m1', 'inbox', 1);
  addMessage('m2', 'inbox', 2);
  db.messages[1]!['deletedAt'] = new Date();
  db.attachments.push({ id: 'a1', messageId: 'm1', storagePath: 'k' });
  const list = await store.listMessages('inbox');
  assert.deepEqual(list.map((m) => [m.id, m.hasAttachments]), [['m1', true]]);
  assert.equal((await store.findMessage('inbox', 1))?.id, 'm1');
  assert.equal(await store.findMessage('inbox', 2), null);
  assert.equal(await store.findMessage('archive', 1), null);
});

test('setRead: \\Seen through the message store (new modSeq) and the unread counter', async () => {
  addMessage('m1', 'inbox', 1);
  const m = (await store.findMessage('inbox', 1))!;
  await store.setRead(OWN, m, true);
  assert.deepEqual(db.messages[0]!['flags'], ['\\Seen']);
  assert.equal(db.messages[0]!['modSeq'], 6n);
  assert.equal(db.folders[0]!['unreadCount'], 0);
  await settle();
  assert.deepEqual(events.map((e) => [e['mailboxId'], e['kinds']]), [['mb1', ['flags']]], 'the message store announces the flag change');
  await store.setRead(OWN, { ...m, flags: ['\\Seen'] }, true);
  assert.equal(db.messages[0]!['modSeq'], 6n, 'an unchanged message keeps its modSeq');
  assert.equal(db.folders[0]!['unreadCount'], 0, 'no counter change without a flag change');
  await settle();
  assert.equal(events.length, 1, 'no event without a change');
});

test('deleteMessages tombstones (recoverable) and fixes the counters; moveOrCopy moves with new UIDs', async () => {
  addMessage('m1', 'inbox', 1);
  addMessage('m2', 'inbox', 2, ['\\Seen']);
  assert.equal(await store.deleteMessages(OWN, 'inbox', [1, 99]), 1);
  assert.ok(db.messages[0]!['deletedAt'] instanceof Date);
  assert.deepEqual([db.folders[0]!['totalCount'], db.folders[0]!['unreadCount']], [1, 0]);
  assert.equal(await store.moveOrCopy({ mailbox: OWN, folderId: 'inbox' }, { mailbox: OWN, folderId: 'archive' }, [2], false), 1);
  assert.equal(db.messages[1]!['folderId'], 'archive');
  assert.equal(db.messages[1]!['uid'], 10);
  assert.deepEqual([db.folders[0]!['totalCount'], db.folders.find((f) => f['id'] === 'archive')!['totalCount']], [0, 1]);
  await settle();
  assert.equal(audits.length, 0, 'nothing is audited in the own mailbox');
});

test('foreign mailbox (delegated): deletes and moves are audited with counts, copies are not', async () => {
  addMessage('m1', 'inbox', 1);
  addMessage('m2', 'inbox', 2);
  addMessage('m3', 'inbox', 3);
  const delegated = { ...OWN, kind: 'delegated' as const, directoryId: 'u9', actor: { userId: 'u2', email: 'bob@example.test' } };
  assert.equal(await store.deleteMessages(delegated, 'inbox', [1]), 1);
  assert.equal(await store.moveOrCopy({ mailbox: delegated, folderId: 'inbox' }, { mailbox: delegated, folderId: 'archive' }, [2], false), 1);
  assert.equal(await store.moveOrCopy({ mailbox: delegated, folderId: 'inbox' }, { mailbox: delegated, folderId: 'archive' }, [3], true), 1);
  await settle();
  assert.deepEqual(audits.map((a) => [a['action'], a['actorId'], (a['target'] as Record<string, unknown>)['kind'], (a['changes'] as Record<string, unknown>)['count']]), [
    ['mailbox.foreign.message.delete', 'u2', 'delegated', 1],
    ['mailbox.foreign.message.move', 'u2', 'delegated', 1],
  ]);
});

test('createFolder: subfolders get "Parent.Name", default names and duplicates are refused', async () => {
  const inbox = (await store.listFolders('mb1')).find((f) => f.name === 'INBOX')!;
  const sub = await store.createFolder(OWN, inbox, 'Projects');
  assert.equal(typeof sub === 'object' && sub.name, 'INBOX.Projects');
  assert.equal(await store.createFolder(OWN, inbox, 'Projects'), 'exists');
  assert.equal(await store.createFolder(OWN, null, 'sent'), 'exists');
  assert.equal(typeof (await store.createFolder(OWN, null, 'Clients')), 'object');
  await settle();
  assert.ok(events.some((e) => e['mailboxId'] === 'mb1' && (e['kinds'] as string[]).includes('folders')), 'the folder list change is announced');
});

test('saveDraft: raw MIME stored, \\Draft row via the message store, the previous version tombstoned', async () => {
  const first = await store.saveDraft(OWN, 'drafts', composed(), null);
  assert.deepEqual(first.flags, ['\\Draft', '\\Seen']);
  assert.equal(first.subject, 'Report');
  const row = db.messages.find((m) => m['id'] === first.id)!;
  const raw = objects.get(String(row['storagePath']))!.toString();
  assert.match(raw, /^From: "Alice" <alice@example\.test>/m);
  assert.doesNotMatch(raw, /hidden@example\.test/, 'Bcc is not part of the header');
  assert.deepEqual(row['bccAddrs'], ['hidden@example.test']);
  const second = await store.saveDraft(OWN, 'drafts', composed({ subject: 'Report v2' }), first);
  assert.ok(db.messages.find((m) => m['id'] === first.id)!['deletedAt'] instanceof Date);
  assert.equal(second.subject, 'Report v2');
  assert.equal(db.folders.find((f) => f['id'] === 'drafts')!['totalCount'], 1);
  await settle();
  assert.ok(events.every((e) => e['mailboxId'] === 'mb1'), 'draft writes are announced through the message store');
  assert.ok(events.length >= 1);
  writeBlocked = true;
  await assert.rejects(store.saveDraft(OWN, 'drafts', composed(), null), MailboxFullError);
});

test('submit: refused without recipients, over the send quota, for a foreign From, for read-only mailboxes', async () => {
  assert.deepEqual(await store.submit(USER, OWN, composed({ to: [], bcc: [] }), { saveCopy: true, draft: null }), { ok: false, reason: 'no-recipients' });
  sendAllowed = false;
  assert.deepEqual(await store.submit(USER, OWN, composed(), { saveCopy: true, draft: null }), { ok: false, reason: 'over-quota' });
  sendAllowed = true;
  assert.deepEqual(await store.submit(USER, OWN, composed({ from: 'ceo@example.test' }), { saveCopy: true, draft: null }), { ok: false, reason: 'sender-not-allowed' });
  assert.deepEqual(await store.submit(USER, { ...OWN, readOnly: true }, composed(), { saveCopy: true, draft: null }), { ok: false, reason: 'read-only' });
  assert.equal(jobs.length, 0);
});

test('submit: the submission limits of the user apply (recipient count after de-duplication, raw size)', async () => {
  limits = { maxMessageBytes: 4096, maxRecipients: 2 };
  const three = composed({ to: ['a@example.test', 'b@example.test'], cc: ['c@example.test'], bcc: [] });
  assert.deepEqual(await store.submit(USER, OWN, three, { saveCopy: true, draft: null }), { ok: false, reason: 'too-many-recipients' });
  const twoDup = composed({ to: ['a@example.test', 'A@Example.test'], cc: ['b@example.test'], bcc: [] });
  assert.equal((await store.submit(USER, OWN, twoDup, { saveCopy: false, draft: null })).ok, true, 'duplicates count once');
  const big = composed({ bcc: [], bodyText: 'x'.repeat(5000) });
  assert.deepEqual(await store.submit(USER, OWN, big, { saveCopy: true, draft: null }), { ok: false, reason: 'too-large' });
  assert.equal(jobs.length, 1);
  assert.deepEqual(await store.submissionLimits(USER), limits);
});

test('submit: queue job (envelope incl. Bcc, raw without Bcc), Sent copy, draft removed, MAIL_FLOW log', async () => {
  const draft = await store.saveDraft(OWN, 'drafts', composed(), null);
  const r = await store.submit(USER, OWN, composed({ cc: ['Carol@Example.test'] }), { saveCopy: true, draft });
  assert.equal(r.ok, true);
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.match(job.messageId, /^mapi-/);
  assert.equal(job.from, 'alice@example.test');
  assert.deepEqual(job.to.sort(), ['bob@example.test', 'carol@example.test', 'hidden@example.test']);
  assert.equal(job.senderUserId, 'u1');
  assert.equal(job.foreignSendSource, undefined, 'own address: no foreign send step');
  const raw = Buffer.from(job.rawMessage, 'base64').toString();
  assert.match(raw, /^Subject: Report/m);
  assert.doesNotMatch(raw, /hidden@example\.test/);
  const sentRows = db.messages.filter((m) => m['folderId'] === 'sent');
  assert.equal(sentRows.length, 1);
  assert.deepEqual(sentRows[0]!['flags'], ['\\Seen']);
  assert.ok(db.messages.find((m) => m['id'] === draft.id)!['deletedAt'] instanceof Date);
  assert.equal(logs.length, 1);
});

test('submit with DeleteAfterSubmit (saveCopy false) files no Sent copy; send as a shared mailbox', async () => {
  const shared = { mailboxId: 'mb1', kind: 'shared' as const, email: 'team@example.test', displayName: 'Team', readOnly: false, directoryId: 'sm1' };
  assert.equal((await store.submit(USER, shared, composed(), { saveCopy: false, draft: null })).ok, true);
  assert.equal(jobs[0]!.from, 'team@example.test');
  assert.match(Buffer.from(jobs[0]!.rawMessage, 'base64').toString(), /^From: "Team" <team@example\.test>/m);
  assert.equal(db.messages.filter((m) => m['folderId'] === 'sent').length, 0);
  // the worker audits the send as and files the Shared Mailbox Sent copy (none kept here)
  assert.equal(jobs[0]!.foreignSendSource, 'mapi');
  assert.equal(jobs[0]!.foreignSendAuditOnly, undefined);
  assert.equal((await store.submit(USER, shared, composed(), { saveCopy: true, draft: null })).ok, true);
  assert.equal(jobs[1]!.foreignSendAuditOnly, true, 'the logon box keeps the Sent copy itself: audit only');
  // send as the shared mailbox from the own logon: full foreign send step
  assert.equal((await store.submit(USER, OWN, composed({ from: 'team@example.test' }), { saveCopy: true, draft: null })).ok, true);
  assert.deepEqual([jobs[2]!.foreignSendSource, jobs[2]!.foreignSendAuditOnly], ['mapi', undefined]);
});

test('loadContent: bodies from the raw original, Bcc from the row, attachment records', async () => {
  const saved = await store.saveDraft(OWN, 'drafts', composed({
    bodyHtml: '<p>Hi</p>', attachments: [{ filename: 'a.txt', mimeType: 'text/plain', contentId: null, inline: false, content: Buffer.from('att') }],
  }), null);
  const content = await store.loadContent(saved);
  assert.equal(content.bodyText.trim(), 'Text');
  assert.equal(content.bodyHtml.trim(), '<p>Hi</p>');
  assert.deepEqual(content.bccAddrs, ['hidden@example.test']);
  assert.equal(content.attachments.length, 1);
  assert.equal(content.attachments[0]!.filename, 'a.txt');
  assert.equal((await store.loadAttachment(content.attachments[0]!.id)).toString(), 'att');
});
