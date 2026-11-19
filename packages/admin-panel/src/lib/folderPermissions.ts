/**
 * w3: folder permissions — the client model of the BCP "Ordnerberechtigungen"
 * editor (Outlook folder properties layout). Pure, no imports; unit-tested with
 * `node --test`.
 *
 * KEEP IN STEP with packages/storage/src/folder-permissions.ts (rights bits,
 * roles, normalisation) and with the webmail copy
 * packages/web-client/src/lib/folderPermissions.ts (identical up to the
 * folder-pane helpers at its end).
 *
 * API (api-gateway lib/folder-permissions-admin.ts, area recipients):
 *   GET  /admin/{mailboxes,shared-mailboxes}/:id/folder-permissions → FolderPermissionsOverview[]
 *   GET  …/:id/folders/:folderId/permissions → FolderPermissionsView
 *   PUT  …/:id/folders/:folderId/permissions ← buildPermissionsBody(entries)
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

export const FOLDER_ROLES = [
  'owner', 'publishingEditor', 'editor', 'publishingAuthor', 'author',
  'nonEditingAuthor', 'reviewer', 'contributor', 'none',
] as const;
export type FolderRole = (typeof FOLDER_ROLES)[number];
export type RoleChoice = FolderRole | 'custom';

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

export const ROLE_LABELS: Readonly<Record<RoleChoice, string>> = Object.freeze({
  owner: 'Besitzer',
  publishingEditor: 'Veröffentlichender Bearbeiter',
  editor: 'Bearbeiter',
  publishingAuthor: 'Veröffentlichender Autor',
  author: 'Autor',
  nonEditingAuthor: 'Nicht bearbeitender Autor',
  reviewer: 'Prüfer',
  contributor: 'Mitwirkender',
  none: 'Keine',
  custom: 'Benutzerdefiniert',
});

/** Role a user gets when added to the list (read access, like a reviewer). */
export const NEW_GRANTEE_ROLE: FolderRole = 'reviewer';

/** Canonical rights: unknown bits dropped, "all" implies "own" (as the server normalises). */
export function normalizeRights(rights: number): number {
  if (!Number.isInteger(rights) || rights < 0) return 0;
  let r = rights & ALL_FOLDER_RIGHTS;
  if (r & FolderRight.EditAny) r |= FolderRight.EditOwned;
  if (r & FolderRight.DeleteAny) r |= FolderRight.DeleteOwned;
  return r;
}

/** The role a rights value matches, or 'custom'. */
export function roleOf(rights: number): RoleChoice {
  const r = normalizeRights(rights);
  return FOLDER_ROLES.find((role) => ROLE_RIGHTS[role] === r) ?? 'custom';
}

export function roleLabel(role: RoleChoice): string {
  return ROLE_LABELS[role];
}

/** Choices of the "Berechtigungsstufe" dropdown: the roles, plus "Benutzerdefiniert" while custom. */
export function roleChoices(current: RoleChoice): RoleChoice[] {
  return current === 'custom' ? [...FOLDER_ROLES, 'custom'] : [...FOLDER_ROLES];
}

// ── Checkbox model (Lesen / Schreiben / Löschen / Sonstiges) ────────────────

export type DeleteLevel = 'none' | 'own' | 'all';

export interface RightsForm {
  /** Lesen: Keine (false) | Alle Elemente (true) */
  readAll: boolean;
  createItems: boolean;
  createSubfolders: boolean;
  editOwn: boolean;
  editAll: boolean;
  deleteLevel: DeleteLevel;
  folderOwner: boolean;
  folderContact: boolean;
  folderVisible: boolean;
}

export const READ_OPTIONS: ReadonlyArray<{ value: boolean; label: string }> = [
  { value: false, label: 'Keine' },
  { value: true, label: 'Alle Elemente' },
];

export const WRITE_OPTIONS: ReadonlyArray<{ key: 'createItems' | 'createSubfolders' | 'editOwn' | 'editAll'; label: string }> = [
  { key: 'createItems', label: 'Elemente erstellen' },
  { key: 'createSubfolders', label: 'Unterordner erstellen' },
  { key: 'editOwn', label: 'Eigene bearbeiten' },
  { key: 'editAll', label: 'Alle bearbeiten' },
];

export const DELETE_OPTIONS: ReadonlyArray<{ value: DeleteLevel; label: string }> = [
  { value: 'none', label: 'Keine' },
  { value: 'own', label: 'Eigene' },
  { value: 'all', label: 'Alle' },
];

export const OTHER_OPTIONS: ReadonlyArray<{ key: 'folderOwner' | 'folderContact' | 'folderVisible'; label: string }> = [
  { key: 'folderOwner', label: 'Ordnerbesitzer' },
  { key: 'folderContact', label: 'Ordnerkontaktperson' },
  { key: 'folderVisible', label: 'Ordner sichtbar' },
];

