import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, CheckCircle2, Circle, Flag, Calendar, Trash2,
  ChevronDown, ChevronRight, AlignLeft, Bell, X, Save,
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

// ── Formular-Typen ─────────────────────────────────────────────────────────────
interface NewTaskForm {
  subject:  string;
  body:     string;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  dueDate:  string;
  reminder: string;
}

interface EditTaskForm {
  subject:  string;
  body:     string;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  dueDate:  string;
  reminder: string;
}

const EMPTY_FORM: NewTaskForm = {
  subject: '', body: '', priority: 'NORMAL', dueDate: '', reminder: '',
};

const EMPTY_EDIT_FORM: EditTaskForm = {
  subject: '', body: '', priority: 'NORMAL', dueDate: '', reminder: '',
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

  // Feature 3 – Fälligkeits-Benachrichtigungen: bereits notifizierte IDs
  const notifiedIds = useRef<Set<string>>(new Set());

  const statusFilter = filter === 'pending'
    ? ['NOT_STARTED', 'IN_PROGRESS', 'DEFERRED']
    : filter === 'completed' ? ['COMPLETED'] : undefined;

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['tasks', filter],
    queryFn:  () => api.get<Task[]>('/tasks'),
    select:   (all) => statusFilter ? all.filter((t) => statusFilter.includes(t.status)) : all,
  });

  // Alle Aufgaben (ungefiltert) für Fälligkeitsprüfung
  const { data: allTasks } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn:  () => api.get<Task[]>('/tasks'),
  });

  // Feature 2 – Kalender-Sync: Standard-Kalender ermitteln
  const { data: calendars } = useQuery({
    queryKey: ['calendars'],
    queryFn:  () => api.get<{ id: string; name: string }[]>('/calendar'),
  });

  // ── Aufgabe erstellen ─────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: Omit<NewTaskForm, 'subject'> & { subject: string }) =>
      api.post('/tasks', {
        subject:  data.subject,
        body:     data.body     || '',
        priority: data.priority,
        status:   'NOT_STARTED',
        ...(data.dueDate  ? { dueDate:  data.dueDate  } : {}),
        ...(data.reminder ? { reminder: data.reminder } : {}),
      }),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      setForm(EMPTY_FORM);
      setShowForm(false);
      toast.success('Aufgabe erstellt');

      // Feature 2 – best-effort Kalender-Sync wenn dueDate gesetzt
      if (variables.dueDate) {
        const calendarId = calendars?.[0]?.id;
        if (calendarId) {
          api.post('/calendar/events', {
            summary:    variables.subject,
            dtStart:    `${variables.dueDate}T00:00`,
            dtEnd:      `${variables.dueDate}T01:00`,
            calendarId,
            allDay:     false,
          }).then(() => {
            qc.invalidateQueries({ queryKey: ['calendar-events'] });
          }).catch(() => {
            // best-effort: Kalender-Fehler still ignorieren
          });
        }
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Status umschalten ─────────────────────────────────────────────────────────
  const toggleMutation = useMutation({
    mutationFn: ({ id, completed }: { id: string; completed: boolean }) =>
      api.put(`/tasks/${id}`, { status: completed ? 'COMPLETED' : 'NOT_STARTED' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
    onError:   (err: Error) => toast.error(err.message),
  });

  // Feature 1 – Aufgabe vollständig bearbeiten
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<EditTaskForm> }) =>
      api.put(`/tasks/${id}`, {
        ...(data.subject  !== undefined                    ? { subject:  data.subject  } : {}),
        ...(data.body     !== undefined                    ? { body:     data.body     } : {}),
        ...(data.priority !== undefined                    ? { priority: data.priority } : {}),
        ...(data.dueDate  !== undefined && data.dueDate  !== '' ? { dueDate:  data.dueDate  } : {}),
        ...(data.reminder !== undefined && data.reminder !== '' ? { reminder: data.reminder } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      setEditingTask(null);
      setEditForm(EMPTY_EDIT_FORM);
      toast.success('Aufgabe gespeichert');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Aufgabe löschen ───────────────────────────────────────────────────────────
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

  // Feature 1 – Doppelklick öffnet Edit-Modal
  const handleRowDoubleClick = (task: Task) => {
    setEditingTask(task);
    setEditForm({
      subject:  task.subject,
      body:     task.body     ?? '',
      priority: (task.priority as 'LOW' | 'NORMAL' | 'HIGH') ?? 'NORMAL',
      dueDate:  task.dueDate  ? task.dueDate.slice(0, 10)  : '',
      reminder: task.reminder ? task.reminder.slice(0, 16) : '',
    });
  };

  const handleEditSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask) return;
    if (!editForm.subject.trim()) return;
    updateMutation.mutate({
      id:   editingTask.id,
      data: {
        subject:  editForm.subject.trim(),
        body:     editForm.body,
        priority: editForm.priority,
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

  // Feature 3 – Fälligkeitsprüfung
  const checkDueDates = () => {
    if (!allTasks) return;
    const today = format(new Date(), 'yyyy-MM-dd');
    for (const task of allTasks) {
      if (task.status === 'COMPLETED') continue;
      if (!task.dueDate) continue;
      if (notifiedIds.current.has(task.id)) continue;
      const taskDate = task.dueDate.slice(0, 10);
      if (taskDate === today) {
        notifiedIds.current.add(task.id);
        toast(`⏰ Aufgabe fällig: ${task.subject}`, { icon: '📋', duration: 8000 });
      }
    }
  };

  useEffect(() => {
    checkDueDates(); // sofort beim Mount prüfen
    const interval = setInterval(checkDueDates, 60_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTasks]);

  return (
    <div className="flex flex-1 overflow-hidden bg-gray-50">
      <div className="w-full max-w-2xl mx-auto p-6 flex flex-col gap-4">

        {/* ── Kopfzeile ──────────────────────────────────────────────────────── */}
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

        {/* ── Neue Aufgabe ────────────────────────────────────────────────────── */}
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
              {/* Priorität */}
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

              {/* Fälligkeitsdatum */}
              <div className="flex items-center gap-1.5">
                <Calendar size={13} className="text-gray-400" />
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((p) => ({ ...p, dueDate: e.target.value }))}
                  className="input py-0.5 text-xs"
                />
              </div>

              {/* Erinnerung */}
              <div className="flex items-center gap-1.5">
                <Bell size={13} className="text-gray-400" />
                <input
                  type="datetime-local"
                  value={form.reminder}
                  onChange={(e) => setForm((p) => ({ ...p, reminder: e.target.value }))}
                  className="input py-0.5 text-xs"
                />
              </div>
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

        {/* ── Aufgabenliste ───────────────────────────────────────────────────── */}
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
                {/* Doppelklick öffnet Edit-Modal (Feature 1) */}
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

                  {/* Betreff + Expand-Button */}
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

                  {/* Meta-Infos + Aktionen */}
                  <div className="flex items-center gap-2 shrink-0">
                    <Flag size={13} className={PRIORITY_COLOR[task.priority]} />
                    {task.dueDate && (
                      <span className={`text-xs flex items-center gap-1 ${overdue ? 'text-red-500 font-medium' : 'text-gray-400'}`}>
                        <Calendar size={11} />
                        {format(new Date(task.dueDate), 'dd.MM.yy')}
                      </span>
                    )}
                    {task.reminder && (
                      <span title={`Erinnerung: ${format(new Date(task.reminder), 'dd.MM.yy HH:mm')}`}>
                        <Bell size={11} className="text-amber-400" />
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

                {/* Body/Notizen aufgeklappt */}
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

            {/* Modal-Kopfzeile */}
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

            {/* Modal-Formular */}
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
                  <Bell size={13} className="text-gray-400 shrink-0" />
                  <input
                    type="datetime-local"
                    value={editForm.reminder}
                    onChange={(e) => setEditForm((f) => ({ ...f, reminder: e.target.value }))}
                    className="input py-0.5 text-xs flex-1"
                  />
                </div>
              </div>

              {/* Aktionen */}
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
