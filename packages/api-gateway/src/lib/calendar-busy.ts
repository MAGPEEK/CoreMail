/**
 * Free/busy of one user as the caller may see it (REST free/busy and the
 * scheduling assistant). Access rule (v3.18.17, unchanged): the caller sees their
 * own calendars and calendars the user shared with them — nobody else's. Without
 * access the result is `visible: false` (unknown, not "free").
 * 9.4: "Anzeigen als" — FREE events do not block, TENTATIVE/OOF are reported as such.
 */
import { prisma, GAL_VISIBLE_WHERE } from '@coremail/storage';
import { expandStoredEvent } from '@coremail/core/recurrence';
import { stricterClassification } from '@coremail/core/calendar';
import { busyKindOf, type BusyKind } from '@coremail/core/free-busy';

export interface BusySlot {
  start: Date;
  end: Date;
  kind: BusyKind;
  /** Only when the caller may see details (own or PUBLIC shared events). */
  subject?: string;
}

export interface UserBusy {
  visible: boolean;
  slots: BusySlot[];
}

/**
 * 9.4 review: users the caller may look up for free/busy by address — no directory
 * enumeration beyond the address list: the caller, active users of the caller's
 * domain that are shown in the address list, and users who shared a calendar with
 * the caller. Anyone else is reported as not found.
 */
export async function freeBusyDirectory(
  caller: { userId: string; domainId?: string | undefined },
  emails: readonly string[],
): Promise<Array<{ id: string; email: string; displayName: string | null }>> {
  if (emails.length === 0) return [];
  return prisma.user.findMany({
    where: {
      email: { in: emails.map((e) => e.toLowerCase()) },
      active: true,
      OR: [
        { id: caller.userId },
        ...(caller.domainId ? [{ domainId: caller.domainId, ...GAL_VISIBLE_WHERE }] : []),
        { calendars: { some: { shares: { some: { granteeId: caller.userId } } } } },
      ],
    },
    select: { id: true, email: true, displayName: true },
  });
}

export async function busyForUser(callerId: string, targetUserId: string, start: Date, end: Date): Promise<UserBusy> {
  const self = targetUserId === callerId;
  const calendars = await prisma.calendar.findMany({
    where: { userId: targetUserId, ...(self ? {} : { shares: { some: { granteeId: callerId } } }) },
    select: { id: true },
  });
  if (calendars.length === 0) return { visible: self, slots: [] };

  const events = await prisma.calendarEvent.findMany({
    where: {
      calendarId: { in: calendars.map((c) => c.id) },
      dtStart: { lt: end },
      OR: [{ dtEnd: { gt: start } }, { recurring: true }, { rrule: { not: null } }],
    },
    select: {
      dtStart: true, dtEnd: true, allDay: true, recurring: true, rrule: true, icalData: true,
      summary: true, classification: true, status: true, showAs: true,
    },
  });

  const slots: BusySlot[] = [];
  for (const e of events) {
    for (const inst of expandStoredEvent(e, start, end)) {
      // an override may be stricter than its series (a private occurrence of a public series)
      const cls = stricterClassification(e.classification, inst.override?.classification);
      if (cls === 'CONFIDENTIAL' && !self) continue;
      const detailed = self || cls === 'PUBLIC';
      const kind = busyKindOf(inst.override?.showAs ?? e.showAs, e.status);
      if (!kind) continue;
      slots.push({
        start: inst.dtStart, end: inst.dtEnd, kind,
        ...(detailed ? { subject: inst.override?.summary ?? e.summary } : {}),
      });
    }
  }
  slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { visible: true, slots };
}
