import { useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Modal as AccessibleModal } from '../components/Modal.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Pencil, Trash2, X, KeyRound, ChevronDown,
  UserCheck, UserX, Mail, Shield, HardDrive, Loader2, RefreshCw, Users, LogOut,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { MailboxAliasesSection } from '../components/MailboxAliasesSection.js';
import { ProtocolAccessEditor } from '../components/ProtocolAccessEditor.js';
import { WebmailPolicyEditor } from '../components/WebmailPolicyEditor.js';
import { MailFlowEditor } from '../components/MailFlowEditor.js';
import { EditPanel, ReportDirty, type EditPanelTab } from '../components/EditPanel.js';
import { FolderPermissionsSection } from '../components/FolderPermissionsSection.js';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { Can, WriteGuard } from '../components/Can.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { DetailPanel } from '../components/DetailPanel.js';
import { gbInputToBytes, bytesToGbInput, gbInputValid, quotaOptions, quotaLabel } from '../lib/quotaInput.js';
import { assignableRoles } from '../lib/permissions.js';

// ── Types ────────────────────────────────────────────────────────────────────
interface User {
  id: string; email: string; displayName: string; role: string;
  active: boolean; quotaBytes: number; usedBytes: number;
  domainId: string; createdAt: string;
  /** 8.x: last successful login (web, SSO, mail protocols) — null = never / not yet recorded */
  lastLoginAt?: string | null;
  /** v8.1: explicit quota levels (null = server default) */
  quotaWarningBytes?: number | null;
  quotaProhibitSendBytes?: number | null;
}
type QuotaLevel = 'ok' | 'warning' | 'prohibitSend' | 'prohibitSendReceive';
interface UserDetail extends User {
  /** v8.1: effective levels (explicit or server default) + current level */
  quotaLimits?: { warningBytes: number; prohibitSendBytes: number; prohibitSendReceiveBytes: number };
  quotaLevel?: QuotaLevel;
}
interface Domain { id: string; name: string; active: boolean }
interface DelegateGrantee { id: string; email: string; displayName: string }
interface Delegate { id: string; granteeId: string; permission: string; grantedAt: string; autoMap?: boolean; grantee: DelegateGrantee }
/** Grant form of the delegation section (9.4: autoMap = "Automatisch einblenden"). */
interface DelegateForm { granteeId: string; permission: PermType; autoMap: boolean }

type PermType = 'FULL_ACCESS' | 'READ_ONLY' | 'SEND_AS' | 'SEND_ON_BEHALF';

// ── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

// Labels: i18n role_label_<ROLE> (shared with the RBAC page).
const ROLE_COLORS: Record<string, string> = {
  USER:                    'badge-gray',
  HELP_DESK:               'badge-blue',
  RECIPIENT_MANAGEMENT:    'badge-blue',
  COMPLIANCE_MANAGEMENT:   'badge-blue',
  HYGIENE_MANAGEMENT:      'badge-blue',
  SERVER_MANAGEMENT:       'badge-blue',
  VIEW_ONLY_ORG:           'badge-gray',
  ORGANIZATION_MANAGEMENT: 'badge-orange',
};
const ROLE_KEYS = Object.keys(ROLE_COLORS);
type Translate = ReturnType<typeof useT>;
const roleLabel = (t: Translate, role: string): string =>
  ROLE_KEYS.includes(role) ? t(`role_label_${role}` as 'role_label_USER') : role;

/** Quota select options; 0 = unlimited (server convention), current non-preset values are kept. */
function QuotaOptions({ current }: { current?: number }) {
  const t = useT();
  return <>{quotaOptions(current).map((v) => (
    <option key={v} value={v}>{quotaLabel(v) ?? t('mbox_quota_unlimited')}</option>
  ))}</>;
}

