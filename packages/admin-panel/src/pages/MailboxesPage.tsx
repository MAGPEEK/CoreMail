import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Search, Pencil, Trash2, X, KeyRound, ChevronDown, ChevronRight,
  UserCheck, UserX, Mail, Shield, HardDrive, Loader2, RefreshCw, Folder,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { MailboxAliasesSection } from '../components/MailboxAliasesSection.js';
import { useT } from '../i18n/useT.js';

// ── Typen ────────────────────────────────────────────────────────────────────
interface FolderInfo { id: string; name: string; displayName: string; totalCount: number; unreadCount: number }
interface User {
  id: string; email: string; displayName: string; role: string;
  active: boolean; quotaBytes: number; usedBytes: number;
  domainId: string; createdAt: string;
}
interface UserDetail extends User {
  mailbox?: { folders: FolderInfo[] };
}
interface Domain { id: string; name: string; active: boolean }

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────
function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

const ROLES: Record<string, { label: string; color: string }> = {
  USER:                    { label: 'Benutzer',       color: 'badge-gray' },
  HELP_DESK:               { label: 'Helpdesk',       color: 'badge-blue' },
  RECIPIENT_MANAGEMENT:    { label: 'Empfänger-Mgmt', color: 'badge-blue' },
  COMPLIANCE_MANAGEMENT:   { label: 'Compliance',     color: 'badge-blue' },
  HYGIENE_MANAGEMENT:      { label: 'Schutz',         color: 'badge-blue' },
  SERVER_MANAGEMENT:       { label: 'Server',         color: 'badge-blue' },
  VIEW_ONLY_ORG:           { label: 'Nur-Lesen',      color: 'badge-gray' },
  ORGANIZATION_MANAGEMENT: { label: 'Administrator',  color: 'badge-orange' },
};

const QUOTA_OPTIONS = [
  { label: '1 GB',       value: 1_073_741_824 },
  { label: '2 GB',       value: 2_147_483_648 },
  { label: '5 GB',       value: 5_368_709_120 },
  { label: '10 GB',      value: 10_737_418_240 },
  { label: '25 GB',      value: 26_843_545_600 },
  { label: '50 GB',      value: 53_687_091_200 },
  { label: 'Unbegrenzt', value: 107_374_182_400 },
];

