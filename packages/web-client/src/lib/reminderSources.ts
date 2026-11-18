/**
 * 9.4: reminder sources besides tasks — flagged mails with a reminder time and
 * calendar events with a reminder ("Erinnerung", optionally "per E-Mail"). They
 * are mapped onto the task reminder items of lib/taskReminders.ts, so the same
 * engine (leading tab, once per timestamp, reminder mail) fires them.
 * Pure — unit-tested with `node --test`.
 */
import type { ReminderTask } from './taskReminders.ts';

export interface FlagReminderSource {
  id: string;
  subject: string;
  flagStatus: string;
  flagReminderAt: string | null;
}

export interface EventReminderSource {
  id: string;
  instanceId?: string;
  summary: string;
  dtStart: string;
  reminder?: { minutes: number; byMail: boolean } | null;
}

/** Flagged mails whose reminder is set (completed flags remind no more). */
export function flagReminderItems(mails: readonly FlagReminderSource[]): ReminderTask[] {
  return mails
    .filter((m) => m.flagStatus === 'flagged' && m.flagReminderAt)
    .map((m) => ({ id: `mail:${m.id}`, subject: m.subject || '(Kein Betreff)', reminder: m.flagReminderAt, reminderByMail: false }));
}

/**
 * Event occurrences whose reminder time (start − minutes) lies within the last
 * `graceMs` (missed while the webmail was closed) or later. Each occurrence is
 * its own item ("<instanceId>"), so a series reminds once per occurrence.
 */
export function eventReminderItems(events: readonly EventReminderSource[], now: Date, graceMs = 60 * 60_000): ReminderTask[] {
  const out: ReminderTask[] = [];
  for (const ev of events) {
    if (!ev.reminder) continue;
    const at = new Date(ev.dtStart).getTime() - ev.reminder.minutes * 60_000;
    if (isNaN(at) || at < now.getTime() - graceMs) continue;
    out.push({
      id: `event:${ev.instanceId ?? ev.id}`, subject: ev.summary,
      reminder: new Date(at).toISOString(), reminderByMail: ev.reminder.byMail,
    });
  }
  return out;
}
