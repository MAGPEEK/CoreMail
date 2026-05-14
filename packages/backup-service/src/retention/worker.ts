/**
 * Retention Policy Worker — Phase 9
 *
 * Runs daily (or on demand) and applies all enabled retention policies:
 *
 *   - ARCHIVE  → moves matching messages to the user's Archive folder
 *   - DELETE   → permanently deletes matching messages (respects Legal Hold)
 *   - MOVE_TO_FOLDER → moves to a named folder (created if not existing)
 *
 * Policies are matched by:
 *   - GLOBAL assignments → all mailboxes
 *   - DOMAIN assignments → all users of the domain
 *   - USER assignments   → specific user mailboxes
 *
 * Legal Hold: messages under an active LegalHold are never deleted (even if policy says DELETE).
 */

import { prisma } from '@coremail/storage/prisma';
import { createLogger } from '@coremail/core';

const log = createLogger('retention:worker');

const DRY_RUN = process.env['RETENTION_DRY_RUN'] === 'true';

export interface RetentionRunResult {
  policiesProcessed: number;
  messagesArchived: number;
  messagesDeleted: number;
  messagesMoved: number;
  messagesSkipped: number;
  errors: string[];
}

/**
 * Run all enabled retention policies.
 * Called by the scheduler (daily at 03:00 UTC).
 */
export async function runRetentionPolicies(): Promise<RetentionRunResult> {
  const result: RetentionRunResult = {
    policiesProcessed: 0,
    messagesArchived: 0,
    messagesDeleted: 0,
    messagesMoved: 0,
    messagesSkipped: 0,
    errors: [],
  };

  log.info({ dryRun: DRY_RUN }, 'Starting retention policy run');

  const policies = await prisma.retentionPolicy.findMany({
    where: { enabled: true },
    include: { assignments: true },
  });

  for (const policy of policies) {
    try {
      await applyPolicy(policy, result);
      result.policiesProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ policyId: policy.id, err }, 'Policy execution failed');
      result.errors.push(`Policy "${policy.name}" (${policy.id}): ${msg}`);
    }
  }

  log.info(result, 'Retention policy run completed');
  return result;
}

// ── Policy Application ────────────────────────────────────────────────────────

