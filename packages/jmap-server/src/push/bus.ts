/**
 * Change bus: Redis mailbox:changes (9.4 — every message and folder writer
 * publishes it, see storage message-store / change-scope) → affected JMAP
 * account →
 *  - local listeners (EventSource/WebSocket connections)
 *  - Web Push to verified PushSubscriptions of the authorized users
 *    (9.4: only users with JMAP switched on)
 * StateChange objects are built per account from the current states.
 */
import { EventEmitter } from 'node:events';
import { prisma, isProtocolAllowed } from '@coremail/storage';
import { getRedisClient, CHANNEL_MAILBOX_CHANGES, parseMailboxChange, createLogger } from '@coremail/core';
import { emailState, mailboxState } from '../state.js';
import { SHARED_PREFIX, usersForAccount } from '../accounts.js';
import { sendPushMessage } from './webpush.js';
import type { AccountContext, StateChange } from '../types.js';

const log = createLogger('jmap:bus');
export const changeBus = new EventEmitter();
changeBus.setMaxListeners(10_000);

const mailboxAccountCache = new Map<string, { accountId: string; expires: number }>();

/** JMAP account of a mailbox: the owner's user id, or shared-<SharedMailbox id>. */
export function accountIdOf(mailbox: { userId: string | null; sharedBoxId: string | null }): string | null {
  return mailbox.userId ?? (mailbox.sharedBoxId ? `${SHARED_PREFIX}${mailbox.sharedBoxId}` : null);
}

async function accountForMailbox(mailboxId: string): Promise<string | null> {
  const hit = mailboxAccountCache.get(mailboxId);
  if (hit && hit.expires > Date.now()) return hit.accountId;
  const mbx = await prisma.mailbox.findUnique({ where: { id: mailboxId }, select: { userId: true, sharedBoxId: true } });
  const accountId = mbx ? accountIdOf(mbx) : null;
  if (accountId) mailboxAccountCache.set(mailboxId, { accountId, expires: Date.now() + 300_000 });
  return accountId;
}

const pendingPush = new Map<string, NodeJS.Timeout>();

/** 9.4: only users with JMAP switched on keep receiving pushes (an unreadable switch withholds them). */
export async function jmapPushRecipients(userIds: string[]): Promise<string[]> {
  const allowed = await Promise.all(userIds.map((id) => isProtocolAllowed(id, 'jmap').catch((err: unknown) => {
    log.warn({ err, userId: id }, 'JMAP switch not readable — push withheld');
    return false;
  })));
  return userIds.filter((_, i) => allowed[i]);
}

async function pushToSubscribers(accountId: string, mailboxId: string | null): Promise<void> {
  const users = await jmapPushRecipients(await usersForAccount(accountId));
  if (!users.length) return;
  const subs = await prisma.jmapPushSubscription.findMany({
    where: { userId: { in: users }, verified: true, OR: [{ expires: null }, { expires: { gt: new Date() } }] },
  });
  if (!subs.length) return;
  const change = await buildStateChange([{ accountId, mailboxId }]);
  await Promise.allSettled(subs.map(async (s) => {
    if (s.types.length && !s.types.some((t) => ['Email', 'Thread', 'Mailbox'].includes(t))) return;
    const filtered: StateChange = { '@type': 'StateChange', changed: {} };
    for (const [acc, states] of Object.entries(change.changed)) {
      filtered.changed[acc] = Object.fromEntries(Object.entries(states).filter(([t]) => !s.types.length || s.types.includes(t)));
    }
    try { await sendPushMessage(s, filtered as unknown as Record<string, unknown>); }
    catch (err) { log.warn({ err, id: s.id }, 'Web Push failed'); }
  }));
}

export async function buildStateChange(accounts: Array<{ accountId: string; mailboxId: string | null }>, types?: Set<string>): Promise<StateChange> {
  const changed: Record<string, Record<string, string>> = {};
  for (const a of accounts) {
    let mailboxId = a.mailboxId;
    if (!mailboxId) {
      const mbx = a.accountId.startsWith(SHARED_PREFIX)
        ? await prisma.mailbox.findFirst({ where: { sharedBoxId: a.accountId.slice(SHARED_PREFIX.length) }, select: { id: true } })
        : await prisma.mailbox.findFirst({ where: { userId: a.accountId }, select: { id: true } });
      mailboxId = mbx?.id ?? null;
    }
    if (!mailboxId) continue;
    const [es, ms] = await Promise.all([emailState(mailboxId), mailboxState(mailboxId)]);
    const states: Record<string, string> = { Email: es, Thread: es, Mailbox: ms };
    changed[a.accountId] = types ? Object.fromEntries(Object.entries(states).filter(([t]) => types.has(t))) : states;
  }
  return { '@type': 'StateChange', changed, pushState: Date.now().toString(36) };
}

export function accountsOf(user: Map<string, AccountContext>): Array<{ accountId: string; mailboxId: string | null }> {
  return [...user.values()].map((a) => ({ accountId: a.accountId, mailboxId: a.mailboxId }));
}

let started = false;
export function startChangeBus(): void {
  if (started) return;
  started = true;
  const sub = getRedisClient().duplicate();
  void sub.subscribe(CHANNEL_MAILBOX_CHANGES).catch((err: unknown) => log.error({ err }, 'Change bus subscription failed'));
  sub.on('message', (channel: string, message: string) => {
    if (channel !== CHANNEL_MAILBOX_CHANGES) return;
    void dispatchMailboxChange(message).catch((err: unknown) => log.warn({ err }, 'Mailbox change not dispatched'));
  });
  log.info('Change bus started (mailbox:changes)');
}

/** Routes one mailbox change to the account's listeners and (batched) Web Push. */
export async function dispatchMailboxChange(message: string): Promise<void> {
  const change = parseMailboxChange(message);
  if (!change) { log.warn('Malformed mailbox change ignored'); return; }
  const accountId = await accountForMailbox(change.mailboxId);
  if (!accountId) return;
  changeBus.emit('change', accountId);
  // Web Push batched (max. 1× per second per account)
  if (!pendingPush.has(accountId)) {
    pendingPush.set(accountId, setTimeout(() => {
      pendingPush.delete(accountId);
      void pushToSubscribers(accountId, change.mailboxId).catch((err) => log.warn({ err }, 'pushToSubscribers'));
    }, 1000));
  }
}
