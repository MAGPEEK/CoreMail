import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, CheckCircle2, Circle, Flag, Calendar, Trash2,
  ChevronDown, ChevronRight, AlignLeft, Bell,
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

// ── Erweiterungsformular für neue Aufgaben ─────────────────────────────────────
interface NewTaskForm {
  subject:  string;
  body:     string;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  dueDate:  string;
  reminder: string;
}

const EMPTY_FORM: NewTaskForm = {
  subject: '', body: '', priority: 'NORMAL', dueDate: '', reminder: '',
};

export function TasksPage() {
  const qc = useQueryClient();
  const [filter, setFilter]       = useState<'all' | 'pending' | 'completed'>('pending');
  const [expanded, setExpanded]   = useState<Set<string>>(new Set());
  const [form, setForm]           = useState<NewTaskForm>(EMPTY_FORM);
  const [showForm, setShowForm]   = useState(false);

  const statusFilter = filter === 'pending'
    ? ['NOT_STARTED', 'IN_PROGRESS', 'DEFERRED']
    : filter === 'completed' ? ['COMPLETED'] : undefined;

  const { data: tasks, isLoading } = useQuery({
    queryKey: ['tasks', filter],
    queryFn:  () => api.get<Task[]>('/tasks'),
    select:   (all) => statusFilter ? all.filter((t) => statusFilter.includes(t.status)) : all,
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      setForm(EMPTY_FORM);
      setShowForm(false);
      toast.success('Aufgabe erstellt');
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

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

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
            const done     = task.status === 'COMPLETED';
            const isOpen   = expanded.has(task.id);
            const hasBody  = !!task.body;
            const overdue  = !done && task.dueDate && new Date(task.dueDate) < new Date();
            return (
              <div key={task.id}>
                <div className="flex items-center gap-3 px-4 py-3 group hover:bg-gray-50 transition-colors">
                  {/* Checkbox */}
                  <button
                    onClick={() => toggleMutation.mutate({ id: task.id, completed: !done })}
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
                        <button onClick={() => toggleExpand(task.id)} className="text-gray-300 hover:text-gray-500 shrink-0">
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
                      onClick={() => {
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
                        onClick={() => toggleExpand(task.id)}
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
    </div>
  );
}
