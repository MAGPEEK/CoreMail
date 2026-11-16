import { useRef, useState } from 'react';
import { usePopoverDismiss } from '../components/usePopoverDismiss.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldHalf, Search, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { canAssignRoles } from '../lib/permissions.js';

// ─── Types ────────────────────────────────────────────────────────────────────

const ROLES = [
  'ORGANIZATION_MANAGEMENT', 'RECIPIENT_MANAGEMENT', 'SERVER_MANAGEMENT',
  'COMPLIANCE_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'HELP_DESK', 'VIEW_ONLY_ORG', 'USER',
] as const;
type UserRole = typeof ROLES[number];

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  domainId: string;
}

// ─── Role Metadata (labels/descriptions via i18n role_label_* / role_desc_*) ──

const ROLE_COLOR: Record<UserRole, string> = {
  ORGANIZATION_MANAGEMENT: 'bg-danger-bg text-danger-fg',
  RECIPIENT_MANAGEMENT:    'bg-warning-bg text-warning-fg',
  SERVER_MANAGEMENT:       'bg-warning-bg text-warning-fg',
  COMPLIANCE_MANAGEMENT:   'bg-info-bg text-info-fg',
  HYGIENE_MANAGEMENT:      'bg-info-bg text-info-fg',
  HELP_DESK:               'bg-info-bg text-info-fg',
  VIEW_ONLY_ORG:           'bg-surface-2 text-fg-muted',
  USER:                    'bg-surface-2 text-fg-subtle',
};

