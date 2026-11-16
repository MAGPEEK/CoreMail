/**
 * One address namespace for user mailboxes, shared mailboxes and aliases: an address
 * may be the primary address of exactly one mailbox OR one alias. Used by the BCP
 * create routes (mailboxes, shared mailboxes, aliases) so a new address can never
 * shadow an existing one (inbound delivery resolves users → shared → aliases).
 */
import { prisma } from '@coremail/storage';

/** null when the address is free, otherwise a readable reason (shown in the BCP). */
export async function addressCollision(
  address: string,
  exclude: { aliasId?: string } = {},
): Promise<string | null> {
  const lower = address.trim().toLowerCase();
  const [user, shared, alias] = await Promise.all([
    prisma.user.findUnique({ where: { email: lower }, select: { id: true } }),
    prisma.sharedMailbox.findUnique({ where: { email: lower }, select: { id: true } }),
    prisma.emailAlias.findUnique({ where: { address: lower }, select: { id: true } }),
  ]);
  if (user) return 'The address is already the primary address of a mailbox';
  if (shared) return 'The address is already the primary address of a shared mailbox';
  if (alias && alias.id !== exclude.aliasId) return 'The address is already in use as an alias';
  return null;
}
