import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, CheckCircle2, Circle, Flag, Calendar, Trash2, Bell, Mail, Lock, Repeat,
} from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../api/client.js';
import type { FlaggedMail, Task } from '../api/types.js';
import toast from 'react-hot-toast';
import { PageShell } from '../components/PageShell.js';
import { PAGE_CONTENT_PAD } from '../lib/pageShell.js';
import { TaskForm, TASK_STATUS_LABEL, type TaskPayload } from '../components/tasks/TaskForm.js';
import { combineItems, type CombinedItem, type ItemFilter } from '../lib/taskItems.js';
import { instantToWallClock } from '../lib/zonedTime.js';
import { mailPath } from '../lib/mailLinks.js';
import { OWN_MAILBOX } from '../lib/mailboxContext.js';
import { useRegional } from '../store/preferences.js';

/**
 * Tasks — 9.4: "Gekennzeichnete Elemente und Aufgaben": tasks and mails flagged
 * for follow-up in one list (Aktiv / Überfällig / Abgeschlossen, by due date).
 * Completing a flagged mail completes the flag of that mail; opening it goes to
 * the mail. Tasks open the full task form (double-click or Enter).
 * Reminder popups/mails are handled app-wide by hooks/useTaskReminders.ts.
 */

const PRIORITY_COLOR: Record<string, string> = {
  LOW:    'text-fg-subtle',
  NORMAL: 'text-info-fg',
  HIGH:   'text-danger-fg',
};

const FILTER_LABEL: Record<ItemFilter, string> = { active: 'Aktiv', overdue: 'Überfällig', completed: 'Abgeschlossen' };

