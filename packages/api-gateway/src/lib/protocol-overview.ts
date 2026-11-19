/**
 * w2b: the combined protocol model of the BCP page "Protokolle" and
 * `coremail protocol show` (GET /api/v1/admin/protocol-access/overview).
 *
 * Two different things switch a protocol, and this model shows them side by side:
 *   - ports (ServiceListener rows, BCP → Dienste): whether a port listens at all;
 *   - access (protocol switches server → domain → mailbox, @coremail/storage
 *     protocol-access.ts): whether an account may log in after authentication.
 *
 * Pure: buildProtocolOverview() takes what the loader read and returns one row
 * per access protocol (server switch, ports, overriding domains / mailboxes,
 * consistency warnings, softer notices) plus the inbound transport (SMTP port 25
 * etc., which is no user access). Warnings and notices carry a code and data only;
 * the BCP and the CLI word them. redactOverrideNames() hides the names a role may
 * not read (the counts stay).
 */
import {
  ACCESS_PROTOCOLS, resolveProtocolAccess, inheritAll,
  type AccessProtocol, type ProtocolOverrides, type ProtocolSettings,
} from '@coremail/storage';
import { isPemCurrentlyValid, uncoveredDomains } from './cert-lifecycle.js';
import { isSelfIssuedPem, isStagingCert } from './protocol-cert-assign.js';

/** Submission ports of the SMTP server (same defaults and env as smtp-server / autodiscover). */
export function submissionPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  return [parseInt(env['SMTP_PORT_465'] ?? '465', 10), parseInt(env['SMTP_PORT_587'] ?? '587', 10)];
}

/** At most this many overriding domains / mailboxes are listed per protocol (the counts are complete). */
export const OVERRIDE_LIST_LIMIT = 25;

export type ListenerService = 'SMTP_RECEIVE' | 'IMAP' | 'POP3';

export interface ListenerRow {
  id: string;
  service: string;
  address: string;
  port: number;
  ssl: boolean;
  active: boolean;
  allowLegacyTls: boolean;
}

export interface OverviewPort {
  id: string;
  service: ListenerService;
  address: string;
  port: number;
  ssl: boolean;
  /** implicit TLS (ssl) or STARTTLS on the plain port. */
  tlsMode: 'tls' | 'starttls';
  active: boolean;
  allowLegacyTls: boolean;
}

/** The integrated HTTPS server (port 443 by default) and the certificate it serves for the public host name (SNI). */
export interface HttpsState {
  active: boolean;
  port: number;
  cert: { id: string; name: string; trusted: boolean } | null;
}

export interface OverrideEntry {
  id: string;
  /** Domain name or mailbox address. */
  name: string;
  setting: 'on' | 'off';
  /** The value differs from what the level would inherit. */
  differs: boolean;
}

export interface OverrideGroup {
  /** Every explicit setting on this level. */
  total: number;
  /** Explicit settings that differ from what the level would inherit. */
  differing: number;
  /** Sorted by name, at most OVERRIDE_LIST_LIMIT; empty when namesHidden. */
  entries: OverrideEntry[];
  /** The caller may not read the domains / mailboxes of this level: counts only (redactOverrideNames). */
  namesHidden?: true;
}

export type OverviewWarningCode =
  /** The protocol is allowed for someone, but none of its ports is active. */
  | 'no-active-port'
  /** A port listens, but no account may use the protocol ("Port offen, Anmeldung für alle gesperrt"). */
  | 'port-open-access-off'
  /** MAPI is on for someone, but the integrated HTTPS server is off or has no trusted certificate. */
  | 'mapi-https';

export interface OverviewWarning {
  code: OverviewWarningCode;
  protocol: AccessProtocol;
  /** port-open-access-off: the listening ports. */
  ports?: number[];
}

/** Softer than a warning: consistent, but worth knowing. */
export type OverviewNoticeCode =
  /** A port listens and the protocol is off on the server, but some domains / mailboxes switch it on. */
  'port-open-access-limited';

export interface OverviewNotice {
  code: OverviewNoticeCode;
  protocol: AccessProtocol;
  /** The listening ports. */
  ports: number[];
}

