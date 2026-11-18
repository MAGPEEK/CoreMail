import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Task } from '../api/types.js';
import { SAFETY_REFETCH_MS } from '../lib/realtimeEvents.js';
import { tabRole } from '../lib/tabRole.js';
import {
  dueReminders, markSeen, parseReminderMessage, reminderMessage, type ReminderFire, type ReminderSeen,
} from '../lib/taskReminders.js';

// ── localStorage — persist reminders ───────────────────────────────────────────
// Keys "taskId:reminderEpochMs" (lib/taskReminders.ts reminderKey): a popup fires
// exactly once per (task, timestamp), also across reloads and tabs.

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function showToast(fire: Pick<ReminderFire, 'kind' | 'key' | 'subject'>): void {
  if (fire.kind === 'due') {
    toast(`⏰ Aufgabe fällig: ${fire.subject}`, { icon: '📋', duration: 8000, id: `due:${fire.key}` });
  } else {
    toast(`🔔 Erinnerung: ${fire.subject}`, { icon: '⏰', duration: 12_000, id: `rem:${fire.key}` });
  }
}

async function sendReminderMail(subject: string): Promise<void> {
  const profile = await api.get<{ email: string }>('/user/profile');
  if (!profile?.email) return;
  await api.post('/mail/send', {
    to:       [profile.email],
    subject:  `🔔 Erinnerung: ${subject}`,
    bodyText: `Deine Aufgabe „${subject}" hat die gesetzte Erinnerungszeit erreicht.`,
    bodyHtml: `<p>Deine Aufgabe <strong>${escapeHtml(subject)}</strong> hat die gesetzte Erinnerungszeit erreicht.</p>`,
  });
}

/**
 * Due-date + reminder watcher for tasks. Mounted once in the app Layout, so
 * reminders fire on every page (not only while /tasks is open). 9.4: only the
 * leading tab of the browser evaluates them (one toast set, one reminder mail);
 * the other tabs show what it announces (lib/taskReminders.ts).
 */
export function useTaskReminders() {
  const seen = useRef<ReminderSeen>({ due: new Set(), reminders: loadNotifiedReminders() });
  const tasksRef = useRef<Task[] | undefined>(undefined);

  const { data: allTasks } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => api.get<Task[]>('/tasks'),
    refetchInterval: SAFETY_REFETCH_MS, // 9.4: live via tasks events
    meta: { silentError: true },
  });
  useEffect(() => { tasksRef.current = allTasks; }, [allTasks]);

  // Stable callback; reads data via refs (no stale closure in the interval)
  const check = useCallback(() => {
    const tasks = tasksRef.current;
    if (!tasks || !tabRole.isLeader()) return;
    const fires = dueReminders(tasks, new Date(), seen.current);
    for (const fire of fires) markSeen(seen.current, fire);
    if (fires.some((f) => f.kind === 'reminder')) saveNotifiedReminders(seen.current.reminders);
    for (const fire of fires) {
      showToast(fire);
      tabRole.broadcast(reminderMessage(fire));
      if (fire.mail) void sendReminderMail(fire.subject).catch(() => { /* best-effort */ });
    }
  }, []);

  useEffect(() => {
    const offLeader = tabRole.onLeaderChange((isLeader) => {
      if (!isLeader) return;
      // another tab may have fired reminders meanwhile (persisted in localStorage)
      for (const key of loadNotifiedReminders()) seen.current.reminders.add(key);
      check();
    });
    const offMessage = tabRole.onMessage((m) => {
      const fire = parseReminderMessage(m);
      if (fire && markSeen(seen.current, fire)) showToast(fire);
    });
    return () => { offLeader(); offMessage(); };
  }, [check]);

  useEffect(() => {
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [check, allTasks]); // allTasks as dep: check immediately when tasks change
}
