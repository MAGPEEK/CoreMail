/**
 * Mailbox Provisioning Helper — Phase 10
 *
 * Creates a mailbox + default folders + default calendar for a user
 * if they don't already have one.
 *
 * Called:
 *   - On POST /api/v1/admin/mailboxes (new user creation)
 *   - On POST /api/v1/admin/mailboxes/:id/provision (repair/backfill)
 *   - On first OAuth2 login (auto-provision on SSO)
 */

import { prisma } from '@coremail/storage/prisma';
import { createLogger } from '@coremail/core';

const log = createLogger('provision-mailbox');

export const DEFAULT_FOLDERS = [
  { name: 'INBOX',   displayName: 'Inbox' },
  { name: 'Drafts',  displayName: 'Drafts' },
  { name: 'Sent',    displayName: 'Sent Items' },
  { name: 'Trash',   displayName: 'Deleted Items' },
  { name: 'Junk',    displayName: 'Junk Email' },
  { name: 'Archive', displayName: 'Archive' },
  { name: 'Notes',   displayName: 'Notes' },
  { name: 'Tasks',   displayName: 'Tasks' },
];

export interface ProvisionResult {
  mailboxCreated: boolean;
  foldersCreated: number;
  calendarCreated: boolean;
  alreadyExisted: boolean;
}

/**
 * Ensure a user has a fully provisioned mailbox.
 * Safe to call multiple times — idempotent.
 */
export async function ensureMailboxProvisioned(userId: string): Promise<ProvisionResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      mailbox: { include: { folders: { select: { name: true } } } },
      calendars: { select: { id: true } },
    },
  });

  if (!user) throw new Error(`User ${userId} not found`);

  // ── Mailbox ────────────────────────────────────────────────────────────────
  let mailboxCreated = false;
  let foldersCreated = 0;
  let mailbox = user.mailbox;

  if (!mailbox) {
    log.info({ userId, email: user.email }, 'Provisioning mailbox');
    mailbox = await prisma.mailbox.create({
      data: {
        userId,
        folders: {
          create: DEFAULT_FOLDERS.map((f) => ({
            name: f.name,
            displayName: f.displayName,
            totalCount: 0,
            unreadCount: 0,
          })),
        },
      },
      include: { folders: { select: { name: true } } },
    });
    mailboxCreated = true;
    foldersCreated = DEFAULT_FOLDERS.length;
  } else {
    // Ensure all default folders exist (backfill missing ones)
    const existingNames = new Set(mailbox.folders.map((f) => f.name));
    const missingFolders = DEFAULT_FOLDERS.filter((f) => !existingNames.has(f.name));
    if (missingFolders.length > 0) {
      await prisma.folder.createMany({
        data: missingFolders.map((f) => ({
          mailboxId: mailbox!.id,
          name: f.name,
          displayName: f.displayName,
          totalCount: 0,
          unreadCount: 0,
        })),
        skipDuplicates: true,
      });
      foldersCreated = missingFolders.length;
      log.info({ userId, foldersCreated }, 'Backfilled missing default folders');
    }
  }

  // ── Calendar ───────────────────────────────────────────────────────────────
  let calendarCreated = false;
  if (user.calendars.length === 0) {
    await prisma.calendar.create({
      data: { userId, name: 'Calendar', color: '#0078D4' },
    });
    calendarCreated = true;
    log.info({ userId }, 'Default calendar created');
  }

  return {
    mailboxCreated,
    foldersCreated,
    calendarCreated,
    alreadyExisted: !mailboxCreated && foldersCreated === 0 && !calendarCreated,
  };
}

/**
 * Ensure a SharedMailbox has the same fully-provisioned folder structure
 * as a regular user mailbox. Idempotent — safe to call repeatedly.
 *
 * Erstellt:
 *   - `Mailbox`-Record (verknüpft via sharedBoxId), falls fehlend
 *   - DEFAULT_FOLDERS (Inbox / Drafts / Sent / Trash / Junk / Archive / Notes / Tasks)
 *     — Backfill von fehlenden Standard-Ordnern bei bestehenden Mailboxen
 *
 * Kein Kalender für Shared Mailboxes (Resource Mailboxes haben den separat).
 */
export async function ensureSharedMailboxProvisioned(sharedMailboxId: string): Promise<ProvisionResult> {
  const sm = await prisma.sharedMailbox.findUnique({
    where: { id: sharedMailboxId },
    include: { mailbox: { include: { folders: { select: { name: true } } } } },
  });
  if (!sm) throw new Error(`SharedMailbox ${sharedMailboxId} not found`);

  let mailboxCreated = false;
  let foldersCreated = 0;
  let mailbox = sm.mailbox;

  if (!mailbox) {
    log.info({ sharedMailboxId, email: sm.email }, 'Provisioning shared mailbox');
    mailbox = await prisma.mailbox.create({
      data: {
        sharedBoxId: sharedMailboxId,
        folders: {
          create: DEFAULT_FOLDERS.map((f) => ({
            name: f.name,
            displayName: f.displayName,
            totalCount: 0,
            unreadCount: 0,
          })),
        },
      },
      include: { folders: { select: { name: true } } },
    });
    mailboxCreated = true;
    foldersCreated = DEFAULT_FOLDERS.length;
  } else {
    const existingNames = new Set(mailbox.folders.map((f) => f.name));
    const missingFolders = DEFAULT_FOLDERS.filter((f) => !existingNames.has(f.name));
    if (missingFolders.length > 0) {
      await prisma.folder.createMany({
        data: missingFolders.map((f) => ({
          mailboxId: mailbox!.id,
          name: f.name,
          displayName: f.displayName,
          totalCount: 0,
          unreadCount: 0,
        })),
        skipDuplicates: true,
      });
      foldersCreated = missingFolders.length;
      log.info({ sharedMailboxId, foldersCreated }, 'Backfilled missing default folders');
    }
  }

  return {
    mailboxCreated,
    foldersCreated,
    calendarCreated: false, // keine Kalender für Shared Mailboxes
    alreadyExisted: !mailboxCreated && foldersCreated === 0,
  };
}
