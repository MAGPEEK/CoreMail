import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Mail, Phone, Building2, X, Pencil, Trash2 } from 'lucide-react';
import { api } from '../api/client.js';
import type { Contact } from '../api/types.js';
import toast from 'react-hot-toast';

export function ContactsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState<Partial<Contact>>({});

  const { data: contacts } = useQuery({
    queryKey: ['contacts', search],
    queryFn: () => api.get<Contact[]>(`/contacts${search.length >= 2 ? `?q=${encodeURIComponent(search)}` : ''}`),
    staleTime: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<Contact>) => api.post<Contact>('/contacts', data),
    onSuccess: (c) => {
      toast.success('Kontakt erstellt');
      qc.invalidateQueries({ queryKey: ['contacts'] });
      setSelected(c);
      setEditMode(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Contact> }) => api.put<Contact>(`/contacts/${id}`, data),
    onSuccess: (c) => {
      toast.success('Kontakt gespeichert');
      qc.invalidateQueries({ queryKey: ['contacts'] });
      setSelected(c);
      setEditMode(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/contacts/${id}`),
    onSuccess: () => {
      toast.success('Kontakt gelöscht');
      qc.invalidateQueries({ queryKey: ['contacts'] });
      setSelected(null);
    },
  });

  const startNew = () => {
    setSelected(null);
    setFormData({ displayName: '', email: '', company: '', phone: '' });
    setEditMode(true);
  };

  const startEdit = (c: Contact) => {
    setFormData({ displayName: c.displayName, email: c.email, company: c.company, phone: c.phone });
    setEditMode(true);
  };

  const handleSave = () => {
    if (selected) {
      updateMutation.mutate({ id: selected.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const initials = (name: string) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Contact list */}
      <div className="w-72 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div className="p-3 border-b border-gray-100 flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              className="input pl-8 text-xs" placeholder="Kontakt suchen..." />
          </div>
          <button onClick={startNew} className="btn-primary text-xs shrink-0">
            <Plus size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {(contacts ?? []).map((c) => (
            <button key={c.id} onClick={() => { setSelected(c); setEditMode(false); }}
              className={`w-full text-left flex items-center gap-3 px-3 py-2.5 border-b border-gray-50 hover:bg-gray-50 transition-colors ${selected?.id === c.id ? 'bg-accent/5' : ''}`}>
              <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold shrink-0">
                {initials(c.displayName)}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{c.displayName}</p>
                <p className="text-xs text-gray-500 truncate">{c.email}</p>
              </div>
            </button>
          ))}
          {contacts?.length === 0 && (
            <div className="py-8 text-center text-gray-400 text-sm">Keine Kontakte gefunden</div>
          )}
        </div>
      </div>

      {/* Detail / Edit panel */}
      <div className="flex-1 overflow-y-auto bg-white">
        {editMode ? (
          <div className="max-w-lg p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold">{selected ? 'Kontakt bearbeiten' : 'Neuer Kontakt'}</h2>
              <button onClick={() => { setEditMode(false); setFormData({}); }} className="btn-ghost p-1"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              {[
                { label: 'Name', key: 'displayName', type: 'text', required: true },
                { label: 'E-Mail', key: 'email', type: 'email', required: false },
                { label: 'Telefon', key: 'phone', type: 'tel', required: false },
                { label: 'Firma', key: 'company', type: 'text', required: false },
              ].map(({ label, key, type }) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
                  <input type={type} className="input"
                    value={(formData[key as keyof Contact] as string) ?? ''}
                    onChange={(e) => setFormData({ ...formData, [key]: e.target.value })} />
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => { setEditMode(false); setFormData({}); }} className="btn-secondary">Abbrechen</button>
              <button onClick={handleSave}
                disabled={!formData.displayName || createMutation.isPending || updateMutation.isPending}
                className="btn-primary disabled:opacity-50">
                Speichern
              </button>
            </div>
          </div>
        ) : selected ? (
          <div className="p-6">
            <div className="flex items-start gap-4 mb-6">
              <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center text-white text-xl font-bold">
                {initials(selected.displayName)}
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-900">{selected.displayName}</h2>
                {selected.company && <p className="text-gray-500 text-sm">{selected.company}</p>}
              </div>
              <div className="ml-auto flex gap-1">
                <button onClick={() => startEdit(selected)} className="btn-secondary text-xs"><Pencil size={13} /> Bearbeiten</button>
                <button onClick={() => deleteMutation.mutate(selected.id)} className="btn-ghost text-xs text-red-600"><Trash2 size={13} /> Löschen</button>
              </div>
            </div>
            <div className="space-y-2">
              {selected.email && (
                <div className="flex items-center gap-3 text-sm">
                  <Mail size={15} className="text-gray-400" />
                  <a href={`mailto:${selected.email}`} className="text-accent hover:underline">{selected.email}</a>
                </div>
              )}
              {selected.phone && (
                <div className="flex items-center gap-3 text-sm">
                  <Phone size={15} className="text-gray-400" />
                  <span>{selected.phone}</span>
                </div>
              )}
              {selected.company && (
                <div className="flex items-center gap-3 text-sm">
                  <Building2 size={15} className="text-gray-400" />
                  <span>{selected.company}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm h-full">
            Kontakt auswählen oder neu erstellen
          </div>
        )}
      </div>
    </div>
  );
}
