/**
 * BCP permissions (8.x) — pure logic behind usePermissions() and <Can>.
 * Source: GET /api/v1/admin/me/permissions →
 *   `{ role, areas: { <area>: 'read'|'write' }, actions: { <area>: AdminAction[] }, mfaVerified }`
 * (the API's ROLE_PERMISSIONS + ADMIN_ACTIONS maps in api-gateway lib/rbac.ts).
 * No imports from React; unit-tested.
 */
import type { AdminArea, AdminAreas, AreaAccess } from './adminAreas.ts';

/**
 * Narrow admin actions beyond an area's read/write (mirror of ADMIN_ACTIONS in
 * api-gateway lib/rbac.ts). `impliedByWrite`: every role with write on the area
 * has the action (used when an older backend sends no `actions`).
 */
export const ADMIN_ACTIONS = {
  resetPassword:     { area: 'recipients', impliedByWrite: true },
  toggleActive:      { area: 'recipients', impliedByWrite: true },
  revokeSessions:    { area: 'recipients', impliedByWrite: true },
  backupMailboxData: { area: 'servers',    impliedByWrite: false },
} as const satisfies Record<string, { area: AdminArea; impliedByWrite: boolean }>;
export type AdminAction = keyof typeof ADMIN_ACTIONS;
export type AdminActions = Partial<Record<AdminArea, AdminAction[]>>;

export interface Permissions {
  role: string | null;
  /** null = unknown (older backend / lookup failed) → previous behaviour: full access. */
  areas: AdminAreas | null;
  /** null = the server sent no actions (older backend) → derived from write access. */
  actions: AdminActions | null;
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
  const actions = parseActions(obj['actions']);
  const src = obj['areas'] ?? obj['adminAreas'];
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { role, areas: null, actions, mfaVerified };
  const areas: AdminAreas = {};
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if ((AREA_NAMES as readonly string[]).includes(k) && (v === 'read' || v === 'write')) areas[k as AdminArea] = v;
  }
  return { role, areas, actions, mfaVerified };
}

function parseActions(src: unknown): AdminActions | null {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const out: AdminActions = {};
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (!(AREA_NAMES as readonly string[]).includes(k) || !Array.isArray(v)) continue;
    const list = v.filter((a): a is AdminAction => typeof a === 'string' && a in ADMIN_ACTIONS
      && ADMIN_ACTIONS[a as AdminAction].area === k);
    if (list.length) out[k as AdminArea] = list;
  }
  return out;
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

/**
 * May the admin perform the narrow `action`? From the server's `actions`; an
 * older backend without them → write on the action's area (if implied).
 */
export function canAction(areas: AdminAreas | null, actions: AdminActions | null, action: AdminAction): boolean {
  if (!areas) return true;
  const def = ADMIN_ACTIONS[action];
  if (actions) return (actions[def.area] ?? []).includes(action);
  return def.impliedByWrite && can(areas, def.area, 'write');
}

/**
 * Account-level limit of the API (mirror of canManageAccount in lib/rbac.ts):
 * only ORGANIZATION_MANAGEMENT may change, reset, sign out or delete admin
 * accounts; everyone else only USER accounts. Unknown role → allowed (the
 * server decides).
 */
export function canManageAccount(actorRole: string | null, targetRole: string | undefined): boolean {
  if (actorRole === null || actorRole === 'ORGANIZATION_MANAGEMENT') return true;
  return (targetRole ?? 'USER') === 'USER';
}

/**
 * Client-side write block of the API client: a mutating /admin request from a
 * page whose area is read-only is refused — unless the admin holds a narrow
 * action on that area (e.g. HELP_DESK password reset on Mailboxes); the server
 * enforces the exact limits.
 */
