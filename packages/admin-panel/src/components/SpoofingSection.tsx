// BCP → Schutzfilter → Spoofing (9.4): how unauthenticated mail that claims one of our
// own domains is treated, plus the trusted senders and ARC sealers. Before 9.4 only set
// by LOCAL_SPOOF_ACTION / LOCAL_SPOOF_ALLOW / ARC_TRUSTED_SEALERS — a set environment
// variable still wins and the field is shown read-only.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { errorMessage } from '../lib/errors.js';
import { envOverrideNote, linesToList, SPOOF_ACTION_LABEL, type SpoofAction } from '../lib/senderLists.js';

type Field = 'localSpoofAction' | 'localSpoofAllow' | 'arcTrustedSealers';

interface SpoofingView {
  localSpoofAction: SpoofAction;
  localSpoofAllow: string[];
  arcTrustedSealers: string[];
  effective: { action: SpoofAction; allow: string[]; arcTrustedSealers: string[] };
  envOverrides: Array<{ field: Field; variable: string }>;
}

const KEY = ['admin', 'security', 'spoofing'] as const;

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
  const [action, setAction] = useState<SpoofAction>('policy');
  const [allow, setAllow] = useState('');
  const [sealers, setSealers] = useState('');

  useEffect(() => {
    if (!data) return;
    setAction(data.localSpoofAction);
    setAllow(data.localSpoofAllow.join('\n'));
    setSealers(data.arcTrustedSealers.join('\n'));
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.put<SpoofingView>('/admin/security/spoofing', {
      localSpoofAction: action, localSpoofAllow: linesToList(allow), arcTrustedSealers: linesToList(sealers),
    }),
    onSuccess: () => { toast.success('Einstellungen gespeichert'); void qc.invalidateQueries({ queryKey: KEY }); },
    onError: (e) => toast.error(errorMessage(e, 'Fehler beim Speichern')),
  });

  if (!data) return <p className="text-sm text-fg-subtle">Lade Einstellungen…</p>;
  const env = (f: Field) => data.envOverrides.find((o) => o.field === f)?.variable;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">Schutz vor gefälschten Absendern</h2>
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="btn-primary text-sm disabled:opacity-50">
          {save.isPending ? 'Speichern...' : 'Speichern'}
        </button>
      </div>

      <p className="text-xs text-fg-subtle">
        Gilt für Mails von außen, die eine eigene Domain im Absender tragen, ohne per SPF, DKIM oder DMARC
        authentifiziert zu sein. Die DMARC-Richtlinie fremder Absenderdomains wird unabhängig davon angewendet.
      </p>

      <fieldset className="card p-4 space-y-2" disabled={!!env('localSpoofAction')}>
        <legend className="text-sm font-semibold text-fg-muted px-1">Aktion</legend>
        <EnvNote variable={env('localSpoofAction')} />
        {(Object.keys(SPOOF_ACTION_LABEL) as SpoofAction[]).map((a) => (
          <label key={a} className="flex items-start gap-2 py-1 cursor-pointer">
            <input type="radio" name="spoof-action" value={a} checked={action === a} onChange={() => setAction(a)} className="mt-1" />
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
        <textarea id="spoof-allow" rows={5} value={allow} onChange={(e) => setAllow(e.target.value)} disabled={!!env('localSpoofAllow')}
          placeholder={'203.0.113.25\n198.51.100.0/24\nmailer.example'}
          className="w-full border border-line-strong rounded px-2 py-1.5 text-sm font-mono bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent-fg disabled:opacity-50" />
      </div>

      <div className="card p-4 space-y-2">
        <label htmlFor="spoof-arc" className="text-sm font-semibold text-fg-muted">Vertrauenswürdige ARC-Versiegler</label>
        <p className="text-xs text-fg-subtle">
          Domains von Weiterleitungs- und Listendiensten, deren gültige ARC-Kette eine fehlgeschlagene Prüfung aufhebt. Ein Eintrag pro Zeile.
        </p>
        <EnvNote variable={env('arcTrustedSealers')} />
        <textarea id="spoof-arc" rows={3} value={sealers} onChange={(e) => setSealers(e.target.value)} disabled={!!env('arcTrustedSealers')}
          placeholder="lists.example.org"
          className="w-full border border-line-strong rounded px-2 py-1.5 text-sm font-mono bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent-fg disabled:opacity-50" />
      </div>
    </div>
  );
}
