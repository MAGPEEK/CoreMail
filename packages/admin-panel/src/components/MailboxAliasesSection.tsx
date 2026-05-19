/**
 * Wiederverwendbare Aliases-Section für die Mailbox- + SharedMailbox-Modals.
 *
 * - mailboxType bestimmt den API-Pfad (`/mailboxes` vs. `/shared-mailboxes`)
 * - mailboxId ist die ID der jeweiligen Ziel-Mailbox
 * - defaultDomain ist die Domain der Mailbox (für localPart-only Eingabe)
 * - allDomains: alle System-Domains, damit der User die Alias-Domain ändern kann
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AtSign, Plus, Trash2, Loader2, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

interface Alias {
  id:           string;
  address:      string;
  localPart:    string;
  description:  string;
  active:       boolean;
  domain:       { id: string; name: string };
  targetUser?:  { id: string; email: string; displayName: string } | null;
  targetShared?: { id: string; email: string; displayName: string } | null;
  createdAt:    string;
  updatedAt:    string;
}

interface DomainLite { id: string; name: string }

const LOCAL_PART_RE = /^[a-z0-9._+-]+$/;

export function MailboxAliasesSection({
  mailboxType, mailboxId, defaultDomainId, allDomains,
}: {
  mailboxType:     'user' | 'shared';
  mailboxId:       string;
  defaultDomainId: string;
  allDomains:      DomainLite[];
}) {
  const qc = useQueryClient();
  const basePath = mailboxType === 'user'
    ? `/admin/mailboxes/${mailboxId}/aliases`
    : `/admin/shared-mailboxes/${mailboxId}/aliases`;

  const [localPart, setLocalPart] = useState('');
  const [domainId, setDomainId]   = useState<string>(defaultDomainId);

  const { data: aliases = [], isLoading } = useQuery<Alias[]>({
    queryKey: ['mailbox-aliases', mailboxType, mailboxId],
    queryFn:  () => api.get(basePath),
  });

  const lc = localPart.trim().toLowerCase();
  const lpValid = lc.length > 0 && LOCAL_PART_RE.test(lc) && !lc.startsWith('.') && !lc.endsWith('.');
  const selectedDomain = allDomains.find((d) => d.id === domainId);
  const fullAddress = lpValid && selectedDomain ? `${lc}@${selectedDomain.name}` : '';

  const addMutation = useMutation({
    mutationFn: () => api.post<Alias>(basePath, { localPart: lc, domainId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mailbox-aliases', mailboxType, mailboxId] });
      setLocalPart('');
      toast.success('Alias hinzugefügt');
    },
    onError: (e: Error) => toast.error(e.message || 'Konnte Alias nicht anlegen'),
  });

  const deleteMutation = useMutation({
    mutationFn: (aliasId: string) => api.delete(`/admin/aliases/${aliasId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mailbox-aliases', mailboxType, mailboxId] });
      toast.success('Alias entfernt');
    },
    onError: (e: Error) => toast.error(e.message || 'Konnte Alias nicht löschen'),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.patch(`/admin/aliases/${id}`, { active }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mailbox-aliases', mailboxType, mailboxId] });
    },
    onError: (e: Error) => toast.error(e.message || 'Konnte Status nicht ändern'),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <AtSign size={14} className="text-gray-400" />
        <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
          E-Mail-Aliase
        </p>
        <span className="text-xs text-gray-400">({aliases.length})</span>
      </div>

      <p className="text-xs text-gray-500">
        Aliase sind zusätzliche Empfangs-Adressen für dieses Postfach. Eingehende Mails
        an einen Alias werden ins Haupt-Postfach ausgeliefert.
      </p>

      {/* Existing aliases */}
      {isLoading ? (
        <p className="text-xs text-gray-400">Lade Aliase…</p>
      ) : aliases.length === 0 ? (
        <p className="text-xs text-gray-400 italic">Noch keine Aliase angelegt.</p>
      ) : (
        <div className="space-y-1.5">
          {aliases.map((a) => (
            <div
              key={a.id}
              className={`flex items-center gap-2 p-2 rounded border ${
                a.active ? 'border-gray-200 bg-gray-50' : 'border-amber-200 bg-amber-50'
              }`}
            >
              <AtSign size={12} className={a.active ? 'text-accent' : 'text-amber-500'} />
              <span className={`text-sm font-mono flex-1 truncate ${a.active ? 'text-gray-800' : 'text-gray-500 line-through'}`}>
                {a.address}
              </span>
              {!a.active && (
                <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                  inaktiv
                </span>
              )}
              <button
                type="button"
                onClick={() => toggleActiveMutation.mutate({ id: a.id, active: !a.active })}
                disabled={toggleActiveMutation.isPending}
                title={a.active ? 'Deaktivieren' : 'Aktivieren'}
                className="text-[11px] text-gray-500 hover:text-accent px-1.5"
              >
                {a.active ? 'Deaktivieren' : 'Aktivieren'}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Alias „${a.address}" wirklich löschen?`)) {
                    deleteMutation.mutate(a.id);
                  }
                }}
                disabled={deleteMutation.isPending}
                title="Alias löschen"
                className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new alias */}
      <div className="border-t border-gray-100 pt-3 space-y-2">
        <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
          Neuen Alias hinzufügen
        </p>
        <div className="flex items-stretch gap-0">
          <input
            type="text"
            value={localPart}
            onChange={(e) => setLocalPart(e.target.value)}
            placeholder="z.B. info"
            className="input flex-1 min-w-0 rounded-r-none border-r-0"
          />
          <span className="inline-flex items-center px-2 bg-gray-50 border border-gray-300 text-gray-500 text-sm select-none">
            @
          </span>
          <select
            value={domainId}
            onChange={(e) => setDomainId(e.target.value)}
            className="input rounded-l-none border-l-0 w-44 flex-shrink-0"
          >
            {allDomains.length === 0 ? (
              <option value="">— keine Domain —</option>
            ) : (
              allDomains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)
            )}
          </select>
        </div>
        {fullAddress && (
          <p className="text-xs text-gray-500 font-mono">→ {fullAddress}</p>
        )}
        {localPart && !lpValid && (
          <p className="text-xs text-red-600 flex items-center gap-1">
            <AlertCircle size={11} /> Erlaubt: a-z, 0-9, . _ + − · nicht mit Punkt beginnen/enden
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => addMutation.mutate()}
            disabled={addMutation.isPending || !lpValid || !domainId}
            title={!lpValid ? 'Bitte einen gültigen Local-Part eingeben' : !domainId ? 'Bitte eine Domain wählen' : ''}
            className="btn-primary flex items-center gap-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {addMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
            Alias hinzufügen
          </button>
        </div>
      </div>
    </div>
  );
}
