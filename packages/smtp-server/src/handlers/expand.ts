import { prisma } from '@coremail/storage';
import { BARE_POSTMASTER } from '../core/types.js';
import { domainVariants, isNonAscii } from '../core/idn.js';

/** True when a domain may have a second IDN spelling (U-label or "xn--" A-label). */
function isIdnDomain(domain: string): boolean {
  return isNonAscii(domain) || /(^|\.)xn--/i.test(domain);
}

/**
 * v8.1 (RFC 6531): maps an address with an internationalized domain onto the
 * spelling of the local domain as configured (A-label "xn--…" or U-label), so
 * mailbox lookups by e-mail match either form. Non-IDN and non-local addresses
 * are returned unchanged (lower-cased domain).
 */
export async function canonicalRecipient(address: string): Promise<string> {
  const at = address.lastIndexOf('@');
  if (at <= 0) return address;
  const domain = address.slice(at + 1).toLowerCase();
  if (!isIdnDomain(domain)) return address;
  const local = await prisma.domain.findFirst({
    where: { name: { in: domainVariants(domain) }, active: true },
    select: { name: true },
  });
  return local ? `${address.slice(0, at)}@${local.name.toLowerCase()}` : address;
}

/** True when the address belongs to an active local domain (either IDN spelling). */
export async function isLocalDomainAddress(address: string): Promise<boolean> {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;
  const domain = address.slice(at + 1).toLowerCase();
  const found = await prisma.domain.findFirst({
    where: { name: { in: domainVariants(domain) }, active: true },
    select: { id: true },
  });
  return !!found;
}

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
 *  3. Regular recipients (User/SharedMailbox) → unchanged
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
  return (await expandRecipientsWithOrigins(rcptTo)).targets;
}

/**
 * expandRecipients plus the reverse mapping: for every delivery target the
 * recipient address(es) as the client gave them (DSNs and NDRs report the
 * original recipient, RFC 3461 §4.2 ORCPT semantics).
 */
export async function expandRecipientsWithOrigins(
  rcptTo: string[],
): Promise<{ targets: string[]; origins: Map<string, string[]> }> {
  const origins = new Map<string, string[]>();
  for (const email of rcptTo) {
    for (const target of await expandOne(email)) {
      const list = origins.get(target) ?? [];
      if (!list.includes(email)) list.push(email);
      origins.set(target, list);
    }
  }
  return { targets: [...origins.keys()], origins };
}

async function expandOne(email: string): Promise<string[]> {
  const result: string[] = [];
  {
    const normalised = (await canonicalRecipient(email)).toLowerCase();

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
      return result;
    }

    // 2. postmaster without an own mailbox
    if (isPostmasterAddress(normalised)) {
      const admin = await resolvePostmaster(normalised);
      if (admin) {
        result.push(admin);
        return result;
      }
    }

    // 3. Regular recipient (User / SharedMailbox)
    result.push(normalised);
  }
  return result;
}