// ── Quota-Balken ─────────────────────────────────────────────────────────────
function QuotaBar({ used, total, showLabel = false }: { used: number; total: number; showLabel?: boolean }) {
  const t = useT();
  const pct = Math.min(100, total > 0 ? (used / total) * 100 : 0);
  const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-accent';
  return (
    <div className="space-y-1 w-full">
      {showLabel && (
        <div className="flex justify-between text-xs text-gray-500">
          <span className="font-medium">{formatBytes(used)}</span>
          <span className="text-gray-400">{t('mbox_storage_of')} {formatBytes(total)}</span>
        </div>
      )}
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      {!showLabel && (
        <div className="flex justify-between text-xs text-gray-400">
          <span>{formatBytes(used)}</span>
          <span>{formatBytes(total)}</span>
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM = {
  email: '', displayName: '', password: '', domainId: '',
  role: 'USER', quotaBytes: 5_368_709_120,
};

// ── Hauptkomponente ──────────────────────────────────────────────────────────
export function MailboxesPage() {
  const t = useT();
  const qc = useQueryClient();
  const [search, setSearch]             = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [expandedId, setExpandedId]     = useState<string | null>(null);
  const [showCreate, setShowCreate]     = useState(false);
  const [editUser, setEditUser]         = useState<User | null>(null);
  const [showResetPw, setShowResetPw]   = useState<User | null>(null);
  const [newPassword, setNewPassword]   = useState('');
  const [form, setForm]                 = useState({ ...EMPTY_FORM });
  const [localPart, setLocalPart]       = useState('');

  const { data: mailboxes = [], isLoading } = useQuery<User[]>({
    queryKey: ['admin-mailboxes'],
    queryFn:  () => api.get<User[]>('/admin/mailboxes'),
  });
  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['admin-domains'],
    queryFn:  () => api.get<{ domains: Domain[] }>('/admin/domains?limit=500').then(r => r.domains),
  });

  // Detail-Abfrage für aufgeklappten User (Ordner + Speicher)
  const { data: detail, isFetching: detailLoading } = useQuery<UserDetail>({
    queryKey: ['admin-mailbox-detail', expandedId],
    queryFn:  () => api.get<UserDetail>(`/admin/mailboxes/${expandedId}`),
    enabled:  !!expandedId,
  });

  const domainName = (id: string) => domains.find((d) => d.id === id)?.name ?? id;

  // Erstellen
  const createMutation = useMutation({
    mutationFn: () => api.post('/admin/mailboxes', form),
    onSuccess: () => {
      toast.success(`${t('mbox_created_toast')} ${form.email}`);
      void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
      setShowCreate(false); setForm({ ...EMPTY_FORM }); setLocalPart('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Bearbeiten
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api.put(`/admin/mailboxes/${id}`, data),
    onSuccess: () => {
      toast.success(t('mbox_saved_toast'));
      void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
      setEditUser(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Status umschalten
  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.put(`/admin/mailboxes/${id}`, { active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] }),
    onError: (err: Error) => toast.error(err.message),
  });

  // Löschen
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/mailboxes/${id}`),
    onSuccess: () => {
      toast.success(t('mbox_deleted_toast'));
      void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
      setExpandedId(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Passwort-Reset
  const resetPwMutation = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.put(`/admin/mailboxes/${id}`, { password }),
    onSuccess: () => { toast.success(t('mbox_pw_changed')); setShowResetPw(null); setNewPassword(''); },
    onError: (err: Error) => toast.error(err.message),
  });

  // Quota neu berechnen (alle)
  const recalcAllMutation = useMutation({
    mutationFn: () => api.post('/admin/mailboxes/recalculate-all-quotas', {}),
    onSuccess: () => {
      toast.success(t('mbox_storage_updated'));
      void qc.invalidateQueries({ queryKey: ['admin-mailboxes'] });
      void qc.invalidateQueries({ queryKey: ['admin-mailbox-detail'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Filter
  const filtered = mailboxes.filter((u) => {
    const q = search.toLowerCase();
    const matchSearch = !search
      || (u.email ?? '').toLowerCase().includes(q)
      || (u.displayName ?? '').toLowerCase().includes(q);
    const matchDomain = !domainFilter || u.domainId === domainFilter;
    return matchSearch && matchDomain;
  });

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

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-4">
      {/* Kopfzeile */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">{t('mbox_page_title')}</h1>
          <p className="text-xs text-gray-400 mt-0.5">{mailboxes.length} {t('mbox_total')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => recalcAllMutation.mutate()}
            disabled={recalcAllMutation.isPending}
            className="btn-secondary flex items-center gap-1.5 text-xs"
            title={t('mbox_recalc_title')}
          >
            <RefreshCw size={13} className={recalcAllMutation.isPending ? 'animate-spin' : ''} />
            {t('mbox_recalc_storage')}
          </button>
          <button
            onClick={() => { setForm({ ...EMPTY_FORM }); setLocalPart(''); setShowCreate(true); }}
            className="btn-primary flex items-center gap-1.5"
          >
            <Plus size={15} /> {t('mbox_new_user')}
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            className="input pl-8 w-60" placeholder={t('mbox_filter_placeholder')} />
        </div>
        <div className="relative">
          <select value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)}
            className="input pr-8 appearance-none cursor-pointer">
            <option value="">{t('mbox_filter_all_domains')}</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({mailboxes.filter((u) => u.domainId === d.id).length})
              </option>
            ))}
          </select>
          <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>
        {(search || domainFilter) && (
          <button onClick={() => { setSearch(''); setDomainFilter(''); }}
            className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <X size={12} /> {t('mbox_filter_clear')}
          </button>
        )}
      </div>

      {/* Tabelle */}
      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="w-8 px-2 py-2.5" />
              {[t('mbox_col_user'), t('mbox_col_domain'), t('mbox_col_role'), t('mbox_col_storage'), t('mbox_col_status'), t('mbox_col_actions')].map((h) => (
                <th key={h} className="text-left px-4 py-2.5 font-medium text-gray-500 text-xs">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center">
                <Loader2 size={20} className="animate-spin mx-auto text-gray-400" />
              </td></tr>
            )}
            {!isLoading && filtered.map((u) => {
              const role = ROLES[u.role] ?? { label: u.role, color: 'badge-gray' };
              const isExpanded = expandedId === u.id;
              const pct = u.quotaBytes > 0 ? Math.min(100, (u.usedBytes / u.quotaBytes) * 100) : 0;

              return [
                // Hauptzeile
                <tr key={u.id}
                  className={`transition-colors ${!u.active ? 'opacity-60' : ''} ${isExpanded ? 'bg-blue-50/50' : 'hover:bg-gray-50'}`}
                >
                  {/* Aufklapp-Pfeil */}
                  <td className="px-2 py-3 text-center">
                    <button onClick={() => toggleExpand(u.id)}
                      className="text-gray-400 hover:text-gray-600 transition-colors">
                      {isExpanded
                        ? <ChevronDown size={15} className="text-accent" />
                        : <ChevronRight size={15} />}
                    </button>
                  </td>

                  {/* Benutzer */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                        <span className="text-sm font-semibold text-accent">
                          {(u.displayName ?? u.email ?? '?').charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium text-gray-800">{u.displayName ?? u.email}</p>
                        <p className="text-xs text-gray-400 flex items-center gap-1">
                          <Mail size={10} />{u.email}
                        </p>
                      </div>
                    </div>
                  </td>

                  {/* Domain */}
                  <td className="px-4 py-3">
                    <span className="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                      {domainName(u.domainId)}
                    </span>
                  </td>

                  {/* Rolle */}
                  <td className="px-4 py-3">
                    <span className={`badge text-xs ${role.color} flex items-center gap-1 w-fit`}>
                      {u.role === 'ORGANIZATION_MANAGEMENT' && <Shield size={10} />}
                      {role.label}
                    </span>
                  </td>

                  {/* Speicher */}
                  <td className="px-4 py-3 w-48">
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className={`font-medium ${pct > 90 ? 'text-red-600' : pct > 70 ? 'text-yellow-600' : 'text-gray-700'}`}>
                          {formatBytes(u.usedBytes)}
                        </span>
                        <span className="text-gray-400">{formatBytes(u.quotaBytes)}</span>
                      </div>
                      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-accent'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-gray-400">{pct.toFixed(1)} {t('mbox_storage_used')}</p>
                    </div>
                  </td>

                  {/* Status */}
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleMutation.mutate({ id: u.id, active: !u.active })}
                      className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border cursor-pointer transition-colors ${
                        u.active
                          ? 'bg-green-50 border-green-200 text-green-700 hover:bg-green-100'
                          : 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'
                      }`}
                    >
                      {u.active ? <><UserCheck size={11} /> {t('status_active')}</> : <><UserX size={11} /> {t('status_disabled')}</>}
                    </button>
                  </td>

                  {/* Aktionen */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => setEditUser(u)} className="btn-ghost p-1.5 rounded" title={t('mbox_btn_edit_title')}>
                        <Pencil size={13} className="text-gray-500" />
                      </button>
                      <button onClick={() => { setShowResetPw(u); setNewPassword(''); }}
                        className="btn-ghost p-1.5 rounded" title={t('mbox_reset_pw_title_btn')}>
                        <KeyRound size={13} className="text-blue-500" />
                      </button>
                      <button
                        onClick={() => { if (confirm(`${t('mbox_delete_confirm')} "${u.email}"`)) deleteMutation.mutate(u.id); }}
                        className="btn-ghost p-1.5 rounded" title={t('mbox_btn_delete_title')}>
                        <Trash2 size={13} className="text-red-500" />
                      </button>
                    </div>
                  </td>
                </tr>,

                // ── Aufgeklappte Detail-Zeile ────────────────────────────────
                isExpanded && (
                  <tr key={`${u.id}-detail`} className="bg-blue-50/30">
                    <td colSpan={7} className="px-6 py-4">
                      {detailLoading && expandedId === u.id ? (
                        <div className="flex items-center gap-2 text-gray-500 text-sm">
                          <Loader2 size={14} className="animate-spin" /> {t('mbox_detail_loading')}
                        </div>
                      ) : detail && detail.id === u.id ? (
                        <div className="space-y-3">
                          {/* Gesamtbalken */}
                          <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-2">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
                                <HardDrive size={14} className="text-accent" />
                                {t('mbox_detail_total_storage')}
                              </span>
                              <span className="text-xs text-gray-500">
                                {formatBytes(detail.usedBytes)} {t('mbox_detail_used_of')} {formatBytes(detail.quotaBytes)} {t('mbox_detail_occupied')}
                              </span>
                            </div>
                            <QuotaBar used={detail.usedBytes} total={detail.quotaBytes} showLabel />
                          </div>

                          {/* Ordner-Aufschlüsselung */}
                          {detail.mailbox?.folders && detail.mailbox.folders.length > 0 && (
                            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                              <p className="text-xs font-medium text-gray-500 px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center gap-1.5">
                                <Folder size={12} /> {t('mbox_detail_folders')}
                              </p>
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b border-gray-100">
                                    <th className="text-left px-4 py-1.5 text-gray-400 font-medium">{t('mbox_detail_col_folder')}</th>
                                    <th className="text-right px-4 py-1.5 text-gray-400 font-medium">{t('mbox_detail_col_messages')}</th>
                                    <th className="text-right px-4 py-1.5 text-gray-400 font-medium">{t('mbox_detail_col_unread')}</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                  {detail.mailbox.folders.map((f) => (
                                    <tr key={f.id} className="hover:bg-gray-50">
                                      <td className="px-4 py-1.5 text-gray-700 flex items-center gap-1.5">
                                        <Folder size={11} className="text-gray-300" />
                                        {f.displayName || f.name}
                                      </td>
                                      <td className="px-4 py-1.5 text-right text-gray-600">{f.totalCount}</td>
                                      <td className="px-4 py-1.5 text-right">
                                        {f.unreadCount > 0
                                          ? <span className="font-semibold text-accent">{f.unreadCount}</span>
                                          : <span className="text-gray-300">—</span>}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot className="border-t border-gray-200 bg-gray-50">
                                  <tr>
                                    <td className="px-4 py-1.5 text-gray-500 font-medium">{t('mbox_detail_total')}</td>
                                    <td className="px-4 py-1.5 text-right text-gray-600 font-medium">
                                      {detail.mailbox.folders.reduce((s, f) => s + f.totalCount, 0)}
                                    </td>
                                    <td className="px-4 py-1.5 text-right text-accent font-medium">
                                      {detail.mailbox.folders.reduce((s, f) => s + f.unreadCount, 0) || '—'}
                                    </td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          )}

                          {/* Metadaten */}
                          <div className="flex gap-4 text-xs text-gray-400">
                            <span>{t('mbox_detail_id')}: <code className="bg-gray-100 px-1 rounded">{detail.id}</code></span>
                            <span>{t('mbox_detail_created')}: {new Date(detail.createdAt).toLocaleDateString('de-DE')}</span>
                          </div>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ),
              ];
            })}
            {!isLoading && filtered.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-gray-400 text-sm">
                {search || domainFilter ? t('mbox_no_results') : t('mbox_no_users')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Dialog: Neuer Benutzer ──────────────────────────────────────────── */}
      {showCreate && (
        <Modal title={t('mbox_create_title')} onClose={() => setShowCreate(false)}>
          <div className="space-y-4">
            <div>
              <label className="field-label">{t('mbox_create_domain')} <span className="text-red-500">*</span></label>
              <select className="input w-full" value={form.domainId} onChange={(e) => selectDomain(e.target.value)}>
                <option value="">{t('mbox_create_domain_select')}</option>
                {domains.filter(d => d.active).map((d) => <option key={d.id} value={d.id}>@{d.name}</option>)}
              </select>
              {domains.filter(d => d.active).length === 0 && (
                <p className="text-xs text-amber-600 mt-1">
                  {domains.length === 0
                    ? t('mbox_create_domain_none')
                    : t('mbox_create_domain_inactive')}
                </p>
              )}
            </div>
            <div>
              <label className="field-label">{t('mbox_create_email')} <span className="text-red-500">*</span></label>
              <div className="flex">
                <input className="input rounded-r-none flex-1" placeholder="benutzername"
                  value={localPart} onChange={(e) => setLocal(e.target.value)} />
                <span className="px-3 py-2 bg-gray-100 border border-l-0 border-gray-300 text-gray-500 text-sm rounded-r">
                  @{form.domainId ? domainName(form.domainId) : 'domain.com'}
                </span>
              </div>
              {form.email && <p className="text-xs text-gray-400 mt-1">→ {form.email}</p>}
            </div>
            <div>
              <label className="field-label">{t('mbox_create_displayname')} <span className="text-red-500">*</span></label>
              <input className="input w-full" placeholder="Max Mustermann"
                value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </div>
            <div>
              <label className="field-label">{t('mbox_create_password')} <span className="text-red-500">*</span></label>
              <input type="password" className="input w-full" placeholder={t('mbox_create_pw_hint')}
                value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              {form.password && form.password.length < 8 && (
                <p className="text-xs text-red-500 mt-1">{t('mbox_create_pw_short')}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">{t('mbox_create_role')}</label>
                <select className="input w-full" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {Object.entries(ROLES).map(([v, { label }]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label flex items-center gap-1"><HardDrive size={12} /> {t('mbox_create_quota')}</label>
                <select className="input w-full" value={form.quotaBytes}
                  onChange={(e) => setForm({ ...form, quotaBytes: parseInt(e.target.value) })}>
                  {QUOTA_OPTIONS.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
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

      {/* ── Dialog: Bearbeiten ─────────────────────────────────────────────── */}
      {editUser && (
        <Modal title={`${editUser.displayName} ${t('mbox_edit_title')}`} onClose={() => setEditUser(null)}>
          <EditForm user={editUser} domains={domains}
            onSave={(data) => updateMutation.mutate({ id: editUser.id, data })}
            isPending={updateMutation.isPending} />
        </Modal>
      )}

      {/* ── Dialog: Passwort-Reset ─────────────────────────────────────────── */}
      {showResetPw && (
        <Modal title={`${t('mbox_reset_pw_title')} — ${showResetPw.email}`} onClose={() => setShowResetPw(null)}>
          <div className="space-y-3">
            <p className="text-sm text-gray-600">{t('mbox_reset_pw_for')} <strong>{showResetPw.displayName}</strong>:</p>
            <input type="password" className="input w-full" placeholder={t('mbox_reset_pw_placeholder')}
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus />
            {newPassword && newPassword.length < 8 && (
              <p className="text-xs text-red-500">{t('mbox_create_pw_short')}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 mt-5">
            <button onClick={() => setShowResetPw(null)} className="btn-secondary">{t('action_cancel')}</button>
            <button
              onClick={() => resetPwMutation.mutate({ id: showResetPw.id, password: newPassword })}
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
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="btn-ghost p-1 rounded"><X size={16} className="text-gray-500" /></button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// ── Edit-Formular ────────────────────────────────────────────────────────────
function EditForm({ user, domains, onSave, isPending }:
  { user: User; domains: Domain[]; onSave: (d: Record<string, unknown>) => void; isPending: boolean }
) {
  const t = useT();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole]               = useState(user.role);
  const [quotaBytes, setQuotaBytes]   = useState(user.quotaBytes);
  const domainLabel = `@${domains.find((d) => d.id === user.domainId)?.name ?? user.domainId}`;

  return (
    <div className="space-y-4">
      <div>
        <label className="field-label">{t('mbox_edit_email')}</label>
        <input className="input w-full bg-gray-50 cursor-not-allowed" value={user.email} disabled />
      </div>
      <div>
        <label className="field-label">{t('mbox_edit_domain')}</label>
        <input className="input w-full bg-gray-50 cursor-not-allowed" value={domainLabel} disabled />
      </div>
      <div>
        <label className="field-label">{t('mbox_edit_displayname')}</label>
        <input className="input w-full" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="field-label">{t('mbox_create_role')}</label>
          <select className="input w-full" value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.entries(ROLES).map(([v, { label }]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </div>
        <div>
          <label className="field-label flex items-center gap-1"><HardDrive size={12} /> {t('mbox_create_quota')}</label>
          <select className="input w-full" value={quotaBytes} onChange={(e) => setQuotaBytes(parseInt(e.target.value))}>
            {QUOTA_OPTIONS.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
          </select>
        </div>
      </div>
      <div className="flex justify-end pt-1">
        <button
          onClick={() => onSave({ displayName, role, quotaBytes })}
          disabled={!displayName || isPending}
          className="btn-primary disabled:opacity-50 flex items-center gap-2"
        >
          {isPending && <Loader2 size={14} className="animate-spin" />}
          {t('action_save')}
        </button>
      </div>

      <div className="border-t border-gray-200 pt-4 mt-2">
        <MailboxAliasesSection
          mailboxType="user"
          mailboxId={user.id}
          defaultDomainId={user.domainId}
          allDomains={domains.map((d) => ({ id: d.id, name: d.name }))}
        />
      </div>
    </div>
  );
}
