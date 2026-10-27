/**
 * Mailbox/* (RFC 8621 §2). Ein JMAP-Mailbox-Objekt ist ein CoreMail-Folder.
 * totalThreads/unreadThreads werden mit totalEmails/unreadEmails angenähert
 * (CoreMail hält keine Thread-Zähler).
 */
import { prisma } from '@coremail/storage';
import { registerMethod } from '../dispatcher.js';
import { CAP_MAIL } from '../capabilities.js';
import { cannotCalculateChanges, setError, unsupportedFilter, unsupportedSort } from '../errors.js';
import { decodeMailboxState, encodeMailboxState, mailboxState, mailboxStateParts } from '../state.js';
import { roleForFolder, SYSTEM_FOLDER_NAMES } from '../mail/keywords.js';
import { notifyMailboxChange } from '../mail/write.js';
import { applyPatch, assertState, paginate, parseGetArgs, parseSetArgs, pick } from './common.js';
import type { AccountContext, JsonObject } from '../types.js';

type FolderRow = {
  id: string; name: string; displayName: string; parentId: string | null; sortOrder: number;
  totalCount: number; unreadCount: number; subscribed: boolean;
};

const FOLDER_SELECT = {
  id: true, name: true, displayName: true, parentId: true, sortOrder: true,
  totalCount: true, unreadCount: true, subscribed: true,
} as const;

function toMailbox(f: FolderRow, account: AccountContext): JsonObject {
  const role = roleForFolder(f.name, f.parentId);
  const w = !account.readOnly;
  return {
    id: f.id,
    name: f.displayName || f.name,
    parentId: f.parentId,
    role,
    sortOrder: f.sortOrder,
    totalEmails: Math.max(0, f.totalCount),
    unreadEmails: Math.max(0, f.unreadCount),
    totalThreads: Math.max(0, f.totalCount),
    unreadThreads: Math.max(0, f.unreadCount),
    myRights: {
      mayReadItems: true,
      mayAddItems: w,
      mayRemoveItems: w,
      maySetSeen: w,
      maySetKeywords: w,
      mayCreateChild: w,
      mayRename: w && !role,
      mayDelete: w && !role && !SYSTEM_FOLDER_NAMES.has(f.name),
      maySubmit: account.maySend,
    },
    isSubscribed: f.subscribed,
  };
}

registerMethod('Mailbox/get', CAP_MAIL, async (args, ctx) => {
  const { account, ids, properties } = parseGetArgs(args, ctx);
  const folders = await prisma.folder.findMany({
    where: { mailboxId: account.mailboxId, ...(ids ? { id: { in: ids } } : {}) },
    select: FOLDER_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
  });
  const found = new Set(folders.map((f) => f.id));
  return {
    accountId: account.accountId,
    state: await mailboxState(account.mailboxId),
    list: folders.map((f) => pick(toMailbox(f, account), properties)),
    notFound: ids ? ids.filter((i) => !found.has(i)) : [],
  };
});

registerMethod('Mailbox/changes', CAP_MAIL, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const old = decodeMailboxState(args['sinceState']);
  if (!old) throw cannotCalculateChanges();
  const parts = await mailboxStateParts(account.mailboxId);
  const newState = encodeMailboxState(parts);
  const oldState = encodeMailboxState(old);
  if (oldState === newState) {
    return { accountId: account.accountId, oldState, newState, hasMoreChanges: false, created: [], updated: [], destroyed: [] };
  }
  const folders = await prisma.folder.findMany({
    where: { mailboxId: account.mailboxId }, select: { id: true, createdAt: true },
  });
  const created = folders.filter((f) => f.createdAt.getTime() > old.maxCreatedMs).map((f) => f.id);
  // Gelöschte Ordner kennen wir nicht mehr → Client muss komplett neu laden
  if (old.count + created.length !== folders.length) throw cannotCalculateChanges();
  const createdSet = new Set(created);
  return {
    accountId: account.accountId,
    oldState,
    newState,
    hasMoreChanges: false,
    created,
    updated: folders.filter((f) => !createdSet.has(f.id)).map((f) => f.id),
    updatedProperties: null,
    destroyed: [],
  };
});

