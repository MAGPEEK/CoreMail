/**
 * Calendar class module ([MS-ASCAL]): the user's OWN calendars (no shared calendars over
 * ActiveSync) — the default one as FolderSync type 8, the others as type 13.
 *
 * Writes follow the device-protocol writer of CalDAV: the calendar object is built / patched
 * (pim/calendar-ical.ts), the row columns are derived from it, and owner + grantees hear
 * about it through announceCalendarChange (realtime). Meeting invitations are not sent by the
 * server: an ActiveSync device sends them itself (SendMail with text/calendar), as for
 * MeetingResponse before 16.0.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@coremail/storage/prisma';
import { announceCalendarChange } from '@coremail/storage';
import type { WbxmlElement } from '../wbxml.js';
import { filterCutoff } from '../commands/body.js';
import { parseCalendar, renderCalendar } from './calendar-codec.js';
import { changedEventIcal, columnsOf, newEventIcal, parsedEvent, type CalendarRow } from './calendar-ical.js';
import { PIM_STATUS, versionOf, type PimClassModule, type PimCollection, type WriteResult } from './types.js';

const PREFIX = 'cal:';

const EVENT_SELECT = {
  id: true, calendarId: true, uid: true, icalData: true, summary: true, description: true, location: true,
  dtStart: true, dtEnd: true, allDay: true, rrule: true, organizer: true, attendees: true,
  classification: true, showAs: true, status: true, sequence: true, updatedAt: true,
} as const;

async function findEvent(col: PimCollection, id: string): Promise<CalendarRow | null> {
  return prisma.calendarEvent.findFirst({ where: { id, calendarId: col.key }, select: EVENT_SELECT }) as Promise<CalendarRow | null>;
}

async function saveChange(row: CalendarRow, icalData: string, calendarIds: string[], extra: { calendarId?: string } = {}): Promise<WriteResult> {
  const columns = columnsOf(icalData);
  if (!columns) return { ok: false, status: PIM_STATUS.CONVERSION_ERROR };
  const saved = await prisma.calendarEvent.update({ where: { id: row.id }, data: { ...columns, ...extra }, select: { id: true, updatedAt: true } });
  announceCalendarChange(calendarIds, { action: 'update', ids: [row.id] });
  return { ok: true, serverId: saved.id, version: versionOf(saved.updatedAt) };
}

export const calendarModule: PimClassModule<CalendarRow> = {
  className: 'Calendar',
  idPrefix: PREFIX,
  feature: 'calendar',

  async folders(userId) {
    const calendars = await prisma.calendar.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true },
    });
    return calendars.map((c, i) => ({ serverId: PREFIX + c.id, displayName: c.name, type: i === 0 ? '8' : '13' }));
  },

  async collection(userId, collectionId) {
    if (!collectionId.startsWith(PREFIX)) return null;
    const calendar = await prisma.calendar.findFirst({ where: { id: collectionId.slice(PREFIX.length), userId }, select: { id: true } });
    return calendar ? { id: collectionId, userId, key: calendar.id } : null;
  },

  async states(col, filterType, now) {
    // calendar FilterType ([MS-ASCMD] 2.2.3.68.1): 4 two weeks … 7 six months back; series always
    const cutoff = filterCutoff(filterType, now);
    const rows = await prisma.calendarEvent.findMany({
      where: { calendarId: col.key },
      select: { id: true, updatedAt: true, dtEnd: true, rrule: true, recurring: true },
    });
    return rows.map((r) => ({
      serverId: r.id,
      version: versionOf(r.updatedAt),
      inFilter: !cutoff || r.recurring || r.rrule !== null || r.dtEnd.getTime() >= cutoff.getTime(),
    }));
  },

  async load(col, ids) {
    if (ids.length === 0) return [];
    return prisma.calendarEvent.findMany({ where: { calendarId: col.key, id: { in: ids } }, select: EVENT_SELECT }) as Promise<CalendarRow[]>;
  },

  rowId: (row) => row.id,
  rowVersion: (row) => versionOf(row.updatedAt),
  render: (row, ctx) => renderCalendar({ ...parsedEvent(row), updatedAt: row.updatedAt }, ctx),

  async create(col, data: WbxmlElement, ctx) {
    const input = parseCalendar(data, ctx.user.timeZone);
    // a UID the calendar already has is the same event again: the client's data updates it
    const existing = input.uid
      ? await prisma.calendarEvent.findFirst({ where: { calendarId: col.key, uid: input.uid }, select: EVENT_SELECT }) as CalendarRow | null
      : null;
    if (existing) {
      const merged = await saveChange(existing, changedEventIcal(existing, input, ctx), [col.key]);
      return merged.ok ? { ...merged, normalized: true } : merged;
    }
    const uid = input.uid ?? randomUUID();
    const icalData = newEventIcal(input, ctx, uid);
    const columns = icalData ? columnsOf(icalData) : null;
    if (!columns) return { ok: false, status: PIM_STATUS.CONVERSION_ERROR };
    const saved = await prisma.calendarEvent.create({ data: { calendarId: col.key, uid, ...columns }, select: { id: true, updatedAt: true } });
    announceCalendarChange([col.key], { action: 'create', ids: [saved.id] });
    return { ok: true, serverId: saved.id, version: versionOf(saved.updatedAt) };
  },

  async update(col, serverId, data, ctx) {
    const row = await findEvent(col, serverId);
    if (!row) return { ok: false, status: PIM_STATUS.OBJECT_NOT_FOUND };
    return saveChange(row, changedEventIcal(row, parseCalendar(data, ctx.user.timeZone), ctx), [col.key]);
  },

  async remove(col, serverId) {
    const row = await findEvent(col, serverId);
    if (!row) return false;
    await prisma.calendarEvent.delete({ where: { id: row.id } });
    announceCalendarChange([col.key], { action: 'delete', ids: [row.id] });
    return true;
  },

  async fingerprint(col) {
    const [count, newest] = await Promise.all([
      prisma.calendarEvent.count({ where: { calendarId: col.key } }),
      prisma.calendarEvent.aggregate({ where: { calendarId: col.key }, _max: { updatedAt: true } }),
    ]);
    return `${count}:${newest._max.updatedAt?.getTime() ?? 0}`;
  },

  async move(src, dst, serverId) {
    const row = await findEvent(src, serverId);
    if (!row) return { ok: false, status: PIM_STATUS.OBJECT_NOT_FOUND };
    // a UID is unique per calendar: the destination must not have this event already
    const clash = await prisma.calendarEvent.findFirst({ where: { calendarId: dst.key, uid: row.uid }, select: { id: true } });
    if (clash) return { ok: false, status: PIM_STATUS.OBJECT_NOT_FOUND };
    return saveChange(row, row.icalData, [src.key, dst.key], { calendarId: dst.key });
  },
};