export function blocksWrite(
  areas: AdminAreas | null, actions: AdminActions | null,
  page: { area: AdminArea | null | undefined; access: AreaAccess | 'none' },
): boolean {
  if (page.access !== 'read') return false;
  const area = page.area;
  if (!area) return true;
  return !(Object.keys(ADMIN_ACTIONS) as AdminAction[]).some((a) => ADMIN_ACTIONS[a].area === area && canAction(areas, actions, a));
}

/**
 * 9.1: BCP pages (first path segment) an admin may open through a narrow action
 * WITHOUT read access to the page's area. The page then opens read-only and
 * shows only what the action covers — COMPLIANCE_MANAGEMENT reaches Backups
 * through backupMailboxData (per-mailbox backup, downloads, import, job list),
 * mirroring complianceBackupAccess in api-gateway routes/admin/backups.ts.
 */
export const PATH_ACTIONS: Readonly<Record<string, readonly AdminAction[]>> = {
  backups: ['backupMailboxData'],
};

const firstSegment = (pathname: string): string =>
  pathname.replace(/^\/bcp(?=\/|$)/, '').split('/').filter(Boolean)[0] ?? 'dashboard';

/**
 * Effective access to a page: the area access (`page.access`, from accessForPath)
 * or — when that is 'none' — 'read' if the admin holds one of the page's
 * PATH_ACTIONS. Used for the sidebar, the 403 page and the client write block.
 */
export function pageAccessFor(
  areas: AdminAreas | null, actions: AdminActions | null,
  page: { path: string; access: AreaAccess | 'none' },
): AreaAccess | 'none' {
  if (page.access !== 'none') return page.access;
  const via = PATH_ACTIONS[firstSegment(page.path)] ?? [];
  return via.some((a) => canAction(areas, actions, a)) ? 'read' : 'none';
}

/** What the Backups page offers (9.1). */
export interface BackupCapabilities {
  /** servers read: schedules tab + operational lists */
  operations: boolean;
  /** servers write: full backup, schedules CRUD, deleting jobs / archive objects */
  manage: boolean;
  /** backupMailboxData: per-mailbox backup, job/archive download, MBOX import */
  mailboxData: boolean;
}

export function backupCapabilities(areas: AdminAreas | null, actions: AdminActions | null): BackupCapabilities {
  return {
    operations: can(areas, 'servers', 'read'),
    manage: can(areas, 'servers', 'write'),
    mailboxData: canAction(areas, actions, 'backupMailboxData'),
  };
}

/**
 * What a failed GET /admin/me/permissions means:
 *  - 404 → older backend: ask /user/me (adminAreas) instead ('legacy');
 *  - 401/403 → the session is not an admin session (e.g. role USER): no areas;
 *  - anything else (5xx, network) → unknown: keep the previous behaviour (null areas).
 */
export function permissionsAfterError(status: number | undefined): Permissions | 'legacy' {
  if (status === 404) return 'legacy';
  if (status === 401 || status === 403) return { role: null, areas: {}, actions: {}, mfaVerified: false };
  return { role: null, areas: null, actions: null, mfaVerified: false };
}

/** What <Can> renders: the children, a disabled copy (read-only), or nothing. */
export type CanOutcome = 'allow' | 'disable' | 'hide';

export function canOutcome(areas: AdminAreas | null, area: AdminArea, access: AreaAccess, mode: 'hide' | 'disable'): CanOutcome {
  if (can(areas, area, access)) return 'allow';
  // A disabled control only makes sense where the admin can at least see the area.
  return mode === 'disable' && can(areas, area, 'read') ? 'disable' : 'hide';
}

/** <Can action="…"> outcome: allowed, disabled (area visible, action missing) or hidden. */
export function actionOutcome(areas: AdminAreas | null, actions: AdminActions | null, action: AdminAction, mode: 'hide' | 'disable'): CanOutcome {
  if (canAction(areas, actions, action)) return 'allow';
  return mode === 'disable' && can(areas, ADMIN_ACTIONS[action].area, 'read') ? 'disable' : 'hide';
}
