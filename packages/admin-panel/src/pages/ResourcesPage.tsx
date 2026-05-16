import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, MonitorSpeaker, Plus, Pencil, Trash2, CalendarX, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Resource {
  id: string;
  email: string;
  displayName: string;
  resourceType: 'ROOM' | 'EQUIPMENT';
  active: boolean;
  capacity?: number;
  location: string;
  phone: string;
  autoAccept: boolean;
  autoDeclineConflict: boolean;
  allowRecurring: boolean;
  maxDurationMinutes?: number;
  bookingWindowDays: number;
  requireApproval: boolean;
  delegateIds: string[];
  domainId: string;
}

interface Booking {
  id: string;
  dtStart: string;
  dtEnd: string;
  status: string;
  organizerEmail: string;
  subject: string;
}

interface Domain { id: string; name: string; }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ResourceIcon({ type, size = 16 }: { type: 'ROOM' | 'EQUIPMENT'; size?: number }) {
  return type === 'ROOM'
    ? <Building2 size={size} className="text-blue-500" />
    : <MonitorSpeaker size={size} className="text-purple-500" />;
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
      active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
    }`}>
      {active ? 'Aktiv' : 'Inaktiv'}
    </span>
  );
}

function BookingStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    ACCEPTED:  'bg-green-100 text-green-700',
    DECLINED:  'bg-red-100 text-red-700',
    PENDING:   'bg-yellow-100 text-yellow-700',
    TENTATIVE: 'bg-blue-100 text-blue-700',
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${map[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

function fmtDt(iso: string) {
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Bookings Panel ───────────────────────────────────────────────────────────

function BookingsPanel({ resource }: { resource: Resource }) {
  const qc = useQueryClient();
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30); d.setHours(23, 59, 59, 0);
    return d.toISOString().slice(0, 10);
  });

  const { data: bookings = [] } = useQuery<Booking[]>({
    queryKey: ['admin-resource-bookings', resource.id, from, to],
    queryFn: () => api.get(`/admin/resources/${resource.id}/bookings?from=${from}T00:00:00Z&to=${to}T23:59:59Z`),
  });

  const cancelBooking = useMutation({
    mutationFn: (bookingId: string) => api.delete(`/admin/resources/${resource.id}/bookings/${bookingId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-resource-bookings', resource.id] });
      toast.success('Buchung storniert');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="border-t border-gray-100 bg-gray-50 px-6 py-4">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
        Buchungen
      </h3>

      {/* Date range filter */}
      <div className="flex gap-2 items-center mb-3">
        <label className="text-xs text-gray-600">Von</label>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent" />
        <label className="text-xs text-gray-600">Bis</label>
        <input type="date" value={to} onChange={e => setTo(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-accent" />
      </div>

      {bookings.length === 0 ? (
        <p className="text-sm text-gray-400 italic">Keine Buchungen im gewählten Zeitraum</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-200">
              <th className="text-left pb-1 pr-4">Zeitraum</th>
              <th className="text-left pb-1 pr-4">Organisator</th>
              <th className="text-left pb-1 pr-4">Betreff</th>
              <th className="text-left pb-1 pr-4">Status</th>
              <th className="pb-1" />
            </tr>
          </thead>
          <tbody>
            {bookings.map(b => (
              <tr key={b.id} className="border-b border-gray-100 hover:bg-white group">
                <td className="py-1.5 pr-4 whitespace-nowrap text-gray-700">
                  {fmtDt(b.dtStart)} – {fmtDt(b.dtEnd)}
                </td>
                <td className="py-1.5 pr-4 text-gray-600">{b.organizerEmail}</td>
                <td className="py-1.5 pr-4 text-gray-700 max-w-[200px] truncate">{b.subject}</td>
                <td className="py-1.5 pr-4"><BookingStatusBadge status={b.status} /></td>
                <td className="py-1.5">
                  <button onClick={() => cancelBooking.mutate(b.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-600 transition-opacity"
                    title="Stornieren">
                    <CalendarX size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Resource Form Modal ──────────────────────────────────────────────────────

interface ResourceFormData {
  email: string;
  displayName: string;
  resourceType: 'ROOM' | 'EQUIPMENT';
  domainId: string;
  location: string;
  phone: string;
  capacity: string;
  autoAccept: boolean;
  autoDeclineConflict: boolean;
  allowRecurring: boolean;
  maxDurationMinutes: string;
  bookingWindowDays: string;
  requireApproval: boolean;
}

function ResourceModal({
  resource, domains, onClose,
}: {
  resource: Resource | null;
  domains: Domain[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = resource !== null;

  const [form, setForm] = useState<ResourceFormData>({
    email: resource?.email ?? '',
    displayName: resource?.displayName ?? '',
    resourceType: resource?.resourceType ?? 'ROOM',
    domainId: resource?.domainId ?? (domains[0]?.id ?? ''),
    location: resource?.location ?? '',
    phone: resource?.phone ?? '',
    capacity: resource?.capacity?.toString() ?? '',
    autoAccept: resource?.autoAccept ?? true,
    autoDeclineConflict: resource?.autoDeclineConflict ?? true,
    allowRecurring: resource?.allowRecurring ?? true,
    maxDurationMinutes: resource?.maxDurationMinutes?.toString() ?? '',
    bookingWindowDays: resource?.bookingWindowDays?.toString() ?? '180',
    requireApproval: resource?.requireApproval ?? false,
  });

  const set = <K extends keyof ResourceFormData>(k: K, v: ResourceFormData[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        displayName: form.displayName,
        location: form.location,
        phone: form.phone,
        ...(form.capacity ? { capacity: parseInt(form.capacity) } : {}),
        autoAccept: form.autoAccept,
        autoDeclineConflict: form.autoDeclineConflict,
        allowRecurring: form.allowRecurring,
        ...(form.maxDurationMinutes ? { maxDurationMinutes: parseInt(form.maxDurationMinutes) } : {}),
        bookingWindowDays: parseInt(form.bookingWindowDays),
        requireApproval: form.requireApproval,
      };
      return isEdit
        ? api.put(`/admin/resources/${resource.id}`, body)
        : api.post('/admin/resources', {
            ...body, email: form.email, domainId: form.domainId, resourceType: form.resourceType,
          });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-resources'] });
      toast.success(isEdit ? 'Ressource aktualisiert' : 'Ressource erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            {isEdit ? 'Ressource bearbeiten' : 'Neue Ressource'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Typ (nur bei Neu) */}
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Typ</label>
              <div className="flex gap-4">
                {(['ROOM', 'EQUIPMENT'] as const).map(t => (
                  <label key={t} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={form.resourceType === t}
                      onChange={() => set('resourceType', t)} className="accent-accent" />
                    <ResourceIcon type={t} size={14} />
                    <span className="text-sm text-gray-700">{t === 'ROOM' ? 'Raum' : 'Gerät/Equipment'}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* E-Mail + Domain (nur bei Neu) */}
          {!isEdit && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">E-Mail</label>
                <input value={form.email} onChange={e => set('email', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                  placeholder="konferenz-a@domain.com" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Domain</label>
                <select value={form.domainId} onChange={e => set('domainId', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                  {domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Anzeigename */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Anzeigename</label>
            <input value={form.displayName} onChange={e => set('displayName', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. Konferenzraum A" />
          </div>

          {/* Location + Phone */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Standort</label>
              <input value={form.location} onChange={e => set('location', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="Gebäude 2, EG" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Telefon</label>
              <input value={form.phone} onChange={e => set('phone', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="+49 89 …" />
            </div>
          </div>

          {/* Kapazität (nur ROOM) + Buchungsfenster */}
          <div className="grid grid-cols-3 gap-3">
            {form.resourceType === 'ROOM' && (
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Kapazität (Pers.)</label>
                <input type="number" min="1" value={form.capacity} onChange={e => set('capacity', e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                  placeholder="10" />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Max. Dauer (min)</label>
              <input type="number" min="1" value={form.maxDurationMinutes} onChange={e => set('maxDurationMinutes', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="unbegrenzt" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Buchungsfenster (Tage)</label>
              <input type="number" min="1" value={form.bookingWindowDays} onChange={e => set('bookingWindowDays', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
            </div>
          </div>

          {/* Optionen */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-gray-700">Buchungsverhalten</label>
            {([
              ['autoAccept',           'Anfragen automatisch annehmen'],
              ['autoDeclineConflict',  'Konflikte automatisch ablehnen'],
              ['allowRecurring',       'Wiederkehrende Termine erlauben'],
              ['requireApproval',      'Genehmigung durch Delegierten erforderlich'],
            ] as [keyof ResourceFormData, string][]).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={form[k] as boolean}
                  onChange={e => set(k, e.target.checked)}
                  className="accent-accent" />
                <span className="text-sm text-gray-700">{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">
            Abbrechen
          </button>
          <button onClick={() => save.mutate()} disabled={save.isPending}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function ResourcesPage() {
  const qc = useQueryClient();
  const [typeTab, setTypeTab] = useState<'ROOM' | 'EQUIPMENT'>('ROOM');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'create' | Resource | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Resource | null>(null);

  const { data: resources = [], isLoading } = useQuery<Resource[]>({
    queryKey: ['admin-resources'],
    queryFn: () => api.get('/admin/resources'),
  });

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['admin-domains-list'],
    queryFn: () => api.get('/admin/domains?limit=200'),
    select: (d: unknown) => {
      if (Array.isArray(d)) return d as Domain[];
      if (d && typeof d === 'object' && 'domains' in d) return (d as { domains: Domain[] }).domains;
      return [];
    },
  });

  const toggleActive = useMutation({
    mutationFn: (r: Resource) => api.put(`/admin/resources/${r.id}`, { active: !r.active }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-resources'] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteResource = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/resources/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-resources'] });
      toast.success('Ressource gelöscht');
      setDeleteConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rooms = resources.filter(r => r.resourceType === 'ROOM');
  const equipment = resources.filter(r => r.resourceType === 'EQUIPMENT');
  const filtered = (typeTab === 'ROOM' ? rooms : equipment).filter(r =>
    !search || r.displayName.toLowerCase().includes(search.toLowerCase()) ||
    r.email.toLowerCase().includes(search.toLowerCase()) ||
    r.location.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Building2 size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Ressourcenpostfächer</h1>
            <p className="text-sm text-gray-500">
              {rooms.length} Räume · {equipment.length} Geräte
            </p>
          </div>
        </div>
        <button onClick={() => setModal('create')}
          className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
          <Plus size={15} /> Neue Ressource
        </button>
      </div>

      {/* Tabs + Search */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex border border-gray-300 rounded overflow-hidden text-sm">
          {(['ROOM', 'EQUIPMENT'] as const).map(t => (
            <button key={t} onClick={() => setTypeTab(t)}
              className={`flex items-center gap-1.5 px-4 py-1.5 ${typeTab === t ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
              <ResourceIcon type={t} size={13} />
              {t === 'ROOM' ? `Räume (${rooms.length})` : `Geräte (${equipment.length})`}
            </button>
          ))}
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 max-w-xs border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder="Suchen…" />
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="w-6 px-3 py-3" />
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Ressource</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Standort</th>
              {typeTab === 'ROOM' && (
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Kapazität</th>
              )}
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Auto-Accept</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400">Laden…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400">
                Keine {typeTab === 'ROOM' ? 'Räume' : 'Geräte'} gefunden
              </td></tr>
            ) : filtered.map(r => (
              <>
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                  {/* Expand */}
                  <td className="px-3 py-3">
                    <button onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                      className="text-gray-400 hover:text-gray-600">
                      {expanded === r.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  {/* Name + Email */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ResourceIcon type={r.resourceType} size={14} />
                      <div>
                        <p className="font-medium text-gray-900">{r.displayName}</p>
                        <p className="text-xs text-gray-500">{r.email}</p>
                      </div>
                    </div>
                  </td>
                  {/* Location */}
                  <td className="px-4 py-3 text-gray-600">{r.location || '—'}</td>
                  {/* Capacity (rooms only) */}
                  {typeTab === 'ROOM' && (
                    <td className="px-4 py-3 text-gray-700">
                      {r.capacity ? `${r.capacity} Pers.` : '—'}
                    </td>
                  )}
                  {/* Auto-Accept */}
                  <td className="px-4 py-3">
                    {r.autoAccept
                      ? <span className="text-xs text-green-600">✓ Automatisch</span>
                      : <span className="text-xs text-gray-400">Manuell</span>}
                  </td>
                  {/* Status */}
                  <td className="px-4 py-3">
                    <button onClick={() => toggleActive.mutate(r)}>
                      <StatusBadge active={r.active} />
                    </button>
                  </td>
                  {/* Actions */}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setModal(r)}
                        className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded" title="Bearbeiten">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => setDeleteConfirm(r)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded" title="Löschen">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
                {/* Bookings Panel */}
                {expanded === r.id && (
                  <tr key={`${r.id}-bookings`}>
                    <td colSpan={typeTab === 'ROOM' ? 7 : 6} className="p-0">
                      <BookingsPanel resource={r} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {/* Resource Modal */}
      {modal !== null && (
        <ResourceModal
          resource={modal === 'create' ? null : modal}
          domains={domains}
          onClose={() => setModal(null)}
        />
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Ressource löschen</h2>
            <p className="text-sm text-gray-600 mb-4">
              Soll <strong>{deleteConfirm.displayName}</strong> ({deleteConfirm.email}) wirklich gelöscht werden?
              Alle Buchungen werden ebenfalls entfernt.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
              <button onClick={() => deleteResource.mutate(deleteConfirm.id)} disabled={deleteResource.isPending}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50">
                {deleteResource.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
