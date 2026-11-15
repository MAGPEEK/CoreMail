/**
 * Thread assignment (RFC 8621 §3). CoreMail does not store threads — the
 * thread id is kept in Message.threadId:
 *  - inReplyTo points to a known message in the same mailbox → its thread
 *  - otherwise the nearest known ancestor of its References chain
 *    (`Message.references`, v9.1; the parent chain when the direct parent is
 *    not in the mailbox) → its thread
 *  - otherwise an earlier-arrived reply to this message (inReplyTo = our
 *    Message-ID) that already has a thread → that thread (parent after child)
 *  - otherwise: own id is the thread root
 *
 * JMAP-created messages get their thread inside the creating transaction.
 * Other writers (SMTP, IMAP APPEND, ActiveSync) leave threadId null; those rows
 * are derived by {@link deriveMissingThreads} before any thread-dependent read.
 * Persisting goes through the message store (touchMessages), i.e. with a fresh
 * modSeq — a membership change is a data change and must change the state
 * (RFC 8620 §1.6.2). threadId is immutable once set (RFC 8621 §4.1.1).
 */
import { prisma, touchMessages, splitReferences, type MessageStoreTx } from '@coremail/storage';

type Db = Pick<MessageStoreTx, 'message'>;

interface Node {
  id: string;
  messageId: string | null;
  inReplyTo: string | null;
  /** References msg-ids, oldest first: a list or the stored column ("<a> <b>"); null = unknown. */
  references?: readonly string[] | string | null;
}

const PARENT_SELECT = { id: true, threadId: true, messageId: true, inReplyTo: true, references: true } as const;

function referenceList(refs: Node['references']): string[] {
  if (!refs) return [];
  return typeof refs === 'string' ? splitReferences(refs) : [...refs];
}

/** Max. rows derived per call (legacy mailboxes are worked off in batches). */
export const THREAD_DERIVE_BATCH = 1000;
const MAX_DEPTH = 50;

/** Thread id for a message that has none yet (pure lookup, no write). */
export async function resolveThreadId(
  msg: Node,
  mailboxId: string,
  db: Db = prisma,
  assigned: Map<string, string> = new Map(),
  depth = 0,
): Promise<string | null> {
  if (msg.inReplyTo && depth < MAX_DEPTH) {
    const parent = await db.message.findFirst({
      where: { messageId: msg.inReplyTo, folder: { mailboxId }, id: { not: msg.id } },
      select: PARENT_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    if (parent) return threadOfAncestor(parent, mailboxId, db, assigned, depth);
  }
  // The direct parent is not here: the nearest ancestor of the References chain
  // that is (one query for the whole chain).
  const ancestors = referenceList(msg.references).filter((r) => r !== msg.messageId && r !== msg.inReplyTo);
  if (ancestors.length > 0 && depth < MAX_DEPTH) {
    const found = await db.message.findMany({
      where: { messageId: { in: ancestors }, folder: { mailboxId }, id: { not: msg.id } },
      select: PARENT_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    let best: (typeof found)[number] | null = null;
    let bestPos = -1;
    for (const row of found) {
      const pos = row.messageId ? ancestors.lastIndexOf(row.messageId) : -1;
      if (pos > bestPos) { best = row; bestPos = pos; } // first-arrived row wins a tie (asc order)
    }
    if (best) return threadOfAncestor(best, mailboxId, db, assigned, depth);
  }
  if (msg.messageId) {
    const child = await db.message.findFirst({
      where: { inReplyTo: msg.messageId, folder: { mailboxId }, id: { not: msg.id }, threadId: { not: null } },
      select: { threadId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (child?.threadId) return child.threadId;
  }
  return null; // root: the caller uses the message's own id
}

async function threadOfAncestor(
  parent: Node & { threadId: string | null },
  mailboxId: string,
  db: Db,
  assigned: Map<string, string>,
  depth: number,
): Promise<string> {
  const known = parent.threadId ?? assigned.get(parent.id);
  if (known) return known;
  const t = (await resolveThreadId(parent, mailboxId, db, assigned, depth + 1)) ?? parent.id;
  assigned.set(parent.id, t);
  return t;
}

/**
 * Assign and persist thread ids for messages that have none (all pending rows of
 * the mailbox, newest first, or only `ids`). Returns id → threadId for the rows it
 * assigned. Parents that are pending themselves are assigned on the way.
 */
export async function deriveMissingThreads(
  mailboxId: string,
  opts: { ids?: string[]; limit?: number } = {},
): Promise<Map<string, string>> {
  const pending = await prisma.message.findMany({
    where: {
      folder: { mailboxId }, deletedAt: null, threadId: null,
      ...(opts.ids ? { id: { in: opts.ids } } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: opts.limit ?? THREAD_DERIVE_BATCH,
    select: { id: true, messageId: true, inReplyTo: true, references: true },
  });
  const assigned = new Map<string, string>();
  if (!pending.length) return assigned;
  // Parents first: a root must not adopt a child's thread that is itself only being derived now.
  for (const m of [...pending].reverse()) {
    if (assigned.has(m.id)) continue;
    assigned.set(m.id, (await resolveThreadId(m, mailboxId, prisma, assigned)) ?? m.id);
  }
  const byThread = new Map<string, string[]>();
  for (const [id, t] of assigned) byThread.set(t, [...(byThread.get(t) ?? []), id]);
  await prisma.$transaction(async (tx) => {
    for (const [threadId, ids] of byThread) await touchMessages(tx, ids, { threadId }, { mailboxId });
  });
  return assigned;
}
