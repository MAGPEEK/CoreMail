/**
 * BCP → Schutzfilter: which scanner sections are shown (pure, 9.3).
 *
 * GET /admin/security/capabilities reports per scanner (rspamd, ClamAV) whether
 * it is part of this installation:
 *  - absent       not deployed — only the explicit env switch CLAMAV_ENABLED=false /
 *                 RSPAMD_ENABLED=false (minimal compose, Helm chart without the
 *                 scanner) → its settings are hidden and a neutral info line with a
 *                 documentation link is shown instead
 *  - unavailable  not answering → settings stay, warning with reason; for
 *                 `host-not-found` (stopped container, NXDOMAIN, typo in the host)
 *                 the warning names CLAMAV_HOST / RSPAMD_URL and the env switches
 *  - available    nothing special
 * Unknown (request failed / still loading / not checked yet) hides nothing.
 */

export type ScannerName = 'rspamd' | 'clamav';
export type ScannerState = 'absent' | 'unavailable' | 'available';
export type ScannerReason =
  | 'disabled-by-config' | 'host-not-found' | 'dns-error' | 'connect-failed'
  | 'timeout' | 'bad-response' | 'ok' | 'not-checked';

export interface ScannerCapability {
  state: ScannerState;
  reason: ScannerReason | string;
  detail?: string;
  checkedAt?: string | null;
}
export interface ScannerCapabilities { rspamd: ScannerCapability; clamav: ScannerCapability }

export type ProtectionSection = 'overview' | 'rspamd' | 'antivirus' | 'dnsbl' | 'greylisting' | 'geoip' | 'attachments';

const DOCS_BASE = 'https://github.com/MAGPEEK/CoreMail/blob/main/docs';
export const SCANNER_DOCS: Record<ScannerName, string> = {
  rspamd: `${DOCS_BASE}/docker-compose.md`,
  clamav: `${DOCS_BASE}/antivirus.md`,
};

const SCANNER_LABEL: Record<ScannerName, string> = {
  rspamd: 'Spamfilter (rspamd)',
  clamav: 'Virenscanner (ClamAV)',
};

/** The settings section that belongs to a scanner. */
const SCANNER_SECTION: Record<ScannerName, ProtectionSection> = { rspamd: 'rspamd', clamav: 'antivirus' };

const REASON_TEXT: Record<ScannerReason, string> = {
  'disabled-by-config': 'per Server-Konfiguration abgeschaltet',
  'host-not-found':     'Host nicht gefunden',
  'dns-error':          'Namensauflösung fehlgeschlagen',
  'connect-failed':     'Verbindung fehlgeschlagen',
  timeout:              'keine Antwort (Zeitüberschreitung)',
  'bad-response':       'unerwartete Antwort',
  ok:                   'erreichbar',
  'not-checked':        'noch nicht geprüft',
};

/** Warning for an unavailable scanner whose host name does not resolve. */
export const HOST_NOT_FOUND_TEXT =
  'Host nicht gefunden: CLAMAV_HOST/RSPAMD_URL prüfen oder den Scanner mit CLAMAV_ENABLED=false bzw. RSPAMD_ENABLED=false als nicht bereitgestellt kennzeichnen.';

/** German text for a reason code (+ error code in brackets). */
export function reasonText(reason: string, detail?: string): string {
  const text = (REASON_TEXT as Record<string, string>)[reason] ?? 'unbekannter Zustand';
  return detail ? `${text} (${detail})` : text;
}

/** Is the scanner's settings section shown? Unknown state → yes. */
export function scannerVisible(cap: ScannerCapability | undefined): boolean {
  return cap?.state !== 'absent';
}

export interface ScannerNotice {
  scanner: ScannerName;
  tone: 'info' | 'warning';
  text: string;
  docsUrl?: string;
}

/** Info line (absent) or warning (unavailable) for one scanner; null when nothing to say. */
export function scannerNotice(scanner: ScannerName, cap: ScannerCapability | undefined): ScannerNotice | null {
  if (!cap) return null;
  const label = SCANNER_LABEL[scanner];
  if (cap.state === 'absent') {
    return { scanner, tone: 'info', text: `${label} ist in dieser Installation nicht bereitgestellt.`, docsUrl: SCANNER_DOCS[scanner] };
  }
  if (cap.state === 'unavailable' && cap.reason !== 'not-checked') {
    const effect = scanner === 'rspamd'
      ? 'Bis er wieder antwortet, werden E-Mails ohne Spamprüfung zugestellt.'
      : 'Bis er wieder antwortet, gilt die eingestellte Fehlerbehandlung. Nach dem Start lädt ClamAV einige Minuten lang seine Signaturen.';
    if (cap.reason === 'host-not-found') {
      // A missing host name is never treated as "not deployed" (only the env switch is).
      return { scanner, tone: 'warning', text: `${label} ist nicht erreichbar. ${HOST_NOT_FOUND_TEXT} ${effect}` };
    }
    return { scanner, tone: 'warning', text: `${label} ist bereitgestellt, aber nicht erreichbar: ${reasonText(cap.reason, cap.detail)}. ${effect}` };
  }
  return null;
}

/** Notices for both scanners, rspamd first. */
export function scannerNotices(caps: ScannerCapabilities | undefined): ScannerNotice[] {
  return (['rspamd', 'clamav'] as const)
    .map((s) => scannerNotice(s, caps?.[s]))
    .filter((n): n is ScannerNotice => n !== null);
}

/** The sub-navigation without the sections of absent scanners (order kept). */
export function visibleSections<T extends { id: ProtectionSection }>(all: readonly T[], caps: ScannerCapabilities | undefined): T[] {
  const hidden = new Set<ProtectionSection>();
  for (const s of ['rspamd', 'clamav'] as const) {
    if (!scannerVisible(caps?.[s])) hidden.add(SCANNER_SECTION[s]);
  }
  return all.filter((x) => !hidden.has(x.id));
}

/** The section to render: falls back to the overview when the selected one was hidden. */
export function resolveSection(current: ProtectionSection, visible: readonly { id: ProtectionSection }[]): ProtectionSection {
  return visible.some((x) => x.id === current) ? current : 'overview';
}

/** Which scanners are absent (for the overview's protection matrix and status cards). */
export function absentScanners(caps: ScannerCapabilities | undefined): Record<ScannerName, boolean> {
  return { rspamd: !scannerVisible(caps?.rspamd), clamav: !scannerVisible(caps?.clamav) };
}
