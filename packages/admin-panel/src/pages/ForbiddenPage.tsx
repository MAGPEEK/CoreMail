import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useAccessStore } from '../store/access.js';
import { firstAllowedPath } from '../lib/adminAreas.js';

/**
 * Friendly 403 for a BCP route the admin's role cannot open. Rendered by the
 * layout INSTEAD of the page, so the page never fires API calls that would
 * only come back 403.
 */
export function ForbiddenPage() {
  const t = useT();
  const { role } = usePermissions();
  const areas = useAccessStore((s) => s.areas);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  return (
    <div className="p-8 max-w-xl mx-auto mt-16 text-center space-y-3" role="alert">
      <ShieldOff size={32} className="mx-auto text-fg-subtle" aria-hidden="true" />
      <h1 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-fg outline-none">{t('forbidden_title')}</h1>
      <p className="text-sm text-fg-subtle">{t('forbidden_text')}</p>
      {role && (
        <p className="text-xs text-fg-subtle">
          {t('forbidden_role')}: <code className="bg-surface-2 px-1 rounded">{role}</code>
        </p>
      )}
      <Link to={firstAllowedPath(areas)} className="btn-secondary inline-flex text-sm">{t('forbidden_back')}</Link>
    </div>
  );
}
