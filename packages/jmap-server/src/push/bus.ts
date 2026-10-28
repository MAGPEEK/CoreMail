/**
 * Change bus: Redis mail:new / mail:update → affected JMAP account →
 *  - local listeners (EventSource/WebSocket connections)
 *  - Web Push to verified PushSubscriptions of the authorized users
 * StateChange objects are built per account from the current states.
 */
import { EventEmitter } from 'node:events';
import { prisma } from '@coremail/storage';
import { getRedisClient, CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE, createLogger } from '@coremail/core';
import { emailState, mailboxState } from '../state.js';
import { SHARED_PREFIX, usersForAccount } from '../accounts.js';
import { sendPushMessage } from './webpush.js';
import type { AccountContext, StateChange } from '../types.js';

const log = createLogger('jmap:bus');
export const changeBus = new EventEmitter();
changeBus.setMaxListeners(10_000);

const folderAccountCache = new Map<string, { accountId: string; expires: number }>();

async function accountForFolder(folderId: string): Promise<string | null> {
  const hit = folderAccountCache.get(folderId);
  if (hit && hit.expires > Date.now()) return hit.accountId;
  const f = await prisma.folder.findUnique({
    where: { id: folderId },
    select: { mailbox: { select: { userId: true, sharedBoxId: true } } },
  });
  const accountId = f?.mailbox.userId ?? (f?.mailbox.sharedBoxId ? `${SHARED_PREFIX}${f.mailbox.sharedBoxId}` : null);
  if (accountId) folderAccountCache.set(folderId, { accountId, expires: Date.now() + 300_000 });
  return accountId;
}

const pendingPush = new Map<string, NodeJS.Timeout>();

async function pushToSubscribers(accountId: string, mailboxId: string | null): Promise<void> {
  const users = await usersForAccount(accountId);
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
  void sub.subscribe(CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE);
  sub.on('message', (_channel: string, message: string) => {
    void (async () => {
      try {
        const p = JSON.parse(message) as { userId?: string; accountId?: string; folderId?: string };
        let accountId = p.accountId ?? null;
        if (!accountId && p.folderId) accountId = await accountForFolder(p.folderId);
        if (!accountId && p.userId) accountId = p.userId;
        if (!accountId) return;
        changeBus.emit('change', accountId);
        // Web Push batched (max. 1× per second per account)
        if (!pendingPush.has(accountId)) {
          pendingPush.set(accountId, setTimeout(() => {
            pendingPush.delete(accountId);
            void pushToSubscribers(accountId!, null).catch((err) => log.warn({ err }, 'pushToSubscribers'));
          }, 1000));
        }
      } catch (err) {
        log.warn({ err }, 'Invalid Redis event');
      }
    })();
  });
  log.info('Change bus started (mail:new, mail:update)');
}
