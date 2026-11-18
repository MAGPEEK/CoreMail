/**
 * 9.4: "…" → Auf Barrierefreiheitsprobleme prüfen — the issues of the body
 * (lib/composeA11y.ts) as a list; "Anzeigen" closes the dialog and puts the
 * cursor at the issue (scrolled into view).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Modal } from '../Modal.js';
import { altTextToApply, type A11yIssue } from '../../lib/composeA11y.js';
import { fmt, useT } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';

interface Props {
  issues: A11yIssue[];
  onShow: (issue: A11yIssue) => void;
  /** Sets the alt attribute of the picture at `pos` ('' = decorative). */
  onApplyAlt: (pos: number, alt: string) => void;
  onClose: () => void;
}

const CHECKBOX = 'h-4 w-4 rounded border-line-strong text-accent focus-visible:ring-2 focus-visible:ring-accent-fg';

/** Alternative text of one picture: a text input, "Dekorativ" and "Übernehmen". */
function ImageAltForm({ pos, onApply }: { pos: number; onApply: (pos: number, alt: string) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [decorative, setDecorative] = useState(false);
  const alt = altTextToApply(text, decorative);
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2"
      onSubmit={(e) => { e.preventDefault(); if (alt !== null) onApply(pos, alt); }}
    >
      <label className="flex-1 min-w-[10rem] text-xs text-fg-muted">
        {t('compose_a11y_alt_label')}
        <input
          value={text}
          disabled={decorative}
          onChange={(e) => setText(e.target.value)}
          className="mt-0.5 w-full text-sm bg-surface text-fg rounded px-2 py-1 border border-line-strong disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
        />
      </label>
      <label className="flex items-center gap-1.5 text-sm text-fg">
        <input type="checkbox" className={CHECKBOX} checked={decorative} onChange={(e) => setDecorative(e.target.checked)} />
        {t('compose_a11y_decorative')}
      </label>
      <button
        type="submit"
        disabled={alt === null}
        className="px-2.5 py-1 text-sm rounded border border-line-strong text-fg hover:bg-surface-2 disabled:opacity-50"
      >
        {t('compose_a11y_apply')}
      </button>
    </form>
  );
}

export function AccessibilityDialog({ issues, onShow, onApplyAlt, onClose }: Props) {
  const t = useT();
  const id = useId();
  // after a check was re-run (alt text applied) the focused field is gone: focus stays inside the dialog
  const summary = useRef<HTMLParagraphElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    summary.current?.focus();
  }, [issues]);
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
        <p ref={summary} tabIndex={-1} role="status" className="text-sm text-fg-muted mb-3 outline-none">
          {issues.length ? fmt(t('compose_a11y_found'), { n: issues.length }) : t('compose_a11y_none')}
        </p>
        {issues.length > 0 && (
          <ul className="divide-y divide-line border border-line rounded">
            {issues.map((issue, i) => (
              <li key={`${issue.kind}-${issue.pos}-${i}`} className="px-3 py-2">
                <div className="flex items-center gap-3">
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
                </div>
                {issue.kind === 'imageAlt' && <ImageAltForm pos={issue.pos} onApply={onApplyAlt} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>,
    document.body,
  );
}
