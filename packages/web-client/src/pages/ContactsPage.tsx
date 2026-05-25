import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Plus, Mail, Phone, Building2, X, Pencil, Trash2,
  Briefcase, MessageSquare, Smartphone, AtSign, User,
  BookOpen, Users as UsersIcon, Globe, RefreshCw,
} from 'lucide-react';
import { api } from '../api/client.js';
import type { Contact } from '../api/types.js';
import { useUiStore } from '../store/ui.js';
import toast from 'react-hot-toast';

// GAL-Entry-Typ (vereint User, ExternalMailContact, DistributionGroup)
interface GalEntry {
  id:           string;
  kind:         'USER' | 'EXTERNAL' | 'GROUP';
  email:        string;
  displayName:  string;
  subtitle?:    string;
  company?:     string;
  department?:  string;
  phone?:       string;
  mobile?:      string;
  domain?:      string;
  memberCount?: number;
}
interface GalResponse { entries: GalEntry[]; total: number; limit: number; offset: number }

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
  const { openCompose } = useUiStore();
  const [view, setView] = useState<'personal' | 'gal'>('personal');
  const [galFilter, setGalFilter] = useState<'all' | 'users' | 'external' | 'groups'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [selectedGal, setSelectedGal] = useState<GalEntry | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState<FormFields>(emptyForm());

  // Persönliche Kontakte
  const { data: contacts } = useQuery({
    queryKey: ['contacts', search],
    queryFn: () =>
      api.get<Contact[]>(`/contacts${search.length >= 2 ? `?q=${encodeURIComponent(search)}` : ''}`),
    staleTime: 10_000,
    enabled: view === 'personal',
  });

  // Globales Adressbuch (GAL) — Browse-Modus ohne q, Suche mit q
  // Cache so wenig wie möglich: Admin kann jederzeit neue ExternalContacts oder
  // DistributionGroups anlegen — der MWA-User soll sie ohne Reload sehen.
  const { data: galData, refetch: refetchGal, isFetching: galLoading } = useQuery<GalResponse>({
    queryKey: ['gal', search, galFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '300' });
      if (search.length >= 2) params.set('q', search);
      if (galFilter !== 'all') params.set('type', galFilter);
      return api.get<GalResponse>(`/contacts/gal?${params.toString()}`);
    },
    staleTime: 0,                  // immer als stale markieren
    refetchOnMount: true,          // bei Tab-Wechsel zur ContactsPage neu laden
    refetchOnWindowFocus: true,    // bei Tab/Fenster-Fokus neu laden
    refetchInterval: 60_000,       // im Hintergrund alle 60s sync
    enabled: view === 'gal',
  });
  const galEntries = galData?.entries ?? [];

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

  // Helper: GAL-Eintrag → Mail verfassen (Klick auf „Mail senden"-Button)
  const composeToGal = (entry: GalEntry) => {
    openCompose({ mode: 'new', toAddrs: [entry.email] });
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Sidebar mit Tabs ──────────────────────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        {/* Tabs */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => { setView('personal'); setSelected(null); setSelectedGal(null); setEditMode(false); }}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
              view === 'personal'
                ? 'text-accent border-b-2 border-accent bg-accent/5'
                : 'text-gray-600 hover:bg-gray-50 border-b-2 border-transparent'
            }`}
          >
            <BookOpen size={13} /> Mein Adressbuch
          </button>
          <button
            onClick={() => { setView('gal'); setSelected(null); setEditMode(false); }}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
              view === 'gal'
                ? 'text-accent border-b-2 border-accent bg-accent/5'
                : 'text-gray-600 hover:bg-gray-50 border-b-2 border-transparent'
            }`}
          >
            <Globe size={13} /> Globales Adressbuch
          </button>
        </div>

        {/* Such-Bar + Add-Button (Add nur in personal) */}
        <div className="p-3 border-b border-gray-100 flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-8 text-xs"
              placeholder={view === 'personal' ? 'Kontakt suchen…' : 'GAL durchsuchen…'}
            />
          </div>
          {view === 'personal' && (
            <button onClick={startNew} className="btn-primary text-xs shrink-0" title="Neuer Kontakt">
              <Plus size={14} />
            </button>
          )}
        </div>

        {/* GAL-Typ-Filter — kompakte Toggle-Bar */}
        {view === 'gal' && (
          <div className="px-3 py-2 border-b border-gray-100 flex gap-1 text-[11px]">
            {([
              { v: 'all',      l: 'Alle' },
              { v: 'users',    l: 'Personen' },
              { v: 'external', l: 'Extern' },
              { v: 'groups',   l: 'Gruppen' },
            ] as const).map(({ v, l }) => (
              <button
                key={v}
                onClick={() => setGalFilter(v)}
                className={`px-2 py-0.5 rounded-full ${
                  galFilter === v ? 'bg-accent text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {l}
              </button>
            ))}
            {galData && <span className="ml-auto text-gray-400 text-[10px]">{galData.total}</span>}
            <button
              onClick={() => refetchGal()}
              disabled={galLoading}
              className="text-gray-400 hover:text-accent transition-colors disabled:opacity-30"
              title="GAL neu laden"
            >
              <RefreshCw size={11} className={galLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        )}

        {/* Liste — abhängig vom view */}
        <div className="flex-1 overflow-y-auto">
          {view === 'personal' ? (
            <>
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
            </>
          ) : (
            <>
              {galEntries.map((g) => {
                const isSelected = selectedGal?.id === g.id;
                const avatarColor = g.kind === 'GROUP' ? 'bg-purple-500' : g.kind === 'EXTERNAL' ? 'bg-amber-500' : 'bg-accent';
                const kindBadge = g.kind === 'GROUP' ? 'Gruppe' : g.kind === 'EXTERNAL' ? 'Extern' : 'Intern';
                const kindCls   = g.kind === 'GROUP' ? 'bg-purple-100 text-purple-700' : g.kind === 'EXTERNAL' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700';
                return (
                  <button
                    key={g.id}
                    onClick={() => setSelectedGal(g)}
                    className={`w-full text-left flex items-center gap-3 px-3 py-2.5 border-b border-gray-50 hover:bg-gray-50 transition-colors ${isSelected ? 'bg-accent/5' : ''}`}
                  >
                    <div className={`w-9 h-9 rounded-full ${avatarColor} flex items-center justify-center text-white text-xs font-bold shrink-0`}>
                      {g.kind === 'GROUP' ? <UsersIcon size={14} /> : initials(g.displayName)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-gray-800 truncate">{g.displayName}</p>
                        <span className={`text-[9px] px-1 py-0.5 rounded shrink-0 ${kindCls}`}>{kindBadge}</span>
                      </div>
                      <p className="text-xs text-gray-500 truncate">{g.email}</p>
                      {g.company && <p className="text-[10px] text-gray-400 truncate">{g.company}</p>}
                      {g.memberCount !== undefined && (
                        <p className="text-[10px] text-purple-500 truncate">{g.memberCount} {g.memberCount === 1 ? 'Mitglied' : 'Mitglieder'}</p>
                      )}
                    </div>
                  </button>
                );
              })}
              {galEntries.length === 0 && (
                <div className="py-8 text-center text-gray-400 text-sm">
                  {search.length >= 2 ? 'Nichts gefunden' : 'Keine Einträge im GAL'}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Detail / Edit panel ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto bg-white">

        {/* ── GAL Read-Only-Detail (Globales Adressbuch) ── */}
        {view === 'gal' && selectedGal ? (
          <div className="max-w-2xl p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-base font-semibold text-gray-900">Adressbuch-Eintrag</h2>
              <button onClick={() => setSelectedGal(null)} className="btn-ghost p-1"><X size={16} /></button>
            </div>
            <div className="flex items-start gap-4 mb-6">
              <div className={`w-16 h-16 rounded-full ${selectedGal.kind === 'GROUP' ? 'bg-purple-500' : selectedGal.kind === 'EXTERNAL' ? 'bg-amber-500' : 'bg-accent'} flex items-center justify-center text-white text-xl font-bold shrink-0`}>
                {selectedGal.kind === 'GROUP' ? <UsersIcon size={24} /> : initials(selectedGal.displayName)}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-gray-900">{selectedGal.displayName}</h3>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    selectedGal.kind === 'GROUP'    ? 'bg-purple-100 text-purple-700' :
                    selectedGal.kind === 'EXTERNAL' ? 'bg-amber-100 text-amber-700'   :
                                                      'bg-blue-100 text-blue-700'
                  }`}>
                    {selectedGal.kind === 'GROUP' ? 'Verteilergruppe' : selectedGal.kind === 'EXTERNAL' ? 'Externer Kontakt' : 'Interner Benutzer'}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-0.5">{selectedGal.email}</p>
                {selectedGal.subtitle && <p className="text-xs text-gray-400 mt-0.5 italic">{selectedGal.subtitle}</p>}
              </div>
            </div>

            {/* Aktionen */}
            <div className="flex gap-2 mb-6">
              <button onClick={() => composeToGal(selectedGal)} className="btn-primary text-sm">
                <Mail size={14} /> Neue Nachricht
              </button>
            </div>

            {/* Details als Read-Only-Tabelle */}
            <div className="space-y-3">
              <div className="flex items-start gap-3 text-sm">
                <AtSign size={14} className="text-gray-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-xs text-gray-500">E-Mail</p>
                  <a href={`mailto:${selectedGal.email}`} className="text-accent hover:underline">{selectedGal.email}</a>
                </div>
              </div>
              {selectedGal.company && (
                <div className="flex items-start gap-3 text-sm">
                  <Building2 size={14} className="text-gray-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs text-gray-500">Unternehmen</p>
                    <p className="text-gray-800">{selectedGal.company}</p>
                  </div>
                </div>
              )}
              {selectedGal.department && (
                <div className="flex items-start gap-3 text-sm">
                  <Briefcase size={14} className="text-gray-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs text-gray-500">Abteilung</p>
                    <p className="text-gray-800">{selectedGal.department}</p>
                  </div>
                </div>
              )}
              {selectedGal.phone && (
                <div className="flex items-start gap-3 text-sm">
                  <Phone size={14} className="text-gray-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs text-gray-500">Telefon</p>
                    <a href={`tel:${selectedGal.phone}`} className="text-accent hover:underline">{selectedGal.phone}</a>
                  </div>
                </div>
              )}
              {selectedGal.mobile && (
                <div className="flex items-start gap-3 text-sm">
                  <Smartphone size={14} className="text-gray-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs text-gray-500">Mobil</p>
                    <a href={`tel:${selectedGal.mobile}`} className="text-accent hover:underline">{selectedGal.mobile}</a>
                  </div>
                </div>
              )}
              {selectedGal.domain && (
                <div className="flex items-start gap-3 text-sm">
                  <Globe size={14} className="text-gray-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs text-gray-500">Domain</p>
                    <p className="text-gray-800 font-mono text-xs">{selectedGal.domain}</p>
                  </div>
                </div>
              )}
              {selectedGal.memberCount !== undefined && (
                <div className="flex items-start gap-3 text-sm">
                  <UsersIcon size={14} className="text-gray-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs text-gray-500">Mitglieder</p>
                    <p className="text-gray-800">{selectedGal.memberCount}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 px-3 py-2 bg-gray-50 border border-gray-200 rounded text-xs text-gray-500">
              ℹ Adressbuch-Einträge sind zentral vom Admin verwaltet und können hier nicht bearbeitet werden.
            </div>
          </div>
        ) : view === 'gal' ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            <div className="text-center">
              <Globe size={48} className="mx-auto mb-3 text-gray-300" />
              <p>Wählen Sie einen Eintrag aus dem globalen Adressbuch</p>
            </div>
          </div>
        ) :

        /* ── Edit form ── */
        editMode ? (
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
