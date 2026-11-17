/**
 * 9.3: the certificate each mail port really serves (GET /admin/certificates/served)
 * — pure helpers for the SSL/TLS page and the dashboard warning (unit-tested).
 */

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
  protocol: 'smtp' | 'imap' | 'pop3';
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

export interface ServedReport {
  hostname: string;
  ports: ServedPort[];
  problem: boolean;
  suggestedCert: { id: string; name: string } | null;
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
