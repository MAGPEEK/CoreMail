/**
 * BCP → Infrastruktur → KI-Schnittstelle (MCP), 10.3 — pure helpers of the page
 * (unit-tested with node --test, no imports). Server side: api-gateway
 * routes/admin/mcp.ts, docs/mcp.md.
 */

export type McpTokenMode = 'read' | 'write';
export type McpTokenStatus = 'active' | 'revoked' | 'expired';

export interface McpSettingsView {
  enabled: boolean;
  endpointUrl: string;
  /** Only for admins with read access to the servers area. */
  allowedIps?: string[];
  openSessions?: number;
  canManage: boolean;
  canSeeAllTokens: boolean;
  canCreateWriteTokens: boolean;
  limits: { tokenDefaultDays: number; tokenMaxDays: number; tokensPerAdmin: number; toolCallsPerMinute: number };
}

export interface McpTokenView {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  mode: McpTokenMode;
  mfaVerified: boolean;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  status: McpTokenStatus;
  /** Only in the "all tokens" view (Organization Management). */
  owner?: string | null;
}

/** Placeholder shown in the example configuration until a token was just created. */
export const TOKEN_PLACEHOLDER = '<token>';

/** Expiry choices of the create form (days); the server allows 1–365. */
export const EXPIRY_CHOICES: readonly number[] = [30, 90, 180, 365];

/**
 * Pure: the example client configuration — generic JSON with the endpoint URL
 * and the bearer header (`mcpServers` is the common key of MCP client configs).
 */
export function clientConfigJson(endpointUrl: string, token: string = TOKEN_PLACEHOLDER): string {
  return JSON.stringify({
    mcpServers: {
      coremail: {
        type: 'http',
        url: endpointUrl,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  }, null, 2);
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isIpv6(v: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(v) || !v.includes(':')) return false;
  const parts = v.split('::');
  if (parts.length > 2) return false;
  const groups = (s: string) => (s ? s.split(':') : []);
  const all = [...groups(parts[0] ?? ''), ...groups(parts[1] ?? '')];
  const last = all[all.length - 1] ?? '';
  const embedded4 = IPV4.test(last);
  const hex = embedded4 ? all.slice(0, -1) : all;
  if (!hex.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  const count = hex.length + (embedded4 ? 2 : 0);
  return parts.length === 2 ? count < 8 : count === 8;
}

/** Pure: is `entry` an IPv4/IPv6 address or CIDR range? (The server validates again.) */
export function isAllowlistEntry(entry: string): boolean {
  const v = entry.trim();
  if (!v) return false;
  const [addr = '', prefix, ...rest] = v.split('/');
  if (rest.length > 0) return false;
  const v4 = IPV4.test(addr);
  const v6 = !v4 && isIpv6(addr);
  if (!v4 && !v6) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (v4 ? 32 : 128);
}

/** Pure: textarea content (one entry per line, commas allowed) → entries + the invalid ones. */
export function parseAllowlistText(text: string): { entries: string[]; invalid: string[] } {
  const items = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const item of items) {
    if (!isAllowlistEntry(item)) invalid.push(item);
    else if (!entries.includes(item)) entries.push(item);
  }
  return { entries, invalid };
}

/** Pure: is a token name acceptable (1–64 characters after trimming, no control characters)? */
export function validTokenName(name: string): boolean {
  const n = name.trim();
  return n.length >= 1 && n.length <= 64 && !/[\u0000-\u001f\u007f]/.test(n);
}

/** Pure: whole days until `iso` (negative = in the past). */
export function daysUntil(iso: string, now = Date.now()): number {
  return Math.floor((new Date(iso).getTime() - now) / 86_400_000);
}

/** Pure: does an active token expire within `days` (default 14) — shown as a hint? */
export function expiresSoon(t: Pick<McpTokenView, 'status' | 'expiresAt'>, now = Date.now(), days = 14): boolean {
  return t.status === 'active' && daysUntil(t.expiresAt, now) < days;
}

/** Pure: tokens sorted for the list — active first, then newest first. */
export function sortTokens(tokens: readonly McpTokenView[]): McpTokenView[] {
  const rank = (s: McpTokenStatus) => (s === 'active' ? 0 : 1);
  return [...tokens].sort((a, b) => rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt));
}
