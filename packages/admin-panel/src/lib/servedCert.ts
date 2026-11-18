/**
 * 9.3: the certificate each mail port really serves (GET /admin/certificates/served)
 * — pure helpers for the SSL/TLS page and the dashboard warning (unit-tested).
 * w2b: per-service status chips for the certificate overview (certServiceChips)
 * and the labels of the HTTPS / mail-protocol switches.
 */
import { MAIL_PROTOCOLS, MAIL_PROTOCOLS_LABEL } from './mailProtocols.ts';

export type ServedProblem = 'self-signed' | 'hostname-mismatch' | 'expired' | null;

export interface ServedCertInfo {
  subject: string;
  issuer: string;
  commonName: string | null;
  altNames: string[];
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  selfSigned: boolean;
  hostnameMatch: boolean;
  trusted: boolean;
  trustError: string | null;
  expired: boolean;
}

export interface ServedPort {
  /** 'https' = the integrated HTTPS server (ServedReport.https). */
  protocol: 'smtp' | 'imap' | 'pop3' | 'https';
  port: number;
  implicitTls: boolean;
  mode: 'tls' | 'starttls';
  ok: boolean;
  error?: string;
  cert?: ServedCertInfo;
  problem: ServedProblem;
  certId: string | null;
  certName: string | null;
}

/** A certificate in use whose stored private key cannot be read (w1). */
export interface UnreadableKeyCert {
  id: string;
  name: string;
  /** SMTP/IMAP/POP3 it is assigned to. */
  services: string[];
  /** It is the active HTTPS certificate. */
  https: boolean;
}

export interface ServedReport {
  hostname: string;
  ports: ServedPort[];
  problem: boolean;
  suggestedCert: { id: string; name: string } | null;
  /** Absent on servers before w1. */
  unreadableKeys?: UnreadableKeyCert[];
  /** The integrated HTTPS server; null while it does not listen, absent on servers before w2b. */
  https?: ServedPort | null;
}

/** "IMAP 993 (TLS)" / "SMTP 587 (STARTTLS)". */
export function portLabel(p: Pick<ServedPort, 'protocol' | 'port' | 'mode'>): string {
  return `${p.protocol.toUpperCase()} ${p.port} (${p.mode === 'tls' ? 'TLS' : 'STARTTLS'})`;
}

export function problemText(problem: ServedProblem, hostname: string): string {
  switch (problem) {
    case 'self-signed':       return 'selbstsigniert — Outlook/iPhone vertrauen diesem Zertifikat nicht';
    case 'hostname-mismatch': return `passt nicht zu ${hostname}`;
    case 'expired':           return 'abgelaufen';
    default:                  return 'OK';
  }
}

/** Ports with a problem, in display order. */
export function problemPorts(report: ServedReport | null | undefined): ServedPort[] {
  return (report?.ports ?? []).filter((p) => p.problem !== null);
}

