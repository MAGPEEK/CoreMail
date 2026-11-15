import { useId, type ReactNode } from 'react';
import { usePermissions } from '../hooks/usePermissions.js';
import { useAccessStore } from '../store/access.js';
import { canOutcome } from '../lib/permissions.js';
import type { AdminArea, AreaAccess } from '../lib/adminAreas.js';
import { useT } from '../i18n/useT.js';

interface CanProps {
  area: AdminArea;
  /** Required access (default 'read'). */
  access?: AreaAccess;
  /**
   * What happens without the right:
   *  - 'disable' (default for write): rendered disabled with a tooltip when the
   *    admin can see the area read-only; hidden when the area is not visible at all;
   *  - 'hide': not rendered.
   */
  mode?: 'hide' | 'disable';
  /** Rendered instead when the outcome is 'hide'. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Permission gate (EAC: an action the role's command rights do not include is
 * hidden or read-only). `<Can area="recipients" access="write"><button…/></Can>`.
 * The disabled variant wraps the children in a disabled <fieldset> (so every
 * button/input inside is disabled natively, keyboard included) inside a span
 * that carries the tooltip — disabled controls do not show their own title.
 */
export function Can({ area, access = 'read', mode, fallback = null, children }: CanProps) {
  const areas = useAccessStore((s) => s.areas);
  const t = useT();
  const outcome = canOutcome(areas, area, access, mode ?? (access === 'write' ? 'disable' : 'hide'));
  if (outcome === 'allow') return <>{children}</>;
  if (outcome === 'hide') return <>{fallback}</>;
  return (
    <span className="inline-flex cursor-not-allowed opacity-50" title={t('perm_readonly_tooltip')}>
      <fieldset disabled aria-disabled="true" className="contents [&_*]:pointer-events-none">
        {children}
      </fieldset>
    </span>
  );
}

/**
 * Form wrapper: everything inside is disabled when the admin lacks write
 * access to `area` (EAC: property pages open read-only without the Set right).
 */
export function WriteGuard({ area, children, className }: { area: AdminArea; children: ReactNode; className?: string }) {
  const { can } = usePermissions();
  const t = useT();
  const noteId = useId();
  const writable = can(area, 'write');
  return (
    <fieldset disabled={!writable} className={`min-w-0 border-0 p-0 m-0 ${className ?? ''}`}
      {...(!writable ? { title: t('perm_readonly_tooltip'), 'aria-describedby': noteId } : {})}>
      {!writable && (
        <p id={noteId} className="mb-3 text-xs text-amber-700 dark:text-amber-300">{t('perm_readonly_form')}</p>
      )}
      {children}
    </fieldset>
  );
}