const bit = (r: number, b: number): boolean => (r & b) !== 0;

export function formFromRights(rights: number): RightsForm {
  const r = normalizeRights(rights);
  return {
    readAll: bit(r, FolderRight.ReadAny),
    createItems: bit(r, FolderRight.Create),
    createSubfolders: bit(r, FolderRight.CreateSubfolder),
    editOwn: bit(r, FolderRight.EditOwned),
    editAll: bit(r, FolderRight.EditAny),
    deleteLevel: bit(r, FolderRight.DeleteAny) ? 'all' : bit(r, FolderRight.DeleteOwned) ? 'own' : 'none',
    folderOwner: bit(r, FolderRight.FolderOwner),
    folderContact: bit(r, FolderRight.FolderContact),
    folderVisible: bit(r, FolderRight.FolderVisible),
  };
}

export function rightsFromForm(f: RightsForm): number {
  let r = 0;
  if (f.readAll) r |= FolderRight.ReadAny;
  if (f.createItems) r |= FolderRight.Create;
  if (f.createSubfolders) r |= FolderRight.CreateSubfolder;
  if (f.editOwn) r |= FolderRight.EditOwned;
  if (f.editAll) r |= FolderRight.EditAny;
  if (f.deleteLevel === 'own') r |= FolderRight.DeleteOwned;
  if (f.deleteLevel === 'all') r |= FolderRight.DeleteAny;
  if (f.folderOwner) r |= FolderRight.FolderOwner;
  if (f.folderContact) r |= FolderRight.FolderContact;
  if (f.folderVisible) r |= FolderRight.FolderVisible;
  return normalizeRights(r);
}

// ── Entries ─────────────────────────────────────────────────────────────────

export const DEFAULT_KEY = 'default';
export const ANONYMOUS_KEY = 'anonymous';

export interface PermissionUser { id: string; email: string; displayName: string }

export interface PermissionEntry {
  /** 'default' | 'anonymous' | 'user:<id>' — 'email:<address>' for a user added in this dialog. */
  granteeKey: string;
  user: PermissionUser | null;
  rights: number;
  role: RoleChoice;
  applyToSubfolders: boolean;
  fixed?: boolean;
}

export interface InheritedPermissionEntry extends PermissionEntry {
  fromFolderId: string;
}

export interface FolderPermissionsView {
  folderId: string;
  folderName: string;
  entries: PermissionEntry[];
  inherited: InheritedPermissionEntry[];
}

/** Anonymous (always "Keine" for mail folders) cannot be edited. */
export function isFixedEntry(e: Pick<PermissionEntry, 'granteeKey' | 'fixed'>): boolean {
  return e.fixed === true || e.granteeKey === ANONYMOUS_KEY;
}

/** Only user entries can be removed; Default and Anonymous always stay. */
export function isRemovableEntry(e: Pick<PermissionEntry, 'granteeKey'>): boolean {
  return e.granteeKey !== DEFAULT_KEY && e.granteeKey !== ANONYMOUS_KEY;
}

/** "Standard" | "Anonym" | "Name <address>". */
export function granteeLabel(e: Pick<PermissionEntry, 'granteeKey' | 'user'>): string {
  if (e.granteeKey === DEFAULT_KEY) return 'Standard';
  if (e.granteeKey === ANONYMOUS_KEY) return 'Anonym';
  if (!e.user) return e.granteeKey;
  return e.user.displayName && e.user.displayName !== e.user.email
    ? `${e.user.displayName} <${e.user.email}>`
    : e.user.email;
}

/** Key of a user added by address (no id known yet). */
export function emailGranteeKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
}

function sameGrantee(e: PermissionEntry, user: { id?: string; email: string }): boolean {
  if (user.id && e.granteeKey === `user:${user.id}`) return true;
  const addr = user.email.trim().toLowerCase();
  return e.granteeKey === emailGranteeKey(addr) || (e.user?.email.toLowerCase() === addr && addr !== '');
}

/** Whether the user (by id or address) is already in the list. */
export function hasGrantee(entries: readonly PermissionEntry[], user: { id?: string; email: string }): boolean {
  return entries.some((e) => sameGrantee(e, user));
}

/**
 * Adds a user with NEW_GRANTEE_ROLE (no-op when already listed). With an id the
 * entry is sent as { userId } (BCP), without one as { email } (webmail directory search).
 */
export function addGrantee(
  entries: readonly PermissionEntry[],
  user: { id?: string; email: string; displayName: string },
): PermissionEntry[] {
  if (hasGrantee(entries, user)) return [...entries];
  const email = user.email.trim();
  const rights = ROLE_RIGHTS[NEW_GRANTEE_ROLE];
  return [...entries, {
    granteeKey: user.id ? `user:${user.id}` : emailGranteeKey(email),
    user: { id: user.id ?? '', email, displayName: user.displayName },
    rights,
    role: NEW_GRANTEE_ROLE,
    applyToSubfolders: false,
  }];
}

