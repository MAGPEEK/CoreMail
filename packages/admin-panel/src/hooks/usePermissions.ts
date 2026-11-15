import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client.js';
import { ApiError } from '../lib/errors.js';
import { useAccessStore } from '../store/access.js';
import { accessForPath, areaForPath, type AdminArea, type AreaAccess } from '../lib/adminAreas.js';
import { can as canPure, canAction as canActionPure, canManageAccount, pageAccessFor, parsePermissions, permissionsAfterError, type AdminAction } from '../lib/permissions.js';

/**
 * Loads the admin's permissions once per session: GET /admin/me/permissions
 * (8.x); an older backend without it (404) falls back to /user/me → adminAreas.
 * 401/403 (not an admin session) → no areas. Other failures (5xx, network)
 * keep the previous behaviour (everything visible — the server enforces every
 * request anyway). See permissionsAfterError().
 */
export function usePermissionsLoader(): void {
  const setPermissions = useAccessStore((s) => s.setPermissions);
  const setUnknown = useAccessStore((s) => s.setUnknown);
  const { data, isError } = useQuery({
    queryKey: ['admin-me-permissions'],
    queryFn: async () => {
      try {
        return parsePermissions(await api.get<unknown>('/admin/me/permissions'));
      } catch (err) {
        // MFA_REQUIRED / MFA_NOT_VERIFIED / expired sessions are redirected by the API client.
        if (!(err instanceof ApiError)) throw err;
        const next = permissionsAfterError(err.status);
        return next === 'legacy' ? parsePermissions(await api.get<unknown>('/user/me')) : next;
      }
    },
    staleTime: 5 * 60_000,
    retry: 1,
    meta: { silentError: true },
  });
  useEffect(() => {
    if (data) setPermissions(data);
    else if (isError) setUnknown();
  }, [data, isError, setPermissions, setUnknown]);
}

export interface PermissionsApi {
  role: string | null;
  mfaVerified: boolean;
  /** false while the permissions are still loading */
  ready: boolean;
  /** May the admin do `access` (default read) on `area`? */
  can: (area: AdminArea, access?: AreaAccess) => boolean;
  /** May the admin perform a narrow action (e.g. resetPassword as HELP_DESK)? */
  canAction: (action: AdminAction) => boolean;
  /** May the admin change/reset/sign out an account with this role (admin accounts: ORGANIZATION_MANAGEMENT only)? */
  canManage: (targetRole: string | undefined) => boolean;
  /** Area of the current page (null = page without an area). */
  pageArea: AdminArea | null;
  /** Access to the current page: 'write' | 'read' | 'none' (9.1: a page action such as backupMailboxData gives 'read'). */
  pageAccess: AreaAccess | 'none';
  /** 9.1: may the admin open this BCP path (sidebar)? Area read, or a page action (lib/permissions.ts PATH_ACTIONS). */
  canSeePath: (path: string) => boolean;
}

/**
 * THE permission hook of the BCP. Pages and components ask it (or <Can>)
 * instead of comparing roles: `const { can } = usePermissions(); can('recipients', 'write')`.
 */
export function usePermissions(): PermissionsApi {
  const areas = useAccessStore((s) => s.areas);
  const actions = useAccessStore((s) => s.actions);
  const role = useAccessStore((s) => s.role);
  const mfaVerified = useAccessStore((s) => s.mfaVerified);
  const status = useAccessStore((s) => s.status);
  const { pathname } = useLocation();
  const can = useCallback((area: AdminArea, access: AreaAccess = 'read') => canPure(areas, area, access), [areas]);
  const canAction = useCallback((action: AdminAction) => canActionPure(areas, actions, action), [areas, actions]);
  return {
    role,
    mfaVerified,
    ready: status === 'ready',
    can,
    canAction,
    canManage: (targetRole: string | undefined) => canManageAccount(role, targetRole),
    pageArea: areaForPath(pathname) ?? null,
    pageAccess: pageAccessFor(areas, actions, { path: pathname, access: accessForPath(areas, pathname) }),
    canSeePath: (path: string) => pageAccessFor(areas, actions, { path, access: accessForPath(areas, path) }) !== 'none',
  };
}
