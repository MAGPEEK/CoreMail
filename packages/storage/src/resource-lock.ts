/**
 * 9.4: serialise booking writes per resource (room/equipment) calendar.
 *
 * A booking is "read the resource's other bookings, check for a conflict, write
 * the booking". Two of them for the same slot must not both see a free room, so
 * every writer (REST event form, the mail path for invitations) takes this lock
 * first inside its transaction: the `UPDATE … SET bookingSeq = bookingSeq + 1`
 * holds the resource calendar's row lock until commit, and a second writer waits
 * and then sees the first booking.
 */
import type { Prisma } from '@prisma/client';

export type ResourceLockTx = Pick<Prisma.TransactionClient, 'resourceCalendar'>;

/** Take the booking lock of a resource calendar for the rest of the transaction. */
export async function lockResourceCalendar(tx: ResourceLockTx, calendarId: string): Promise<void> {
  await tx.resourceCalendar.update({
    where: { id: calendarId },
    data: { bookingSeq: { increment: 1 } },
    select: { id: true },
  });
}
