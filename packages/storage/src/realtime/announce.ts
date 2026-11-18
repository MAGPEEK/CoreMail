/**
 * Fire-and-forget announcements for writers (9.4): a failed publish is logged
 * and never fails the write — the clients fall back to their safety refresh.
 * Message changes need none of this (the message store records them); folder
 * list changes use announceFolderListChange (change-scope.ts).
 */
import { createLogger, publishUserEvent, type UserEvent, type UserEventAction } from '@coremail/core';
import { prisma } from '../prisma/index.js';
import { publishCalendarChange } from './audience.js';

const log = createLogger('realtime');

function settle(p: Promise<unknown>, what: string): void {
  p.catch((err: unknown) => log.warn({ err, what }, 'Realtime announcement failed'));
}

/** Announces a user event (tasks, contacts, notes, settings, quota …) to the given users. */
export function announceUserEvent(userIds: string | Iterable<string>, event: UserEvent): void {
  settle(publishUserEvent(userIds, event), event.type);
}

/** Calendar data changed: the owners and grantees of the calendars hear about it. */
export function announceCalendarChange(
  calendarIds: string[],
  opts: { action?: UserEventAction; ids?: string[]; scope?: 'shares'; extraUserIds?: string[] } = {},
): void {
  settle(publishCalendarChange(prisma as never, calendarIds, opts), 'calendar');
}
