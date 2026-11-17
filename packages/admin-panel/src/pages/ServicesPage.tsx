import { useId, useState } from 'react';
import { Modal } from '../components/Modal.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Lock, LayoutGrid, Mail, Inbox, Archive, Loader2, Network } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';
import { Can } from '../components/Can.js';
import { ProtocolAccessEditor } from '../components/ProtocolAccessEditor.js';
import { errorMessage } from '../lib/errors.js';
import { useT } from '../i18n/useT.js';

// ── Types ─────────────────────────────────────────────────────────────────────
type ServiceKey = 'SMTP_RECEIVE' | 'IMAP' | 'POP3';
/** 9.4: 'protocols' = server level of the per-protocol access switches. */
type NavView    = 'overview' | 'protocols' | ServiceKey;

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

function ListenerModal({ initial, onSave, onClose, saving }: {
  initial?: Partial<ListenerFormData>;
  onSave:  (data: ListenerFormData) => void;
  onClose: () => void;
  saving:  boolean;
}) {
  const [form, setForm] = useState<ListenerFormData>({
    address: initial?.address ?? '0.0.0.0',
    port:    initial?.port    ?? '',
    ssl:     initial?.ssl     ?? false,
    active:  initial?.active  ?? true,
  });
  const set = (f: keyof ListenerFormData, v: string | boolean) =>
    setForm(prev => ({ ...prev, [f]: v }));

  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}

      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40"
      className="bg-surface rounded-xl shadow-2xl w-full max-w-sm p-6"
    >
        <h3 id={titleId} className="text-base font-semibold text-fg mb-4">
          {initial ? 'Listener bearbeiten' : 'Listener hinzufügen'}
        </h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">IP-Adresse</label>
            <input type="text" value={form.address} onChange={e => set('address', e.target.value)}
              placeholder="0.0.0.0"
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg" />
            <p className="text-[11px] text-fg-subtle mt-1">0.0.0.0 = alle Schnittstellen. Eine feste IP muss auf dem Server existieren.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">Port</label>
            <input type="number" value={form.port} onChange={e => set('port', e.target.value)}
              placeholder="25" min={1} max={65535}
              className="w-full border border-line-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg" />
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-xs font-medium text-fg-muted">SSL/TLS (implizit, z. B. 465/993/995) — aus = STARTTLS</span>
            <Toggle active={form.ssl}    onToggle={() => set('ssl',    !form.ssl)}    />
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-xs font-medium text-fg-muted">Aktiv</span>
            <Toggle active={form.active} onToggle={() => set('active', !form.active)} />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-fg-muted bg-surface-2 rounded-lg hover:bg-surface-3 transition-colors">
            Abbrechen
          </button>
          <button disabled={saving} onClick={() => {
            const port = Number(form.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) { toast.error('Bitte einen gültigen Port (1–65535) eingeben'); return; }
            if (!form.address.trim()) { toast.error('Bitte eine IP-Adresse eingeben (0.0.0.0 = alle)'); return; }
            onSave({ ...form, address: form.address.trim() });
          }} className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50">
            {saving ? 'Speichern…' : 'Speichern'}
          </button>
        </div>
    </Modal>
  );
}

