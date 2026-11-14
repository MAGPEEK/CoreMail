/**
 * Mailbox provisioning (moved from api-gateway/lib in v6.1 so that auth paths —
 * LDAP first login, LDAP sync, OIDC auto-provisioning — can call it).
 *
 * Creates the mailbox + default folders + default calendar of a user if they
 * are missing. Idempotent: safe to call repeatedly, backfills missing folders.
 *
 * Called by:
 *   - POST /api/v1/admin/mailboxes (new user) and /:id/provision (repair)
 *   - LDAP first login + LDAP sync (@coremail/auth-ldap)
 *   - OIDC auto-provisioning (@coremail/auth-sso)
 */
import { createLogger } from '@coremail/core';
import { prisma } from './prisma/index.js';

const log = createLogger('provision-mailbox');

// Only real mail folders — Notes and Tasks are separate database models.
export const DEFAULT_FOLDERS = [
  { name: 'INBOX',   displayName: 'Inbox' },
  { name: 'Drafts',  displayName: 'Drafts' },
  { name: 'Sent',    displayName: 'Sent Items' },
  { name: 'Trash',   displayName: 'Deleted Items' },
  { name: 'Junk',    displayName: 'Junk Email' },
  { name: 'Archive', displayName: 'Archive' },
];

export interface ProvisionResult {
  mailboxCreated: boolean;
  foldersCreated: number;
  calendarCreated: boolean;
  alreadyExisted: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

/** Creates the missing default folders of a mailbox. Returns how many were created. */
async function backfillFolders(mailboxId: string): Promise<number> {
  const existing = await prisma.folder.findMany({ where: { mailboxId }, select: { name: true } });
  const names = new Set(existing.map((f) => f.name));
  const missing = DEFAULT_FOLDERS.filter((f) => !names.has(f.name));
  if (missing.length === 0) return 0;
  await prisma.folder.createMany({
    data: missing.map((f) => ({ mailboxId, name: f.name, displayName: f.displayName, totalCount: 0, unreadCount: 0 })),
    skipDuplicates: true,
  });
  return missing.length;
}

/** Ensure a user has a fully provisioned mailbox. Idempotent. */
export async function ensureMailboxProvisioned(userId: string): Promise<ProvisionResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) throw new Error(`User ${userId} not found`);

  let mailboxCreated = false;
  let mailbox = await prisma.mailbox.findUnique({ where: { userId }, select: { id: true } });
  if (!mailbox) {
    try {
      mailbox = await prisma.mailbox.create({ data: { userId }, select: { id: true } });
      mailboxCreated = true;
      log.info({ userId, email: user.email }, 'Mailbox provisioned');
    } catch (err) {
      // Concurrent first logins: the other request created it.
      if (!isUniqueViolation(err)) throw err;
      mailbox = await prisma.mailbox.findUnique({ where: { userId }, select: { id: true } });
      if (!mailbox) throw err;
    }
  }
  const foldersCreated = await backfillFolders(mailbox.id);
  if (foldersCreated > 0 && !mailboxCreated) log.info({ userId, foldersCreated }, 'Backfilled missing default folders');

  let calendarCreated = false;
  if ((await prisma.calendar.count({ where: { userId } })) === 0) {
    await prisma.calendar.create({
      data: { userId, name: 'Kalender', color: '#0078D4', isDefault: true, sortOrder: 0 },
    });
    calendarCreated = true;
  }

  return {
    mailboxCreated,
    foldersCreated,
    calendarCreated,
    alreadyExisted: !mailboxCreated && foldersCreated === 0 && !calendarCreated,
  };
}

/**
 * Ensure a SharedMailbox has the same default folder structure as a user
 * mailbox (no calendar). Idempotent.
 */
export async function ensureSharedMailboxProvisioned(sharedMailboxId: string): Promise<ProvisionResult> {
  const sm = await prisma.sharedMailbox.findUnique({ where: { id: sharedMailboxId }, select: { id: true, email: true } });
  if (!sm) throw new Error(`SharedMailbox ${sharedMailboxId} not found`);

  let mailboxCreated = false;
  let mailbox = await prisma.mailbox.findUnique({ where: { sharedBoxId: sharedMailboxId }, select: { id: true } });
  if (!mailbox) {
    try {
      mailbox = await prisma.mailbox.create({ data: { sharedBoxId: sharedMailboxId }, select: { id: true } });
      mailboxCreated = true;
      log.info({ sharedMailboxId, email: sm.email }, 'Shared mailbox provisioned');
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      mailbox = await prisma.mailbox.findUnique({ where: { sharedBoxId: sharedMailboxId }, select: { id: true } });
      if (!mailbox) throw err;
    }
  }
  const foldersCreated = await backfillFolders(mailbox.id);

  return {
    mailboxCreated,
    foldersCreated,
    calendarCreated: false,
    alreadyExisted: !mailboxCreated && foldersCreated === 0,
  };
}
