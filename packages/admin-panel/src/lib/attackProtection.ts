/**
 * BCP → Schutz → Angriffsschutz (10.5) — pure helpers of the page (unit-tested
 * with node --test, no imports). Server side: api-gateway
 * routes/admin/security-protection.ts, docs/attack-protection.md.
 */

export interface ActiveLockView {
  scope: 'ip' | 'account';
  /** IP or account hash — the release id. */
  id: string;
  ip: string | null;
  account: string | null;
  remainingSec: number;
  strikes: number;
  failures: number | null;
  protocol: string | null;
  lockedAt: string | null;
  lockSec: number | null;
  locksInWindow: number | null;
}

export interface LocksView {
  ips: ActiveLockView[];
  accounts: ActiveLockView[];
  truncated: boolean;
  repeatWindowDays: number;
}

export interface IpRuleView {
  id: string;
  kind: 'BLOCK' | 'ALLOW';
  cidr: string;
  note: string;
  auto: boolean;
  expiresAt: string | null;
  createdBy: string | null;
  createdAt: string;
  expired: boolean;
}

export interface RulesView {
  block: IpRuleView[];
  allow: IpRuleView[];
  callerIp: string;
  callerVerdict: 'allow' | 'block' | 'none';
  envExempt: string[];
  maxEntries: number;
}

export interface ProtectionSettingsView {
  notifyEnabled: boolean;
  notifyRecipient: string;
  failureAlertThreshold: number;
  autoBlockEnabled: boolean;
  autoBlockThreshold: number;
  autoBlockDays: number;
  effectiveRecipients: string[];
  limits: {
    failureAlertThreshold: { min: number; max: number };
    autoBlockThreshold: { min: number; max: number };
    autoBlockDays: { min: number; max: number };
  };
}

const PROTOCOL_LABELS: Record<string, string> = {
  smtp: 'SMTP', imap: 'IMAP', pop3: 'POP3', web: 'Webmail/API', jmap: 'JMAP', caldav: 'CalDAV/CardDAV',
  activesync: 'ActiveSync', mapi: 'MAPI', autodiscover: 'Autodiscover', mcp: 'MCP', http: 'HTTP',
};

/** Display name of a login surface / protocol. */
export function protocolLabel(p: string | null | undefined): string {
  if (!p) return '—';
  return PROTOCOL_LABELS[p] ?? p.toUpperCase();
}

/** Remaining lock time: "45 s", "12 min", "1 h 5 min", "2 d 3 h". */
export function formatRemaining(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.round((s % 86_400) / 3600);
  return h > 0 ? `${d} d ${h} h` : `${d} d`;
}

/**
 * Client-side plausibility of a block list / exception entry (the server
 * validates and normalises): IPv4 or IPv6, optionally with a prefix.
 */
export function looksLikeCidr(input: string): boolean {
  const v = input.trim();
  if (!v || v.length > 64 || /\s/.test(v)) return false;
  const [addr, prefix, extra] = v.split('/');
  if (extra !== undefined || !addr) return false;
  const isV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(addr);
  const isV6 = !isV4 && addr.includes(':') && /^[0-9a-fA-F:.]+$/.test(addr) && (addr.match(/::/g) ?? []).length <= 1;
  if (!isV4 && !isV6) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (isV4 ? 32 : 128);
}

/** Lifetime choices of a manual entry (null = permanent). */
export const EXPIRY_CHOICES: ReadonlyArray<number | null> = [null, 1, 7, 30, 90, 365];

/** Sum of the per-protocol counts. */
export function totalEvents(byProtocol: ReadonlyArray<{ protocol: string; count: number }> | undefined): number {
  return (byProtocol ?? []).reduce((n, p) => n + p.count, 0);
}
