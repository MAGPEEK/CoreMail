/**
 * SSL/TLS page helpers (pure): retry availability for Let's Encrypt
 * certificates, hints per classified ACME error code and the pre-flight
 * report types. The server classifies failures (lastErrorCode) — see
 * api-gateway lib/acme-errors.ts.
 */

export type CertStatus = 'PENDING' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'ERROR' | 'RENEWING';

/** The server stops every ACME run after 5 minutes; a run older than this is gone. */
export const STALE_IN_PROGRESS_MS = 6 * 60_000;

export interface RetryableCert {
  type: string;
  status: CertStatus;
  issuedAt?: string | null;
  updatedAt?: string | null;
}

/** PENDING / RENEWING for longer than any run can take (server restart) — a retry restarts it. */
export function isStaleInProgress(cert: RetryableCert, now: number = Date.now()): boolean {
  if (cert.status !== 'PENDING' && cert.status !== 'RENEWING') return false;
  if (!cert.updatedAt) return false;
  const t = new Date(cert.updatedAt).getTime();
  return Number.isFinite(t) && now - t > STALE_IN_PROGRESS_MS;
}

/** Let's Encrypt only; not while a live run is in progress. */
export function canStartAcme(cert: RetryableCert, now: number = Date.now()): boolean {
  if (cert.type !== 'LETSENCRYPT') return false;
  if (cert.status === 'PENDING' || cert.status === 'RENEWING') return isStaleInProgress(cert, now);
  return true;
}

/** Tooltip / aria label of the renew-or-retry button. */
export function acmeActionLabel(cert: RetryableCert & { expiresAt?: string | null; autoRenew?: boolean }, now: number = Date.now()): string {
  if (cert.status === 'PENDING' || cert.status === 'RENEWING') {
    return isStaleInProgress(cert, now)
      ? 'Vorgang hängt (Server-Neustart?) — erneut versuchen'
      : cert.status === 'PENDING' ? 'Let\'s Encrypt-Anfrage läuft — bitte warten' : 'Erneuerung läuft…';
  }
  if (cert.status === 'ERROR') {
    return cert.issuedAt ? 'Letzte Erneuerung fehlgeschlagen — erneut versuchen' : 'Ausstellung fehlgeschlagen — erneut versuchen';
  }
  if (cert.status === 'EXPIRED') return 'Abgelaufen — jetzt erneuern';
  if (cert.status === 'EXPIRING') {
    const days = cert.expiresAt ? Math.floor((new Date(cert.expiresAt).getTime() - now) / 86_400_000) : null;
    return `Läuft in ${days ?? '?'} Tagen ab — jetzt erneuern${cert.autoRenew ? ' (Auto-Renew aktiv)' : ''}`;
  }
  return 'Jetzt erneuern';
}

/** What the admin should do, per classified error code (German, like the page). */
const HINTS: Record<string, string> = {
  'connection':          'Let\'s Encrypt erreicht den Server nicht auf Port 80. Prüfen: Port 80 in Firewall/Router freigegeben und auf CoreMail weitergeleitet (Docker: Host-Port 80 → Container-Port 3000).',
  'unauthorized':        'Auf Port 80 antwortet ein anderer Webserver (oder die Domain zeigt auf eine andere IP). Prüfen: DNS-A-Record und Portweiterleitung auf CoreMail.',
  'dns':                 'Die Domain ist im öffentlichen DNS nicht auflösbar. A-Record (und ggf. AAAA) auf die öffentliche IP dieses Servers setzen.',
  'caa':                 'Ein CAA-Eintrag der Domain verbietet Let\'s Encrypt. CAA-Eintrag 0 issue "letsencrypt.org" ergänzen oder entfernen.',
  'rate-limited':        'Let\'s Encrypt-Limit erreicht. Erst nach der angegebenen Zeit erneut versuchen; für Tests die Staging-Umgebung verwenden.',
  'rejected-identifier': 'Für diesen Namen stellt Let\'s Encrypt kein Zertifikat aus (nur öffentliche Domainnamen).',
  'tls':                 'Port 80 leitet auf HTTPS um und die TLS-Verbindung schlägt fehl. Umleitung für /.well-known/acme-challenge/ entfernen.',
  'account':             'Let\'s Encrypt hat das Konto abgelehnt — meist eine ungültige Kontakt-E-Mail-Adresse.',
  'local-serving':       'CoreMail liefert das Prüf-Token selbst nicht aus (Redis erreichbar?). Es wurde nichts an Let\'s Encrypt gesendet.',
  'network':             'Der Server erreicht Let\'s Encrypt nicht (ausgehendes HTTPS oder DNS des Servers gestört).',
  'server':              'Let\'s Encrypt ist vorübergehend nicht verfügbar. Später erneut versuchen.',
  'timeout':             'Der Vorgang wurde nach 5 Minuten abgebrochen. „Voraussetzungen prüfen" zeigt, woran es liegt.',
  'interrupted':         'Der Vorgang wurde durch einen Neustart unterbrochen. Einfach erneut versuchen.',
};

export function acmeErrorHint(code: string | null | undefined): string | null {
  if (!code) return null;
  return HINTS[code] ?? null;
}

// ── Pre-flight report (POST /admin/certificates/preflight) ───────────────────

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skip';

export interface PreflightCheck { id: string; status: CheckStatus; message: string }
export interface PreflightReport {
  ok: boolean;
  domains: Array<{ domain: string; ipv4: string[]; ipv6: string[]; checks: PreflightCheck[] }>;
  external: { status: CheckStatus; message: string; code?: string };
}

export const CHECK_LABELS: Record<string, string> = {
  'dns':       'DNS',
  'ipv6':      'IPv6',
  'server-ip': 'Server-Adresse',
  'caa':       'CAA',
  'local':     'Prüfpfad lokal',
  'public':    'Abruf über öffentlichen Namen',
};

/** Domains from the textarea (one per line, also comma/space separated), lower-cased, unique. */
export function parseDomainList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))];
}
