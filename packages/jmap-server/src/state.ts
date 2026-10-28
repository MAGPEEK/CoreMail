/**
 * State strings (RFC 8620 §1.6.2) per account and data type.
 *
 * Email/Thread: `<maxMsgModSeq>.<mailboxHighestModSeq>.<maxCreatedMs>.<count>`
 *   - REST/JMAP set modSeq = Date.now() on changes (ms, > 1e12)
 *   - SMTP inbound/IMAP increment the mailbox counter highestModSeq (small)
 *   Both semantics are tracked separately so /changes misses nothing.
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
  return {
    maxModSeq: agg._max.modSeq ?? 0n,
    highestModSeq: mbx?.highestModSeq ?? 0n,
    maxCreatedMs: agg._max.createdAt?.getTime() ?? 0,
    count: agg._count._all,
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
