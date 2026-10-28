/**
 * Calendar Access Control (v3.18.14)
 *
 * Central helper for all permission checks on calendars. Takes into account
 * ownership AND CalendarShare entries with READ/WRITE permission.
 *
 * IMPORTANT: ALL calendar routes (REST + CalDAV) must use this helper instead
 * of direct `findFirst({ where: { id, userId } })` checks — otherwise there
 * will be permission bypasses.
 */
import { prisma } from '@coremail/storage';

export type RequiredPerm = 'READ' | 'WRITE';
export type EffectivePerm = 'OWNER' | 'WRITE' | 'READ';

export interface CalendarAccess {
  calendarId: string;
  isOwner: boolean;
  permission: EffectivePerm;
  ownerId: string;
}

export interface AccessibleCalendar {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  sortOrder: number;
  isDefault: boolean;
  shared: boolean;
  ownerId: string;
  ownerDisplayName: string | null;
  ownerEmail: string | null;
  permission: EffectivePerm;
  // v3.18.16: share ID only with `shared: true` — the frontend uses it for
  // PATCH/POST /calendar/mine-shares* (change color, reorder, self-remove)
  shareId?: string;
}

/**
 * Checks whether `userId` has at least the `required` permission on `calendarId`.
 * Returns `null` when there is no access; otherwise the access info.
 *
 * Logic:
 * - Owner → always OWNER (all operations allowed)
 * - Share with WRITE → satisfies READ + WRITE
 * - Share with READ → satisfies READ only (WRITE → null)
 */
export async function canAccessCalendar(
  userId: string,
  calendarId: string,
  required: RequiredPerm,
): Promise<CalendarAccess | null> {
  const cal = await prisma.calendar.findUnique({
    where: { id: calendarId },
    select: { id: true, userId: true },
  });
  if (!cal) return null;

  if (cal.userId === userId) {
    return { calendarId: cal.id, isOwner: true, permission: 'OWNER', ownerId: cal.userId };
  }

  const share = await prisma.calendarShare.findUnique({
    where: { calendarId_granteeId: { calendarId, granteeId: userId } },
    select: { permission: true },
  });
  if (!share) return null;

  if (required === 'WRITE' && share.permission === 'READ') return null;

  return {
    calendarId: cal.id,
    isOwner: false,
    permission: share.permission === 'WRITE' ? 'WRITE' : 'READ',
    ownerId: cal.userId,
  };
}

/**
 * Returns all calendars `userId` has access to: own + shared via share.
 * Lazy provisioning for empty users is NOT done here — the caller takes
 * care of that if needed.
 */
export async function listAccessibleCalendars(userId: string): Promise<AccessibleCalendar[]> {
  const [owned, shares] = await Promise.all([
    prisma.calendar.findMany({
      where: { userId },
      select: {
        id: true, name: true, color: true, icon: true,
        sortOrder: true, isDefault: true, userId: true,
      },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.calendarShare.findMany({
      where: { granteeId: userId },
      select: {
        id: true,
        permission: true,
        localColor: true,
        sortOrder: true,
        calendar: {
          select: {
            id: true, name: true, color: true, icon: true,
            sortOrder: true, isDefault: true, userId: true,
            user: { select: { id: true, displayName: true, email: true } },
          },
        },
      },
      orderBy: { sortOrder: 'asc' },
    }),
  ]);

  const ownedList: AccessibleCalendar[] = owned.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    icon: c.icon,
    sortOrder: c.sortOrder,
    isDefault: c.isDefault,
    shared: false,
    ownerId: c.userId,
    ownerDisplayName: null,
    ownerEmail: null,
    permission: 'OWNER',
  }));

  const sharedList: AccessibleCalendar[] = shares.map((s) => ({
    id: s.calendar.id,
    name: s.calendar.name,
    // v3.18.16 A3: grantee-local color overrides the owner color (if set)
    color: s.localColor ?? s.calendar.color,
    icon: s.calendar.icon,
    // v3.18.16 A8: grantee-local sorting (sortOrder in the CalendarShare record)
    sortOrder: s.sortOrder,
    isDefault: false,
    shared: true,
    ownerId: s.calendar.user.id,
    ownerDisplayName: s.calendar.user.displayName ?? null,
    ownerEmail: s.calendar.user.email ?? null,
    permission: s.permission === 'WRITE' ? 'WRITE' : 'READ',
    shareId: s.id,
  }));

  return [...ownedList, ...sharedList];
}

/**
 * Accepts IDs with a `gal-` prefix (as delivered by the frontend autocomplete)
 * and strips it. Other known prefixes are removed as well.
 */
export function stripGalPrefix(id: string): string {
  return id.replace(/^(gal|ext|grp|user)-/, '');
}

/**
 * v3.18.15 private/confidential events.
 *
 * Masks an event based on permission + classification:
 *   - Owner: unchanged
 *   - PUBLIC: unchanged
 *   - PRIVATE: Subject="Beschäftigt", Description="", Location="", attendees removed
 *   - CONFIDENTIAL: the event must be hidden completely from the caller → helper
 *     returns `null`. The caller filters it out.
 *
 * The owner ALWAYS sees all details. Only grantees (READ/WRITE) see the masking.
 */
export interface MaskableEvent {
  id: string;
  uid: string;
  calendarId: string;
  summary: string;
  description: string;
  location: string;
  dtStart: Date;
  dtEnd: Date;
  allDay: boolean;
  recurring: boolean;
  classification: string;
  // Remaining fields are passed through
  [key: string]: unknown;
}

export function maskEventForViewer<T extends MaskableEvent>(
  event: T,
  isOwner: boolean,
): T | null {
  if (isOwner) return event;
  const cls = (event.classification ?? 'PUBLIC').toUpperCase();
  if (cls === 'CONFIDENTIAL') return null;
  if (cls === 'PRIVATE') {
    return {
      ...event,
      summary: 'Beschäftigt',
      description: '',
      location: '',
      // Also clear attendees/organizer fields if present
      organizer: null,
      attendees: [],
    };
  }
  return event;
}