export interface ProtocolOverviewRow {
  protocol: AccessProtocol;
  /** `listener` = own ports (BCP → Dienste), `http` = served by the HTTP/HTTPS server. */
  transport: 'listener' | 'http';
  /** Listener service of the ports (for adding a listener); null for HTTP-based protocols. */
  listenerService: ListenerService | null;
  /** The server-level switch. */
  server: 'on' | 'off';
  ports: OverviewPort[];
  /** Ports of the active listeners, ascending. */
  activePorts: number[];
  overrides: { domains: OverrideGroup; users: OverrideGroup };
  /** On at the server level or switched on for any domain / mailbox. */
  enabledAnywhere: boolean;
  warnings: OverviewWarning[];
  notices: OverviewNotice[];
}

export interface ProtocolOverview {
  protocols: ProtocolOverviewRow[];
  /** Inbound mail from other servers (SMTP on non-submission ports): transport, no user access switch. */
  smtpInbound: { ports: OverviewPort[]; activePorts: number[] };
  https: HttpsState;
  /** Every warning of every protocol, in protocol order. */
  warnings: OverviewWarning[];
  /** Every notice of every protocol, in protocol order. */
  notices: OverviewNotice[];
}

export interface OverviewInput {
  overrides: ProtocolOverrides;
  listeners: readonly ListenerRow[];
  https: HttpsState;
  submissionPorts: readonly number[];
}

const LISTENER_SERVICE: Partial<Record<AccessProtocol, ListenerService>> = {
  imap: 'IMAP', pop3: 'POP3', smtp: 'SMTP_RECEIVE',
};

function toPort(l: ListenerRow): OverviewPort {
  return {
    id: l.id, service: l.service as ListenerService, address: l.address, port: l.port, ssl: l.ssl,
    tlsMode: l.ssl ? 'tls' : 'starttls', active: l.active, allowLegacyTls: l.allowLegacyTls,
  };
}

const byPort = (a: OverviewPort, b: OverviewPort) => a.port - b.port || a.address.localeCompare(b.address);
const activePortsOf = (ports: readonly OverviewPort[]) => [...new Set(ports.filter((p) => p.active).map((p) => p.port))].sort((a, b) => a - b);

/** The ports of a protocol: IMAP / POP3 by service, SMTP submission = SMTP listeners on the submission ports. */
function portsFor(protocol: AccessProtocol, listeners: readonly ListenerRow[], submission: readonly number[]): OverviewPort[] {
  const service = LISTENER_SERVICE[protocol];
  if (!service) return [];
  return listeners
    .filter((l) => l.service === service && (protocol !== 'smtp' || submission.includes(l.port)))
    .map(toPort)
    .sort(byPort);
}

function group(entries: OverrideEntry[]): OverrideGroup {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return { total: entries.length, differing: entries.filter((e) => e.differs).length, entries: sorted.slice(0, OVERRIDE_LIST_LIMIT) };
}

/** Explicit domain / mailbox settings of one protocol and whether they differ from what they inherit. */
function overridesFor(protocol: AccessProtocol, o: ProtocolOverrides): { domains: OverrideGroup; users: OverrideGroup } {
  const inherit = inheritAll();
  const domainSettings = new Map<string, ProtocolSettings>(o.domains.map((d) => [d.id, d.settings]));
  const serverValue = resolveProtocolAccess([o.server])[protocol];
  const domains: OverrideEntry[] = [];
  for (const d of o.domains) {
    const s = d.settings[protocol];
    if (s !== 'inherit') domains.push({ id: d.id, name: d.name, setting: s, differs: (s === 'on') !== serverValue });
  }
  const users: OverrideEntry[] = [];
  for (const u of o.users) {
    const s = u.settings[protocol];
    if (s === 'inherit') continue;
    const inherited = resolveProtocolAccess([o.server, domainSettings.get(u.domainId) ?? inherit])[protocol];
    users.push({ id: u.id, name: u.email, setting: s, differs: (s === 'on') !== inherited });
  }
  return { domains: group(domains), users: group(users) };
}