// ── Listener table ────────────────────────────────────────────────────────────
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
    onError:   (e) => toast.error(`Fehler beim Hinzufügen: ${errorMessage(e)}`),
  });

  const editMut = useMutation({
    mutationFn: ({ id, d }: { id: string; d: ListenerFormData }) => api.put(`/admin/services/listeners/${id}`, {
      address: d.address, port: Number(d.port), ssl: d.ssl, active: d.active,
    }),
    onSuccess: () => { invalidate(); setModal(null); toast.success('Gespeichert'); },
    onError:   (e) => toast.error(`Fehler beim Speichern: ${errorMessage(e)}`),
  });

  const toggleMut = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/services/listeners/${id}/toggle`, {}),
    onSuccess: () => invalidate(),
    onError:   (e) => toast.error(`Umschalten fehlgeschlagen: ${errorMessage(e)}`),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/services/listeners/${id}`),
    onSuccess: () => { invalidate(); toast.success('Gelöscht'); },
    onError:   (e) => toast.error(`Fehler beim Löschen: ${errorMessage(e)}`),
  });

  const svc = SERVICES.find(s => s.key === svcKey)!;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-lg font-semibold text-fg">{svc.label}</h2>
          <p className="text-xs text-fg-subtle">Standard-Ports: {svc.ports}</p>
        </div>
        <Can area="servers" access="write">
          <button onClick={() => setModal('add')}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
            <Plus size={14} /> Listener hinzufügen
          </button>
        </Can>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-fg-subtle">
          <Loader2 size={18} className="animate-spin mr-2" /> Lade…
        </div>
      ) : listeners.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-fg-subtle">
          <p className="text-sm">Keine Listener konfiguriert</p>
          <Can area="servers" access="write" mode="hide">
            <button onClick={() => setModal('add')} className="mt-3 text-accent-fg text-sm hover:underline">
              Ersten Listener hinzufügen
            </button>
          </Can>
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-line overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2 border-b border-line">
                <th className="text-left px-6 py-3 text-xs font-semibold text-fg-subtle uppercase tracking-wide w-10">#</th>
                <th className="text-left px-6 py-3 text-xs font-semibold text-fg-subtle uppercase tracking-wide">Address:Port</th>
                <th className="text-right px-6 py-3 text-xs font-semibold text-fg-subtle uppercase tracking-wide">Status</th>
                <th className="text-right px-6 py-3 text-xs font-semibold text-fg-subtle uppercase tracking-wide">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {listeners.map((l, i) => (
                <tr key={l.id} className="hover:bg-surface-2 transition-colors">
                  <td className="px-6 py-4 text-fg-subtle font-mono text-xs">{i + 1}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium text-fg">{l.address}:{l.port}</span>
                      {l.ssl && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-surface-2 text-fg-muted border border-line">
                          <Lock size={10} /> SSL
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Can area="servers" access="write">
                      <Toggle active={l.active} onToggle={() => { if (!toggleMut.isPending) toggleMut.mutate(l.id); }} />
                    </Can>
                  </td>
                  <td className="px-6 py-4">
                    <Can area="servers" access="write" mode="hide">
                    <div className="flex items-center justify-end gap-2">
                      <button aria-label="Bearbeiten" onClick={() => setModal(l.id)}
                        className="p-1.5 text-fg-subtle hover:text-info-fg hover:bg-info-bg rounded transition-colors border border-line" title="Bearbeiten">
                        <Pencil size={14} />
                      </button>
                      <button aria-label="Löschen" onClick={() => { if (confirm(`Listener ${l.address}:${l.port} löschen?`)) deleteMut.mutate(l.id); }}
                        className="p-1.5 text-fg-subtle hover:text-danger-fg hover:bg-danger-bg rounded transition-colors border border-line" title="Löschen">
                        <Trash2 size={14} />
                      </button>
                    </div>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal === 'add' && <ListenerModal saving={addMut.isPending} onSave={d => addMut.mutate(d)} onClose={() => setModal(null)} />}
      {modal && modal !== 'add' && editing && (
        <ListenerModal
          initial={{ address: editing.address, port: String(editing.port), ssl: editing.ssl, active: editing.active }}
          saving={editMut.isPending}
          onSave={d => editMut.mutate({ id: modal, d })}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────────────────────
function Overview({ onSelect }: { onSelect: (k: ServiceKey) => void }) {
  const { data: overview, isLoading } = useQuery<Overview>({
    queryKey: ['services-overview'],
    queryFn:  () => api.get<Overview>('/admin/services/overview'),
  });

  return (
    <div className="p-6">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-fg">Services</h2>
        <p className="text-sm text-fg-subtle mt-0.5">Protokoll-Listener — IP-Adressen und Ports der eingehenden Verbindungen</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-fg-subtle">
          <Loader2 size={18} className="animate-spin mr-2" /> Lade…
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4 max-w-2xl">
          {SERVICES.map(({ key, label, ports, icon: Icon }) => {
            const entry = overview?.[key] ?? { total: 0, active: 0 };
            return (
              <button key={key} onClick={() => onSelect(key)}
                className="bg-surface border border-line rounded-xl p-5 text-left hover:border-info-line hover:shadow-md transition-all group">
                <div className="flex items-center gap-3 mb-4">
                  <div className="p-2 bg-info-bg rounded-lg group-hover:bg-info-bg transition-colors">
                    <Icon size={18} className="text-info-fg" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-fg">{label}</p>
                    <p className="text-xs text-fg-subtle font-mono">{ports}</p>
                  </div>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-2xl font-bold text-fg">{entry.active}</span>
                  <span className="text-sm text-fg-subtle">/ {entry.total} aktiv</span>
                </div>
                <div className="mt-2">
                  <div className="w-full bg-surface-2 rounded-full h-1.5">
                    <div className="bg-blue-500 h-1.5 rounded-full"
                      style={{ width: entry.total ? `${(entry.active / entry.total) * 100}%` : '0%' }} />
                  </div>
                </div>
                <p className="text-xs text-accent-fg mt-3 font-medium group-hover:underline">Listener verwalten →</p>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-6 bg-info-bg border border-info-line rounded-lg p-4 max-w-2xl">
        <p className="text-xs text-info-fg">
          <strong>Hinweis:</strong> Änderungen (Hinzufügen, Bearbeiten, Löschen, Toggle) werden sofort wirksam —
          die Dienste laden ihre Listener-Konfiguration dynamisch neu ohne Container-Neustart. Ändert sich SSL/TLS oder
          die IP-Adresse eines laufenden Ports, wird nur dieser Port kurz neu gestartet (offene Verbindungen werden getrennt).
        </p>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function ServicesPage() {
  const t = useT();
  const [view, setView] = useState<NavView>('overview');

  return (
    <div className="h-full flex bg-surface-2">
      {/* Sub-Navigation */}
      <aside className="w-44 shrink-0 bg-surface-2 border-r border-line text-fg-muted flex flex-col">
        <div className="px-4 py-3 border-b border-line">
          <p className="text-[10px] font-bold text-fg-subtle uppercase tracking-widest">Services</p>
        </div>
        <nav className="flex-1 py-1">
          {([
            { key: 'overview'     as NavView, label: 'Übersicht',    icon: LayoutGrid },
            { key: 'SMTP_RECEIVE' as NavView, label: 'SMTP Inbound', icon: Inbox      },
            { key: 'IMAP'         as NavView, label: 'IMAP',         icon: Mail       },
            { key: 'POP3'         as NavView, label: 'POP3',         icon: Archive    },
            { key: 'protocols'    as NavView, label: t('proto_title'), icon: Network },
          ] as const).map(({ key, label, icon: Icon }) => (
            <button key={key} onClick={() => setView(key)}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors text-left ${
                view === key ? 'bg-surface-3 text-fg border-l-2 border-accent-fg' : 'text-fg-muted hover:bg-surface-3'
              }`}>
              <Icon size={13} />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {view === 'overview'
          ? <Overview onSelect={k => setView(k)} />
          : view === 'protocols'
            ? <div className="p-6 max-w-2xl"><ProtocolAccessEditor path="/admin/protocol-access" area="servers" /></div>
            : <ListenersTable svcKey={view} />
        }
      </div>
    </div>
  );
}
