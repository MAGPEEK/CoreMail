/**
 * 9.4: "Gekennzeichnete Elemente und Aufgaben" — tasks and flagged mails in one
 * list (filters Aktiv / Überfällig / Abgeschlossen, sorted by due date), plus the
 * work-hours fields of the task form. Pure — unit-tested with `node --test`.
 */
import { isOverdue } from './followUp.ts';
import { instantToWallClock } from './zonedTime.ts';

/** Task dates are calendar days (stored as UTC midnight): overdue when the day is before today in the zone. */
function taskOverdue(dueDate: string | null, now: Date, tz: string): boolean {
  return !!dueDate && dueDate.slice(0, 10) < instantToWallClock(now.toISOString(), tz).date;
}

export type ItemFilter = 'active' | 'overdue' | 'completed';

export interface TaskLike {
  id: string;
  subject: string;
  status: string;
  dueDate: string | null;
  startDate?: string | null;
  priority?: string;
  percentComplete?: number;
}

export interface FlaggedMailLike {
  id: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  folderName: string;
  flagStatus: string;
  flagDueAt: string | null;
  flagStartAt: string | null;
}

export interface CombinedItem {
  kind: 'task' | 'mail';
  id: string;
  subject: string;
  dueAt: string | null;
  startAt: string | null;
  completed: boolean;
  overdue: boolean;
  /** Mail: sender and folder; task: priority. */
  detail: string;
  priority: string;
  percentComplete: number;
}

function fromTask(t: TaskLike, now: Date, tz: string): CombinedItem {
  const completed = t.status === 'COMPLETED';
  return {
    kind: 'task', id: t.id, subject: t.subject, dueAt: t.dueDate, startAt: t.startDate ?? null, completed,
    overdue: !completed && taskOverdue(t.dueDate, now, tz), detail: '', priority: t.priority ?? 'NORMAL',
    percentComplete: t.percentComplete ?? (completed ? 100 : 0),
  };
}

function fromMail(m: FlaggedMailLike, now: Date, tz: string): CombinedItem {
  const completed = m.flagStatus === 'complete';
  return {
    kind: 'mail', id: m.id, subject: m.subject || '(Kein Betreff)', dueAt: m.flagDueAt, startAt: m.flagStartAt, completed,
    overdue: !completed && isOverdue(m.flagDueAt, now, tz),
    detail: `${m.fromName || m.fromAddr} · ${m.folderName}`, priority: 'NORMAL', percentComplete: completed ? 100 : 0,
  };
}

const FILTERS: Record<ItemFilter, (i: CombinedItem) => boolean> = {
  active: (i) => !i.completed,
  overdue: (i) => i.overdue,
  completed: (i) => i.completed,
};

/** Tasks + flagged mails for a filter, due date ascending (no due date last), then subject. */
export function combineItems(
  tasks: readonly TaskLike[],
  mails: readonly FlaggedMailLike[],
  filter: ItemFilter,
  now: Date,
  timeZone: string,
): CombinedItem[] {
  const all = [...tasks.map((t) => fromTask(t, now, timeZone)), ...mails.map((m) => fromMail(m, now, timeZone))];
  return all.filter(FILTERS[filter]).sort((a, b) => {
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    }
    return a.subject.localeCompare(b.subject, 'de');
  });
}

/** Minutes → hours text of the form ("1,5"); '' for none. */
export function formatWorkHours(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '';
  const hours = Math.round((minutes / 60) * 100) / 100;
  return String(hours).replace('.', ',');
}

/** Hours text ("1,5", "2.25", "3") → minutes; null for empty, undefined for invalid input. */
export function parseWorkHours(text: string): number | null | undefined {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  return Math.round(Number(t) * 60);
}
