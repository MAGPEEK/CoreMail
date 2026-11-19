/**
 * Which foreign mailboxes may a user open? (v9.1)
 *
 * The same policy as JMAP account resolution (jmap-server `resolveAccounts`), the
 * REST shared-mailbox routes (`getReadableSharedMailbox`) and the web attachment
 * download (`readableMailboxWhere`):
 *
 *   - Shared Mailbox: the box is active and has a mailbox row, and the user holds
 *     FULL_ACCESS (read-write) or READ_ONLY (read-only). SEND_AS / SEND_ON_BEHALF
 *     alone grant no mailbox access.
 *   - Delegated mailbox (MailboxDelegate): the owner is an active user and the
 *     grantee holds FULL_ACCESS (read-write) or READ_ONLY (read-only). Delegation
 *     never grants send-as.
 *
 * The user's own mailbox is never part of the result. The database client is
 * passed in (no runtime import of the Prisma client), so protocol test harnesses
 * can run this module unchanged against an in-memory fake.
 */

export type ForeignMailboxKind = 'shared' | 'delegated';

export interface AccessibleMailbox {
  kind: ForeignMailboxKind;
  mailboxId: string;
  /** Primary address of the shared mailbox / the delegating user (lower case). */
  email: string;
  displayName: string;
  /** READ_ONLY without FULL_ACCESS. */
  readOnly: boolean;
  sharedMailboxId: string | null;
  ownerUserId: string | null;
  /**
   * 9.4 auto-mapping: shown in the webmail folder pane and the IMAP namespace
   * without the user adding it (false only when every read grant has it off).
   */
  autoMap: boolean;
  /**
   * w3: reached only through folder permissions (no mailbox-level grant) — only
   * folder-aware paths (storage folder-access.ts) list such entries; access is
   * decided per folder. Always `readOnly` at mailbox level.
   */
  folderScoped?: boolean;
}

/** Permissions that grant access to the mailbox content. */
export const MAILBOX_READ_PERMISSIONS = ['FULL_ACCESS', 'READ_ONLY'] as const;

interface SharedPermRow {
  permission: string;
  autoMap?: boolean;
  sharedMailbox: {
    id: string; email: string; displayName: string | null; active: boolean;
    mailbox: { id: string } | null;
  } | null;
}

interface DelegateRow {
  permission: string;
  autoMap?: boolean;
  mailbox: {
    id: string;
    user: { id: string; email: string; displayName: string | null; active: boolean } | null;
  } | null;
}

/** The part of the Prisma client this module reads (structural, for fakes). */
export interface MailboxAccessDb {
  sharedMailboxPerm: { findMany(args: never): Promise<unknown[]> };
  mailboxDelegate: { findMany(args: never): Promise<unknown[]> };
}

/**
 * Every foreign mailbox `userId` may currently read, sorted by kind and address.
 * At most one entry per mailbox.
 */
export async function listAccessibleMailboxes(db: MailboxAccessDb, userId: string): Promise<AccessibleMailbox[]> {
  const sharedArgs = {
    where: { userId, permission: { in: [...MAILBOX_READ_PERMISSIONS] } },
    select: {
      permission: true,
      autoMap: true,
      sharedMailbox: {
        select: { id: true, email: true, displayName: true, active: true, mailbox: { select: { id: true } } },
      },
    },
  };
  const delegateArgs = {
    where: { granteeId: userId, permission: { in: [...MAILBOX_READ_PERMISSIONS] } },
    select: {
      permission: true,
      autoMap: true,
      mailbox: { select: { id: true, user: { select: { id: true, email: true, displayName: true, active: true } } } },
    },
  };
  const [perms, delegations] = await Promise.all([
    db.sharedMailboxPerm.findMany(sharedArgs as never) as Promise<SharedPermRow[]>,
    db.mailboxDelegate.findMany(delegateArgs as never) as Promise<DelegateRow[]>,
  ]);
  return accessFromRows(userId, perms, delegations);
}

