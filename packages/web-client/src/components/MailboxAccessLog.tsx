/**
 * 9.4 Settings → Sicherheit: who accessed my mailbox — the mailbox access
 * audit of the user's own mailbox (delegates: open, send, delete, move, folder
 * changes), newest first. Read-only.
 */
import { useQuery } from '@tanstack/react-query';
import { Eye, Loader2 } from 'lucide-react';
import { format as fmtDate } from 'date-fns';
import { api } from '../api/client.js';
import { accessActionLabel, accessSourceLabel, type MailboxAccessEntry } from '../lib/mailboxAccessLog.js';

export function MailboxAccessLog() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['mailbox-access-log'],
    queryFn: () => api.get<{ entries: MailboxAccessEntry[] }>('/user/mailbox-access-log?limit=50'),
  });
  const entries = data?.entries ?? [];

  return (
    <section aria-labelledby="mbx-access-log-h" className="bg-surface-2 border border-line rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <Eye size={15} className="text-fg-subtle" aria-hidden="true" />
        <h3 id="mbx-access-log-h" className="text-sm font-medium">Zugriffe auf mein Postfach</h3>
      </div>
      <p className="text-xs text-fg-subtle mb-3">
        Was Personen mit Zugriff auf Ihr Postfach (Stellvertretung) darin getan haben. Das Öffnen wird höchstens einmal pro Stunde erfasst.
      </p>
      {isLoading ? (
        <p className="text-xs text-fg-subtle flex items-center gap-2"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Wird geladen…</p>
      ) : isError ? (
        <p className="text-xs text-danger-fg" role="alert">Die Zugriffe konnten nicht geladen werden.</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-fg-subtle">Keine Zugriffe durch andere Personen.</p>
      ) : (
        <table className="w-full text-xs">
          <caption className="sr-only">Zugriffe auf mein Postfach</caption>
          <thead>
            <tr className="border-b border-line text-fg-subtle">
              <th scope="col" className="text-left py-1 pr-2 font-medium">Zeitpunkt</th>
              <th scope="col" className="text-left py-1 pr-2 font-medium">Person</th>
              <th scope="col" className="text-left py-1 pr-2 font-medium">Aktion</th>
              <th scope="col" className="text-left py-1 font-medium">Programm</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="py-1 pr-2 whitespace-nowrap text-fg-muted">{fmtDate(new Date(e.at), 'dd.MM.yyyy HH:mm')}</td>
                <td className="py-1 pr-2 text-fg break-all">{e.actor || '—'}</td>
                <td className="py-1 pr-2 text-fg-muted">{accessActionLabel(e)}</td>
                <td className="py-1 text-fg-muted">{accessSourceLabel(e.source)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
