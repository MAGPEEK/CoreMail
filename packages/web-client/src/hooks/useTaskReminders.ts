import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { api } from '../api/client.js';
import type { Task } from '../api/types.js';

// ── localStorage — persist reminders ───────────────────────────────────────────
// Key format: "taskId:reminderEpochMs" → popup fires exactly once per (task, timestamp).
// The epoch form is independent of how the server serialises the date, so a task
// that is merely re-saved (same reminder) never fires twice.

const REMINDER_STORAGE_KEY = 'coremail:notified-reminders';

function loadNotifiedReminders(): Set<string> {
  try {
    const raw = localStorage.getItem(REMINDER_STORAGE_KEY);
    return raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

function saveNotifiedReminders(set: Set<string>): void {
  try {
    // Keep the list bounded
    const list = [...set].slice(-500);
    localStorage.setItem(REMINDER_STORAGE_KEY, JSON.stringify(list));
  } catch { /* localStorage quota — ignore */ }
}

export function reminderKey(taskId: string, reminderIso: string): string {
  const t = new Date(reminderIso).getTime();
  return `${taskId}:${Number.isNaN(t) ? reminderIso : t}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Due-date + reminder watcher for tasks. Mounted once in the app Layout, so
 * reminders fire on every page (not only while /tasks is open).
 */
export function useTaskReminders() {
  const notifiedDue = useRef<Set<string>>(new Set());
  const notifiedReminders = useRef<Set<string>>(loadNotifiedReminders());
  const tasksRef = useRef<Task[] | undefined>(undefined);

  const { data: allTasks } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => api.get<Task[]>('/tasks'),
    refetchInterval: 5 * 60_000,
    meta: { silentError: true },
  });
  useEffect(() => { tasksRef.current = allTasks; }, [allTasks]);

  // Stable callback; reads data via refs (no stale closure in the interval)
  const check = useCallback(() => {
    const tasks = tasksRef.current;
    if (!tasks) return;
    const today = format(new Date(), 'yyyy-MM-dd');
    const now = Date.now();

    for (const task of tasks) {
      if (task.status === 'COMPLETED') continue;

      // ① Due date reached (once per session and day)
      const dueKey = `${task.id}:${today}`;
      if (task.dueDate && !notifiedDue.current.has(dueKey) && format(new Date(task.dueDate), 'yyyy-MM-dd') === today) {
        notifiedDue.current.add(dueKey);
        toast(`⏰ Aufgabe fällig: ${task.subject}`, { icon: '📋', duration: 8000, id: `due:${task.id}` });
      }

      // ② Reminder — fires exactly once per (task, timestamp), persisted across reloads
      if (task.reminder) {
        const key = reminderKey(task.id, task.reminder);
        const legacyKey = `${task.id}:${task.reminder}`; // pre-v6 format (ISO string)
        const already = notifiedReminders.current.has(key) || notifiedReminders.current.has(legacyKey);
        if (!already && new Date(task.reminder).getTime() <= now) {
          notifiedReminders.current.add(key);
          saveNotifiedReminders(notifiedReminders.current);
          toast(`🔔 Erinnerung: ${task.subject}`, { icon: '⏰', duration: 12_000, id: `rem:${key}` });

          if (task.reminderByMail) {
            const sendReminderMail = async () => {
              const profile = await api.get<{ email: string }>('/user/profile');
              if (!profile?.email) return;
              await api.post('/mail/send', {
                to:       [profile.email],
                subject:  `🔔 Erinnerung: ${task.subject}`,
                bodyText: `Deine Aufgabe „${task.subject}" hat die gesetzte Erinnerungszeit erreicht.`,
                bodyHtml: `<p>Deine Aufgabe <strong>${escapeHtml(task.subject)}</strong> hat die gesetzte Erinnerungszeit erreicht.</p>`,
              });
            };
            void sendReminderMail().catch(() => { /* best-effort */ });
          }
        }
      }
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [check, allTasks]); // allTasks as dep: check immediately when tasks change
}
