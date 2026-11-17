/**
 * Admin areas (RBAC) — GET /api/v1/user/me answers
 * `{ adminAreas: { <area>: 'write' | 'read' } }`. Pure helpers, no imports
 * (unit-tested with node --test).
 */

export type AdminArea =
  | 'dashboard' | 'organisation' | 'identity' | 'servers'
  | 'recipients' | 'domains' | 'hygiene' | 'compliance';

export type AreaAccess = 'write' | 'read';
export type AdminAreas = Partial<Record<AdminArea, AreaAccess>>;

/** BCP route (first path segment, without /bcp) → area. `null` = always visible. */
export const PATH_AREA: Record<string, AdminArea | null> = {
  'dashboard':        'dashboard',
  'reports':          'dashboard',
  'settings':         'organisation',
  'branding':         'organisation',
  'rbac':             'organisation',
  'ldap':             'identity',
  'sso':              'identity',
  'servers':          'servers',
  'services':         'servers',
  'certificates':     'servers',
  'queues':           'servers',
  'logs':             'servers',
  'backups':          'servers',
  'connectors':       'servers',
  'smtp-config':      'servers',
  'mailboxes':        'recipients',
  'shared-mailboxes': 'recipients',
  'domains':          'domains',
  'protection':       'hygiene',
  'quarantine':       'hygiene',
  'transport-rules':  'hygiene',
  'retention':        'compliance',
  'audit-log':        'compliance',
  'message-trace':    'compliance',
  'compliance-info':  null,
  'mfa-required':     null,
  'login':            null,
};

/** Area of a router path ("/mailboxes", "/bcp/mailboxes/x"); undefined = unknown page. */
export function areaForPath(pathname: string): AdminArea | null | undefined {
  const parts = pathname.replace(/^\/bcp(?=\/|$)/, '').split('/').filter(Boolean);
  const seg = parts[0] ?? 'dashboard';
  return seg in PATH_AREA ? PATH_AREA[seg] : undefined;
}

/**
 * Access level for a path. `areas === null` means the server did not send
 * adminAreas (older backend) → full access, i.e. the previous behaviour.
 */
export function accessForPath(areas: AdminAreas | null, pathname: string): AreaAccess | 'none' {
  if (!areas) return 'write';
  const area = areaForPath(pathname);
  if (area === null || area === undefined) return 'write';
  return areas[area] ?? 'none';
}

/** First page the admin may open (redirect target for "/"). */
export function firstAllowedPath(areas: AdminAreas | null): string {
  if (!areas) return '/dashboard';
  for (const [seg, area] of Object.entries(PATH_AREA)) {
    if (area && areas[area]) return `/${seg}`;
  }
  return '/compliance-info';
}
