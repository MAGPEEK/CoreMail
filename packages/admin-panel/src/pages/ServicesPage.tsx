import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Pencil, Trash2, Lock, LayoutGrid,
  Mail, Send, Inbox, Archive,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ── Typen ─────────────────────────────────────────────────────────────────────
type ServiceKey = 'SMTP_RECEIVE' | 'SMTP_SEND' | 'IMAP' | 'POP3';

interface ServiceListener {
  id:        string;
  service:   ServiceKey;
  address:   string;
  port:      number;
  ssl:       boolean;
  active:    boolean;
  createdAt: string;
}

interface OverviewEntry { total: number; active: number }
type Overview = Record<ServiceKey, OverviewEntry>;

// ── Sub-Navigations-Einträge ──────────────────────────────────────────────────
const NAV_ITEMS: { key: ServiceKey | 'overview'; label: string; slug: string; icon: React.ElementType }[] = [
  { key: 'overview',      label: 'Services Management', slug: 'overview',      icon: LayoutGrid },
  { key: 'SMTP_RECEIVE',  label: 'SMTP Receiving',      slug: 'smtp-receive',  icon: Inbox      },
  { key: 'SMTP_SEND',     label: 'SMTP Sending',        slug: 'smtp-send',     icon: Send       },
  { key: 'IMAP',          label: 'IMAP',                slug: 'imap',          icon: Mail       },
  { key: 'POP3',          label: 'POP3',                slug: 'pop3',          icon: Archive    },
];

const SVC_SLUG: Record<ServiceKey, string> = {
  SMTP_RECEIVE: 'smtp-receive',
  SMTP_SEND:    'smtp-send',
  IMAP:         'imap',
  POP3:         'pop3',
};

