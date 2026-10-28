/**
 * Delta computation for Email/changes and Thread/changes from the state parts.
 * Deleted messages cannot be traced (no tombstones) →
 * cannotCalculateChanges, the client reloads (RFC 8620 §5.2).
 */
import { prisma } from '@coremail/storage';
import { cannotCalculateChanges } from '../errors.js';
import type { EmailStateParts } from '../state.js';
import type { AccountContext } from '../types.js';

export interface Changes { created: string[]; updated: string[] }

const COUNTER_LIMIT = 100_000_000_000n; // modSeq < 1e11 = mailbox counter, otherwise Date.now()

export async function changedMessageIds(account: AccountContext, old: EmailStateParts, now: EmailStateParts): Promise<Changes> {
  if (old.maxModSeq === now.maxModSeq && old.highestModSeq === now.highestModSeq
    && old.maxCreatedMs === now.maxCreatedMs && old.count === now.count) {
    return { created: [], updated: [] };
  }
  const rows = await prisma.message.findMany({
    where: {
      folder: { mailboxId: account.mailboxId }, deletedAt: null,
      OR: [
        { createdAt: { gt: new Date(old.maxCreatedMs) } },
        { modSeq: { gt: old.maxModSeq } },
        { AND: [{ modSeq: { lt: COUNTER_LIMIT } }, { modSeq: { gt: old.highestModSeq } }] },
      ],
    },
    select: { id: true, createdAt: true },
    take: 5000,
  });
  const created = rows.filter((r) => r.createdAt.getTime() > old.maxCreatedMs).map((r) => r.id);
  const createdSet = new Set(created);
  const updated = rows.filter((r) => !createdSet.has(r.id)).map((r) => r.id);
  // Counter check: old count + newly created must equal the current count, otherwise something was deleted
  if (old.count + created.length !== now.count) throw cannotCalculateChanges();
  return { created, updated };
}
