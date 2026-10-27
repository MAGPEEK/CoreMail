/**
 * Account-Auflösung: welche Postfächer sieht der authentifizierte User?
 *  1. eigenes Postfach           → accountId = userId
 *  2. Shared Mailboxes           → accountId = `shared-<id>` (FULL_ACCESS | READ_ONLY | SEND_AS)
 *  3. delegierte Fremdpostfächer → accountId = userId des Besitzers (MailboxDelegate)
 */
import { prisma } from '@coremail/storage';
import type { AccountContext, JmapUser } from './types.js';

export const SHARED_PREFIX = 'shared-';

export async function resolveAccounts(user: JmapUser): Promise<Map<string, AccountContext>> {
  const accounts = new Map<string, AccountContext>();

  const [own, perms, delegations] = await Promise.all([
    prisma.mailbox.findFirst({ where: { userId: user.userId }, select: { id: true } }),
    prisma.sharedMailboxPerm.findMany({
      where: { userId: user.userId, sharedMailbox: { active: true } },
      select: {
        permission: true,
        sharedMailbox: { select: { id: true, email: true, displayName: true, mailbox: { select: { id: true } } } },
      },
    }),
    prisma.mailboxDelegate.findMany({
      where: { granteeId: user.userId },
      select: {
        permission: true,
        mailbox: { select: { id: true, user: { select: { id: true, email: true, displayName: true, active: true } } } },
      },
    }),
  ]);

  if (own) {
    accounts.set(user.userId, {
      accountId: user.userId,
      mailboxId: own.id,
      ownerUserId: user.userId,
      sharedMailboxId: null,
      name: user.displayName || user.email,
      email: user.email,
      readOnly: false,
      isPersonal: true,
      maySend: true,
    });
  }

  // Shared Mailboxes — mehrere Permission-Rows pro Box möglich
  const sharedAgg = new Map<string, { perms: Set<string>; box: (typeof perms)[number]['sharedMailbox'] }>();
  for (const p of perms) {
    const entry = sharedAgg.get(p.sharedMailbox.id) ?? { perms: new Set<string>(), box: p.sharedMailbox };
    entry.perms.add(p.permission);
    sharedAgg.set(p.sharedMailbox.id, entry);
  }
  for (const [id, { perms: ps, box }] of sharedAgg) {
    if (!box.mailbox) continue;
    const full = ps.has('FULL_ACCESS');
    const readOnly = !full && ps.has('READ_ONLY');
    if (!full && !readOnly) continue; // nur SEND_AS/SEND_ON_BEHALF → kein Postfachzugriff
    accounts.set(`${SHARED_PREFIX}${id}`, {
      accountId: `${SHARED_PREFIX}${id}`,
      mailboxId: box.mailbox.id,
      ownerUserId: null,
      sharedMailboxId: id,
      name: box.displayName || box.email,
      email: box.email,
      readOnly,
      isPersonal: false,
      maySend: full || ps.has('SEND_AS'),
    });
  }

  for (const d of delegations) {
    const owner = d.mailbox.user;
    if (!owner?.active || accounts.has(owner.id)) continue;
    accounts.set(owner.id, {
      accountId: owner.id,
      mailboxId: d.mailbox.id,
      ownerUserId: owner.id,
      sharedMailboxId: null,
      name: owner.displayName || owner.email,
      email: owner.email,
      readOnly: d.permission === 'READ_ONLY',
      isPersonal: false,
      maySend: d.permission === 'FULL_ACCESS' || d.permission === 'SEND_AS',
    });
  }

  return accounts;
}

/** accountId → alle User, die über diesen Account benachrichtigt werden sollen. */
export async function usersForAccount(accountId: string): Promise<string[]> {
  if (accountId.startsWith(SHARED_PREFIX)) {
    const perms = await prisma.sharedMailboxPerm.findMany({
      where: { sharedMailboxId: accountId.slice(SHARED_PREFIX.length), permission: { in: ['FULL_ACCESS', 'READ_ONLY'] } },
      select: { userId: true },
    });
    return [...new Set(perms.map((p) => p.userId))];
  }
  const delegates = await prisma.mailboxDelegate.findMany({
    where: { mailbox: { userId: accountId } },
    select: { granteeId: true },
  });
  return [accountId, ...delegates.map((d) => d.granteeId)];
}
