/**
 * The user PIM items are rendered for and written by: own addresses (organizer / attendee
 * matching) and the Settings → Region time zone (all-day events, task dates).
 */
import { prisma } from '@coremail/storage/prisma';
import { isValidTimeZone } from '@coremail/core/calendar';
import type { PimUser } from './types.js';

/** `regional.timeZone` of the roaming preferences (UserSettings.preferences); null when unset / unknown. */
export function preferredTimeZone(preferences: unknown): string | null {
  const regional = (preferences as { regional?: { timeZone?: unknown } } | null)?.regional;
  const tz = typeof regional?.timeZone === 'string' ? regional.timeZone.trim() : '';
  return tz && isValidTimeZone(tz) ? tz : null;
}

export async function loadPimUser(userId: string): Promise<PimUser | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, displayName: true } });
  if (!user) return null;
  const [aliases, settings] = await Promise.all([
    prisma.emailAlias.findMany({ where: { targetUserId: userId, active: true }, select: { address: true } }),
    prisma.userSettings.findUnique({ where: { userId }, select: { preferences: true } }),
  ]);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? '',
    addresses: [user.email, ...aliases.map((a) => a.address)].map((a) => a.toLowerCase()),
    timeZone: preferredTimeZone(settings?.preferences),
  };
}
