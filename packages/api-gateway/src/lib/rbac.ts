/**
 * Admin RBAC — role → area matrix (v6).
 *
 * Every /api/v1/admin/* router is assigned exactly one AREA (some routers
 * guard sub-paths with different areas, e.g. the EMS bridge). A role has
 * either `write` (all methods) or `read` (GET/HEAD only) access to an area.
 * ORGANIZATION_MANAGEMENT always has write access to everything.
 *
 *  Area          Routers (mount under /api/v1/admin)                        write                 read (GET/HEAD)
 *  ───────────── ────────────────────────────────────────────────────────── ───────────────────── ─────────────────────────────────────────────
 *  dashboard     /dashboard                                                 —                     every admin role
 *  organisation  /settings, /organisation, /branding                        —                     SERVER_MANAGEMENT, VIEW_ONLY_ORG
 *  identity      /ldap, /sso                                                —                     VIEW_ONLY_ORG
 *  servers       /servers, /services, /certificates, /queues, /logs,        SERVER_MANAGEMENT     VIEW_ONLY_ORG
 *                /backups, /connectors, /smtp-config,
 *                /protocol-access, /protocol-access/domains/:id (9.4; the
 *                domain level is also readable by `domains` readers)
 *  recipients    /mailboxes, /shared-mailboxes, /resources, /mobile,        RECIPIENT_MANAGEMENT  HELP_DESK, VIEW_ONLY_ORG
 *                aliases (/mailboxes/:id/aliases, /aliases, …),
 *                /ems/mailboxes, /ems/mailbox-statistics, /ems/resource-mailboxes,
 *                /protocol-access/users/:id (9.4)
 *  domains       /domains, /ems/accepted-domains                            —                     RECIPIENT_MANAGEMENT, SERVER_MANAGEMENT, VIEW_ONLY_ORG
 *  hygiene       /security, /security/attacks, /quarantine,                 HYGIENE_MANAGEMENT    VIEW_ONLY_ORG
 *                /transport-rules, /ems/transport-rules
 *  compliance    /compliance/retention, /audit-log, /message-trace          COMPLIANCE_MANAGEMENT —  (VIEW_ONLY_ORG excluded: personal data)
 *
 * Special rules (enforced in the routes, see canManageAccount / canAssignRole):
 *  - HELP_DESK may additionally PUT /mailboxes/:id with ONLY `password` (and
 *    `active`) — and only for accounts whose role is USER.
 *  - Only ORGANIZATION_MANAGEMENT may assign/change roles, and modify, reset the
 *    password of, or delete another admin account (role ≠ USER) — 9.4: this
 *    includes the protocol switches of an admin account.
 *
 * The caller's areas are exposed via GET /api/v1/admin/me/permissions
 * (`{ role, areas: { "<area>": "write" | "read" }, mfaVerified }`) and, for
 * older clients, GET /api/v1/user/me → `adminAreas`, so the BCP can hide pages
 * and render read-only forms. ROLE_PERMISSIONS (below) is the per-role view of
 * this matrix and the one the guards consult.
 */

export const USER_ROLES = [
  'USER', 'HELP_DESK', 'RECIPIENT_MANAGEMENT', 'COMPLIANCE_MANAGEMENT',
  'HYGIENE_MANAGEMENT', 'SERVER_MANAGEMENT', 'VIEW_ONLY_ORG', 'ORGANIZATION_MANAGEMENT',
] as const;
export type UserRoleName = typeof USER_ROLES[number];

export const ADMIN_ROLES: readonly UserRoleName[] = USER_ROLES.filter((r) => r !== 'USER');

export const ADMIN_AREAS = [
  'dashboard', 'organisation', 'identity', 'servers', 'recipients', 'domains', 'hygiene', 'compliance',
] as const;
export type AdminArea = typeof ADMIN_AREAS[number];

export type AreaAccess = 'write' | 'read';

export const AREA_MATRIX: Record<AdminArea, { write: readonly UserRoleName[]; read: readonly UserRoleName[] }> = {
  dashboard:    { write: [],                         read: ADMIN_ROLES },
  organisation: { write: [],                         read: ['SERVER_MANAGEMENT', 'VIEW_ONLY_ORG'] },
  identity:     { write: [],                         read: ['VIEW_ONLY_ORG'] },
  servers:      { write: ['SERVER_MANAGEMENT'],      read: ['VIEW_ONLY_ORG'] },
  recipients:   { write: ['RECIPIENT_MANAGEMENT'],   read: ['HELP_DESK', 'VIEW_ONLY_ORG'] },
  domains:      { write: [],                         read: ['RECIPIENT_MANAGEMENT', 'SERVER_MANAGEMENT', 'VIEW_ONLY_ORG'] },
  hygiene:      { write: ['HYGIENE_MANAGEMENT'],     read: ['VIEW_ONLY_ORG'] },
  compliance:   { write: ['COMPLIANCE_MANAGEMENT'],  read: [] },
};

