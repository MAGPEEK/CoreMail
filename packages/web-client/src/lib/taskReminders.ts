/**
 * Task reminders of the webmail — the pure part (no imports, unit-tested with
 * `node --test`); hooks/useTaskReminders.ts runs it every 30 s.
 *
 * 9.4: only the tab that leads the browser's live connection (lib/tabRole.ts)
 * evaluates the reminders. It shows the toast, sends the reminder mail and
 * tells the other tabs (`reminder` message): they show the same toast and
 * remember it, so a later leader does not fire it again. Without
 * BroadcastChannel every tab leads itself (as before 9.4).
 */

export interface ReminderTask {
  id: string;
  subject: string;
  status?: string;
  dueDate?: string | null;
  reminder?: string | null;
  reminderByMail?: boolean;
}

/** One notification: due today, or a reminder time reached. */
export interface ReminderFire {
  kind: 'due' | 'reminder';
  /** Key it is remembered by: "taskId:yyyy-mm-dd" (due) / reminderKey() (reminder). */
  key: string;
  taskId: string;
  subject: string;
  /** Send the reminder mail (reminders with "by email" only). */
  mail: boolean;
}

/** Already notified keys: due (per tab and day) and reminders (persisted). */
export interface ReminderSeen { due: Set<string>; reminders: Set<string> }

/** "taskId:reminderEpochMs" — once per (task, timestamp), however the server serialises the date. */
export function reminderKey(taskId: string, reminderIso: string): string {
  const t = new Date(reminderIso).getTime();
  return `${taskId}:${Number.isNaN(t) ? reminderIso : t}`;
}

/** Local calendar day yyyy-mm-dd. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Notifications due at `now` that `seen` does not hold yet (does not modify `seen`). */
export function dueReminders(tasks: readonly ReminderTask[], now: Date, seen: ReminderSeen): ReminderFire[] {
  const today = localDay(now);
  const out: ReminderFire[] = [];
  for (const task of tasks) {
    if (task.status === 'COMPLETED') continue;
    const dueKey = `${task.id}:${today}`;
    if (task.dueDate && !seen.due.has(dueKey) && localDay(new Date(task.dueDate)) === today) {
      out.push({ kind: 'due', key: dueKey, taskId: task.id, subject: task.subject, mail: false });
    }
    if (task.reminder) {
      const key = reminderKey(task.id, task.reminder);
      const legacyKey = `${task.id}:${task.reminder}`; // pre-v6 format (ISO string)
      if (!seen.reminders.has(key) && !seen.reminders.has(legacyKey) && new Date(task.reminder).getTime() <= now.getTime()) {
        out.push({ kind: 'reminder', key, taskId: task.id, subject: task.subject, mail: !!task.reminderByMail });
      }
    }
  }
  return out;
}

/** Remembers a fired notification; true when it was new. */
export function markSeen(seen: ReminderSeen, fire: Pick<ReminderFire, 'kind' | 'key'>): boolean {
  const set = fire.kind === 'due' ? seen.due : seen.reminders;
  if (set.has(fire.key)) return false;
  set.add(fire.key);
  return true;
}

/** Tab message announcing a fired notification to the other tabs. */
export interface ReminderMessage { t: 'reminder'; kind: 'due' | 'reminder'; key: string; subject: string; [field: string]: unknown }

export function reminderMessage(fire: ReminderFire): ReminderMessage {
  return { t: 'reminder', kind: fire.kind, key: fire.key, subject: fire.subject };
}

/** A `reminder` message from another tab, or null for anything else. */
export function parseReminderMessage(m: unknown): ReminderMessage | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o['t'] !== 'reminder' || (o['kind'] !== 'due' && o['kind'] !== 'reminder')) return null;
  if (typeof o['key'] !== 'string' || !o['key'] || typeof o['subject'] !== 'string') return null;
  return { t: 'reminder', kind: o['kind'], key: o['key'], subject: o['subject'] };
}