// ── Quota bar ────────────────────────────────────────────────────────────────
function QuotaBar({ used, total, showLabel = false }: { used: number; total: number; showLabel?: boolean }) {
  const t = useT();
  const pct = Math.min(100, total > 0 ? (used / total) * 100 : 0);
  const color = pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warning' : 'bg-accent';
  return (
    <div className="space-y-1 w-full">
      {showLabel && (
        <div className="flex justify-between text-xs text-fg-subtle">
          <span className="font-medium">{formatBytes(used)}</span>
          <span className="text-fg-subtle">{t('mbox_storage_of')} {total > 0 ? formatBytes(total) : t('mbox_quota_unlimited')}</span>
        </div>
      )}
      <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {!showLabel && (
        <div className="flex justify-between text-xs text-fg-subtle">
          <span>{formatBytes(used)}</span>
          <span>{total > 0 ? formatBytes(total) : t('mbox_quota_unlimited')}</span>
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM = {
  email: '', displayName: '', password: '', domainId: '',
  role: 'USER', quotaBytes: 5_368_709_120,
};

// ── Main component ───────────────────────────────────────────────────────────

export function MailboxesPage() {
  const t = useT();
  const qc = useQueryClient();
  const { can, canManage, role: actorRole } = usePermissions();
  const canWrite = can('recipients', 'write');
  // w2b: `?q=` (links from Dienste → Protokolle) starts the list search
  const [searchParams] = useSearchParams();
  const initialQuery = searchParams.get('q');
  const [domainFilter, setDomainFilter] = useState('');
  const [activeId, setActiveId]         = useState<string | null>(null);
  const [showCreate, setShowCreate]     = useState(false);
  const [editUser, setEditUser]         = useState<User | null>(null);
  const [showResetPw, setShowResetPw]   = useState<User | null>(null);
  const [newPassword, setNewPassword]   = useState('');
  const [revokeAppPw, setRevokeAppPw]   = useState(false);
  const [form, setForm]                 = useState({ ...EMPTY_FORM });
  const [localPart, setLocalPart]       = useState('');
  const [delegateForm, setDelegateForm] = useState<Record<string, DelegateForm>>({});

  const { data: mailboxes = [], isLoading, isFetching, refetch } = useQuery<User[]>({
    queryKey: ['admin-mailboxes'],
    queryFn:  () => api.get<User[]>('/admin/mailboxes'),
  });
  // Domains: names for the list + filter. Readable by every role that can read recipients
  // except HELP_DESK — a 403 there just leaves the ids visible.
  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['admin-domains'],
    queryFn:  () => api.get<{ domains: Domain[] }>('/admin/domains?limit=200').then(r => r.domains),
    enabled:  can('domains', 'read'),
  });

  const active = mailboxes.find((u) => u.id === activeId) ?? null;

  // Detail query for the selected user (folders + storage)
  const { data: detail, isFetching: detailLoading } = useQuery<UserDetail>({
    queryKey: ['admin-mailbox-detail', activeId],
    queryFn:  () => api.get<UserDetail>(`/admin/mailboxes/${activeId}`),
    enabled:  !!activeId,
  });

  // Narrow actions (HELP_DESK: reset password / enable-disable / sign out USER
  // accounts) — from GET /admin/me/permissions; admin accounts: ORGANIZATION_MANAGEMENT only.
  const mayOn = (u: User | null) => !!u && canManage(u.role);
  const lastLoginAt = (detail?.id === active?.id ? detail?.lastLoginAt : undefined) ?? active?.lastLoginAt ?? null;

  const domainName = (id: string) => domains.find((d) => d.id === id)?.name ?? id;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
    void qc.invalidateQueries({ queryKey: ['admin-mailbox-detail'] });
    void qc.invalidateQueries({ queryKey: ['admin-rbac-users'] });
    void qc.invalidateQueries({ queryKey: ['admin-users-list-all'] });
  };

  // Create
  const createMutation = useMutation({
    mutationFn: () => api.post('/admin/mailboxes', form),
    onSuccess: () => {
      toast.success(`${t('mbox_created_toast')} ${form.email}`);
      invalidate();
      setShowCreate(false); setForm({ ...EMPTY_FORM }); setLocalPart('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Edit
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.put(`/admin/mailboxes/${id}`, data),
    onSuccess: () => {
      toast.success(t('mbox_saved_toast'));
      invalidate();
      setEditUser(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Enable / disable (a deactivation ends all sessions server-side)
  const toggleMutation = useMutation({
    mutationFn: ({ id, active: a }: { id: string; active: boolean }) =>
      api.put(`/admin/mailboxes/${id}`, { active: a }),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });

  // Delete
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/mailboxes/${id}`),
    onSuccess: (_d, id) => {
      toast.success(t('mbox_deleted_toast'));
      invalidate();
      if (activeId === id) setActiveId(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Bulk (toolbar): delete / disable the selection, one request per mailbox
  const bulkMutation = useMutation({
    mutationFn: async ({ ids, op }: { ids: string[]; op: 'delete' | 'disable' }) => {
      const results = await Promise.allSettled(ids.map((id) =>
        op === 'delete' ? api.delete(`/admin/mailboxes/${id}`) : api.put(`/admin/mailboxes/${id}`, { active: false })));
      return { ok: results.filter((r) => r.status === 'fulfilled').length, failed: results.filter((r) => r.status === 'rejected').length };
    },
    onSuccess: ({ ok, failed }) => {
      if (ok) toast.success(`${ok} ${t('mbox_bulk_done')}`);
      if (failed) toast.error(`${failed} ${t('mbox_bulk_failed')}`);
      invalidate();
    },
  });

  // Password reset (ends all web/API sessions — "sign out everywhere")
  const resetPwMutation = useMutation({
    mutationFn: ({ id, password, revoke }: { id: string; password: string; revoke: boolean }) =>
      api.put(`/admin/mailboxes/${id}`, { password, ...(revoke ? { revokeAppPasswords: true } : {}) }),
    onSuccess: () => { toast.success(t('mbox_pw_changed')); setShowResetPw(null); setNewPassword(''); setRevokeAppPw(false); },
    onError: (err: Error) => toast.error(err.message),
  });

  // v8.1: sign out everywhere (ends all web/API sessions of the user)
  const revokeSessionsMutation = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; sessionsRevoked: number }>(`/admin/mailboxes/${id}/revoke-sessions`, {}),
    onSuccess: (r) => toast.success(`${t('mbox_signout_done')} ${r.sessionsRevoked}`),
    onError: (err: Error) => toast.error(err.message),
  });

  // Recalculate quota (all)
  const recalcAllMutation = useMutation({
    mutationFn: () => api.post('/admin/mailboxes/recalculate-all-quotas', {}),
    onSuccess: () => {
      toast.success(t('mbox_storage_updated'));
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Delegates of the selected user
  const { data: delegates = [], refetch: refetchDelegates } = useQuery<Delegate[]>({
    queryKey: ['admin-mailbox-delegates', activeId],
    queryFn:  () => api.get<Delegate[]>(`/admin/mailboxes/${activeId}/delegates`),
    enabled:  !!activeId,
  });

  const grantDelegateMutation = useMutation({
    mutationFn: ({ userId, granteeId, permission, autoMap }: { userId: string; granteeId: string; permission: string; autoMap: boolean }) =>
      api.post(`/admin/mailboxes/${userId}/delegates`, { granteeId, permission, autoMap }),
    onSuccess: (_data, vars) => {
      toast.success(t('delegate_saved'));
      setDelegateForm((prev) => ({ ...prev, [vars.userId]: { granteeId: '', permission: 'READ_ONLY', autoMap: true } }));
      void refetchDelegates();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const revokeDelegateMutation = useMutation({
    mutationFn: ({ userId, granteeId }: { userId: string; granteeId: string }) =>
      api.delete(`/admin/mailboxes/${userId}/delegates/${granteeId}`),
    onSuccess: () => {
      toast.success(t('delegate_revoked'));
      void refetchDelegates();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rows = useMemo(
    () => (domainFilter ? mailboxes.filter((u) => u.domainId === domainFilter) : mailboxes),
    [mailboxes, domainFilter],
  );

  // Create-Dialog Helpers
  function selectDomain(domainId: string) {
    const d = domains.find((x) => x.id === domainId);
    setForm({ ...form, domainId, email: localPart && d ? `${localPart}@${d.name}` : '' });
  }
  function setLocal(val: string) {
    setLocalPart(val);
    const d = domains.find((x) => x.id === form.domainId);
    setForm({ ...form, email: d ? `${val}@${d.name}` : val });
  }
  const openReset = (u: User) => { setShowResetPw(u); setNewPassword(''); setRevokeAppPw(false); };
  const confirmDelete = (u: User) => { if (confirm(`${t('mbox_delete_confirm')} "${u.email}"`)) deleteMutation.mutate(u.id); };

  const columns: Column<User>[] = [
    {
      key: 'user', header: t('mbox_col_user'),
      sortValue: (u) => (u.displayName || u.email).toLowerCase(),
      cell: (u) => (
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center shrink-0" aria-hidden="true">
            <span className="text-sm font-semibold text-accent-fg">{(u.displayName ?? u.email ?? '?').charAt(0).toUpperCase()}</span>
          </div>
          <div className="min-w-0">
            <p className="font-medium text-fg truncate">{u.displayName ?? u.email}</p>
            <p className="text-xs text-fg-subtle flex items-center gap-1 truncate"><Mail size={10} aria-hidden="true" />{u.email}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'domain', header: t('mbox_col_domain'),
      sortValue: (u) => domainName(u.domainId),
      cell: (u) => <span className="text-xs font-mono bg-surface-2 text-fg-muted px-2 py-0.5 rounded">{domainName(u.domainId)}</span>,
    },
    {
      key: 'role', header: t('mbox_col_role'),
      sortValue: (u) => roleLabel(t, u.role),
      cell: (u) => {
        const role = { label: roleLabel(t, u.role), color: ROLE_COLORS[u.role] ?? 'badge-gray' };
        return (
          <span className={`badge text-xs ${role.color} flex items-center gap-1 w-fit`}>
            {u.role === 'ORGANIZATION_MANAGEMENT' && <Shield size={10} aria-hidden="true" />}
            {role.label}
          </span>
        );
      },
    },
    {
      key: 'storage', header: t('mbox_col_storage'), className: 'w-48',
      sortValue: (u) => (u.quotaBytes > 0 ? u.usedBytes / u.quotaBytes : 0),
      cell: (u) => {
        const pct = u.quotaBytes > 0 ? Math.min(100, (u.usedBytes / u.quotaBytes) * 100) : 0;
        return (
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className={`font-medium ${pct > 90 ? 'text-danger-fg' : pct > 70 ? 'text-warning-fg' : 'text-fg-muted'}`}>{formatBytes(u.usedBytes)}</span>
              <span className="text-fg-subtle">{u.quotaBytes > 0 ? formatBytes(u.quotaBytes) : t('mbox_quota_unlimited')}</span>
            </div>
            <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}
              aria-label={t('mbox_col_storage')}>
              <div className={`h-full rounded-full transition-all ${pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      },
    },
    {
      key: 'status', header: t('mbox_col_status'),
      sortValue: (u) => u.active,
      cell: (u) => (
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
          u.active ? 'bg-success-bg border-success-line text-success-fg' : 'bg-danger-bg border-danger-line text-danger-fg'}`}>
          {u.active ? <><UserCheck size={11} aria-hidden="true" /> {t('status_active')}</> : <><UserX size={11} aria-hidden="true" /> {t('status_disabled')}</>}
        </span>
      ),
    },
    {
      key: 'actions', header: t('mbox_col_actions'), srOnlyHeader: true,
      cell: (u) => (
        <Can area="recipients" access="write">
          <div className="flex items-center gap-1">
            <button onClick={() => setEditUser(u)} className="btn-ghost p-1.5 rounded" title={t('mbox_btn_edit_title')} aria-label={`${t('mbox_btn_edit_title')}: ${u.email}`}>
              <Pencil size={13} className="text-fg-subtle" />
            </button>
            <button onClick={() => confirmDelete(u)} className="btn-ghost p-1.5 rounded" title={t('mbox_btn_delete_title')} aria-label={`${t('mbox_btn_delete_title')}: ${u.email}`}>
              <Trash2 size={13} className="text-danger-fg" />
            </button>
          </div>
        </Can>
      ),
    },
  ];

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-fg">{t('mbox_page_title')}</h1>
        <p className="text-xs text-fg-subtle mt-0.5">{mailboxes.length} {t('mbox_total')}</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div className="flex-1 min-w-0 w-full">
          <DataTable<User>
            caption={t('mbox_page_title')}
            rows={rows}
            columns={columns}
            rowKey={(u) => u.id}
            loading={isLoading}
            initialSort={{ key: 'user', dir: 'asc' }}
            search={{
              placeholder: t('mbox_filter_placeholder'), text: (u) => [u.email, u.displayName, domainName(u.domainId)],
              ...(initialQuery ? { initial: initialQuery } : {}),
            }}
            selectable={canWrite}
            onActivate={(u) => setActiveId(u.id)}
            activeKey={activeId}
            rowClassName={(u) => (!u.active ? 'bg-surface-2' : '')}
            emptyText={domainFilter ? t('mbox_no_results') : undefined}
            filters={domains.length > 0 && (
              <div className="relative">
                <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)}
                  className="input pr-8 appearance-none cursor-pointer" aria-label={t('mbox_filter_all_domains')}>
                  <option value="">{t('mbox_filter_all_domains')}</option>
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>{d.name} ({mailboxes.filter((u) => u.domainId === d.id).length})</option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" aria-hidden="true" />
              </div>
            )}
            toolbar={({ selectedRows, clearSelection }) => (
              <>
                <Can area="recipients" access="write">
                  <button onClick={() => { setForm({ ...EMPTY_FORM }); setLocalPart(''); setShowCreate(true); }}
                    className="btn-primary flex items-center gap-1.5">
                    <Plus size={15} aria-hidden="true" /> {t('mbox_new_user')}
                  </button>
                </Can>
                <Can area="recipients" access="write">
                  <button className="btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-40"
                    disabled={selectedRows.length !== 1}
                    onClick={() => selectedRows[0] && setEditUser(selectedRows[0])}>
                    <Pencil size={13} aria-hidden="true" /> {t('tb_edit')}
                  </button>
                </Can>
                <Can area="recipients" access="write">
                  <button className="btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-40"
                    disabled={selectedRows.length === 0 || bulkMutation.isPending}
                    onClick={() => {
                      if (!confirm(`${t('mbox_bulk_disable_confirm')} (${selectedRows.length})`)) return;
                      bulkMutation.mutate({ ids: selectedRows.map((u) => u.id), op: 'disable' }, { onSuccess: clearSelection });
                    }}>
                    <UserX size={13} aria-hidden="true" /> {t('mbox_quick_disable')}
                  </button>
                </Can>
                <Can area="recipients" access="write">
                  <button className="btn-secondary flex items-center gap-1.5 text-xs text-danger-fg disabled:opacity-40"
                    disabled={selectedRows.length === 0 || bulkMutation.isPending}
                    onClick={() => {
                      if (!confirm(`${t('tb_delete_selected_confirm')} (${selectedRows.length})\n${selectedRows.map((u) => u.email).join('\n')}`)) return;
                      bulkMutation.mutate({ ids: selectedRows.map((u) => u.id), op: 'delete' }, { onSuccess: clearSelection });
                    }}>
                    <Trash2 size={13} aria-hidden="true" /> {t('tb_delete')}
                  </button>
                </Can>
                <button onClick={() => void refetch()} className="btn-secondary flex items-center gap-1.5 text-xs" aria-label={t('tb_refresh')}>
                  <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} aria-hidden="true" /> {t('tb_refresh')}
                </button>
                <Can area="recipients" access="write">
                  <button
                    onClick={() => recalcAllMutation.mutate()}
                    disabled={recalcAllMutation.isPending}
                    className="btn-secondary flex items-center gap-1.5 text-xs"
                    title={t('mbox_recalc_title')}
                  >
                    <HardDrive size={13} className={recalcAllMutation.isPending ? 'animate-pulse' : ''} aria-hidden="true" />
                    {t('mbox_recalc_storage')}
                  </button>
                </Can>
              </>
            )}
          />
        </div>

        {/* ── Details pane ─────────────────────────────────────────────────── */}
        {active && (
          <DetailPanel
            title={active.displayName || active.email}
            subtitle={active.email}
            onClose={() => setActiveId(null)}
            actions={
              <div className="flex flex-wrap gap-1.5">
                {/* Each quick action follows its own right (HELP_DESK: reset / enable-disable / sign out). */}
                <Can area="recipients" access="write">
                  <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => setEditUser(active)}>
                    <Pencil size={12} aria-hidden="true" /> {t('tb_edit')}
                  </button>
                </Can>
                {mayOn(active) && (
                  <>
                    <Can action="resetPassword">
                      <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => openReset(active)}>
                        <KeyRound size={12} aria-hidden="true" /> {t('mbox_reset_pw_title')}
                      </button>
                    </Can>
                    <Can action="revokeSessions">
                      <button className="btn-secondary text-xs flex items-center gap-1"
                        onClick={() => { if (confirm(`${t('mbox_signout_confirm')}\n\n${active.email}`)) revokeSessionsMutation.mutate(active.id); }}
                        disabled={revokeSessionsMutation.isPending}>
                        <LogOut size={12} aria-hidden="true" /> {t('mbox_signout_title')}
                      </button>
                    </Can>
                    <Can action="toggleActive">
                      <button className="btn-secondary text-xs flex items-center gap-1"
                        onClick={() => {
                          if (active.active && !confirm(`${t('mbox_disable_confirm')} "${active.email}"`)) return;
                          toggleMutation.mutate({ id: active.id, active: !active.active });
                        }}
                        disabled={toggleMutation.isPending}>
                        {active.active
                          ? <><UserX size={12} aria-hidden="true" /> {t('mbox_quick_disable')}</>
                          : <><UserCheck size={12} aria-hidden="true" /> {t('mbox_quick_enable')}</>}
                      </button>
                    </Can>
                  </>
                )}
                <Can area="recipients" access="write">
                  <button className="btn-secondary text-xs flex items-center gap-1 text-danger-fg" onClick={() => confirmDelete(active)}>
                    <Trash2 size={12} aria-hidden="true" /> {t('tb_delete')}
                  </button>
                </Can>
              </div>
            }
          >
            {/* Quota / usage */}
            <section aria-label={t('mbox_detail_total_storage')} className="space-y-2">
              <h3 className="text-xs font-medium text-fg-subtle flex items-center gap-1.5">
                <HardDrive size={12} className="text-accent-fg" aria-hidden="true" /> {t('mbox_detail_total_storage')}
              </h3>
              <QuotaBar used={detail?.id === active.id ? detail.usedBytes : active.usedBytes}
                total={active.quotaBytes} showLabel />
              {/* v8.1: quota levels */}
              {detail?.id === active.id && detail.quotaLimits && (
                <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-fg-subtle">{t('mbox_quota_warning').replace(' (GB)', '')}</dt>
                  <dd className="text-fg-muted">{detail.quotaLimits.warningBytes > 0 ? formatBytes(detail.quotaLimits.warningBytes) : '—'}</dd>
                  <dt className="text-fg-subtle">{t('mbox_quota_prohibit_send').replace(' (GB)', '')}</dt>
                  <dd className="text-fg-muted">{detail.quotaLimits.prohibitSendBytes > 0 ? formatBytes(detail.quotaLimits.prohibitSendBytes) : '—'}</dd>
                  <dt className="text-fg-subtle">{t('mbox_quota_receive_limit')}</dt>
                  <dd className="text-fg-muted">{detail.quotaLimits.prohibitSendReceiveBytes > 0 ? formatBytes(detail.quotaLimits.prohibitSendReceiveBytes) : '—'}</dd>
                  {detail.quotaLevel && (
                    <dd className={`col-span-2 font-medium ${
                      detail.quotaLevel === 'ok' ? 'text-fg-subtle'
                        : detail.quotaLevel === 'warning' ? 'text-warning-fg' : 'text-danger-fg'}`}>
                      {t(`mbox_quota_level_${detail.quotaLevel}` as 'mbox_quota_level_ok')}
                    </dd>
                  )}
                </dl>
              )}
            </section>

            {/* Facts */}
            <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-fg-subtle">{t('mbox_col_role')}</dt>
              <dd className="text-fg-muted">{roleLabel(t, active.role)}</dd>
              <dt className="text-fg-subtle">{t('mbox_col_status')}</dt>
              <dd className="text-fg-muted">{active.active ? t('status_active') : t('status_disabled')}</dd>
              <dt className="text-fg-subtle">{t('mbox_col_domain')}</dt>
              <dd className="text-fg-muted font-mono">{domainName(active.domainId)}</dd>
              <dt className="text-fg-subtle">{t('mbox_last_login')}</dt>
              <dd className="text-fg-muted">
                {lastLoginAt
                  ? <time dateTime={lastLoginAt}>{new Date(lastLoginAt).toLocaleString()}</time>
                  : <span className="text-fg-subtle">{t('mbox_last_login_none')}</span>}
              </dd>
              <dt className="text-fg-subtle">{t('mbox_detail_created')}</dt>
              <dd className="text-fg-muted">{new Date(active.createdAt).toLocaleDateString()}</dd>
            </dl>

            {detailLoading && detail?.id !== active.id && (
              <p className="flex items-center gap-2 text-fg-subtle text-xs" role="status">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" /> {t('mbox_detail_loading')}
              </p>
            )}

            {/* Aliases (existing component; write actions are gated by the area) */}
            <WriteGuard area="recipients">
              <MailboxAliasesSection key={active.id}
                mailboxType="user"
                mailboxId={active.id}
                defaultDomainId={active.domainId}
                allDomains={domains.map((d) => ({ id: d.id, name: d.name }))}
              />
            </WriteGuard>

            {/* Delegates */}
            <WriteGuard area="recipients">
              <DelegateSection
                userId={active.id}
                allUsers={mailboxes}
                delegates={delegates}
                delegateForm={delegateForm[active.id] ?? { granteeId: '', permission: 'READ_ONLY', autoMap: true }}
                onFormChange={(f) => setDelegateForm((prev) => ({ ...prev, [active.id]: f }))}
                onGrant={() => {
                  const f = delegateForm[active.id];
                  if (f?.granteeId) grantDelegateMutation.mutate({ userId: active.id, granteeId: f.granteeId, permission: f.permission, autoMap: f.autoMap });
                }}
                onRevoke={(granteeId) => revokeDelegateMutation.mutate({ userId: active.id, granteeId })}
                isPending={grantDelegateMutation.isPending || revokeDelegateMutation.isPending}
              />
            </WriteGuard>

            <p className="text-xs text-fg-subtle">{t('mbox_detail_id')}: <code className="bg-surface-2 px-1 rounded">{active.id}</code></p>
          </DetailPanel>
        )}
      </div>

      {/* ── Dialog: New user ────────────────────────────────────────────────── */}
      {showCreate && (
        <Modal title={t('mbox_create_title')} onClose={() => setShowCreate(false)}>
          <div className="space-y-4">
            <div>
              <label className="field-label" htmlFor="mbox-create-domain">{t('mbox_create_domain')} <span className="text-danger-fg">*</span></label>
              <select id="mbox-create-domain" className="input w-full" value={form.domainId} onChange={(e) => selectDomain(e.target.value)}>
                <option value="">{t('mbox_create_domain_select')}</option>
                {domains.filter(d => d.active).map((d) => <option key={d.id} value={d.id}>@{d.name}</option>)}
              </select>
              {domains.filter(d => d.active).length === 0 && (
                <p className="text-xs text-warning-fg mt-1">
                  {domains.length === 0
                    ? t('mbox_create_domain_none')
                    : t('mbox_create_domain_inactive')}
                </p>
              )}
            </div>
            <div>
              <label className="field-label" htmlFor="mbox-create-local">{t('mbox_create_email')} <span className="text-danger-fg">*</span></label>
              <div className="flex">
                <input id="mbox-create-local" className="input rounded-r-none flex-1" placeholder={t('mbox_create_local_ph')}
                  value={localPart} onChange={(e) => setLocal(e.target.value)} />
                <span className="px-3 py-2 bg-surface-2 border border-l-0 border-line-strong text-fg-subtle text-sm rounded-r">
                  @{form.domainId ? domainName(form.domainId) : 'domain.com'}
                </span>
              </div>
              {form.email && <p className="text-xs text-fg-subtle mt-1">→ {form.email}</p>}
            </div>
            <div>
              <label className="field-label" htmlFor="mbox-create-name">{t('mbox_create_displayname')} <span className="text-danger-fg">*</span></label>
              <input id="mbox-create-name" className="input w-full" placeholder={t('mbox_create_name_ph')}
                value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </div>
            <div>
              <label className="field-label" htmlFor="mbox-create-pw">{t('mbox_create_password')} <span className="text-danger-fg">*</span></label>
              <input id="mbox-create-pw" type="password" className="input w-full" placeholder={t('mbox_create_pw_hint')}
                value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              {form.password && form.password.length < 8 && (
                <p className="text-xs text-danger-fg mt-1">{t('mbox_create_pw_short')}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label" htmlFor="mbox-create-role">{t('mbox_create_role')}</label>
                <select id="mbox-create-role" className="input w-full" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {assignableRoles(ROLE_KEYS, actorRole).map((v) => <option key={v} value={v}>{roleLabel(t, v)}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label flex items-center gap-1" htmlFor="mbox-create-quota"><HardDrive size={12} aria-hidden="true" /> {t('mbox_create_quota')}</label>
                <select id="mbox-create-quota" className="input w-full" value={form.quotaBytes}
                  onChange={(e) => setForm({ ...form, quotaBytes: parseInt(e.target.value) })}>
                  <QuotaOptions />
                </select>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <button onClick={() => setShowCreate(false)} className="btn-secondary">{t('action_cancel')}</button>
            <button
              onClick={() => createMutation.mutate()}
              disabled={!form.email || !form.password || form.password.length < 8 || !form.domainId || !form.displayName || createMutation.isPending}
              className="btn-primary disabled:opacity-50 flex items-center gap-2"
            >
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('mbox_create_btn')}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Panel: Edit ────────────────────────────────────────────────────── */}
      {editUser && (
        <UserEditPanel user={editUser} domains={domains}
          onSave={(data) => updateMutation.mutate({ id: editUser.id, data })}
          isPending={updateMutation.isPending}
          onClose={() => setEditUser(null)} />
      )}

      {/* ── Dialog: Password reset ─────────────────────────────────────────── */}
      {showResetPw && (
        <Modal title={`${t('mbox_reset_pw_title')} — ${showResetPw.email}`} onClose={() => setShowResetPw(null)}>
          <div className="space-y-3">
            <p className="text-sm text-fg-muted">{t('mbox_reset_pw_for')} <strong>{showResetPw.displayName}</strong>:</p>
            <input type="password" className="input w-full" placeholder={t('mbox_reset_pw_placeholder')}
              aria-label={t('mbox_reset_pw_placeholder')}
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus />
            {newPassword && newPassword.length < 8 && (
              <p className="text-xs text-danger-fg">{t('mbox_create_pw_short')}</p>
            )}
            <label className="flex items-start gap-2 text-xs text-fg-muted">
              <input type="checkbox" className="mt-0.5" checked={revokeAppPw} onChange={(e) => setRevokeAppPw(e.target.checked)} />
              {t('mbox_reset_pw_revoke_app')}
            </label>
            <p className="text-xs text-fg-subtle">{t('mbox_quick_signout_hint')}</p>
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <button onClick={() => setShowResetPw(null)} className="btn-secondary">{t('action_cancel')}</button>
            <button
              onClick={() => resetPwMutation.mutate({ id: showResetPw.id, password: newPassword, revoke: revokeAppPw })}
              disabled={newPassword.length < 8 || resetPwMutation.isPending}
              className="btn-primary disabled:opacity-50 flex items-center gap-2"
            >
              {resetPwMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('mbox_reset_pw_btn')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  return (
    <AccessibleModal
      onClose={onClose}
      labelledBy={titleId}
      overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50 p-4"
      className="bg-surface rounded-xl shadow-2xl w-full max-w-lg"
    >
        <div className="flex items-center justify-between px-6 py-4 border-b border-line">
          <h2 id={titleId} className="text-base font-semibold text-fg">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t('action_close')} className="btn-ghost p-1 rounded"><X size={16} className="text-fg-subtle" aria-hidden="true" /></button>
        </div>
        <div className="px-6 py-5">{children}</div>
    </AccessibleModal>
  );
}

// ── Edit panel ───────────────────────────────────────────────────────────────
function UserEditPanel({ user, domains, onSave, isPending, onClose }:
  { user: User; domains: Domain[]; onSave: (d: Record<string, unknown>) => void; isPending: boolean; onClose: () => void }
) {
  const t = useT();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole]               = useState(user.role);
  const [quotaBytes, setQuotaBytes]   = useState(user.quotaBytes);
  const [warningGb, setWarningGb]     = useState(bytesToGbInput(user.quotaWarningBytes));
  const [sendGb, setSendGb]           = useState(bytesToGbInput(user.quotaProhibitSendBytes));
  const { role: actorRole } = usePermissions();
  const levelsValid = gbInputValid(warningGb) && gbInputValid(sendGb);
  const domainLabel = `@${domains.find((d) => d.id === user.domainId)?.name ?? user.domainId}`;

  const generalDirty = displayName !== user.displayName || role !== user.role;
  const limitsDirty = quotaBytes !== user.quotaBytes
    || warningGb !== bytesToGbInput(user.quotaWarningBytes) || sendGb !== bytesToGbInput(user.quotaProhibitSendBytes);

  const save = (
    <div className="flex justify-end pt-1">
      <button
        onClick={() => onSave({
          displayName: displayName.trim(), quotaBytes,
          // role only when changed — a role change ends the account's sessions
          ...(role !== user.role ? { role } : {}),
          quotaWarningBytes: gbInputToBytes(warningGb),
          quotaProhibitSendBytes: gbInputToBytes(sendGb),
        })}
        disabled={!displayName.trim() || !levelsValid || isPending}
        className="btn-primary disabled:opacity-50 flex items-center gap-2"
      >
        {isPending && <Loader2 size={14} className="animate-spin" />}
        {t('action_save')}
      </button>
    </div>
  );

  const tabs: EditPanelTab[] = [
    {
      id: 'general', label: t('mbox_tab_general'),
      content: (
        <WriteGuard area="recipients">
          <ReportDirty dirty={generalDirty} />
          <div className="space-y-4">
            <div>
              <label className="field-label" htmlFor="mbox-edit-email">{t('mbox_edit_email')}</label>
              <input id="mbox-edit-email" className="input w-full bg-surface-2 cursor-not-allowed" value={user.email} disabled />
            </div>
            <div>
              <label className="field-label" htmlFor="mbox-edit-domain">{t('mbox_edit_domain')}</label>
              <input id="mbox-edit-domain" className="input w-full bg-surface-2 cursor-not-allowed" value={domainLabel} disabled />
            </div>
            <div>
              <label className="field-label" htmlFor="mbox-edit-name">{t('mbox_edit_displayname')}</label>
              <input id="mbox-edit-name" className="input w-full" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div>
              <label className="field-label" htmlFor="mbox-edit-role">{t('mbox_create_role')}</label>
              <select id="mbox-edit-role" className="input w-full" value={role} onChange={(e) => setRole(e.target.value)}>
                {assignableRoles(ROLE_KEYS, actorRole, user.role).map((v) => <option key={v} value={v}>{roleLabel(t, v)}</option>)}
              </select>
            </div>
            {save}
            <div className="border-t border-line pt-4">
              <MailboxAliasesSection
                mailboxType="user"
                mailboxId={user.id}
                defaultDomainId={user.domainId}
                allDomains={domains.map((d) => ({ id: d.id, name: d.name }))}
              />
            </div>
          </div>
        </WriteGuard>
      ),
    },
    {
      id: 'limits', label: t('mbox_tab_limits'),
      content: (
        <WriteGuard area="recipients">
          <ReportDirty dirty={limitsDirty} />
          <div className="space-y-4">
            <div>
              <label className="field-label flex items-center gap-1" htmlFor="mbox-edit-quota"><HardDrive size={12} aria-hidden="true" /> {t('mbox_create_quota')}</label>
              <select id="mbox-edit-quota" className="input w-full" value={quotaBytes} onChange={(e) => setQuotaBytes(parseInt(e.target.value))}>
                <QuotaOptions current={user.quotaBytes} />
              </select>
            </div>
            {/* v8.1: quota levels (warning / prohibit send / prohibit send+receive) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label" htmlFor="mbox-quota-warning">{t('mbox_quota_warning')}</label>
                <input id="mbox-quota-warning" className="input w-full" inputMode="decimal" value={warningGb}
                  placeholder={t('mbox_quota_default_hint')} onChange={(e) => setWarningGb(e.target.value)} />
              </div>
              <div>
                <label className="field-label" htmlFor="mbox-quota-send">{t('mbox_quota_prohibit_send')}</label>
                <input id="mbox-quota-send" className="input w-full" inputMode="decimal" value={sendGb}
                  placeholder={t('mbox_quota_default_hint')} onChange={(e) => setSendGb(e.target.value)} />
              </div>
              {/* a typo used to be saved silently as "server default" */}
              {!levelsValid && <p className="col-span-2 text-xs text-danger-fg" role="alert">{t('mbox_quota_invalid')}</p>}
            </div>
            {save}
          </div>
        </WriteGuard>
      ),
    },
    // 9.4: per-mailbox mail flow
    { id: 'flow', label: t('mbox_tab_flow'), content: <MailFlowEditor path={`/admin/mailboxes/${user.id}/mail-flow`} kind="user" /> },
    // w3: folder permissions
    { id: 'folders', label: t('mbox_tab_folders'), content: <FolderPermissionsSection basePath={`/admin/mailboxes/${user.id}`} ownerUserId={user.id} /> },
    // 9.4: protocol access (user level)
    { id: 'protocols', label: t('mbox_tab_protocols'), content: <ProtocolAccessEditor path={`/admin/protocol-access/users/${user.id}`} area="recipients" /> },
    // 9.4: webmail policies (user level)
    { id: 'webmail', label: t('mbox_tab_webmail'), content: <WebmailPolicyEditor path={`/admin/webmail-policies/users/${user.id}`} area="recipients" /> },
  ];

  return <EditPanel kind="mailbox" title={user.displayName} subtitle={user.email} tabs={tabs} onClose={onClose} />;
}

// ── Delegate Section ─────────────────────────────────────────────────────────
const PERM_LABELS: Record<string, string> = {
  FULL_ACCESS:     'delegate_perm_full',
  READ_ONLY:       'delegate_perm_readonly',
  SEND_AS:         'delegate_perm_sendas',
  SEND_ON_BEHALF:  'delegate_perm_sendonbehalf',
};

function DelegateSection({
  userId, allUsers, delegates, delegateForm, onFormChange, onGrant, onRevoke, isPending,
}: {
  userId: string;
  allUsers: User[];
  delegates: Delegate[];
  delegateForm: DelegateForm;
  onFormChange: (f: DelegateForm) => void;
  onGrant: () => void;
  onRevoke: (granteeId: string) => void;
  isPending: boolean;
}) {
  const t = useT();
  // All users except the mailbox owner and those already delegated
  const alreadyGranted = new Set(delegates.map((d) => d.granteeId));
  const available = allUsers.filter((u) => u.id !== userId && !alreadyGranted.has(u.id));

  return (
    <div className="bg-surface border border-line rounded-lg overflow-hidden">
      <p className="text-xs font-medium text-fg-subtle px-4 py-2 bg-surface-2 border-b border-line flex items-center gap-1.5">
        <Users size={12} /> {t('delegate_section')}
      </p>

      {/* Existing delegates */}
      {delegates.length === 0 ? (
        <p className="px-4 py-3 text-xs text-fg-subtle">{t('delegate_no_delegates')}</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line">
              <th className="text-left px-4 py-1.5 text-fg-subtle font-medium">{t('delegate_user')}</th>
              <th className="text-left px-4 py-1.5 text-fg-subtle font-medium">{t('delegate_permission')}</th>
              <th className="px-4 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {delegates.map((d) => (
              <tr key={d.id} className="hover:bg-surface-2">
                <td className="px-4 py-1.5">
                  <span className="font-medium text-fg-muted">{d.grantee.displayName}</span>
                  <span className="text-fg-subtle ml-1">({d.grantee.email})</span>
                </td>
                <td className="px-4 py-1.5 text-fg-muted">
                  {t((PERM_LABELS[d.permission] ?? d.permission) as Parameters<typeof t>[0])}
                  {d.autoMap === false && <span className="ml-1 text-fg-subtle">({t('shared_perm_not_automapped')})</span>}
                </td>
                <td className="px-4 py-1.5 text-right">
                  <button
                    onClick={() => onRevoke(d.granteeId)}
                    disabled={isPending}
                    className="text-danger-fg hover:text-danger-fg disabled:opacity-40 text-xs"
                  >
                    {t('delegate_revoke')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Grant access form */}
      <div className="px-4 py-3 border-t border-line bg-surface-2/50 flex items-center gap-2 flex-wrap">
        <select
          className="input text-xs flex-1 min-w-40"
          value={delegateForm.granteeId}
          onChange={(e) => onFormChange({ ...delegateForm, granteeId: e.target.value })}
        >
          <option value="">{t('delegate_user')}…</option>
          {available.map((u) => (
            <option key={u.id} value={u.id}>{u.displayName} ({u.email})</option>
          ))}
        </select>
        <select
          className="input text-xs w-44"
          value={delegateForm.permission}
          onChange={(e) => onFormChange({ ...delegateForm, permission: e.target.value as PermType })}
        >
          {Object.entries(PERM_LABELS).map(([val, key]) => (
            <option key={val} value={val}>{t(key as Parameters<typeof t>[0])}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer select-none" title={t('shared_perm_automap_hint')}>
          <input type="checkbox" checked={delegateForm.autoMap} onChange={(e) => onFormChange({ ...delegateForm, autoMap: e.target.checked })} className="rounded" />
          {t('shared_perm_automap')}
        </label>
        <button
          onClick={onGrant}
          disabled={!delegateForm.granteeId || isPending}
          className="btn-primary text-xs py-1.5 px-3 disabled:opacity-40 flex items-center gap-1"
        >
          {isPending && <Loader2 size={11} className="animate-spin" />}
          {t('delegate_add')}
        </button>
      </div>
    </div>
  );
}
