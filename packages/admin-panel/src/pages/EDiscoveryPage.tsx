import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SearchCheck, Plus, Trash2, Play, Download, Lock, Unlock,
  ChevronDown, ChevronRight, Eye, Search, X, Check, Paperclip,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api, getToken } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface EDiscoverySearch {
  id: string;
  name: string;
  description: string;
  status: 'DRAFT' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  resultCount: number;
  query: {
    keywords?: string;
    senderAddresses?: string[];
    recipientAddresses?: string[];
    dateFrom?: string;
    dateTo?: string;
    subjectContains?: string;
    hasAttachment?: boolean;
  };
  mailboxIds: string[];
  createdAt: string;
  exportPath?: string;
}

interface LegalHold {
  id: string;
  name: string;
  description: string;
  active: boolean;
  mailboxIds: string[];
  appliedBy: string;
  appliedAt: string;
  releasedAt?: string;
}

interface MailboxOption {
  id: string;
  email: string;
  displayName: string;
  domainName: string;
}

interface ResultMessage {
  id: string;
  subject: string;
  fromAddr: string;
  toAddrs: string[];
  date: string;
  rawSize: number;
  messageId: string | null;
  folder: { name: string; mailbox: { user: { email: string } } };
}

interface PreviewResponse {
  total: number;
  sample: number;
  dedupedSample: number;
  deduped: boolean;
  messages: ResultMessage[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: EDiscoverySearch['status'] }) {
  const map: Record<EDiscoverySearch['status'], string> = {
    DRAFT:     'bg-gray-100 text-gray-600',
    RUNNING:   'bg-blue-100 text-blue-700',
    COMPLETED: 'bg-green-100 text-green-700',
    FAILED:    'bg-red-100 text-red-700',
  };
  const labels: Record<EDiscoverySearch['status'], string> = {
    DRAFT: 'Entwurf', RUNNING: 'Läuft', COMPLETED: 'Abgeschlossen', FAILED: 'Fehlgeschlagen',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${map[status]}`}>
      {labels[status]}
    </span>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

// ─── Mailbox Multi-Picker ─────────────────────────────────────────────────────

function MailboxPicker({
  selected, onChange, mailboxes,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  mailboxes: MailboxOption[];
}) {
  const [open, setOpen]   = useState(false);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return mailboxes;
    return mailboxes.filter((m) =>
      m.email.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q)
    );
  }, [mailboxes, search]);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const summary = selected.length === 0
    ? 'Alle Postfächer (keine Auswahl)'
    : selected.length <= 2
      ? mailboxes.filter((m) => selected.includes(m.id)).map((m) => m.email).join(', ')
      : `${selected.length} Postfächer ausgewählt`;

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between border border-gray-300 rounded px-3 py-1.5 text-sm bg-white hover:border-gray-400">
        <span className="truncate text-left">{summary}</span>
        <ChevronDown size={14} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-hidden flex flex-col">
          <div className="p-2 border-b border-gray-100 flex items-center gap-2">
            <Search size={13} className="text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Postfach suchen…"
              className="flex-1 text-sm outline-none" autoFocus />
            {selected.length > 0 && (
              <button onClick={() => onChange([])} className="text-[11px] text-gray-500 hover:text-red-600">Alle abwählen</button>
            )}
          </div>
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">Kein Postfach gefunden</p>
            ) : filtered.map((m) => (
              <label key={m.id} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={selected.includes(m.id)} onChange={() => toggle(m.id)}
                  className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-800 truncate">{m.displayName || m.email}</p>
                  <p className="text-[11px] text-gray-500 truncate">{m.email}</p>
                </div>
              </label>
            ))}
          </div>
          <div className="px-3 py-2 border-t border-gray-100 flex items-center justify-end">
            <button onClick={() => setOpen(false)} className="text-xs px-2.5 py-1 bg-accent text-white rounded hover:bg-accent/90">Fertig</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SearchField (module-level — MUST NOT be defined inside another component) ─
// Defining a component inside a render function creates a new type on every
// render → React unmounts + remounts the input → focus lost after each keystroke.

function SearchField({ label, value, onChange, placeholder, type = 'text' }: {
  label:        string;
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
  type?:        string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
        placeholder={placeholder}
      />
    </div>
  );
}

// ─── Create / Edit Search Modal ───────────────────────────────────────────────

function CreateSearchModal({ onClose, mailboxes }: { onClose: () => void; mailboxes: MailboxOption[] }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: '', description: '',
    keywords: '', senderAddresses: '', recipientAddresses: '',
    dateFrom: '', dateTo: '', subjectContains: '',
    hasAttachment: 'any' as 'any' | 'yes' | 'no',
  });
  const [mailboxIds, setMailboxIds] = useState<string[]>([]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => api.post('/admin/ediscovery/searches', {
      name: form.name,
      description: form.description,
      query: {
        ...(form.keywords ? { keywords: form.keywords } : {}),
        ...(form.senderAddresses ? { senderAddresses: form.senderAddresses.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(form.recipientAddresses ? { recipientAddresses: form.recipientAddresses.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
        ...(form.dateFrom ? { dateFrom: new Date(form.dateFrom).toISOString() } : {}),
        ...(form.dateTo ? { dateTo: new Date(form.dateTo).toISOString() } : {}),
        ...(form.subjectContains ? { subjectContains: form.subjectContains } : {}),
        ...(form.hasAttachment === 'yes' ? { hasAttachment: true } : form.hasAttachment === 'no' ? { hasAttachment: false } : {}),
      },
      mailboxIds,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ediscovery-searches'] });
      toast.success('Suche erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-gray-900">Neue eDiscovery-Suche</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="px-6 py-4 space-y-3 overflow-y-auto flex-1">
          <SearchField label="Name *" value={form.name} onChange={(v) => set('name', v)} placeholder="Projekt Gamma Untersuchung" />
          <SearchField label="Beschreibung" value={form.description} onChange={(v) => set('description', v)} placeholder="Optionale Beschreibung" />

          <div className="border-t border-gray-100 pt-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Postfächer</p>
            <MailboxPicker selected={mailboxIds} onChange={setMailboxIds} mailboxes={mailboxes} />
            <p className="text-[11px] text-gray-400 mt-1">Keine Auswahl = organisationsweite Suche</p>
          </div>

          <div className="border-t border-gray-100 pt-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Suchkriterien</p>
          </div>
          <SearchField label="Stichwörter (Betreff & Body)" value={form.keywords} onChange={(v) => set('keywords', v)} placeholder="Vertrag, Kündigung, …" />
          <SearchField label="Betreff enthält" value={form.subjectContains} onChange={(v) => set('subjectContains', v)} placeholder="Re: Vertrag" />
          <SearchField label="Absender (kommagetrennt)" value={form.senderAddresses} onChange={(v) => set('senderAddresses', v)} placeholder="user@domain.com, …" />
          <SearchField label="Empfänger — To/Cc/Bcc (kommagetrennt)" value={form.recipientAddresses} onChange={(v) => set('recipientAddresses', v)} placeholder="user@domain.com, …" />
          <div className="grid grid-cols-2 gap-3">
            <SearchField label="Datum von" value={form.dateFrom} onChange={(v) => set('dateFrom', v)} type="date" />
            <SearchField label="Datum bis" value={form.dateTo} onChange={(v) => set('dateTo', v)} type="date" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1 flex items-center gap-1.5">
              <Paperclip size={11} className="text-gray-400" /> Anhang
            </label>
            <div className="flex gap-2">
              {(['any', 'yes', 'no'] as const).map((v) => (
                <button key={v} type="button" onClick={() => setForm((f) => ({ ...f, hasAttachment: v }))}
                  className={`flex-1 px-3 py-1.5 text-sm rounded border ${
                    form.hasAttachment === v
                      ? 'bg-accent/10 border-accent text-accent font-medium'
                      : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                  }`}>
                  {v === 'any' ? 'Egal' : v === 'yes' ? 'Mit Anhang' : 'Ohne Anhang'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Erstellen…' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Preview Modal ────────────────────────────────────────────────────────────

function PreviewModal({ searchId, searchName, status, onClose }: { searchId: string; searchName: string; status: EDiscoverySearch['status']; onClose: () => void }) {
  const [dedupe, setDedupe] = useState(true);

  const { data, isLoading, error } = useQuery<PreviewResponse>({
    queryKey: ['admin-ediscovery-preview', searchId, dedupe],
    queryFn: () => api.get(`/admin/ediscovery/searches/${searchId}/preview?limit=50&dedupe=${dedupe ? 1 : 0}`),
  });

  const handleExport = () => {
    if (status !== 'COMPLETED') {
      toast.error('Suche muss zuerst gestartet und abgeschlossen werden');
      return;
    }
    // MBOX-Download via API mit Auth-Header — fetch+blob, weil <a download> kein Header senden kann
    const url = `/api/v1/admin/ediscovery/searches/${searchId}/export?dedupe=${dedupe ? 1 : 0}`;
    const token = getToken() ?? '';
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Export-Fehler: ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${searchName.replace(/[^a-z0-9-]+/gi, '_')}.mbox`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast.success('MBOX-Datei heruntergeladen');
      })
      .catch((e: Error) => toast.error(e.message));
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Vorschau — {searchName}</h2>
            {data && (
              <p className="text-xs text-gray-500 mt-0.5">
                Gesamt: {data.total.toLocaleString('de-DE')} ·
                {' '}{data.deduped
                  ? <>nach De-Duplizierung: {data.dedupedSample.toLocaleString('de-DE')} (Sample {data.sample.toLocaleString('de-DE')})</>
                  : <>Sample {data.sample.toLocaleString('de-DE')}</>
                }
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="px-6 py-3 border-b border-gray-100 flex items-center justify-between gap-3 shrink-0">
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-accent" />
            <span>De-Duplizieren <span className="text-gray-400">(gleiche Message-ID in mehreren Postfächern)</span></span>
          </label>
          <button onClick={handleExport} disabled={status !== 'COMPLETED'}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50"
            title={status !== 'COMPLETED' ? 'Erst „Suche starten" anklicken' : 'Als MBOX herunterladen'}>
            <Download size={13} /> MBOX-Export
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="text-center text-sm text-gray-400 py-12">Vorschau wird geladen…</p>
          ) : error ? (
            <p className="text-center text-sm text-red-500 py-12">Fehler: {(error as Error).message}</p>
          ) : !data || data.messages.length === 0 ? (
            <p className="text-center text-sm text-gray-400 py-12">Keine Ergebnisse für die aktuellen Kriterien</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <th className="text-left px-4 py-2.5">Betreff</th>
                  <th className="text-left px-4 py-2.5">Von</th>
                  <th className="text-left px-4 py-2.5">An</th>
                  <th className="text-left px-4 py-2.5">Postfach</th>
                  <th className="text-left px-4 py-2.5">Datum</th>
                  <th className="text-right px-4 py-2.5">Größe</th>
                </tr>
              </thead>
              <tbody>
                {data.messages.map((m) => (
                  <tr key={m.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-900 max-w-xs truncate">{m.subject || '(kein Betreff)'}</td>
                    <td className="px-4 py-2 text-xs text-gray-600 max-w-[200px] truncate">{m.fromAddr}</td>
                    <td className="px-4 py-2 text-xs text-gray-600 max-w-[200px] truncate">{m.toAddrs.join(', ')}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 truncate">{m.folder.mailbox.user.email}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{fmtDate(m.date)}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 text-right">{fmtBytes(m.rawSize)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Create Hold Modal (mit Picker) ───────────────────────────────────────────

function CreateHoldModal({ onClose, mailboxes }: { onClose: () => void; mailboxes: MailboxOption[] }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mailboxIds, setMailboxIds] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: () => api.post('/admin/ediscovery/holds', { name, description, mailboxIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ediscovery-holds'] });
      toast.success('Legal Hold erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">Neuer Legal Hold</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. Rechtsstreit Müller vs. AG" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Betroffene Postfächer *</label>
            <MailboxPicker selected={mailboxIds} onChange={setMailboxIds} mailboxes={mailboxes} />
            <p className="text-[11px] text-gray-400 mt-1">Mindestens ein Postfach erforderlich</p>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !name || mailboxIds.length === 0}
            className="px-4 py-2 text-sm text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50">
            {save.isPending ? 'Sperren…' : 'Hold aktivieren'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function EDiscoveryPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'searches' | 'holds'>('searches');
  const [createSearch, setCreateSearch] = useState(false);
  const [createHold, setCreateHold]     = useState(false);
  const [preview, setPreview]           = useState<EDiscoverySearch | null>(null);
  const [expandedSearch, setExpandedSearch] = useState<string | null>(null);

  const { data: mailboxes = [] } = useQuery<MailboxOption[]>({
    queryKey: ['admin-ediscovery-mailboxes'],
    queryFn:  () => api.get('/admin/ediscovery/mailboxes'),
    staleTime: 60_000,
  });

  const mailboxById = useMemo(() => new Map(mailboxes.map((m) => [m.id, m])), [mailboxes]);

  const { data: searches = [], isLoading: searchLoading } = useQuery<EDiscoverySearch[]>({
    queryKey: ['admin-ediscovery-searches'],
    queryFn:  () => api.get('/admin/ediscovery/searches'),
    refetchInterval: 5000,
  });

  const { data: holds = [], isLoading: holdLoading } = useQuery<LegalHold[]>({
    queryKey: ['admin-ediscovery-holds'],
    queryFn:  () => api.get('/admin/ediscovery/holds'),
  });

  const runSearch = useMutation({
    mutationFn: (id: string) => api.post(`/admin/ediscovery/searches/${id}/run`, {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ediscovery-searches'] }); toast.success('Suche gestartet'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const deleteSearch = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/ediscovery/searches/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ediscovery-searches'] }); toast.success('Suche gelöscht'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const releaseHold = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/ediscovery/holds/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ediscovery-holds'] }); toast.success('Legal Hold aufgehoben'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <SearchCheck size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">eDiscovery & Legal Hold</h1>
            <p className="text-sm text-gray-500">Postfach-Suche mit De-Duplizierung, MBOX-Export und Aufbewahrungssperren</p>
          </div>
        </div>
        <button onClick={() => tab === 'searches' ? setCreateSearch(true) : setCreateHold(true)}
          className={`flex items-center gap-2 px-4 py-2 text-sm text-white rounded hover:opacity-90 ${
            tab === 'holds' ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent/90'
          }`}>
          <Plus size={15} /> {tab === 'searches' ? 'Neue Suche' : 'Neuer Legal Hold'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-4">
        {(['searches', 'holds'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t === 'searches' ? `Suchen (${searches.length})` : `Legal Holds (${holds.filter((h) => h.active).length} aktiv)`}
          </button>
        ))}
      </div>

      {/* Searches Tab */}
      {tab === 'searches' && (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="w-6 px-3 py-3" />
                <th className="text-left px-4 py-3">Suche</th>
                <th className="text-left px-4 py-3">Postfächer</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Ergebnisse</th>
                <th className="text-left px-4 py-3">Erstellt</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {searchLoading ? (
                <tr><td colSpan={7} className="text-center py-12 text-gray-400">Laden…</td></tr>
              ) : searches.length === 0 ? (
                <tr><td colSpan={7} className="text-center py-12 text-gray-400">Noch keine Suchen angelegt</td></tr>
              ) : searches.map((s) => [
                <tr key={s.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-3">
                    <button onClick={() => setExpandedSearch(expandedSearch === s.id ? null : s.id)}
                      className="text-gray-400 hover:text-gray-600">
                      {expandedSearch === s.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{s.name}</p>
                    {s.description && <p className="text-xs text-gray-500">{s.description}</p>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {s.mailboxIds.length === 0 ? <span className="italic text-gray-400">Alle</span> : `${s.mailboxIds.length}`}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                  <td className="px-4 py-3 text-gray-700 tabular-nums">
                    {s.status === 'COMPLETED' ? s.resultCount.toLocaleString('de-DE') : '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{fmtDate(s.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setPreview(s)}
                        className="p-1.5 text-gray-400 hover:text-accent hover:bg-blue-50 rounded" title="Vorschau">
                        <Eye size={13} />
                      </button>
                      {s.status !== 'RUNNING' && (
                        <button onClick={() => runSearch.mutate(s.id)}
                          className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded" title="Suche starten">
                          <Play size={13} />
                        </button>
                      )}
                      <button onClick={() => deleteSearch.mutate(s.id)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded" title="Löschen">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>,
                expandedSearch === s.id && (
                  <tr key={`${s.id}-details`}>
                    <td colSpan={7} className="p-0">
                      <div className="bg-gray-50 border-t border-gray-100 px-8 py-4">
                        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Suchkriterien</p>
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          {s.query.keywords && <div><span className="text-gray-500">Stichwörter:</span> <span className="text-gray-800">{s.query.keywords}</span></div>}
                          {s.query.subjectContains && <div><span className="text-gray-500">Betreff:</span> <span className="text-gray-800">{s.query.subjectContains}</span></div>}
                          {s.query.senderAddresses?.length ? <div><span className="text-gray-500">Absender:</span> <span className="text-gray-800">{s.query.senderAddresses.join(', ')}</span></div> : null}
                          {s.query.recipientAddresses?.length ? <div><span className="text-gray-500">Empfänger:</span> <span className="text-gray-800">{s.query.recipientAddresses.join(', ')}</span></div> : null}
                          {s.query.dateFrom && <div><span className="text-gray-500">Von:</span> <span className="text-gray-800">{new Date(s.query.dateFrom).toLocaleDateString('de-DE')}</span></div>}
                          {s.query.dateTo && <div><span className="text-gray-500">Bis:</span> <span className="text-gray-800">{new Date(s.query.dateTo).toLocaleDateString('de-DE')}</span></div>}
                          {s.query.hasAttachment !== undefined && (
                            <div><span className="text-gray-500">Anhang:</span> <span className="text-gray-800">{s.query.hasAttachment ? 'Mit' : 'Ohne'}</span></div>
                          )}
                        </div>
                        {s.mailboxIds.length > 0 && (
                          <div className="mt-3">
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Postfächer</p>
                            <div className="flex flex-wrap gap-1">
                              {s.mailboxIds.map((mid) => {
                                const mb = mailboxById.get(mid);
                                return (
                                  <span key={mid} className="text-xs bg-white border border-gray-200 rounded px-2 py-0.5 text-gray-700">
                                    {mb ? mb.email : mid.slice(0, 8)}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
      )}

      {/* Legal Holds Tab */}
      {tab === 'holds' && (
        <div className="space-y-3">
          {holdLoading ? (
            <p className="text-gray-400 text-center py-12">Laden…</p>
          ) : holds.length === 0 ? (
            <p className="text-gray-400 text-center py-12">Keine Legal Holds vorhanden</p>
          ) : holds.map((h) => (
            <div key={h.id} className={`bg-white rounded-lg border p-4 ${h.active ? 'border-red-200' : 'border-gray-200 opacity-60'}`}>
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Lock size={14} className={h.active ? 'text-red-500' : 'text-gray-400'} />
                    <span className="font-medium text-gray-900">{h.name}</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      h.active ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {h.active ? <><Check size={10} className="mr-1" /> Aktiv</> : 'Aufgehoben'}
                    </span>
                  </div>
                  {h.description && <p className="text-xs text-gray-500 mb-1">{h.description}</p>}
                  <p className="text-xs text-gray-500">
                    {h.mailboxIds.length} Postfächer gesperrt · Aktiviert {fmtDate(h.appliedAt)}
                    {h.releasedAt && ` · Aufgehoben ${fmtDate(h.releasedAt)}`}
                  </p>
                  {h.mailboxIds.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {h.mailboxIds.slice(0, 5).map((mid) => {
                        const mb = mailboxById.get(mid);
                        return (
                          <span key={mid} className="text-[11px] bg-gray-100 rounded px-1.5 py-0.5 text-gray-600">
                            {mb ? mb.email : mid.slice(0, 8)}
                          </span>
                        );
                      })}
                      {h.mailboxIds.length > 5 && (
                        <span className="text-[11px] text-gray-500">+ {h.mailboxIds.length - 5} weitere</span>
                      )}
                    </div>
                  )}
                </div>
                {h.active && (
                  <button onClick={() => releaseHold.mutate(h.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50 shrink-0 ml-3">
                    <Unlock size={12} /> Aufheben
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {createSearch && <CreateSearchModal onClose={() => setCreateSearch(false)} mailboxes={mailboxes} />}
      {createHold   && <CreateHoldModal   onClose={() => setCreateHold(false)}   mailboxes={mailboxes} />}
      {preview      && <PreviewModal      onClose={() => setPreview(null)} searchId={preview.id} searchName={preview.name} status={preview.status} />}
    </div>
  );
}
