/**
 * Folder permissions (w3) — the rights model, pure.
 *
 * A mailbox owner (or an administrator) grants another user, or "Default"
 * (every user of the organisation), a role on one folder — like the
 * "Permissions" tab of a folder's properties in Outlook. The rights are the
 * member-rights bitmask of the public MS-OXCPERM specification, so roles and
 * individual rights map one to one:
 *
 *   ReadAny 0x1, Create 0x2, EditOwned 0x8, DeleteOwned 0x10, EditAny 0x20,
 *   DeleteAny 0x40, CreateSubfolder 0x80, FolderOwner 0x100, FolderContact 0x200,
 *   FolderVisible 0x400
 *
 * "Own" items are the ones the grantee created in the foreign folder
 * (`Message.createdBy`). "Anonymous" is never granted anything on mail folders.
 *
 * Effective rights of a user on a folder of a foreign mailbox:
 *
 *   1. the user's own mailbox                     → everything ('owner')
 *   2. mailbox FULL_ACCESS (Shared Mailbox / delegation) → everything except
 *      administering the permissions ('full'); folder grants change nothing
 *   3. otherwise ('grants') the folder grant of the user — the folder's own
 *      entry, else the nearest ancestor entry marked "apply to subfolders" —
 *      or, when the user has none, the Default grant found the same way;
 *      plus the mailbox READ_ONLY floor (read + visible) when the user holds it.
 *
 * The user-specific entry wins over Default (most specific grantee wins), the
 * folder's own entry over an inherited one (most specific folder wins).
 * Mailbox-level grants are a floor that folder grants only add to — so every
 * path that knows only the mailbox-level grants (JMAP, MAPI, the pre-9.3 REST
 * routes) can never grant more than the folder rules allow.
 */

export const FolderRight = {
  ReadAny: 0x1,
  Create: 0x2,
  EditOwned: 0x8,
  DeleteOwned: 0x10,
  EditAny: 0x20,
  DeleteAny: 0x40,
  CreateSubfolder: 0x80,
  FolderOwner: 0x100,
  FolderContact: 0x200,
  FolderVisible: 0x400,
} as const;

/** Every right of a mail folder (the Owner role). */
export const ALL_FOLDER_RIGHTS = 0x7fb;

/** Rights the mailbox-level READ_ONLY grant always includes. */
export const READ_ONLY_FLOOR = FolderRight.ReadAny | FolderRight.FolderVisible;

export const FOLDER_ROLES = [
  'owner', 'publishingEditor', 'editor', 'publishingAuthor', 'author',
  'nonEditingAuthor', 'reviewer', 'contributor', 'none',
] as const;
export type FolderRole = (typeof FOLDER_ROLES)[number];

/** The rights of each role (MS-OXCPERM). "None" grants nothing (not even visibility). */
export const ROLE_RIGHTS: Readonly<Record<FolderRole, number>> = Object.freeze({
  owner: 0x7fb,
  publishingEditor: 0x4fb,
  editor: 0x47b,
  publishingAuthor: 0x49b,
  author: 0x41b,
  nonEditingAuthor: 0x413,
  reviewer: 0x401,
  contributor: 0x402,
  none: 0,
});

/**
 * Pure: the canonical form of a rights value — unknown bits dropped, and "all"
 * implies "own" (EditAny ⇒ EditOwned, DeleteAny ⇒ DeleteOwned).
 */
export function normalizeRights(rights: number): number {
  if (!Number.isInteger(rights) || rights < 0) return 0;
  let r = rights & ALL_FOLDER_RIGHTS;
  if (r & FolderRight.EditAny) r |= FolderRight.EditOwned;
  if (r & FolderRight.DeleteAny) r |= FolderRight.DeleteOwned;
  return r;
}

/** Pure: the role a rights value matches, or 'custom'. */
export function roleOfRights(rights: number): FolderRole | 'custom' {
  const r = normalizeRights(rights);
  return FOLDER_ROLES.find((role) => ROLE_RIGHTS[role] === r) ?? 'custom';
}

// ─── Grantees ────────────────────────────────────────────────────────────────

/** Grantee key of "Default" (every user of the organisation). */
export const DEFAULT_GRANTEE_KEY = 'default';

export function userGranteeKey(userId: string): string {
  return `user:${userId}`;
}

