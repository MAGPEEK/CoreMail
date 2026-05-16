import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users, Plus, Pencil, Trash2, UserPlus, UserMinus, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Group {
  id: string;
  email: string;
  displayName: string;
  description: string;
  groupType: 'STATIC' | 'DYNAMIC';
  active: boolean;
  hiddenFromGal: boolean;
  requireSenderAuth: boolean;
  allowExternal: boolean;
  moderationEnabled: boolean;
  moderatorIds: string[];
  ldapFilter?: string;
  domainId: string;
  _count: { members: number };
}

interface Member {
  id: string;
  memberEmail: string;
  memberType: 'USER' | 'SHARED_MAILBOX' | 'GROUP' | 'EXTERNAL';
}

interface Domain { id: string; name: string; }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: 'STATIC' | 'DYNAMIC' }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
      type === 'DYNAMIC' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
    }`}>
      {type === 'DYNAMIC' ? 'Dynamisch' : 'Statisch'}
    </span>
  );
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

function MemberTypeBadge({ type }: { type: Member['memberType'] }) {
  const map: Record<Member['memberType'], string> = {
    USER: 'bg-blue-100 text-blue-700',
    SHARED_MAILBOX: 'bg-yellow-100 text-yellow-700',
    GROUP: 'bg-purple-100 text-purple-700',
    EXTERNAL: 'bg-gray-100 text-gray-600',
  };
  const labels: Record<Member['memberType'], string> = {
    USER: 'User', SHARED_MAILBOX: 'Shared', GROUP: 'Gruppe', EXTERNAL: 'Extern',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${map[type]}`}>
      {labels[type]}
    </span>
  );
}

// ─── Group Form Modal ─────────────────────────────────────────────────────────

interface GroupFormData {
  email: string;
  displayName: string;
  description: string;
  domainId: string;
  groupType: 'STATIC' | 'DYNAMIC';
  ldapFilter: string;
  requireSenderAuth: boolean;
  allowExternal: boolean;
  moderationEnabled: boolean;
  hiddenFromGal: boolean;
}

