/**
 * Thread/* (RFC 8621 §3). Threads sind abgeleitet (Message.threadId).
 */
import { prisma } from '@coremail/storage';
import { registerMethod } from '../dispatcher.js';
import { CAP_MAIL } from '../capabilities.js';
import { cannotCalculateChanges, requestTooLarge } from '../errors.js';
import { decodeEmailState, emailState, emailStateParts, encodeEmailState } from '../state.js';
import { parseGetArgs } from './common.js';
import { changedMessageIds } from './email-changes.js';
import type { JsonObject } from '../types.js';

registerMethod('Thread/get', CAP_MAIL, async (args, ctx) => {
  const { account, ids } = parseGetArgs(args, ctx);
  if (!ids) throw requestTooLarge(); // Thread/get ohne ids: alle Threads wären zu groß
  const list: JsonObject[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const msgs = await prisma.message.findMany({
      where: {
        folder: { mailboxId: account.mailboxId }, deletedAt: null,
        OR: [{ threadId: id }, { threadId: null, id }],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!msgs.length) { notFound.push(id); continue; }
    list.push({ id, emailIds: msgs.map((m) => m.id) });
  }
  return { accountId: account.accountId, state: await emailState(account.mailboxId), list, notFound };
});

registerMethod('Thread/changes', CAP_MAIL, async (args, ctx) => {
  const account = ctx.account(args['accountId']);
  const old = decodeEmailState(args['sinceState']);
  if (!old) throw cannotCalculateChanges();
  const parts = await emailStateParts(account.mailboxId);
  const changes = await changedMessageIds(account, old, parts);
  const threadIds = new Set<string>();
  for (const id of [...changes.created, ...changes.updated]) {
    const m = await prisma.message.findUnique({ where: { id }, select: { threadId: true } });
    threadIds.add(m?.threadId ?? id);
  }
  return {
    accountId: account.accountId,
    oldState: encodeEmailState(old),
    newState: encodeEmailState(parts),
    hasMoreChanges: false,
    created: [],
    updated: [...threadIds],
    destroyed: [],
  };
});
