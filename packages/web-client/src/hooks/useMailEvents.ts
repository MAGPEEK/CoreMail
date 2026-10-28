import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/auth.js';

/**
 * Listens for SSE events `mail:new` and `mail:update` and automatically
 * invalidates the folder/messages caches so new mails appear
 * in the inbox immediately.
 *
 * EventSource cannot send Authorization headers — the JWT is therefore
 * passed via the `?token=` query parameter. The api-gateway
 * `requireAuth` middleware reads both (header + query).
 *
 * A subtle toast is shown on new mail.
 */
export function useMailEvents() {
  const token = useAuthStore((s) => s.accessToken);
  const qc = useQueryClient();
  // Connection counter — cleanly closes old EventSources when the token changes
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!token) return;

    // Close old connection (e.g. after token refresh)
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const url = `/api/v1/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('mail:new', (ev) => {
      // Reload caches immediately — invalidate triggers a background refetch
      void qc.invalidateQueries({ queryKey: ['folders'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
      // Subtle toast with sender + subject (if present)
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
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
    });

    es.addEventListener('mail:update', () => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['folders'] });
    });

    // v3.18.17 A2: Calendar share lifecycle → live sync without polling
    es.addEventListener('calendar:shares', (ev) => {
      void qc.invalidateQueries({ queryKey: ['calendars'] });
      void qc.invalidateQueries({ queryKey: ['calendar-shares'] });
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          action?: 'create' | 'update' | 'delete' | 'self_remove';
        };
        if (data.action === 'create') {
          toast('🗓️ Ein Kalender wurde mit dir geteilt', { duration: 3500 });
        } else if (data.action === 'delete') {
          toast('🗓️ Eine Kalender-Freigabe wurde entfernt', { duration: 3500 });
        }
      } catch { /* silent */ }
    });

    es.onerror = () => {
      // EventSource automatically tries to reconnect every 3s
      // — no manual reconnect needed
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [token, qc]);
}
