/**
 * Sender identity policy for client submission paths (ActiveSync, JMAP, …).
 *
 * Mirrors the rule of SMTP submission (smtp-server/src/submission/handler.ts
 * `checkSenderPermission`): an authenticated user may send as
 *   1. their own primary address,
 *   2. an active alias that points to their own mailbox,
 *   3. a Shared Mailbox (primary address or active alias) on which they hold
 *      SEND_AS or FULL_ACCESS.
 * Anything else is spoofing and must be rejected.
 */
import { prisma } from './prisma/index.js';

/** Lower-case and strip angle brackets/whitespace from an address. */
export function normalizeSenderAddress(address: string): string {
  return address.trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

/** Pure: is `address` one of the allowed sender addresses? */
export function isSenderAddressAllowed(address: string, allowed: Iterable<string>): boolean {
  const wanted = normalizeSenderAddress(address);
  if (!wanted) return false;
  for (const a of allowed) {
    if (normalizeSenderAddress(a) === wanted) return true;
  }
  return false;
}

/**
 * All addresses `userId` may use as From / envelope sender. Empty for
 * unknown or deactivated users.
 */
export async function listAllowedSenderAddresses(userId: string): Promise<string[]> {
  const user = await prisma.user.findFirst({
    where:  { id: userId, active: true },
    select: { email: true },
  });
  if (!user) return [];

  const [ownAliases, perms] = await Promise.all([
    prisma.emailAlias.findMany({
      where:  { targetUserId: userId, active: true },
      select: { address: true },
    }),
    prisma.sharedMailboxPerm.findMany({
      where: {
        userId,
        permission:    { in: ['FULL_ACCESS', 'SEND_AS'] },
        sharedMailbox: { active: true },
      },
      select: {
        sharedMailbox: {
          select: {
            email:   true,
            aliases: { where: { active: true }, select: { address: true } },
          },
        },
      },
    }),
  ]);

  const out = new Set<string>([normalizeSenderAddress(user.email)]);
  for (const a of ownAliases) out.add(normalizeSenderAddress(a.address));
  for (const p of perms) {
    out.add(normalizeSenderAddress(p.sharedMailbox.email));
    for (const a of p.sharedMailbox.aliases) out.add(normalizeSenderAddress(a.address));
  }
  return [...out];
}
