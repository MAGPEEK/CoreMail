/**
 * Folder permissions (w3) — the central access check for foreign folders.
 *
 * Every reader and writer of a mailbox that is not the caller's own asks here:
 *
 *   listVisibleForeignMailboxes(db, userId)   mailbox-level grants
 *       (listAccessibleMailboxes) + mailboxes reached only through folder
 *       grants (`folderScoped`), for folder panes and the IMAP namespaces
 *   loadMailboxFolderAccess(db, userId, entry) the user's rights on every folder
 *       of one such mailbox (combined as described in folder-permissions.ts)
 *   folderAccessForUser(db, userId, folderId)  one folder (attachment download,
 *       reply/forward of a foreign message)
 *   listableFolders(...)                       which folders a folder list shows
 *
 * Changing permissions: setFolderPermissions() (REST, IMAP SETACL/DELETEACL,
 * admin) validates, writes, audits every change and returns the changes for
 * publishFolderPermissionChange() (permission-events.ts). Callers add their own
 * rules through `authorize` (admin scope, a grantee's subtree — w3 review).
 *
 * The database client is passed in (structural types): the IMAP test harness
 * runs this module unchanged against an in-memory fake.
 */
import { listAccessibleMailboxes, type AccessibleMailbox, type MailboxAccessDb } from './mailbox-access.js';
import {
  ALL_FOLDER_RIGHTS, DEFAULT_GRANTEE_KEY, NO_FOLDER_ACCESS, READ_ONLY_FLOOR, FolderRight,
  applicableGrant, canAdministerFolder, canReadFolder, canSeeFolder, computeFolderRights, descendantFolderIds, hasAnyWriteRight,
  folderParents, folderPath, granteeUserId,
  indexGrants, normalizeRights, roleOfRights, userGranteeKey,
  type FolderAccess, type FolderAccessLevel, type FolderGrantRow, type FolderTreeNode, type FolderRole,
} from './folder-permissions.js';

// ─── Database surface ────────────────────────────────────────────────────────

type FindMany = { findMany(args: never): Promise<unknown[]> };

export interface FolderAccessDb extends MailboxAccessDb {
  folderPermission: FindMany;
  folder: FindMany & { findUnique(args: never): Promise<unknown> };
  mailbox: FindMany & { findUnique(args: never): Promise<unknown> };
  user: FindMany;
  sharedMailbox: FindMany;
}

export interface FolderPermissionWriteDb extends FolderAccessDb {
  folderPermission: FindMany & {
    upsert(args: never): Promise<unknown>;
    deleteMany(args: never): Promise<unknown>;
  };
  auditLog: { create(args: never): Promise<unknown> };
  $transaction?: <T>(fn: (tx: never) => Promise<T>) => Promise<T>;
}

interface GrantRow extends FolderGrantRow { mailboxId: string }
interface FolderRow extends FolderTreeNode { mailboxId: string }
interface MailboxRow { id: string; userId: string | null; sharedBoxId: string | null }
interface PrincipalRow { id: string; email: string; displayName: string | null; active: boolean }

const GRANT_SELECT = { folderId: true, mailboxId: true, granteeKey: true, rights: true, applyToSubfolders: true } as const;
const FOLDER_SELECT = { id: true, mailboxId: true, name: true, parentId: true } as const;

/** Grants of the user and of Default (the only rows that matter for one user). */
function grantsWhere(userId: string, extra: Record<string, unknown> = {}) {
  return { ...extra, OR: [{ granteeId: userId }, { granteeKey: DEFAULT_GRANTEE_KEY }] };
}

function relevant(rows: GrantRow[], userId: string): GrantRow[] {
  const own = userGranteeKey(userId);
  return rows.filter((r) => r.granteeKey === own || r.granteeKey === DEFAULT_GRANTEE_KEY);
}

const byMailbox = <T extends { mailboxId: string }>(rows: T[], mailboxId: string): T[] => rows.filter((r) => r.mailboxId === mailboxId);

