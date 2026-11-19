import { useId, useState, useEffect } from 'react';
import { Modal } from '../components/Modal.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Inbox, Plus, Trash2, Pencil, UserPlus, X, Loader2, Shield, RefreshCw, HardDrive } from 'lucide-react';
import { api } from '../api/client.js';
import { MailboxAliasesSection } from '../components/MailboxAliasesSection.js';
import { MailFlowEditor } from '../components/MailFlowEditor.js';
import { EditPanel, ReportDirty, type EditPanelTab } from '../components/EditPanel.js';
import { FolderPermissionsSection } from '../components/FolderPermissionsSection.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { Can, WriteGuard } from '../components/Can.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { gbInputToBytes, bytesToGbInput, gbInputValid, quotaOptions, quotaLabel } from '../lib/quotaInput.js';

type PermType = 'FULL_ACCESS' | 'SEND_AS' | 'SEND_ON_BEHALF' | 'READ_ONLY';

interface Perm {
  id: string; userId: string; permission: PermType; grantedAt: string;
  /** 9.4 auto-mapping ("Automatisch einblenden"), default true. */
  autoMap?: boolean;
  user: { email: string; displayName: string };
}
interface SharedMailbox {
  id: string; email: string; displayName: string; domainId: string;
  quotaBytes: number; usedBytes: number; active: boolean; createdAt: string;
  quotaWarningBytes?: number | null; quotaProhibitSendBytes?: number | null;
  /** 9.4: copy of mail sent as / on behalf of the box into its Sent folder. */
  sentCopySendAs?: boolean; sentCopySendOnBehalf?: boolean;
  permissions: Perm[];
}
interface Domain { id: string; name: string; active?: boolean }
interface User   { id: string; email: string; displayName: string }

// i18n keys (shared with the mailbox delegation section)
const PERM_KEYS: Record<PermType, { label: TranslationKey; desc: TranslationKey }> = {
  FULL_ACCESS:    { label: 'delegate_perm_full',         desc: 'shared_perm_desc_full' },
  SEND_AS:        { label: 'delegate_perm_sendas',       desc: 'shared_perm_desc_sendas' },
  SEND_ON_BEHALF: { label: 'delegate_perm_sendonbehalf', desc: 'shared_perm_desc_onbehalf' },
  READ_ONLY:      { label: 'delegate_perm_readonly',     desc: 'shared_perm_desc_readonly' },
};
const PERM_ORDER: PermType[] = ['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY'];

