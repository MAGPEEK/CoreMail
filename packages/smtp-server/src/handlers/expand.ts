import { prisma } from '@coremail/storage';

/**
 * Resolves recipient addresses:
 *  1. Email aliases (EmailAlias) → target primary address (User or SharedMailbox)
 *  2. Regular recipients (User/SharedMailbox/ResourceMailbox) → unchanged
 *
 * v5.6.1: DistributionGroup expansion removed (feature completely dropped).
 * Cycle protection via the `visited` set prevents endless loops on cyclic
 * aliases.
 *
 * **IMPORTANT**: This function is called BEFORE `storeInboundMessage()` so that
 * local recipients are always resolved to a concrete User/SharedMailbox address.
 * Otherwise aliases would be silently dropped.
 */
export async function expandRecipients(
  rcptTo: string[],
  visited = new Set<string>(),
): Promise<string[]> {
  const result: string[] = [];

  for (const email of rcptTo) {
    const normalised = email.toLowerCase();

    // 1. Email alias? → replace with target primary address
    const alias = await prisma.emailAlias.findFirst({
      where: { address: normalised, active: true },
      include: {
        targetUser:   { select: { email: true, active: true } },
        targetShared: { select: { email: true, active: true } },
      },
    });
    if (alias) {
      const targetEmail = alias.targetUser?.active
        ? alias.targetUser.email
        : alias.targetShared?.active
          ? alias.targetShared.email
          : null;
      if (targetEmail && !visited.has(normalised)) {
        visited.add(normalised);
        result.push(targetEmail.toLowerCase());
        continue;
      }
    }

    // 2. Regular recipient (User / SharedMailbox / ResourceMailbox)
    result.push(normalised);
  }

  // Deduplicate
  return [...new Set(result)];
}
