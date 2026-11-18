/**
 * 9.3: what the mail ports (and, since w2b, the integrated HTTPS server) really serve.
 *
 * ServedCertWarning — banner (SSL/TLS page + dashboard) when a mail port serves
 *   a self-signed, name-mismatched or expired certificate, with "Jetzt zuweisen"
 *   (activates the suggested trusted certificate for SMTP/IMAP/POP3); also when
 *   the private key of a certificate in use cannot be read (w1), and when the
 *   integrated HTTPS server serves a wrong certificate (w2b).
 * CertServiceChips  — w2b: per service a certificate holds (SMTP, IMAP, POP3,
 *   HTTPS) a status chip in the certificate overview; the tooltip lists the ports.
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, type LucideIcon } from 'lucide-react';
import { api } from '../api/client.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { Can } from './Can.js';
import {
  certServiceChips, chipLabel, httpsServedProblem, httpsSwitchName, httpsWarningText, mailFixSuggestion, unreadableKeyText,
  warningSummary, type ChipCert, type ChipState, type ServedPort, type ServedReport, type ServiceChip, type UnreadableKeyCert,
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

/** Re-probes the ports shortly after a certificate change (the servers reload within a second). */
export function useRecheckServedSoon(): () => void {
  const qc = useQueryClient();
  return () => { setTimeout(() => void qc.invalidateQueries({ queryKey: SERVED_CERT_QUERY_KEY }), 2_000); };
}

function useAssignSuggested() {
  const qc = useQueryClient();
  const recheck = useRecheckServedSoon();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/certificates/${id}/activate-protocol`),
    onSuccess: () => {
      toast.success('Zertifikat wird jetzt für SMTP/IMAP/POP3 verwendet');
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      recheck();
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
  const https = httpsServedProblem(data);
  return (
    <>
      {unreadable.length > 0 && <UnreadableKeyWarning certs={unreadable} linkToCertificates={linkToCertificates} />}
      {data?.problem && <ServedPortsWarning data={data} linkToCertificates={linkToCertificates} />}
      {data && https && <HttpsServedWarning data={data} https={https} linkToCertificates={linkToCertificates} />}
    </>
  );
}

/** w2b: the integrated HTTPS server serves a self-signed / name-mismatched / expired certificate. */
function HttpsServedWarning({ data, https, linkToCertificates }: { data: ServedReport; https: ServedPort; linkToCertificates: boolean }) {
  return (
    <div className="mb-4 px-4 py-3 bg-warning-bg border border-warning-line rounded-xl flex items-start gap-3 text-sm text-warning-fg" role="alert">
      <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 space-y-1">
        <p>
          <strong>{httpsSwitchName(https.port)} liefert kein passendes Zertifikat für {data.hostname}.</strong>{' '}
          Browser, Outlook und Mobilgeräte warnen oder verbinden sich nicht (Webmail, ActiveSync, Autodiscover, MAPI).
        </p>
        <p className="text-xs">{httpsWarningText(data, https)}</p>
        {data.suggestedCert
          ? <p className="text-xs">Passendes Zertifikat vorhanden: <span className="font-mono">{data.suggestedCert.name}</span> — mit dem Schloss-Schalter in seiner Zeile für HTTPS einschalten.</p>
          : <p className="text-xs">Kein vertrauenswürdiges Zertifikat für {data.hostname} vorhanden — bitte ein Let's Encrypt-Zertifikat anfordern.</p>}
      </div>
      {linkToCertificates && (
        <Link to="/certificates" className="btn-secondary text-xs text-center shrink-0">SSL/TLS öffnen</Link>
      )}
    </div>
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

const CHIP_LOOK: Record<ChipState, { Icon: LucideIcon; className: string }> = {
  ok:      { Icon: CheckCircle2,  className: 'bg-success-bg text-success-fg border-success-line' },
  warning: { Icon: AlertTriangle, className: 'bg-warning-bg text-warning-fg border-warning-line' },
  unknown: { Icon: HelpCircle,    className: 'bg-surface-2 text-fg-muted border-line' },
};

/**
 * One service chip: icon + name (state not by colour alone). The tooltip opens
 * on hover, keyboard focus and click, stays open while hovered, closes with
 * Escape; it is positioned fixed so the scrolling table does not clip it.
 */
function ServiceStatusChip({ chip }: { chip: ServiceChip }) {
  const tipId = useId();
  const chipRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const open = () => {
    const r = chipRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom, left: r.left });
  };
  const close = () => setPos(null);

  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPos(null); };
    const onScroll = () => setPos(null);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [pos]);

  const { Icon, className } = CHIP_LOOK[chip.state];
  return (
    <span className="inline-flex" onMouseEnter={open} onMouseLeave={close}>
      <button ref={chipRef} type="button" aria-label={chipLabel(chip)} aria-describedby={tipId}
        onFocus={open} onBlur={close} onClick={open}
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg ${className}`}>
        <Icon size={12} aria-hidden="true" />
        {chip.service}
      </button>
      {/* pt-1: the gap below the chip belongs to the tooltip, so it stays open while the pointer moves onto it */}
      <div id={tipId} role="tooltip" hidden={!pos} style={pos ?? undefined} className="fixed z-50 pt-1">
        <div className="max-w-sm px-3 py-2 bg-surface border border-line rounded-lg shadow-lg text-xs text-fg text-left">
          <p className="font-semibold mb-1">{chipLabel(chip)}</p>
          <ul className="space-y-0.5">
            {chip.details.map((d) => <li key={d}>{d}</li>)}
          </ul>
        </div>
      </div>
    </span>
  );
}

/**
 * The services column of a certificate row: a chip per held service from the
 * served-certificate probe, plus "Jetzt zuweisen" when a mail protocol does not
 * serve a trusted, matching certificate and a suitable one exists.
 */
export function CertServiceChips({ cert }: { cert: ChipCert }) {
  const { can } = usePermissions();
  const { data } = useServedCert(can('servers', 'read'));
  const assign = useAssignSuggested();
  const chips = certServiceChips(cert, data);
  if (chips.length === 0) return <span className="text-xs text-fg-subtle">–</span>;
  const fix = mailFixSuggestion(chips, data);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips.map((c) => <ServiceStatusChip key={c.service} chip={c} />)}
      {fix && (
        <Can area="servers" access="write">
          <button type="button" className="btn-secondary text-xs flex items-center gap-1 disabled:opacity-40"
            aria-label={`Jetzt zuweisen: „${fix.name}“ für SMTP/IMAP/POP3 verwenden`}
            title={`„${fix.name}“ für SMTP/IMAP/POP3 verwenden`}
            disabled={assign.isPending} onClick={() => assign.mutate(fix.id)}>
            {assign.isPending && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
            Jetzt zuweisen
          </button>
        </Can>
      )}
    </div>
  );
}
