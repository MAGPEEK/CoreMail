// BCP → Schutzfilter → Absenderlisten (9.4): sender block / allow lists per scope
// (global, domain, mailbox) with CSV import/export. Saved via
// /admin/security/sender-lists; the security filter reads them per message.
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Trash2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { api, downloadFile } from '../api/client.js';
import { ApiError, errorMessage } from '../lib/errors.js';
import { Toggle } from './Toggle.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { IdnText } from './IdnText.js';
import {
  creatableScopes, effectiveScope,
  filterEntries, patternDisplay, targetDisplay, importErrorText, patternPlaceholder, LIST_TYPE_LABEL, SCOPE_LABEL, PATTERN_TYPE_LABEL,
  type ListScope, type ListType, type PatternType, type SenderListEntry,
} from '../lib/senderLists.js';

const KEY = ['admin', 'security', 'sender-lists'] as const;
const BASE = '/admin/security/sender-lists';

const inputCls = 'border border-line-strong rounded px-2 py-1.5 text-sm bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent-fg';

export function SenderListsSection() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<ListType>('BLOCK');
  const [query, setQuery] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [chosenScope, setScope] = useState<ListScope>('GLOBAL');
  // 9.5: no GLOBAL entries for an admin limited to domains
  const { scoped } = usePermissions();
  const scopeOptions = creatableScopes(scoped);
  const scope = effectiveScope(chosenScope, scopeOptions);
  const [target, setTarget] = useState('');
  const [patternType, setPatternType] = useState<PatternType>('EXACT');
  const [pattern, setPattern] = useState('');
  const [comment, setComment] = useState('');

  const { data: entries = [], isLoading } = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<SenderListEntry[]>(BASE),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });

  const create = useMutation({
    mutationFn: () => api.post(BASE, {
      listType: tab, scope, target: scope === 'GLOBAL' ? '' : target.trim(), patternType, pattern: pattern.trim(), comment: comment.trim(),
    }),
    onSuccess: () => { void invalidate(); toast.success('Eintrag angelegt'); setPattern(''); setComment(''); },
    onError: (e) => toast.error(errorMessage(e, 'Fehler beim Anlegen')),
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<SenderListEntry> }) => api.patch(`${BASE}/${id}`, body),
    onSuccess: () => { void invalidate(); },
    onError: (e) => toast.error(errorMessage(e, 'Fehler beim Speichern')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: () => { void invalidate(); toast.success('Eintrag gelöscht'); },
    onError: (e) => toast.error(errorMessage(e, 'Fehler beim Löschen')),
  });
  const importCsv = useMutation({
    mutationFn: (csv: string) => api.post<{ created: number; skipped: number }>(`${BASE}/import`, { csv }),
    onSuccess: (r) => { void invalidate(); toast.success(`${r.created} Einträge importiert, ${r.skipped} bereits vorhanden`); },
    onError: (e) => {
      const errors = e instanceof ApiError && e.errors ? e.errors as Array<{ line: number; error: string }> : [];
      toast.error(errors.length ? `Import abgelehnt:\n${importErrorText(errors)}` : errorMessage(e, 'Import fehlgeschlagen'));
    },
  });

  async function onFile(file: File | undefined) {
    if (!file) return;
    importCsv.mutate(await file.text());
    if (fileRef.current) fileRef.current.value = '';
  }

  const shown = filterEntries(entries, tab, query);
  const canAdd = pattern.trim() !== '' && (scope === 'GLOBAL' || target.trim() !== '');

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-fg">Absenderlisten</h2>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary text-sm gap-1"
            onClick={() => { void downloadFile(`${BASE}/export.csv`, 'absenderlisten.csv').catch((e) => toast.error(errorMessage(e, 'Export fehlgeschlagen'))); }}>
            <Download size={13} /> CSV-Export
          </button>
          <button type="button" className="btn-secondary text-sm gap-1" disabled={importCsv.isPending}
            onClick={() => fileRef.current?.click()}>
            <Upload size={13} /> CSV-Import
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" aria-label="CSV-Datei importieren"
            onChange={(e) => { void onFile(e.target.files?.[0]); }} />
        </div>
      </div>

      <p className="text-xs text-fg-subtle">
        Einträge der Sperrliste weisen den Absender beim Empfang ab (je Empfänger). Einträge der Zulassungsliste heben
        eine Sperre auf; die Spam-Bewertung entfällt nur, wenn die Absenderdomain per SPF oder DKIM bestätigt ist.
        Der genaueste Geltungsbereich entscheidet (Postfach vor Domain vor Global), innerhalb eines Bereichs hat die
        Zulassungsliste Vorrang. SPF-, DKIM- und DMARC-Prüfung, Virenscan und Anhänge-Filter gelten immer.
      </p>

      <div className="flex gap-1 border-b border-line" role="tablist">
        {(['BLOCK', 'ALLOW'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === id ? 'border-accent-fg text-accent-fg font-semibold' : 'border-transparent text-fg-subtle hover:text-fg-muted'
            }`}>
            {LIST_TYPE_LABEL[id]}
            <span className="ml-1.5 text-xs bg-surface-2 px-1.5 py-0.5 rounded-full text-fg-muted">
              {entries.filter((e) => e.listType === id).length}
            </span>
          </button>
        ))}
      </div>

      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-fg-muted">Neuer Eintrag ({LIST_TYPE_LABEL[tab]})</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-fg-muted flex flex-col gap-1">
            Geltungsbereich
            <select value={scope} onChange={(e) => setScope(e.target.value as ListScope)} className={inputCls}>
              {scopeOptions.map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
            </select>
          </label>
          <label className="text-xs text-fg-muted flex flex-col gap-1">
            {scope === 'DOMAIN' ? 'Domain' : scope === 'USER' ? 'Postfach-Adresse' : 'Ziel'}
            <input value={scope === 'GLOBAL' ? '' : target} disabled={scope === 'GLOBAL'} onChange={(e) => setTarget(e.target.value)}
              placeholder={scope === 'DOMAIN' ? 'firma.example' : scope === 'USER' ? 'benutzer@firma.example' : 'alle Empfänger'}
              className={`${inputCls} disabled:opacity-50`} />
          </label>
          <label className="text-xs text-fg-muted flex flex-col gap-1">
            Typ
            <select value={patternType} onChange={(e) => setPatternType(e.target.value as PatternType)} className={inputCls}>
              {(['EXACT', 'WILDCARD', 'REGEX'] as const).map((t) => <option key={t} value={t}>{PATTERN_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="text-xs text-fg-muted flex flex-col gap-1">
            Muster
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={patternPlaceholder(patternType)}
              className={`${inputCls} font-mono`} />
          </label>
          <label className="text-xs text-fg-muted flex flex-col gap-1 col-span-2">
            Kommentar
            <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} className={inputCls} />
          </label>
        </div>
        <div className="flex justify-end">
          <button type="button" className="btn-primary text-sm gap-1" disabled={!canAdd || create.isPending}
            onClick={() => create.mutate()}>
            <Plus size={13} /> Hinzufügen
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">{shown.length} Einträge</p>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Suchen…" aria-label="Einträge durchsuchen"
          className="border border-line-strong rounded px-2 py-1 text-xs w-48 bg-surface text-fg focus:outline-none focus:ring-2 focus:ring-accent-fg" />
      </div>

      <div className="card overflow-hidden">
        {isLoading && <p className="p-4 text-sm text-fg-subtle">Lade Einträge…</p>}
        {!isLoading && shown.length === 0 && <p className="p-4 text-sm text-fg-subtle">Keine Einträge</p>}
        {shown.length > 0 && (
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-xs text-fg-subtle text-left">
              <tr>
                <th className="px-3 py-2 font-semibold">Aktiv</th>
                <th className="px-3 py-2 font-semibold">Muster</th>
                <th className="px-3 py-2 font-semibold">Geltungsbereich</th>
                <th className="px-3 py-2 font-semibold">Kommentar</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((e) => (
                <tr key={e.id} className={e.active ? '' : 'bg-surface-2'}>
                  <td className="px-3 py-2">
                    <Toggle active={e.active} label={`${e.pattern} aktiv`}
                      onToggle={() => patch.mutate({ id: e.id, body: { active: !e.active } })} />
                  </td>
                  <td className="px-3 py-2">
                    <IdnText display={patternDisplay(e)} />
                    <span className="block text-[10px] text-fg-subtle">{PATTERN_TYPE_LABEL[e.patternType]}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-fg-muted">
                    {SCOPE_LABEL[e.scope]}
                    {e.target && <>: <IdnText display={targetDisplay(e)} className="text-xs text-fg-muted break-all" /></>}
                  </td>
                  <td className="px-3 py-2 text-xs text-fg-subtle">{e.comment}</td>
                  <td className="px-3 py-2 text-right">
                    <button type="button" aria-label={`Eintrag ${e.pattern} löschen`}
                      onClick={() => { if (window.confirm(`Eintrag „${e.pattern}" wirklich löschen?`)) remove.mutate(e.id); }}
                      className="text-fg-subtle hover:text-danger-fg transition-colors p-1">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-fg-subtle">
        CSV-Spalten: listType, scope, target, patternType, pattern, comment, active. Ein Import wird vollständig
        abgelehnt, wenn eine Zeile fehlerhaft ist; vorhandene Einträge werden übersprungen. Domains dürfen als
        Unicode (müller.example) oder in Punycode (xn--mller-kva.example) eingegeben werden; gespeichert und im
        CSV-Export ausgegeben wird immer die Punycode-Form.
      </p>
    </div>
  );
}
