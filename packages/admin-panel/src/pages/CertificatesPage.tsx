/**
 * SSL/TLS Zertifikat-Verwaltung
 *
 * Listet alle Zertifikate, ermöglicht:
 * - Let's Encrypt (ACME HTTP-01) anfordern
 * - Eigenes Zertifikat hochladen (PEM)
 * - Selbstsigniertes Zertifikat generieren
 * - Zertifikat erneuern / löschen
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ShieldCheck, Plus, RefreshCw, Trash2, Upload,
  ChevronDown, ChevronUp, X, Loader2, AlertCircle,
  Lock, LockOpen, Server,
} from 'lucide-react';
import { api } from '../api/client.js';

// ── Typen ─────────────────────────────────────────────────────────────────────

type CertType   = 'LETSENCRYPT' | 'CUSTOM' | 'SELF_SIGNED';
type CertStatus = 'PENDING' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'ERROR' | 'RENEWING';

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
  lastError:        string | null;
  createdAt:        string;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

function StatusBadge({ status, expiresAt }: { status: CertStatus; expiresAt: string | null }) {
  const days = daysUntil(expiresAt);
  const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold';
  if (status === 'ACTIVE')   return <span className={`${base} bg-green-100 text-green-700`}>Aktiv{days !== null ? ` · ${days}d` : ''}</span>;
  if (status === 'EXPIRING') return <span className={`${base} bg-amber-100 text-amber-700`}>Läuft ab · {days}d</span>;
  if (status === 'EXPIRED')  return <span className={`${base} bg-red-100 text-red-700`}>Abgelaufen</span>;
  if (status === 'PENDING')  return <span className={`${base} bg-blue-100 text-blue-700`}><Loader2 size={10} className="animate-spin" /> Ausstehend</span>;
  if (status === 'RENEWING') return <span className={`${base} bg-blue-100 text-blue-700`}><Loader2 size={10} className="animate-spin" /> Erneuerung</span>;
  if (status === 'ERROR')    return <span className={`${base} bg-red-100 text-red-700`}><AlertCircle size={10} /> Fehler</span>;
  return <span className={`${base} bg-gray-100 text-gray-600`}>{status}</span>;
}

function TypeBadge({ type }: { type: CertType }) {
  const base = 'px-2 py-0.5 rounded text-xs font-medium';
  if (type === 'LETSENCRYPT') return <span className={`${base} bg-purple-100 text-purple-700`}>Let's Encrypt</span>;
  if (type === 'CUSTOM')      return <span className={`${base} bg-indigo-100 text-indigo-700`}>Eigenes</span>;
  return <span className={`${base} bg-gray-100 text-gray-600`}>Self-Signed</span>;
}

const ALL_SERVICES = ['MWA', 'BCP', 'SMTP', 'IMAP', 'POP3', 'EWS', 'CALDAV', 'AUTODISCOVER'];

// Farbgebung je Service-Gruppe
const SERVICE_COLORS: Record<string, string> = {
  MWA:         'bg-blue-100 text-blue-700',
  BCP:         'bg-blue-100 text-blue-700',
  SMTP:        'bg-green-100 text-green-700',
  IMAP:        'bg-green-100 text-green-700',
  POP3:        'bg-green-100 text-green-700',
  EWS:         'bg-gray-100 text-gray-600',
  CALDAV:      'bg-gray-100 text-gray-600',
  AUTODISCOVER:'bg-gray-100 text-gray-600',
};

function ServiceSelector({
  selected, onChange,
}: { selected: string[]; onChange: (s: string[]) => void }) {
  function toggle(svc: string) {
    onChange(selected.includes(svc) ? selected.filter(s => s !== svc) : [...selected, svc]);
  }
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {ALL_SERVICES.map(svc => (
          <button
            key={svc}
            type="button"
            onClick={() => toggle(svc)}
            className={`px-2 py-1 rounded text-xs font-medium border transition-colors ${
              selected.includes(svc)
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-white border-gray-300 text-gray-600 hover:border-blue-400'
            }`}>
            {svc}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-400">
        Nur zur Dokumentation — die Aktivierung (Schloss-Symbol) entscheidet über den tatsächlichen Einsatz.
      </p>
    </div>
  );
}

// ── Modal-Typen ───────────────────────────────────────────────────────────────

type ModalMode = 'letsencrypt' | 'upload' | 'selfsigned' | null;

// ── TLS-Proxy-Status-Typen ────────────────────────────────────────────────────

interface TlsProxyInfo {
  port:       number;
  activeCert: { id: string; name: string; domains: string[]; status: string } | null;
}

// ── Haupt-Komponente ──────────────────────────────────────────────────────────

export function CertificatesPage() {
  const qc = useQueryClient();
  const [modal, setModal] = useState<ModalMode>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data: certs = [], isLoading } = useQuery<Certificate[]>({
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
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-certificates'] }); toast.success('Erneuerung gestartet'); },
    onError: () => toast.error('Erneuerung fehlgeschlagen'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/certificates/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-certificates'] }); toast.success('Zertifikat gelöscht'); },
    onError: () => toast.error('Löschen fehlgeschlagen'),
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
      toast.success('Protokoll-TLS aktiviert — SMTP/IMAP/POP3 laden neu');
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
    onError: () => toast.error('Deaktivierung fehlgeschlagen'),
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


  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ShieldCheck size={22} className="text-blue-600" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">SSL/TLS Zertifikate</h1>
            <p className="text-sm text-gray-500">{certs.length} Zertifikat{certs.length !== 1 ? 'e' : ''}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setModal('selfsigned')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors">
            <Plus size={14} /> Self-Signed
          </button>
          <button
            onClick={() => setModal('upload')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors">
            <Upload size={14} /> Hochladen
          </button>
          <button
            onClick={() => setModal('letsencrypt')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium">
            <Plus size={14} /> Let's Encrypt
          </button>
        </div>
      </div>

      {/* HTTPS-Status-Banner — zwei Zustände */}
      {tlsInfo?.activeCert ? (
        /* ── HTTPS aktiv ── */
        <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
          <Lock size={16} className="text-green-600 shrink-0" />
          <span>
            <strong>HTTPS aktiv</strong> — Port {tlsInfo.port} verwendet{' '}
            <span className="font-mono font-medium">{tlsInfo.activeCert.name}</span>
            {tlsInfo.activeCert.domains[0] && (
              <> für <span className="font-mono">{tlsInfo.activeCert.domains[0]}</span></>
            )}
            {' '}· Zum Deaktivieren: grünes Schloss-Symbol klicken.
          </span>
        </div>
      ) : (
        /* ── Kein HTTPS-Zertifikat aktiv ── */
        <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-500">
          <LockOpen size={16} className="shrink-0" />
          <span>
            Kein HTTPS-Zertifikat aktiv —{' '}
            <LockOpen size={12} className="inline mb-0.5" /> <strong>Schloss:</strong>{' '}
            HTTPS (Port {tlsInfo?.port ?? 443}) aktivieren.{' '}
            <Server size={12} className="inline mb-0.5" /> <strong>Server:</strong>{' '}
            Protokoll-TLS für SMTP/IMAP/POP3 (unabhängig von HTTPS).
          </span>
        </div>
      )}

      {/* Tabelle */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <Loader2 size={24} className="animate-spin mr-2" /> Lade Zertifikate…
          </div>
        ) : certs.length === 0 ? (
          <div className="text-center py-16 text-gray-400">
            <ShieldCheck size={32} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm">Noch keine Zertifikate. Erstelle dein erstes Zertifikat.</p>
          </div>
        ) : (
          <>
            {/* Status-Banner: PENDING/RENEWING */}
            {certs.some(c => c.status === 'PENDING' || c.status === 'RENEWING') && (
              <div className="px-4 py-3 bg-blue-50 border-b border-blue-100 flex items-center gap-2 text-sm text-blue-700">
                <Loader2 size={14} className="animate-spin shrink-0" />
                <span>ACME-Prozess läuft… Let's Encrypt verifiziert die Domain über <strong>Port 80</strong> (<code className="font-mono text-xs bg-blue-100 px-1 rounded">/.well-known/acme-challenge/</code>). Das dauert 1–3 Minuten.</span>
              </div>
            )}
            {/* Status-Banner: ERROR */}
            {certs.some(c => c.status === 'ERROR') && (
              <div className="px-4 py-3 bg-red-50 border-b border-red-200 flex items-start gap-2 text-sm text-red-700">
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>
                  <strong>Zertifikat fehlgeschlagen.</strong> Häufigste Ursache: <strong>Port 80</strong> muss öffentlich erreichbar sein (ACME HTTP-01 Challenge).
                  {' '}Details: Zeile aufklappen (<ChevronDown size={12} className="inline mb-0.5" />).
                </span>
              </div>
            )}
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name / Domains</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Typ</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Services</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {certs.map(cert => (
                <>
                  <tr key={cert.id} className="hover:bg-gray-50 transition-colors">
                    {/* Name + Domains */}
                    <td className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <button
                          onClick={() => setExpandedId(expandedId === cert.id ? null : cert.id)}
                          className="mt-0.5 text-gray-400 hover:text-gray-600 transition-colors shrink-0">
                          {expandedId === cert.id ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                        <div>
                          <p className="font-medium text-gray-900 text-sm">{cert.name}</p>
                          <p className="text-xs text-gray-400 mt-0.5">{cert.domains.slice(0, 2).join(', ')}{cert.domains.length > 2 ? ` +${cert.domains.length - 2}` : ''}</p>
                        </div>
                      </div>
                    </td>
                    {/* Typ */}
                    <td className="px-4 py-3">
                      <TypeBadge type={cert.type} />
                    </td>
                    {/* Status */}
                    <td className="px-4 py-3">
                      <StatusBadge status={cert.status} expiresAt={cert.expiresAt} />
                    </td>
                    {/* Services */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {cert.services.length === 0
                          ? <span className="text-xs text-gray-400">–</span>
                          : cert.services.map(s => (
                              <span key={s} className={`px-1.5 py-0.5 rounded text-xs font-medium ${SERVICE_COLORS[s] ?? 'bg-gray-100 text-gray-600'}`}>{s}</span>
                            ))
                        }
                      </div>
                    </td>
                    {/* Aktionen */}
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* ── HTTPS-Proxy Schloss ── */}
                        {cert.isActiveHttps ? (
                          <button
                            onClick={() => deactivateHttpsMutation.mutate(cert.id)}
                            disabled={deactivateHttpsMutation.isPending}
                            title="HTTPS-Proxy deaktivieren"
                            className="p-1.5 text-green-600 hover:text-gray-500 hover:bg-gray-50 rounded transition-colors disabled:opacity-40">
                            <Lock size={14} />
                          </button>
                        ) : (cert.status === 'ACTIVE' || cert.status === 'EXPIRING') ? (
                          <button
                            onClick={() => activateHttpsMutation.mutate(cert.id)}
                            disabled={activateHttpsMutation.isPending}
                            title="HTTPS-Proxy (Port 443) aktivieren"
                            className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded transition-colors disabled:opacity-40">
                            <LockOpen size={14} />
                          </button>
                        ) : null}
                        {/* ── Protokoll-TLS (SMTP/IMAP/POP3) — unabhängig von HTTPS ── */}
                        {cert.isActiveProtocol ? (
                          <span title="SMTP/IMAP/POP3 nutzen dieses Cert" className="p-1.5 text-blue-500 cursor-default">
                            <Server size={14} />
                          </span>
                        ) : (cert.status === 'ACTIVE' || cert.status === 'EXPIRING') ? (
                          <button
                            onClick={() => activateProtocolMutation.mutate(cert.id)}
                            disabled={activateProtocolMutation.isPending}
                            title="Protokoll-TLS aktivieren (SMTP/IMAP/POP3)"
                            className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors disabled:opacity-40">
                            <Server size={14} />
                          </button>
                        ) : null}
                        {cert.type === 'LETSENCRYPT' && (
                          <button
                            onClick={() => renewMutation.mutate(cert.id)}
                            disabled={cert.status === 'RENEWING'}
                            title="Jetzt erneuern"
                            className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors disabled:opacity-40">
                            <RefreshCw size={14} className={cert.status === 'RENEWING' ? 'animate-spin' : ''} />
                          </button>
                        )}
                        <button
                          onClick={() => confirmDelete(cert)}
                          title="Löschen"
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {/* Aufgeklappte Detailzeile */}
                  {expandedId === cert.id && (
                    <tr key={`${cert.id}-detail`} className="bg-blue-50/40">
                      <td colSpan={5} className="px-4 py-3">
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <p className="text-xs text-gray-500 mb-1">Alle Domains</p>
                            <div className="flex flex-wrap gap-1">
                              {cert.domains.map(d => (
                                <span key={d} className="px-2 py-0.5 bg-white border border-gray-200 rounded text-xs font-mono">{d}</span>
                              ))}
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <p className="text-xs text-gray-500">Ausgestellt</p>
                              <p className="text-gray-700">{cert.issuedAt ? new Date(cert.issuedAt).toLocaleDateString('de-DE') : '–'}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Läuft ab</p>
                              <p className="text-gray-700">{cert.expiresAt ? new Date(cert.expiresAt).toLocaleDateString('de-DE') : '–'}</p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Auto-Renew</p>
                              <p className="text-gray-700">{cert.autoRenew ? 'Ja' : 'Nein'}</p>
                            </div>
                            {/* HTTPS-Proxy Status */}
                            <div>
                              <p className="text-xs text-gray-500">HTTPS-Proxy (Port 443)</p>
                              <p className="flex items-center gap-1 text-gray-700">
                                {cert.isActiveHttps
                                  ? <><Lock size={12} className="text-green-600" /> <span className="text-green-700 font-medium">Aktiv</span></>
                                  : <><LockOpen size={12} className="text-gray-400" /> <span className="text-gray-400">Inaktiv</span></>
                                }
                              </p>
                            </div>
                            {/* Protokoll-TLS Status — unabhängig von HTTPS-Proxy */}
                            <div>
                              <p className="text-xs text-gray-500">Protokoll-TLS (SMTP/IMAP/POP3)</p>
                              <p className="flex items-center gap-1 text-gray-700">
                                {cert.isActiveProtocol
                                  ? <><Server size={12} className="text-green-600" /> <span className="text-green-700 font-medium">Aktiv (465 / 993 / 995)</span></>
                                  : <><Server size={12} className="text-gray-400" /> <span className="text-gray-400">Inaktiv</span></>
                                }
                              </p>
                            </div>
                            {cert.acmeEmail && (
                              <div>
                                <p className="text-xs text-gray-500">ACME E-Mail</p>
                                <p className="text-gray-700">{cert.acmeEmail}</p>
                              </div>
                            )}
                          </div>
                          {cert.lastError && (
                            <div className="col-span-2 p-3 bg-red-50 border border-red-200 rounded">
                              <p className="text-xs font-semibold text-red-700 mb-1 flex items-center gap-1">
                                <AlertCircle size={12} /> Fehlermeldung
                              </p>
                              <pre className="text-xs text-red-700 whitespace-pre-wrap break-words font-mono leading-relaxed">{cert.lastError}</pre>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
          </>
        )}
      </div>

      {/* Modals */}
      {modal === 'letsencrypt' && <LetsEncryptModal onClose={() => setModal(null)} />}
      {modal === 'upload'      && <UploadModal      onClose={() => setModal(null)} />}
      {modal === 'selfsigned'  && <SelfSignedModal  onClose={() => setModal(null)} />}
    </div>
  );
}

// ── Let's Encrypt Modal ───────────────────────────────────────────────────────

function LetsEncryptModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName]         = useState('');
  const [domains, setDomains]   = useState('');
  const [email, setEmail]       = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [autoRenew, setAutoRenew] = useState(true);
  const [staging, setStaging]   = useState(false);

  const mutation = useMutation({
    mutationFn: () => api.post('/admin/certificates/letsencrypt', {
      name,
      domains: domains.split('\n').map(d => d.trim()).filter(Boolean),
      email,
      services,
      autoRenew,
      staging,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      toast.success('Let\'s Encrypt Anfrage gestartet');
      onClose();
    },
    onError: () => toast.error('Anfrage fehlgeschlagen'),
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
        </Field>
        <Field label="E-Mail (für ACME-Konto)">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            className="input" placeholder="admin@company.com" />
        </Field>
        <Field label="Services">
          <ServiceSelector selected={services} onChange={setServices} />
        </Field>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={autoRenew} onChange={e => setAutoRenew(e.target.checked)}
              className="rounded" />
            Auto-Renew (empfohlen)
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none text-amber-700">
            <input type="checkbox" checked={staging} onChange={e => setStaging(e.target.checked)}
              className="rounded" />
            Staging-Umgebung (Test)
          </label>
        </div>
        <p className="text-xs text-gray-500 bg-blue-50 border border-blue-200 rounded p-2">
          <strong>Voraussetzung:</strong> Port 80 muss öffentlich erreichbar sein, damit Let's Encrypt den ACME HTTP-01 Challenge verifizieren kann.
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-secondary">Abbrechen</button>
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

// ── Upload Modal ──────────────────────────────────────────────────────────────

function UploadModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName]         = useState('');
  const [domains, setDomains]   = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [certPem, setCertPem]   = useState('');
  const [keyPem, setKeyPem]     = useState('');
  const [chainPem, setChainPem] = useState('');

  const mutation = useMutation({
    mutationFn: () => api.post('/admin/certificates/upload', {
      name,
      domains: domains.split('\n').map(d => d.trim()).filter(Boolean),
      services,
      certPem,
      keyPem,
      ...(chainPem.trim() ? { chainPem } : {}),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      toast.success('Zertifikat hochgeladen');
      onClose();
    },
    onError: () => toast.error('Upload fehlgeschlagen — ungültiges PEM?'),
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
        <Field label="Services">
          <ServiceSelector selected={services} onChange={setServices} />
        </Field>
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

function SelfSignedModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName]         = useState('');
  const [domains, setDomains]   = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [days, setDays]         = useState(365);

  const mutation = useMutation({
    mutationFn: () => api.post('/admin/certificates/self-signed', {
      name,
      domains: domains.split('\n').map(d => d.trim()).filter(Boolean),
      services,
      days,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      toast.success('Selbstsigniertes Zertifikat generiert');
      onClose();
    },
    onError: () => toast.error('Generierung fehlgeschlagen'),
  });

  return (
    <Modal title="Selbstsigniertes Zertifikat generieren" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
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
        <Field label="Services">
          <ServiceSelector selected={services} onChange={setServices} />
        </Field>
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

// ── UI-Helpers ────────────────────────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}