function GroupModal({
  group, domains, onClose,
}: {
  group: Group | null;
  domains: Domain[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = group !== null;

  const [form, setForm] = useState<GroupFormData>({
    email: group?.email ?? '',
    displayName: group?.displayName ?? '',
    description: group?.description ?? '',
    domainId: group?.domainId ?? (domains[0]?.id ?? ''),
    groupType: group?.groupType ?? 'STATIC',
    ldapFilter: group?.ldapFilter ?? '',
    requireSenderAuth: group?.requireSenderAuth ?? false,
    allowExternal: group?.allowExternal ?? true,
    moderationEnabled: group?.moderationEnabled ?? false,
    hiddenFromGal: group?.hiddenFromGal ?? false,
  });

  const save = useMutation({
    mutationFn: () => isEdit
      ? api.put(`/admin/groups/${group.id}`, {
          displayName: form.displayName,
          description: form.description,
          requireSenderAuth: form.requireSenderAuth,
          allowExternal: form.allowExternal,
          moderationEnabled: form.moderationEnabled,
          hiddenFromGal: form.hiddenFromGal,
          ...(form.groupType === 'DYNAMIC' ? { ldapFilter: form.ldapFilter } : {}),
        })
      : api.post('/admin/groups', {
          email: form.email,
          displayName: form.displayName,
          description: form.description,
          domainId: form.domainId,
          groupType: form.groupType,
          requireSenderAuth: form.requireSenderAuth,
          allowExternal: form.allowExternal,
          moderationEnabled: form.moderationEnabled,
          hiddenFromGal: form.hiddenFromGal,
          ...(form.groupType === 'DYNAMIC' ? { ldapFilter: form.ldapFilter } : {}),
        }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-groups'] });
      toast.success(isEdit ? 'Gruppe aktualisiert' : 'Gruppe erstellt');
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = <K extends keyof GroupFormData>(k: K, v: GroupFormData[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            {isEdit ? 'Gruppe bearbeiten' : 'Neue Verteilergruppe'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Typ (nur bei Neu) */}
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Typ</label>
              <div className="flex gap-3">
                {(['STATIC', 'DYNAMIC'] as const).map(t => (
                  <label key={t} className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" checked={form.groupType === t}
                      onChange={() => set('groupType', t)} className="accent-accent" />
                    <span className="text-sm text-gray-700">{t === 'STATIC' ? 'Statisch (manuelle Mitglieder)' : 'Dynamisch (LDAP-Filter)'}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* E-Mail (nur bei Neu) */}
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">E-Mail-Adresse</label>
              <input value={form.email} onChange={e => set('email', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="verteilung@domain.com" />
            </div>
          )}

          {/* Domain (nur bei Neu) */}
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Domain</label>
              <select value={form.domainId} onChange={e => set('domainId', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
                {domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
          )}

          {/* Anzeigename */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Anzeigename</label>
            <input value={form.displayName} onChange={e => set('displayName', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="z.B. Vertriebs-Team" />
          </div>

          {/* Beschreibung */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Beschreibung</label>
            <textarea value={form.description} onChange={e => set('description', e.target.value)}
              rows={2}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent resize-none" />
          </div>

          {/* LDAP-Filter (nur DYNAMIC) */}
          {form.groupType === 'DYNAMIC' && (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">LDAP-Filter</label>
              <input value={form.ldapFilter} onChange={e => set('ldapFilter', e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                placeholder="(department=Vertrieb)" />
            </div>
          )}

          {/* Optionen */}
          <div className="space-y-2">
            <label className="block text-xs font-medium text-gray-700">Optionen</label>
            {([
              ['requireSenderAuth', 'Nur authentifizierte Absender'],
              ['allowExternal',     'Externe Absender erlauben'],
              ['moderationEnabled', 'Moderation aktivieren'],
              ['hiddenFromGal',     'In GAL ausblenden'],
            ] as [keyof GroupFormData, string][]).map(([k, label]) => (
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

// ─── Members Panel ────────────────────────────────────────────────────────────

function MembersPanel({ group }: { group: Group }) {
  const qc = useQueryClient();
  const [newEmail, setNewEmail] = useState('');
  const [newType, setNewType] = useState<Member['memberType']>('USER');

  const { data: members = [] } = useQuery<Member[]>({
    queryKey: ['admin-group-members', group.id],
    queryFn: () => api.get(`/admin/groups/${group.id}/members`),
  });

  const addMember = useMutation({
    mutationFn: () => api.post(`/admin/groups/${group.id}/members`, { memberEmail: newEmail.trim(), memberType: newType }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-group-members', group.id] });
      void qc.invalidateQueries({ queryKey: ['admin-groups'] });
      setNewEmail('');
      toast.success('Mitglied hinzugefügt');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeMember = useMutation({
    mutationFn: (email: string) => api.delete(`/admin/groups/${group.id}/members/${encodeURIComponent(email)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-group-members', group.id] });
      void qc.invalidateQueries({ queryKey: ['admin-groups'] });
      toast.success('Mitglied entfernt');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="border-t border-gray-100 bg-gray-50 px-6 py-4">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
        Mitglieder ({members.length})
      </h3>

      {/* Add member */}
      {group.groupType === 'STATIC' && (
        <div className="flex gap-2 mb-3">
          <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && newEmail.trim()) addMember.mutate(); }}
            className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            placeholder="E-Mail-Adresse eingeben" />
          <select value={newType} onChange={e => setNewType(e.target.value as Member['memberType'])}
            className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
            <option value="USER">User</option>
            <option value="SHARED_MAILBOX">Shared Mailbox</option>
            <option value="GROUP">Gruppe</option>
            <option value="EXTERNAL">Extern</option>
          </select>
          <button onClick={() => { if (newEmail.trim()) addMember.mutate(); }}
            disabled={!newEmail.trim() || addMember.isPending}
            className="flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-accent rounded hover:bg-accent/90 disabled:opacity-50">
            <UserPlus size={13} /> Hinzufügen
          </button>
        </div>
      )}

      {group.groupType === 'DYNAMIC' && (
        <p className="text-xs text-gray-500 mb-3 italic">
          Dynamische Gruppe — Mitglieder werden über den LDAP-Filter ermittelt.
        </p>
      )}

      {/* Member list */}
      {members.length === 0 ? (
        <p className="text-sm text-gray-400 italic">Noch keine Mitglieder</p>
      ) : (
        <ul className="space-y-1">
          {members.map(m => (
            <li key={m.id} className="flex items-center justify-between py-1 px-2 rounded hover:bg-white group">
              <div className="flex items-center gap-2">
                <MemberTypeBadge type={m.memberType} />
                <span className="text-sm text-gray-700">{m.memberEmail}</span>
              </div>
              {group.groupType === 'STATIC' && (
                <button onClick={() => removeMember.mutate(m.memberEmail)}
                  className="opacity-0 group-hover:opacity-100 p-1 text-red-400 hover:text-red-600 transition-opacity">
                  <UserMinus size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function GroupsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'STATIC' | 'DYNAMIC'>('ALL');
  const [modal, setModal] = useState<'create' | Group | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Group | null>(null);

  const { data: groups = [], isLoading } = useQuery<Group[]>({
    queryKey: ['admin-groups'],
    queryFn: () => api.get('/admin/groups'),
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
    mutationFn: (g: Group) => api.put(`/admin/groups/${g.id}`, { active: !g.active }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-groups'] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteGroup = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/groups/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-groups'] });
      toast.success('Gruppe gelöscht');
      setDeleteConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const filtered = groups.filter(g => {
    if (typeFilter !== 'ALL' && g.groupType !== typeFilter) return false;
    if (search && !(g.displayName ?? '').toLowerCase().includes(search.toLowerCase()) &&
        !(g.email ?? '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Users size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Verteilergruppen</h1>
            <p className="text-sm text-gray-500">{groups.length} Gruppen gesamt</p>
          </div>
        </div>
        <button onClick={() => setModal('create')}
          className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent/90">
          <Plus size={15} /> Neue Gruppe
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <input value={search} onChange={e => setSearch(e.target.value)}
          className="flex-1 max-w-xs border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          placeholder="Suchen…" />
        <div className="flex border border-gray-300 rounded overflow-hidden text-sm">
          {(['ALL', 'STATIC', 'DYNAMIC'] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-3 py-1.5 ${typeFilter === t ? 'bg-accent text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
              {t === 'ALL' ? 'Alle' : t === 'STATIC' ? 'Statisch' : 'Dynamisch'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="w-6 px-3 py-3" />
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Gruppe</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Typ</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Mitglieder</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">GAL</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400">Laden…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="text-center py-12 text-gray-400">Keine Gruppen gefunden</td></tr>
            ) : filtered.map(g => (
              <>
                <tr key={g.id} className="border-b border-gray-100 hover:bg-gray-50">
                  {/* Expand */}
                  <td className="px-3 py-3">
                    <button onClick={() => setExpanded(expanded === g.id ? null : g.id)}
                      className="text-gray-400 hover:text-gray-600">
                      {expanded === g.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  {/* Name + Email */}
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{g.displayName}</p>
                    <p className="text-xs text-gray-500">{g.email}</p>
                    {g.description && <p className="text-xs text-gray-400 mt-0.5">{g.description}</p>}
                  </td>
                  {/* Type */}
                  <td className="px-4 py-3"><TypeBadge type={g.groupType} /></td>
                  {/* Member count */}
                  <td className="px-4 py-3 text-gray-700">{g._count.members}</td>
                  {/* Status */}
                  <td className="px-4 py-3">
                    <button onClick={() => toggleActive.mutate(g)}>
                      <StatusBadge active={g.active} />
                    </button>
                  </td>
                  {/* GAL */}
                  <td className="px-4 py-3">
                    {g.hiddenFromGal
                      ? <span className="text-xs text-gray-400">Ausgeblendet</span>
                      : <span className="text-xs text-green-600">Sichtbar</span>}
                  </td>
                  {/* Actions */}
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setModal(g)}
                        className="p-1.5 text-gray-400 hover:text-accent hover:bg-accent/10 rounded" title="Bearbeiten">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => setDeleteConfirm(g)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded" title="Löschen">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
                {/* Members Panel */}
                {expanded === g.id && (
                  <tr key={`${g.id}-members`}>
                    <td colSpan={7} className="p-0">
                      <MembersPanel group={g} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {/* Group Modal */}
      {modal !== null && (
        <GroupModal
          group={modal === 'create' ? null : modal}
          domains={domains}
          onClose={() => setModal(null)}
        />
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Gruppe löschen</h2>
            <p className="text-sm text-gray-600 mb-4">
              Soll <strong>{deleteConfirm.displayName}</strong> wirklich gelöscht werden?
              Alle Mitgliedschaften werden entfernt.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">Abbrechen</button>
              <button onClick={() => deleteGroup.mutate(deleteConfirm.id)} disabled={deleteGroup.isPending}
                className="px-4 py-2 text-sm text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50">
                {deleteGroup.isPending ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
