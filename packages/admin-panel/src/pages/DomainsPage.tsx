import { useId, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Modal } from '../components/Modal.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, X, Copy, Check, CheckCircle, AlertCircle, Globe, RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { useT } from '../i18n/useT.js';
import { Can } from '../components/Can.js';
import { EditPanel, ReportDirty, type EditPanelTab } from '../components/EditPanel.js';
import { ProtocolAccessEditor } from '../components/ProtocolAccessEditor.js';
import { WebmailPolicyEditor } from '../components/WebmailPolicyEditor.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { IdnText } from '../components/IdnText.js';
import { describeDomain } from '../lib/idn.js';
import { clientSetupRows, clientSetupSummary, srvParts, srvZoneLine, type SrvParts } from '../lib/dnsClientSetup.js';

// ── Types ─────────────────────────────────────────────────────────────────────
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

// ── DNS check types ───────────────────────────────────────────────────────────
interface DnsRec {
  type: string; name: string; expected: string; ok: boolean; found: string | null; warning?: string; recommended?: boolean;
  /** 9.3: hard error (e.g. MX is an IP literal or a CNAME) with the suggested fix. */
  error?: string; suggestion?: string;
  optional?: boolean; srv?: SrvParts;
}
interface DnsCheckResult {
  domain: string; hostname: string; serverIp: string;
  records: { a: DnsRec; mx: DnsRec; spf: DnsRec; dkim: DnsRec; dmarc: DnsRec; autodiscover: DnsRec; ptr: DnsRec };
  // v8.1: recommended client auto-setup records (SRV/autoconfig) + certificate SAN hint
  clientSetup?: Record<string, DnsRec>;
  certificateHostnames?: string[];
}

// ── DNS helpers (module level) ────────────────────────────────────────────────
function getHostPart(name: string, domain: string): string {
  if (name === domain) return '@';
  if (name.endsWith('.' + domain)) return name.slice(0, -(domain.length + 1));
  return name;
}

