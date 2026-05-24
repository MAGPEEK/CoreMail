import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Building2, Plus, Trash2, Pencil, X, Loader2, Users, Share2, List } from 'lucide-react';
import { api } from '../api/client.js';

type Tab = 'sharing' | 'address-lists' | 'gal';

interface SharingPolicy {
  id: string; name: string; description: string; enabled: boolean;
  allowedDomains: string[]; allowCalendar: boolean; allowContacts: boolean;
  calendarDetail: 'FREEBUSY' | 'LIMITED' | 'FULL'; isDefault: boolean; createdAt: string;
}
interface AddressList {
  id: string; name: string; description: string; isGal: boolean;
  filter: Record<string, unknown>; createdAt: string;
}
interface GalEntry { id: string; email: string; displayName: string; type: string }
interface GalResult { users: GalEntry[]; shared: GalEntry[]; groups: GalEntry[]; resources: GalEntry[]; total: number }

export function OrganisationPage() {
  const [tab, setTab] = useState<Tab>('sharing');
  const qc = useQueryClient();

  const { data: policies = [], isLoading: loadingPolicies } = useQuery<SharingPolicy[]>({
    queryKey: ['sharing-policies'],
    queryFn: () => api.get<SharingPolicy[]>('/admin/organisation/sharing-policies'),
    enabled: tab === 'sharing',
  });

  const { data: addressLists = [], isLoading: loadingLists } = useQuery<AddressList[]>({
    queryKey: ['address-lists'],
    queryFn: () => api.get<AddressList[]>('/admin/organisation/address-lists'),
    enabled: tab === 'address-lists',
  });

  const [galSearch, setGalSearch] = useState('');
  const [galDebouncedSearch, setGalDebounced] = useState('');
  const { data: gal } = useQuery<GalResult>({
    queryKey: ['gal', galDebouncedSearch],
    queryFn: () => api.get<GalResult>(`/admin/organisation/gal?search=${encodeURIComponent(galDebouncedSearch)}&limit=100`),
    enabled: tab === 'gal',
  });

  const deletePolicyMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/organisation/sharing-policies/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sharing-policies'] }); toast.success('Gelöscht'); },
    onError: () => toast.error('Fehler'),
  });
  const deleteListMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/organisation/address-lists/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['address-lists'] }); toast.success('Gelöscht'); },
    onError: () => toast.error('Fehler'),
  });

  const [editPolicy, setEditPolicy] = useState<SharingPolicy | null>(null);
  const [createPolicy, setCreatePolicy] = useState(false);
  const [editList, setEditList] = useState<AddressList | null>(null);
  const [createList, setCreateList] = useState(false);

  const typeIcon: Record<string, string> = {
    USER: '👤', SHARED: '📫', GROUP: '👥', ROOM: '🏢', EQUIPMENT: '🖥️',
  };

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <Building2 size={22} className="text-blue-600" />
        <div>
          <h1 className="text-xl font-bold text-gray-900">Organisation</h1>
          <p className="text-sm text-gray-500">Freigaberichtlinien · Adresslisten · Globale Adressliste</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-lg p-1 mb-5 w-fit">
        {([
          { key: 'sharing',        label: 'Freigaberichtlinien', icon: Share2 },
          { key: 'address-lists',  label: 'Adresslisten',        icon: List   },
          { key: 'gal',            label: 'Globale Adressliste', icon: Users  },
        ] as const).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${tab === t.key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-600 hover:text-gray-900'}`}>
            <t.icon size={13} /> {t.label}
          </button>
        ))}
      </div>

      {/* ── Sharing Policies ──────────────────────────────────────── */}
      {tab === 'sharing' && (
        <div>
          <div className="flex justify-end mb-3">
            <button onClick={() => setCreatePolicy(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
              <Plus size={14} /> Neue Richtlinie
            </button>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {loadingPolicies ? (
              <div className="flex items-center justify-center py-10 text-gray-400"><Loader2 size={18} className="animate-spin mr-2" />Lade…</div>
            ) : policies.length === 0 ? (
              <p className="text-center py-10 text-sm text-gray-400">Keine Freigaberichtlinien</p>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Freigabe</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Domains</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Aktionen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {policies.map(p => (
                    <tr key={p.id} className={`hover:bg-gray-50 ${!p.enabled ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-900">{p.name}</p>
                          {p.isDefault && <span className="badge badge-blue text-xs">Standard</span>}
                        </div>
                        {p.description && <p className="text-xs text-gray-400">{p.description}</p>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {[p.allowCalendar && `Kalender (${p.calendarDetail})`, p.allowContacts && 'Kontakte'].filter(Boolean).join(' · ') || '–'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {p.allowedDomains.length === 0 ? 'Alle' : p.allowedDomains.join(', ')}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => setEditPolicy(p)} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"><Pencil size={14} /></button>
                          <button onClick={() => { if (!p.isDefault && window.confirm(`"${p.name}" löschen?`)) deletePolicyMutation.mutate(p.id); }}
                            disabled={p.isDefault} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-30"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── Address Lists ──────────────────────────────────────────── */}
      {tab === 'address-lists' && (
        <div>
          <div className="flex justify-end mb-3">
            <button onClick={() => setCreateList(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors">
              <Plus size={14} /> Neue Adressliste
            </button>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            {loadingLists ? (
              <div className="flex items-center justify-center py-10 text-gray-400"><Loader2 size={18} className="animate-spin mr-2" />Lade…</div>
            ) : addressLists.length === 0 ? (
              <p className="text-center py-10 text-sm text-gray-400">Keine Adresslisten</p>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Name</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Typ</th>
                    <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">Aktionen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {addressLists.map(l => (
                    <tr key={l.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-900">{l.name}</p>
                          {l.isGal && <span className="badge badge-blue text-xs">GAL</span>}
                        </div>
                        {l.description && <p className="text-xs text-gray-400">{l.description}</p>}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{l.isGal ? 'Globale Adressliste' : 'Benutzerdefiniert'}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => setEditList(l)} className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded"><Pencil size={14} /></button>
                          <button onClick={() => { if (window.confirm(`"${l.name}" löschen?`)) deleteListMutation.mutate(l.id); }}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── GAL ───────────────────────────────────────────────────── */}
      {tab === 'gal' && (
        <div>
          <div className="mb-4">
            <input value={galSearch} onChange={e => { setGalSearch(e.target.value); setTimeout(() => setGalDebounced(e.target.value), 300); }}
              className="input max-w-sm" placeholder="Namen oder E-Mail suchen…" />
          </div>
          {gal && (
            <div className="grid grid-cols-2 gap-4">
              {([
                { title: 'Benutzer', items: gal.users },
                { title: 'Freigegebene Postfächer', items: gal.shared },
                { title: 'Verteilergruppen', items: gal.groups },
                { title: 'Ressourcen', items: gal.resources },
              ]).map(section => (
                <div key={section.title} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                    <p className="text-xs font-semibold text-gray-500 uppercase">{section.title} ({section.items.length})</p>
                  </div>
                  {section.items.length === 0
                    ? <p className="text-center py-6 text-sm text-gray-400">Keine Einträge</p>
                    : (
                      <ul className="divide-y divide-gray-100 max-h-64 overflow-y-auto">
                        {section.items.map(e => (
                          <li key={e.id} className="flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50">
                            <span className="text-base">{typeIcon[e.type] ?? '📧'}</span>
                            <div>
                              <p className="text-sm font-medium text-gray-900">{e.displayName}</p>
                              <p className="text-xs text-gray-400">{e.email}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )
                  }
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(createPolicy || editPolicy) && (
        <SharingPolicyModal policy={editPolicy ?? undefined} onClose={() => { setCreatePolicy(false); setEditPolicy(null); }} />
      )}
      {(createList || editList) && (
        <AddressListModal list={editList ?? undefined} onClose={() => { setCreateList(false); setEditList(null); }} />
      )}
    </div>
  );
}

function SharingPolicyModal({ policy, onClose }: { policy?: SharingPolicy; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName]                 = useState(policy?.name ?? '');
  const [description, setDesc]          = useState(policy?.description ?? '');
  const [allowedDomains, setDomains]    = useState(policy?.allowedDomains.join('\n') ?? '');
  const [allowCalendar, setAllowCal]    = useState(policy?.allowCalendar ?? true);
  const [calendarDetail, setCalDetail]  = useState(policy?.calendarDetail ?? 'FREEBUSY');
  const [allowContacts, setAllowCont]   = useState(policy?.allowContacts ?? false);
  const [isDefault, setIsDefault]       = useState(policy?.isDefault ?? false);

  const mutation = useMutation({
    mutationFn: () => {
      const body = { name, description, allowedDomains: allowedDomains.split('\n').map(d => d.trim()).filter(Boolean), allowCalendar, calendarDetail, allowContacts, isDefault };
      return policy ? api.put(`/admin/organisation/sharing-policies/${policy.id}`, body) : api.post('/admin/organisation/sharing-policies', body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sharing-policies'] }); toast.success(policy ? 'Gespeichert' : 'Erstellt'); onClose(); },
    onError: () => toast.error('Fehler'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">{policy ? 'Richtlinie bearbeiten' : 'Neue Freigaberichtlinie'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div><label className="field-label">Name</label><input value={name} onChange={e => setName(e.target.value)} className="input" /></div>
          <div><label className="field-label">Beschreibung</label><input value={description} onChange={e => setDesc(e.target.value)} className="input" /></div>
          <div><label className="field-label">Erlaubte Domains (eine pro Zeile, leer = alle extern)</label><textarea value={allowedDomains} onChange={e => setDomains(e.target.value)} rows={3} className="input text-sm font-mono" placeholder="partner.com" /></div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none"><input type="checkbox" checked={allowCalendar} onChange={e => setAllowCal(e.target.checked)} className="rounded" />Kalenderfreigabe</label>
            {allowCalendar && (
              <select value={calendarDetail} onChange={e => setCalDetail(e.target.value as 'FREEBUSY' | 'LIMITED' | 'FULL')} className="input ml-5 w-48">
                <option value="FREEBUSY">Nur Frei/Gebucht</option>
                <option value="LIMITED">Eingeschränkt (Titel)</option>
                <option value="FULL">Vollständig</option>
              </select>
            )}
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none"><input type="checkbox" checked={allowContacts} onChange={e => setAllowCont(e.target.checked)} className="rounded" />Kontaktfreigabe</label>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none"><input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} className="rounded" />Als Standardrichtlinie</label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-secondary">Abbrechen</button>
            <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name} className="btn-primary flex items-center gap-1.5">
              {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {policy ? 'Speichern' : 'Erstellen'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddressListModal({ list, onClose }: { list?: AddressList; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName]       = useState(list?.name ?? '');
  const [description, setDesc] = useState(list?.description ?? '');
  const [isGal, setIsGal]     = useState(list?.isGal ?? false);

  const mutation = useMutation({
    mutationFn: () => {
      const body = { name, description, isGal, filter: {} };
      return list ? api.put(`/admin/organisation/address-lists/${list.id}`, body) : api.post('/admin/organisation/address-lists', body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['address-lists'] }); toast.success(list ? 'Gespeichert' : 'Erstellt'); onClose(); },
    onError: () => toast.error('Fehler'),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">{list ? 'Adressliste bearbeiten' : 'Neue Adressliste'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div><label className="field-label">Name</label><input value={name} onChange={e => setName(e.target.value)} className="input" /></div>
          <div><label className="field-label">Beschreibung</label><input value={description} onChange={e => setDesc(e.target.value)} className="input" /></div>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none"><input type="checkbox" checked={isGal} onChange={e => setIsGal(e.target.checked)} className="rounded" />Als Globale Adressliste (GAL) markieren</label>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-secondary">Abbrechen</button>
            <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name} className="btn-primary flex items-center gap-1.5">
              {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {list ? 'Speichern' : 'Erstellen'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
