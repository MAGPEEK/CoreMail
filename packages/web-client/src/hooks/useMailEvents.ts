import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '../store/auth.js';

/**
 * Hört auf SSE-Events `mail:new` und `mail:update` und invalidiert
 * automatisch die Folder-/Messages-Caches damit neue Mails sofort
 * im Posteingang erscheinen.
 *
 * EventSource kann keine Authorization-Header senden — das JWT wird
 * deshalb via `?token=` Query-Parameter mitgegeben. Der api-gateway
 * `requireAuth`-Middleware liest beides (Header + Query).
 *
 * Bei neuer Mail wird ein dezenter Toast angezeigt.
 */
export function useMailEvents() {
  const token = useAuthStore((s) => s.accessToken);
  const qc = useQueryClient();
  // Verbindungs-Counter — beendet alte EventSources sauber wenn Token wechselt
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!token) return;

    // Alte Verbindung schließen (z.B. nach Token-Refresh)
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const url = `/api/v1/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('mail:new', (ev) => {
      // Caches sofort neu laden — invalidate triggert Background-Refetch
      void qc.invalidateQueries({ queryKey: ['folders'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
      // Dezenter Toast mit Absender + Betreff (falls vorhanden)
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

    // v3.18.17 A2: Calendar-Share-Lifecycle → Live-Sync ohne Polling
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
      // EventSource versucht automatisch alle 3s neu zu verbinden
      // — kein manuelles Reconnect nötig
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [token, qc]);
}