/** One permission entry: `access` on `area` (write implies read). */
export interface AreaPermission { readonly area: AdminArea; readonly access: AreaAccess }

/**
 * Role → permissions (8.x). THE map every area guard consults: `areaAccess()`
 * — and therefore `canAccess()`, `requireArea()`, `allowedAreas()`,
 * `GET /api/v1/user/me` (`adminAreas`) and `GET /api/v1/admin/me/permissions` —
 * reads it. Built once from AREA_MATRIX (which stays the readable per-area
 * view); ORGANIZATION_MANAGEMENT gets write on every area, USER gets nothing.
 * `requireRole()` without roles (EMS fallback, /storage) is ORGANIZATION_MANAGEMENT
 * only and therefore needs no area.
 */
export const ROLE_PERMISSIONS: Readonly<Record<UserRoleName, readonly AreaPermission[]>> = Object.freeze(
  Object.fromEntries(USER_ROLES.map((role) => {
    const perms: AreaPermission[] = [];
    if (role !== 'USER') {
      for (const area of ADMIN_AREAS) {
        const m = AREA_MATRIX[area];
        if (role === 'ORGANIZATION_MANAGEMENT' || m.write.includes(role)) perms.push(Object.freeze({ area, access: 'write' as const }));
        else if (m.read.includes(role)) perms.push(Object.freeze({ area, access: 'read' as const }));
      }
    }
    return [role, Object.freeze(perms)];
  })) as Record<UserRoleName, readonly AreaPermission[]>,
);

/**
 * Narrow admin actions (8.x) — rights finer than an area's read/write that the
 * routes grant via `requireArea(area, extra)` / handler checks. The guards
 * consult `hasAdminAction()` (mailboxes, backups), GET /admin/me/permissions
 * reports them as `actions: { <area>: AdminAction[] }`, and the BCP shows
 * exactly these actions (permissions.test.ts proves guards and map agree).
 *
 *  action             area        what (route)                                           granted to
 *  ─────────────────  ──────────  ─────────────────────────────────────────────────────  ─────────────────────────────────────────
 *  resetPassword      recipients  PUT /mailboxes/:id { password, revokeAppPasswords }    write on recipients + HELP_DESK (USER accounts only)
 *  toggleActive       recipients  PUT /mailboxes/:id { active }                          write on recipients + HELP_DESK (USER accounts only)
 *  revokeSessions     recipients  POST /mailboxes/:id/revoke-sessions                    write on recipients + HELP_DESK (USER accounts only)
 *  backupMailboxData  servers     per-mailbox backup, job/archive download, MBOX import  ORGANIZATION_MANAGEMENT + COMPLIANCE_MANAGEMENT
 *                                 (+ GET job/archive/user lists for COMPLIANCE)          (NOT implied by write on servers)
 */
export const ADMIN_ACTIONS = {
  resetPassword:     { area: 'recipients', impliedByWrite: true },
  toggleActive:      { area: 'recipients', impliedByWrite: true },
  revokeSessions:    { area: 'recipients', impliedByWrite: true },
  backupMailboxData: { area: 'servers',    impliedByWrite: false },
} as const satisfies Record<string, { area: AdminArea; impliedByWrite: boolean }>;
export type AdminAction = keyof typeof ADMIN_ACTIONS;

/** Explicit action grants beyond the area matrix (ORGANIZATION_MANAGEMENT has every action). */
export const ROLE_ACTION_GRANTS: Readonly<Partial<Record<UserRoleName, readonly AdminAction[]>>> = {
  HELP_DESK:             ['resetPassword', 'toggleActive', 'revokeSessions'],
  COMPLIANCE_MANAGEMENT: ['backupMailboxData'],
};

/** Request-body fields a role WITHOUT write on recipients may send to PUT /mailboxes/:id, per action. */
export const ACTION_FIELDS: Readonly<Partial<Record<AdminAction, readonly string[]>>> = {
  resetPassword: ['password', 'revokeAppPasswords'],
  toggleActive:  ['active'],
};

export function isUserRole(v: unknown): v is UserRoleName {
  return typeof v === 'string' && (USER_ROLES as readonly string[]).includes(v);
}

