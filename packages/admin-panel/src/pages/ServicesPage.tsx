import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Lock, LayoutGrid, Mail, Inbox, Archive, Loader2, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';

// ── Typen ─────────────────────────────────────────────────────────────────────
type ServiceKey = 'SMTP_RECEIVE' | 'IMAP' | 'POP3';
type NavView    = 'overview' | ServiceKey;

interface ServiceListener {
  id: string; service: ServiceKey; address: string; port: number;
  ssl: boolean; active: boolean; createdAt: string;
}

interface OverviewEntry { total: number; active: number }
type Overview = Record<ServiceKey, OverviewEntry>;

const SVC_SLUG: Record<ServiceKey, string> = {
  SMTP_RECEIVE: 'smtp-receive',
  IMAP:         'imap',
  POP3:         'pop3',
};

const SERVICES: { key: ServiceKey; label: string; ports: string; icon: React.ElementType }[] = [
  { key: 'SMTP_RECEIVE', label: 'SMTP Inbound', ports: '25 · 465 · 587', icon: Inbox   },
  { key: 'IMAP',         label: 'IMAP',          ports: '143 · 993',       icon: Mail    },
  { key: 'POP3',         label: 'POP3',          ports: '110 · 995',       icon: Archive },
];


// ── Listener Modal ─────────────────────────────────────────────────────────────
interface ListenerFormData { address: string; port: string; ssl: boolean; active: boolean }