// ─── Listing foreign mailboxes ───────────────────────────────────────────────

/**
 * Mailboxes the user reaches only through folder grants: at least one folder
 * visible to the user, owner active (user mailbox) / box active (Shared
 * Mailbox), never the user's own mailbox. Auto-mapped when a grant names the
 * user (Default-only mailboxes are added by the user).
 */
export async function listFolderGrantMailboxes(db: FolderAccessDb, userId: string): Promise<AccessibleMailbox[]> {
  const grants = relevant(await db.folderPermission.findMany({ where: grantsWhere(userId), select: GRANT_SELECT } as never) as GrantRow[], userId);
  const candidates = [...new Set(grants.filter((g) => normalizeRights(g.rights) !== 0).map((g) => g.mailboxId))];
  if (candidates.length === 0) return [];
  const mailboxes = (await db.mailbox.findMany({
    where: { id: { in: candidates } }, select: { id: true, userId: true, sharedBoxId: true },
  } as never) as MailboxRow[]).filter((m) => m.userId !== userId);
  if (mailboxes.length === 0) return [];
  const ownerIds = mailboxes.flatMap((m) => (m.userId ? [m.userId] : []));
  const boxIds = mailboxes.flatMap((m) => (m.sharedBoxId ? [m.sharedBoxId] : []));
  const principal = { id: true, email: true, displayName: true, active: true } as const;
  const [owners, boxes, folders] = await Promise.all([
    ownerIds.length ? db.user.findMany({ where: { id: { in: ownerIds } }, select: principal } as never) as Promise<PrincipalRow[]> : [],
    boxIds.length ? db.sharedMailbox.findMany({ where: { id: { in: boxIds } }, select: principal } as never) as Promise<PrincipalRow[]> : [],
    db.folder.findMany({ where: { mailboxId: { in: mailboxes.map((m) => m.id) } }, select: FOLDER_SELECT } as never) as Promise<FolderRow[]>,
  ]);
  const out: AccessibleMailbox[] = [];
  for (const m of mailboxes) {
    const who = m.userId ? owners.find((o) => o.id === m.userId) : boxes.find((b) => b.id === m.sharedBoxId);
    if (!who || !who.active) continue;
    const mine = byMailbox(grants, m.id);
    const rights = computeFolderRights(byMailbox(folders, m.id), mine, userId, 0);
    if (![...rights.values()].some((r) => (r & FolderRight.FolderVisible) !== 0)) continue;
    out.push({
      kind: m.sharedBoxId ? 'shared' : 'delegated',
      mailboxId: m.id,
      email: who.email.toLowerCase(),
      displayName: who.displayName || who.email,
      readOnly: true,
      sharedMailboxId: m.sharedBoxId,
      ownerUserId: m.userId,
      autoMap: mine.some((g) => g.granteeKey !== DEFAULT_GRANTEE_KEY && normalizeRights(g.rights) !== 0),
      folderScoped: true,
    });
  }
  return out;
}

/** Pure: mailbox-level entries first; folder-only entries for the other mailboxes, same order as listAccessibleMailboxes. */
export function mergeForeignMailboxes(mailboxLevel: AccessibleMailbox[], folderLevel: AccessibleMailbox[]): AccessibleMailbox[] {
  const known = new Set(mailboxLevel.map((a) => a.mailboxId));
  return [...mailboxLevel, ...folderLevel.filter((a) => !known.has(a.mailboxId))]
    .sort((a, b) => (a.kind === b.kind ? a.email.localeCompare(b.email) : a.kind.localeCompare(b.kind)));
}

/** Every foreign mailbox with at least one folder the user may see (folder panes, IMAP namespaces). */
export async function listVisibleForeignMailboxes(db: FolderAccessDb, userId: string): Promise<AccessibleMailbox[]> {
  const [mailboxLevel, folderLevel] = await Promise.all([listAccessibleMailboxes(db, userId), listFolderGrantMailboxes(db, userId)]);
  return mergeForeignMailboxes(mailboxLevel, folderLevel);
}

