/**
 * w2b: the combined protocol page "Protokolle" (BCP → Dienste) — the model of
 * GET /admin/protocol-access/overview and the pure wording of its summary line,
 * warnings and override links. Ports decide whether a connection is possible,
 * access switches decide after the login whether an account may use the protocol.
 */
import type { Protocol } from './protocolAccess.ts';

export type ListenerService = 'SMTP_RECEIVE' | 'IMAP' | 'POP3';

export interface OverviewPort {
  id: string;
  service: ListenerService;
  address: string;
  port: number;
  ssl: boolean;
  tlsMode: 'tls' | 'starttls';
  active: boolean;
  allowLegacyTls: boolean;
}

export interface OverrideEntry { id: string; name: string; setting: 'on' | 'off'; differs: boolean }
/** `namesHidden`: the role may not read these domains / mailboxes — counts only, `entries` empty. */
export interface OverrideGroup { total: number; differing: number; entries: OverrideEntry[]; namesHidden?: true }

export type OverviewWarningCode = 'no-active-port' | 'port-open-access-off' | 'mapi-https';
export interface OverviewWarning { code: OverviewWarningCode; protocol: Protocol; ports?: number[] }

/** Softer than a warning: port open, server-wide off, on for some domains / mailboxes. */
export type OverviewNoticeCode = 'port-open-access-limited';
export interface OverviewNotice { code: OverviewNoticeCode; protocol: Protocol; ports: number[] }

export interface HttpsState {
  /** The integrated HTTPS server listens (also without a certificate marked isActiveHttps). */
  active: boolean;
  port: number;
  cert: { id: string; name: string; trusted: boolean } | null;
}

export interface ProtocolOverviewRow {
  protocol: Protocol;
  transport: 'listener' | 'http';
  listenerService: ListenerService | null;
  server: 'on' | 'off';
  ports: OverviewPort[];
  activePorts: number[];
  overrides: { domains: OverrideGroup; users: OverrideGroup };
  enabledAnywhere: boolean;
  warnings: OverviewWarning[];
  notices: OverviewNotice[];
}

export interface ProtocolOverview {
  protocols: ProtocolOverviewRow[];
  smtpInbound: { ports: OverviewPort[]; activePorts: number[] };
  https: HttpsState;
  warnings: OverviewWarning[];
  notices: OverviewNotice[];
}

/** Names on the page (German UI). */
export const PROTOCOL_NAMES: Record<Protocol, string> = {
  smtp: 'SMTP-Versand', imap: 'IMAP', pop3: 'POP3', activesync: 'ActiveSync', jmap: 'JMAP',
  dav: 'CalDAV / CardDAV', webmail: 'Webmail', mapi: 'MAPI über HTTP',
};

/** Display order: sending first, then the mail-access protocols, then the HTTP-based ones. */
export const PROTOCOL_ORDER: readonly Protocol[] = ['smtp', 'imap', 'pop3', 'activesync', 'jmap', 'dav', 'webmail', 'mapi'];

/** The rows in display order. */
export function orderedRows(o: Pick<ProtocolOverview, 'protocols'>): ProtocolOverviewRow[] {
  return PROTOCOL_ORDER.flatMap((p) => o.protocols.filter((r) => r.protocol === p));
}

/** API slug of a listener service (/admin/services/listeners/:service). */
export function listenerSlug(service: ListenerService): string {
  return service.toLowerCase().replace(/_/g, '-');
}

/** "HTTPS (Port 443)" — the integrated HTTPS server, as on the SSL/TLS page. */
export function httpsName(port: number): string {
  return `HTTPS (Port ${port})`;
}

const countText = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "aktiv auf 143, 993" / "kein Port aktiv" / "über HTTPS (Port 443)" / "über HTTP (HTTPS aus)". */
export function portsSummary(row: Pick<ProtocolOverviewRow, 'transport' | 'activePorts'>, https: HttpsState): string {
  if (row.transport === 'http') return https.active ? `über ${httpsName(https.port)}` : `über HTTP (${httpsName(https.port)} aus)`;
  return row.activePorts.length > 0 ? `aktiv auf ${row.activePorts.join(', ')}` : 'kein Port aktiv';
}

