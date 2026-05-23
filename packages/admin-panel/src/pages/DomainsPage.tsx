import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, X, Copy, Check, CheckCircle, AlertCircle, Globe, ChevronDown, RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { useT } from '../i18n/useT.js';

// ── Typen ─────────────────────────────────────────────────────────────────────
interface Domain {
  id:           string;
  name:         string;
  active:       boolean;
  primary:      boolean;
  dkimSelector: string;
  createdAt:    string;
  _count:       { users: number };
}
interface DomainsResponse { domains: Domain[]; total: number; page: number; limit: number }
interface DkimRecord { selector: string; dnsName: string; dnsValue: string }

// ── DNS-Check-Typen ───────────────────────────────────────────────────────────
interface DnsRec { type: string; name: string; expected: string; ok: boolean; found: string | null; warning?: string }
interface DnsCheckResult {
  domain: string; hostname: string; serverIp: string;
  records: { a: DnsRec; mx: DnsRec; spf: DnsRec; dkim: DnsRec; dmarc: DnsRec; autodiscover: DnsRec; ptr: DnsRec };
}

// ── DNS-Hilfsfunktionen (Modul-Ebene) ─────────────────────────────────────────
function getHostPart(name: string, domain: string): string {
  if (name === domain) return '@';
  if (name.endsWith('.' + domain)) return name.slice(0, -(domain.length + 1));
  return name;
}