/** Pure: the consistency warnings of one protocol row. */
export function protocolWarnings(
  row: Pick<ProtocolOverviewRow, 'protocol' | 'transport' | 'activePorts' | 'enabledAnywhere'>,
  https: HttpsState,
): OverviewWarning[] {
  const out: OverviewWarning[] = [];
  if (row.transport === 'listener') {
    if (row.enabledAnywhere && row.activePorts.length === 0) out.push({ code: 'no-active-port', protocol: row.protocol });
    if (!row.enabledAnywhere && row.activePorts.length > 0) {
      out.push({ code: 'port-open-access-off', protocol: row.protocol, ports: row.activePorts });
    }
  }
  if (row.protocol === 'mapi' && row.enabledAnywhere && !(https.active && https.cert?.trusted === true)) {
    out.push({ code: 'mapi-https', protocol: row.protocol });
  }
  return out;
}

/**
 * Pure: the notices of one protocol row — a listening port while the server
 * switch is off is fine when some domains / mailboxes switch the protocol on
 * (the others are refused after the login), so it is no warning, but it is said.
 */
export function protocolNotices(
  row: Pick<ProtocolOverviewRow, 'protocol' | 'transport' | 'server' | 'activePorts' | 'enabledAnywhere'>,
): OverviewNotice[] {
  if (row.transport === 'listener' && row.server === 'off' && row.enabledAnywhere && row.activePorts.length > 0) {
    return [{ code: 'port-open-access-limited', protocol: row.protocol, ports: row.activePorts }];
  }
  return [];
}

/** Pure: the combined model (see the module comment). */
export function buildProtocolOverview(input: OverviewInput): ProtocolOverview {
  const server = resolveProtocolAccess([input.overrides.server]);
  const protocols = ACCESS_PROTOCOLS.map((protocol): ProtocolOverviewRow => {
    const ports = portsFor(protocol, input.listeners, input.submissionPorts);
    const overrides = overridesFor(protocol, input.overrides);
    const enabledAnywhere = server[protocol]
      || [...input.overrides.domains, ...input.overrides.users].some((o) => o.settings[protocol] === 'on');
    const base = {
      protocol,
      transport: LISTENER_SERVICE[protocol] ? 'listener' as const : 'http' as const,
      listenerService: LISTENER_SERVICE[protocol] ?? null,
      server: server[protocol] ? 'on' as const : 'off' as const,
      ports,
      activePorts: activePortsOf(ports),
      overrides,
      enabledAnywhere,
    };
    return { ...base, warnings: protocolWarnings(base, input.https), notices: protocolNotices(base) };
  });
  const inbound = input.listeners
    .filter((l) => l.service === 'SMTP_RECEIVE' && !input.submissionPorts.includes(l.port))
    .map(toPort)
    .sort(byPort);
  return {
    protocols,
    smtpInbound: { ports: inbound, activePorts: activePortsOf(inbound) },
    https: input.https,
    warnings: protocols.flatMap((p) => p.warnings),
    notices: protocols.flatMap((p) => p.notices),
  };
}

const hidden = (g: OverrideGroup): OverrideGroup => ({ total: g.total, differing: g.differing, entries: [], namesHidden: true });

/**
 * Pure: the overview for a caller who may not read every name — domain names
 * need read access to the domains, mailbox addresses to the recipients. The
 * counts stay (they reveal no name); the lists are emptied and marked.
 */
export function redactOverrideNames(o: ProtocolOverview, may: { domains: boolean; users: boolean }): ProtocolOverview {
  if (may.domains && may.users) return o;
  return {
    ...o,
    protocols: o.protocols.map((p) => ({
      ...p,
      overrides: {
        domains: may.domains ? p.overrides.domains : hidden(p.overrides.domains),
        users: may.users ? p.overrides.users : hidden(p.overrides.users),
      },
    })),
  };
}

/**
 * Pure: whether the active HTTPS certificate is one clients trust for the
 * public host name — issued by a CA (not self-signed, not Let's Encrypt
 * staging), currently valid and covering the host name.
 */
export function isTrustedHttpsCert(
  c: { type: string; acmeStaging: boolean | null; certPem: string | null; status: string },
  hostname: string,
  now: Date = new Date(),
): boolean {
  if (c.type === 'SELF_SIGNED' || isStagingCert(c) || !c.certPem || c.status === 'PENDING') return false;
  if (isSelfIssuedPem(c.certPem) || !isPemCurrentlyValid(c.certPem, now)) return false;
  return uncoveredDomains(c.certPem, [hostname]).length === 0;
}