registerMethod('Mailbox/query', CAP_MAIL, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  let folders = await prisma.folder.findMany({ where: { mailboxId: account.mailboxId }, select: FOLDER_SELECT });

  const filter = args['filter'];
  if (filter && typeof filter === 'object') {
    const f = filter as JsonObject;
    if ('operator' in f) throw unsupportedFilter('FilterOperator not supported for Mailbox/query');
    if (f['parentId'] !== undefined) folders = folders.filter((x) => x.parentId === f['parentId']);
    if (typeof f['name'] === 'string') folders = folders.filter((x) => (x.displayName || x.name).toLowerCase().includes((f['name'] as string).toLowerCase()));
    if (f['role'] !== undefined) folders = folders.filter((x) => roleForFolder(x.name, x.parentId) === f['role']);
    if (typeof f['hasAnyRole'] === 'boolean') folders = folders.filter((x) => (roleForFolder(x.name, x.parentId) !== null) === f['hasAnyRole']);
    if (typeof f['isSubscribed'] === 'boolean') folders = folders.filter((x) => x.subscribed === f['isSubscribed']);
  }

  const sort = Array.isArray(args['sort']) ? (args['sort'] as Array<{ property?: string; isAscending?: boolean }>) : [];
  for (const s of sort) {
    if (s.property !== 'name' && s.property !== 'sortOrder') throw unsupportedSort(`Cannot sort by ${s.property}`);
  }
  const cmp = (a: FolderRow, b: FolderRow): number => {
    for (const s of sort) {
      const dir = s.isAscending === false ? -1 : 1;
      const r = s.property === 'name'
        ? (a.displayName || a.name).localeCompare(b.displayName || b.name)
        : a.sortOrder - b.sortOrder;
      if (r !== 0) return r * dir;
    }
    return a.sortOrder - b.sortOrder || (a.displayName || a.name).localeCompare(b.displayName || b.name);
  };

  let ordered: FolderRow[];
  if (args['sortAsTree'] === true) {
    const byParent = new Map<string | null, FolderRow[]>();
    for (const f of folders) {
      const list = byParent.get(f.parentId) ?? [];
      list.push(f);
      byParent.set(f.parentId, list);
    }
    const present = new Set(folders.map((f) => f.id));
    ordered = [];
    const walk = (parent: string | null): void => {
      for (const f of (byParent.get(parent) ?? []).sort(cmp)) { ordered.push(f); walk(f.id); }
    };
    walk(null);
    // Ordner, deren Eltern ausgefiltert wurden, hinten anhängen
    for (const f of folders) if (!ordered.includes(f) && f.parentId && !present.has(f.parentId)) ordered.push(f);
  } else {
    ordered = [...folders].sort(cmp);
  }

  const page = paginate(ordered.map((f) => f.id), args);
  return {
    accountId: account.accountId,
    queryState: await mailboxState(account.mailboxId),
    canCalculateChanges: false,
    position: page.position,
    ids: page.ids,
    ...(args['calculateTotal'] === true ? { total: page.total } : {}),
    ...(page.limit !== null ? { limit: page.limit } : {}),
  };
});

registerMethod('Mailbox/queryChanges', CAP_MAIL, async () => { throw cannotCalculateChanges(); });

