/**
 * BCP permissions (8.x) — pure logic behind usePermissions() and <Can>.
 * Source: GET /api/v1/admin/me/permissions → `{ role, areas, mfaVerified }`
 * (the API's ROLE_PERMISSIONS map). No imports from React; unit-tested.
 */
import type { AdminArea, AdminAreas, AreaAccess } from './adminAreas.ts';

export interface Permissions {
  role: string | null;
  /** null = unknown (older backend / lookup failed) → previous behaviour: full access. */
  areas: AdminAreas | null;
  mfaVerified: boolean;
}

export const AREA_NAMES: readonly AdminArea[] = [
  'dashboard', 'organisation', 'identity', 'servers', 'recipients', 'domains', 'hygiene', 'compliance',
];

/** Validates a server answer; anything unexpected yields `areas: null`. */
export function parsePermissions(raw: unknown): Permissions {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const role = typeof obj['role'] === 'string' ? obj['role'] : null;
  const mfaVerified = obj['mfaVerified'] === true;
  const src = obj['areas'] ?? obj['adminAreas'];
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { role, areas: null, mfaVerified };
  const areas: AdminAreas = {};
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if ((AREA_NAMES as readonly string[]).includes(k) && (v === 'read' || v === 'write')) areas[k as AdminArea] = v;
  }
  return { role, areas, mfaVerified };
}

/**
 * May the admin do `access` on `area`? write implies read.
 * `areas === null` (unknown) keeps full access, as before permissions existed;
 * the server enforces every request anyway.
 */
export function can(areas: AdminAreas | null, area: AdminArea, access: AreaAccess = 'read'): boolean {
  if (!areas) return true;
  const granted = areas[area];
  if (!granted) return false;
  return access === 'read' || granted === 'write';
}

/** What <Can> renders: the children, a disabled copy (read-only), or nothing. */
export type CanOutcome = 'allow' | 'disable' | 'hide';

export function canOutcome(areas: AdminAreas | null, area: AdminArea, access: AreaAccess, mode: 'hide' | 'disable'): CanOutcome {
  if (can(areas, area, access)) return 'allow';
  // A disabled control only makes sense where the admin can at least see the area.
  return mode === 'disable' && can(areas, area, 'read') ? 'disable' : 'hide';
}