// ── CopyBtn (Modul-Ebene — keine Inline-Definition) ──────────────────────────
function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { void copyToClipboard(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      className="shrink-0 p-1 text-gray-400 hover:text-blue-600 transition-colors"
      title="Kopieren"
    >
      {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
    </button>
  );
}

// ── DnsRow (Modul-Ebene) ──────────────────────────────────────────────────────
interface DnsRowProps {
  label: string; record: DnsRec; domain: string;
  hostOverride?: string; valueOverride?: string; extra?: React.ReactNode;
}
function DnsRow({ label, record, domain, hostOverride, valueOverride, extra }: DnsRowProps) {
  const host  = hostOverride ?? getHostPart(record.name, domain);
  const value = valueOverride ?? record.expected;
  return (
    <div className="py-2.5 border-b border-gray-100 last:border-0">
      <div className="flex items-start gap-2">
        {record.ok
          ? <CheckCircle size={14} className="mt-0.5 shrink-0 text-green-500" />
          : <AlertCircle size={14} className={`mt-0.5 shrink-0 ${record.warning ? 'text-amber-500' : 'text-red-500'}`} />}
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5 leading-none ${
          record.type === 'TXT'  ? 'bg-purple-100 text-purple-700' :
          record.type === 'MX'   ? 'bg-blue-100   text-blue-700'   :
          record.type === 'A'    ? 'bg-green-100  text-green-700'  :
          record.type === 'CNAME'? 'bg-amber-100  text-amber-700'  :
                                   'bg-gray-100   text-gray-500'
        }`}>{record.type}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-gray-700 mb-1.5">{label}</div>
          {/* Host */}
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[10px] text-gray-400 w-9 shrink-0">Host</span>
            <code className="flex-1 bg-gray-50 border border-gray-200 rounded px-2 py-0.5 text-xs font-mono truncate min-w-0" title={record.name}>{host}</code>
            <CopyBtn value={host} />
          </div>
          {/* Value */}
          {value && (
            <div className="flex items-start gap-1.5">
              <span className="text-[10px] text-gray-400 w-9 shrink-0 pt-0.5">Wert</span>
              <code className="flex-1 bg-gray-50 border border-gray-200 rounded px-2 py-0.5 text-xs font-mono break-all min-w-0 leading-relaxed">{value}</code>
              <CopyBtn value={value} />
            </div>
          )}
          {extra}
          {/* Aktuell im DNS — wenn abweichend */}
          {record.found && record.found !== record.expected && (
            <div className="mt-1.5 text-[10px] text-gray-400 bg-gray-50 rounded px-2 py-0.5 font-mono break-all">
              Im DNS: {record.found.slice(0, 80)}{record.found.length > 80 ? '…' : ''}
            </div>
          )}
          {record.warning && (
            <div className="mt-1.5 text-[10px] text-amber-700 bg-amber-50 rounded px-2 py-1 leading-relaxed">⚠ {record.warning}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── DkimDnsRow — mit 255-Zeichen-Chunk-Ansicht ────────────────────────────────
function DkimDnsRow({ record, domain, label }: { record: DnsRec; domain: string; label: string }) {
  const [showChunked, setShowChunked] = useState(false);
  const full   = record.expected;
  const chunk1 = full.slice(0, 255);
  const chunk2 = full.slice(255);
  return (
    <DnsRow label={label} record={record} domain={domain} extra={
      full.length > 255 ? (
        <div className="mt-1.5">
          <button onClick={() => setShowChunked(s => !s)}
            className="text-[10px] text-blue-500 hover:underline flex items-center gap-1">
            {showChunked ? '▲' : '▼'} Für DNS-Provider mit 255-Zeichen-Limit
          </button>
          {showChunked && (
            <div className="mt-1 space-y-1">
              <div className="flex items-start gap-1.5">
                <code className="flex-1 bg-blue-50 border border-blue-200 rounded px-2 py-0.5 text-xs font-mono break-all leading-relaxed">"{chunk1}"</code>
                <CopyBtn value={chunk1} />
              </div>
              {chunk2 && (
                <div className="flex items-start gap-1.5">
                  <code className="flex-1 bg-blue-50 border border-blue-200 rounded px-2 py-0.5 text-xs font-mono break-all leading-relaxed">"{chunk2}"</code>
                  <CopyBtn value={chunk2} />
                </div>
              )}
            </div>
          )}
        </div>
      ) : null
    } />
  );
}


// ── Add-Domain-Modal ──────────────────────────────────────────────────────────
function AddDomainModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [selector, setSelector] = useState('coremail');

  const createMutation = useMutation({
    mutationFn: () => api.post<Domain>('/admin/domains', { name: name.trim(), dkimSelector: selector }),
    onSuccess: () => {
      toast.success(t('domain_added_toast'));
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || t('domain_add_error')),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-2xl w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-gray-900">{t('domain_add_title')}</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{t('domain_add_name_label')} <span className="text-red-500">*</span></label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="example.com"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && name.trim() && createMutation.mutate()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{t('domain_add_dkim_label')}</label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={selector}
              onChange={e => setSelector(e.target.value)}
              placeholder="coremail"
            />
            <p className="text-xs text-gray-400 mt-1">{t('domain_add_dkim_hint')}</p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
          >
            {t('action_cancel')}
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!name.trim() || createMutation.isPending}
            className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {createMutation.isPending ? t('domain_add_btn_adding') : t('domain_add_btn_add')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit-Domain-Modal ─────────────────────────────────────────────────────────
function EditDomainModal({ domain, onClose }: { domain: Domain; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(domain.name);
  const [selector, setSelector] = useState(domain.dkimSelector);
  const [dkimRecord, setDkimRecord] = useState<DkimRecord | null>(null);
  const [dkimLoading, setDkimLoading] = useState(false);
  const [dnsCheck, setDnsCheck] = useState<DnsCheckResult | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);

  const updateMutation = useMutation({
    mutationFn: () => api.put<Domain>(`/admin/domains/${domain.id}`, { name: name.trim(), dkimSelector: selector }),
    onSuccess: () => {
      toast.success(t('domain_updated_toast'));
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || 'Fehler'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/admin/domains/${domain.id}`),
    onSuccess: () => {
      toast.success(t('domain_deleted_toast'));
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const loadDkim = async () => {
    setDkimLoading(true);
    try {
      const r = await api.get<DkimRecord>(`/admin/domains/${domain.id}/dkim-record`);
      setDkimRecord(r);
    } catch {
      toast.error(t('domain_dkim_load_error'));
    } finally {
      setDkimLoading(false);
    }
  };

  const regenerateDkim = async () => {
    if (!confirm(t('domain_dkim_regen_confirm'))) return;
    setDkimLoading(true);
    try {
      const r = await api.post<DkimRecord>(`/admin/domains/${domain.id}/regenerate-dkim`, {});
      setDkimRecord(r);
      setDnsCheck(null); // DNS-Panel invalidieren — neuer Key
      toast.success(t('domain_dkim_regen_success'));
    } catch {
      toast.error(t('domain_dkim_regen_error'));
    } finally {
      setDkimLoading(false);
    }
  };

  const runDnsCheck = async () => {
    setDnsLoading(true);
    try {
      const r = await api.get<DnsCheckResult>(`/admin/domains/${domain.id}/dns-check`);
      setDnsCheck(r);
    } catch {
      toast.error(t('domain_dns_check_error'));
    } finally {
      setDnsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-lg shadow-2xl w-full ${dnsCheck ? 'max-w-2xl' : 'max-w-lg'} p-6 max-h-[90vh] overflow-y-auto transition-all`}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-gray-900">{t('domain_edit_title')}</h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded"><X size={16} /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{t('domain_edit_name_label')}</label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{t('domain_edit_dkim_label')}</label>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={selector}
              onChange={e => setSelector(e.target.value)}
            />
          </div>

          {/* Info */}
          <div className="flex items-center gap-4 pt-1">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${domain.primary ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
              {domain.primary ? t('domain_edit_primary') : t('domain_edit_secondary')}
            </span>
            <span className="text-xs text-gray-400">{domain._count.users} {t('domain_edit_mailbox_count')}</span>
          </div>

          {/* ── DKIM Quick-Show ────────────────────────────────────────────── */}
          <div className="pt-1 flex items-center gap-3">
            <button
              onClick={() => void loadDkim()}
              disabled={dkimLoading}
              className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline disabled:opacity-50"
            >
              <CheckCircle size={13} />
              {dkimLoading ? t('domain_dkim_loading') : t('domain_dkim_show')}
            </button>
            {dkimRecord && (
              <button
                onClick={() => void regenerateDkim()}
                disabled={dkimLoading}
                className="flex items-center gap-1.5 text-xs text-amber-600 hover:underline disabled:opacity-50"
                title="Neues RSA-2048-Schlüsselpaar generieren — bestehender DNS-Eintrag wird ungültig"
              >
                <RefreshCw size={12} />
                {t('domain_dkim_regenerate')}
              </button>
            )}
          </div>

          {dkimRecord && (
            <div className="bg-gray-50 rounded-lg p-3 space-y-2 border border-gray-200">
              <div>
                <label className="text-xs text-gray-500 font-medium">{t('domain_dkim_dns_name')}</label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-xs font-mono break-all">{dkimRecord.dnsName}</code>
                  <button onClick={() => { copyToClipboard(dkimRecord.dnsName).then(() => toast.success(t('domain_dkim_copied'))).catch(() => toast.error(t('domain_dkim_copy_error'))); }} className="p-1 text-gray-400 hover:text-gray-600"><Copy size={12} /></button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 font-medium">{t('domain_dkim_txt_value')}</label>
                <div className="flex items-start gap-2 mt-1">
                  <code className="flex-1 bg-white border border-gray-200 rounded px-2 py-1 text-xs font-mono break-all">{dkimRecord.dnsValue}</code>
                  <button onClick={() => { copyToClipboard(dkimRecord.dnsValue).then(() => toast.success(t('domain_dkim_copied'))).catch(() => toast.error(t('domain_dkim_copy_error'))); }} className="p-1 text-gray-400 hover:text-gray-600 mt-0.5"><Copy size={12} /></button>
                </div>
              </div>
            </div>
          )}

          {/* ── DNS-Einrichtung ────────────────────────────────────────────── */}
          <div className="pt-1 border-t border-gray-100">
            <button
              onClick={() => void runDnsCheck()}
              disabled={dnsLoading}
              className="flex items-center gap-1.5 text-xs text-indigo-600 hover:underline disabled:opacity-50"
            >
              <Globe size={13} />
              {dnsLoading ? t('domain_dns_checking') : t('domain_dns_check_btn')}
              {dnsCheck && !dnsLoading && <RefreshCw size={11} className="ml-1 opacity-60" />}
            </button>

            {dnsCheck && (
              <div className="mt-2 rounded-lg border border-gray-200 overflow-hidden">
                {/* Header */}
                <div className="bg-gray-50 px-3 py-2 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-700">
                    {t('domain_dns_panel_title')} <span className="text-indigo-600">{dnsCheck.domain}</span>
                  </span>
                  <span className="text-[10px] text-gray-500 font-mono">
                    {dnsCheck.hostname}
                    {dnsCheck.serverIp ? <> · <span className="text-green-600">{dnsCheck.serverIp}</span></> : <span className="text-amber-600"> · {t('domain_dns_ip_unknown')}</span>}
                  </span>
                </div>

                <div className="px-3">
                  {/* A-Record */}
                  <DnsRow
                    label={t('domain_dns_record_a')}
                    record={dnsCheck.records.a}
                    domain={dnsCheck.domain}
                    hostOverride={getHostPart(dnsCheck.records.a.name, dnsCheck.domain)}
                  />
                  {/* MX */}
                  <DnsRow label={t('domain_dns_record_mx')} record={dnsCheck.records.mx} domain={dnsCheck.domain} />
                  {/* SPF */}
                  <DnsRow label={t('domain_dns_record_spf')} record={dnsCheck.records.spf} domain={dnsCheck.domain} />
                  {/* DKIM — mit Chunked-Option */}
                  <DkimDnsRow label={t('domain_dns_record_dkim')} record={dnsCheck.records.dkim} domain={dnsCheck.domain} />
                  {/* DMARC */}
                  <DnsRow label={t('domain_dns_record_dmarc')} record={dnsCheck.records.dmarc} domain={dnsCheck.domain} />
                  {/* Autodiscover */}
                  <DnsRow label={t('domain_dns_record_ac')} record={dnsCheck.records.autodiscover} domain={dnsCheck.domain} />
                  {/* PTR — Host = Server-IP, Wert = Hostname */}
                  <DnsRow
                    label={t('domain_dns_record_ptr')}
                    record={dnsCheck.records.ptr}
                    domain={dnsCheck.domain}
                    hostOverride={dnsCheck.serverIp || '(Server-IP)'}
                    valueOverride={dnsCheck.hostname}
                    extra={<p className="mt-1 text-[10px] text-gray-400">ℹ {t('domain_dns_ptr_note')}</p>}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-5">
          {/* Löschen nur wenn nicht primär */}
          <button
            onClick={() => {
              if (confirm(`${t('domain_delete_confirm')} "${domain.name}"`)) deleteMutation.mutate();
            }}
            disabled={domain.primary || deleteMutation.isPending}
            className="px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={domain.primary ? t('domain_delete_primary_title') : undefined}
          >
            {t('action_delete')}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors">
              {t('action_cancel')}
            </button>
            <button
              onClick={() => updateMutation.mutate()}
              disabled={!name.trim() || updateMutation.isPending}
              className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {updateMutation.isPending ? t('action_saving') : t('action_save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Haupt-Komponente ──────────────────────────────────────────────────────────
export function DomainsPage() {
  const t = useT();
  const qc = useQueryClient();

  const [search, setSearch]       = useState('');
  const [limit,  setLimit]        = useState(50);
  const [page,   setPage]         = useState(1);
  const [showAdd, setShowAdd]     = useState(false);
  const [editing, setEditing]     = useState<Domain | null>(null);

  // Debounced search query string
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useMemo(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery<DomainsResponse>({
    queryKey: ['admin-domains', debouncedSearch, page, limit],
    queryFn:  () => api.get<DomainsResponse>(
      `/admin/domains?search=${encodeURIComponent(debouncedSearch)}&page=${page}&limit=${limit}`
    ),
    placeholderData: prev => prev,
  });

  const domains = data?.domains ?? [];
  const total   = data?.total   ?? 0;
  const totalPages = Math.ceil(total / limit);

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/domains/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-domains'] }),
    onError: () => toast.error('Fehler beim Umschalten'),
  });

  const makePrimaryMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/domains/${id}/make-primary`, {}),
    onSuccess: () => {
      toast.success(t('domain_primary_set_toast'));
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
    },
    onError: () => toast.error('Fehler beim Setzen der primären Domain'),  // no key exists for this
  });

  return (
    <div className="min-h-full bg-gray-100">
      {/* ── Kopfzeile ──────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-8 py-5">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">{t('domain_page_title')}</h1>
        </div>
      </div>

      {/* ── Inhaltsbereich ─────────────────────────────────────────────────── */}
      <div className="p-8">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          {/* ── Toolbar ──────────────────────────────────────── */}
          <div className="flex items-center gap-4 p-5 border-b border-gray-200">
            <h2 className="text-lg font-bold text-gray-900 shrink-0">{t('domain_section_title')}</h2>

            {/* Suche */}
            <div className="flex-1 max-w-lg">
              <input
                type="text"
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
                placeholder={t('domain_search_placeholder')}
                className="w-full border border-gray-300 rounded px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-center placeholder-gray-400"
              />
            </div>

            <div className="flex-1" />

            {/* ADD DOMAIN */}
            <button
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors uppercase tracking-wide"
            >
              <Plus size={15} />
              {t('domain_add_btn')}
            </button>
          </div>

          {/* ── Tabelle ───────────────────────────────────────── */}
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide w-12">#</th>
                <th className="text-left px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide">{t('domain_col_domain')}</th>
                <th className="px-6 py-3 w-44"></th>
                <th className="text-center px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide">{t('domain_col_status')}</th>
                <th className="text-center px-6 py-3 text-xs font-bold text-gray-700 uppercase tracking-wide">{t('domain_col_actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-gray-400 text-sm">{t('domain_loading')}</td>
                </tr>
              )}
              {!isLoading && domains.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-gray-400 text-sm">
                    {search ? t('domain_no_results') : t('domain_empty')}
                  </td>
                </tr>
              )}
              {domains.map((d, i) => (
                <tr key={d.id} className="hover:bg-gray-50 transition-colors">
                  {/* # */}
                  <td className="px-6 py-4 text-gray-500 text-sm">{(page - 1) * limit + i + 1}</td>

                  {/* Domain Name */}
                  <td className="px-6 py-4 text-gray-800 text-sm font-medium">{d.name}</td>

                  {/* MAKE PRIMARY / Primary Domain label */}
                  <td className="px-6 py-4">
                    {d.primary ? (
                      <span className="text-sm text-gray-500">{t('domain_primary_label')}</span>
                    ) : (
                      <button
                        onClick={() => makePrimaryMutation.mutate(d.id)}
                        disabled={makePrimaryMutation.isPending}
                        className="px-4 py-1.5 text-xs font-bold text-blue-600 border border-blue-300 rounded hover:bg-blue-50 transition-colors uppercase tracking-wide disabled:opacity-50"
                      >
                        {t('domain_make_primary')}
                      </button>
                    )}
                  </td>

                  {/* STATUS Toggle */}
                  <td className="px-6 py-4 text-center">
                    <Toggle
                      active={d.active}
                      onToggle={() => toggleMutation.mutate(d.id)}
                    />
                  </td>

                  {/* ACTIONS — Pencil-Edit */}
                  <td className="px-6 py-4 text-center">
                    <button
                      onClick={() => setEditing(d)}
                      className="p-1.5 text-blue-500 hover:text-blue-700 border border-blue-200 rounded hover:bg-blue-50 transition-colors"
                      title={t('domain_edit_title_btn')}
                    >
                      <Pencil size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ── Fußzeile: Pagination ──────────────────────────── */}
          <div className="flex items-center gap-3 px-6 py-3 border-t border-gray-200">
            {/* Limit-Auswahl */}
            <div className="relative flex items-center">
              <select
                value={limit}
                onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
                className="appearance-none border border-gray-300 rounded px-3 py-1.5 pr-7 text-sm bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
              >
                {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <ChevronDown size={12} className="absolute right-2 text-gray-400 pointer-events-none" />
            </div>
            <span className="text-sm text-gray-500">{t('domain_per_page')}</span>

            <div className="flex-1" />

            {/* Seitennavigation */}
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded disabled:opacity-40"
                >
                  ‹
                </button>
                <span className="text-sm text-gray-600">{page} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded disabled:opacity-40"
                >
                  ›
                </button>
              </div>
            )}

            <span className="text-xs text-gray-400">{total} Domain{total !== 1 ? 's' : ''} {t('domain_total')}</span>
          </div>
        </div>
      </div>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {showAdd  && <AddDomainModal  onClose={() => setShowAdd(false)} />}
      {editing  && <EditDomainModal domain={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
