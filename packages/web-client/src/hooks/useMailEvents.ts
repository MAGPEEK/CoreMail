import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/auth.js';
import { fetchEventTicket } from '../api/client.js';
import { openReconnectingEventSource, eventStreamUrl } from '../lib/reconnectingEventSource.js';

/**
 * Listens for SSE events `mail:new` and `mail:update` and automatically
 * invalidates the folder/messages caches so new mails appear
 * in the inbox immediately.
 *
 * EventSource cannot send Authorization headers. v8.1: before every
 * (re)connect a single-use ticket is requested with the in-memory access token
 * (POST /api/v1/events/ticket, refresh once on 401) and the stream is opened
 * with `?ticket=` — the token itself never goes into a URL. The stream follows
 * the web session server-side, so a token refresh does not need a reconnect.
 *
 * A subtle toast is shown on new mail.
 */
export function useMailEvents() {
  const loggedIn = useAuthStore((s) => !!s.accessToken);
  const qc = useQueryClient();

  useEffect(() => {
    if (!loggedIn) return;

    return openReconnectingEventSource({
      url: async () => {
        const ticket = await fetchEventTicket();
        return ticket ? eventStreamUrl(ticket) : null;
      },
      handlers: {
        'mail:new': (ev) => {
          // Reload caches immediately — invalidate triggers a background refetch
          void qc.invalidateQueries({ queryKey: ['folders'] });
          void qc.invalidateQueries({ queryKey: ['messages'] });
          // Subtle toast with sender + subject (if present)
          try {
            const data = JSON.parse(String(ev.data)) as {
              fromName?: string;
              fromAddr?: string;
              subject?: string;
            };
            const from = data.fromName ?? data.fromAddr ?? 'Unbekannt';
            const subject = data.subject ?? '(Kein Betreff)';
            toast(`📧 ${from}: ${subject}`, { duration: 4000 });
          } catch {
            toast('📧 Neue Nachricht', { duration: 3000 });
          }
        },
        'mail:update': () => {
          void qc.invalidateQueries({ queryKey: ['messages'] });
          void qc.invalidateQueries({ queryKey: ['folders'] });
        },
        // v3.18.17 A2: Calendar share lifecycle → live sync without polling
        'calendar:shares': (ev) => {
          void qc.invalidateQueries({ queryKey: ['calendars'] });
          void qc.invalidateQueries({ queryKey: ['calendar-shares'] });
          try {
            const data = JSON.parse(String(ev.data)) as {
              action?: 'create' | 'update' | 'delete' | 'self_remove';
            };
            if (data.action === 'create') {
              toast('🗓️ Ein Kalender wurde mit dir geteilt', { duration: 3500 });
            } else if (data.action === 'delete') {
              toast('🗓️ Eine Kalender-Freigabe wurde entfernt', { duration: 3500 });
            }
          } catch { /* silent */ }
        },
      },
    });
  }, [loggedIn, qc]);
}
