import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Plus, Mail, Phone, Building2, X, Pencil, Trash2,
  Briefcase, MessageSquare, Smartphone, AtSign, User,
} from 'lucide-react';
import { api } from '../api/client.js';
import type { Contact } from '../api/types.js';
import toast from 'react-hot-toast';

type FormFields = {
  displayName: string;
  email: string;
  email2: string;
  company: string;
  phone: string;
  mobile: string;
  department: string;
  jobTitle: string;
  notes: string;
};

const emptyForm = (): FormFields => ({
  displayName: '',
  email: '',
  email2: '',
  company: '',
  phone: '',
  mobile: '',
  department: '',
  jobTitle: '',
  notes: '',
});

export function ContactsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState<FormFields>(emptyForm());

  // Persönliche Kontakte
  const { data: contacts } = useQuery({
    queryKey: ['contacts', search],
    queryFn: () =>
      api.get<Contact[]>(`/contacts${search.length >= 2 ? `?q=${encodeURIComponent(search)}` : ''}`),
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
    mutationFn: ({ id, data }: { id: string; data: Partial<Contact> }) =>
      api.put<Contact>(`/contacts/${id}`, data),
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
    setFormData(emptyForm());
    setEditMode(true);
  };

  const startEdit = (c: Contact) => {
    setFormData({
      displayName: c.displayName,
      email:       c.email,
      email2:      c.email2,
      company:     c.company,
      phone:       c.phone,
      mobile:      c.mobile,
      department:  c.department,
      jobTitle:    c.jobTitle,
      notes:       c.notes,
    });
    setEditMode(true);
  };

  const handleSave = () => {
    if (selected) {
      updateMutation.mutate({ id: selected.id, data: formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const field = (key: keyof FormFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFormData((prev) => ({ ...prev, [key]: e.target.value }));

  const initials = (name: string) =>
    name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Sidebar (nur persönliche Kontakte) ────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        {/* Such-Bar + Add-Button */}
        <div className="p-3 border-b border-gray-100 flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-8 text-xs"
              placeholder="Kontakt suchen…"
            />
          </div>
          <button onClick={startNew} className="btn-primary text-xs shrink-0" title="Neuer Kontakt">
            <Plus size={14} />
          </button>
        </div>

        {/* Liste */}
        <div className="flex-1 overflow-y-auto">
          {(contacts ?? []).map((c) => (
            <button
              key={c.id}
              onClick={() => { setSelected(c); setEditMode(false); }}
              className={`w-full text-left flex items-center gap-3 px-3 py-2.5 border-b border-gray-50 hover:bg-gray-50 transition-colors ${selected?.id === c.id ? 'bg-accent/5' : ''}`}
            >
              <div className="w-9 h-9 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold shrink-0">
                {initials(c.displayName)}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{c.displayName}</p>
                <p className="text-xs text-gray-500 truncate">{c.jobTitle || c.email}</p>
              </div>
            </button>
          ))}
          {contacts?.length === 0 && (
            <div className="py-8 text-center text-gray-400 text-sm">Keine Kontakte gefunden</div>
          )}
        </div>
      </div>

      {/* ── Detail / Edit panel ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto bg-white">
        {/* ── Edit form ── */}
        {editMode ? (
          <div className="max-w-2xl p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-base font-semibold text-gray-900">
                {selected ? 'Kontakt bearbeiten' : 'Neuer Kontakt'}
              </h2>
              <button
                onClick={() => { setEditMode(false); setFormData(emptyForm()); }}
                className="btn-ghost p-1"
              >
                <X size={16} />
              </button>
            </div>

            {/* Section: Allgemein */}
            <div className="mb-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Allgemein
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    className="input"
                    value={formData.displayName}
                    onChange={field('displayName')}
                    placeholder="Vollständiger Name"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Position</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.jobTitle}
                    onChange={field('jobTitle')}
                    placeholder="z. B. Projektleiter"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Abteilung</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.department}
                    onChange={field('department')}
                    placeholder="z. B. Vertrieb"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Firma</label>
                  <input
                    type="text"
                    className="input"
                    value={formData.company}
                    onChange={field('company')}
                    placeholder="Firmenname"
                  />
                </div>
              </div>
            </div>

            {/* Section: E-Mail & Telefon */}
            <div className="mb-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                E-Mail &amp; Telefon
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">E-Mail (primär)</label>
                  <input
                    type="email"
                    className="input"
                    value={formData.email}
                    onChange={field('email')}
                    placeholder="name@firma.de"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">E-Mail (2)</label>
                  <input
                    type="email"
                    className="input"
                    value={formData.email2}
                    onChange={field('email2')}
                    placeholder="privat@beispiel.de"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Telefon</label>
                  <input
                    type="tel"
                    className="input"
                    value={formData.phone}
                    onChange={field('phone')}
                    placeholder="+49 30 123456"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Mobil</label>
                  <input
                    type="tel"
                    className="input"
                    value={formData.mobile}
                    onChange={field('mobile')}
                    placeholder="+49 170 9876543"
                  />
                </div>
              </div>
            </div>

            {/* Section: Notizen */}
            <div className="mb-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Notizen
              </p>
              <textarea
                className="input resize-none"
                rows={4}
                value={formData.notes}
                onChange={field('notes')}
                placeholder="Interne Notizen zum Kontakt..."
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => { setEditMode(false); setFormData(emptyForm()); }}
                className="btn-secondary"
              >
                Abbrechen
              </button>
              <button
                onClick={handleSave}
                disabled={!formData.displayName || createMutation.isPending || updateMutation.isPending}
                className="btn-primary disabled:opacity-50"
              >
                Speichern
              </button>
            </div>
          </div>

        /* ── Detail view ── */
        ) : selected ? (
          <div className="p-6 max-w-2xl">
            {/* Header */}
            <div className="flex items-start gap-4 mb-6">
              <div className="w-16 h-16 rounded-full bg-accent flex items-center justify-center text-white text-xl font-bold shrink-0">
                {initials(selected.displayName)}
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-xl font-semibold text-gray-900 leading-tight">{selected.displayName}</h2>
                {(selected.jobTitle || selected.department) && (
                  <p className="text-sm text-gray-500 mt-0.5">
                    {[selected.jobTitle, selected.department].filter(Boolean).join(' · ')}
                  </p>
                )}
                {selected.company && (
                  <p className="text-sm text-gray-500">{selected.company}</p>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => startEdit(selected)} className="btn-secondary text-xs flex items-center gap-1">
                  <Pencil size={13} /> Bearbeiten
                </button>
                <button
                  onClick={() => deleteMutation.mutate(selected.id)}
                  className="btn-ghost text-xs text-red-600 flex items-center gap-1"
                >
                  <Trash2 size={13} /> Löschen
                </button>
              </div>
            </div>

            {/* Detail rows */}
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-100">

              {selected.email && (
                <div className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Mail size={15} className="text-gray-400 shrink-0" />
                  <span className="text-xs text-gray-400 w-28 shrink-0">E-Mail (primär)</span>
                  <a href={`mailto:${selected.email}`} className="text-accent hover:underline truncate">
                    {selected.email}
                  </a>
                </div>
              )}

              {selected.email2 && (
                <div className="flex items-center gap-3 px-4 py-3 text-sm">
                  <AtSign size={15} className="text-gray-400 shrink-0" />
                  <span className="text-xs text-gray-400 w-28 shrink-0">E-Mail (2)</span>
                  <a href={`mailto:${selected.email2}`} className="text-accent hover:underline truncate">
                    {selected.email2}
                  </a>
                </div>
              )}

              {selected.phone && (
                <div className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Phone size={15} className="text-gray-400 shrink-0" />
                  <span className="text-xs text-gray-400 w-28 shrink-0">Telefon</span>
                  <a href={`tel:${selected.phone}`} className="hover:underline">{selected.phone}</a>
                </div>
              )}

              {selected.mobile && (
                <div className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Smartphone size={15} className="text-gray-400 shrink-0" />
                  <span className="text-xs text-gray-400 w-28 shrink-0">Mobil</span>
                  <a href={`tel:${selected.mobile}`} className="hover:underline">{selected.mobile}</a>
                </div>
              )}

              {selected.company && (
                <div className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Building2 size={15} className="text-gray-400 shrink-0" />
                  <span className="text-xs text-gray-400 w-28 shrink-0">Firma</span>
                  <span>{selected.company}</span>
                </div>
              )}

              {selected.department && (
                <div className="flex items-center gap-3 px-4 py-3 text-sm">
                  <User size={15} className="text-gray-400 shrink-0" />
                  <span className="text-xs text-gray-400 w-28 shrink-0">Abteilung</span>
                  <span>{selected.department}</span>
                </div>
              )}

              {selected.jobTitle && (
                <div className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Briefcase size={15} className="text-gray-400 shrink-0" />
                  <span className="text-xs text-gray-400 w-28 shrink-0">Position</span>
                  <span>{selected.jobTitle}</span>
                </div>
              )}

              {selected.notes && (
                <div className="flex items-start gap-3 px-4 py-3 text-sm">
                  <MessageSquare size={15} className="text-gray-400 shrink-0 mt-0.5" />
                  <span className="text-xs text-gray-400 w-28 shrink-0 mt-0.5">Notizen</span>
                  <p className="text-gray-700 whitespace-pre-wrap leading-relaxed">{selected.notes}</p>
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
