import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldHalf, Search, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type UserRole =
  | 'USER'
  | 'HELP_DESK'
  | 'RECIPIENT_MANAGEMENT'
  | 'COMPLIANCE_MANAGEMENT'
  | 'HYGIENE_MANAGEMENT'
  | 'SERVER_MANAGEMENT'
  | 'VIEW_ONLY_ORG'
  | 'ORGANIZATION_MANAGEMENT';

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  domainId: string;
}

interface MailboxesResponse {
  mailboxes?: AdminUser[];
  users?: AdminUser[];
  total?: number;
}

// ─── Role Metadata ────────────────────────────────────────────────────────────

const ROLE_META: Record<UserRole, { label: string; description: string; color: string }> = {
  ORGANIZATION_MANAGEMENT: {
    label: 'Organization Management',
    description: 'Vollzugriff auf alle ECP-Bereiche',
    color: 'bg-red-100 text-red-700',
  },
  RECIPIENT_MANAGEMENT: {
    label: 'Recipient Management',
    description: 'Empfänger, Gruppen, Postfächer verwalten',
    color: 'bg-orange-100 text-orange-700',
  },
  SERVER_MANAGEMENT: {
    label: 'Server Management',
    description: 'Server, Zertifikate, Queues verwalten',
    color: 'bg-yellow-100 text-yellow-700',
  },
  COMPLIANCE_MANAGEMENT: {
    label: 'Compliance Management',
    description: 'eDiscovery, Journaling, Aufbewahrung',
    color: 'bg-purple-100 text-purple-700',
  },
  HYGIENE_MANAGEMENT: {
    label: 'Hygiene Management',
    description: 'Spam-/Malware-Schutzrichtlinien',
    color: 'bg-blue-100 text-blue-700',
  },
  HELP_DESK: {
    label: 'Help Desk',
    description: 'Passwort-Reset, Postfach-Status',
    color: 'bg-cyan-100 text-cyan-700',
  },
  VIEW_ONLY_ORG: {
    label: 'View Only Organization',
    description: 'Nur-Lesen auf alle Einstellungen',
    color: 'bg-gray-100 text-gray-600',
  },
  USER: {
    label: 'User',
    description: 'Kein Administratorzugriff',
    color: 'bg-gray-100 text-gray-400',
  },
};

function RoleBadge({ role }: { role: UserRole }) {
  const m = ROLE_META[role];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${m.color}`}>
      {m.label}
    </span>
  );
}

// ─── Role Selector ────────────────────────────────────────────────────────────

function RoleSelector({ userId, currentRole }: { userId: string; currentRole: UserRole }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const update = useMutation({
    mutationFn: (role: UserRole) => api.put(`/admin/mailboxes/${userId}`, { role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-rbac-users'] });
      toast.success('Rolle aktualisiert');
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const adminRoles: UserRole[] = [
    'ORGANIZATION_MANAGEMENT', 'RECIPIENT_MANAGEMENT', 'SERVER_MANAGEMENT',
    'COMPLIANCE_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'HELP_DESK', 'VIEW_ONLY_ORG', 'USER',
  ];

  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2 py-1 rounded border border-gray-200 hover:border-accent hover:bg-accent/5 transition-colors">
        <RoleBadge role={currentRole} />
        <ChevronDown size={11} className="text-gray-400" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-72 bg-white rounded-lg border border-gray-200 shadow-lg z-20 py-1 overflow-hidden">
            {adminRoles.map(r => {
              const m = ROLE_META[r];
              return (
                <button key={r} onClick={() => update.mutate(r)}
                  className={`w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-start gap-3 ${r === currentRole ? 'bg-accent/5' : ''}`}>
                  <div className="pt-0.5">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${m.color}`}>
                      {m.label}
                    </span>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">{m.description}</p>
                  </div>
                  {r === currentRole && <span className="ml-auto text-accent text-xs">✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function RbacPage() {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRole | 'ALL' | 'ADMINS'>('ALL');

  const { data, isLoading } = useQuery<MailboxesResponse>({
    queryKey: ['admin-rbac-users'],
    queryFn: () => api.get('/admin/mailboxes?limit=500'),
  });

  const users: AdminUser[] = Array.isArray(data)
    ? (data as AdminUser[])
    : ((data?.mailboxes ?? data?.users ?? []) as AdminUser[]);

  const filtered = users.filter(u => {
    if (roleFilter === 'ADMINS' && u.role === 'USER') return false;
    if (roleFilter !== 'ALL' && roleFilter !== 'ADMINS' && u.role !== roleFilter) return false;
    if (search && !u.displayName.toLowerCase().includes(search.toLowerCase()) &&
        !u.email.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const adminCount = users.filter(u => u.role !== 'USER').length;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <ShieldHalf size={22} className="text-accent" />
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Berechtigungen (RBAC)</h1>
          <p className="text-sm text-gray-500">
            {users.length} Benutzer · {adminCount} mit Admin-Rollen
          </p>
        </div>
      </div>

      {/* Role legend */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Rollenbeschreibungen</p>
        <div className="grid grid-cols-2 gap-2">
          {(Object.entries(ROLE_META) as [UserRole, typeof ROLE_META[UserRole]][])
            .filter(([r]) => r !== 'USER')
            .map(([role, m]) => (
              <div key={role} className="flex items-start gap-2">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${m.color}`}>
                  {m.label}
                </span>
                <span className="text-xs text-gray-500">{m.description}</span>
              </div>
            ))}
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <div className="flex items-center gap-2 bg-white border border-gray-300 rounded px-3 py-1.5 flex-1 max-w-xs">
          <Search size={14} className="text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            className="flex-1 text-sm focus:outline-none"
            placeholder="Name oder E-Mail…" />
        </div>
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as UserRole | 'ALL' | 'ADMINS')}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-accent">
          <option value="ALL">Alle Rollen</option>
          <option value="ADMINS">Nur Admins</option>
          {(Object.keys(ROLE_META) as UserRole[]).map(r => (
            <option key={r} value={r}>{ROLE_META[r].label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3">Benutzer</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Aktuelle Rolle</th>
              <th className="text-right px-4 py-3">Rolle ändern</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={4} className="text-center py-12 text-gray-400">Laden…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={4} className="text-center py-12 text-gray-400">Keine Benutzer gefunden</td></tr>
            ) : filtered.map(u => (
              <tr key={u.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <p className="font-medium text-gray-900">{u.displayName}</p>
                  <p className="text-xs text-gray-500">{u.email}</p>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    u.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {u.active ? 'Aktiv' : 'Inaktiv'}
                  </span>
                </td>
                <td className="px-4 py-3"><RoleBadge role={u.role} /></td>
                <td className="px-4 py-3 text-right">
                  <RoleSelector userId={u.id} currentRole={u.role} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