// ── CopyBtn (module level — no inline definition) ────────────────────────────
function CopyBtn({ value }: { value: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" aria-label={t('domain_dns_copy')}
      onClick={() => { void copyToClipboard(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      className="shrink-0 p-1 text-fg-subtle hover:text-info-fg transition-colors"
      title={t('domain_dns_copy')}
    >
      {copied ? <Check size={12} className="text-success-fg" /> : <Copy size={12} />}
    </button>
  );
}

// ── SrvFields — SRV split into provider fields + zone-file line (module level) ─
function SrvFields({ record, domain }: { record: DnsRec; domain: string }) {
  const t = useT();
  const parts = srvParts(record);
  if (!parts) return null;
  const fields: [string, string][] = [
    [t('domain_dns_srv_priority'), String(parts.priority)],
    [t('domain_dns_srv_weight'),   String(parts.weight)],
    [t('domain_dns_srv_port'),     String(parts.port)],
    [t('domain_dns_srv_target'),   parts.target],
  ];
  const zone = srvZoneLine(record.name, domain, parts);
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        {fields.map(([label, v]) => (
          <div key={label} className="min-w-0">
            <div className="text-[10px] text-fg-subtle">{label}</div>
            <div className="flex items-center gap-1">
              <code className="flex-1 bg-surface-2 border border-line rounded px-2 py-0.5 text-xs font-mono truncate min-w-0" title={v}>{v}</code>
              <CopyBtn value={v} />
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-1.5">
        <span className="text-[10px] text-fg-subtle w-16 shrink-0 pt-0.5">{t('domain_dns_srv_zone')}</span>
        <code className="flex-1 bg-surface-2 border border-line rounded px-2 py-0.5 text-xs font-mono break-all min-w-0 leading-relaxed">{zone}</code>
        <CopyBtn value={zone} />
      </div>
      <p className="text-[10px] text-fg-subtle leading-relaxed">{t('domain_dns_srv_hint')}</p>
    </div>
  );
}

// ── DnsRow (module level) ─────────────────────────────────────────────────────
interface DnsRowProps {
  label: string; record: DnsRec; domain: string;
  hostOverride?: string; valueOverride?: string; extra?: React.ReactNode;
}
function DnsRow({ label, record, domain, hostOverride, valueOverride, extra }: DnsRowProps) {
  const t = useT();
  const host  = hostOverride ?? getHostPart(record.name, domain);
  const value = valueOverride ?? record.expected;
  const isSrv = record.type === 'SRV' && srvParts(record) !== null;
  return (
    <div className="py-2.5 border-b border-line last:border-0">
      <div className="flex items-start gap-2">
        {record.ok
          ? <CheckCircle size={14} className="mt-0.5 shrink-0 text-success-fg" />
          // v8.1: recommended records are yellow when missing, never red; optional ones grey
          : <AlertCircle size={14} className={`mt-0.5 shrink-0 ${
              record.error ? 'text-danger-fg'
              : record.warning ? 'text-warning-fg'
              : record.optional ? 'text-fg-subtle'
              : record.recommended ? 'text-warning-fg' : 'text-danger-fg'}`} />}
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5 leading-none ${
          record.type === 'TXT'  ? 'bg-info-bg text-info-fg' :
          record.type === 'MX'   ? 'bg-info-bg   text-info-fg'   :
          record.type === 'A'    ? 'bg-success-bg  text-success-fg'  :
          record.type === 'CNAME'? 'bg-warning-bg  text-warning-fg'  :
          record.type === 'SRV'  ? 'bg-success-bg   text-success-fg'   :
                                   'bg-surface-2   text-fg-subtle'
        }`}>{record.type}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-fg-muted mb-1.5 flex flex-wrap items-center gap-1.5">
            {label}
            {record.optional && (
              <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-surface-2 text-fg-subtle leading-none">{t('domain_dns_optional_badge')}</span>
            )}
          </div>
          {/* Host */}
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-[10px] text-fg-subtle w-16 shrink-0">{t('domain_dns_host_label')}</span>
            <code className="flex-1 bg-surface-2 border border-line rounded px-2 py-0.5 text-xs font-mono truncate min-w-0" title={record.name}>{host}</code>
            <CopyBtn value={host} />
          </div>
          {/* Value — SRV split into provider fields + zone-file line */}
          {isSrv ? <SrvFields record={record} domain={domain} /> : value && (
            <div className="flex items-start gap-1.5">
              <span className="text-[10px] text-fg-subtle w-16 shrink-0 pt-0.5">{t('domain_dns_value_label')}</span>
              <code className="flex-1 bg-surface-2 border border-line rounded px-2 py-0.5 text-xs font-mono break-all min-w-0 leading-relaxed">{value}</code>
              <CopyBtn value={value} />
            </div>
          )}
          {record.optional && !record.ok && (
            <p className="mt-1 text-[10px] text-fg-subtle leading-relaxed">ℹ {t('domain_dns_optional_hint')}</p>
          )}
          {extra}
          {/* Currently in DNS — if different */}
          {record.found && record.found !== record.expected && (
            <div className="mt-1.5 text-[10px] text-fg-subtle bg-surface-2 rounded px-2 py-0.5 font-mono break-all">
              {t('domain_dns_found_label')}: {record.found.slice(0, 80)}{record.found.length > 80 ? '…' : ''}
            </div>
          )}
          {record.error && (
            <div className="mt-1.5 text-[10px] text-danger-fg bg-danger-bg rounded px-2 py-1 leading-relaxed" role="alert">✖ {record.error}</div>
          )}
          {record.warning && (
            <div className="mt-1.5 text-[10px] text-warning-fg bg-warning-bg rounded px-2 py-1 leading-relaxed">⚠ {record.warning}</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── DkimDnsRow — with 255-character chunk view ────────────────────────────────
function DkimDnsRow({ record, domain, label }: { record: DnsRec; domain: string; label: string }) {
  const t = useT();
  const [showChunked, setShowChunked] = useState(false);
  const full   = record.expected;
  const chunk1 = full.slice(0, 255);
  const chunk2 = full.slice(255);
  return (
    <DnsRow label={label} record={record} domain={domain} extra={
      full.length > 255 ? (
        <div className="mt-1.5">
          <button onClick={() => setShowChunked(s => !s)}
            className="text-[10px] text-info-fg hover:underline flex items-center gap-1">
            {showChunked ? '▲' : '▼'} {t('domain_dns_dkim_chunked')}
          </button>
          {showChunked && (
            <div className="mt-1 space-y-1">
              <div className="flex items-start gap-1.5">
                <code className="flex-1 bg-info-bg border border-info-line rounded px-2 py-0.5 text-xs font-mono break-all leading-relaxed">"{chunk1}"</code>
                <CopyBtn value={chunk1} />
              </div>
              {chunk2 && (
                <div className="flex items-start gap-1.5">
                  <code className="flex-1 bg-info-bg border border-info-line rounded px-2 py-0.5 text-xs font-mono break-all leading-relaxed">"{chunk2}"</code>
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


// ── Recommended client auto-setup records (v8.1, module level) ────────────────
function ClientSetupDnsSection({ dnsCheck }: { dnsCheck: DnsCheckResult }) {
  const t = useT();
  const rows = clientSetupRows(dnsCheck.clientSetup);
  if (rows.length === 0) return null;
  const summary = clientSetupSummary(rows);
  return (
    <div className="border-t border-line">
      <div className="bg-warning-bg px-3 py-2 border-b border-line">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-fg-muted">{t('domain_dns_recommended_title')}</span>
          <span className={`text-[10px] font-mono ${summary.ok === summary.total ? 'text-success-fg' : 'text-warning-fg'}`}>
            {summary.ok}/{summary.total} {t('domain_dns_recommended_count')}
          </span>
        </div>
        <p className="mt-1 text-[10px] text-fg-subtle leading-relaxed">{t('domain_dns_recommended_hint')}</p>
      </div>
      <div className="px-3">
        {rows.map((row) => (
          <DnsRow key={row.key} label={t(row.labelKey)} record={{ ...row.record, recommended: true }} domain={dnsCheck.domain} />
        ))}
      </div>
      {dnsCheck.certificateHostnames && dnsCheck.certificateHostnames.length > 0 && (
        <div className="px-3 py-2 border-t border-line text-[10px] text-fg-subtle leading-relaxed">
          ℹ {t('domain_dns_cert_hint')}{' '}
          {dnsCheck.certificateHostnames.map((h, i) => (
            <span key={h}>{i > 0 && ', '}<code className="font-mono text-fg-muted">{h}</code></span>
          ))}
        </div>
      )}
    </div>
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

  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}

      closeOnBackdrop={false}
      overlayClassName="fixed inset-0 bg-scrim/40 flex items-center justify-center z-50"
      className="bg-surface rounded-lg shadow-2xl w-full max-w-sm p-6"
    >
        <div className="flex items-center justify-between mb-5">
          <h2 id={titleId} className="text-base font-semibold text-fg">{t('domain_add_title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('action_close')} className="p-1 text-fg-subtle hover:text-fg-muted rounded">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">{t('domain_add_name_label')} <span className="text-danger-fg">*</span></label>
            <input
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="example.com"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && name.trim() && createMutation.mutate()}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">{t('domain_add_dkim_label')}</label>
            <input
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg"
              value={selector}
              onChange={e => setSelector(e.target.value)}
              placeholder="coremail"
            />
            <p className="text-xs text-fg-subtle mt-1">{t('domain_add_dkim_hint')}</p>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-fg-muted bg-surface-2 rounded hover:bg-surface-3 transition-colors"
          >
            {t('action_cancel')}
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!name.trim() || createMutation.isPending}
            className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {createMutation.isPending ? t('domain_add_btn_adding') : t('domain_add_btn_add')}
          </button>
        </div>
    </Modal>
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
    // Only changed fields: an unchanged name must not trip the server's rename guard.
    mutationFn: () => api.put<Domain>(`/admin/domains/${domain.id}`, {
      ...(name.trim() !== domain.name ? { name: name.trim() } : {}),
      ...(selector.trim() !== domain.dkimSelector ? { dkimSelector: selector.trim() } : {}),
    }),
    onSuccess: () => {
      toast.success(t('domain_updated_toast'));
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
    },
    onError: (err: Error) => toast.error(err.message || t('domain_save_error')),
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
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('domain_dkim_load_error'));
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
      setDnsCheck(null); // Invalidate DNS panel — new key
      toast.success(t('domain_dkim_regen_success'));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('domain_dkim_regen_error'));
    } finally {
      setDkimLoading(false);
    }
  };

  const runDnsCheck = async () => {
    setDnsLoading(true);
    try {
      const r = await api.get<DnsCheckResult>(`/admin/domains/${domain.id}/dns-check`);
      setDnsCheck(r);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t('domain_dns_check_error'));
    } finally {
      setDnsLoading(false);
    }
  };

  const tabs: EditPanelTab[] = [
    {
      id: 'general', label: t('mbox_tab_general'),
      content: (
        <>
          <ReportDirty dirty={name !== domain.name || selector !== domain.dkimSelector} />
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">{t('domain_edit_name_label')}</label>
            <input
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-fg-muted mb-1">{t('domain_edit_dkim_label')}</label>
            <input
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg"
              value={selector}
              onChange={e => setSelector(e.target.value)}
            />
          </div>

          {/* Info */}
          <div className="flex items-center gap-4 pt-1">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${domain.primary ? 'bg-info-bg text-info-fg' : 'bg-surface-2 text-fg-subtle'}`}>
              {domain.primary ? t('domain_edit_primary') : t('domain_edit_secondary')}
            </span>
            <span className="text-xs text-fg-subtle">{domain._count.users} {t('domain_edit_mailbox_count')}</span>
          </div>

          {/* ── DKIM Quick-Show ────────────────────────────────────────────── */}
          <div className="pt-1 flex items-center gap-3">
            <button
              onClick={() => void loadDkim()}
              disabled={dkimLoading}
              className="flex items-center gap-1.5 text-xs text-info-fg hover:underline disabled:opacity-50"
            >
              <CheckCircle size={13} />
              {dkimLoading ? t('domain_dkim_loading') : t('domain_dkim_show')}
            </button>
            {dkimRecord && (
              <button
                onClick={() => void regenerateDkim()}
                disabled={dkimLoading}
                className="flex items-center gap-1.5 text-xs text-warning-fg hover:underline disabled:opacity-50"
                title={t('domain_dkim_regen_title')}
              >
                <RefreshCw size={12} />
                {t('domain_dkim_regenerate')}
              </button>
            )}
          </div>

          {dkimRecord && (
            <div className="bg-surface-2 rounded-lg p-3 space-y-2 border border-line">
              <div>
                <label className="text-xs text-fg-subtle font-medium">{t('domain_dkim_dns_name')}</label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="flex-1 bg-surface border border-line rounded px-2 py-1 text-xs font-mono break-all">{dkimRecord.dnsName}</code>
                  <button aria-label={t('domain_dns_copy')} onClick={() => { copyToClipboard(dkimRecord.dnsName).then(() => toast.success(t('domain_dkim_copied'))).catch(() => toast.error(t('domain_dkim_copy_error'))); }} className="p-1 text-fg-subtle hover:text-fg-muted"><Copy size={12} /></button>
                </div>
              </div>
              <div>
                <label className="text-xs text-fg-subtle font-medium">{t('domain_dkim_txt_value')}</label>
                <div className="flex items-start gap-2 mt-1">
                  <code className="flex-1 bg-surface border border-line rounded px-2 py-1 text-xs font-mono break-all">{dkimRecord.dnsValue}</code>
                  <button aria-label={t('domain_dns_copy')} onClick={() => { copyToClipboard(dkimRecord.dnsValue).then(() => toast.success(t('domain_dkim_copied'))).catch(() => toast.error(t('domain_dkim_copy_error'))); }} className="p-1 text-fg-subtle hover:text-fg-muted mt-0.5"><Copy size={12} /></button>
                </div>
              </div>
            </div>
          )}

          {/* ── DNS setup ──────────────────────────────────────────────────── */}
          <div className="pt-1 border-t border-line">
            <button
              onClick={() => void runDnsCheck()}
              disabled={dnsLoading}
              className="flex items-center gap-1.5 text-xs text-info-fg hover:underline disabled:opacity-50"
            >
              <Globe size={13} />
              {dnsLoading ? t('domain_dns_checking') : t('domain_dns_check_btn')}
              {dnsCheck && !dnsLoading && <RefreshCw size={11} className="ml-1 opacity-60" />}
            </button>

            {dnsCheck && (
              <div className="mt-2 rounded-lg border border-line overflow-hidden">
                {/* Header */}
                <div className="bg-surface-2 px-3 py-2 border-b border-line flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-fg-muted">
                    {t('domain_dns_panel_title')} <span className="text-info-fg">{dnsCheck.domain}</span>
                  </span>
                  <span className="text-[10px] text-fg-subtle font-mono">
                    {dnsCheck.hostname}
                    {dnsCheck.serverIp ? <> · <span className="text-success-fg">{dnsCheck.serverIp}</span></> : <span className="text-warning-fg"> · {t('domain_dns_ip_unknown')}</span>}
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
                  {/* DKIM — with chunked option */}
                  <DkimDnsRow label={t('domain_dns_record_dkim')} record={dnsCheck.records.dkim} domain={dnsCheck.domain} />
                  {/* DMARC */}
                  <DnsRow label={t('domain_dns_record_dmarc')} record={dnsCheck.records.dmarc} domain={dnsCheck.domain} />
                  {/* Autodiscover */}
                  <DnsRow label={t('domain_dns_record_ac')} record={dnsCheck.records.autodiscover} domain={dnsCheck.domain} />
                  {/* PTR — host = server IP, value = hostname */}
                  <DnsRow
                    label={t('domain_dns_record_ptr')}
                    record={dnsCheck.records.ptr}
                    domain={dnsCheck.domain}
                    hostOverride={dnsCheck.serverIp || t('domain_dns_server_ip')}
                    valueOverride={dnsCheck.hostname}
                    extra={<p className="mt-1 text-[10px] text-fg-subtle">ℹ {t('domain_dns_ptr_note')}</p>}
                  />
                </div>
                <ClientSetupDnsSection dnsCheck={dnsCheck} />
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-5">
          {/* Delete only if not primary */}
          <button
            onClick={() => {
              if (confirm(`${t('domain_delete_confirm')} "${domain.name}"`)) deleteMutation.mutate();
            }}
            disabled={domain.primary || deleteMutation.isPending}
            className="px-3 py-2 text-sm text-danger-fg hover:bg-danger-bg rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={domain.primary ? t('domain_delete_primary_title') : undefined}
          >
            {t('action_delete')}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-fg-muted bg-surface-2 rounded hover:bg-surface-3 transition-colors">
              {t('action_cancel')}
            </button>
            <button
              onClick={() => updateMutation.mutate()}
              disabled={!name.trim() || updateMutation.isPending}
              className="px-4 py-2 text-sm text-white bg-accent rounded hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {updateMutation.isPending ? t('action_saving') : t('action_save')}
            </button>
          </div>
        </div>
        </>
      ),
    },
    // 9.4: protocol access (domain level; write = servers area)
    { id: 'protocols', label: t('mbox_tab_protocols'), content: <ProtocolAccessEditor path={`/admin/protocol-access/domains/${domain.id}`} area="servers" /> },
    // 9.4: webmail policies (domain level; write = servers area)
    { id: 'webmail', label: t('mbox_tab_webmail'), content: <WebmailPolicyEditor path={`/admin/webmail-policies/domains/${domain.id}`} area="servers" /> },
  ];

  return <EditPanel kind="domain" title={t('domain_edit_title')} subtitle={domain.name} tabs={tabs} onClose={onClose} />;
}

// ── Main component ────────────────────────────────────────────────────────────
export function DomainsPage() {
  const t = useT();
  const qc = useQueryClient();

  // w2b: `?q=` (links from Dienste → Protokolle) starts the search
  const [searchParams] = useSearchParams();
  const [search, setSearch]       = useState(() => searchParams.get('q') ?? '');
  const [limit,  setLimit]        = useState(50);
  const [page,   setPage]         = useState(1);
  const [showAdd, setShowAdd]     = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Debounced search query string
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Server-side search + paging (API: search/page/limit)
  const { data, isLoading, isFetching, refetch } = useQuery<DomainsResponse>({
    queryKey: ['admin-domains', debouncedSearch, page, limit],
    queryFn:  () => api.get<DomainsResponse>(
      `/admin/domains?search=${encodeURIComponent(debouncedSearch)}&page=${page}&limit=${limit}`
    ),
    placeholderData: prev => prev,
  });

  const domains = data?.domains ?? [];
  // The panel reads the live row: after a save the list refetches and the form compares against the saved state.
  const editing = domains.find((d) => d.id === editingId) ?? null;
  const total   = data?.total   ?? 0;

  const toggleMutation = useMutation({
    mutationFn: (id: string) => api.patch(`/admin/domains/${id}/toggle`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-domains'] }),
    onError: (err: Error) => toast.error(err.message || t('domain_toggle_error')),
  });

  const makePrimaryMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/domains/${id}/make-primary`, {}),
    onSuccess: () => {
      toast.success(t('domain_primary_set_toast'));
      void qc.invalidateQueries({ queryKey: ['admin-domains'] });
    },
    onError: (err: Error) => toast.error(err.message || t('domain_primary_error')),
  });

  const columns: Column<Domain>[] = [
    {
      key: 'name', header: t('domain_col_domain'),
      cell: (d) => <IdnText display={describeDomain(d.name)} className="text-fg text-sm font-medium break-all" />,
    },
    {
      key: 'primary', header: t('domain_primary_label'), srOnlyHeader: true, className: 'w-44',
      cell: (d) => d.primary ? (
        <span className="text-sm text-fg-subtle">{t('domain_primary_label')}</span>
      ) : (
        <Can area="domains" access="write">
          <button
            onClick={() => makePrimaryMutation.mutate(d.id)}
            disabled={makePrimaryMutation.isPending}
            className="px-4 py-1.5 text-xs font-bold text-info-fg border border-info-line rounded hover:bg-info-bg transition-colors uppercase tracking-wide disabled:opacity-50"
          >
            {t('domain_make_primary')}
          </button>
        </Can>
      ),
    },
    {
      key: 'users', header: t('mbox_page_title'),
      cell: (d) => <span className="text-fg-subtle text-xs">{d._count?.users ?? 0}</span>,
    },
    {
      key: 'status', header: t('domain_col_status'), headerClassName: 'text-center', className: 'text-center',
      cell: (d) => (
        <Can area="domains" access="write" fallback={<span className="text-xs text-fg-subtle">{d.active ? t('status_active') : t('status_inactive')}</span>}>
          <Toggle active={d.active} onToggle={() => toggleMutation.mutate(d.id)} />
        </Can>
      ),
    },
    {
      key: 'actions', header: t('domain_col_actions'), srOnlyHeader: true, className: 'text-center',
      cell: (d) => (
        <Can area="domains" access="write">
          <button
            onClick={() => setEditingId(d.id)}
            className="p-1.5 text-info-fg hover:text-info-fg border border-info-line rounded hover:bg-info-bg transition-colors"
            title={t('domain_edit_title_btn')}
            aria-label={`${t('domain_edit_title_btn')}: ${d.name}`}
          >
            <Pencil size={14} />
          </button>
        </Can>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg">{t('domain_page_title')}</h1>
        <p className="text-xs text-fg-subtle mt-0.5">{total} Domain{total !== 1 ? 's' : ''} {t('domain_total')}</p>
      </div>

      <DataTable<Domain>
        caption={t('domain_section_title')}
        rows={domains}
        columns={columns}
        rowKey={(d) => d.id}
        loading={isLoading}
        server={{ page, pageSize: limit, total, onPageChange: setPage }}
        search={{ placeholder: t('domain_search_placeholder'), value: search, onChange: (q) => { setSearch(q); setPage(1); } }}
        emptyText={search ? t('domain_no_results') : t('domain_empty')}
        filters={
          <label className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <select
              value={limit}
              onChange={e => { setLimit(Number(e.target.value)); setPage(1); }}
              className="input w-auto py-1"
            >
              {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            {t('domain_per_page')}
          </label>
        }
        toolbar={() => (
          <>
            <Can area="domains" access="write">
              <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-1.5">
                <Plus size={15} aria-hidden="true" /> {t('domain_add_btn')}
              </button>
            </Can>
            <button onClick={() => void refetch()} className="btn-secondary flex items-center gap-1.5 text-xs">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} aria-hidden="true" /> {t('tb_refresh')}
            </button>
          </>
        )}
      />

      {/* ── Modals ─────────────────────────────────────────────────────────── */}
      {showAdd  && <AddDomainModal  onClose={() => setShowAdd(false)} />}
      {editing  && <EditDomainModal domain={editing} onClose={() => setEditingId(null)} />}
    </div>
  );
}
