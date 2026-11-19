/**
 * 9.5: whose copy of a meeting is being written? Only the organizer's own copy sends
 * invitations / cancellations; an attendee's copy of someone else's meeting changes
 * (or deletes) only itself.
 */
import { prisma } from '@coremail/storage';

export interface MeetingWriter {
  /** The acting user (id + login address). */
  userId: string;
  email: string;
  /** Owner of the calendar the event is stored in (the acting user, or the one who granted WRITE). */
  calendarOwnerId: string;
}

/** Pure: a calendar address as compared here (`mailto:` stripped, trimmed, lower case). */
const calendarAddress = (address: string): string => address.trim().replace(/^mailto:/i, '').toLowerCase();

/**
 * Is the stored event the organizer's own copy of the meeting? True without organizer (an
 * appointment), when the organizer is the acting user, or when it is the owner of the
 * calendar the event lives in (the acting user is that owner or a delegate with WRITE) —
 * own addresses and active aliases count.
 */
export async function isOrganizerCopy(organizer: string | null, writer: MeetingWriter): Promise<boolean> {
  if (!organizer) return true;
  const address = calendarAddress(organizer);
  if (calendarAddress(writer.email) === address) return true;
  if (writer.calendarOwnerId !== writer.userId) {
    const owner = await prisma.user.findUnique({ where: { id: writer.calendarOwnerId }, select: { email: true } });
    if (owner && calendarAddress(owner.email) === address) return true;
  }
  const alias = await prisma.emailAlias.findFirst({
    where: { targetUserId: { in: [...new Set([writer.userId, writer.calendarOwnerId])] }, active: true, address: { equals: address, mode: 'insensitive' } },
    select: { id: true },
  });
  return alias !== null;
}