export function isAdminRole(role: string | undefined): boolean {
  return !!role && role !== 'USER' && isUserRole(role);
}

/** Privilege rank (v7.1.0) — used to pick the stricter of two roles. */
const ROLE_RANK: Record<UserRoleName, number> = {
  USER: 0, VIEW_ONLY_ORG: 1, HELP_DESK: 1,
  RECIPIENT_MANAGEMENT: 2, COMPLIANCE_MANAGEMENT: 2, HYGIENE_MANAGEMENT: 2, SERVER_MANAGEMENT: 2,
  ORGANIZATION_MANAGEMENT: 3,
};

/**
 * The less privileged of two roles (v7.1.0): the role in an access token vs.
 * the current role in the database. Same rank (lateral change) → `current`
 * (the database is authoritative); unknown roles count as USER.
 */
export function stricterRole(tokenRole: string, current: string): string {
  const rank = (r: string): number => (isUserRole(r) ? ROLE_RANK[r] : 0);
  return rank(tokenRole) < rank(current) ? tokenRole : current;
}

export function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** Access level of `role` on `area`, or null. */
export function areaAccess(role: string | undefined, area: AdminArea): AreaAccess | null {
  if (!role || !isUserRole(role)) return null;
  return ROLE_PERMISSIONS[role].find((p) => p.area === area)?.access ?? null;
}

export function canAccess(role: string | undefined, area: AdminArea, method: string): boolean {
  const a = areaAccess(role, area);
  if (a === 'write') return true;
  return a === 'read' && isReadMethod(method.toUpperCase());
}

/** `{ area: 'write' | 'read' }` for every area the role can reach (empty for USER). */
export function allowedAreas(role: string | undefined): Partial<Record<AdminArea, AreaAccess>> {
  const out: Partial<Record<AdminArea, AreaAccess>> = {};
  for (const area of ADMIN_AREAS) {
    const a = areaAccess(role, area);
    if (a) out[area] = a;
  }
  return out;
}

/** May `role` perform the narrow admin `action` (see ADMIN_ACTIONS)? */
export function hasAdminAction(role: string | undefined, action: AdminAction): boolean {
  if (!role || !isUserRole(role) || role === 'USER') return false;
  if (role === 'ORGANIZATION_MANAGEMENT') return true;
  const def = ADMIN_ACTIONS[action];
  if (def.impliedByWrite && areaAccess(role, def.area) === 'write') return true;
  return (ROLE_ACTION_GRANTS[role] ?? []).includes(action);
}

/** `{ <area>: AdminAction[] }` for every action the role may perform (empty for USER). */
export function allowedActions(role: string | undefined): Partial<Record<AdminArea, AdminAction[]>> {
  const out: Partial<Record<AdminArea, AdminAction[]>> = {};
  for (const action of Object.keys(ADMIN_ACTIONS) as AdminAction[]) {
    if (!hasAdminAction(role, action)) continue;
    (out[ADMIN_ACTIONS[action].area] ??= []).push(action);
  }
  return out;
}

/**
 * Fields a role may send to PUT /mailboxes/:id: null = unrestricted (write on
 * recipients), otherwise the union of ACTION_FIELDS of its granted actions.
 */
export function mailboxUpdateFields(role: string | undefined): ReadonlySet<string> | null {
  if (areaAccess(role, 'recipients') === 'write') return null;
  const fields = new Set<string>();
  for (const [action, f] of Object.entries(ACTION_FIELDS) as Array<[AdminAction, readonly string[]]>) {
    if (hasAdminAction(role, action)) f.forEach((x) => fields.add(x));
  }
  return fields;
}

/**
 * May `actorRole` modify / reset the password of / delete an account with
 * `targetRole`? Admin accounts are ORGANIZATION_MANAGEMENT-only.
 */
export function canManageAccount(actorRole: string | undefined, targetRole: string | undefined): boolean {
  if (actorRole === 'ORGANIZATION_MANAGEMENT') return true;
  return (targetRole ?? 'USER') === 'USER';
}

/**
 * May `actorRole` set `newRole` on an account whose current role is
 * `currentRole` (undefined = account is being created)?
 */
export function canAssignRole(actorRole: string | undefined, newRole: string | undefined, currentRole?: string): boolean {
  if (actorRole === 'ORGANIZATION_MANAGEMENT') return true;
  if (newRole === undefined) return true;
  if (currentRole === undefined) return newRole === 'USER';
  return newRole === currentRole;
}