/** One line for the warning banner: "IMAP 993 (TLS), SMTP 465 (TLS): selbstsigniert (CN=mail.localhost)". */
export function warningSummary(report: ServedReport): string {
  const groups = new Map<string, ServedPort[]>();
  for (const p of problemPorts(report)) {
    const key = `${p.problem}|${p.cert?.commonName ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.values()].map((ports) => {
    const first = ports[0]!;
    const cn = first.cert?.commonName ? ` (CN=${first.cert.commonName})` : '';
    return `${ports.map(portLabel).join(', ')}: ${problemText(first.problem, report.hostname)}${cn}`;
  }).join(' · ');
}

/**
 * Warning line for a certificate whose private key cannot be read: the mail
 * protocols serve the self-signed replacement, HTTPS skips the certificate.
 */
export function unreadableKeyText(c: UnreadableKeyCert): string {
  const effects = [
    ...(c.services.length > 0 ? ['Mail-Protokolle nutzen das selbstsignierte Ersatzzertifikat'] : []),
    ...(c.https ? ['HTTPS liefert es nicht aus'] : []),
  ];
  return `Privater Schlüssel von ${c.name} nicht lesbar — ${effects.join(', ') || 'das Zertifikat wird nicht verwendet'}; Zertifikat neu ausstellen oder hochladen`;
}

// ── w2b: per-service status chips in the certificate overview ────────────────

export type CertService = (typeof MAIL_PROTOCOLS)[number] | 'HTTPS';
export type ChipState = 'ok' | 'warning' | 'unknown';

export interface ServiceChip {
  service: CertService;
  state: ChipState;
  /** Tooltip lines: one per probed port, or why nothing could be checked. */
  details: string[];
}

/** The fields of a certificate row the chips need. */
export interface ChipCert {
  id: string;
  services: readonly string[];
  isActiveHttps: boolean;
}

type PortVerdict = 'ok' | 'problem' | 'other' | 'unreachable';

function portVerdict(p: ServedPort, certId: string): PortVerdict {
  if (!p.ok) return 'unreachable';
  if (p.problem) return 'problem';
  return p.certId === certId ? 'ok' : 'other';
}

function servedName(p: ServedPort): string {
  if (p.certName) return `„${p.certName}“`;
  return p.cert?.commonName ? `CN=${p.cert.commonName}` : 'unbekannt';
}

function portDetail(p: ServedPort, verdict: PortVerdict, hostname: string): string {
  const label = portLabel(p);
  switch (verdict) {
    case 'unreachable': return `${label}: nicht erreichbar (${p.error ?? 'keine Antwort'})`;
    case 'problem':     return `${label}: ${problemText(p.problem, hostname)} (${servedName(p)})`;
    case 'other':       return `${label}: liefert ein anderes Zertifikat (${servedName(p)})`;
    default:            return `${label}: liefert dieses Zertifikat`;
  }
}

/**
 * Chip for one service from its probed ports: any port serving a self-signed,
 * mismatched, expired or another certificate = warning; unreachable ports are
 * listed but do not decide the state (as in the warning banner).
 */
function chipFromPorts(service: CertService, ports: ServedPort[], certId: string, hostname: string): ServiceChip {
  if (ports.length === 0) return { service, state: 'unknown', details: ['Kein aktiver Port gefunden'] };
  const verdicts = ports.map((p) => portVerdict(p, certId));
  const details = ports.map((p, i) => portDetail(p, verdicts[i]!, hostname));
  const state: ChipState = verdicts.some((v) => v === 'problem' || v === 'other') ? 'warning'
    : verdicts.includes('ok') ? 'ok'
    : 'unknown';
  return { service, state, details };
}

function httpsChip(certId: string, report: ServedReport): ServiceChip {
  if (report.https === undefined) return { service: 'HTTPS', state: 'unknown', details: ['Nicht geprüft'] };
  if (report.https === null) {
    return {
      service: 'HTTPS', state: 'warning',
      details: ['Der integrierte HTTPS-Server läuft nicht (Port belegt oder Zertifikat nicht ladbar)'],
    };
  }
  return chipFromPorts('HTTPS', [report.https], certId, report.hostname);
}

/**
 * Status chips for the services a certificate holds — SMTP/IMAP/POP3 from its
 * services, HTTPS when it is the active HTTPS certificate — derived from what
 * the ports really serve. Without a report every chip is "unknown".
 */
export function certServiceChips(cert: ChipCert, report: ServedReport | null | undefined): ServiceChip[] {
  const services: CertService[] = [
    ...MAIL_PROTOCOLS.filter((s) => cert.services.includes(s)),
    ...(cert.isActiveHttps ? ['HTTPS' as const] : []),
  ];
  return services.map((service): ServiceChip => {
    if (!report) return { service, state: 'unknown', details: ['Wird geprüft …'] };
    if (service === 'HTTPS') return httpsChip(cert.id, report);
    const ports = report.ports.filter((p) => p.protocol === service.toLowerCase());
    return chipFromPorts(service, ports, cert.id, report.hostname);
  });
}

const CHIP_STATE_TEXT: Record<ChipState, string> = {
  ok:      'OK, dieses Zertifikat wird ausgeliefert',
  warning: 'Warnung',
  unknown: 'nicht geprüft',
};

/** Accessible name of a chip: "IMAP: Warnung". */
export function chipLabel(chip: ServiceChip): string {
  return `${chip.service}: ${CHIP_STATE_TEXT[chip.state]}`;
}

/**
 * The "Jetzt zuweisen" fix next to the chips: the suggested trusted certificate
 * when a mail-protocol chip warns; null otherwise.
 */
export function mailFixSuggestion(
  chips: readonly ServiceChip[], report: ServedReport | null | undefined,
): { id: string; name: string } | null {
  const mailWarns = chips.some((c) => c.service !== 'HTTPS' && c.state === 'warning');
  return mailWarns ? report?.suggestedCert ?? null : null;
}

// ── w2b: labels of the two switches per certificate ──────────────────────────

/** Short name of the HTTPS switch: "HTTPS (Port 443)". */
export function httpsSwitchName(port: number): string {
  return `HTTPS (Port ${port})`;
}

/** w2b: the integrated HTTPS server when it serves a self-signed / name-mismatched / expired certificate, else null. */
export function httpsServedProblem(report: ServedReport | null | undefined): ServedPort | null {
  const https = report?.https;
  return https && https.problem !== null ? https : null;
}

/** w2b: detail line of the HTTPS warning banner: "HTTPS (Port 443): selbstsigniert … (CN=mail.localhost)". */
export function httpsWarningText(report: ServedReport, https: ServedPort): string {
  const cn = https.cert?.commonName ? ` (CN=${https.cert.commonName})` : '';
  return `${httpsSwitchName(https.port)}: ${problemText(https.problem, report.hostname)}${cn}`;
}

/** Accessible name + tooltip of the HTTPS switch (its on/off state is aria-pressed). */
export function httpsSwitchLabel(port: number): string {
  return `${httpsSwitchName(port)}: Dieses Zertifikat für Webmail/BCP/ActiveSync/Autodiscover über den integrierten HTTPS-Server verwenden`;
}

/** Accessible name + tooltip of the mail-protocol switch. */
export function mailSwitchLabel(active: boolean): string {
  return active
    ? `${MAIL_PROTOCOLS_LABEL}: aktiv, dieses Zertifikat wird verwendet`
    : `${MAIL_PROTOCOLS_LABEL}: Dieses Zertifikat sofort verwenden`;
}