// ─── Per-folder rights in one mailbox ────────────────────────────────────────

/** The user's access to the folders of one mailbox. */
export interface MailboxFolderAccess {
  mailboxId: string;
  level: FolderAccessLevel;
  /** Rights per folder id (level 'grants'); null = every folder, all rights. */
  rights: Map<string, number> | null;
}

/** Pure: how a listed foreign mailbox is reached. */
export function accessLevelOf(entry: Pick<AccessibleMailbox, 'readOnly'>): FolderAccessLevel {
  return entry.readOnly ? 'grants' : 'full';
}

/**
 * The user's rights on every folder of a mailbox: `entry` is the user's own
 * mailbox ('owner') or a foreign mailbox from listVisibleForeignMailboxes.
 */
export async function loadMailboxFolderAccess(
  db: FolderAccessDb,
  userId: string,
  entry: 'owner' | { mailboxId: string } & Pick<AccessibleMailbox, 'readOnly' | 'folderScoped'>,
  ownMailboxId?: string,
): Promise<MailboxFolderAccess> {
  if (entry === 'owner') return { mailboxId: ownMailboxId ?? '', level: 'owner', rights: null };
  const level = accessLevelOf(entry);
  if (level !== 'grants') return { mailboxId: entry.mailboxId, level, rights: null };
  const [folders, grants] = await Promise.all([
    db.folder.findMany({ where: { mailboxId: entry.mailboxId }, select: FOLDER_SELECT } as never) as Promise<FolderRow[]>,
    db.folderPermission.findMany({ where: grantsWhere(userId, { mailboxId: entry.mailboxId }), select: GRANT_SELECT } as never) as Promise<GrantRow[]>,
  ]);
  const floor = entry.folderScoped ? 0 : READ_ONLY_FLOOR;
  return {
    mailboxId: entry.mailboxId,
    level,
    rights: computeFolderRights(folders, byMailbox(relevant(grants, userId), entry.mailboxId), userId, floor),
  };
}

/** Pure: the access to one folder (a folder the map does not know grants nothing). */
export function accessToFolder(m: MailboxFolderAccess, folderId: string): FolderAccess {
  if (m.rights === null) return { level: m.level, rights: ALL_FOLDER_RIGHTS };
  const rights = m.rights.get(folderId);
  return rights === undefined ? NO_FOLDER_ACCESS : { level: m.level, rights };
}

/** Pure: does the user hold any write right in the mailbox (else it is read-only for them)? */
export function hasWriteRightSomewhere(m: MailboxFolderAccess): boolean {
  if (m.rights === null) return true;
  return [...m.rights.values()].some((rights) => hasAnyWriteRight({ level: m.level, rights }));
}

/** Pure: ids of the folders whose messages the user may read. */
export function readableFolderIds(m: MailboxFolderAccess, folderIds: readonly string[]): string[] {
  return folderIds.filter((id) => canReadFolder(accessToFolder(m, id)));
}

/** One entry of a folder list for a foreign mailbox. */
export interface ListableFolder {
  id: string;
  /** Only shown as the path to a visible folder, or visible without read right. */
  noSelect: boolean;
}

/**
 * Pure: the folders a folder list shows — every visible folder, plus the
 * ancestors of visible folders as non-selectable path entries (no rights, no
 * counts). A visible folder without read right is non-selectable too.
 */
