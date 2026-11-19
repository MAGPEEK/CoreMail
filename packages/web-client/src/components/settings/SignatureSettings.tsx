/**
 * 9.4: Settings → Signatur — several named signatures, and which one is
 * inserted for new mails / replies per identity (own address, shared mailboxes
 * the user may send from).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/auth.js';
import { usePreferences } from '../../store/preferences.js';
import { useAccessibleMailboxes } from '../../hooks/useActiveMailbox.js';
import { mailboxTitle } from '../../lib/mailboxContext.js';
import type { NamedSignature, SignatureDefaults } from '../../lib/signaturePick.js';
import { SignatureEditor, type SignatureDraft } from '../SignatureSection.js';
import { Group, SectionHeader } from './controls.js';

export const SIGNATURES_KEY = ['user', 'signatures'] as const;
const NEW: SignatureDraft = { id: null, name: 'Neue Signatur', html: '' };
const SEND_PERMS = ['SEND_AS', 'FULL_ACCESS', 'SEND_ON_BEHALF'];

interface SignaturesResponse { signatures: NamedSignature[]; defaults: Record<string, SignatureDefaults> }

export function SignatureSettings() {
  const qc = useQueryClient();
  const ownEmail = useAuthStore((s) => s.email) ?? 'Eigene Adresse';
  const update = usePreferences((s) => s.update);
  const { data, isLoading } = useQuery({ queryKey: SIGNATURES_KEY, queryFn: () => api.get<SignaturesResponse>('/user/signatures') });
  const { data: mailboxes } = useAccessibleMailboxes();
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/user/signatures/${id}`),
    onSuccess: () => { setEditing(null); void qc.invalidateQueries({ queryKey: SIGNATURES_KEY }); toast.success('Signatur gelöscht'); },
  });

  if (isLoading || !data) {
    return <div className="flex justify-center py-12 text-fg-subtle"><Loader2 size={18} className="animate-spin" /></div>;
  }

  const signatures = data.signatures;
  const current: SignatureDraft | null = editing === 'new'
    ? NEW
    : signatures.find((s) => s.id === (editing ?? signatures[0]?.id)) ?? null;
  const identities = [
    { key: 'own', label: ownEmail },
    ...(mailboxes ?? [])
      .filter((m) => m.kind === 'shared' && m.permissions.some((p) => SEND_PERMS.includes(p)))
      .map((m) => ({ key: `shared:${m.id}`, label: mailboxTitle(m) })),
  ];
  const setDefault = (identity: string, field: 'newId' | 'replyId', id: string) => {
    const prev = data.defaults[identity] ?? { newId: null, replyId: null };
    const next = { ...prev, [field]: id || null };
    update({ signatures: { defaults: { [identity]: next } } });
    qc.setQueryData<SignaturesResponse>(SIGNATURES_KEY, (d) => (d ? { ...d, defaults: { ...d.defaults, [identity]: next } } : d));
  };

  return (
    <section className="space-y-8">
      <SectionHeader title="Signaturen" description="Mehrere Signaturen anlegen und festlegen, welche bei neuen Nachrichten und Antworten eingefügt wird." />

      <div className="flex flex-wrap items-center gap-2">
        {signatures.map((s) => (
          <button key={s.id} type="button" onClick={() => setEditing(s.id)}
            className={current?.id === s.id ? 'btn-primary text-xs' : 'btn-secondary text-xs'}>
            {s.name}
          </button>
        ))}
        <button type="button" className="btn-ghost text-xs" onClick={() => setEditing('new')}>
          <Plus size={13} /> Neue Signatur
        </button>
        {current?.id && (
          <button type="button" className="btn-ghost text-xs text-danger-fg ml-auto" disabled={remove.isPending}
            onClick={() => { if (current.id && window.confirm(`Signatur „${current.name}“ löschen?`)) remove.mutate(current.id); }}>
            <Trash2 size={13} /> Löschen
          </button>
        )}
      </div>

      {current
        ? <SignatureEditor key={current.id ?? 'new'} signature={current}
            onSaved={(id) => { setEditing(id); void qc.invalidateQueries({ queryKey: SIGNATURES_KEY }); }} />
        : <p className="text-sm text-fg-subtle">Noch keine Signatur angelegt.</p>}

      {signatures.length > 0 && (
        <Group title="Standardsignaturen">
          <div role="region" aria-label="Standardsignaturen (scrollbar)" tabIndex={0} className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-fg-muted">
                <th className="font-medium py-1 pr-2">Absender</th>
                <th className="font-medium py-1 pr-2">Neue Nachrichten</th>
                <th className="font-medium py-1">Antworten / Weiterleiten</th>
              </tr>
            </thead>
            <tbody>
              {identities.map((idn) => {
                const d = data.defaults[idn.key];
                return (
                  <tr key={idn.key} className="border-t border-line">
                    <td className="py-2 pr-2 text-fg break-all">{idn.label}</td>
                    {(['newId', 'replyId'] as const).map((field) => (
                      <td key={field} className="py-2 pr-2">
                        <select className="input w-full" aria-label={`${idn.label}: ${field === 'newId' ? 'Neue Nachrichten' : 'Antworten'}`}
                          value={d?.[field] ?? ''} onChange={(e) => setDefault(idn.key, field, e.target.value)}>
                          <option value="">Keine</option>
                          {signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </Group>
      )}
    </section>
  );
}
