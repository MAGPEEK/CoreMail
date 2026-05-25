import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookUser, Plus, Pencil, Trash2, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

interface ExternalContact {
  id: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  company: string;
  department: string;
  phone: string;
  mobile: string;
  hiddenFromGal: boolean;
  notes: string;
}

interface ContactsResponse { contacts: ExternalContact[]; total: number; }

// ─── Form Modal ───────────────────────────────────────────────────────────────

type FormData = Omit<ExternalContact, 'id'>;

function ContactModal({ contact, onClose }: { contact: ExternalContact | null; onClose: () => void }) {
  const qc = useQueryClient();
  const isEdit = contact !== null;

  const [form, setForm] = useState<FormData>({
    email:         contact?.email ?? '',
    displayName:   contact?.displayName ?? '',
    firstName:     contact?.firstName ?? '',
    lastName:      contact?.lastName ?? '',
    company:       contact?.company ?? '',
    department:    contact?.department ?? '',
    phone:         contact?.phone ?? '',
    mobile:        contact?.mobile ?? '',
    hiddenFromGal: contact?.hiddenFromGal ?? false,
    notes:         contact?.notes ?? '',
  });

  const set = <K extends keyof FormData>(k: K, v: FormData[K]) => setForm(f => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => isEdit
      ? api.put(`/admin/contacts/${contact.id}`, form)
      : api.post('/admin/contacts', form),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ext-contacts'] });
      toast.success(isEdit ? 'Kontakt aktualisiert' : 'Kontakt erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Inline-Helper-DIV statt eigener Field-Komponente — letztere würde bei jedem
  // Render eine neue Component-Referenz erzeugen → React unmount+remount des Inputs
  // → Cursor verloren (bekanntes Problem, siehe v3.17.44 Fix bei eDiscovery).

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            {isEdit ? 'Kontakt bearbeiten' : 'Neuer externer Kontakt'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Anzeigename *</label>
            <input value={form.displayName} onChange={e => set('displayName', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="Max Mustermann" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">E-Mail-Adresse *</label>
            <input value={form.email} onChange={e => set('email', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="max@extern.com" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Unternehmen</label>
              <input value={form.company} onChange={e => set('company', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="Acme GmbH" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Abteilung</label>
              <input value={form.department} onChange={e => set('department', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="Vertrieb" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Telefon</label>
              <input value={form.phone} onChange={e => set('phone', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="+49 89 …" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Mobil</label>
              <input value={form.mobile} onChange={e => set('mobile', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="+49 170 …" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Notizen</label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)}
              rows={2} className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.hiddenFromGal} onChange={e => set('hiddenFromGal', e.target.checked)}
              className="accent-accent" />
            <span className="text-sm text-gray-700">In der Globalen Adressliste (GAL) ausblenden</span>
          </label>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.email || !form.displayName}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            {save.isPending ? 'Speichern…' : isEdit ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function ExternalContactsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<'create' | ExternalContact | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<ExternalContact | null>(null);

  const { data, isLoading } = useQuery<ContactsResponse>({
    queryKey: ['admin-ext-contacts', search],
    queryFn: () => api.get(`/admin/contacts?search=${encodeURIComponent(search)}&limit=200`),
  });

  const contacts = data?.contacts ?? [];

  const deleteContact = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/contacts/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ext-contacts'] });
      toast.success('Kontakt gelöscht');
      setDeleteConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <BookUser size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Externe Kontakte</h1>
            <p className="text-sm text-gray-500">E-Mail-Kontakte die in der GAL erscheinen</p>
          </div>
        </div>
        <button onClick={() => setModal('create')}
          className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
          <Plus size={15} /> Neuer Kontakt
        </button>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 mb-4 bg-white border border-gray-300 rounded px-3 py-1.5 w-full max-w-sm">
        <Search size={14} className="text-gray-400" />
        <input value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 text-sm focus:outline-none"
          placeholder="Name, E-Mail oder Unternehmen…" />
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3">Name</th>
              <th className="text-left px-4 py-3">E-Mail</th>
              <th className="text-left px-4 py-3">Unternehmen</th>
              <th className="text-left px-4 py-3">Telefon</th>
              <th className="text-left px-4 py-3">GAL</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="text-center py-12 text-gray-400">Laden…</td></tr>
            ) : contacts.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-12 text-gray-400">
                {search ? 'Keine Kontakte gefunden' : 'Noch keine externen Kontakte angelegt'}
              </td></tr>
            ) : contacts.map(c => (
              <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900">{c.displayName}</p>
                  {c.department && <p className="text-xs text-gray-500">{c.department}</p>}
                </td>
                <td className="px-4 py-3 text-gray-700">{c.email}</td>
                <td className="px-4 py-3 text-gray-600">{c.company || '—'}</td>
                <td className="px-4 py-3 text-gray-600">{c.phone || c.mobile || '—'}</td>
                <td className="px-4 py-3">
                  {c.hiddenFromGal
                    ? <span className="text-xs text-gray-400">Ausgeblendet</span>
                    : <span className="text-xs text-green-600">Sichtbar</span>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => setModal(c)}
                      className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => setDeleteConfirm(c)}
                      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100">{data.total} Kontakte gesamt</div>}
      </div>

      {modal !== null && (
        <ContactModal contact={modal === 'create' ? null : modal} onClose={() => setModal(null)} />
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Kontakt löschen</h2>
            <p className="text-sm text-gray-600 mb-4">
              Soll <strong>{deleteConfirm.displayName}</strong> wirklich gelöscht werden?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
              <button onClick={() => deleteContact.mutate(deleteConfirm.id)} disabled={deleteContact.isPending}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50">
                {deleteContact.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
