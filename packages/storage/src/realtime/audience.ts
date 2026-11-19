/**
 * Who sees a change (9.4)? Resolves realtime events to the users whose clients
 * must refresh, and holds the writer-side helpers that need such a lookup.
 *
 *   mailboxAudience(db, mailboxId)  owner ('own') + Shared Mailbox members and
 *                                   delegates with a read permission (the same
 *                                   policy as listAccessibleMailboxes), each with
 *                                   the webmail mailbox key ("shared:<id>" /
 *                                   "delegated:<mailboxId>").
 *   publishCalendarChange(...)      calendar owner + share grantees.
 *
 * The database client is passed in (structural types, in-memory fakes in tests).
 */
import { publishUserEvent, type UserEventAction } from '@coremail/core';
import { MAILBOX_READ_PERMISSIONS } from '../mailbox-access.js';
import { DEFAULT_GRANTEE_KEY, FolderRight, computeFolderRights, type FolderTreeNode } from '../folder-permissions.js';

export interface AudienceMember {
  userId: string;
  /** Webmail mailbox key: "own" | "shared:<SharedMailbox id>" | "delegated:<Mailbox id>". */
  mailboxKey: string;
  /** Shared Mailbox id (quota key of the webmail) when kind = shared. */
  sharedMailboxId?: string;
  /**
   * w3: the member reaches the mailbox only through folder permissions — the
   * folders whose messages they may read (the SSE hub forwards only changes of
   * these). Absent = the whole mailbox.
   */
  folderIds?: string[];
}

export interface AudienceDb {
  mailbox: { findUnique(args: never): Promise<unknown> };
}

interface MailboxAudienceRow {
  id: string;
  userId: string | null;
  sharedBoxId: string | null;
  sharedBox: { active: boolean; permissions: Array<{ userId: string; permission: string; user: { active: boolean } | null }> } | null;
  delegates: Array<{ granteeId: string; permission: string; grantee: { active: boolean } | null }>;
  user: { active: boolean } | null;
  /** w3: folders and user folder grants (Default grants reach everyone and are not pushed). */
  folders?: FolderTreeNode[];
  folderPermissions?: Array<{
    folderId: string; granteeKey: string; granteeId: string | null; rights: number; applyToSubfolders: boolean;
    grantee: { active: boolean } | null;
  }>;
}

const READ = new Set<string>(MAILBOX_READ_PERMISSIONS);

/** Pure: the audience of one mailbox row. */
export function audienceFromRow(row: MailboxAudienceRow): AudienceMember[] {
  const out = new Map<string, AudienceMember>();
  if (row.userId) out.set(row.userId, { userId: row.userId, mailboxKey: 'own' });
  if (row.sharedBoxId && row.sharedBox?.active) {
    for (const p of row.sharedBox.permissions) {
      if (!READ.has(p.permission) || p.user?.active === false || out.has(p.userId)) continue;
      out.set(p.userId, { userId: p.userId, mailboxKey: `shared:${row.sharedBoxId}`, sharedMailboxId: row.sharedBoxId });
    }
  }
  if (row.userId && row.user?.active !== false) {
    for (const d of row.delegates) {
      if (!READ.has(d.permission) || d.grantee?.active === false || out.has(d.granteeId)) continue;
      out.set(d.granteeId, { userId: d.granteeId, mailboxKey: `delegated:${row.id}` });
    }
  }
  for (const member of folderGrantAudience(row, out)) out.set(member.userId, member);
  return [...out.values()];
}

/** Pure (w3): users who reach the mailbox only through their own folder grants, with their readable folders. */
function folderGrantAudience(row: MailboxAudienceRow, known: ReadonlyMap<string, AudienceMember>): AudienceMember[] {
  const grants = (row.folderPermissions ?? [])
    .filter((g) => g.granteeKey !== DEFAULT_GRANTEE_KEY && g.granteeId && g.grantee?.active !== false);
  if (grants.length === 0 || (row.userId && row.user?.active === false) || (row.sharedBoxId && !row.sharedBox?.active)) return [];
  const mailboxKey = row.sharedBoxId ? `shared:${row.sharedBoxId}` : `delegated:${row.id}`;
  const out: AudienceMember[] = [];
  for (const granteeId of new Set(grants.map((g) => g.granteeId as string))) {
    if (known.has(granteeId) || granteeId === row.userId) continue;
    const rights = computeFolderRights(row.folders ?? [], grants, granteeId, 0);
    const folderIds = [...rights].filter(([, r]) => (r & FolderRight.ReadAny) !== 0).map(([id]) => id);
    if (folderIds.length === 0) continue;
    out.push({ userId: granteeId, mailboxKey, ...(row.sharedBoxId ? { sharedMailboxId: row.sharedBoxId } : {}), folderIds });
  }
  return out;
}

/** Every user whose webmail shows the mailbox (empty when it does not exist). */
export async function mailboxAudience(db: AudienceDb, mailboxId: string): Promise<AudienceMember[]> {
  const row = await db.mailbox.findUnique({
    where: { id: mailboxId },
    select: {
      id: true, userId: true, sharedBoxId: true,
      user: { select: { active: true } },
      sharedBox: { select: { active: true, permissions: { select: { userId: true, permission: true, user: { select: { active: true } } } } } },
      delegates: { select: { granteeId: true, permission: true, grantee: { select: { active: true } } } },
      folders: { select: { id: true, name: true, parentId: true } },
      folderPermissions: {
        where: { granteeId: { not: null } },
        select: { folderId: true, granteeKey: true, granteeId: true, rights: true, applyToSubfolders: true, grantee: { select: { active: true } } },
      },
    },
  } as never) as MailboxAudienceRow | null;
  return row ? audienceFromRow(row) : [];
}

export interface CalendarAudienceDb {
  calendar: { findMany(args: never): Promise<unknown[]> };
}

/**
 * Announces a change of calendar data (events, the calendar itself or its
 * shares) to the owners and grantees of the given calendars. `extraUserIds`
 * reach users that lost access in the same change (a removed share).
 *
 * Event ids go to the owners only: a grantee must not learn that a
 * confidential event (hidden from grantees) was created or changed — the
 * calendar ids are enough for their refresh.
 */
export async function publishCalendarChange(
  db: CalendarAudienceDb,
  calendarIds: string[],
  opts: { action?: UserEventAction; ids?: string[]; scope?: 'shares'; extraUserIds?: string[] } = {},
): Promise<void> {
  const ids = [...new Set(calendarIds)];
  const owners = new Set<string>();
  const others = new Set(opts.extraUserIds ?? []);
  if (ids.length > 0) {
    const rows = await db.calendar.findMany({
      where: { id: { in: ids } },
      select: { userId: true, shares: { select: { granteeId: true } } },
    } as never) as Array<{ userId: string; shares: Array<{ granteeId: string }> }>;
    for (const r of rows) {
      owners.add(r.userId);
      for (const s of r.shares) others.add(s.granteeId);
    }
  }
  for (const o of owners) others.delete(o);
  const base = {
    type: 'calendar' as const,
    ...(ids.length ? { calendarIds: ids } : {}),
    ...(opts.action ? { action: opts.action } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
  await Promise.all([
    publishUserEvent(owners, { ...base, ...(opts.ids?.length ? { ids: opts.ids } : {}) }),
    publishUserEvent(others, base),
  ]);
}