registerMethod('Mailbox/set', CAP_MAIL, async (args, ctx) => {
  const { account, ifInState, create, update, destroy } = parseSetArgs(args, ctx);
  const oldState = await mailboxState(account.mailboxId);
  assertState(ifInState, oldState);

  const created: JsonObject = {}; const notCreated: JsonObject = {};
  const updated: JsonObject = {}; const notUpdated: JsonObject = {};
  const destroyed: string[] = []; const notDestroyed: JsonObject = {};

  const existing = async (): Promise<FolderRow[]> => prisma.folder.findMany({ where: { mailboxId: account.mailboxId }, select: FOLDER_SELECT });

  for (const [cid, obj] of Object.entries(create)) {
    const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
    if (!name || name.length > 100 || /[/\\]/.test(name)) { notCreated[cid] = setError('invalidProperties', 'name invalid', ['name']); continue; }
    if (obj['role'] !== undefined && obj['role'] !== null) { notCreated[cid] = setError('invalidProperties', 'role cannot be set', ['role']); continue; }
    let parentId: string | null = null;
    if (typeof obj['parentId'] === 'string') {
      try { parentId = ctx.resolveId(obj['parentId']); } catch { notCreated[cid] = setError('invalidProperties', 'parentId unknown', ['parentId']); continue; }
      const parent = await prisma.folder.findFirst({ where: { id: parentId, mailboxId: account.mailboxId }, select: { id: true } });
      if (!parent) { notCreated[cid] = setError('invalidProperties', 'parentId not found', ['parentId']); continue; }
    }
    if (!parentId && SYSTEM_FOLDER_NAMES.has(name)) { notCreated[cid] = setError('invalidProperties', 'reserved name', ['name']); continue; }
    const dup = await prisma.folder.findFirst({ where: { mailboxId: account.mailboxId, name }, select: { id: true } });
    if (dup) { notCreated[cid] = setError('invalidProperties', 'a mailbox with this name exists', ['name']); continue; }
    const f = await prisma.folder.create({
      data: {
        mailboxId: account.mailboxId, name, displayName: name,
        ...(parentId ? { parentId } : {}),
        ...(typeof obj['sortOrder'] === 'number' ? { sortOrder: Math.trunc(obj['sortOrder']) } : {}),
        ...(typeof obj['isSubscribed'] === 'boolean' ? { subscribed: obj['isSubscribed'] } : {}),
      },
      select: FOLDER_SELECT,
    });
    ctx.createdIds.set(cid, f.id);
    const full = toMailbox(f, account);
    created[cid] = { id: f.id, role: full['role'], totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, myRights: full['myRights'], sortOrder: f.sortOrder, isSubscribed: f.subscribed };
  }

  for (const [id, patch] of Object.entries(update)) {
    const f = (await existing()).find((x) => x.id === id);
    if (!f) { notUpdated[id] = setError('notFound'); continue; }
    let next: JsonObject;
    try { next = applyPatch(toMailbox(f, account), patch); } catch (e) { notUpdated[id] = setError('invalidPatch', e instanceof Error ? e.message : undefined); continue; }
    const bad: string[] = [];
    for (const k of Object.keys(patch)) {
      const top = k.split('/')[0]!;
      if (!['name', 'parentId', 'sortOrder', 'isSubscribed'].includes(top)) bad.push(top);
    }
    const role = roleForFolder(f.name, f.parentId);
    if (role && (patch['name'] !== undefined || patch['parentId'] !== undefined)) bad.push('name');
    if (bad.length) { notUpdated[id] = setError('invalidProperties', 'immutable or unknown property', [...new Set(bad)]); continue; }
    const name = String(next['name'] ?? '').trim();
    if (!name || name.length > 100 || /[/\\]/.test(name)) { notUpdated[id] = setError('invalidProperties', 'name invalid', ['name']); continue; }
    let parentId: string | null = null;
    if (typeof next['parentId'] === 'string') {
      parentId = ctx.resolveId(next['parentId']);
      if (parentId === id) { notUpdated[id] = setError('invalidProperties', 'mailbox cannot be its own parent', ['parentId']); continue; }
      const parent = await prisma.folder.findFirst({ where: { id: parentId, mailboxId: account.mailboxId }, select: { id: true } });
      if (!parent) { notUpdated[id] = setError('invalidProperties', 'parentId not found', ['parentId']); continue; }
    }
    if (name !== (f.displayName || f.name)) {
      const dup = await prisma.folder.findFirst({ where: { mailboxId: account.mailboxId, name, id: { not: id } }, select: { id: true } });
      if (dup) { notUpdated[id] = setError('invalidProperties', 'a mailbox with this name exists', ['name']); continue; }
    }
    await prisma.folder.update({
      where: { id },
      data: {
        ...(role ? {} : { name, displayName: name, parentId }),
        sortOrder: typeof next['sortOrder'] === 'number' ? Math.trunc(next['sortOrder']) : f.sortOrder,
        subscribed: typeof next['isSubscribed'] === 'boolean' ? next['isSubscribed'] : f.subscribed,
      },
    });
    updated[id] = null;
  }

  const removeEmails = args['onDestroyRemoveEmails'] === true;
  for (const id of destroy) {
    const f = await prisma.folder.findFirst({
      where: { id, mailboxId: account.mailboxId },
      select: { id: true, name: true, parentId: true, _count: { select: { children: true, messages: true } } },
    });
    if (!f) { notDestroyed[id] = setError('notFound'); continue; }
    if (roleForFolder(f.name, f.parentId) || (!f.parentId && SYSTEM_FOLDER_NAMES.has(f.name))) { notDestroyed[id] = setError('forbidden', 'system mailbox'); continue; }
    if (f._count.children > 0) { notDestroyed[id] = setError('mailboxHasChild'); continue; }
    if (f._count.messages > 0 && !removeEmails) { notDestroyed[id] = setError('mailboxHasEmail'); continue; }
    await prisma.folder.delete({ where: { id } });
    destroyed.push(id);
  }

  if (Object.keys(created).length || Object.keys(updated).length || destroyed.length) await notifyMailboxChange(account);

  return {
    accountId: account.accountId,
    oldState,
    newState: await mailboxState(account.mailboxId),
    created: Object.keys(created).length ? created : null,
    updated: Object.keys(updated).length ? updated : null,
    destroyed: destroyed.length ? destroyed : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
});

// Hilfsfunktion für andere Module
export async function folderInAccount(account: AccountContext, folderId: string): Promise<{ id: string; name: string } | null> {
  return prisma.folder.findFirst({ where: { id: folderId, mailboxId: account.mailboxId }, select: { id: true, name: true } });
}
export async function roleFolder(account: AccountContext, name: string): Promise<{ id: string } | null> {
  return prisma.folder.findFirst({ where: { mailboxId: account.mailboxId, name, parentId: null }, select: { id: true } });
}
