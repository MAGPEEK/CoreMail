/**
 * Calendar Access Control (v3.18.14)
 *
 * Zentraler Helper für alle Permission-Checks auf Kalendern. Berücksichtigt
 * Owner-Recht UND CalendarShare-Einträge mit READ/WRITE-Permission.
 *
 * WICHTIG: ALLE Calendar-Routen (REST + CalDAV) müssen diesen Helper benutzen
 * statt direkter `findFirst({ where: { id, userId } })`-Checks — sonst gibt es
 * Permission-Bypasses.
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
}

/**
 * Prüft ob `userId` mindestens `required`-Recht auf `calendarId` hat.
 * Liefert `null` wenn kein Zugriff besteht; sonst Access-Info.
 *
 * Logik:
 * - Owner → immer OWNER (alle Operationen erlaubt)
 * - Share mit WRITE → erfüllt READ + WRITE
 * - Share mit READ → erfüllt nur READ (WRITE → null)
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
 * Liefert alle Kalender, auf die `userId` Zugriff hat: eigene + per Share
 * freigegebene. Lazy-Provisioning für leere User wird hier NICHT gemacht —
 * der Aufrufer kümmert sich darum, falls nötig.
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
        permission: true,
        calendar: {
          select: {
            id: true, name: true, color: true, icon: true,
            sortOrder: true, isDefault: true, userId: true,
            user: { select: { id: true, displayName: true, email: true } },
          },
        },
      },
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
    color: s.calendar.color,
    icon: s.calendar.icon,
    sortOrder: 9999, // shared calendars werden ans Ende einsortiert
    isDefault: false,
    shared: true,
    ownerId: s.calendar.user.id,
    ownerDisplayName: s.calendar.user.displayName ?? null,
    ownerEmail: s.calendar.user.email ?? null,
    permission: s.permission === 'WRITE' ? 'WRITE' : 'READ',
  }));

  return [...ownedList, ...sharedList];
}

/**
 * Akzeptiert IDs mit `gal-`-Prefix (Frontend-Autocomplete liefert so) und
 * strippt diesen. Auch andere bekannte Prefixe werden entfernt.
 */
export function stripGalPrefix(id: string): string {
  return id.replace(/^(gal|ext|grp|user)-/, '');
}

/**
 * v3.18.15 Private/Confidential Events.
 *
 * Maskiert ein Event basierend auf Permission + Classification:
 *   - Owner: unverändert
 *   - PUBLIC: unverändert
 *   - PRIVATE: Subject="Beschäftigt", Description="", Location="", attendees gehen weg
 *   - CONFIDENTIAL: Event soll vom Aufrufer komplett ausgeblendet werden → Helper
 *     gibt `null` zurück. Der Aufrufer filtert das raus.
 *
 * Owner sieht IMMER alle Details. Nur Grantees (READ/WRITE) sehen Maskierung.
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
  // Restliche Felder bleiben durchgereicht
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
      // attendees/organizer-Felder auch leeren falls vorhanden
      organizer: null,
      attendees: [],
    };
  }
  return event;
}
