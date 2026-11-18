/**
 * 9.4: Settings → Lesen → "Externe Bilder": the senders (address or @domain)
 * whose external images the webmail loads without asking, stored server-side
 * (/api/v1/user/trusted-senders). Shows the administrator's mode for external
 * images; with "always block" the list has no effect.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '../../api/client.js';
import { toastError } from '../../lib/errors.js';
import { useWebmailFeatures } from '../../hooks/useWebmailFeatures.js';
import type { ExternalImageMode } from '../../lib/webmailFeatures.js';
import { Group } from './controls.js';

const MODE_TEXT: Record<ExternalImageMode, string> = {
  ask: 'Externe Bilder werden erst nach Klick auf „Bilder anzeigen“ geladen – außer für die Absender unten.',
  contacts: 'Externe Bilder von Absendern aus Ihren Kontakten und von den Absendern unten werden automatisch geladen.',
  block: 'Externe Bilder sind für Ihr Konto gesperrt (Vorgabe des Administrators) – die Liste unten ist ohne Wirkung.',
};

export function TrustedSendersSettings() {
  const qc = useQueryClient();
  const mode = useWebmailFeatures().content.externalImages;
  const [draft, setDraft] = useState('');
  const { data } = useQuery({
    queryKey: ['trusted-senders'],
    queryFn: () => api.get<{ senders: string[] }>('/user/trusted-senders'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['trusted-senders'] });
  const add = useMutation({
    mutationFn: (sender: string) => api.post('/user/trusted-senders', { sender }),
    onSuccess: () => { setDraft(''); void refresh(); },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (sender: string) => api.delete(`/user/trusted-senders/${encodeURIComponent(sender)}`),
    onSuccess: () => { void refresh(); },
    onError: toastError,
  });
  const senders = data?.senders ?? [];

  return (
    <Group title="Externe Bilder">
      <p className="text-xs text-fg-subtle">{MODE_TEXT[mode]}</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); if (draft.trim()) add.mutate(draft.trim()); }}
      >
        <label htmlFor="trusted-sender-input" className="sr-only">Absender oder Domain</label>
        <input
          id="trusted-sender-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="name@beispiel.de oder @beispiel.de"
          className="flex-1 px-3 py-1.5 text-sm border border-line rounded bg-surface text-fg"
        />
        <button type="submit" disabled={!draft.trim() || add.isPending}
          className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50">
          Hinzufügen
        </button>
      </form>
      {senders.length === 0
        ? <p className="text-xs text-fg-subtle">Keine vertrauenswürdigen Absender.</p>
        : (
          <ul className="divide-y divide-line border border-line rounded">
            {senders.map((s) => (
              <li key={s} className="flex items-center justify-between px-3 py-1.5 text-sm text-fg">
                <span className="truncate">{s}</span>
                <button type="button" onClick={() => remove.mutate(s)} aria-label={`${s} entfernen`}
                  className="text-fg-subtle hover:text-danger-fg">
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
    </Group>
  );
}
