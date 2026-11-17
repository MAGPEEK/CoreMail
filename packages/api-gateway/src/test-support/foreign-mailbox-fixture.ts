/**
 * Shared fixture of the foreign-mailbox route tests (foreign-mailbox.test.ts,
 * shared-mailbox-compat.test.ts): an in-memory Prisma fake (globalThis.__prisma)
 * with shared / delegated mailboxes, and a loopback Express app with the same
 * mount order as server.ts. Importing it registers before/after/beforeEach hooks.
 */
import { before, after, beforeEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from './fake-prisma.js';

setTestEnv();

export type Row = Record<string, unknown>;

// alice: FULL_ACCESS + SEND_AS on sm1, READ_ONLY on sm2; bob: SEND_AS on sm1 only;
// carol: FULL_ACCESS on sm3 (inactive).
const perms = [
  { userId: 'alice', sharedMailboxId: 'sm1', permission: 'FULL_ACCESS' },
  { userId: 'alice', sharedMailboxId: 'sm1', permission: 'SEND_AS' },
  { userId: 'alice', sharedMailboxId: 'sm2', permission: 'READ_ONLY' },
  { userId: 'bob',   sharedMailboxId: 'sm1', permission: 'SEND_AS' },
  { userId: 'carol', sharedMailboxId: 'sm3', permission: 'FULL_ACCESS' },
];
const shared: Record<string, Row> = {
  sm1: { id: 'sm1', email: 'team@ex.com', displayName: 'Team', active: true, mailboxId: 'mb-sm1' },
  sm2: { id: 'sm2', email: 'sales@ex.com', displayName: 'Sales', active: true, mailboxId: 'mb-sm2' },
  sm3: { id: 'sm3', email: 'old@ex.com', displayName: 'Old', active: false, mailboxId: 'mb-sm3' },
};
// dave: FULL_ACCESS on erin's mailbox and on gina's (gina deactivated); frank: READ_ONLY on erin's.
const owners: Record<string, Row> = {
  'mb-erin': { id: 'erin', email: 'erin@ex.com', displayName: 'Erin', active: true },
  'mb-gina': { id: 'gina', email: 'gina@ex.com', displayName: 'Gina', active: false },
};
const delegates = [
  { granteeId: 'dave',  mailboxId: 'mb-erin', permission: 'FULL_ACCESS' },
  { granteeId: 'frank', mailboxId: 'mb-erin', permission: 'READ_ONLY' },
  { granteeId: 'dave',  mailboxId: 'mb-gina', permission: 'FULL_ACCESS' },
];

export let folders: Row[] = [];
export let messages: Row[] = [];
export const settings = new Map<string, Row>();
export const writes: string[] = [];
/** Ids passed to folder.delete, in call order. */
export const deletedFolderIds: string[] = [];
export const summarySelects: Row[] = [];
export const auditRows: Row[] = [];
/** Arguments of every prisma.message.findFirst call (include / where checks). */
export const messageFindFirstArgs: Row[] = [];
/** Owner of a user mailbox (own-mailbox routes match folder.mailbox.userId). */
const mailboxOwner: Record<string, string> = { 'mb-alice': 'alice', 'mb-erin': 'erin', 'mb-gina': 'gina' };

export function seed(): void {
  const f = (id: string, mailboxId: string, name: string, parentId: string | null = null): Row =>
    ({ id, mailboxId, name, displayName: name, parentId, totalCount: 0, unreadCount: 1, isFavorite: false, sortOrder: 0, color: null });
  folders = [
    f('f-sm1-inbox', 'mb-sm1', 'INBOX'), f('f-sm1-trash', 'mb-sm1', 'Trash'), f('f-sm1-archive', 'mb-sm1', 'Archive'),
    f('f-sm1-proj', 'mb-sm1', 'Projekte'),
    f('f-sm2-inbox', 'mb-sm2', 'INBOX'), f('f-sm2-proj', 'mb-sm2', 'Projekte'),
    f('f-erin-inbox', 'mb-erin', 'INBOX'), f('f-erin-trash', 'mb-erin', 'Trash'),
    f('f-gina-inbox', 'mb-gina', 'INBOX'),
    f('f-alice-inbox', 'mb-alice', 'INBOX'),
  ];
  const m = (id: string, folderId: string): Row => ({
    id, folderId, uid: 1, subject: `S ${id}`, fromAddr: 'x@ex.com', fromName: 'X', toAddrs: [], date: new Date(0),
    flags: [], rawSize: 10, pinnedAt: null, snoozeUntil: null, spamScore: null, scheduledAt: null, scheduledStatus: null,
    deletedAt: null, attachments: [], bodyText: 'hi', bodyHtml: '',
  });
  messages = [m('m-sm1', 'f-sm1-inbox'), m('m-sm2', 'f-sm2-inbox'), m('m-erin', 'f-erin-inbox'), m('m-alice', 'f-alice-inbox')];
  settings.clear();
  writes.length = 0;
  deletedFolderIds.length = 0;
  summarySelects.length = 0;
  auditRows.length = 0;
  messageFindFirstArgs.length = 0;
}

/** Test helpers: add a folder / message row to the fake DB. */
export function addFolder(id: string, mailboxId: string, name: string, parentId: string | null = null): Row {
  const row: Row = { id, mailboxId, name, displayName: name, parentId, totalCount: 0, unreadCount: 0, isFavorite: false, sortOrder: 0, color: null };
  folders.push(row);
  return row;
}
export function addMessage(id: string, folderId: string, extra: Row = {}): Row {
  const row: Row = {
    id, folderId, uid: 1, subject: `S ${id}`, fromAddr: 'x@ex.com', fromName: 'X', toAddrs: [], date: new Date(0),
    flags: [], rawSize: 10, pinnedAt: null, snoozeUntil: null, spamScore: null, scheduledAt: null, scheduledStatus: null,
    deletedAt: null, attachments: [], bodyText: 'hi', bodyHtml: '', ...extra,
  };
  messages.push(row);
  return row;
}
export const msg = (id: string): Row => messages.find((m) => m['id'] === id)!;
export const folderById = (id: string): Row | undefined => folders.find((f) => f['id'] === id);

export function matches(row: Row, where: Row | undefined): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'NOT') { if (matches(row, v as Row)) return false; continue; }
    if (k === 'OR') { if (!(v as Row[]).some((w) => matches(row, w))) return false; continue; }
    if (k === 'AND') { if (!(v as Row[]).every((w) => matches(row, w))) return false; continue; }
    if (k === 'mailbox') {
      if (mailboxOwner[String(row['mailboxId'])] !== (v as Row)['userId']) return false;
      continue;
    }
    if (k === 'folder') {
      const fo = folders.find((x) => x['id'] === row['folderId']);
      if (!fo || !matches(fo, v as Row)) return false;
      continue;
    }
    const have = row[k];
    if (v === null) { if (have !== null && have !== undefined) return false; continue; }
    if (typeof v === 'object' && !(v instanceof Date)) {
      const o = v as Row;
      if ('in' in o && !(o['in'] as unknown[]).includes(have)) return false;
      if ('not' in o && have === o['not']) return false;
      if ('lte' in o && !(have !== null && (have as Date) <= (o['lte'] as Date))) return false;
      continue;
    }
    if (have !== v) return false;
  }
  return true;
}

