import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useT } from '../i18n/useT.js';

interface DetailPanelProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  /** Quick actions (EAC: links under the heading of the details pane). */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Right-hand details pane of a list page (EAC). Not modal: the list stays
 * usable. Focus moves to the heading when the pane opens (and when it shows
 * another item); Escape closes it and returns focus to where it came from
 * (normally the table row).
 */
export function DetailPanel({ title, subtitle, onClose, actions, children }: DetailPanelProps) {
  const t = useT();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    returnTo.current = document.activeElement as HTMLElement | null;
    return () => {
      const el = returnTo.current;
      if (el && document.contains(el)) el.focus();
    };
  }, []);
  // Move focus to the heading on open and whenever another item is shown.
  const titleKey = typeof title === 'string' ? title : '';
  useEffect(() => { headingRef.current?.focus(); }, [titleKey]);

  return (
    <aside
      aria-labelledby={headingId}
      className="w-full lg:w-96 shrink-0 card p-0 overflow-hidden lg:sticky lg:top-4 self-start"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target as HTMLElement).closest('[role="dialog"]')) { e.stopPropagation(); onCloseRef.current(); }
      }}
    >
      <div className="flex items-start justify-between gap-2 px-4 py-3 border-b border-line">
        <div className="min-w-0">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-base font-semibold text-fg truncate outline-none">
            {title}
          </h2>
          {subtitle && <p className="text-xs text-fg-subtle truncate">{subtitle}</p>}
        </div>
        <button type="button" onClick={onClose} className="btn-ghost p-1 rounded shrink-0" aria-label={t('dt_close_details')}>
          <X size={16} className="text-fg-subtle" />
        </button>
      </div>
      {actions && <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b border-line bg-surface-2/60">{actions}</div>}
      <div className="px-4 py-4 space-y-4 text-sm">{children}</div>
    </aside>
  );
}