function ListenerModal({ initial, onSave, onClose }: {
  initial?: Partial<ListenerFormData>;
  onSave:  (data: ListenerFormData) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ListenerFormData>({
    address: initial?.address ?? '0.0.0.0',
    port:    initial?.port    ?? '',
    ssl:     initial?.ssl     ?? false,
    active:  initial?.active  ?? true,
  });
  const set = (f: keyof ListenerFormData, v: string | boolean) =>
    setForm(prev => ({ ...prev, [f]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-4">
          {initial ? 'Listener bearbeiten' : 'Listener hinzufügen'}
        </h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">IP-Adresse</label>
            <input type="text" value={form.address} onChange={e => set('address', e.target.value)}
              placeholder="0.0.0.0"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
            <input type="number" value={form.port} onChange={e => set('port', e.target.value)}
              placeholder="25" min={1} max={65535}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-xs font-medium text-gray-600">SSL/TLS</span>
            <Toggle active={form.ssl}    onToggle={() => set('ssl',    !form.ssl)}    />
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-xs font-medium text-gray-600">Aktiv</span>
            <Toggle active={form.active} onToggle={() => set('active', !form.active)} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
            Abbrechen
          </button>
          <button onClick={() => {
            if (!form.port || isNaN(Number(form.port))) { toast.error('Bitte einen gültigen Port eingeben'); return; }
            onSave(form);
          }} className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Listener-Tabelle ──────────────────────────────────────────────────────────
function ListenersTable({ svcKey }: { svcKey: ServiceKey }) {
  const qc   = useQueryClient();
  const slug = SVC_SLUG[svcKey];
  const [modal, setModal] = useState<'add' | string | null>(null);

  const { data: listeners = [], isLoading } = useQuery<ServiceListener[]>({
    queryKey: ['service-listeners', svcKey],
    queryFn:  () => api.get<ServiceListener[]>(`/admin/services/listeners/${slug}`),
  });

  const editing = modal && modal !== 'add' ? listeners.find(l => l.id === modal) : null;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] });
    void qc.invalidateQueries({ queryKey: ['services-overview'] });
  };

  const addMut = useMutation({
    mutationFn: (d: ListenerFormData) => api.post(`/admin/services/listeners/${slug}`, {
      address: d.address, port: Number(d.port), ssl: d.ssl, active: d.active,
    }),
    onSuccess: () => { invalidate(); setModal(null); toast.success('Listener hinzugefügt'); },
    onError:   () => toast.error('Fehler beim Hinzufügen'),
  });

  const editMut = useMutation({
    mutationFn: ({ id, d }: { id: string; d: ListenerFormData }) => api.put(`/admin/services/listeners/${id}`, {
      address: d.address, port: Number(d.port), ssl: d.ssl, active: d.active,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }); setModal(null); toast.success('Gespeichert'); },
    onError:   () => toast.error('Fehler beim Speichern'),
  });

  const toggleMut = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/services/listeners/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }),
    onError:   () => toast.error('Fehler'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/services/listeners/${id}`),
    onSuccess: () => { invalidate(); toast.success('Gelöscht'); },
    onError:   () => toast.error('Fehler beim Löschen'),
  });

  const restoreMut = useMutation({
    mutationFn: () => api.post(`/admin/services/listeners/${slug}/restore-defaults`, {}),
    onSuccess: () => { invalidate(); toast.success('Standard-Ports wiederhergestellt'); },
    onError:   () => toast.error('Fehler beim Wiederherstellen der Standard-Ports'),
  });

  const svc = SERVICES.find(s => s.key === svcKey)!;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{svc.label}</h2>
          <p className="text-xs text-gray-400">Standard-Ports: {svc.ports}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (confirm(`Standard-Ports für ${svc.label} wiederherstellen?\n\nAlle bestehenden Listener werden gelöscht und durch die Standard-Ports (${svc.ports}) ersetzt.`)) {
                restoreMut.mutate();
              }
            }}
            disabled={restoreMut.isPending}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-colors disabled:opacity-50"
            title="Standard-Ports wiederherstellen"
          >
            {restoreMut.isPending
              ? <Loader2 size={14} className="animate-spin" />
              : <RotateCcw size={14} />
            }
            Standards
          </button>
          <button onClick={() => setModal('add')}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
            <Plus size={14} /> Listener hinzufügen
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 size={18} className="animate-spin mr-2" /> Lade…
        </div>
      ) : listeners.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-gray-400">
          <p className="text-sm">Keine Listener konfiguriert</p>
          <button onClick={() => setModal('add')} className="mt-3 text-blue-600 text-sm hover:underline">
            Ersten Listener hinzufügen
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-10">#</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Address:Port</th>
                <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {listeners.map((l, i) => (
                <tr key={l.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 text-gray-400 font-mono text-xs">{i + 1}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium text-gray-800">{l.address}:{l.port}</span>
                      {l.ssl && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200">
                          <Lock size={10} /> SSL
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Toggle active={l.active} onToggle={() => toggleMut.mutate(l.id)} />
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => setModal(l.id)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors border border-gray-200" title="Bearbeiten">
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => { if (confirm(`Listener ${l.address}:${l.port} löschen?`)) deleteMut.mutate(l.id); }}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors border border-gray-200" title="Löschen">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal === 'add' && <ListenerModal onSave={d => addMut.mutate(d)} onClose={() => setModal(null)} />}
      {modal && modal !== 'add' && editing && (
        <ListenerModal
          initial={{ address: editing.address, port: String(editing.port), ssl: editing.ssl, active: editing.active }}
          onSave={d => editMut.mutate({ id: modal, d })}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Übersicht ─────────────────────────────────────────────────────────────────
function Overview({ onSelect }: { onSelect: (k: ServiceKey) => void }) {
  const { data: overview, isLoading } = useQuery<Overview>({
    queryKey: ['services-overview'],
    queryFn:  () => api.get<Overview>('/admin/services/overview'),
  });

  return (
    <div className="p-6">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-gray-900">Services</h2>
        <p className="text-sm text-gray-500 mt-0.5">Protokoll-Listener — IP-Adressen und Ports der eingehenden Verbindungen</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 size={18} className="animate-spin mr-2" /> Lade…
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4 max-w-2xl">
          {SERVICES.map(({ key, label, ports, icon: Icon }) => {
            const entry = overview?.[key] ?? { total: 0, active: 0 };
            return (
              <button key={key} onClick={() => onSelect(key)}
                className="bg-white border border-gray-200 rounded-xl p-5 text-left hover:border-blue-400 hover:shadow-md transition-all group">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 bg-blue-50 rounded-lg group-hover:bg-blue-100 transition-colors">
                    <Icon size={18} className="text-blue-600" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-gray-800">{label}</p>
                    <p className="text-xs text-gray-400 font-mono">{ports}</p>
                  </div>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-gray-900">{entry.active}</span>
                  <span className="text-sm text-gray-400">/ {entry.total} aktiv</span>
                </div>
                <div className="mt-2">
                  <div className="w-full bg-gray-100 rounded-full h-1.5">
                    <div className="bg-blue-500 h-1.5 rounded-full"
                      style={{ width: entry.total ? `${(entry.active / entry.total) * 100}%` : '0%' }} />
                  </div>
                </div>
                <p className="text-xs text-blue-600 mt-3 font-medium group-hover:underline">Listener verwalten →</p>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-6 bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-2xl">
        <p className="text-xs text-blue-700">
          <strong>Hinweis:</strong> Änderungen (Hinzufügen, Bearbeiten, Löschen, Toggle) werden sofort wirksam —
          die Dienste laden ihre Listener-Konfiguration dynamisch neu ohne Container-Neustart.
        </p>
      </div>
    </div>
  );
}

// ── Haupt-Komponente ──────────────────────────────────────────────────────────
export function ServicesPage() {
  const [view, setView] = useState<NavView>('overview');

  return (
    <div className="h-full flex bg-gray-50">
      {/* Sub-Navigation */}
      <aside className="w-44 shrink-0 bg-[#1e2433] text-gray-300 flex flex-col">
        <div className="px-4 py-3 border-b border-white/10">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Services</p>
        </div>
        <nav className="flex-1 py-1">
          {([
            { key: 'overview'     as NavView, label: 'Übersicht',    icon: LayoutGrid },
            { key: 'SMTP_RECEIVE' as NavView, label: 'SMTP Inbound', icon: Inbox      },
            { key: 'IMAP'         as NavView, label: 'IMAP',         icon: Mail       },
            { key: 'POP3'         as NavView, label: 'POP3',         icon: Archive    },
          ] as const).map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => setView(key)}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors text-left ${
                view === key ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`}>
              <Icon size={13} />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Inhalt */}
      <div className="flex-1 overflow-y-auto">
        {view === 'overview'
          ? <Overview onSelect={k => setView(k)} />
          : <ListenersTable svcKey={view as ServiceKey} />
        }
      </div>
    </div>
  );
}
