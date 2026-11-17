/**
 * SSL/TLS certificate management
 *
 * Lists all certificates, allows:
 * - Requesting Let's Encrypt (ACME HTTP-01)
 * - Uploading your own certificate (PEM)
 * - Generating a self-signed certificate
 * - Renewing / deleting certificates
 */
import { useEffect, useId, useState } from 'react';
import { Modal as AccessibleModal } from '../components/Modal.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ShieldCheck, Plus, RefreshCw, Trash2, Upload,
  ChevronDown, ChevronUp, X, Loader2, AlertCircle,
  Lock, LockOpen, Server, Pencil,
  CheckCircle2, AlertTriangle, XCircle, ListChecks,
} from 'lucide-react';
import { api } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { Can } from '../components/Can.js';
import { DataTable, type Column } from '../components/DataTable.js';
import {
  acmeActionLabel, acmeErrorHint, canStartAcme, CHECK_LABELS, parseDomainList,
  type CertStatus, type CheckStatus, type PreflightReport,
} from '../lib/certStatus.js';
import { SERVED_CERT_QUERY_KEY, ServedCertTable, ServedCertWarning } from '../components/ServedCert.js';
import { Toggle } from '../components/Toggle.js';
import { hasMailProtocols, mailProtocolHolder, mailServicesFor, MAIL_PROTOCOLS_LABEL } from '../lib/mailProtocols.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type CertType   = 'LETSENCRYPT' | 'CUSTOM' | 'SELF_SIGNED';

interface Certificate {
  id:               string;
  name:             string;
  domains:          string[];
  services:         string[];
  type:             CertType;
  status:           CertStatus;
  issuedAt:         string | null;
  expiresAt:        string | null;
  autoRenew:        boolean;
  isActiveHttps:    boolean;
  isActiveProtocol: boolean;
  acmeEmail:        string | null;
  /** Let's Encrypt staging environment (test certificate, not trusted by browsers) */
  acmeStaging?:     boolean;
  lastError:        string | null;
  /** Classified failure (connection, dns, caa, rate-limited, timeout, …) */
  lastErrorCode?:   string | null;
  createdAt:        string;
  updatedAt?:       string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

/**
 * Usable for HTTPS / protocol activation: the server checks the PEM validity
 * (v6), so an EXPIRING cert or one whose renewal failed (ERROR/RENEWING) but
 * whose PEM is still valid can be activated.
 */
function isCertUsable(status: CertStatus, expiresAt: string | null): boolean {
  if (status === 'ACTIVE' || status === 'EXPIRING') return true;
  if (status === 'ERROR' || status === 'RENEWING') return (daysUntil(expiresAt) ?? -1) >= 0;
  return false;
}

function StatusBadge({ status, expiresAt }: { status: CertStatus; expiresAt: string | null }) {
  const days = daysUntil(expiresAt);
  const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold';
  if (status === 'ACTIVE')   return <span className={`${base} bg-success-bg text-success-fg`}>Aktiv{days !== null ? ` · ${days}d` : ''}</span>;
  if (status === 'EXPIRING') return <span className={`${base} bg-warning-bg text-warning-fg`}>Läuft ab · {days}d</span>;
  if (status === 'EXPIRED')  return <span className={`${base} bg-danger-bg text-danger-fg`}>Abgelaufen</span>;
  if (status === 'PENDING')  return <span className={`${base} bg-info-bg text-info-fg`}><Loader2 size={10} className="animate-spin" /> Ausstehend</span>;
  if (status === 'RENEWING') return <span className={`${base} bg-info-bg text-info-fg`}><Loader2 size={10} className="animate-spin" /> Erneuerung</span>;
  if (status === 'ERROR')    return <span className={`${base} bg-danger-bg text-danger-fg`}><AlertCircle size={10} /> Fehler</span>;
  return <span className={`${base} bg-surface-2 text-fg-muted`}>{status}</span>;
}

function TypeBadge({ type, staging }: { type: CertType; staging?: boolean | undefined }) {
  const base = 'px-2 py-0.5 rounded text-xs font-medium';
  if (type === 'LETSENCRYPT' && staging) {
    return <span className={`${base} bg-warning-bg text-warning-fg`} title="Test-Zertifikat der Let's Encrypt Staging-Umgebung — von Browsern nicht vertraut">Let's Encrypt · Staging</span>;
  }
  if (type === 'LETSENCRYPT') return <span className={`${base} bg-info-bg text-info-fg`}>Let's Encrypt</span>;
  if (type === 'CUSTOM')      return <span className={`${base} bg-info-bg text-info-fg`}>Eigenes</span>;
  return <span className={`${base} bg-surface-2 text-fg-muted`}>Self-Signed</span>;
}

// Mail protocols only — HTTPS is activated via the lock icon, not via services
const SERVICE_COLORS: Record<string, string> = {
  SMTP: 'bg-success-bg text-success-fg',
  IMAP: 'bg-success-bg text-success-fg',
  POP3: 'bg-success-bg text-success-fg',
};

/**
 * 9.3: SMTP, IMAP and POP3 always share one certificate — one switch
 * (lib/mailProtocols.ts). Shows which certificate currently holds the mail
 * protocols and loses them when the switch is saved as on.
 */
function MailProtocolSwitch({
  on, onChange, allCerts, currentCertId,
}: {
  on:             boolean;
  onChange:       (on: boolean) => void;
  allCerts?:      Certificate[];
  currentCertId?: string; // undefined = new cert
}) {
  const holder = mailProtocolHolder(allCerts, currentCertId);
  return (
    <div>
      <div className="flex items-center gap-3">
        <Toggle active={on} onToggle={() => onChange(!on)} label={MAIL_PROTOCOLS_LABEL} />
        <span className="text-sm font-medium text-fg-muted" aria-hidden="true">{MAIL_PROTOCOLS_LABEL}</span>
      </div>
      {on && holder && (
        <p className="mt-2 text-xs text-warning-fg bg-warning-bg border border-warning-line rounded px-2 py-1">
          Aktuell bei „{holder}" — SMTP, IMAP und POP3 werden beim Speichern diesem Zertifikat übertragen und beim anderen entfernt.
        </p>
      )}
    </div>
  );
}

// ── Modal types ───────────────────────────────────────────────────────────────

type ModalMode = 'letsencrypt' | 'upload' | 'selfsigned' | null;

// ── TLS proxy status types ────────────────────────────────────────────────────

interface TlsProxyInfo {
  port:       number;
  activeCert: { id: string; name: string; domains: string[]; status: string } | null;
}

// ── Main component ────────────────────────────────────────────────────────────

export function CertificatesPage() {
  const t = useT();
  const qc = useQueryClient();
  const { can } = usePermissions();
  const canWrite = can('servers', 'write');
  const [modal, setModal] = useState<ModalMode>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingCert, setEditingCert] = useState<Certificate | null>(null);

