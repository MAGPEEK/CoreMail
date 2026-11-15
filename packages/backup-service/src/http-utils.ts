/** Small, pure HTTP helpers for the backup-service (v6, unit-tested). */

/** Parse a `?limit=` query value: invalid / non-positive → fallback, capped at max. */
export function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

const WRITE_ROLES = new Set(['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT']);

/** Routes that expose mailbox CONTENT (per-mailbox backup, downloads, import). */
const MAILBOX_DATA_ROUTES: ReadonlyArray<RegExp> = [
  /^\/backup\/admin\/mailbox\/[^/]+\/?$/,
  /^\/backup\/admin\/download\/[^/]+\/?$/,
  /^\/backup\/admin\/archive\/download\/?$/,
  /^\/backup\/admin\/import\/[^/]+\/?$/,
];
/** Listings COMPLIANCE_MANAGEMENT needs to pick a mailbox or job. */
const MAILBOX_DATA_LISTINGS: ReadonlyArray<RegExp> = [
  /^\/backup\/admin\/(users|list|jobs)\/?$/,
];

export function isMailboxDataRoute(path: string): boolean {
  return MAILBOX_DATA_ROUTES.some((r) => r.test(path));
}

/**
 * Backup admin endpoints — mirrors the api-gateway RBAC (9.1, defence in depth):
 *  - ORGANIZATION_MANAGEMENT: everything
 *  - SERVER_MANAGEMENT: everything except mailbox content (per-mailbox backup, downloads, import)
 *  - COMPLIANCE_MANAGEMENT: mailbox content + the listings needed to use it
 *  - VIEW_ONLY_ORG: read-only listings, no downloads
 * `path` is the request path; without it only the role/method rule of 9.0 applies.
 */
export function isBackupAdmin(role: string | undefined, method: string, path?: string): boolean {
  if (!role) return false;
  const read = method === 'GET' || method === 'HEAD';
  if (path === undefined) {
    if (WRITE_ROLES.has(role)) return true;
    return role === 'VIEW_ONLY_ORG' && read;
  }
  const mailboxData = isMailboxDataRoute(path);
  if (role === 'ORGANIZATION_MANAGEMENT') return true;
  if (role === 'SERVER_MANAGEMENT') return !mailboxData;
  if (role === 'COMPLIANCE_MANAGEMENT') return mailboxData || (read && MAILBOX_DATA_LISTINGS.some((r) => r.test(path)));
  if (role === 'VIEW_ONLY_ORG') return read && !mailboxData;
  return false;
}
