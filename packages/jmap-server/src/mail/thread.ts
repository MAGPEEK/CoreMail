/**
 * Thread assignment (RFC 8621 §3). CoreMail does not store threads — we
 * derive them lazily and persist them in Message.threadId:
 *  - inReplyTo points to a known message in the same mailbox → its threadId
 *  - otherwise: own id is the thread root
 */
import { prisma } from '@coremail/storage';

interface ThreadInput { id: string; threadId: string | null; inReplyTo: string | null; folder?: { mailboxId: string } }

export async function ensureThreadId(msg: ThreadInput, mailboxId?: string): Promise<string> {
  if (msg.threadId) return msg.threadId;
  const mbx = mailboxId ?? msg.folder?.mailboxId;
  let threadId = msg.id;
  if (msg.inReplyTo && mbx) {
    const parent = await prisma.message.findFirst({
      where: { messageId: msg.inReplyTo, folder: { mailboxId: mbx }, id: { not: msg.id } },
      select: { id: true, threadId: true, inReplyTo: true },
      orderBy: { createdAt: 'asc' },
    });
    if (parent) threadId = parent.threadId ?? await ensureThreadId({ ...parent, folder: { mailboxId: mbx } });
  }
  await prisma.message.update({ where: { id: msg.id }, data: { threadId } }).catch(() => undefined);
  return threadId;
}

/** Bulk variant: returns Map id → threadId, computes missing ones. */
export async function ensureThreadIds(
  msgs: ThreadInput[],
  mailboxId: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const m of msgs) {
    out.set(m.id, m.threadId ?? await ensureThreadId(m, mailboxId));
  }
  return out;
}
