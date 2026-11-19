/**
 * Who may see whose profile photo (9.5), and the batched address → photo
 * lookup of the webmail.
 *
 * Visibility: the organisation boundary is the caller's domain — the same
 * boundary as the address list (GET /contacts/gal). A user sees the photos of
 * the active users of that domain that are listed in the address list
 * (GAL_VISIBLE_WHERE), and always the own photo. Everything else is "not
 * found", so the answer never reveals that an account or a photo exists.
 *
 * The lookup resolves primary addresses and aliases in one query (no query per
 * message row); only accounts that have a photo are returned.
 */
import { prisma, GAL_VISIBLE_WHERE, profilePhotoVersion } from '@coremail/storage';

/** Largest number of addresses per lookup request. */
export const MAX_LOOKUP_ADDRESSES = 100;

const ADDRESS_RE = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

/**
 * The addresses of a lookup body (pure): trimmed, lower case, unique, at most
 * MAX_LOOKUP_ADDRESSES. null when the input is not a list of strings or too long.
 */
export function lookupAddresses(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_LOOKUP_ADDRESSES) return null;
  if (!raw.every((a) => typeof a === 'string')) return null;
  const out = new Set<string>();
  for (const a of raw) {
    const v = a.trim().toLowerCase();
    if (ADDRESS_RE.test(v)) out.add(v);
  }
  return [...out];
}

export interface PhotoCaller { userId: string; domainId?: string | undefined }

/** The caller's domain (from the token, or the database for older tokens). */
async function domainOf(caller: PhotoCaller): Promise<string | null> {
  if (caller.domainId) return caller.domainId;
  const row = await prisma.user.findUnique({ where: { id: caller.userId }, select: { domainId: true } });
  return row?.domainId ?? null;
}

/** Prisma filter: users whose photo the caller may see (pure). */
export function visiblePhotoOwners(callerId: string, domainId: string): Record<string, unknown> {
  return {
    domainId,
    active: true,
    photoKey: { not: null },
    OR: [{ id: callerId }, GAL_VISIBLE_WHERE],
  };
}

/** Photo key of `targetId` if the caller may see it, else null. */
export async function visiblePhotoKey(caller: PhotoCaller, targetId: string): Promise<string | null> {
  const domainId = await domainOf(caller);
  if (!domainId) return null;
  const row = await prisma.user.findFirst({
    where: { id: targetId, ...visiblePhotoOwners(caller.userId, domainId) },
    select: { photoKey: true },
  });
  return row?.photoKey ?? null;
}

export interface PhotoEntry { userId: string; version: string }

/** Address → photo of the users the caller may see (addresses without a photo are left out). */
export async function lookupPhotos(caller: PhotoCaller, addresses: readonly string[]): Promise<Record<string, PhotoEntry>> {
  if (addresses.length === 0) return {};
  const domainId = await domainOf(caller);
  if (!domainId) return {};
  const rows = await prisma.user.findMany({
    where: {
      AND: [
        visiblePhotoOwners(caller.userId, domainId),
        { OR: [{ email: { in: [...addresses], mode: 'insensitive' } }, { aliases: { some: { address: { in: [...addresses], mode: 'insensitive' } } } }] },
      ],
    },
    select: { id: true, email: true, photoKey: true, aliases: { select: { address: true } } },
    take: MAX_LOOKUP_ADDRESSES,
  });
  const wanted = new Set(addresses);
  const out: Record<string, PhotoEntry> = {};
  for (const row of rows) {
    const version = profilePhotoVersion(row.photoKey);
    if (!version) continue;
    for (const address of [row.email, ...row.aliases.map((a) => a.address)]) {
      const key = address.toLowerCase();
      if (wanted.has(key)) out[key] = { userId: row.id, version };
    }
  }
  return out;
}
