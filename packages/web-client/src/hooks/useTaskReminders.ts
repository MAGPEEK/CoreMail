import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { CalendarEvent, FlaggedMail, Task } from '../api/types.js';
import { SAFETY_REFETCH_MS } from '../lib/realtimeEvents.js';
import { tabRole } from '../lib/tabRole.js';
import { useWebmailFeatures } from './useWebmailFeatures.js';
import {
  dueReminders, markSeen, parseReminderMessage, reminderMessage, type ReminderFire, type ReminderSeen, type ReminderTask,
} from '../lib/taskReminders.js';
import { eventReminderItems, flagReminderItems } from '../lib/reminderSources.js';
import { hintNotification, reminderHref } from '../lib/notifications.js';
import { useNotifications } from '../store/notifications.js';

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
  const text = fire.kind === 'due' ? `⏰ Aufgabe fällig: ${fire.subject}` : `🔔 Erinnerung: ${fire.subject}`;
  if (fire.kind === 'due') {
    toast(text, { icon: '📋', duration: 8000, id: `due:${fire.key}` });
  } else {
    toast(`🔔 Erinnerung: ${fire.subject}`, { icon: '⏰', duration: 12_000, id: `rem:${fire.key}` });
  }
  // 10.7: also listed in the bell panel of the rail (this session)
  useNotifications.getState().add(hintNotification('reminder', `${fire.kind}:${fire.key}`, text, Date.now(), reminderHref(fire.key)));
}

async function sendReminderMail(subject: string, itemId: string): Promise<void> {
  const profile = await api.get<{ email: string }>('/user/profile');
  if (!profile?.email) return;
  // 9.4: event reminders ("event:…") name the appointment, task reminders the task
  const what = itemId.startsWith('event:') ? 'Dein Termin' : 'Deine Aufgabe';
  await api.post('/mail/send', {
    to:       [profile.email],
    subject:  `🔔 Erinnerung: ${subject}`,
    bodyText: `${what} „${subject}" hat die gesetzte Erinnerungszeit erreicht.`,
    bodyHtml: `<p>${what} <strong>${escapeHtml(subject)}</strong> hat die gesetzte Erinnerungszeit erreicht.</p>`,
  });
}

/** Window of calendar events whose reminders are watched (now − 1 h … now + 8 days). */
function reminderEventWindow(): { start: string; end: string } {
  const hour = 60 * 60_000;
  const now = Math.floor(Date.now() / hour) * hour;
  return { start: new Date(now - hour).toISOString(), end: new Date(now + 8 * 24 * hour).toISOString() };
}

/**
 * Due-date + reminder watcher for tasks. Mounted once in the app Layout, so
 * reminders fire on every page (not only while /tasks is open). 9.4: only the
 * leading tab of the browser evaluates them (one toast set, one reminder mail);
 * the other tabs show what it announces (lib/taskReminders.ts). Also the
 * reminders of flagged mails and calendar events (lib/reminderSources.ts).
 */
export function useTaskReminders() {
  const seen = useRef<ReminderSeen>({ due: new Set(), reminders: loadNotifiedReminders() });
  const tasksRef = useRef<ReminderTask[] | undefined>(undefined);

  // 9.4: no reminders while the tasks module is off (webmail policy)
  const tasksEnabled = useWebmailFeatures().features.tasks;
  const { data: allTasks } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => api.get<Task[]>('/tasks'),
    enabled: tasksEnabled,
    refetchInterval: SAFETY_REFETCH_MS, // 9.4: live via tasks events
    meta: { silentError: true },
  });
  // 9.4: reminders of flagged mails and of calendar events go through the same engine
  const { data: flagged } = useQuery({
    queryKey: ['follow-up', 'flagged'],
    queryFn: () => api.get<FlaggedMail[]>('/mail/follow-up?status=flagged'),
    refetchInterval: SAFETY_REFETCH_MS,
    meta: { silentError: true },
  });
  const [eventWindow, setEventWindow] = useState(reminderEventWindow);
  useEffect(() => {
    const id = setInterval(() => setEventWindow(reminderEventWindow()), 60 * 60_000);
    return () => clearInterval(id);
  }, []);
  const { data: events } = useQuery({
    queryKey: ['calendar-events', 'reminders', eventWindow.start, eventWindow.end],
    queryFn: () => api.get<CalendarEvent[]>(`/calendar/events?start=${encodeURIComponent(eventWindow.start)}&end=${encodeURIComponent(eventWindow.end)}`),
    refetchInterval: SAFETY_REFETCH_MS,
    meta: { silentError: true },
  });
  useEffect(() => {
    if (!allTasks) return;
    tasksRef.current = [...allTasks, ...flagReminderItems(flagged ?? []), ...eventReminderItems(events ?? [], new Date())];
  }, [allTasks, flagged, events]);

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
      if (fire.mail) void sendReminderMail(fire.subject, fire.taskId).catch(() => { /* best-effort */ });
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
  }, [check, allTasks, flagged, events]); // check immediately when the reminder items change
}
