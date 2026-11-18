/**
 * Address lookups for Search (Store=GAL) and ResolveRecipients.
 *
 * Scope: the global address list of a caller is the active users and Shared
 * Mailboxes of the caller's own domain — never other domains of the server —
 * without the mailboxes hidden from the address list (9.4 MailFlowPolicy).
 * Contacts are the caller's own personal contacts.
 */
import { prisma } from '@coremail/storage/prisma';
import { GAL_VISIBLE_WHERE } from '@coremail/storage';

export interface DirectoryEntry {
  kind: 'user' | 'shared' | 'contact';
  displayName: string;
  email: string;
  company?: string;
  title?: string;
  phone?: string;
  mobilePhone?: string;
}

/** Hard cap on lookups — Search returns at most 100 rows per range anyway. */
const MAX_ROWS = 500;

async function callerDomain(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { domainId: true } });
  return u?.domainId ?? null;
}

/** GAL entries of the caller's domain matching `query` (display name or address, case-insensitive). */
export async function searchGal(userId: string, query: string): Promise<DirectoryEntry[]> {
  const q = query.trim();
  if (!q) return [];
  const domainId = await callerDomain(userId);
  if (!domainId) return [];
  const match = { OR: [
    { displayName: { contains: q, mode: 'insensitive' as const } },
    { email: { contains: q, mode: 'insensitive' as const } },
  ] };
  const [users, shared] = await Promise.all([
    prisma.user.findMany({
      where: { domainId, active: true, ...GAL_VISIBLE_WHERE, ...match },
      select: { displayName: true, email: true, domainId: true },
      orderBy: { displayName: 'asc' },
      take: MAX_ROWS,
    }),
    prisma.sharedMailbox.findMany({
      where: { domainId, active: true, ...GAL_VISIBLE_WHERE, ...match },
      select: { displayName: true, email: true, domainId: true },
      orderBy: { displayName: 'asc' },
      take: MAX_ROWS,
    }),
  ]);
  // Defence in depth: the domain filter is the security boundary.
  const entries: DirectoryEntry[] = [
    ...users.filter((u) => u.domainId === domainId).map((u) => ({ kind: 'user' as const, displayName: u.displayName || u.email, email: u.email.toLowerCase() })),
    ...shared.filter((s) => s.domainId === domainId).map((s) => ({ kind: 'shared' as const, displayName: s.displayName || s.email, email: s.email.toLowerCase() })),
  ];
  return entries.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.email.localeCompare(b.email));
}

/** Personal contacts of the caller matching `query` (one entry per address). */
export async function searchContacts(userId: string, query: string): Promise<DirectoryEntry[]> {
  const q = query.trim();
  if (!q) return [];
  const rows = await prisma.contact.findMany({
    where: { userId, OR: [
      { displayName: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { email2: { contains: q, mode: 'insensitive' } },
    ] },
    select: { userId: true, displayName: true, email: true, email2: true, company: true, jobTitle: true, phone: true, mobile: true },
    orderBy: { displayName: 'asc' },
    take: MAX_ROWS,
  });
  const out: DirectoryEntry[] = [];
  const ql = q.toLowerCase();
  for (const c of rows.filter((r) => r.userId === userId)) {
    const addrs = [c.email, c.email2].filter((a) => a && a.includes('@'));
    // name match → all addresses; address match → only the matching ones
    const nameHit = c.displayName.toLowerCase().includes(ql);
    for (const a of addrs) {
      if (!nameHit && !a.toLowerCase().includes(ql)) continue;
      out.push({
        kind: 'contact', displayName: c.displayName || a, email: a.toLowerCase(),
        ...(c.company ? { company: c.company } : {}), ...(c.jobTitle ? { title: c.jobTitle } : {}),
        ...(c.phone ? { phone: c.phone } : {}), ...(c.mobile ? { mobilePhone: c.mobile } : {}),
      });
    }
  }
  return out;
}

/** Pure: "a-b" (inclusive) → [start, end]; max `limit` rows. Null for a malformed range. */
export function parseRange(range: string, limit = 100): [number, number] | null {
  if (!range) return [0, limit - 1];
  const m = /^(\d+)-(\d+)$/.exec(range.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end < start) return null;
  return [start, Math.min(end, start + limit - 1)];
}
