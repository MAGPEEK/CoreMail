import { prisma } from '@coremail/storage';
import { BARE_POSTMASTER } from '../core/types.js';

/** Roles whose (oldest active) member receives mail for postmaster (RFC 5321 §4.5.1). */
const POSTMASTER_ROLES = ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT'] as const;

/** True for `<Postmaster>` and `postmaster@<domain>` (case-insensitive). */
export function isPostmasterAddress(address: string): boolean {
  const lower = address.toLowerCase();
  return lower === BARE_POSTMASTER || lower.startsWith(`${BARE_POSTMASTER}@`);
}

/**
 * Mailbox that receives postmaster mail when no user, shared mailbox or alias
 * with that address exists: the oldest active administrator. Null when the
 * address itself is a mailbox (it is then delivered as is) or no admin exists.
 */
export async function resolvePostmaster(address: string): Promise<string | null> {
  const email = address.toLowerCase();
  if (email !== BARE_POSTMASTER) {
    const [user, shared] = await Promise.all([
      prisma.user.findFirst({ where: { email, active: true }, select: { id: true } }),
      prisma.sharedMailbox.findFirst({ where: { email, active: true }, select: { id: true } }),
    ]);
    if (user || shared) return null;
  }
  const admin = await prisma.user.findFirst({
    where: { active: true, role: { in: [...POSTMASTER_ROLES] } },
    orderBy: { createdAt: 'asc' },
    select: { email: true },
  });
  return admin?.email.toLowerCase() ?? null;
}

/**
 * Resolves recipient addresses:
 *  1. Email aliases (EmailAlias) → target primary address (User or SharedMailbox)
 *  2. postmaster (bare or at a local domain) without an own mailbox → an
 *     administrator (RFC 5321 §4.5.1: postmaster MUST be accepted and delivered)
 *  3. Regular recipients (User/SharedMailbox/ResourceMailbox) → unchanged
 *
 * Resolution is single-level (an alias always targets a mailbox), so there is
 * no cycle to guard against; the same alias given twice resolves both times
 * and the result is deduplicated.
 *
 * **IMPORTANT**: This function is called BEFORE `storeInboundMessage()` so that
 * local recipients are always resolved to a concrete User/SharedMailbox address.
 * Otherwise aliases would be silently dropped.
 */
export async function expandRecipients(rcptTo: string[]): Promise<string[]> {
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
    const targetEmail = alias?.targetUser?.active
      ? alias.targetUser.email
      : alias?.targetShared?.active
        ? alias.targetShared.email
        : null;
    if (targetEmail) {
      result.push(targetEmail.toLowerCase());
      continue;
    }

    // 2. postmaster without an own mailbox
    if (isPostmasterAddress(normalised)) {
      const admin = await resolvePostmaster(normalised);
      if (admin) {
        result.push(admin);
        continue;
      }
    }

    // 3. Regular recipient (User / SharedMailbox / ResourceMailbox)
    result.push(normalised);
  }

  // Deduplicate
  return [...new Set(result)];
}