function RoleBadge({ role }: { role: UserRole }) {
  const t = useT();
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLOR[role] ?? ROLE_COLOR.USER}`}>
      {ROLES.includes(role) ? t(`role_label_${role}`) : role}
    </span>
  );
}

// ─── Role Selector ────────────────────────────────────────────────────────────

function RoleSelector({ userId, currentRole }: { userId: string; currentRole: UserRole }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, () => setOpen(false), triggerRef, menuRef);

  const update = useMutation({
    mutationFn: (role: UserRole) => api.put(`/admin/mailboxes/${userId}`, { role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-rbac-users'] });
      void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
      void qc.invalidateQueries({ queryKey: ['admin-mailbox-detail'] });
      toast.success(t('rbac_role_updated'));
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pick = (r: UserRole) => {
    if (r === currentRole) { setOpen(false); return; }
    // A role change ends the account's web sessions (server side).
    if (!confirm(t('rbac_change_confirm'))) return;
    update.mutate(r);
  };

  return (
    <div className="relative inline-block">
      <button ref={triggerRef} type="button" onClick={() => setOpen(o => !o)} disabled={update.isPending}
        aria-haspopup="menu" aria-expanded={open} aria-label={`${t('rbac_change_aria')}: ${t(`role_label_${currentRole}`)}`}
        className="flex items-center gap-1.5 px-2 py-1 rounded border border-line hover:border-accent hover:bg-accent/5 transition-colors disabled:cursor-wait">
        <RoleBadge role={currentRole} />
        <ChevronDown size={11} className="text-fg-subtle" aria-hidden="true" />
      </button>

      {open && <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />}
      {open && (
        <div ref={menuRef} role="menu" aria-label={t('rbac_pick_aria')} className="absolute right-0 top-full mt-1 w-72 bg-surface rounded-lg border border-line shadow-lg z-20 py-1 overflow-hidden">
          {ROLES.map(r => (
            <button key={r} type="button" role="menuitemradio" aria-checked={r === currentRole} onClick={() => pick(r)}
              className={`w-full text-left px-4 py-2.5 hover:bg-surface-2 flex items-start gap-3 ${r === currentRole ? 'bg-accent/5' : ''}`}>
              <div className="pt-0.5"><RoleBadge role={r} /></div>
              <p className="text-xs text-fg-subtle">{t(`role_desc_${r}`)}</p>
              {r === currentRole && <span className="ml-auto text-accent-fg text-xs" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function RbacPage() {
  const t = useT();
  const { role: actorRole } = usePermissions();
  // Server: only ORGANIZATION_MANAGEMENT may assign roles (canAssignRole); every
  // other role sees the badges read-only instead of a selector that would fail.
  const mayAssign = canAssignRoles(actorRole);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRole | 'ALL' | 'ADMINS'>('ALL');

  // Organisation-area endpoint (the page's own area): every role that can open
  // the page can load it — GET /admin/mailboxes needs the recipients area.
  const { data: users = [], isLoading, isError, error } = useQuery<AdminUser[]>({
    queryKey: ['admin-rbac-users'],
    queryFn: () => api.get<AdminUser[]>('/admin/organisation/role-assignments').then((r) => (Array.isArray(r) ? r : [])),
  });

  const q = search.trim().toLowerCase();
  const filtered = users.filter(u => {
    if (roleFilter === 'ADMINS' && u.role === 'USER') return false;
    if (roleFilter !== 'ALL' && roleFilter !== 'ADMINS' && u.role !== roleFilter) return false;
    if (q && !(u.displayName ?? '').toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
    return true;
  });

  const adminCount = users.filter(u => u.role !== 'USER').length;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <ShieldHalf size={22} className="text-accent-fg" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-semibold text-fg">{t('rbac_title')}</h1>
          <p className="text-sm text-fg-subtle">
            {users.length} {t('rbac_users')} · {adminCount} {t('rbac_with_admin')}
          </p>
        </div>
      </div>

      {/* Role legend */}
      <div className="bg-surface rounded-lg border border-line p-4 mb-4">
        <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide mb-3">{t('rbac_legend')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {ROLES.filter((r) => r !== 'USER').map((role) => (
            <div key={role} className="flex items-start gap-2">
              <span className="whitespace-nowrap"><RoleBadge role={role} /></span>
              <span className="text-xs text-fg-subtle">{t(`role_desc_${role}`)}</span>
            </div>
          ))}
        </div>
        {!mayAssign && <p className="mt-3 text-xs text-fg-subtle">{t('rbac_readonly_hint')}</p>}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="flex items-center gap-2 bg-surface border border-line-strong rounded px-3 py-1.5 flex-1 max-w-xs focus-within:ring-2 focus-within:ring-accent-fg">
          <Search size={14} className="text-fg-subtle" aria-hidden="true" />
          <input value={search} onChange={e => setSearch(e.target.value)} aria-label={t('rbac_search_ph')}
            className="flex-1 text-sm bg-transparent text-fg placeholder-fg-subtle focus:outline-none"
            placeholder={t('rbac_search_ph')} />
        </div>
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as UserRole | 'ALL' | 'ADMINS')}
          aria-label={t('rbac_col_role')}
          className="bg-surface border border-line-strong rounded px-3 py-1.5 text-sm text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent-fg">
          <option value="ALL">{t('rbac_filter_all')}</option>
          <option value="ADMINS">{t('rbac_filter_admins')}</option>
          {ROLES.map(r => <option key={r} value={r}>{t(`role_label_${r}`)}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="bg-surface rounded-lg border border-line overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-2 border-b border-line text-xs font-semibold text-fg-subtle uppercase tracking-wide">
              <th scope="col" className="text-left px-4 py-3">{t('rbac_col_user')}</th>
              <th scope="col" className="text-left px-4 py-3">{t('rbac_col_status')}</th>
              <th scope="col" className="text-right px-4 py-3">{mayAssign ? t('rbac_col_change') : t('rbac_col_role')}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={3} className="text-center py-12 text-fg-subtle">{t('rbac_loading')}</td></tr>
            ) : isError ? (
              <tr><td colSpan={3} className="text-center py-12 text-danger-fg" role="alert">
                {t('rbac_load_error')}{error instanceof Error && error.message ? `: ${error.message}` : ''}
              </td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={3} className="text-center py-12 text-fg-subtle">{t('rbac_empty')}</td></tr>
            ) : filtered.map(u => (
              <tr key={u.id} className="border-b border-line hover:bg-surface-2">
                <td className="px-4 py-3">
                  <p className="font-medium text-fg">{u.displayName}</p>
                  <p className="text-xs text-fg-subtle">{u.email}</p>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    u.active ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'
                  }`}>
                    {u.active ? t('status_active') : t('status_inactive')}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {mayAssign ? <RoleSelector userId={u.id} currentRole={u.role} /> : <RoleBadge role={u.role} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