export function SharedMailboxesPage() {
  const t = useT();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canWrite = can('recipients', 'write');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [editId, setEditId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [permId, setPermId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Server-side search + paging (API: search/page/limit)
  const { data, isLoading, isFetching, refetch } = useQuery<{ items: SharedMailbox[]; total: number }>({
    queryKey: ['admin-shared-mailboxes', debouncedSearch, page, limit],
    queryFn: () => api.get(`/admin/shared-mailboxes?search=${encodeURIComponent(debouncedSearch)}&page=${page}&limit=${limit}`),
    placeholderData: (prev) => prev,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/shared-mailboxes/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] }); toast.success(t('shared_deleted')); },
    onError: (e: Error) => toast.error(e.message || t('shared_delete_failed')),
  });
  const bulkDelete = useMutation({
    mutationFn: async (ids: string[]) => {
      const r = await Promise.allSettled(ids.map((id) => api.delete(`/admin/shared-mailboxes/${id}`)));
      return r.filter((x) => x.status === 'rejected').length;
    },
    onSuccess: (failed) => {
      void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] });
      if (failed) toast.error(`${failed} × ${t('shared_delete_failed')}`); else toast.success(t('shared_deleted'));
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  // Modals read the LIVE row: after a save the list refetches and the modal shows
  // the new state (it used to keep the snapshot taken when it was opened).
  const editItem = items.find((i) => i.id === editId) ?? null;
  const permItem = items.find((i) => i.id === permId) ?? null;
  const confirmDelete = (item: SharedMailbox) => {
    if (window.confirm(`"${item.email}" ${t('shared_delete_confirm')}`)) deleteMutation.mutate(item.id);
  };

  const columns: Column<SharedMailbox>[] = [
    {
      key: 'email', header: t('shared_col_email'),
      cell: (item) => (
        <>
          <p className="font-medium text-fg text-sm">{item.email}</p>
          <p className="text-xs text-fg-subtle">{item.displayName}</p>
        </>
      ),
    },
    {
      key: 'perms', header: t('shared_col_permissions'),
      cell: (item) => (
        <div className="flex flex-wrap gap-1">
          {item.permissions.length === 0
            ? <span className="text-xs text-fg-subtle">–</span>
            : item.permissions.slice(0, 3).map(p => (
                <span key={p.id} className="px-1.5 py-0.5 bg-info-bg text-info-fg rounded text-xs">
                  {p.user.email.split('@')[0]} · {t(PERM_KEYS[p.permission].label)}
                </span>
              ))}
          {item.permissions.length > 3 && <span className="text-xs text-fg-subtle">+{item.permissions.length - 3}</span>}
        </div>
      ),
    },
    {
      key: 'status', header: t('mbox_col_status'),
      cell: (item) => (
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${item.active ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'}`}>
          {item.active ? t('status_active') : t('status_inactive')}
        </span>
      ),
    },
    {
      key: 'actions', header: t('mbox_col_actions'), srOnlyHeader: true, headerClassName: 'text-right', className: 'text-right',
      cell: (item) => (
        <div className="flex items-center justify-end gap-1">
          <button onClick={() => setPermId(item.id)} title={t('shared_col_permissions')} aria-label={`${t('shared_col_permissions')}: ${item.email}`}
            className="p-1.5 text-fg-subtle hover:text-info-fg hover:bg-info-bg rounded transition-colors">
            <Shield size={14} />
          </button>
          <Can area="recipients" access="write">
            <button onClick={() => setEditId(item.id)} title={t('tb_edit')} aria-label={`${t('tb_edit')}: ${item.email}`}
              className="p-1.5 text-fg-subtle hover:text-fg-muted hover:bg-surface-2 rounded transition-colors">
              <Pencil size={14} />
            </button>
            <button onClick={() => confirmDelete(item)} title={t('tb_delete')} aria-label={`${t('tb_delete')}: ${item.email}`}
              className="p-1.5 text-fg-subtle hover:text-danger-fg hover:bg-danger-bg rounded transition-colors">
              <Trash2 size={14} />
            </button>
          </Can>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Inbox size={22} className="text-info-fg" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-bold text-fg">{t('shared_title')}</h1>
          <p className="text-sm text-fg-subtle">{total} {t('shared_count')}</p>
        </div>
      </div>

      <DataTable<SharedMailbox>
        caption={t('shared_title')}
        rows={items}
        columns={columns}
        rowKey={(i) => i.id}
        loading={isLoading}
        server={{ page, pageSize: limit, total, onPageChange: setPage }}
        search={{ placeholder: t('shared_search'), value: search, onChange: (q) => { setSearch(q); setPage(1); } }}
        selectable={canWrite}
        onActivate={(i) => setPermId(i.id)}
        rowClassName={(i) => (!i.active ? 'bg-surface-2' : '')}
        emptyText={debouncedSearch ? undefined : t('shared_empty')}
        toolbar={({ selectedRows, clearSelection }) => (
          <>
            <Can area="recipients" access="write">
              <button onClick={() => setCreateOpen(true)} className="btn-primary flex items-center gap-1.5">
                <Plus size={14} aria-hidden="true" /> {t('shared_new')}
              </button>
            </Can>
            <Can area="recipients" access="write">
              <button className="btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-40" disabled={selectedRows.length !== 1}
                onClick={() => selectedRows[0] && setEditId(selectedRows[0].id)}>
                <Pencil size={13} aria-hidden="true" /> {t('tb_edit')}
              </button>
            </Can>
            <Can area="recipients" access="write">
              <button className="btn-secondary flex items-center gap-1.5 text-xs text-danger-fg disabled:opacity-40"
                disabled={selectedRows.length === 0 || bulkDelete.isPending}
                onClick={() => {
                  if (!window.confirm(`${t('tb_delete_selected_confirm')} (${selectedRows.length})\n${selectedRows.map((r) => r.email).join('\n')}`)) return;
                  bulkDelete.mutate(selectedRows.map((r) => r.id), { onSuccess: clearSelection });
                }}>
                <Trash2 size={13} aria-hidden="true" /> {t('tb_delete')}
              </button>
            </Can>
            <button onClick={() => void refetch()} className="btn-secondary flex items-center gap-1.5 text-xs">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} aria-hidden="true" /> {t('tb_refresh')}
            </button>
          </>
        )}
      />

      {createOpen && <SharedMailboxCreateModal onClose={() => setCreateOpen(false)} />}
      {editItem   && <SharedMailboxEditPanel key={editItem.id} item={editItem} onClose={() => setEditId(null)} />}
      {permItem   && <PermissionsModal key={permItem.id} item={permItem} onClose={() => setPermId(null)} />}
    </div>
  );
}

// ── Create modal ──────────────────────────────────────────────────────────────
function SharedMailboxCreateModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName]         = useState('');
  const [localPart, setLocalPart] = useState('');
  const [domainId, setDomainId] = useState('');
  const [quotaBytes, setQuotaBytes] = useState<number>(5 * 1024 ** 3);

  const { data: allDomains = [] } = useQuery<Domain[]>({
    queryKey: ['admin-domains-list'],
    queryFn: () => api.get<{ domains: Domain[] }>('/admin/domains?limit=200').then(r => r.domains),
  });
  // New mailboxes only on active domains (same rule as user mailboxes)
  const domains = allDomains.filter((d) => d.active !== false);

  // Set default domain once the list is available
  useEffect(() => {
    if (!domainId && domains.length > 0) {
      setDomainId(domains[0]!.id);
    }
  }, [domains, domainId]);

  const selectedDomain = domains.find(d => d.id === domainId);
  // simplified local-part rule: a-z, 0-9, dot, dash, underscore, plus
  const localPartTrimmed = localPart.trim().toLowerCase();
  const localPartValid   = /^[a-z0-9._+-]+$/.test(localPartTrimmed) && !localPartTrimmed.startsWith('.') && !localPartTrimmed.endsWith('.');
  const fullEmail        = localPartTrimmed && selectedDomain ? `${localPartTrimmed}@${selectedDomain.name}` : '';

  const mutation = useMutation({
    mutationFn: () => api.post('/admin/shared-mailboxes', { email: fullEmail, displayName: name.trim(), domainId, quotaBytes }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] });
      toast.success(t('shared_created'));
      onClose();
    },
    onError: (e: Error) => toast.error(e.message || t('shared_save_error')),
  });

  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}

      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
      className="bg-surface rounded-xl shadow-2xl w-full max-w-md"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id={titleId} className="font-semibold text-fg">{t('shared_create_title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('action_close')} className="text-fg-subtle hover:text-fg-muted"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="field-label" htmlFor="sm-name">{t('shared_displayname')}</label>
            <input id="sm-name" value={name} onChange={e => setName(e.target.value)} className="input" placeholder={t('shared_displayname_ph')} />
          </div>
          <div>
            <label className="field-label" htmlFor="sm-local">{t('shared_email')}</label>
            <div className="flex items-stretch gap-0">
              <input
                id="sm-local"
                value={localPart}
                onChange={e => setLocalPart(e.target.value)}
                className="input rounded-r-none border-r-0 flex-1 min-w-0"
                placeholder="support"
                autoComplete="off"
              />
              <span className="inline-flex items-center px-2 bg-surface-2 border border-line-strong text-fg-subtle text-sm select-none">@</span>
              <select
                value={domainId}
                onChange={e => setDomainId(e.target.value)}
                aria-label={t('mbox_col_domain')}
                className="input rounded-l-none border-l-0 w-44 flex-shrink-0"
              >
                {domains.length === 0 ? (
                  <option value="">{t('shared_no_domain')}</option>
                ) : (
                  domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)
                )}
              </select>
            </div>
            {fullEmail && (
              <p className="mt-1 text-xs text-fg-subtle font-mono">{fullEmail}</p>
            )}
            {localPart && !localPartValid && (
              <p className="mt-1 text-xs text-danger-fg">{t('shared_localpart_invalid')}</p>
            )}
          </div>
          <div>
            <label className="field-label flex items-center gap-1" htmlFor="sm-quota"><HardDrive size={12} aria-hidden="true" /> {t('shared_quota')}</label>
            <select id="sm-quota" className="input w-full" value={quotaBytes} onChange={(e) => setQuotaBytes(parseInt(e.target.value, 10))}>
              {quotaOptions(undefined).map((v) => (
                <option key={v} value={v}>{quotaLabel(v) ?? t('mbox_quota_unlimited')}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="btn-secondary">{t('action_cancel')}</button>
            <button onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !name.trim() || !localPartValid || !domainId}
              className="btn-primary flex items-center gap-1.5">
              {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('mbox_create_btn')}
            </button>
          </div>
        </div>
    </Modal>
  );
}

// ── Edit panel ────────────────────────────────────────────────────────────────
function SharedMailboxEditPanel({ item, onClose }: { item: SharedMailbox; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName]         = useState(item.displayName);
  const [active, setActive]     = useState(item.active);
  const [quotaBytes, setQuotaBytes] = useState<number>(item.quotaBytes);
  const [warningGb, setWarningGb]   = useState(bytesToGbInput(item.quotaWarningBytes));
  const [sendGb, setSendGb]         = useState(bytesToGbInput(item.quotaProhibitSendBytes));
  const [copySendAs, setCopySendAs]         = useState(item.sentCopySendAs ?? false);
  const [copyOnBehalf, setCopyOnBehalf]     = useState(item.sentCopySendOnBehalf ?? false);
  const levelsValid = gbInputValid(warningGb) && gbInputValid(sendGb);

  const { data: allDomains = [] } = useQuery<Domain[]>({
    queryKey: ['admin-domains-list'],
    queryFn: () => api.get<{ domains: Domain[] }>('/admin/domains?limit=200').then(r => r.domains),
  });

  const generalDirty = name !== item.displayName || active !== item.active
    || copySendAs !== (item.sentCopySendAs ?? false) || copyOnBehalf !== (item.sentCopySendOnBehalf ?? false);
  const limitsDirty = quotaBytes !== item.quotaBytes
    || warningGb !== bytesToGbInput(item.quotaWarningBytes) || sendGb !== bytesToGbInput(item.quotaProhibitSendBytes);

  const mutation = useMutation({
    mutationFn: () => api.put(`/admin/shared-mailboxes/${item.id}`, {
      displayName: name.trim(), active, quotaBytes,
      quotaWarningBytes: gbInputToBytes(warningGb),
      quotaProhibitSendBytes: gbInputToBytes(sendGb),
      sentCopySendAs: copySendAs, sentCopySendOnBehalf: copyOnBehalf,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] });
      toast.success(t('shared_saved'));
      onClose();
    },
    onError: (e: Error) => toast.error(e.message || t('shared_save_error')),
  });

  const save = (
    <div className="flex justify-end pt-1">
      <button onClick={() => mutation.mutate()}
        disabled={mutation.isPending || !name.trim() || !levelsValid}
        className="btn-primary flex items-center gap-1.5">
        {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
        {t('action_save')}
      </button>
    </div>
  );

  const tabs: EditPanelTab[] = [
    {
      id: 'general', label: t('mbox_tab_general'),
      content: (
        <>
          <ReportDirty dirty={generalDirty} />
          <div>
            <label className="field-label" htmlFor="sm-name">{t('shared_displayname')}</label>
            <input id="sm-name" value={name} onChange={e => setName(e.target.value)} className="input" placeholder={t('shared_displayname_ph')} />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="rounded" />
            {t('shared_active')}
          </label>
          {/* 9.4: sent items of send as / send on behalf */}
          <fieldset className="space-y-1.5">
            <legend className="field-label">{t('shared_sent_copy_title')}</legend>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={copySendAs} onChange={e => setCopySendAs(e.target.checked)} className="rounded" />
              {t('shared_sent_copy_send_as')}
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={copyOnBehalf} onChange={e => setCopyOnBehalf(e.target.checked)} className="rounded" />
              {t('shared_sent_copy_on_behalf')}
            </label>
          </fieldset>
          {save}
          <div className="border-t border-line pt-4">
            <MailboxAliasesSection
              mailboxType="shared"
              mailboxId={item.id}
              defaultDomainId={item.domainId}
              allDomains={allDomains.map((d) => ({ id: d.id, name: d.name }))}
            />
          </div>
        </>
      ),
    },
    {
      id: 'limits', label: t('mbox_tab_limits'),
      content: (
        <>
          <ReportDirty dirty={limitsDirty} />
          <div>
            <label className="field-label flex items-center gap-1" htmlFor="sm-quota"><HardDrive size={12} aria-hidden="true" /> {t('shared_quota')}</label>
            <select id="sm-quota" className="input w-full" value={quotaBytes} onChange={(e) => setQuotaBytes(parseInt(e.target.value, 10))}>
              {quotaOptions(item.quotaBytes).map((v) => (
                <option key={v} value={v}>{quotaLabel(v) ?? t('mbox_quota_unlimited')}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label" htmlFor="sm-quota-warning">{t('mbox_quota_warning')}</label>
              <input id="sm-quota-warning" className="input w-full" inputMode="decimal" value={warningGb}
                placeholder={t('mbox_quota_default_hint')} onChange={(e) => setWarningGb(e.target.value)} />
            </div>
            <div>
              <label className="field-label" htmlFor="sm-quota-send">{t('mbox_quota_prohibit_send')}</label>
              <input id="sm-quota-send" className="input w-full" inputMode="decimal" value={sendGb}
                placeholder={t('mbox_quota_default_hint')} onChange={(e) => setSendGb(e.target.value)} />
            </div>
            {!levelsValid && <p className="col-span-2 text-xs text-danger-fg" role="alert">{t('mbox_quota_invalid')}</p>}
          </div>
          {save}
        </>
      ),
    },
    // 9.4: per-mailbox mail flow
    { id: 'flow', label: t('mbox_tab_flow'), content: <MailFlowEditor path={`/admin/shared-mailboxes/${item.id}/mail-flow`} kind="shared" /> },
    // w3: folder permissions
    { id: 'folders', label: t('mbox_tab_folders'), content: <FolderPermissionsSection basePath={`/admin/shared-mailboxes/${item.id}`} /> },
  ];

  return <EditPanel kind="shared-mailbox" title={item.displayName} subtitle={item.email} tabs={tabs} onClose={onClose} />;
}

// ── Permissions modal — multiple permissions per user ────
function PermissionsModal({ item, onClose }: { item: SharedMailbox; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [userId, setUserId]     = useState('');
  const [perms, setPerms]       = useState<PermType[]>(['FULL_ACCESS']);
  const [autoMap, setAutoMap]   = useState(true);
  const [userSearch, setUserSearch] = useState('');
  const [editingUser, setEditingUser] = useState<string | null>(null);

  // Load the complete user list once (small SMB setup, <500 users).
  // Filtering happens client-side, case-insensitive.
  const { data: allUsers = [], isLoading: usersLoading } = useQuery<User[]>({
    queryKey: ['admin-users-list-all'],
    queryFn: () => api.get<User[]>('/admin/mailboxes').then(r => Array.isArray(r) ? r : []),
    staleTime: 60_000,
  });

  const searchLc = userSearch.trim().toLowerCase();
  const filteredUsers = searchLc.length > 0
    ? allUsers.filter(u =>
        u.email.toLowerCase().includes(searchLc) ||
        (u.displayName ?? '').toLowerCase().includes(searchLc),
      ).slice(0, 30)
    : [];

  // Hide user IDs that already have permissions so the same person cannot be
  // added twice as a "new" permission (there is "Edit" for editing).
  const alreadyGrantedIds = new Set(item.permissions.map((p) => p.userId));
  const visibleUsers = editingUser ? filteredUsers : filteredUsers.filter(u => !alreadyGrantedIds.has(u.id));

  // Group existing permissions per user
  const grouped = item.permissions.reduce<Record<string, { user: { email: string; displayName: string }; perms: { id: string; permission: PermType }[]; autoMap: boolean }>>((acc, p) => {
    const key = p.userId;
    if (!acc[key]) acc[key] = { user: p.user, perms: [], autoMap: false };
    acc[key].perms.push({ id: p.id, permission: p.permission });
    acc[key].autoMap = acc[key].autoMap || p.autoMap !== false;
    return acc;
  }, {});

  const setMutation = useMutation({
    mutationFn: ({ uid, permissions }: { uid: string; permissions: PermType[] }) =>
      api.post(`/admin/shared-mailboxes/${item.id}/permissions`, { userId: uid, permissions, autoMap }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] });
      toast.success(t('shared_perm_saved'));
      setUserId(''); setUserSearch(''); setPerms(['FULL_ACCESS']); setAutoMap(true); setEditingUser(null);
    },
    onError: (e: Error) => toast.error(e.message || t('shared_save_error')),
  });

  const removeAllMutation = useMutation({
    mutationFn: (uid: string) => api.delete(`/admin/shared-mailboxes/${item.id}/permissions/${uid}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-shared-mailboxes'] }); toast.success(t('shared_perm_removed')); },
    onError: (e: Error) => toast.error(e.message || t('shared_save_error')),
  });

  const togglePerm = (p: PermType) =>
    setPerms((cur) => cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]);

  // Validation: SEND_AS and SEND_ON_BEHALF are mutually exclusive
  const sendConflict = perms.includes('SEND_AS') && perms.includes('SEND_ON_BEHALF');

  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}

      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
      className="bg-surface rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div>
            <h2 id={titleId} className="font-semibold text-fg">{t('shared_perm_title')}</h2>
            <p className="text-xs text-fg-subtle">{item.email}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('action_close')} className="text-fg-subtle hover:text-fg-muted"><X size={18} /></button>
        </div>
        <WriteGuard area="recipients" className="p-5 space-y-4">
          {/* Existing permissions — grouped per user */}
          <div className="space-y-2">
            {Object.keys(grouped).length === 0 && !editingUser && (
              <p className="text-sm text-fg-subtle text-center py-2">{t('shared_perm_none')}</p>
            )}
            {Object.entries(grouped).map(([uid, g]) => (
              <div key={uid} className="p-3 bg-surface-2 rounded-lg">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-fg">{g.user.displayName}</p>
                    <p className="text-xs text-fg-subtle truncate">{g.user.email}</p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {g.perms.map((p) => (
                        <span key={p.id} className="text-[10px] bg-accent/10 text-accent-fg border border-accent/20 px-1.5 py-0.5 rounded">
                          {t(PERM_KEYS[p.permission].label)}
                        </span>
                      ))}
                      {!g.autoMap && <span className="text-[10px] text-fg-subtle px-1.5 py-0.5">{t('shared_perm_not_automapped')}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingUser(uid);
                        setPerms(g.perms.map((p) => p.permission));
                        setAutoMap(g.autoMap);
                        setUserId(uid);
                      }}
                      className="text-xs text-accent-fg hover:underline"
                    >
                      {t('action_edit')}
                    </button>
                    <button type="button" aria-label={`${t('shared_perm_remove_all')}: ${g.user.email}`} title={t('shared_perm_remove_all')}
                      disabled={removeAllMutation.isPending}
                      onClick={() => { if (confirm(`${t('shared_perm_remove_confirm')}\n${g.user.email}`)) removeAllMutation.mutate(uid); }}
                      className="p-1 text-fg-subtle hover:text-danger-fg transition-colors">
                      <X size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* New / edit permission */}
          <div className="border-t border-line pt-4 space-y-2">
            <p className="text-xs font-semibold text-fg-subtle uppercase">
              {editingUser ? t('shared_perm_edit') : t('shared_perm_add')}
            </p>

            {!editingUser && (
              <>
                <input
                  value={userSearch}
                  onChange={e => { setUserSearch(e.target.value); setUserId(''); }}
                  className="input"
                  aria-label={t('shared_perm_search_ph')}
                  placeholder={t('shared_perm_search_ph')}
                  autoFocus
                />
                {searchLc.length === 0 ? (
                  <p className="text-xs text-fg-subtle px-2 py-1.5">{t('shared_perm_search_hint')}</p>
                ) : usersLoading ? (
                  <p className="text-xs text-fg-subtle px-2 py-1.5">{t('shared_perm_users_loading')}</p>
                ) : visibleUsers.length === 0 ? (
                  <p className="text-xs text-warning-fg bg-warning-bg border border-warning-line rounded px-2 py-1.5">
                    {filteredUsers.length === 0
                      ? `${t('shared_perm_no_user')} „${userSearch}“.`
                      : t('shared_perm_all_granted')}
                  </p>
                ) : (
                  <div className="border border-line rounded max-h-44 overflow-y-auto">
                    {visibleUsers.map(u => (
                      <button
                        key={u.id}
                        type="button"
                        aria-pressed={userId === u.id}
                        onClick={() => setUserId(u.id)}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-accent/10 border-b border-line last:border-b-0 ${
                          userId === u.id ? 'bg-accent/15 ring-1 ring-accent-fg' : ''
                        }`}
                      >
                        <span className="font-medium text-fg">{u.displayName || u.email}</span>
                        <span className="text-xs text-fg-subtle ml-2">{u.email}</span>
                      </button>
                    ))}
                  </div>
                )}
                {!userId && visibleUsers.length > 0 && (
                  <p className="text-xs text-fg-subtle px-2">{t('shared_perm_pick_user')}</p>
                )}
              </>
            )}

            {/* Multi-permission checkboxes */}
            <div className="space-y-1.5">
              {PERM_ORDER.map((k) => (
                <label key={k} className="flex items-start gap-2 p-2 hover:bg-surface-2 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={perms.includes(k)}
                    onChange={() => togglePerm(k)}
                    className="mt-0.5"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-fg">{t(PERM_KEYS[k].label)}</p>
                    <p className="text-xs text-fg-subtle">{t(PERM_KEYS[k].desc)}</p>
                  </div>
                </label>
              ))}
            </div>

            {/* 9.4 auto-mapping */}
            <label className="flex items-start gap-2 p-2 hover:bg-surface-2 rounded cursor-pointer">
              <input type="checkbox" checked={autoMap} onChange={(e) => setAutoMap(e.target.checked)} className="mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-medium text-fg">{t('shared_perm_automap')}</p>
                <p className="text-xs text-fg-subtle">{t('shared_perm_automap_hint')}</p>
              </div>
            </label>

            {sendConflict && (
              <p className="text-xs text-warning-fg bg-warning-bg border border-warning-line rounded px-2 py-1">
                ⚠ {t('shared_perm_send_conflict')}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              {editingUser && (
                <button type="button" onClick={() => { setEditingUser(null); setUserId(''); setPerms(['FULL_ACCESS']); setAutoMap(true); }}
                  className="btn-secondary text-sm">
                  {t('action_cancel')}
                </button>
              )}
              <button
                type="button"
                onClick={() => userId && perms.length > 0 && setMutation.mutate({ uid: userId, permissions: perms })}
                disabled={!userId || perms.length === 0 || setMutation.isPending}
                title={
                  !userId ? t('shared_perm_pick_user')
                  : perms.length === 0 ? t('shared_perm_pick_perm')
                  : ''
                }
                className="btn-primary flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
                {setMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                {editingUser ? t('action_save') : t('action_add')}
              </button>
            </div>
          </div>
        </WriteGuard>
    </Modal>
  );
}
