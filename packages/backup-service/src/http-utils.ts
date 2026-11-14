/** Small, pure HTTP helpers for the backup-service (v6, unit-tested). */

/** Parse a `?limit=` query value: invalid / non-positive → fallback, capped at max. */
export function parseLimit(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

const WRITE_ROLES = new Set(['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT']);

/** Backup admin endpoints: "servers" area of the api-gateway RBAC matrix. */
export function isBackupAdmin(role: string | undefined, method: string): boolean {
  if (!role) return false;
  if (WRITE_ROLES.has(role)) return true;
  return role === 'VIEW_ONLY_ORG' && (method === 'GET' || method === 'HEAD');
}