export function removeGrantee(entries: readonly PermissionEntry[], key: string): PermissionEntry[] {
  return entries.filter((e) => e.granteeKey !== key || !isRemovableEntry(e));
}

function patchEntry(entries: readonly PermissionEntry[], key: string, patch: (e: PermissionEntry) => PermissionEntry): PermissionEntry[] {
  return entries.map((e) => (e.granteeKey === key && !isFixedEntry(e) ? patch(e) : e));
}

/** New rights from the checkboxes: the role follows (a matching role or custom). */
export function setEntryRights(entries: readonly PermissionEntry[], key: string, rights: number): PermissionEntry[] {
  const r = normalizeRights(rights);
  return patchEntry(entries, key, (e) => ({ ...e, rights: r, role: roleOf(r) }));
}

/** A role from the dropdown; 'custom' keeps the current rights. */
export function setEntryRole(entries: readonly PermissionEntry[], key: string, role: RoleChoice): PermissionEntry[] {
  if (role === 'custom') return [...entries];
  return setEntryRights(entries, key, ROLE_RIGHTS[role]);
}

export function setEntryApplyToSubfolders(entries: readonly PermissionEntry[], key: string, apply: boolean): PermissionEntry[] {
  return patchEntry(entries, key, (e) => ({ ...e, applyToSubfolders: apply }));
}

// ── PUT body ────────────────────────────────────────────────────────────────

export type PermissionGrantee = 'default' | 'anonymous' | { userId: string } | { email: string };

export interface PermissionBodyEntry {
  grantee: PermissionGrantee;
  role?: FolderRole;
  rights?: number;
  applyToSubfolders: boolean;
}

/** The grantee as the PUT body names it; null for an unknown key. */
export function granteeOf(e: Pick<PermissionEntry, 'granteeKey' | 'user'>): PermissionGrantee | null {
  if (e.granteeKey === DEFAULT_KEY) return 'default';
  if (e.granteeKey === ANONYMOUS_KEY) return 'anonymous';
  if (e.granteeKey.startsWith('user:')) return { userId: e.granteeKey.slice(5) };
  if (e.granteeKey.startsWith('email:')) return { email: e.user?.email ?? e.granteeKey.slice(6) };
  return null;
}

/**
 * The complete list for PUT (it replaces the folder's permissions): a role when
 * the rights match one, else the rights. Anonymous is left out (always "Keine").
 */
export function buildPermissionsBody(entries: readonly PermissionEntry[]): { entries: PermissionBodyEntry[] } {
  const out: PermissionBodyEntry[] = [];
  for (const e of entries) {
    if (e.granteeKey === ANONYMOUS_KEY) continue;
    const grantee = granteeOf(e);
    if (!grantee) continue;
    const role = roleOf(e.rights);
    out.push(role === 'custom'
      ? { grantee, rights: normalizeRights(e.rights), applyToSubfolders: e.applyToSubfolders }
      : { grantee, role, applyToSubfolders: e.applyToSubfolders });
  }
  return { entries: out };
}

/** Whether the edited list differs from the loaded one. */
export function permissionsChanged(loaded: readonly PermissionEntry[], edited: readonly PermissionEntry[]): boolean {
  return JSON.stringify(buildPermissionsBody(loaded)) !== JSON.stringify(buildPermissionsBody(edited));
}

/** "Geerbt von „Projekte"" — or "Geerbt von übergeordnetem Ordner" when the name is unknown. */
export function inheritedFromLabel(folderName: string | undefined): string {
  return folderName ? `Geerbt von „${folderName}"` : 'Geerbt von übergeordnetem Ordner';
}

// ── BCP overview ────────────────────────────────────────────────────────────

/** One folder of GET …/folder-permissions (raw folder name, own entries incl. Default + Anonymous). */
export interface FolderPermissionsOverview {
  id: string;
  name: string;
  parentId: string | null;
  entries: PermissionEntry[];
}

const SYSTEM_FOLDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  INBOX: 'Posteingang', Drafts: 'Entwürfe', Sent: 'Gesendete Elemente', Trash: 'Gelöschte Elemente',
  Junk: 'Junk-E-Mail', Archive: 'Archiv',
});

/** Display name of a folder: German name of a system folder, else the folder name. */
export function folderDisplayName(name: string): string {
  return SYSTEM_FOLDER_LABELS[name] ?? name;
}

/** "Standard: Keine · Max Muster <max@…>: Prüfer" — Anonymous is always "Keine" and left out. */
export function grantSummary(entries: readonly PermissionEntry[]): string {
  return entries
    .filter((e) => e.granteeKey !== ANONYMOUS_KEY)
    .map((e) => `${granteeLabel(e)}: ${roleLabel(e.role)}`)
    .join(' · ');
}
