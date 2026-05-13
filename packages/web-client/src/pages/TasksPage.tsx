import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2, Circle, Flag, Calendar, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { api } from '../api/client.js';
import type { Task } from '../api/types.js';
import toast from 'react-hot-toast';

const PRIORITY_COLOR: Record<string, string> = {
  LOW: 'text-gray-400',
  NORMAL: 'text-blue-500',
  HIGH: 'text-red-500',
};

export function TasksPage() {
  const qc = useQueryClient();
  const [newTitle, setNewTitle] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'completed'>('pending');

  const statusFilter = filter === 'pending'
    ? ['NOT_STARTED', 'IN_PROGRESS', 'DEFERRED']
    : filter === 'completed' ? ['COMPLETED'] : undefined;

  const { data: tasks } = useQuery({
    queryKey: ['tasks', filter],
    queryFn: () => api.get<Task[]>('/tasks'),
    select: (all) => statusFilter ? all.filter((t) => statusFilter.includes(t.status)) : all,
  });

  const createMutation = useMutation({
    mutationFn: (title: string) => api.post('/tasks', { title }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      setNewTitle('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, completed }: { id: string; completed: boolean }) =>
      api.put(`/tasks/${id}`, { status: completed ? 'COMPLETED' : 'NOT_STARTED' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/tasks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTitle.trim()) createMutation.mutate(newTitle.trim());
  };

  return (
    <div className="flex flex-1 overflow-hidden bg-gray-50">
      <div className="w-full max-w-2xl mx-auto p-6 flex flex-col gap-4">
        {/* Header */}
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

        {/* Add task */}
        <form onSubmit={handleAddTask} className="flex gap-2">
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
            className="input flex-1" placeholder="Neue Aufgabe hinzufügen..." />
          <button type="submit" disabled={!newTitle.trim() || createMutation.isPending}
            className="btn-primary disabled:opacity-50">
            <Plus size={15} />
          </button>
        </form>

        {/* Task list */}
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {(tasks ?? []).length === 0 && (
            <div className="py-10 text-center text-gray-400 text-sm">Keine Aufgaben</div>
          )}
          {(tasks ?? []).map((task) => {
            const done = task.status === 'COMPLETED';
            return (
              <div key={task.id} className="flex items-center gap-3 px-4 py-3 group hover:bg-gray-50 transition-colors">
                <button onClick={() => toggleMutation.mutate({ id: task.id, completed: !done })}
                  className="shrink-0 transition-colors">
                  {done
                    ? <CheckCircle2 size={18} className="text-green-500" />
                    : <Circle size={18} className="text-gray-300 hover:text-accent" />}
                </button>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${done ? 'line-through text-gray-400' : 'text-gray-800'}`}>{task.title}</p>
                  {task.notes && <p className="text-xs text-gray-400 truncate">{task.notes}</p>}
                </div>
                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Flag size={14} className={PRIORITY_COLOR[task.priority]} />
                  {task.dueDate && (
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                      <Calendar size={12} />{format(new Date(task.dueDate), 'dd.MM.')}
                    </span>
                  )}
                  <button onClick={() => deleteMutation.mutate(task.id)} className="text-gray-300 hover:text-red-500 transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