/** Pure part of {@link listAccessibleMailboxes}: aggregates the permission rows. */
export function accessFromRows(userId: string, perms: SharedPermRow[], delegations: DelegateRow[]): AccessibleMailbox[] {
  const out = new Map<string, AccessibleMailbox>();
  const isRead = (p: string): boolean => (MAILBOX_READ_PERMISSIONS as readonly string[]).includes(p);

  // Shared mailboxes — several permission rows per box (FULL_ACCESS + SEND_AS …).
  for (const p of perms) {
    const box = p.sharedMailbox;
    if (!box || !box.active || !box.mailbox || !isRead(p.permission)) continue;
    const existing = out.get(box.mailbox.id);
    const readOnly = p.permission !== 'FULL_ACCESS';
    const autoMap = p.autoMap !== false;
    if (existing) {
      existing.readOnly = existing.readOnly && readOnly;
      existing.autoMap = existing.autoMap || autoMap;
      continue;
    }
    out.set(box.mailbox.id, {
      kind: 'shared', mailboxId: box.mailbox.id, email: box.email.toLowerCase(),
      displayName: box.displayName || box.email, readOnly, sharedMailboxId: box.id, ownerUserId: null, autoMap,
    });
  }

  for (const d of delegations) {
    const owner = d.mailbox?.user;
    if (!d.mailbox || !owner || !owner.active || owner.id === userId || !isRead(d.permission)) continue;
    if (out.has(d.mailbox.id)) continue;
    out.set(d.mailbox.id, {
      kind: 'delegated', mailboxId: d.mailbox.id, email: owner.email.toLowerCase(),
      displayName: owner.displayName || owner.email, readOnly: d.permission !== 'FULL_ACCESS',
      sharedMailboxId: null, ownerUserId: owner.id, autoMap: d.autoMap !== false,
    });
  }

  return [...out.values()].sort((a, b) => (a.kind === b.kind ? a.email.localeCompare(b.email) : a.kind.localeCompare(b.kind)));
}

// ─── Auto-mapping (9.4) ──────────────────────────────────────────────────────

/** Folder-pane reference of a foreign mailbox: "shared:<sharedMailboxId>" | "delegated:<mailboxId>". */
export function accessibleMailboxRef(a: Pick<AccessibleMailbox, 'kind' | 'mailboxId' | 'sharedMailboxId'>): string {
  return a.kind === 'shared' ? `shared:${a.sharedMailboxId ?? ''}` : `delegated:${a.mailboxId}`;
}

/**
 * Pure: is a foreign mailbox mapped into the user's folder pane / IMAP
 * namespace? Auto-mapped grants always are; others only after the user added
 * them (UserSettings.addedSharedMailboxes). Access itself never depends on it.
 */
export function isMailboxMapped(
  a: Pick<AccessibleMailbox, 'kind' | 'mailboxId' | 'sharedMailboxId' | 'autoMap'>,
  added: ReadonlySet<string>,
): boolean {
  return a.autoMap || added.has(accessibleMailboxRef(a));
}

// ─── Reserved folder names (IMAP namespace prefixes) ─────────────────────────

const DISABLED_PREFIX = new Set(['', 'off', 'none', 'false', 'disabled']);

function prefixFromEnv(value: string | undefined, fallback: string): string | null {
  if (value === undefined) return fallback;
  const v = value.trim().replace(/\/+$/, '');
  if (DISABLED_PREFIX.has(v.toLowerCase())) return null;
  // Same validity rule as the IMAP server (imap-server namespaces.ts): invalid → default.
  if (v.length > 64 || !/^[\x20-\x7e]+$/.test(v) || /[./%*"\\]/.test(v) || v.toUpperCase() === 'INBOX') return fallback;
  return v;
}

/**
 * The IMAP namespace prefixes (9.1) — IMAP_NAMESPACE_OTHER_USERS (default
 * "Other Users") and IMAP_NAMESPACE_SHARED (default "Shared"); disabled ones are
 * left out. A personal folder named "<prefix>/…" can never be selected over IMAP
 * (the name resolves into the namespace), so new folders must not get such names.
 */
export function reservedNamespacePrefixes(env: Record<string, string | undefined> = process.env): string[] {
  return [
    prefixFromEnv(env['IMAP_NAMESPACE_OTHER_USERS'], 'Other Users'),
    prefixFromEnv(env['IMAP_NAMESPACE_SHARED'], 'Shared'),
  ].filter((p): p is string => p !== null);
}

/** The reserved prefix a folder name starts with ("<prefix>/", any case), or null. */
export function reservedFolderPrefix(name: string, env: Record<string, string | undefined> = process.env): string | null {
  const lower = name.trim().toLowerCase();
  return reservedNamespacePrefixes(env).find((p) => lower.startsWith(`${p.toLowerCase()}/`)) ?? null;
}

/** User-facing error for a reserved folder name. */
export function reservedFolderNameError(prefix: string): string {
  return `Folder names starting with "${prefix}/" are reserved for shared and delegated mailboxes`;
}
