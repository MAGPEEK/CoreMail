/**
 * 10.7: notifications of this session for the bell panel of the rail
 * (components/NotificationsPanel.tsx). Memory only — a reload starts empty.
 * Filled by hooks/useRealtime.ts (new mail, calendar shares) and
 * hooks/useTaskReminders.ts (task / event reminders). Model: lib/notifications.ts.
 */
import { create } from 'zustand';
import { addNotification, markAllRead, type AppNotification } from '../lib/notifications.js';

interface NotificationsState {
  items: AppNotification[];
  add: (entry: AppNotification) => void;
  markAllRead: () => void;
  clear: () => void;
}

export const useNotifications = create<NotificationsState>((set) => ({
  items: [],
  add: (entry) => set((s) => ({ items: addNotification(s.items, entry) })),
  markAllRead: () => set((s) => ({ items: markAllRead(s.items) })),
  clear: () => set({ items: [] }),
}));