export function listableFolders(folders: readonly FolderTreeNode[], m: MailboxFolderAccess): ListableFolder[] {
  if (m.rights === null) return folders.map((f) => ({ id: f.id, noSelect: false }));
  const parents = folderParents(folders);
  const out = new Map<string, ListableFolder>();
  for (const f of folders) {
    const access = accessToFolder(m, f.id);
    if (!canSeeFolder(access)) continue;
    out.set(f.id, { id: f.id, noSelect: !canReadFolder(access) });
    for (const ancestor of folderPath(f.id, parents).slice(1)) {
      if (!out.has(ancestor)) out.set(ancestor, { id: ancestor, noSelect: true });
    }
  }
  // (A visible ancestor keeps its own entry: it is set unconditionally in its own turn.)
  return folders.filter((f) => out.has(f.id)).map((f) => out.get(f.id)!);
}

/**
 * The user's access to one folder, wherever it lives (own mailbox, mailbox
 * grant, folder grant); null when the folder does not exist or the user has
 * no way into its mailbox.
 */
export async function folderAccessForUser(
  db: FolderAccessDb,
  userId: string,
  folderId: string,
): Promise<{ mailboxId: string; access: FolderAccess } | null> {
  const folder = await db.folder.findUnique({ where: { id: folderId }, select: { id: true, mailboxId: true } } as never) as { mailboxId: string } | null;
  if (!folder) return null;
  const mailbox = await db.mailbox.findUnique({ where: { id: folder.mailboxId }, select: { id: true, userId: true } } as never) as { userId: string | null } | null;
  if (!mailbox) return null;
  if (mailbox.userId === userId) return { mailboxId: folder.mailboxId, access: { level: 'owner', rights: ALL_FOLDER_RIGHTS } };
  const entry = (await listVisibleForeignMailboxes(db, userId)).find((a) => a.mailboxId === folder.mailboxId);
  if (!entry) return null;
  const m = await loadMailboxFolderAccess(db, userId, entry);
  return { mailboxId: folder.mailboxId, access: accessToFolder(m, folderId) };
}

// ─── Reading and changing permissions ────────────────────────────────────────

export interface FolderPermissionView {
  granteeKey: string;
  /** null for Default. */
  user: { id: string; email: string; displayName: string } | null;
  rights: number;
  role: FolderRole | 'custom';
  applyToSubfolders: boolean;
}

export interface InheritedPermissionView extends FolderPermissionView {
  fromFolderId: string;
}

export interface FolderPermissionsView {
  folderId: string;
  mailboxId: string;
  entries: FolderPermissionView[];
  /** Grants that reach the folder from an ancestor (grantees without an entry of their own). */
  inherited: InheritedPermissionView[];
}