/** Adds `minutes` minutes to an ISO instant. */
function addMinutesIso(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export function TasksPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const timeZone = useRegional().timeZone;
  const [filter, setFilter] = useState<ItemFilter>('active');
  const [form, setForm] = useState<{ task: Task | null } | null>(null);

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => api.get<Task[]>('/tasks'),
  });
  const { data: mails = [] } = useQuery({
    queryKey: ['follow-up', 'all'],
    queryFn: () => api.get<FlaggedMail[]>('/mail/follow-up?status=all'),
  });
  const items = useMemo(() => combineItems(tasks, mails, filter, new Date(), timeZone), [tasks, mails, filter, timeZone]);

  // Calendar sync (best effort, as before 9.4): the due date of a new task becomes an
  // all-day event, a changed reminder an event at the reminder time
  const { data: calendars } = useQuery({
    queryKey: ['calendars'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/calendar'),
  });
  const syncCalendar = (events: object[]) => {
    const calendarId = calendars?.[0]?.id;
    if (!calendarId || events.length === 0) return;
    void Promise.allSettled(events.map((ev) => api.post('/calendar/events', { ...ev, calendarId })))
      .then(() => qc.invalidateQueries({ queryKey: ['calendar-events'] }));
  };

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    void qc.invalidateQueries({ queryKey: ['follow-up'] });
  };

  const saveMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string | null; payload: TaskPayload }) =>
      (id ? api.put<Task & { next?: Task }>(`/tasks/${id}`, payload) : api.post<Task>('/tasks', payload)),
    onSuccess: (saved, { id, payload }) => {
      invalidate();
      toast.success(id ? 'Aufgabe gespeichert' : 'Aufgabe erstellt');
      if ('next' in saved && saved.next) toast('Nächste Aufgabe der Serie angelegt', { icon: '🔁' });
      const previous = form?.task?.reminder ?? null;
      syncCalendar([
        ...(!id && payload.dueDate ? [{ summary: payload.subject, dtStart: payload.dueDate.slice(0, 10), dtEnd: payload.dueDate.slice(0, 10), allDay: true }] : []),
        ...(payload.reminder && payload.reminder !== previous
          ? [{ summary: `🔔 Erinnerung: ${payload.subject}`, dtStart: payload.reminder, dtEnd: addMinutesIso(payload.reminder, 30), allDay: false }]
          : []),
      ]);
      setForm(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const completeMutation = useMutation({
    mutationFn: ({ item, completed }: { item: CombinedItem; completed: boolean }) => (item.kind === 'task'
      ? api.put<Task & { next?: Task }>(`/tasks/${item.id}`, { status: completed ? 'COMPLETED' : 'NOT_STARTED' })
      // same object: completing the item completes the flag of the mail
      : api.put('/mail/follow-up', { ids: [item.id], status: completed ? 'complete' : 'flagged' })),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (item: CombinedItem) => (item.kind === 'task'
      ? api.delete(`/tasks/${item.id}`)
      : api.put('/mail/follow-up', { ids: [item.id], status: 'none' })),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });

  const open = (item: CombinedItem) => {
    if (item.kind === 'task') { setForm({ task: tasks.find((t) => t.id === item.id) ?? null }); return; }
    const mail = mails.find((m) => m.id === item.id);
    if (mail) navigate(mailPath(OWN_MAILBOX, mail.folderId, mail.id));
  };

  const dueText = (item: CombinedItem): string => {
    if (!item.dueAt) return '';
    const date = item.kind === 'task' ? item.dueAt.slice(0, 10) : instantToWallClock(item.dueAt, timeZone).date;
    return date.split('-').reverse().join('.');
  };

  return (
    <PageShell
      title="Aufgaben"
      bodyClassName="bg-surface-2"
      actions={
        <div role="group" aria-label="Filter" className="flex gap-1 bg-surface border border-line rounded p-0.5">
          {(Object.keys(FILTER_LABEL) as ItemFilter[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={`text-xs px-3 py-1 rounded transition-colors ${filter === f ? 'bg-accent text-white' : 'text-fg-muted hover:bg-surface-2'}`}>
              {FILTER_LABEL[f]}
            </button>
          ))}
        </div>
      }
    >
      <div className={`w-full max-w-3xl mx-auto ${PAGE_CONTENT_PAD} flex flex-col gap-4 overflow-y-auto`}>
        <button
          type="button"
          onClick={() => setForm({ task: null })}
          className="flex items-center gap-2 w-full px-4 py-2.5 bg-surface border border-line border-dashed rounded-lg text-sm text-fg-subtle hover:text-accent-fg hover:border-accent-fg transition-colors"
        >
          <Plus size={15} />
          Neue Aufgabe…
        </button>

        <section aria-labelledby="flagged-heading" className="bg-surface rounded-lg border border-line">
          <h2 id="flagged-heading" className="px-4 py-2.5 text-sm font-semibold text-fg border-b border-line">
            Gekennzeichnete Elemente und Aufgaben
          </h2>
          <ul className="divide-y divide-line">
            {isLoading && <li className="py-8 text-center text-fg-subtle text-sm">Lade Aufgaben…</li>}
            {!isLoading && items.length === 0 && <li className="py-10 text-center text-fg-subtle text-sm">Keine Elemente</li>}
            {items.map((item) => {
              const task = item.kind === 'task' ? tasks.find((t) => t.id === item.id) : undefined;
              return (
                <li
                  key={`${item.kind}:${item.id}`}
                  className="flex items-center gap-3 px-4 py-3 group hover:bg-surface-2 transition-colors"
                  onDoubleClick={() => open(item)}
                >
                  <button
                    aria-label={item.completed ? 'Als nicht erledigt markieren' : 'Als erledigt markieren'}
                    title={item.completed ? 'Als nicht erledigt markieren' : 'Als erledigt markieren'}
                    onClick={() => completeMutation.mutate({ item, completed: !item.completed })}
                    className="shrink-0"
                  >
                    {item.completed
                      ? <CheckCircle2 size={18} className="text-success-fg" />
                      : <Circle size={18} className="text-fg-subtle hover:text-accent-fg" />}
                  </button>
                  {item.kind === 'mail'
                    ? <Mail size={14} className="text-fg-subtle shrink-0" aria-label="E-Mail" />
                    : <Flag size={14} className={`${PRIORITY_COLOR[item.priority] ?? ''} shrink-0`} aria-label={`Priorität ${item.priority}`} />}
                  <button type="button" onClick={() => open(item)} className="flex-1 min-w-0 text-left">
                    <span className={`block text-sm truncate ${item.completed ? 'line-through text-fg-subtle' : 'text-fg'}`}>{item.subject}</span>
                    <span className="block text-xs text-fg-subtle truncate">
                      {item.kind === 'mail' ? item.detail : TASK_STATUS_LABEL[task?.status ?? 'NOT_STARTED']}
                      {item.kind === 'task' && (task?.percentComplete ?? 0) > 0 && !item.completed ? ` · ${task?.percentComplete} %` : ''}
                    </span>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    {task?.isPrivate && <span title="Privat"><Lock size={12} className="text-fg-subtle" /></span>}
                    {task?.rrule && <span title="Serie"><Repeat size={12} className="text-fg-subtle" /></span>}
                    {item.dueAt && (
                      <span className={`text-xs flex items-center gap-1 ${item.overdue ? 'text-danger-fg font-medium' : 'text-fg-subtle'}`}>
                        <Calendar size={11} />
                        {item.overdue && <span className="sr-only">Überfällig:</span>}
                        {dueText(item)}
                      </span>
                    )}
                    {task?.reminder && (
                      <span title={`Erinnerung: ${format(new Date(task.reminder), 'dd.MM.yy HH:mm')}${task.reminderByMail ? ' · per E-Mail' : ''}`}>
                        <Bell size={11} className="text-warning-fg" />
                      </span>
                    )}
                    <button
                      aria-label={item.kind === 'task' ? 'Aufgabe löschen' : 'Kennzeichnung löschen'}
                      title={item.kind === 'task' ? 'Aufgabe löschen' : 'Kennzeichnung löschen'}
                      onClick={() => {
                        const q = item.kind === 'task' ? `Aufgabe „${item.subject}" löschen?` : `Kennzeichnung von „${item.subject}" löschen?`;
                        if (window.confirm(q)) deleteMutation.mutate(item);
                      }}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-fg-subtle hover:text-danger-fg transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {form && (
        <TaskForm
          task={form.task}
          pending={saveMutation.isPending}
          onClose={() => setForm(null)}
          onSave={(payload) => saveMutation.mutate({ id: form.task?.id ?? null, payload })}
        />
      )}
    </PageShell>
  );
}
