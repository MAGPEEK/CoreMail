/**
 * Thread/* (RFC 8621 §3). Threads are derived (Message.threadId, see mail/thread.ts).
 * Rows delivered by other writers without a threadId are derived first, so
 * membership and the state string always agree (RFC 8620 §1.6.2).
 */
import { prisma } from '@coremail/storage';
import { registerMethod } from '../dispatcher.js';
import { CAP_MAIL } from '../capabilities.js';
import { cannotCalculateChanges, requestTooLarge } from '../errors.js';
import { decodeEmailState, emailState, emailStateParts, encodeEmailState, type EmailStateParts } from '../state.js';
import { deriveMissingThreads } from '../mail/thread.js';
import { parseGetArgs } from './common.js';
import { changedMessageIds, existedAt, parseMaxChanges, windowFloor, type WindowRow } from './email-changes.js';
import type { JsonObject } from '../types.js';

registerMethod('Thread/get', CAP_MAIL, async (args, ctx) => {
  const { account, ids } = parseGetArgs(args, ctx);
  if (!ids) throw requestTooLarge(); // Thread/get without ids: all threads would be too large
  await deriveMissingThreads(account.mailboxId);
  const rows = ids.length
    ? await prisma.message.findMany({
      where: {
        folder: { mailboxId: account.mailboxId }, deletedAt: null,
        OR: [{ threadId: { in: ids } }, { threadId: null, id: { in: ids } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, threadId: true },
    })
    : [];
  const byThread = new Map<string, string[]>();
  for (const r of rows) {
    const t = r.threadId ?? r.id;
    byThread.set(t, [...(byThread.get(t) ?? []), r.id]);
  }
  const list: JsonObject[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const emailIds = byThread.get(id);
    if (emailIds) list.push({ id, emailIds }); else notFound.push(id);
  }
  return { accountId: account.accountId, state: await emailState(account.mailboxId), list, notFound };
});

interface MemberRow extends WindowRow { threadId: string | null }

/** Thread-level classification from the member rows (RFC 8620 §5.2). */
export function classifyThreads(
  threadIds: Iterable<string>, members: MemberRow[], old: EmailStateParts,
): { created: string[]; updated: string[]; destroyed: string[] } {
  const floor = windowFloor(old);
  const out = { created: [] as string[], updated: [] as string[], destroyed: [] as string[] };
  for (const t of threadIds) {
    const ms = members.filter((m) => (m.threadId ?? m.id) === t);
    // a member counts for the old state if it existed then and was not already expunged
    const existed = ms.some((m) => existedAt(m, old) && (!m.deletedAt || m.modSeq > floor));
    const exists = ms.some((m) => !m.deletedAt);
    if (existed && exists) out.updated.push(t);
    else if (exists) out.created.push(t);
    else if (existed) out.destroyed.push(t);
  }
  return out;
}

registerMethod('Thread/changes', CAP_MAIL, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const old = decodeEmailState(args['sinceState']);
  if (!old) throw cannotCalculateChanges();
  const max = parseMaxChanges(args['maxChanges']);
  await deriveMissingThreads(account.mailboxId);
  const parts = await emailStateParts(account.mailboxId);
  const ch = await changedMessageIds(account, old, parts, max);
  const changedIds = [...ch.created, ...ch.updated, ...ch.destroyed];
  const changed = changedIds.length
    ? await prisma.message.findMany({ where: { id: { in: changedIds } }, select: { id: true, threadId: true } })
    : [];
  const threadIds = [...new Set(changed.map((m) => m.threadId ?? m.id))];
  const members: MemberRow[] = threadIds.length
    ? await prisma.message.findMany({
      where: { folder: { mailboxId: account.mailboxId }, OR: [{ threadId: { in: threadIds } }, { threadId: null, id: { in: threadIds } }] },
      select: { id: true, threadId: true, modSeq: true, createdAt: true, createdModSeq: true, deletedAt: true },
    })
    : [];
  const t = classifyThreads(threadIds, members, old);
  return {
    accountId: account.accountId,
    oldState: String(args['sinceState']),
    newState: encodeEmailState(ch.newState),
    hasMoreChanges: ch.hasMoreChanges,
    created: t.created,
    updated: t.updated,
    destroyed: t.destroyed,
  };
});
