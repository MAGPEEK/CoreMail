/**
 * 9.3: what the mail ports really serve.
 *
 * ServedCertWarning — banner (SSL/TLS page + dashboard) when a mail port serves
 *   a self-signed, name-mismatched or expired certificate, with "Jetzt zuweisen"
 *   (activates the suggested trusted certificate for SMTP/IMAP/POP3); also when
 *   the private key of a certificate in use cannot be read (w1).
 * ServedCertTable  — per port: served certificate, issuer, expiry, status.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { api } from '../api/client.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { Can } from './Can.js';
import {
  portLabel, problemText, unreadableKeyText, warningSummary, type ServedReport, type UnreadableKeyCert,
} from '../lib/servedCert.js';

export const SERVED_CERT_QUERY_KEY = ['admin-certificates-served'] as const;

export function useServedCert(enabled = true) {
  return useQuery<ServedReport>({
    queryKey: SERVED_CERT_QUERY_KEY,
    queryFn: () => api.get<ServedReport>('/admin/certificates/served'),
    refetchInterval: 60_000,
    enabled,
  });
}

function useAssignSuggested() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/certificates/${id}/activate-protocol`),
    onSuccess: () => {
      toast.success('Zertifikat wird jetzt für SMTP/IMAP/POP3 verwendet');
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      // the servers reload within a second — check the ports again shortly after
      setTimeout(() => void qc.invalidateQueries({ queryKey: SERVED_CERT_QUERY_KEY }), 2_000);
    },
    onError: (err: unknown) => toast.error((err as { message?: string })?.message ?? 'Zuweisung fehlgeschlagen'),
  });
}

/** Certificates in use whose private key cannot be read (mail ports serve the self-signed replacement). */
function UnreadableKeyWarning({ certs, linkToCertificates }: { certs: UnreadableKeyCert[]; linkToCertificates: boolean }) {
  return (
    <div className="mb-4 px-4 py-3 bg-warning-bg border border-warning-line rounded-xl flex items-start gap-3 text-sm text-warning-fg" role="alert">
      <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <ul className="flex-1 space-y-1">
        {certs.map((c) => <li key={c.id}><strong>{unreadableKeyText(c)}</strong></li>)}
      </ul>
      {linkToCertificates && (
        <Link to="/certificates" className="btn-secondary text-xs text-center shrink-0">SSL/TLS öffnen</Link>
      )}
    </div>
  );
}

/** Warning banners; render nothing while every mail port serves a matching, trusted name and every key is readable. */
export function ServedCertWarning({ linkToCertificates = false }: { linkToCertificates?: boolean }) {
  const { can } = usePermissions();
  const { data } = useServedCert(can('servers', 'read'));
  const unreadable = data?.unreadableKeys ?? [];
  return (
    <>
      {unreadable.length > 0 && <UnreadableKeyWarning certs={unreadable} linkToCertificates={linkToCertificates} />}
      {data?.problem && <ServedPortsWarning data={data} linkToCertificates={linkToCertificates} />}
    </>
  );
}

/** A mail port serves a self-signed / name-mismatched / expired certificate ("Jetzt zuweisen"). */
function ServedPortsWarning({ data, linkToCertificates }: { data: ServedReport; linkToCertificates: boolean }) {
  const assign = useAssignSuggested();
  return (
    <div className="mb-4 px-4 py-3 bg-warning-bg border border-warning-line rounded-xl flex items-start gap-3 text-sm text-warning-fg" role="alert">
      <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 space-y-1">
        <p>
          <strong>Mail-Ports liefern kein passendes Zertifikat für {data.hostname}.</strong>{' '}
          Mail-Programme (Outlook, iPhone) melden „Zertifikat unbekannt“ und verbinden sich nicht.
        </p>
        <p className="text-xs">{warningSummary(data)}</p>
        {data.suggestedCert
          ? <p className="text-xs">Passendes Zertifikat vorhanden: <span className="font-mono">{data.suggestedCert.name}</span></p>
          : <p className="text-xs">Kein vertrauenswürdiges Zertifikat für {data.hostname} vorhanden — bitte ein Let's Encrypt-Zertifikat anfordern.</p>}
      </div>
      <div className="flex flex-col gap-1.5 shrink-0">
        {data.suggestedCert && (
          <Can area="servers" access="write">
            <button type="button" className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-40"
              disabled={assign.isPending} onClick={() => assign.mutate(data.suggestedCert!.id)}>
              {assign.isPending && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
              Jetzt zuweisen
            </button>
          </Can>
        )}
        {linkToCertificates && (
          <Link to="/certificates" className="btn-secondary text-xs text-center">SSL/TLS öffnen</Link>
        )}
      </div>
    </div>
  );
}

/** Per mail port: the certificate actually served (subject, issuer, expiry, status). */
export function ServedCertTable() {
  const qc = useQueryClient();
  const { data, isLoading, isFetching } = useServedCert();
  return (
    <section className="mb-6 border border-line rounded-xl overflow-hidden" aria-labelledby="served-cert-title">
      <div className="flex items-center justify-between px-4 py-2 bg-surface-2 border-b border-line">
        <h2 id="served-cert-title" className="text-sm font-semibold text-fg">
          Tatsächlich ausgeliefert (Mail-Ports{data ? `, SNI ${data.hostname}` : ''})
        </h2>
        <button type="button" className="btn-secondary text-xs flex items-center gap-1.5"
          onClick={() => void qc.invalidateQueries({ queryKey: SERVED_CERT_QUERY_KEY })}>
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} aria-hidden="true" /> Prüfen
        </button>
      </div>
      {isLoading ? (
        <p className="px-4 py-3 text-sm text-fg-subtle flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Verbinde mit den Mail-Ports…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-fg-subtle">
                <th scope="col" className="px-4 py-2 font-medium">Port</th>
                <th scope="col" className="px-4 py-2 font-medium">Zertifikat</th>
                <th scope="col" className="px-4 py-2 font-medium">Aussteller</th>
                <th scope="col" className="px-4 py-2 font-medium">Gültig bis</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {(data?.ports ?? []).map((p) => (
                <tr key={`${p.protocol}-${p.port}`} className="border-t border-line">
                  <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{portLabel(p)}</td>
                  <td className="px-4 py-2 text-xs">
                    {p.cert ? <>
                      <span className="font-mono">{p.cert.commonName ?? p.cert.subject}</span>
                      {p.certName && <span className="block text-fg-subtle">{p.certName}</span>}
                    </> : <span className="text-fg-subtle">–</span>}
                  </td>
                  <td className="px-4 py-2 text-xs text-fg-muted">{p.cert ? (p.cert.selfSigned ? 'selbstsigniert' : p.cert.issuer.replace(/^.*CN=/, '')) : '–'}</td>
                  <td className="px-4 py-2 text-xs text-fg-muted whitespace-nowrap">{p.cert ? new Date(p.cert.validTo).toLocaleDateString('de-DE') : '–'}</td>
                  <td className="px-4 py-2 text-xs">
                    {!p.ok
                      ? <span className="inline-flex items-center gap-1 text-fg-subtle"><XCircle size={12} aria-hidden="true" /> {p.error ?? 'nicht erreichbar'}</span>
                      : p.problem
                        ? <span className="inline-flex items-center gap-1 text-warning-fg"><AlertTriangle size={12} aria-hidden="true" /> {problemText(p.problem, data?.hostname ?? '')}</span>
                        : <span className="inline-flex items-center gap-1 text-success-fg"><CheckCircle2 size={12} aria-hidden="true" /> OK</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
