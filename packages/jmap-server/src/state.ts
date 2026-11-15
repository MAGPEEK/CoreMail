/**
 * State strings (RFC 8620 §1.6.2) per account and data type.
 *
 * Email/Thread: `<maxMsgModSeq>.<mailboxHighestModSeq>.<maxCreatedMs>.<count>`
 *   - Since the message store (@coremail/storage message-store) every writer sets
 *     message.modSeq = ++mailbox.highestModSeq; rows from older versions may still
 *     carry Date.now()-sized modSeqs (the counter is lifted above them on first use).
 *   Both parts are kept so /changes also works across that migration.
 * Mailbox: `<count>.<maxCreatedMs>.<hash>` — hash over all visible fields.
 * Others (Identity, Quota, Principal, …): hash of the content.
 */
import { prisma } from '@coremail/storage';
import {
  hashState, encodeEmailState, encodeMailboxState,
  type EmailStateParts, type MailboxStateParts,
} from './state-codec.js';

export * from './state-codec.js';

export async function emailStateParts(mailboxId: string): Promise<EmailStateParts> {
  const [agg, mbx] = await Promise.all([
    prisma.message.aggregate({
      where: { folder: { mailboxId }, deletedAt: null },
      _max: { modSeq: true, createdAt: true },
      _count: { _all: true },
    }),
    prisma.mailbox.findUnique({ where: { id: mailboxId }, select: { highestModSeq: true } }),
  ]);
  const highestModSeq = mbx?.highestModSeq ?? 0n;
  return {
    maxModSeq: agg._max.modSeq ?? 0n,
    highestModSeq,
    maxCreatedMs: agg._max.createdAt?.getTime() ?? 0,
    count: agg._count._all,
    createdBase: highestModSeq,
  };
}

export async function emailState(mailboxId: string): Promise<string> {
  return encodeEmailState(await emailStateParts(mailboxId));
}

export async function mailboxStateParts(mailboxId: string): Promise<MailboxStateParts> {
  const folders = await prisma.folder.findMany({
    where: { mailboxId },
    orderBy: { id: 'asc' },
    select: {
      id: true, name: true, displayName: true, parentId: true, totalCount: true,
      unreadCount: true, sortOrder: true, subscribed: true, createdAt: true,
    },
  });
  let maxCreatedMs = 0;
  for (const f of folders) maxCreatedMs = Math.max(maxCreatedMs, f.createdAt.getTime());
  return {
    count: folders.length,
    maxCreatedMs,
    hash: hashState(folders.map((f) => [f.id, f.displayName, f.parentId, f.totalCount, f.unreadCount, f.sortOrder, f.subscribed])),
  };
}

export async function mailboxState(mailboxId: string): Promise<string> {
  return encodeMailboxState(await mailboxStateParts(mailboxId));
}