/** "2 Domains abweichend" / "1 Benutzer abweichend", or null when nothing differs. */
export function overrideSummary(level: 'domains' | 'users', g: OverrideGroup): string | null {
  if (g.differing === 0) return null;
  return `${countText(g.differing, level === 'domains' ? 'Domain' : 'Benutzer', level === 'domains' ? 'Domains' : 'Benutzer')} abweichend`;
}

/** The summary line of a protocol: "aktiv auf 993 · 2 Domains abweichend · 1 Benutzer abweichend". */
export function summaryLine(row: ProtocolOverviewRow, https: HttpsState): string {
  return [
    portsSummary(row, https),
    overrideSummary('domains', row.overrides.domains),
    overrideSummary('users', row.overrides.users),
  ].filter((s): s is string => s !== null).join(' · ');
}

/** One sentence per warning. */
export function warningText(w: OverviewWarning, https: HttpsState): string {
  const name = PROTOCOL_NAMES[w.protocol];
  switch (w.code) {
    case 'no-active-port':
      return `${name} ist erlaubt, aber kein Port ist aktiv — Clients können sich nicht verbinden.`;
    case 'port-open-access-off':
      return `${name}: Port offen (${(w.ports ?? []).join(', ')}), Anmeldung für alle gesperrt — der Zugriff ist serverweit aus und für keine Domain und kein Postfach an.`;
    case 'mapi-https':
      return `MAPI über HTTP ist eingeschaltet, aber ${httpsName(https.port)} ist nicht aktiv oder hat kein vertrauenswürdiges Zertifikat — Outlook verbindet sich nur über HTTPS (es sei denn, ein vorgeschalteter Reverse Proxy stellt HTTPS bereit).`;
  }
}

/** One sentence per notice (shown softer than a warning, not counted as an inconsistency). */
export function noticeText(n: OverviewNotice): string {
  switch (n.code) {
    case 'port-open-access-limited':
      return `${PROTOCOL_NAMES[n.protocol]}: Port offen (${n.ports.join(', ')}); Anmeldung nur für abweichende Domains/Benutzer.`;
  }
}

/** Link to an overriding domain / mailbox: the list page, filtered to that name. */
export function overrideLink(level: 'domains' | 'users', name: string): string {
  return `${level === 'domains' ? '/domains' : '/mailboxes'}?q=${encodeURIComponent(name)}`;
}

/** Hint instead of the list when the role may not read the names (OverrideGroup.namesHidden). */
export function hiddenNamesText(level: 'domains' | 'users'): string {
  return level === 'domains' ? 'Namen nur mit Leserecht für Domains sichtbar' : 'Adressen nur mit Leserecht für Empfänger sichtbar';
}

/** Element id of a protocol card (anchor target, e.g. /services#protocol-imap). */
export function protocolAnchorId(p: Protocol): string {
  return `protocol-${p}`;
}

/** Element id of the SMTP-Empfang (transport) card. */
export const SMTP_INBOUND_ANCHOR = 'smtp-inbound';

/**
 * Before w2b the Services page had sub-pages per listener service (SMTP Inbound,
 * IMAP, POP3) and the server-level "Protokollzugriff" editor. Old links
 * /services/<slug> land on the combined page at the matching card.
 */
const LEGACY_SERVICE_ANCHORS: Record<string, string> = {
  'smtp-receive': protocolAnchorId('smtp'),
  smtp: protocolAnchorId('smtp'),
  'smtp-inbound': SMTP_INBOUND_ANCHOR,
  imap: protocolAnchorId('imap'),
  pop3: protocolAnchorId('pop3'),
};

/** Target of an old /services/<sub> link: the combined page, anchored to the card when known. */
export function legacyServicesTarget(sub: string | undefined): string {
  const anchor = sub ? LEGACY_SERVICE_ANCHORS[sub.toLowerCase()] : undefined;
  return anchor ? `/services#${anchor}` : '/services';
}

/** "an" / "aus" label of an override entry, with "(wie geerbt)" when it does not differ. */
export function overrideEntryLabel(e: OverrideEntry): string {
  return `${e.setting === 'on' ? 'an' : 'aus'}${e.differs ? '' : ' (wie geerbt)'}`;
}
