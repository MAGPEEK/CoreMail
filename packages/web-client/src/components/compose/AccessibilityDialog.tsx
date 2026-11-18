/**
 * 9.4: "…" → Auf Barrierefreiheitsprobleme prüfen — the issues of the body
 * (lib/composeA11y.ts) as a list; "Anzeigen" closes the dialog and puts the
 * cursor at the issue (scrolled into view).
 */
import { useId } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Modal } from '../Modal.js';
import type { A11yIssue } from '../../lib/composeA11y.js';
import { fmt, useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';

interface Props {
  issues: A11yIssue[];
  onShow: (issue: A11yIssue) => void;
  onClose: () => void;
}

export function AccessibilityDialog({ issues, onShow, onClose }: Props) {
  const t = useT();
  const id = useId();
  const title = (issue: A11yIssue) => fmt(t(`compose_a11y_${issue.kind}` as TranslationKey), { ratio: String(issue.ratio ?? '') });
  return createPortal(
    <Modal
      onClose={onClose}
      labelledBy={`${id}-title`}
      overlayClassName="fixed inset-0 z-[200] flex items-center justify-center bg-scrim/40 p-4"
      className="bg-surface rounded-lg shadow-xl w-[480px] max-w-full max-h-[80vh] flex flex-col"
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-line shrink-0">
        <h3 id={`${id}-title`} className="text-base font-semibold text-fg">{t('compose_a11y_title')}</h3>
        <button type="button" onClick={onClose} aria-label={t('compose_close')} className="p-1 rounded text-fg-subtle hover:text-fg hover:bg-surface-2">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="px-5 py-4 overflow-y-auto">
        <p role="status" className="text-sm text-fg-muted mb-3">
          {issues.length ? fmt(t('compose_a11y_found'), { n: issues.length }) : t('compose_a11y_none')}
        </p>
        {issues.length > 0 && (
          <ul className="divide-y divide-line border border-line rounded">
            {issues.map((issue, i) => (
              <li key={`${issue.kind}-${issue.pos}-${i}`} className="flex items-center gap-3 px-3 py-2">
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-fg">{title(issue)}</span>
                  {issue.excerpt && <span className="block text-xs text-fg-subtle truncate">{issue.excerpt}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => onShow(issue)}
                  aria-label={`${t('compose_a11y_show')}: ${title(issue)}`}
                  className="shrink-0 px-2.5 py-1 text-sm rounded border border-line-strong text-fg hover:bg-surface-2"
                >
                  {t('compose_a11y_show')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>,
    document.body,
  );
}
