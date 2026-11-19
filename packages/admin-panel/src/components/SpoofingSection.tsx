// BCP → Schutzfilter → Spoofing (9.4): how unauthenticated mail that claims one of our
// own domains is treated, plus the trusted senders and ARC sealers. Before 9.4 only set
// by LOCAL_SPOOF_ACTION / LOCAL_SPOOF_ALLOW / ARC_TRUSTED_SEALERS — a set environment
// variable still wins: the field shows the value in effect, read-only, and is not saved.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { errorMessage } from '../lib/errors.js';
import { describeDomain } from '../lib/idn.js';
import { IdnText } from './IdnText.js';
import {
  envOverrideNote, linesToList, spoofFormFrom, spoofPayload, SPOOF_ACTION_LABEL,
  type SpoofAction, type SpoofField, type SpoofForm, type SpoofingView,
} from '../lib/senderLists.js';

const KEY = ['admin', 'security', 'spoofing'] as const;

/** Unicode readings of the international domains typed into a list (nothing for plain entries). */
function IdnPreview({ text }: { text: string }) {
  const idn = linesToList(text).map(describeDomain).filter((d) => d.state !== 'ascii');
  if (idn.length === 0) return null;
  return (
    <ul className="space-y-1" aria-label="Internationale Domains in Unicode-Darstellung">
      {idn.map((d) => <li key={d.ascii}><IdnText display={d} /></li>)}
    </ul>
  );
}

function EnvNote({ variable }: { variable: string | undefined }) {
  const note = envOverrideNote(variable);
  if (!note) return null;
  return (
    <p role="note" className="flex items-start gap-1.5 text-xs text-fg-muted bg-surface-2 border border-line rounded px-2 py-1.5">
      <Info size={12} className="shrink-0 mt-0.5" /> {note}
    </p>
  );
}

export function SpoofingSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: () => api.get<SpoofingView>('/admin/security/spoofing') });
  const [form, setForm] = useState<SpoofForm>({ action: 'policy', allow: '', sealers: '' });

  useEffect(() => {
    if (data) setForm(spoofFormFrom(data));
  }, [data]);

  const envFields: SpoofField[] = data ? data.envOverrides.map((o) => o.field) : [];
  const save = useMutation({
    mutationFn: () => api.put<SpoofingView>('/admin/security/spoofing', spoofPayload(form, envFields)),
    onSuccess: () => { toast.success('Einstellungen gespeichert'); void qc.invalidateQueries({ queryKey: KEY }); },
    onError: (e) => toast.error(errorMessage(e, 'Fehler beim Speichern')),
  });

  if (!data) return <p className="text-sm text-fg-subtle">Lade Einstellungen…</p>;
  const env = (f: SpoofField) => data.envOverrides.find((o) => o.field === f)?.variable;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">Schutz vor gefälschten Absendern</h2>
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm disabled:opacity-50">
          {save.isPending ? 'Speichern...' : 'Speichern'}
        </button>
      </div>

      <p className="text-xs text-fg-subtle">
        Gilt für Mails von außen, die eine eigene Domain als Absender angeben, ohne per SPF, DKIM oder DMARC
        bestätigt zu sein. Die DMARC-Richtlinie fremder Absenderdomains wird unabhängig davon angewendet.
      </p>

      <fieldset className="card p-4 space-y-2" disabled={!!env('localSpoofAction')}>
        <legend className="text-sm font-semibold text-fg-muted px-1">Aktion</legend>
        <EnvNote variable={env('localSpoofAction')} />
        {(Object.keys(SPOOF_ACTION_LABEL) as SpoofAction[]).map((a) => (
          <label key={a} className="flex items-start gap-2 py-1 cursor-pointer">
            <input type="radio" name="spoof-action" value={a} checked={form.action === a}
              onChange={() => setForm((f) => ({ ...f, action: a }))} className="mt-1" />
            <span>
              <span className="text-sm font-medium text-fg">{SPOOF_ACTION_LABEL[a].title}</span>
              <span className="block text-xs text-fg-subtle">{SPOOF_ACTION_LABEL[a].desc}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="card p-4 space-y-2">
        <label htmlFor="spoof-allow" className="text-sm font-semibold text-fg-muted">Vertrauenswürdige Absender</label>
        <p className="text-xs text-fg-subtle">
          IP-Adressen, Netze (CIDR) oder Domains externer Dienste, die im Namen der eigenen Domain senden dürfen
          (z. B. Newsletter- oder Ticketsysteme). Ein Eintrag pro Zeile.
        </p>
        <EnvNote variable={env('localSpoofAllow')} />
        <textarea id="spoof-allow" rows={5} value={form.allow} onChange={(e) => setForm((f) => ({ ...f, allow: e.target.value }))}
          disabled={!!env('localSpoofAllow')}
          placeholder={'203.0.113.25\n198.51.100.0/24\nmailer.example'}
          className="w-full border border-line-strong rounded px-2 py-1.5 text-sm font-mono bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent-fg disabled:opacity-50" />
        <IdnPreview text={form.allow} />
      </div>

      <div className="card p-4 space-y-2">
        <label htmlFor="spoof-arc" className="text-sm font-semibold text-fg-muted">Vertrauenswürdige ARC-Sealer</label>
        <p className="text-xs text-fg-subtle">
          Domains von Weiterleitungs- und Listendiensten (ARC-Sealer), deren gültige ARC-Kette eine fehlgeschlagene
          Absenderprüfung aufhebt. Ein Eintrag pro Zeile.
        </p>
        <EnvNote variable={env('arcTrustedSealers')} />
        <textarea id="spoof-arc" rows={3} value={form.sealers} onChange={(e) => setForm((f) => ({ ...f, sealers: e.target.value }))}
          disabled={!!env('arcTrustedSealers')}
          placeholder="lists.example.org"
          className="w-full border border-line-strong rounded px-2 py-1.5 text-sm font-mono bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent-fg disabled:opacity-50" />
        <IdnPreview text={form.sealers} />
      </div>
    </div>
  );
}