/** The user id of a grantee key, or null for Default. */
export function granteeUserId(key: string): string | null {
  return key.startsWith('user:') ? key.slice(5) : null;
}

// ─── Hierarchy ───────────────────────────────────────────────────────────────

export interface FolderTreeNode {
  id: string;
  name: string;
  parentId?: string | null;
}

/**
 * Pure: the parent of every folder — `parentId` (folders created in the
 * webmail), else the folder whose name is the "."-prefix of this one (folders
 * created over IMAP, "Projects.2026" → "Projects"). Root folders map to null.
 * A webmail folder without parent is NOT treated as a subfolder of INBOX for
 * the permissions (the webmail only shows it there).
 */
export function folderParents(folders: readonly FolderTreeNode[]): Map<string, string | null> {
  const ids = new Set(folders.map((f) => f.id));
  const byName = new Map(folders.map((f) => [f.name, f.id]));
  const out = new Map<string, string | null>();
  for (const f of folders) {
    if (f.parentId && ids.has(f.parentId) && f.parentId !== f.id) { out.set(f.id, f.parentId); continue; }
    const dot = f.name.lastIndexOf('.');
    const byPrefix = dot > 0 ? byName.get(f.name.slice(0, dot)) : undefined;
    out.set(f.id, byPrefix && byPrefix !== f.id ? byPrefix : null);
  }
  return out;
}

/** Pure: every folder below `rootId` (not the folder itself), by the same parents as folderParents(). */
export function descendantFolderIds(folders: readonly FolderTreeNode[], rootId: string): string[] {
  const parents = folderParents(folders);
  return folders.filter((f) => f.id !== rootId && folderPath(f.id, parents).includes(rootId)).map((f) => f.id);
}

/**
 * Pure: the folders (other than `exempt`) whose parent differs between two
 * versions of a mailbox's folder list. A folder's parent can come from another
 * folder's NAME (the "." prefix), so creating, renaming or deleting one folder
 * may move unrelated folders below another one — and with it into the reach of
 * its "apply to subfolders" grants. Grantees must never reshape the tree like
 * that (w3 review); only the folders they change themselves may move.
 */
export function reparentedFolders(
  before: readonly FolderTreeNode[],
  after: readonly FolderTreeNode[],
  exempt: ReadonlySet<string> = new Set(),
): string[] {
  const was = folderParents(before);
  const now = folderParents(after);
  return [...now.keys()].filter((id) => !exempt.has(id) && was.has(id) && was.get(id) !== now.get(id));
}

/** Pure: the folder and its ancestors, nearest first (cycle-safe). */
export function folderPath(folderId: string, parents: ReadonlyMap<string, string | null>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = folderId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = parents.get(cur);
  }
  return path;
}

// ─── Effective rights ────────────────────────────────────────────────────────

export interface FolderGrantRow {
  folderId: string;
  granteeKey: string;
  rights: number;
  applyToSubfolders: boolean;
}

/** A grant that applies to a folder: its own entry or one inherited from `fromFolderId`. */
export interface ApplicableGrant {
  rights: number;
  applyToSubfolders: boolean;
  fromFolderId: string;
  inherited: boolean;
}

/** Pure: index of grant rows by folder and grantee key. */
export function indexGrants(rows: readonly FolderGrantRow[]): Map<string, Map<string, FolderGrantRow>> {
  const out = new Map<string, Map<string, FolderGrantRow>>();
  for (const r of rows) {
    let byKey = out.get(r.folderId);
    if (!byKey) { byKey = new Map(); out.set(r.folderId, byKey); }
    byKey.set(r.granteeKey, r);
  }
  return out;
}

/**
 * Pure: the grant of `granteeKey` that applies to a folder — its own entry,
 * else the nearest ancestor entry with "apply to subfolders"; null when none.
 */
export function applicableGrant(
  folderId: string,
  granteeKey: string,
  parents: ReadonlyMap<string, string | null>,
  grants: ReadonlyMap<string, ReadonlyMap<string, FolderGrantRow>>,
): ApplicableGrant | null {
  const path = folderPath(folderId, parents);
  for (let i = 0; i < path.length; i++) {
    const row = grants.get(path[i]!)?.get(granteeKey);
    if (!row) continue;
    if (i === 0) return { rights: normalizeRights(row.rights), applyToSubfolders: row.applyToSubfolders, fromFolderId: row.folderId, inherited: false };
    if (row.applyToSubfolders) return { rights: normalizeRights(row.rights), applyToSubfolders: true, fromFolderId: row.folderId, inherited: true };
  }
  return null;
}