  const { data: certs = [], isLoading, isFetching, refetch } = useQuery<Certificate[]>({
    queryKey: ['admin-certificates'],
    queryFn: () => api.get<Certificate[]>('/admin/certificates'),
    refetchInterval: 10_000,
  });

  const { data: tlsInfo } = useQuery<TlsProxyInfo>({
    queryKey: ['admin-certificates-tls-info'],
    queryFn: () => api.get<TlsProxyInfo>('/admin/certificates/tls-proxy-info'),
    refetchInterval: 15_000,
  });

  const renewMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/certificates/${id}/renew`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-certificates'] }); toast.success('Let\'s Encrypt-Vorgang gestartet'); },
    onError: (err: unknown) => toast.error((err as { message?: string })?.message ?? 'Erneuerung fehlgeschlagen'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/certificates/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-certificates'] }); toast.success('Zertifikat gelöscht'); },
    onError: (err: Error) => toast.error(err.message || 'Löschen fehlgeschlagen'),
  });

  const activateHttpsMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/certificates/${id}/activate-https`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      toast.success('HTTPS-Proxy (Port 443) aktiviert');
    },
    onError: (err: unknown) => {
      const msg = (err as { message?: string })?.message ?? 'Aktivierung fehlgeschlagen';
      toast.error(msg);
    },
  });

  const activateProtocolMutation = useMutation({
    mutationFn: (id: string) => api.post(`/admin/certificates/${id}/activate-protocol`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      setTimeout(() => void qc.invalidateQueries({ queryKey: SERVED_CERT_QUERY_KEY }), 2_000);
      toast.success('Zertifikat wird jetzt für SMTP/IMAP/POP3 verwendet');
    },
    onError: (err: unknown) => {
      const msg = (err as { message?: string })?.message ?? 'Aktivierung fehlgeschlagen';
      toast.error(msg);
    },
  });

  const deactivateHttpsMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/certificates/${id}/activate-https`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      toast.success('HTTPS-Proxy deaktiviert — Mail-Protokolle nutzen Cert weiterhin');
    },
    onError: (err: Error) => toast.error(err.message || 'Deaktivierung fehlgeschlagen'),
  });

  function confirmDelete(cert: Certificate) {
    const activeFor: string[] = [];
    if (cert.isActiveHttps)    activeFor.push('HTTPS-Proxy (Port 443)');
    if (cert.isActiveProtocol) activeFor.push('Protokoll-TLS (SMTP/IMAP/POP3)');
    const warning = activeFor.length > 0
      ? `\n\n⚠️ Aktiv für: ${activeFor.join(', ')}.\nDie betroffenen Dienste nutzen danach wieder das selbstsignierte Zertifikat.`
      : '';
    if (!window.confirm(`Zertifikat "${cert.name}" wirklich löschen?${warning}`)) return;
    deleteMutation.mutate(cert.id);
  }


  const columns: Column<Certificate>[] = [
    {
      key: 'name', header: t('cert_col_name'), sortValue: (c) => c.name,
      cell: (cert) => (
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-fg-subtle shrink-0" aria-hidden="true">
            {expandedId === cert.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </span>
          <div>
            <p className="font-medium text-fg text-sm">{cert.name}</p>
            <p className="text-xs text-fg-subtle mt-0.5">{cert.domains.slice(0, 2).join(', ')}{cert.domains.length > 2 ? ` +${cert.domains.length - 2}` : ''}</p>
          </div>
        </div>
      ),
    },
    { key: 'type', header: t('cert_col_type'), sortValue: (c) => c.type, cell: (cert) => <TypeBadge type={cert.type} staging={cert.acmeStaging} /> },
    { key: 'status', header: t('cert_col_status'), sortValue: (c) => c.status, cell: (cert) => <StatusBadge status={cert.status} expiresAt={cert.expiresAt} /> },
    {
      key: 'expires', header: t('cert_col_expires'), sortValue: (c) => (c.expiresAt ? new Date(c.expiresAt) : null),
      className: 'text-xs text-fg-subtle whitespace-nowrap',
      cell: (cert) => (cert.expiresAt ? new Date(cert.expiresAt).toLocaleDateString() : '–'),
    },
    {
      key: 'services', header: t('cert_col_services'),
      cell: (cert) => (
        <div className="flex flex-wrap gap-1">
          {cert.services.length === 0
            ? <span className="text-xs text-fg-subtle">–</span>
            : cert.services.map(s => (
                <span key={s} className={`px-1.5 py-0.5 rounded text-xs font-medium ${SERVICE_COLORS[s] ?? 'bg-surface-2 text-fg-muted'}`}>{s}</span>
              ))}
        </div>
      ),
    },
    {
      key: 'actions', header: t('mbox_col_actions'), srOnlyHeader: true, className: 'text-right',
      cell: (cert) => (
        <Can area="servers" access="write">
          <div className="flex items-center justify-end gap-1">
                        {/* ── HTTPS proxy lock ── */}
                        {cert.isActiveHttps ? (
                          <button
                            onClick={() => deactivateHttpsMutation.mutate(cert.id)}
                            disabled={deactivateHttpsMutation.isPending}
                            title="HTTPS-Proxy deaktivieren"
                            aria-label="HTTPS-Proxy deaktivieren"
                            className="p-1.5 text-success-fg hover:text-fg-subtle hover:bg-surface-2 rounded transition-colors disabled:opacity-40">
                            <Lock size={14} />
                          </button>
                        ) : isCertUsable(cert.status, cert.expiresAt) ? (
                          <button aria-label="HTTPS-Proxy (Port 443) aktivieren"
                            onClick={() => activateHttpsMutation.mutate(cert.id)}
                            disabled={activateHttpsMutation.isPending}
                            title="HTTPS-Proxy (Port 443) aktivieren"
                            className="p-1.5 text-fg-subtle hover:text-success-fg hover:bg-success-bg rounded transition-colors disabled:opacity-40">
                            <LockOpen size={14} />
                          </button>
                        ) : null}
                        {/* ── Protocol TLS (SMTP/IMAP/POP3) — independent of HTTPS ── */}
                        {cert.isActiveProtocol ? (
                          <span title="SMTP/IMAP/POP3 nutzen dieses Cert" role="img" aria-label="SMTP/IMAP/POP3 nutzen dieses Cert" className="p-1.5 text-info-fg cursor-default">
                            <Server size={14} />
                          </span>
                        ) : isCertUsable(cert.status, cert.expiresAt) ? (
                          <button aria-label="Sofort für SMTP/IMAP/POP3 verwenden"
                            onClick={() => activateProtocolMutation.mutate(cert.id)}
                            disabled={activateProtocolMutation.isPending || (cert.type === 'LETSENCRYPT' && !!cert.acmeStaging)}
                            title={cert.type === 'LETSENCRYPT' && cert.acmeStaging ? 'Staging-Zertifikate werden nie für SMTP/IMAP/POP3 verwendet' : 'Sofort für SMTP/IMAP/POP3 verwenden'}
                            className="p-1.5 text-fg-subtle hover:text-info-fg hover:bg-info-bg rounded transition-colors disabled:opacity-40">
                            <Server size={14} />
                          </button>
                        ) : null}
                        {cert.type === 'LETSENCRYPT' && (() => {
                          // 9.2.x: a retry is possible after every failure and for runs left
                          // over by a server restart; never while a live run is in progress.
                          const label = acmeActionLabel(cert);
                          const startable = canStartAcme(cert);
                          const running = (cert.status === 'RENEWING' || cert.status === 'PENDING') && !startable;
                          return (
                            <button aria-label={label}
                              onClick={() => renewMutation.mutate(cert.id)}
                              disabled={!startable || renewMutation.isPending}
                              title={label}
                              className={`p-1.5 rounded transition-colors disabled:opacity-40 hover:text-info-fg hover:bg-info-bg ${
                                cert.status === 'EXPIRED' || cert.status === 'ERROR' || (startable && (cert.status === 'PENDING' || cert.status === 'RENEWING')) ? 'text-danger-fg'
                                : cert.status === 'EXPIRING' ? 'text-warning-fg'
                                : 'text-fg-subtle'}`}>
                              <RefreshCw size={14} className={running ? 'animate-spin' : ''} />
                            </button>
                          );
                        })()}
                        <button
                          onClick={() => setEditingCert(cert)}
                          title="Bearbeiten (Name, Services, Auto-Renew)" aria-label={`${t('tb_edit')}: ${cert.name}`}
                          className="p-1.5 text-fg-subtle hover:text-info-fg hover:bg-info-bg rounded transition-colors">
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={() => confirmDelete(cert)}
                          title="Löschen" aria-label={`${t('tb_delete')}: ${cert.name}`}
                          className="p-1.5 text-fg-subtle hover:text-danger-fg hover:bg-danger-bg rounded transition-colors">
                          <Trash2 size={14} />
                        </button>
          </div>
        </Can>
      ),
    },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ShieldCheck size={22} className="text-info-fg" />
          <div>
            <h1 className="text-xl font-bold text-fg">{t('page_certificates')}</h1>
            <p className="text-sm text-fg-subtle">{certs.length} Zertifikat{certs.length !== 1 ? 'e' : ''}</p>
          </div>
        </div>
      </div>

      {/* HTTPS status banner — only when active */}
      {tlsInfo?.activeCert && (
        <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-success-bg border border-success-line rounded-xl text-sm text-success-fg">
          <Lock size={16} className="text-success-fg shrink-0" />
          <span>
            <strong>HTTPS aktiv</strong> — Port {tlsInfo.port} verwendet{' '}
            <span className="font-mono font-medium">{tlsInfo.activeCert.name}</span>
            {tlsInfo.activeCert.domains[0] && (
              <> für <span className="font-mono">{tlsInfo.activeCert.domains[0]}</span></>
            )}
            {' '}· Zum Deaktivieren: grünes Schloss-Symbol klicken.
          </span>
        </div>
      )}

      {/* 9.3: what the mail ports really serve */}
      <ServedCertWarning />
      <ServedCertTable />

      {/* Status banners */}
      {certs.some(c => (c.status === 'PENDING' || c.status === 'RENEWING') && !canStartAcme(c)) && (
        <div className="mb-3 px-4 py-3 bg-info-bg border border-info-line rounded-xl flex items-center gap-2 text-sm text-info-fg" role="status">
          <Loader2 size={14} className="animate-spin shrink-0" aria-hidden="true" />
          <span>ACME-Prozess läuft… Let's Encrypt verifiziert die Domain über <strong>Port 80</strong> (<code className="font-mono text-xs bg-info-bg px-1 rounded">/.well-known/acme-challenge/</code>). Das dauert meist unter einer Minute, höchstens 5 Minuten.</span>
        </div>
      )}
      {certs.some(c => c.status === 'ERROR') && (
        <div className="mb-3 px-4 py-3 bg-danger-bg border border-danger-line rounded-xl flex items-start gap-2 text-sm text-danger-fg" role="alert">
          <AlertCircle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1">
            <p>
              <strong>Zertifikat fehlgeschlagen.</strong>{' '}
              Vollständige Meldung von Let's Encrypt: Zeile aufklappen (<ChevronDown size={12} className="inline mb-0.5" aria-hidden="true" />).
            </p>
            <ul className="list-disc pl-4">
              {certs.filter(c => c.status === 'ERROR').map(c => (
                <li key={c.id}>
                  <span className="font-medium">{c.name}</span>
                  {acmeErrorHint(c.lastErrorCode) ? <>: {acmeErrorHint(c.lastErrorCode)}</> : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* List — client-side search/sort/paging (the API returns every certificate) */}
      <DataTable<Certificate>
        caption="SSL/TLS"
        rows={certs}
        columns={columns}
        rowKey={(c) => c.id}
        loading={isLoading}
        initialSort={{ key: 'name', dir: 'asc' }}
        search={{ text: (c) => [c.name, c.type, c.status, ...c.domains, ...c.services] }}
        selectable={canWrite}
        onActivate={(c) => setExpandedId(expandedId === c.id ? null : c.id)}
        activeKey={expandedId}
        emptyText={
          <span className="inline-flex flex-col items-center gap-2">
            <ShieldCheck size={32} className="opacity-30" aria-hidden="true" />
            Noch keine Zertifikate. Erstelle dein erstes Zertifikat.
          </span>
        }
        renderExpanded={(cert) => expandedId === cert.id ? (
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <p className="text-xs text-fg-subtle mb-1">Alle Domains</p>
                            <div className="flex flex-wrap gap-1">
                              {cert.domains.map(d => (
                                <span key={d} className="px-2 py-0.5 bg-surface border border-line rounded text-xs font-mono">{d}</span>
                              ))}
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <p className="text-xs text-fg-subtle">Ausgestellt</p>
                              <p className="text-fg-muted">{cert.issuedAt ? new Date(cert.issuedAt).toLocaleDateString('de-DE') : '–'}</p>
                            </div>
                            <div>
                              <p className="text-xs text-fg-subtle">Läuft ab</p>
                              <p className="text-fg-muted">{cert.expiresAt ? new Date(cert.expiresAt).toLocaleDateString('de-DE') : '–'}</p>
                            </div>
                            <div>
                              <p className="text-xs text-fg-subtle">Auto-Renew</p>
                              <p className="text-fg-muted">{cert.autoRenew ? 'Ja' : 'Nein'}</p>
                            </div>
                            {/* HTTPS-Proxy Status */}
                            <div>
                              <p className="text-xs text-fg-subtle">HTTPS-Proxy (Port 443)</p>
                              <p className="flex items-center gap-1 text-fg-muted">
                                {cert.isActiveHttps
                                  ? <><Lock size={12} className="text-success-fg" /> <span className="text-success-fg font-medium">Aktiv</span></>
                                  : <><LockOpen size={12} className="text-fg-subtle" /> <span className="text-fg-subtle">Inaktiv</span></>
                                }
                              </p>
                            </div>
                            {/* Protocol TLS status — independent of HTTPS proxy */}
                            <div>
                              <p className="text-xs text-fg-subtle">Protokoll-TLS (SMTP/IMAP/POP3)</p>
                              <p className="flex items-center gap-1 text-fg-muted">
                                {cert.isActiveProtocol
                                  ? <><Server size={12} className="text-success-fg" /> <span className="text-success-fg font-medium">Aktiv — SMTP/IMAP/POP3 verwenden dieses Zertifikat</span></>
                                  : <><Server size={12} className="text-fg-subtle" /> <span className="text-fg-subtle">Inaktiv</span></>
                                }
                              </p>
                            </div>
                            {cert.acmeEmail && (
                              <div>
                                <p className="text-xs text-fg-subtle">ACME E-Mail</p>
                                <p className="text-fg-muted">{cert.acmeEmail}</p>
                              </div>
                            )}
                            {cert.type === 'LETSENCRYPT' && (
                              <div>
                                <p className="text-xs text-fg-subtle">Let's Encrypt-Umgebung</p>
                                <p className={cert.acmeStaging ? 'text-warning-fg' : 'text-fg-muted'}>
                                  {cert.acmeStaging ? 'Staging (Test, nicht vertrauenswürdig)' : 'Produktion'}
                                </p>
                              </div>
                            )}
                          </div>
                          {cert.lastError && (
                            <div className="col-span-2 p-3 bg-danger-bg border border-danger-line rounded">
                              <p className="text-xs font-semibold text-danger-fg mb-1 flex items-center gap-1">
                                <AlertCircle size={12} /> Fehlermeldung
                              </p>
                              {acmeErrorHint(cert.lastErrorCode) && (
                                <p className="text-sm text-danger-fg mb-2">{acmeErrorHint(cert.lastErrorCode)}</p>
                              )}
                              <pre className="text-xs text-danger-fg whitespace-pre-wrap break-words font-mono leading-relaxed">{cert.lastError}</pre>
                              {cert.type === 'LETSENCRYPT' && canStartAcme(cert) && (
                                <Can area="servers" access="write">
                                  <button type="button" onClick={() => renewMutation.mutate(cert.id)} disabled={renewMutation.isPending}
                                    className="btn-secondary mt-2 flex items-center gap-1.5 text-xs disabled:opacity-40">
                                    <RefreshCw size={13} aria-hidden="true" /> Erneut versuchen
                                  </button>
                                </Can>
                              )}
                            </div>
                          )}
                        </div>
        ) : null}
        toolbar={({ selectedRows, clearSelection }) => (
          <>
            <Can area="servers" access="write">
              <button onClick={() => setModal('letsencrypt')} className="btn-primary flex items-center gap-1.5">
                <Plus size={14} aria-hidden="true" /> Let's Encrypt
              </button>
            </Can>
            <Can area="servers" access="write">
              <button onClick={() => setModal('upload')} className="btn-secondary flex items-center gap-1.5 text-xs">
                <Upload size={13} aria-hidden="true" /> Hochladen
              </button>
            </Can>
            <Can area="servers" access="write">
              <button onClick={() => setModal('selfsigned')} className="btn-secondary flex items-center gap-1.5 text-xs">
                <Plus size={13} aria-hidden="true" /> Self-Signed
              </button>
            </Can>
            <Can area="servers" access="write">
              <button className="btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-40" disabled={selectedRows.length !== 1}
                onClick={() => selectedRows[0] && setEditingCert(selectedRows[0])}>
                <Pencil size={13} aria-hidden="true" /> {t('tb_edit')}
              </button>
            </Can>
            <Can area="servers" access="write">
              <button className="btn-secondary flex items-center gap-1.5 text-xs text-danger-fg disabled:opacity-40" disabled={selectedRows.length !== 1}
                onClick={() => { if (selectedRows[0]) { confirmDelete(selectedRows[0]); clearSelection(); } }}>
                <Trash2 size={13} aria-hidden="true" /> {t('tb_delete')}
              </button>
            </Can>
            <button onClick={() => void refetch()} className="btn-secondary flex items-center gap-1.5 text-xs">
              <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} aria-hidden="true" /> {t('tb_refresh')}
            </button>
          </>
        )}
      />

      {/* Modals — pass certs for exclusivity display */}
      {modal === 'letsencrypt' && <LetsEncryptModal onClose={() => setModal(null)} allCerts={certs} />}
      {modal === 'upload'      && <UploadModal      onClose={() => setModal(null)} allCerts={certs} />}
      {modal === 'selfsigned'  && <SelfSignedModal  onClose={() => setModal(null)} allCerts={certs} />}
      {editingCert && (
        <EditCertModal
          cert={editingCert}
          allCerts={certs}
          onClose={() => setEditingCert(null)}
        />
      )}
    </div>
  );
}

// ── Let's Encrypt Modal ───────────────────────────────────────────────────────

interface AcmeSuggestions {
  publicHostname: string | null;
  domain: string | null;
  sans: Array<{ name: string; resolvesHere: boolean; message: string }>;
  preselectServices: string[];
}

function LetsEncryptModal({ onClose, allCerts }: { onClose: () => void; allCerts: Certificate[] }) {
  const qc = useQueryClient();
  const [name, setName]         = useState('');
  const [domains, setDomains]   = useState('');
  const [email, setEmail]       = useState('');
  const [mail, setMail]         = useState(false);
  const [autoRenew, setAutoRenew] = useState(true);
  const [staging, setStaging]   = useState(false);
  // 9.3: defaults for the public host name — mail services preselected,
  // autodiscover./autoconfig. offered as additional names (on when DNS points here)
  const [extraSans, setExtraSans] = useState<Record<string, boolean>>({});
  const [prefilled, setPrefilled] = useState(false);
  const { data: suggest } = useQuery<AcmeSuggestions>({
    queryKey: ['admin-certificates-acme-suggestions'],
    queryFn: () => api.get<AcmeSuggestions>('/admin/certificates/acme-suggestions'),
    staleTime: 60_000,
  });
  useEffect(() => {
    if (prefilled || !suggest?.publicHostname) return;
    setPrefilled(true);
    setExtraSans(Object.fromEntries(suggest.sans.map(x => [x.name, x.resolvesHere])));
    if (!domains.trim()) {
      setDomains(suggest.publicHostname);
      if (!name.trim()) setName(suggest.publicHostname);
      setMail(hasMailProtocols(suggest.preselectServices));
    }
  }, [suggest, prefilled, domains, name]);
  const baseDomains = parseDomainList(domains);
  const forPublicHost = !!suggest?.publicHostname && baseDomains.includes(suggest.publicHostname);
  const sanOptions = forPublicHost ? (suggest?.sans ?? []).filter(x => !baseDomains.includes(x.name)) : [];
  const allDomains = [...new Set([...baseDomains, ...sanOptions.filter(x => extraSans[x.name]).map(x => x.name)])];

  const mutation = useMutation({
    mutationFn: () => api.post('/admin/certificates/letsencrypt', {
      name,
      domains: allDomains,
      email,
      // staging certificates never serve SMTP/IMAP/POP3 (refused by the server)
      services: mailServicesFor(mail && !staging),
      autoRenew,
      staging,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      toast.success('Let\'s Encrypt Anfrage gestartet');
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || 'Anfrage fehlgeschlagen'),
  });

  // 9.2.x: pre-flight — DNS, CAA, local token serving, public fetch and a real
  // validation by the Let's Encrypt staging environment (no certificate issued).
  const preflight = useMutation({
    mutationFn: () => api.post<PreflightReport>('/admin/certificates/preflight', {
      domains: allDomains,
      external: true,
    }),
    onError: (err: Error) => toast.error(err.message || 'Prüfung fehlgeschlagen'),
  });

  return (
    <Modal title="Let's Encrypt Zertifikat" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name">
          <input value={name} onChange={e => setName(e.target.value)}
            className="input" placeholder="z.B. mail.company.com" />
        </Field>
        <Field label="Domains (eine pro Zeile)">
          <textarea value={domains} onChange={e => setDomains(e.target.value)}
            rows={3} className="input font-mono text-sm"
            placeholder={"mail.company.com\nautodiscover.company.com"} />
          {sanOptions.length > 0 && (
            <fieldset className="mt-2 space-y-1">
              <legend className="text-xs text-fg-subtle mb-1">Zusätzliche Namen für Outlook/Thunderbird (Autodiscover/Autoconfig)</legend>
              {sanOptions.map(x => (
                <label key={x.name} className="flex items-start gap-2 text-sm cursor-pointer select-none">
                  <input type="checkbox" className="rounded mt-0.5" checked={!!extraSans[x.name]}
                    onChange={e => setExtraSans(prev => ({ ...prev, [x.name]: e.target.checked }))} />
                  <span>
                    <span className="font-mono">{x.name}</span>
                    <span className={`block text-xs ${x.resolvesHere ? 'text-fg-subtle' : 'text-warning-fg'}`}>{x.message}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </Field>
        <Field label="E-Mail (für ACME-Konto)">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            className="input" placeholder="admin@company.com" />
        </Field>
        <div>
          <MailProtocolSwitch on={mail} onChange={setMail} allCerts={allCerts} />
          {staging && mail ? (
            <p className="mt-2 text-xs text-warning-fg">Staging-Zertifikate werden nie für SMTP/IMAP/POP3 verwendet — die Dienste werden nicht zugewiesen.</p>
          ) : mail ? (
            <p className="mt-2 text-xs text-fg-subtle">Wird nach der Ausstellung automatisch für SMTP/IMAP/POP3 verwendet.</p>
          ) : null}
        </div>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={autoRenew} onChange={e => setAutoRenew(e.target.checked)}
              className="rounded" />
            Auto-Renew (empfohlen)
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none text-warning-fg">
            <input type="checkbox" checked={staging} onChange={e => setStaging(e.target.checked)}
              className="rounded" />
            Staging-Umgebung (Test)
          </label>
        </div>
        <p className="text-xs text-fg-subtle bg-info-bg border border-info-line rounded p-2">
          <strong>Voraussetzung:</strong> Jede Domain zeigt per DNS auf diesen Server und Port 80 ist aus dem Internet erreichbar, damit Let's Encrypt die Domain prüfen kann.
          {' '}„Voraussetzungen prüfen" testet das vorab (mit einer echten Prüfung durch die Let's Encrypt Staging-Umgebung, ca. 10–60 Sekunden).
        </p>
        {preflight.data && <PreflightResult report={preflight.data} />}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary">Abbrechen</button>
          <button type="button" onClick={() => preflight.mutate()} disabled={preflight.isPending || allDomains.length === 0}
            className="btn-secondary flex items-center gap-1.5">
            {preflight.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}
            Voraussetzungen prüfen
          </button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name || !domains || !email}
            className="btn-primary flex items-center gap-1.5">
            {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
            Zertifikat anfordern
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Pre-flight result ─────────────────────────────────────────────────────────

const CHECK_TONE: Record<CheckStatus, string> = {
  ok:    'text-success-fg',
  warn:  'text-warning-fg',
  error: 'text-danger-fg',
  skip:  'text-fg-subtle',
};

function CheckIcon({ status }: { status: CheckStatus }) {
  if (status === 'ok')    return <CheckCircle2 size={14} className="text-success-fg shrink-0 mt-0.5" aria-label="OK" />;
  if (status === 'warn')  return <AlertTriangle size={14} className="text-warning-fg shrink-0 mt-0.5" aria-label="Warnung" />;
  if (status === 'error') return <XCircle size={14} className="text-danger-fg shrink-0 mt-0.5" aria-label="Fehler" />;
  return <span className="w-3.5 shrink-0 text-center text-fg-subtle" aria-label="Übersprungen">–</span>;
}

function PreflightResult({ report }: { report: PreflightReport }) {
  return (
    <div className="border border-line rounded-lg p-3 space-y-3 text-sm" role="status">
      <p className={`font-semibold ${report.ok ? 'text-success-fg' : 'text-danger-fg'}`}>
        {report.ok ? 'Voraussetzungen erfüllt' : 'Voraussetzungen nicht erfüllt'}
      </p>
      {report.domains.map(d => (
        <div key={d.domain}>
          <p className="font-mono text-xs text-fg mb-1">{d.domain}</p>
          <ul className="space-y-1">
            {d.checks.map(c => (
              <li key={c.id} className="flex items-start gap-2 text-xs">
                <CheckIcon status={c.status} />
                <span className={CHECK_TONE[c.status]}>
                  <span className="font-medium">{CHECK_LABELS[c.id] ?? c.id}:</span> {c.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="flex items-start gap-2 text-xs border-t border-line pt-2">
        <CheckIcon status={report.external.status} />
        <span className={CHECK_TONE[report.external.status]}>
          <span className="font-medium">Externe Prüfung (Let's Encrypt Staging):</span> {report.external.message}
          {acmeErrorHint(report.external.code) && <span className="block mt-1">{acmeErrorHint(report.external.code)}</span>}
        </span>
      </div>
    </div>
  );
}

// ── Upload Modal ──────────────────────────────────────────────────────────────

function UploadModal({ onClose, allCerts }: { onClose: () => void; allCerts: Certificate[] }) {
  const qc = useQueryClient();
  const [name, setName]         = useState('');
  const [domains, setDomains]   = useState('');
  const [mail, setMail]         = useState(false);
  const [certPem, setCertPem]   = useState('');
  const [keyPem, setKeyPem]     = useState('');
  const [chainPem, setChainPem] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.post('/admin/certificates/upload', {
      name,
      domains: domains.split('\n').map(d => d.trim()).filter(Boolean),
      services: mailServicesFor(mail),
      certPem,
      keyPem,
      ...(chainPem.trim() ? { chainPem } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      toast.success('Zertifikat hochgeladen');
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || 'Upload fehlgeschlagen — ungültiges PEM?'),
  });

  return (
    <Modal title="Eigenes Zertifikat hochladen" onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name">
          <input value={name} onChange={e => setName(e.target.value)}
            className="input" placeholder="z.B. Wildcard *.company.com" />
        </Field>
        <Field label="Domains (eine pro Zeile)">
          <textarea value={domains} onChange={e => setDomains(e.target.value)}
            rows={2} className="input font-mono text-sm" placeholder="mail.company.com" />
        </Field>
        <MailProtocolSwitch on={mail} onChange={setMail} allCerts={allCerts} />
        <Field label="Zertifikat (PEM)">
          <textarea value={certPem} onChange={e => setCertPem(e.target.value)}
            rows={5} className="input font-mono text-xs"
            placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"} />
        </Field>
        <Field label="Privater Schlüssel (PEM)">
          <textarea value={keyPem} onChange={e => setKeyPem(e.target.value)}
            rows={5} className="input font-mono text-xs"
            placeholder={"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"} />
        </Field>
        <Field label="Zertifikatskette (optional, PEM)">
          <textarea value={chainPem} onChange={e => setChainPem(e.target.value)}
            rows={3} className="input font-mono text-xs"
            placeholder={"-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary">Abbrechen</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name || !certPem || !keyPem}
            className="btn-primary flex items-center gap-1.5">
            {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
            Hochladen
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Self-Signed Modal ─────────────────────────────────────────────────────────

function SelfSignedModal({ onClose, allCerts }: { onClose: () => void; allCerts: Certificate[] }) {
  const qc = useQueryClient();
  const [name, setName]         = useState('');
  const [domains, setDomains]   = useState('');
  const [mail, setMail]         = useState(false);
  const [days, setDays]         = useState(365);

  const mutation = useMutation({
    mutationFn: () => api.post('/admin/certificates/self-signed', {
      name,
      domains: domains.split('\n').map(d => d.trim()).filter(Boolean),
      services: mailServicesFor(mail),
      days,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      toast.success('Selbstsigniertes Zertifikat generiert');
      onClose();
    },
    onError: (err: Error) => toast.error(err.message || 'Generierung fehlgeschlagen'),
  });

  return (
    <Modal title="Selbstsigniertes Zertifikat generieren" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-warning-fg bg-warning-bg border border-warning-line rounded p-2">
          Selbstsignierte Zertifikate werden von Browsern nicht vertraut. Nur für interne Tests geeignet.
        </p>
        <Field label="Name">
          <input value={name} onChange={e => setName(e.target.value)}
            className="input" placeholder="z.B. Intern-Test" />
        </Field>
        <Field label="Domains (eine pro Zeile)">
          <textarea value={domains} onChange={e => setDomains(e.target.value)}
            rows={2} className="input font-mono text-sm" placeholder="localhost" />
        </Field>
        <MailProtocolSwitch on={mail} onChange={setMail} allCerts={allCerts} />
        <Field label="Gültigkeit (Tage)">
          <input type="number" value={days} onChange={e => setDays(Number(e.target.value))}
            min={1} max={3650} className="input w-32" />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary">Abbrechen</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !name || !domains}
            className="btn-primary flex items-center gap-1.5">
            {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
            Generieren
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Edit Cert Modal ───────────────────────────────────────────────────────────

function EditCertModal({ cert, allCerts, onClose }: {
  cert:     Certificate;
  allCerts: Certificate[];
  onClose:  () => void;
}) {
  const qc = useQueryClient();
  const [name, setName]         = useState(cert.name);
  const [mail, setMail]         = useState(hasMailProtocols(cert.services));
  const [autoRenew, setAutoRenew] = useState(cert.autoRenew);
  const [staging, setStaging] = useState(!!cert.acmeStaging);

  const mutation = useMutation({
    mutationFn: () => api.put<{ protocolApplied?: boolean }>(`/admin/certificates/${cert.id}`, {
      name,
      services: mailServicesFor(mail),
      ...(cert.type === 'LETSENCRYPT' ? { autoRenew, acmeStaging: staging } : {}),
    }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      // 9.3: the assignment is applied right away — re-check what the ports serve
      setTimeout(() => void qc.invalidateQueries({ queryKey: SERVED_CERT_QUERY_KEY }), 2_000);
      toast.success(res?.protocolApplied
        ? 'Gespeichert — SMTP/IMAP/POP3 verwenden jetzt dieses Zertifikat'
        : 'Zertifikat aktualisiert');
      onClose();
    },
    onError: (err: unknown) => {
      const msg = (err as { message?: string })?.message ?? 'Aktualisierung fehlgeschlagen';
      toast.error(msg);
    },
  });

  return (
    <Modal title="Zertifikat bearbeiten" onClose={onClose}>
      <div className="space-y-4">
        {/* Read-only info: type, status, domains */}
        <div className="flex items-center gap-2 flex-wrap">
          <TypeBadge type={cert.type} staging={cert.acmeStaging} />
          <StatusBadge status={cert.status} expiresAt={cert.expiresAt} />
        </div>
        <div>
          <p className="text-xs text-fg-subtle mb-1">Domains (nicht editierbar)</p>
          <div className="flex flex-wrap gap-1">
            {cert.domains.map(d => (
              <span key={d} className="px-2 py-0.5 bg-surface-2 border border-line rounded text-xs font-mono">{d}</span>
            ))}
          </div>
        </div>
        {/* Read-only: activation status */}
        <div className="grid grid-cols-2 gap-3 p-3 bg-surface-2 rounded-lg border border-line text-sm">
          <div>
            <p className="text-xs text-fg-subtle mb-0.5">HTTPS-Proxy (Port 443)</p>
            <p className="flex items-center gap-1">
              {cert.isActiveHttps
                ? <><Lock size={12} className="text-success-fg" /><span className="text-success-fg font-medium">Aktiv</span></>
                : <><LockOpen size={12} className="text-fg-subtle" /><span className="text-fg-subtle">Inaktiv</span></>}
            </p>
          </div>
          <div>
            <p className="text-xs text-fg-subtle mb-0.5">Protokoll-TLS (SMTP/IMAP/POP3)</p>
            <p className="flex items-center gap-1">
              {cert.isActiveProtocol
                ? <><Server size={12} className="text-info-fg" /><span className="text-info-fg font-medium">Aktiv</span></>
                : <><Server size={12} className="text-fg-subtle" /><span className="text-fg-subtle">Inaktiv</span></>}
            </p>
          </div>
        </div>
        {/* Editable fields */}
        <Field label="Name">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="input"
            placeholder="Zertifikat-Name"
          />
        </Field>
        <div>
          <MailProtocolSwitch on={mail} onChange={setMail} allCerts={allCerts} currentCertId={cert.id} />
          <EditServicesHint cert={cert} wantsMail={mail} staging={staging} />
        </div>
        {cert.type === 'LETSENCRYPT' && (
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRenew}
              onChange={e => setAutoRenew(e.target.checked)}
              className="rounded"
            />
            Auto-Renew (automatisch 30 Tage vor Ablauf erneuern)
          </label>
        )}
        {cert.type === 'LETSENCRYPT' && (
          <div>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none text-warning-fg">
              <input
                type="checkbox"
                checked={staging}
                onChange={e => setStaging(e.target.checked)}
                className="rounded"
              />
              Staging-Umgebung (Test)
            </label>
            {staging !== !!cert.acmeStaging && (
              <p className="mt-1 text-xs text-fg-subtle">
                Gilt ab dem nächsten Let's Encrypt-Vorgang — nach dem Speichern „Erneuern" klicken.
              </p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary">Abbrechen</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !name.trim()}
            className="btn-primary flex items-center gap-1.5">
            {mutation.isPending && <Loader2 size={14} className="animate-spin" />}
            Speichern
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * 9.3: honest wording — the services ARE the switch for SMTP/IMAP/POP3
 * (PUT applies the certificate immediately; module level, not inline).
 */
function EditServicesHint({ cert, wantsMail, staging }: { cert: Certificate; wantsMail: boolean; staging: boolean }) {
  const isStaging = cert.type === 'LETSENCRYPT' && staging;
  let text: string | null = null;
  let tone = 'text-info-fg bg-info-bg border-info-line';
  if (wantsMail && isStaging) {
    text = 'Staging-Zertifikate werden nie für SMTP/IMAP/POP3 verwendet — Speichern wird abgelehnt.';
    tone = 'text-danger-fg bg-danger-bg border-danger-line';
  } else if (wantsMail && !cert.isActiveProtocol) {
    text = isCertUsable(cert.status, cert.expiresAt)
      ? 'Wird sofort für SMTP/IMAP/POP3 verwendet (Ports 465/587/993/143/995/110) — das bisherige Zertifikat wird abgelöst.'
      : 'Wird für SMTP/IMAP/POP3 verwendet, sobald das Zertifikat ausgestellt ist.';
  } else if (!wantsMail && cert.isActiveProtocol) {
    text = cert.type === 'SELF_SIGNED'
      ? 'SMTP/IMAP/POP3 brauchen immer ein Zertifikat — bitte die Dienste einem anderen Zertifikat zuweisen.'
      : 'SMTP/IMAP/POP3 wechseln beim Speichern sofort auf das selbstsignierte Standard-Zertifikat.';
    tone = 'text-warning-fg bg-warning-bg border-warning-line';
  }
  if (!text) return null;
  return <p className={`mt-2 text-xs border rounded px-2 py-1 ${tone}`} role="status">{text}</p>;
}

// ── UI-Helpers ────────────────────────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  return (
    <AccessibleModal
      onClose={onClose}
      labelledBy={titleId}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-scrim/40 p-4"
      className="bg-surface rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
    >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id={titleId} className="font-semibold text-fg">{title}</h2>
          <button type="button" onClick={onClose} aria-label={t('action_close')} className="text-fg-subtle hover:text-fg-muted transition-colors">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="p-5">{children}</div>
    </AccessibleModal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-fg-muted mb-1">{label}</label>
      {children}
    </div>
  );
}
