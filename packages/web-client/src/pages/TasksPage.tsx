import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, CheckCircle2, Circle, Flag, Calendar, Trash2,
  ChevronDown, ChevronRight, AlignLeft, Bell, X, Save, Mail,
} from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../api/client.js';
import type { Task } from '../api/types.js';
import toast from 'react-hot-toast';

const PRIORITY_COLOR: Record<string, string> = {
  LOW:    'text-gray-400',
  NORMAL: 'text-blue-500',
  HIGH:   'text-red-500',
};

const PRIORITY_LABEL: Record<string, string> = {
  LOW:    'Niedrig',
  NORMAL: 'Normal',
  HIGH:   'Hoch',
};

// ── localStorage — persist reminders ───────────────────────────────────────────
// Key format: "taskId:reminderISO" → popup fires exactly once per (task, timestamp).
// If the user changes the timestamp, a new key is created → popup fires again. ✓

const REMINDER_STORAGE_KEY = 'coremail:notified-reminders';

function loadNotifiedReminders(): Set<string> {
  try {
    const raw = localStorage.getItem(REMINDER_STORAGE_KEY);
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

function saveNotifiedReminders(set: Set<string>): void {
  try { localStorage.setItem(REMINDER_STORAGE_KEY, JSON.stringify([...set])); }
  catch { /* localStorage quota — ignore */ }
}

function mkReminderKey(taskId: string, reminderIso: string): string {
  return `${taskId}:${reminderIso}`;
}

// ───────────────────────────────────────────────────────────────────────────────

/** Adds `minutes` minutes to a datetime-local string (YYYY-MM-DDTHH:mm). */
function addMinutes(dtLocal: string, minutes: number): string {
  const d = new Date(dtLocal);
  d.setMinutes(d.getMinutes() + minutes);
  // ISO without seconds/timezone so it fits as calendar dtEnd
  return d.toISOString().slice(0, 16);
}

// ── Form types ─────────────────────────────────────────────────────────────────
interface NewTaskForm {
  subject:        string;
  body:           string;
  priority:       'LOW' | 'NORMAL' | 'HIGH';
  dueDate:        string;
  reminder:       string;
  reminderByMail: boolean;
}

interface EditTaskForm {
  subject:        string;
  body:           string;
  priority:       'LOW' | 'NORMAL' | 'HIGH';
  dueDate:        string;
  reminder:       string;
  reminderByMail: boolean;
}

const EMPTY_FORM: NewTaskForm = {
  subject: '', body: '', priority: 'NORMAL', dueDate: '', reminder: '', reminderByMail: false,
};

const EMPTY_EDIT_FORM: EditTaskForm = {
  subject: '', body: '', priority: 'NORMAL', dueDate: '', reminder: '', reminderByMail: false,
};

export function TasksPage() {
  const qc = useQueryClient();
  const [filter, setFilter]       = useState<'all' | 'pending' | 'completed'>('pending');
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [form, setForm]           = useState<NewTaskForm>(EMPTY_FORM);
  const [showForm, setShowForm]   = useState(false);

  // Feature 1 – Edit-Modal
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editForm, setEditForm]       = useState<EditTaskForm>(EMPTY_EDIT_FORM);

  // Feature 3 – due date notifications: already notified IDs
  const notifiedIds         = useRef<Set<string>>(new Set());
  // Reminder popups: load from localStorage → survive page refresh
  const notifiedReminderIds = useRef<Set<string>>(loadNotifiedReminders());

  // Ref so checkDueDates always sees current tasks in the interval (no stale closure)
  const allTasksRef = useRef<Task[] | undefined>(undefined);
  // Ref for user email (for "reminder by mail")
  const userMeRef   = useRef<{ email: string } | undefined>(undefined);

  const statusFilter = filter === 'pending'
    ? ['NOT_STARTED', 'IN_PROGRESS', 'DEFERRED']
    : filter === 'completed' ? ['COMPLETED'] : undefined;

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['tasks', filter],
    queryFn:  () => api.get<Task[]>('/tasks'),
    select:   (all) => statusFilter ? all.filter((t) => statusFilter.includes(t.status)) : all,
  });

  // All tasks (unfiltered) for due date check
  const { data: allTasks } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn:  () => api.get<Task[]>('/tasks'),
  });

  // Feature 2 – calendar sync: determine default calendar
  const { data: calendars } = useQuery({
    queryKey: ['calendars'],
    queryFn:  () => api.get<{ id: string; name: string }[]>('/calendar'),
  });

  // User profile for "reminder by mail" — correct endpoint: /user/profile
  const { data: userMe } = useQuery({
    queryKey: ['user', 'profile'],
    queryFn:  () => api.get<{ email: string }>('/user/profile'),
    staleTime: Infinity,
  });
  useEffect(() => { if (userMe) userMeRef.current = userMe; }, [userMe]);

  // ── Create task ───────────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: Omit<NewTaskForm, 'subject'> & { subject: string }) =>
      api.post('/tasks', {
        subject:        data.subject,
        body:           data.body     || '',
        priority:       data.priority,
        status:         'NOT_STARTED',
        reminderByMail: data.reminderByMail,
        ...(data.dueDate  ? { dueDate:  data.dueDate  } : {}),
        ...(data.reminder ? { reminder: data.reminder } : {}),
      }),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      setForm(EMPTY_FORM);
      setShowForm(false);
      toast.success('Aufgabe erstellt');

      // Immediate feedback when a reminder was set
      if (variables.reminder) {
        const label = variables.reminderByMail ? 'Erinnerung + E-Mail' : 'Erinnerung';
        toast(`🔔 ${label}: ${format(new Date(variables.reminder), 'dd.MM. HH:mm')} Uhr`, { duration: 4000 });
      }

      // Feature 2 – best-effort calendar sync
      const calendarId = calendars?.[0]?.id;
      if (calendarId) {
        const syncs: Promise<unknown>[] = [];

        // Due date → all-day event
        if (variables.dueDate) {
          syncs.push(
            api.post('/calendar/events', {
              summary:    variables.subject,
              dtStart:    `${variables.dueDate}T00:00`,
              dtEnd:      `${variables.dueDate}T01:00`,
              calendarId,
              allDay:     false,
            }),
          );
        }

        // Reminder → calendar event at the exact time (30 min duration)
        if (variables.reminder) {
          syncs.push(
            api.post('/calendar/events', {
              summary:    `🔔 Erinnerung: ${variables.subject}`,
              dtStart:    variables.reminder,
              dtEnd:      addMinutes(variables.reminder, 30),
              calendarId,
              allDay:     false,
            }),
          );
        }

        if (syncs.length > 0) {
          Promise.allSettled(syncs).then(() => {
            qc.invalidateQueries({ queryKey: ['calendar-events'] });
          });
        }
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Toggle status ─────────────────────────────────────────────────────────────
  const toggleMutation = useMutation({
    mutationFn: ({ id, completed }: { id: string; completed: boolean }) =>
      api.put(`/tasks/${id}`, { status: completed ? 'COMPLETED' : 'NOT_STARTED' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
    onError:   (err: Error) => toast.error(err.message),
  });

  // Feature 1 – fully edit task
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<EditTaskForm> }) =>
      api.put(`/tasks/${id}`, {
        ...(data.subject        !== undefined                    ? { subject:        data.subject        } : {}),
        ...(data.body           !== undefined                    ? { body:           data.body           } : {}),
        ...(data.priority       !== undefined                    ? { priority:       data.priority       } : {}),
        ...(data.reminderByMail !== undefined                    ? { reminderByMail: data.reminderByMail } : {}),
        ...(data.dueDate  !== undefined && data.dueDate  !== '' ? { dueDate:  data.dueDate  } : {}),
        ...(data.reminder !== undefined && data.reminder !== '' ? { reminder: data.reminder } : {}),
      }),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      setEditingTask(null);
      setEditForm(EMPTY_EDIT_FORM);
      toast.success('Aufgabe gespeichert');

      // Immediate feedback when a reminder was set/changed.
      // No manual removal from the tracking set needed — the compound key
      // (taskId:reminderISO) is automatically new for the new timestamp. ✓
      if (variables.data.reminder) {
        const label = variables.data.reminderByMail ? 'Erinnerung + E-Mail' : 'Erinnerung';
        toast(`🔔 ${label}: ${format(new Date(variables.data.reminder), 'dd.MM. HH:mm')} Uhr`, { duration: 4000 });
      }

      // Calendar sync for reminder after edit
      if (variables.data.reminder) {
        const calendarId = calendars?.[0]?.id;
        if (calendarId) {
          api.post('/calendar/events', {
            summary:    `🔔 Erinnerung: ${variables.data.subject ?? ''}`,
            dtStart:    variables.data.reminder,
            dtEnd:      addMinutes(variables.data.reminder, 30),
            calendarId,
            allDay:     false,
          }).then(() => {
            qc.invalidateQueries({ queryKey: ['calendar-events'] });
          }).catch(() => { /* best-effort */ });
        }
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Delete task ───────────────────────────────────────────────────────────────
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/tasks/${id}`),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['tasks'] }),
    onError:    (err: Error) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.subject.trim()) return;
    createMutation.mutate({ ...form, subject: form.subject.trim() });
  };

  // Feature 1 – double-click opens edit modal
  const handleRowDoubleClick = (task: Task) => {
    setEditingTask(task);
    setEditForm({
      subject:        task.subject,
      body:           task.body     ?? '',
      priority:       (task.priority as 'LOW' | 'NORMAL' | 'HIGH') ?? 'NORMAL',
      dueDate:        task.dueDate  ? task.dueDate.slice(0, 10)  : '',
      reminder:       task.reminder ? task.reminder.slice(0, 16) : '',
      reminderByMail: task.reminderByMail ?? false,
    });
  };

  const handleEditSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask) return;
    if (!editForm.subject.trim()) return;
    updateMutation.mutate({
      id:   editingTask.id,
      data: {
        subject:        editForm.subject.trim(),
        body:           editForm.body,
        priority:       editForm.priority,
        reminderByMail: editForm.reminderByMail,
        ...(editForm.dueDate  ? { dueDate:  editForm.dueDate  } : {}),
        ...(editForm.reminder ? { reminder: editForm.reminder } : {}),
      },
    });
  };

  const handleEditClose = () => {
    setEditingTask(null);
    setEditForm(EMPTY_EDIT_FORM);
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Keep ref in sync with current tasks — so the interval callback
  // never sees a stale snapshot (no stale-closure bug)
  useEffect(() => { allTasksRef.current = allTasks; }, [allTasks]);

  // Feature 3 – due date and reminder check
  // useCallback + empty deps → stable reference; always reads data via refs
  const checkDueDates = useCallback(() => {
    const tasks = allTasksRef.current;
    if (!tasks) return;
    const today = format(new Date(), 'yyyy-MM-dd');
    const now   = new Date();

    for (const task of tasks) {
      if (task.status === 'COMPLETED') continue;

      // ① Due date reached (once per day)
      if (task.dueDate && !notifiedIds.current.has(task.id)) {
        if (task.dueDate.slice(0, 10) === today) {
          notifiedIds.current.add(task.id);
          toast(`⏰ Aufgabe fällig: ${task.subject}`, { icon: '📋', duration: 8000 });
        }
      }

      // ② Reminder — compound key: each (task, timestamp) fires exactly once,
      //    even after page reload (persisted in localStorage).
      //    If the user changes the time → new key → fires again. ✓
      if (task.reminder) {
        const rKey = mkReminderKey(task.id, task.reminder);
        if (!notifiedReminderIds.current.has(rKey) && new Date(task.reminder) <= now) {
          notifiedReminderIds.current.add(rKey);
          saveNotifiedReminders(notifiedReminderIds.current);
          toast(`🔔 Erinnerung: ${task.subject}`, { icon: '⏰', duration: 12_000 });

          // If "by email" is requested → send mail to own address (best-effort)
          // If userMeRef is not yet populated (timing on the first mount check),
          // the profile is loaded on demand.
          if (task.reminderByMail) {
            const sendReminderMail = async () => {
              const profile = userMeRef.current
                ?? await api.get<{ email: string }>('/user/profile').catch(() => null);
              if (profile && !userMeRef.current) userMeRef.current = profile; // cache
              if (!profile?.email) return;
              await api.post('/mail/send', {
                to:       [profile.email],
                subject:  `🔔 Erinnerung: ${task.subject}`,
                bodyText: `Deine Aufgabe „${task.subject}" hat die gesetzte Erinnerungszeit erreicht.`,
                bodyHtml: `<p>Deine Aufgabe <strong>${task.subject}</strong> hat die gesetzte Erinnerungszeit erreicht.</p>`,
              });
            };
            void sendReminderMail().catch(() => { /* best-effort */ });
          }
        }
      }
    }
  }, []); // stable — not recreated on every render

  // Check immediately when new data arrives + every 30 seconds
  useEffect(() => {
    checkDueDates();
    const id = setInterval(checkDueDates, 30_000);
    return () => clearInterval(id);
  }, [checkDueDates, allTasks]); // allTasks as dep: trigger immediately when tasks change

  return (
    <div className="flex flex-1 overflow-hidden bg-gray-50">
      <div className="w-full max-w-2xl mx-auto p-6 flex flex-col gap-4">

        {/* ── Header ─────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-gray-900">Aufgaben</h1>
          <div className="flex gap-1 bg-white border border-gray-200 rounded p-0.5">
            {(['pending', 'all', 'completed'] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`text-xs px-3 py-1 rounded transition-colors ${filter === f ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-100'}`}>
                {f === 'pending' ? 'Offen' : f === 'all' ? 'Alle' : 'Erledigt'}
              </button>
            ))}
          </div>
        </div>

        {/* ── New task ────────────────────────────────────────────────────────── */}
        {showForm ? (
          <form onSubmit={handleSubmit} className="bg-white border border-accent/30 rounded-lg shadow-sm p-4 space-y-3">
            <input
              autoFocus
              value={form.subject}
              onChange={(e) => setForm((p) => ({ ...p, subject: e.target.value }))}
              className="input w-full font-medium"
              placeholder="Aufgabe eingeben…"
              required
            />

            <textarea
              value={form.body}
              onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
              className="input w-full resize-none text-sm"
              rows={2}
              placeholder="Notizen (optional)…"
            />

            <div className="flex flex-wrap gap-3">
              {/* Priority */}
              <div className="flex items-center gap-1.5">
                <Flag size={13} className={PRIORITY_COLOR[form.priority]} />
                <select
                  value={form.priority}
                  onChange={(e) => setForm((p) => ({ ...p, priority: e.target.value as 'LOW' | 'NORMAL' | 'HIGH' }))}
                  className="input py-0.5 text-xs"
                >
                  {(['LOW', 'NORMAL', 'HIGH'] as const).map((p) => (
                    <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
                  ))}
                </select>
              </div>

              {/* Due date */}
              <div className="flex items-center gap-1.5">
                <Calendar size={13} className="text-gray-400" />
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))}
                  className="input py-0.5 text-xs"
                />
              </div>

              {/* Reminder — date + time */}
              <div className="flex items-center gap-1.5" title="Erinnerung: Datum und Uhrzeit → erscheint im Kalender und als Popup">
                <Bell size={13} className="text-amber-400" />
                <input
                  type="datetime-local"
                  value={form.reminder}
                  onChange={(e) => setForm((p) => ({ ...p, reminder: e.target.value }))}
                  className="input py-0.5 text-xs"
                />
              </div>

              {/* Checkbox "by email" — only visible when a reminder is set */}
              {form.reminder && (
                <label className="flex items-center gap-1.5 cursor-pointer select-none" title="Erinnerungsmail in dein Postfach senden">
                  <input
                    type="checkbox"
                    checked={form.reminderByMail}
                    onChange={(e) => setForm((p) => ({ ...p, reminderByMail: e.target.checked }))}
                    className="h-3 w-3 rounded border-gray-300 accent-blue-500"
                  />
                  <Mail size={12} className="text-blue-500" />
                  <span className="text-xs text-gray-500">per E-Mail</span>
                </label>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
                className="btn-secondary text-xs">Abbrechen</button>
              <button type="submit" disabled={!form.subject.trim() || createMutation.isPending}
                className="btn-primary text-xs disabled:opacity-50">
                Aufgabe erstellen
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 w-full px-4 py-2.5 bg-white border border-gray-200 border-dashed rounded-lg text-sm text-gray-500 hover:text-accent hover:border-accent transition-colors"
          >
            <Plus size={15} />
            Neue Aufgabe hinzufügen…
          </button>
        )}

        {/* ── Task list ───────────────────────────────────────────────────────── */}
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {isLoading && (
            <div className="py-8 text-center text-gray-400 text-sm">Lade Aufgaben…</div>
          )}
          {!isLoading && (tasks ?? []).length === 0 && (
            <div className="py-10 text-center text-gray-400 text-sm">Keine Aufgaben</div>
          )}
          {(tasks ?? []).map((task) => {
            const done    = task.status === 'COMPLETED';
            const isOpen  = expanded.has(task.id);
            const hasBody = !!task.body;
            const overdue = !done && task.dueDate && new Date(task.dueDate) < new Date();
            return (
              <div key={task.id}>
                {/* Double-click opens edit modal (Feature 1) */}
                <div
                  className="flex items-center gap-3 px-4 py-3 group hover:bg-gray-50 transition-colors cursor-default"
                  onDoubleClick={() => handleRowDoubleClick(task)}
                  title="Doppelklick zum Bearbeiten"
                >
                  {/* Checkbox */}
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleMutation.mutate({ id: task.id, completed: !done }); }}
                    className="shrink-0 transition-colors"
                    title={done ? 'Als offen markieren' : 'Als erledigt markieren'}
                  >
                    {done
                      ? <CheckCircle2 size={18} className="text-green-500" />
                      : <Circle      size={18} className="text-gray-300 hover:text-accent" />}
                  </button>

                  {/* Subject + expand button */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className={`text-sm ${done ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                        {task.subject}
                      </p>
                      {hasBody && (
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleExpand(task.id); }}
                          className="text-gray-300 hover:text-gray-500 shrink-0"
                        >
                          <AlignLeft size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Meta info + actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <Flag size={13} className={PRIORITY_COLOR[task.priority]} />
                    {task.dueDate && (
                      <span className={`text-xs flex items-center gap-1 ${overdue ? 'text-red-500 font-medium' : 'text-gray-400'}`}>
                        <Calendar size={11} />
                        {format(new Date(task.dueDate), 'dd.MM.yy')}
                      </span>
                    )}
                    {task.reminder && (
                      <span title={`Erinnerung: ${format(new Date(task.reminder), 'dd.MM.yy HH:mm')}${task.reminderByMail ? ' · per E-Mail' : ''}`}>
                        <Bell size={11} className="text-amber-400" />
                      </span>
                    )}
                    {task.reminderByMail && (
                      <span title="E-Mail-Erinnerung aktiv">
                        <Mail size={11} className="text-blue-400" />
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Aufgabe „${task.subject}" löschen?`)) {
                          deleteMutation.mutate(task.id);
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                    {hasBody && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleExpand(task.id); }}
                        className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-gray-600 transition-all"
                      >
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                  </div>
                </div>

                {/* Body/notes expanded */}
                {isOpen && hasBody && (
                  <div className="px-11 pb-3 text-sm text-gray-600 whitespace-pre-wrap leading-relaxed bg-gray-50/50">
                    {task.body}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Feature 1: Edit-Modal ─────────────────────────────────────────────── */}
      {editingTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) handleEditClose(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">

            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">Aufgabe bearbeiten</h2>
              <button
                onClick={handleEditClose}
                className="text-gray-400 hover:text-gray-600 transition-colors"
                title="Schließen"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal form */}
            <form onSubmit={handleEditSave} className="p-5 flex flex-col gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Betreff *</label>
                <input
                  autoFocus
                  type="text"
                  value={editForm.subject}
                  onChange={(e) => setEditForm((f) => ({ ...f, subject: e.target.value }))}
                  className="input w-full"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Notizen</label>
                <textarea
                  value={editForm.body}
                  onChange={(e) => setEditForm((f) => ({ ...f, body: e.target.value }))}
                  rows={3}
                  className="input w-full resize-none text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Priorität</label>
                  <div className="flex items-center gap-1.5">
                    <Flag size={13} className={PRIORITY_COLOR[editForm.priority]} />
                    <select
                      value={editForm.priority}
                      onChange={(e) => setEditForm((f) => ({ ...f, priority: e.target.value as 'LOW' | 'NORMAL' | 'HIGH' }))}
                      className="input py-0.5 text-xs flex-1"
                    >
                      {(['LOW', 'NORMAL', 'HIGH'] as const).map((p) => (
                        <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Fälligkeit</label>
                  <div className="flex items-center gap-1.5">
                    <Calendar size={13} className="text-gray-400 shrink-0" />
                    <input
                      type="date"
                      value={editForm.dueDate}
                      onChange={(e) => setEditForm((f) => ({ ...f, dueDate: e.target.value }))}
                      className="input py-0.5 text-xs flex-1"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Erinnerung</label>
                <div className="flex items-center gap-1.5">
                  <Bell size={13} className="text-amber-400 shrink-0" />
                  <input
                    type="datetime-local"
                    value={editForm.reminder}
                    onChange={(e) => setEditForm((f) => ({ ...f, reminder: e.target.value }))}
                    className="input py-0.5 text-xs flex-1"
                  />
                </div>
                {editForm.reminder && (
                  <label className="flex items-center gap-1.5 mt-2 cursor-pointer select-none" title="Erinnerungsmail in dein Postfach senden">
                    <input
                      type="checkbox"
                      checked={editForm.reminderByMail}
                      onChange={(e) => setEditForm((f) => ({ ...f, reminderByMail: e.target.checked }))}
                      className="h-3.5 w-3.5 rounded border-gray-300 accent-blue-500"
                    />
                    <Mail size={13} className="text-blue-500" />
                    <span className="text-xs text-gray-600">Auch per E-Mail benachrichtigen</span>
                  </label>
                )}
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleEditClose}
                  className="btn-secondary text-xs"
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  disabled={!editForm.subject.trim() || updateMutation.isPending}
                  className="btn-primary text-xs disabled:opacity-50 flex items-center gap-1.5"
                >
                  <Save size={13} />
                  {updateMutation.isPending ? 'Speichern…' : 'Speichern'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