// ── Toggle-Schalter ───────────────────────────────────────────────────────────
function Toggle({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
        active ? 'bg-blue-600' : 'bg-gray-300'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          active ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

// ── Modal für Add/Edit Listener ───────────────────────────────────────────────
interface ListenerFormData { address: string; port: string; ssl: boolean; active: boolean }

function ListenerModal({
  initial,
  onSave,
  onClose,
}: {
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

  const handle = (field: keyof ListenerFormData, val: string | boolean) =>
    setForm(f => ({ ...f, [field]: val }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h3 className="text-base font-semibold text-gray-800 mb-4">
          {initial ? 'Listener bearbeiten' : 'Listener hinzufügen'}
        </h3>

        <div className="space-y-3">
          {/* Adresse */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">IP-Adresse</label>
            <input
              type="text"
              value={form.address}
              onChange={e => handle('address', e.target.value)}
              placeholder="0.0.0.0"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Port */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
            <input
              type="number"
              value={form.port}
              onChange={e => handle('port', e.target.value)}
              placeholder="25"
              min={1} max={65535}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* SSL */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-gray-600">SSL/TLS</span>
            <Toggle active={form.ssl} onToggle={() => handle('ssl', !form.ssl)} />
          </div>

          {/* Aktiv */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-gray-600">Aktiv</span>
            <Toggle active={form.active} onToggle={() => handle('active', !form.active)} />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
          >
            Abbrechen
          </button>
          <button
            onClick={() => {
              if (!form.port || isNaN(Number(form.port))) {
                toast.error('Bitte einen gültigen Port eingeben');
                return;
              }
              onSave(form);
            }}
            className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors"
          >
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Listeners-Tabelle ─────────────────────────────────────────────────────────
function ListenersTable({ svcKey, svcSlug }: { svcKey: ServiceKey; svcSlug: string }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState<'add' | string | null>(null); // null | 'add' | listener-id (edit)

  const { data: listeners = [], isLoading } = useQuery<ServiceListener[]>({
    queryKey: ['service-listeners', svcKey],
    queryFn:  () => api.get<ServiceListener[]>(`/admin/services/listeners/${svcSlug}`),
  });

  const editingListener = modal && modal !== 'add'
    ? listeners.find(l => l.id === modal)
    : null;

  const addMutation = useMutation({
    mutationFn: (data: ListenerFormData) =>
      api.post(`/admin/services/listeners/${svcSlug}`, {
        address: data.address,
        port:    Number(data.port),
        ssl:     data.ssl,
        active:  data.active,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] });
      void qc.invalidateQueries({ queryKey: ['services-overview'] });
      setModal(null);
      toast.success('Listener hinzugefügt');
    },
    onError: () => toast.error('Fehler beim Hinzufügen'),
  });

  const editMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ListenerFormData }) =>
      api.put(`/admin/services/listeners/${id}`, {
        address: data.address,
        port:    Number(data.port),
        ssl:     data.ssl,
        active:  data.active,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] });
      setModal(null);
      toast.success('Listener aktualisiert');
    },
    onError: () => toast.error('Fehler beim Aktualisieren'),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/services/listeners/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] }),
    onError:   () => toast.error('Fehler beim Umschalten'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/services/listeners/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['service-listeners', svcKey] });
      void qc.invalidateQueries({ queryKey: ['services-overview'] });
      toast.success('Listener gelöscht');
    },
    onError: () => toast.error('Fehler beim Löschen'),
  });

  return (
    <div className="flex flex-col h-full">
      {/* ── Kopfzeile ───────────────────────────── */}
      <div className="flex items-center justify-between px-8 py-5 border-b border-gray-200 bg-white">
        <h2 className="text-xl font-semibold text-gray-900">Listeners</h2>
        <button
          onClick={() => setModal('add')}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors"
        >
          <Plus size={15} />
          ADD LISTENER
        </button>
      </div>

      {/* ── Tabelle ─────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-8">
        {isLoading ? (
          <div className="flex justify-center py-16 text-gray-400 text-sm">Lade…</div>
        ) : listeners.length === 0 ? (
          <div className="flex flex-col items-center py-16 text-gray-400">
            <p className="text-sm">Keine Listener konfiguriert</p>
            <button
              onClick={() => setModal('add')}
              className="mt-3 text-blue-600 text-sm hover:underline"
            >
              Ersten Listener hinzufügen
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-12">#</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">ADDRESS:PORT</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">STATUS</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {listeners.map((l, i) => (
                  <tr key={l.id} className="hover:bg-gray-50 transition-colors">
                    {/* # */}
                    <td className="px-6 py-4 text-gray-500 font-mono text-xs">{i + 1}</td>

                    {/* ADDRESS:PORT */}
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium text-gray-800">
                          {l.address}:{l.port}
                        </span>
                        {l.ssl && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200">
                            <Lock size={10} />
                            SSL
                          </span>
                        )}
                      </div>
                    </td>

                    {/* STATUS — Toggle */}
                    <td className="px-6 py-4 text-right">
                      <Toggle
                        active={l.active}
                        onToggle={() => toggleMutation.mutate(l.id)}
                      />
                    </td>

                    {/* ACTIONS */}
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setModal(l.id)}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors border border-gray-200"
                          title="Bearbeiten"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`Listener ${l.address}:${l.port} wirklich löschen?`)) {
                              deleteMutation.mutate(l.id);
                            }
                          }}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors border border-gray-200"
                          title="Löschen"
                        >
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
      </div>

      {/* ── Modals ─────────────────────────────── */}
      {modal === 'add' && (
        <ListenerModal
          onSave={data => addMutation.mutate(data)}
          onClose={() => setModal(null)}
        />
      )}
      {modal && modal !== 'add' && editingListener && (
        <ListenerModal
          initial={{
            address: editingListener.address,
            port:    String(editingListener.port),
            ssl:     editingListener.ssl,
            active:  editingListener.active,
          }}
          onSave={data => editMutation.mutate({ id: modal, data })}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Übersichts-Karte ─────────────────────────────────────────────────────────
function OverviewCard({
  label,
  icon: Icon,
  entry,
  onClick,
}: {
  label:   string;
  icon:    React.ElementType;
  entry:   OverviewEntry;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="bg-white border border-gray-200 rounded-lg p-5 text-left hover:border-blue-400 hover:shadow-md transition-all group"
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="p-2 bg-blue-50 rounded-lg group-hover:bg-blue-100 transition-colors">
          <Icon size={18} className="text-blue-600" />
        </div>
        <span className="text-sm font-semibold text-gray-800">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-gray-900">{entry.active}</span>
        <span className="text-sm text-gray-400">/ {entry.total} Listener</span>
      </div>
      <div className="mt-2">
        <div className="w-full bg-gray-100 rounded-full h-1.5">
          <div
            className="bg-blue-500 h-1.5 rounded-full transition-all"
            style={{ width: entry.total ? `${(entry.active / entry.total) * 100}%` : '0%' }}
          />
        </div>
      </div>
      <p className="text-xs text-blue-600 mt-3 font-medium group-hover:underline">
        Listener verwalten →
      </p>
    </button>
  );
}

// ── Overview-Seite ────────────────────────────────────────────────────────────
function OverviewPage({ onSelect }: { onSelect: (key: ServiceKey) => void }) {
  const { data: overview, isLoading } = useQuery<Overview>({
    queryKey: ['services-overview'],
    queryFn:  () => api.get<Overview>('/admin/services/overview'),
  });

  const CARDS: { key: ServiceKey; label: string; icon: React.ElementType }[] = [
    { key: 'SMTP_RECEIVE', label: 'SMTP Receiving', icon: Inbox  },
    { key: 'SMTP_SEND',    label: 'SMTP Sending',   icon: Send   },
    { key: 'IMAP',         label: 'IMAP',           icon: Mail   },
    { key: 'POP3',         label: 'POP3',           icon: Archive},
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-8 py-5 border-b border-gray-200 bg-white">
        <h2 className="text-xl font-semibold text-gray-900">Services Management</h2>
        <p className="text-sm text-gray-500 mt-0.5">Übersicht aller konfigurierten Protokoll-Services und Listener</p>
      </div>
      <div className="flex-1 p-8">
        {isLoading ? (
          <div className="flex justify-center py-16 text-gray-400 text-sm">Lade…</div>
        ) : (
          <div className="grid grid-cols-2 gap-4 max-w-2xl">
            {CARDS.map(({ key, label, icon }) => (
              <OverviewCard
                key={key}
                label={label}
                icon={icon}
                entry={overview?.[key] ?? { total: 0, active: 0 }}
                onClick={() => onSelect(key)}
              />
            ))}
          </div>
        )}

        {/* Info-Box */}
        <div className="mt-8 bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-2xl">
          <p className="text-xs text-blue-700">
            <strong>Hinweis:</strong> Listener-Änderungen werden in der Datenbank gespeichert.
            Die tatsächlich lauschenden Ports werden durch die Dienst-Konfiguration (supervisord / Docker) bestimmt.
            Verwende diese Verwaltung um die geplante Konfiguration zu dokumentieren.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Haupt-Komponente ──────────────────────────────────────────────────────────
export function ServicesPage() {
  const [activeKey, setActiveKey] = useState<ServiceKey | 'overview'>('overview');

  return (
    <div className="h-full flex bg-gray-50">
      {/* ── Linke Sub-Navigation (dunkel, wie im Screenshot) ─── */}
      <aside className="w-52 shrink-0 bg-[#1e2433] text-gray-300 flex flex-col">
        <div className="px-4 py-3 border-b border-white/10">
          <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Services</p>
        </div>
        <nav className="flex-1 py-1">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => {
            const isActive = key === activeKey;
            return (
              <button
                key={key}
                onClick={() => setActiveKey(key)}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors text-left ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* ── Rechter Inhaltsbereich ───────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {activeKey === 'overview' ? (
          <OverviewPage onSelect={k => setActiveKey(k)} />
        ) : (
          <ListenersTable
            svcKey={activeKey}
            svcSlug={SVC_SLUG[activeKey]}
          />
        )}
      </div>
    </div>
  );
}