async function applyPolicy(
  policy: Awaited<ReturnType<typeof prisma.retentionPolicy.findMany>>[number],
  result: RetentionRunResult,
): Promise<void> {
  // Determine which users are in scope
  const userIds = await resolveUserIds(policy.assignments);
  if (userIds.length === 0) return;

  // Calculate the cutoff date
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - policy.retentionDays);

  // Get active legal holds (affected mailboxes)
  const legalHolds = policy.respectLegalHold
    ? await prisma.legalHold.findMany({ where: { active: true } })
    : [];
  const heldUserIds = new Set(legalHolds.flatMap((h) => h.mailboxIds));

  log.info(
    {
      policyId: policy.id,
      policyName: policy.name,
      users: userIds.length,
      cutoffDate: cutoffDate.toISOString(),
      action: policy.action,
    },
    'Applying retention policy',
  );

  for (const userId of userIds) {
    try {
      await applyPolicyForUser(policy, userId, cutoffDate, heldUserIds, result);
    } catch (err) {
      log.error({ policyId: policy.id, userId, err }, 'Failed to apply policy for user');
      result.errors.push(`User ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function applyPolicyForUser(
  policy: Awaited<ReturnType<typeof prisma.retentionPolicy.findMany>>[number],
  userId: string,
  cutoffDate: Date,
  heldUserIds: Set<string>,
  result: RetentionRunResult,
): Promise<void> {
  const mailbox = await prisma.mailbox.findUnique({
    where: { userId },
    include: { folders: { select: { id: true, name: true, displayName: true } } },
  });
  if (!mailbox) return;

  // Build folder filter based on scope
  const folderIds = resolveFolderIds(policy.scope, mailbox.folders);
  if (folderIds.length === 0) return;

  // Query matching messages
  const messages = await prisma.message.findMany({
    where: {
      folderId: { in: folderIds },
      date: { lt: cutoffDate },
      deletedAt: null,
    },
    select: { id: true, folderId: true, rawSize: true },
  });

  if (messages.length === 0) return;

  // If user is under Legal Hold and action is DELETE → skip
  if (heldUserIds.has(userId) && policy.action === 'DELETE') {
    log.info({ userId, count: messages.length }, 'Skipping DELETE — user under Legal Hold');
    result.messagesSkipped += messages.length;
    return;
  }

  if (DRY_RUN) {
    log.info(
      { userId, policyId: policy.id, action: policy.action, count: messages.length },
      '[DRY RUN] Would apply retention action',
    );
    result.messagesSkipped += messages.length;
    return;
  }

  const messageIds = messages.map((m) => m.id);

  switch (policy.action) {
    case 'ARCHIVE':
      await archiveMessages(messageIds, mailbox.folders, userId, result);
      break;

    case 'DELETE':
      await deleteMessages(messageIds, userId, result);
      break;

    case 'MOVE_TO_FOLDER':
      if (policy.targetFolder) {
        await moveMessagesToFolder(
          messageIds,
          policy.targetFolder,
          mailbox.id,
          mailbox.folders,
          userId,
          result,
        );
      }
      break;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function archiveMessages(
  messageIds: string[],
  folders: { id: string; name: string; displayName: string }[],
  userId: string,
  result: RetentionRunResult,
): Promise<void> {
  const archiveFolder = folders.find(
    (f) => f.name === 'Archive' || f.displayName === 'Archiv',
  );
  if (!archiveFolder) {
    log.warn({ userId }, 'No Archive folder found — skipping archive action');
    result.messagesSkipped += messageIds.length;
    return;
  }

  await prisma.message.updateMany({
    where: { id: { in: messageIds } },
    data: { folderId: archiveFolder.id },
  });

  result.messagesArchived += messageIds.length;
  log.debug({ userId, count: messageIds.length }, 'Messages archived');
}

async function deleteMessages(
  messageIds: string[],
  userId: string,
  result: RetentionRunResult,
): Promise<void> {
  // Hard delete — remove from DB (attachments cascade)
  // First free up quota
  const messages = await prisma.message.findMany({
    where: { id: { in: messageIds } },
    select: { rawSize: true },
  });
  const totalSize = messages.reduce((sum, m) => sum + m.rawSize, 0);

  await prisma.message.deleteMany({ where: { id: { in: messageIds } } });

  await prisma.user.update({
    where: { id: userId },
    data: { usedBytes: { decrement: totalSize } },
  });

  result.messagesDeleted += messageIds.length;
  log.debug({ userId, count: messageIds.length, totalSize }, 'Messages permanently deleted by retention policy');
}

async function moveMessagesToFolder(
  messageIds: string[],
  targetFolderName: string,
  mailboxId: string,
  folders: { id: string; name: string; displayName: string }[],
  userId: string,
  result: RetentionRunResult,
): Promise<void> {
  let targetFolder = folders.find(
    (f) =>
      f.name.toLowerCase() === targetFolderName.toLowerCase() ||
      f.displayName.toLowerCase() === targetFolderName.toLowerCase(),
  );

  // Create the folder if it doesn't exist
  if (!targetFolder) {
    log.info({ userId, targetFolderName }, 'Creating retention target folder');
    targetFolder = await prisma.folder.create({
      data: {
        mailboxId,
        name: targetFolderName,
        displayName: targetFolderName,
      },
      select: { id: true, name: true, displayName: true },
    });
  }

  await prisma.message.updateMany({
    where: { id: { in: messageIds } },
    data: { folderId: targetFolder.id },
  });

  result.messagesMoved += messageIds.length;
  log.debug({ userId, count: messageIds.length, targetFolder: targetFolderName }, 'Messages moved by retention policy');
}

// ── Resolution Helpers ────────────────────────────────────────────────────────

async function resolveUserIds(
  assignments: Array<{ target: string; targetId: string }>,
): Promise<string[]> {
  const userIds = new Set<string>();

  for (const assignment of assignments) {
    switch (assignment.target) {
      case 'GLOBAL': {
        const users = await prisma.user.findMany({
          where: { active: true },
          select: { id: true },
        });
        users.forEach((u) => userIds.add(u.id));
        break;
      }
      case 'DOMAIN': {
        if (assignment.targetId) {
          const domain = await prisma.domain.findUnique({
            where: { name: assignment.targetId },
            include: { users: { select: { id: true } } },
          });
          domain?.users.forEach((u) => userIds.add(u.id));
        }
        break;
      }
      case 'USER': {
        if (assignment.targetId) {
          userIds.add(assignment.targetId);
        }
        break;
      }
    }
  }

  return Array.from(userIds);
}

function resolveFolderIds(
  scope: string,
  folders: { id: string; name: string; displayName: string }[],
): string[] {
  switch (scope) {
    case 'ALL_ITEMS':
      return folders.map((f) => f.id);

    case 'INBOX':
      return folders
        .filter((f) => f.name === 'Inbox' || f.name === 'INBOX')
        .map((f) => f.id);

    case 'SENT_ITEMS':
      return folders
        .filter((f) => f.name === 'Sent Items' || f.name === 'Sent')
        .map((f) => f.id);

    case 'DELETED_ITEMS':
      return folders
        .filter((f) => f.name === 'Deleted Items' || f.name === 'Trash')
        .map((f) => f.id);

    case 'JUNK':
      return folders
        .filter((f) => f.name === 'Junk E-Mail' || f.name === 'Junk' || f.name === 'Spam')
        .map((f) => f.id);

    default:
      return [];
  }
}