function apply(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const o = v as { increment?: number; decrement?: number };
      if (typeof o.increment === 'number') row[k] = Number(row[k] ?? 0) + o.increment;
      if (typeof o.decrement === 'number') row[k] = Number(row[k] ?? 0) - o.decrement;
      continue;
    }
    row[k] = v;
  }
}

const matchPerm = (want: unknown, have: string): boolean =>
  want === undefined ? true : typeof want === 'string' ? want === have : ((want as { in: string[] }).in ?? []).includes(have);

installFakePrisma({
  sharedMailboxPerm: {
    findMany: (a) => {
      const w = (a as { where: Row }).where;
      if (w['sharedMailboxId']) {
        const ids = (w['sharedMailboxId'] as { in: string[] }).in;
        return perms.filter((p) => p.userId === w['userId'] && ids.includes(p.sharedMailboxId))
          .map((p) => ({ sharedMailboxId: p.sharedMailboxId, permission: p.permission }));
      }
      return perms
        .filter((p) => p.userId === w['userId'] && matchPerm(w['permission'], p.permission))
        .map((p) => {
          const s = shared[p.sharedMailboxId]!;
          return { permission: p.permission, sharedMailbox: { id: s['id'], email: s['email'], displayName: s['displayName'], active: s['active'], mailbox: { id: s['mailboxId'] } } };
        });
    },
  },
  mailboxDelegate: {
    findMany: (a) => {
      const w = (a as { where: Row }).where;
      return delegates
        .filter((d) => d.granteeId === w['granteeId'] && matchPerm(w['permission'], d.permission))
        .map((d) => ({ permission: d.permission, mailbox: { id: d.mailboxId, user: owners[d.mailboxId] ?? null } }));
    },
  },
  auditLog: {
    create: (a) => { auditRows.push((a as { data: Row }).data); return {}; },
  },
  folder: {
    findMany: (a) => folders.filter((f) => matches(f, (a as { where: Row }).where)).map((f) => ({ ...f })),
    findFirst: (a) => {
      const q = a as { where: Row; include?: Row };
      const f = folders.find((x) => matches(x, q.where));
      if (!f) return null;
      // include: { _count: { select: { children: true } } } (pre-9.3 compat DELETE)
      return q.include?.['_count'] ? { ...f, _count: { children: folders.filter((x) => x['parentId'] === f['id']).length } } : f;
    },
    findUnique: (a) => folders.find((f) => f['id'] === (a as { where: Row }).where['id']) ?? null,
    count: (a) => folders.filter((f) => matches(f, (a as { where: Row }).where)).length,
    create: (a) => {
      writes.push('folder.create');
      const row = { id: `f-new-${folders.length}`, parentId: null, totalCount: 0, unreadCount: 0, isFavorite: false, sortOrder: 0, color: null, ...(a as { data: Row }).data };
      folders.push(row);
      return row;
    },
    update: (a) => {
      const q = a as { where: Row; data: Row };
      writes.push('folder.update');
      const row = folders.find((f) => f['id'] === q.where['id'])!;
      apply(row, q.data);
      return row;
    },
    updateMany: (a) => {
      const q = a as { where: Row; data: Row };
      writes.push('folder.updateMany');
      const rows = folders.filter((f) => matches(f, q.where));
      for (const row of rows) apply(row, q.data);
      return { count: rows.length };
    },
    delete: (a) => {
      writes.push('folder.delete');
      deletedFolderIds.push(String((a as { where: Row }).where['id']));
      folders = folders.filter((f) => f['id'] !== (a as { where: Row }).where['id']);
      return {};
    },
  },
  message: {
    findMany: (a) => {
      const q = a as { where: Row; select?: Row };
      if (q.select && 'subject' in q.select) summarySelects.push(q.select);
      return messages.filter((m) => matches(m, q.where)).map((m) => ({ ...m }));
    },
    findFirst: (a) => {
      messageFindFirstArgs.push(a as Row);
      const m = messages.find((x) => matches(x, (a as { where: Row }).where));
      return m ? { ...m } : null;
    },
    count: (a) => messages.filter((m) => matches(m, (a as { where: Row }).where)).length,
    aggregate: () => ({ _max: { modSeq: 0n, uid: 0 } }),
    update: (a) => {
      const q = a as { where: Row; data: Row };
      writes.push('message.update');
      const row = messages.find((m) => m['id'] === q.where['id'])!;
      apply(row, q.data);
      return row;
    },
    updateMany: (a) => {
      const q = a as { where: Row; data: Row };
      writes.push('message.updateMany');
      const rows = messages.filter((m) => matches(m, q.where));
      for (const r of rows) apply(r, q.data);
      return { count: rows.length };
    },
  },
  mailbox: {
    update: () => { writes.push('mailbox.update'); return { uidNext: 100, highestModSeq: 7n }; },
  },
  userSettings: {
    findUnique: (a) => settings.get(String((a as { where: Row }).where['userId'])) ?? null,
    upsert: (a) => {
      const q = a as { where: Row; create: Row; update: Row };
      const id = String(q.where['userId']);
      const row = { ...(settings.get(id) ?? q.create), ...q.update };
      settings.set(id, row);
      return row;
    },
  },
});

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { sharedMailboxContentRouter, delegatedMailboxContentRouter } = await import('../routes/foreign-mailbox.js');
const { sharedRecoverableRouter, delegatedRecoverableRouter } = await import('../routes/recoverable.js');
const { userRouter } = await import('../routes/user.js');
const { mailRouter } = await import('../routes/mail.js');