/** How the user reaches the mailbox. */
export type FolderAccessLevel = 'owner' | 'full' | 'grants';

/** The effective access of one user on one folder. */
export interface FolderAccess {
  level: FolderAccessLevel;
  rights: number;
}

export const NO_FOLDER_ACCESS: Readonly<FolderAccess> = Object.freeze({ level: 'grants', rights: 0 });

/**
 * Pure: the rights of `userId` on every folder of a mailbox reached through
 * grants (level 'grants'). `floor` = READ_ONLY_FLOOR for a mailbox READ_ONLY
 * grant, else 0.
 */
export function computeFolderRights(
  folders: readonly FolderTreeNode[],
  rows: readonly FolderGrantRow[],
  userId: string,
  floor: number,
): Map<string, number> {
  const parents = folderParents(folders);
  const grants = indexGrants(rows);
  const userKey = userGranteeKey(userId);
  const out = new Map<string, number>();
  for (const f of folders) {
    const grant = applicableGrant(f.id, userKey, parents, grants) ?? applicableGrant(f.id, DEFAULT_GRANTEE_KEY, parents, grants);
    out.set(f.id, normalizeRights(floor | (grant?.rights ?? 0)));
  }
  return out;
}

// ─── Operations ──────────────────────────────────────────────────────────────

const has = (a: FolderAccess, bit: number): boolean => a.level !== 'grants' || (a.rights & bit) !== 0;

/** The folder appears in folder lists. */
export const canSeeFolder = (a: FolderAccess): boolean => has(a, FolderRight.FolderVisible);
/** Message lists, message content, search. */
export const canReadFolder = (a: FolderAccess): boolean => has(a, FolderRight.ReadAny);
/** New items in the folder (IMAP APPEND / COPY or a move into it). */
export const canCreateItems = (a: FolderAccess): boolean => has(a, FolderRight.Create);
/** Change an item's flags (read state, flag, keywords). */
export const canEditItem = (a: FolderAccess, own: boolean): boolean =>
  has(a, FolderRight.EditAny) || (own && has(a, FolderRight.EditOwned));
/** Delete an item or move it out of the folder. */
export const canDeleteItem = (a: FolderAccess, own: boolean): boolean =>
  has(a, FolderRight.DeleteAny) || (own && has(a, FolderRight.DeleteOwned));
/** Create a subfolder below the folder. */
export const canCreateSubfolder = (a: FolderAccess): boolean => has(a, FolderRight.CreateSubfolder);
/** Rename, move or delete the folder, change its properties. */
export const canManageFolder = (a: FolderAccess): boolean => has(a, FolderRight.FolderOwner);
/**
 * Change the folder's permissions: the mailbox owner, or a grantee with the
 * "folder owner" right. Mailbox FULL_ACCESS alone does not administer
 * permissions (administrators do that in the BCP).
 */
export const canAdministerFolder = (a: FolderAccess): boolean =>
  a.level === 'owner' || (a.level === 'grants' && (a.rights & FolderRight.FolderOwner) !== 0);

/** Any write right at all (the folder is not read-only for the user). */
export const hasAnyWriteRight = (a: FolderAccess): boolean =>
  a.level !== 'grants' || (a.rights & (ALL_FOLDER_RIGHTS & ~(FolderRight.ReadAny | FolderRight.FolderVisible | FolderRight.FolderContact))) !== 0;

/** Pure: the rights as named booleans (REST `myRights`). */
export function folderRightsView(a: FolderAccess) {
  return {
    read: canReadFolder(a),
    createItems: canCreateItems(a),
    editOwn: canEditItem(a, true),
    editAll: canEditItem(a, false),
    deleteOwn: canDeleteItem(a, true),
    deleteAll: canDeleteItem(a, false),
    createSubfolders: canCreateSubfolder(a),
    manageFolder: canManageFolder(a),
    administer: canAdministerFolder(a),
  };
}
