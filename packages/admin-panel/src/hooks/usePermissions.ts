import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client.js';
import { ApiError } from '../lib/errors.js';
import { useAccessStore } from '../store/access.js';
import { accessForPath, areaForPath, type AdminArea, type AreaAccess } from '../lib/adminAreas.js';
import { can as canPure, parsePermissions } from '../lib/permissions.js';

/**
 * Loads the admin's permissions once per session: GET /admin/me/permissions
 * (8.x); an older backend without it (404) falls back to /user/me → adminAreas.
 * Any other failure keeps the previous behaviour (everything visible — the
 * server enforces every request anyway).
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
        if (err instanceof ApiError && err.status === 404) return parsePermissions(await api.get<unknown>('/user/me'));
        throw err;
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
  /** Area of the current page (null = page without an area). */
  pageArea: AdminArea | null;
  /** Access to the current page: 'write' | 'read' | 'none'. */
  pageAccess: AreaAccess | 'none';
}

/**
 * THE permission hook of the BCP. Pages and components ask it (or <Can>)
 * instead of comparing roles: `const { can } = usePermissions(); can('recipients', 'write')`.
 */
export function usePermissions(): PermissionsApi {
  const areas = useAccessStore((s) => s.areas);
  const role = useAccessStore((s) => s.role);
  const mfaVerified = useAccessStore((s) => s.mfaVerified);
  const status = useAccessStore((s) => s.status);
  const { pathname } = useLocation();
  const can = useCallback((area: AdminArea, access: AreaAccess = 'read') => canPure(areas, area, access), [areas]);
  return {
    role,
    mfaVerified,
    ready: status === 'ready',
    can,
    pageArea: areaForPath(pathname) ?? null,
    pageAccess: accessForPath(areas, pathname),
  };
}