export const tok = (sub: string) => core.signAccessToken({ sub, email: `${sub}@ex.com`, role: 'USER', domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: true });

let server: Server;
let base = '';
before(async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  app.use(express.json());
  // same mount order as server.ts
  app.use('/api/v1/user/shared-mailboxes/:id/recoverable', sharedRecoverableRouter);
  app.use('/api/v1/mail/delegated-mailboxes/:id/recoverable', delegatedRecoverableRouter);
  app.use('/api/v1/mail/shared-mailboxes/:id', sharedMailboxContentRouter);
  app.use('/api/v1/mail/delegated-mailboxes/:id', delegatedMailboxContentRouter);
  app.use('/api/v1/mail', mailRouter);
  app.use('/api/v1/user', userRouter);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server?.close());
beforeEach(seed);
/** audit() is fire-and-forget */
export const flush = (): Promise<unknown> => new Promise((r) => setTimeout(r, 20));

export async function call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: Row & Row[] }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;
  const r = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json = {} as Row & Row[];
  try { json = JSON.parse(text) as Row & Row[]; } catch { /* not JSON */ }
  return { status: r.status, json };
}

/** 9.3 webmail paths. */
export const S = (id: string) => `/api/v1/mail/shared-mailboxes/${id}`;
/** Pre-9.3 shared-mailbox content routes (compat, routes/user.ts). */
export const OLD = (id: string) => `/api/v1/user/shared-mailboxes/${id}`;
export const D = (id: string) => `/api/v1/mail/delegated-mailboxes/${id}`;