async function principals(db: FolderAccessDb, keys: Iterable<string>): Promise<Map<string, { id: string; email: string; displayName: string }>> {
  const ids = [...new Set([...keys].map(granteeUserId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await db.user.findMany({
    where: { id: { in: ids } }, select: { id: true, email: true, displayName: true, active: true },
  } as never) as PrincipalRow[];
  return new Map(rows.map((r) => [r.id, { id: r.id, email: r.email, displayName: r.displayName || r.email }]));
}

/** Pure: Default first, then users by address. */
function byGrantee(a: FolderPermissionView, b: FolderPermissionView): number {
  if (a.user === null) return -1;
  if (b.user === null) return 1;
  return a.user.email.localeCompare(b.user.email);
}

/** The permission entries of a folder (and the inherited ones) with the grantees' names. */
export async function describeFolderPermissions(db: FolderAccessDb, folder: { id: string; mailboxId: string }): Promise<FolderPermissionsView> {
  const [folders, rows] = await Promise.all([
    db.folder.findMany({ where: { mailboxId: folder.mailboxId }, select: FOLDER_SELECT } as never) as Promise<FolderRow[]>,
    db.folderPermission.findMany({ where: { mailboxId: folder.mailboxId }, select: GRANT_SELECT } as never) as Promise<GrantRow[]>,
  ]);
  const parents = folderParents(folders);
  const index = indexGrants(rows);
  const own = [...(index.get(folder.id)?.values() ?? [])];
  const ownKeys = new Set(own.map((r) => r.granteeKey));
  const inheritedKeys = new Set(rows.map((r) => r.granteeKey).filter((k) => !ownKeys.has(k)));
  const inherited = [...inheritedKeys].flatMap((key) => {
    const g = applicableGrant(folder.id, key, parents, index);
    return g ? [{ key, g }] : [];
  });
  const users = await principals(db, [...ownKeys, ...inherited.map((i) => i.key)]);
  const view = (key: string, rights: number, applyToSubfolders: boolean): FolderPermissionView | null => {
    const userId = granteeUserId(key);
    const user = userId === null ? null : users.get(userId);
    if (user === undefined) return null; // grantee no longer exists
    const r = normalizeRights(rights);
    return { granteeKey: key, user, rights: r, role: roleOfRights(r), applyToSubfolders };
  };
  return {
    folderId: folder.id,
    mailboxId: folder.mailboxId,
    entries: own.flatMap((r) => view(r.granteeKey, r.rights, r.applyToSubfolders) ?? []).sort(byGrantee),
    inherited: inherited
      .flatMap(({ key, g }) => { const v = view(key, g.rights, true); return v ? [{ ...v, fromFolderId: g.fromFolderId }] : []; })
      .sort(byGrantee),
  };
}

/** Every folder of a mailbox with its own permission entries (admin overview). */
export async function listMailboxFolderPermissions(
  db: FolderAccessDb,
  mailboxId: string,
): Promise<Array<{ id: string; name: string; parentId: string | null; entries: FolderPermissionView[] }>> {
  const [folders, rows] = await Promise.all([
    db.folder.findMany({ where: { mailboxId }, select: FOLDER_SELECT } as never) as Promise<FolderRow[]>,
    db.folderPermission.findMany({ where: { mailboxId }, select: GRANT_SELECT } as never) as Promise<GrantRow[]>,
  ]);
  const users = await principals(db, rows.map((r) => r.granteeKey));
  return folders
    .map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId ?? null,
      entries: rows.filter((r) => r.folderId === f.id).flatMap((r) => {
        const userId = granteeUserId(r.granteeKey);
        const user = userId === null ? null : users.get(userId);
        if (user === undefined) return [];
        const rights = normalizeRights(r.rights);
        return [{ granteeKey: r.granteeKey, user, rights, role: roleOfRights(rights), applyToSubfolders: r.applyToSubfolders }];
      }).sort(byGrantee),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A change request for one grantee: set (rights + subfolders) or remove the entry. */
export type FolderPermissionInput =
  | { granteeKey: string; rights: number; applyToSubfolders: boolean }
  | { granteeKey: string; remove: true };

export interface FolderPermissionChange {
  granteeKey: string;
  before: { rights: number; applyToSubfolders: boolean } | null;
  after: { rights: number; applyToSubfolders: boolean } | null;
}

export interface PermissionActor {
  userId: string;
  email?: string;
  source: 'webmail' | 'imap' | 'admin';
  ipAddress?: string;
  userAgent?: string;
}

export type FolderPermissionErrorCode =
  | 'UNKNOWN_GRANTEE' | 'OWNER_GRANTEE' | 'INVALID_RIGHTS' | 'TOO_MANY_ENTRIES'
  /** An administrator other than ORGANIZATION_MANAGEMENT gives rights to itself or to Default. */
  | 'FORBIDDEN_GRANTEE'
  /** A grantee changes an entry that reaches subfolders it does not administer. */
  | 'SUBFOLDERS_NOT_ADMINISTERED';

/** Decides whether the planned changes may be applied (null = yes); runs before any write. */
export type FolderPermissionAuthorizer = (
  changes: readonly FolderPermissionChange[],
) => FolderPermissionErrorCode | null | Promise<FolderPermissionErrorCode | null>;

export class FolderPermissionError extends Error {
  constructor(readonly code: FolderPermissionErrorCode, message: string) {
    super(message);
    this.name = 'FolderPermissionError';
  }
}

/** Upper bound of entries per folder (one request). */
export const MAX_FOLDER_PERMISSION_ENTRIES = 200;

export const FOLDER_PERMISSION_AUDIT_ACTION = {
  set: 'mailbox.folder.permission.set',
  remove: 'mailbox.folder.permission.remove',
} as const;

/**
 * Pure: the changes that turn the current entries into the requested ones.
 * `replace` = the request is the complete list (absent grantees are removed).
 * Default with no rights is no entry; a user entry with no rights stays (an
 * explicit "None" that overrides Default).
 */
export function planFolderPermissionChanges(
  current: readonly FolderGrantRow[],
  inputs: readonly FolderPermissionInput[],
  replace: boolean,
): FolderPermissionChange[] {
  const now = new Map(current.map((r) => [r.granteeKey, { rights: normalizeRights(r.rights), applyToSubfolders: r.applyToSubfolders }]));
  const want = new Map<string, { rights: number; applyToSubfolders: boolean } | null>();
  if (replace) for (const key of now.keys()) want.set(key, null);
  for (const input of inputs) {
    if ('remove' in input) { want.set(input.granteeKey, null); continue; }
    const rights = normalizeRights(input.rights);
    const empty = input.granteeKey === DEFAULT_GRANTEE_KEY && rights === 0;
    want.set(input.granteeKey, empty ? null : { rights, applyToSubfolders: input.applyToSubfolders });
  }
  const changes: FolderPermissionChange[] = [];
  for (const [key, after] of want) {
    const before = now.get(key) ?? null;
    const same = before === null ? after === null
      : after !== null && before.rights === after.rights && before.applyToSubfolders === after.applyToSubfolders;
    if (!same) changes.push({ granteeKey: key, before, after });
  }
  return changes;
}

/** Pure: does the change give the grantee a right its entry did not hold before? */
export function addsRights(change: FolderPermissionChange): boolean {
  return change.after !== null && (change.after.rights & ~(change.before?.rights ?? 0)) !== 0;
}

/**
 * Pure: does the change reach the folder's subfolders — the entry applies to
 * them before or after? (Lowering or removing such an entry can raise a
 * grantee's rights below as well: an inherited user "None" that kept Default
 * out disappears.)
 */
export function affectsSubfolders(change: FolderPermissionChange): boolean {
  return change.before?.applyToSubfolders === true || change.after?.applyToSubfolders === true;
}

/**
 * The authorizer of a grantee who administers `rootId` through folder
 * permissions (w3 review): an entry that reaches subfolders may only change
 * when the user also administers every folder below — the folder owner right
 * on one folder never extends to the folders below it. Owners pass always.
 */
export function subfolderAuthorizer(
  folders: readonly FolderTreeNode[],
  rootId: string,
  m: MailboxFolderAccess,
): FolderPermissionAuthorizer {
  return (changes) => {
    if (!changes.some(affectsSubfolders)) return null;
    const below = descendantFolderIds(folders, rootId);
    return below.every((id) => canAdministerFolder(accessToFolder(m, id))) ? null : 'SUBFOLDERS_NOT_ADMINISTERED';
  };
}

function validInput(input: FolderPermissionInput): boolean {
  if (input.granteeKey !== DEFAULT_GRANTEE_KEY && granteeUserId(input.granteeKey) === null) return false;
  if ('remove' in input) return true;
  return Number.isInteger(input.rights) && input.rights >= 0 && (input.rights & ~ALL_FOLDER_RIGHTS) === 0;
}

/**
 * Validates and applies permission changes to one folder; every change is
 * written to the audit log (`mailbox.folder.permission.set|remove`). Grantees
 * must be existing users other than the mailbox owner. Returns the applied
 * changes (empty = nothing changed) — publish them with
 * publishFolderPermissionChange().
 */
export async function setFolderPermissions(
  db: FolderPermissionWriteDb,
  args: {
    folder: { id: string; mailboxId: string; name: string };
    mailboxOwnerId: string | null;
    inputs: readonly FolderPermissionInput[];
    replace: boolean;
    actor: PermissionActor;
    /** Further rules of the caller (admin scope, a grantee's subtree), checked on the planned changes. */
    authorize?: FolderPermissionAuthorizer;
  },
): Promise<FolderPermissionChange[]> {
  const { folder, inputs, actor } = args;
  if (inputs.length > MAX_FOLDER_PERMISSION_ENTRIES) throw new FolderPermissionError('TOO_MANY_ENTRIES', 'Too many permission entries');
  if (!inputs.every(validInput)) throw new FolderPermissionError('INVALID_RIGHTS', 'Invalid permission entry');
  const userIds = [...new Set(inputs.filter((i) => !('remove' in i)).map((i) => granteeUserId(i.granteeKey)).filter((id): id is string => id !== null))];
  if (args.mailboxOwnerId && userIds.includes(args.mailboxOwnerId)) {
    throw new FolderPermissionError('OWNER_GRANTEE', 'The mailbox owner always has every right');
  }
  if (userIds.length > 0) {
    const found = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true } } as never) as Array<{ id: string }>;
    if (found.length !== userIds.length) throw new FolderPermissionError('UNKNOWN_GRANTEE', 'Unknown user');
  }
  const apply = async (tx: FolderPermissionWriteDb): Promise<FolderPermissionChange[]> => {
    const current = await tx.folderPermission.findMany({ where: { folderId: folder.id }, select: GRANT_SELECT } as never) as GrantRow[];
    const changes = planFolderPermissionChanges(current, inputs, args.replace);
    const refusal = changes.length > 0 && args.authorize ? await args.authorize(changes) : null;
    if (refusal) throw new FolderPermissionError(refusal, 'Permission change not allowed');
    for (const change of changes) {
      if (change.after === null) {
        await tx.folderPermission.deleteMany({ where: { folderId: folder.id, granteeKey: change.granteeKey } } as never);
      } else {
        const data = { rights: change.after.rights, applyToSubfolders: change.after.applyToSubfolders, grantedBy: actor.userId };
        await tx.folderPermission.upsert({
          where: { folderId_granteeKey: { folderId: folder.id, granteeKey: change.granteeKey } },
          create: { folderId: folder.id, mailboxId: folder.mailboxId, granteeKey: change.granteeKey, granteeId: granteeUserId(change.granteeKey), ...data },
          update: data,
        } as never);
      }
      await tx.auditLog.create({ data: permissionAuditRow(folder, change, actor) } as never);
    }
    return changes;
  };
  // One transaction: the read of the current entries, the writes and the audit rows.
  return db.$transaction ? db.$transaction((tx) => apply(tx as FolderPermissionWriteDb)) : apply(db);
}

/** Pure: the audit row of one permission change. */
export function permissionAuditRow(folder: { id: string; mailboxId: string; name: string }, change: FolderPermissionChange, actor: PermissionActor) {
  const describe = (v: FolderPermissionChange['before']) => (v ? { rights: v.rights, role: roleOfRights(v.rights), applyToSubfolders: v.applyToSubfolders } : null);
  return {
    actorId: actor.userId,
    ...(actor.email ? { actorEmail: actor.email } : {}),
    action: change.after === null ? FOLDER_PERMISSION_AUDIT_ACTION.remove : FOLDER_PERMISSION_AUDIT_ACTION.set,
    targetType: 'folder',
    targetId: folder.id,
    targetName: folder.name,
    ...(actor.ipAddress ? { ipAddress: actor.ipAddress } : {}),
    ...(actor.userAgent ? { userAgent: actor.userAgent } : {}),
    changes: {
      mailboxId: folder.mailboxId, folderId: folder.id, grantee: change.granteeKey, source: actor.source,
      before: describe(change.before), after: describe(change.after),
    },
    success: true,
  };
}
