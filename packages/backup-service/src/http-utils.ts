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

/**
 * 9.1: also tested against the lower-cased path — a second guard next to the
 * case-sensitive routing of server.ts, so `/backup/admin/DOWNLOAD/x` can never
 * reach a handler while being classified as "not mailbox data".
 */
export function isMailboxDataRoute(path: string): boolean {
  const lower = path.toLowerCase();
  return MAILBOX_DATA_ROUTES.some((r) => r.test(path) || r.test(lower));
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

/**
 * 9.2: an archive key from `?key=` (archive download/delete) must be a plain
 * relative object key — no empty/"."/".." segments, no leading "/", no
 * backslashes or control characters. Such keys used to reach the object store
 * and come back as a 500 ("Resource name contains bad components").
 */
export function isSafeArchiveKey(key: string): boolean {
  if (!key || key.length > 1024) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(key) || key.startsWith('/')) return false;
  return key.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
