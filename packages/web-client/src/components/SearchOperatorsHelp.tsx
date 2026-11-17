import { useEffect, useRef, useState } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import type { SearchChip } from '../api/types.js';

/** Operators understood by GET /mail/search (api-gateway lib/search-query.ts). */
const OPERATORS: { example: string; insert: string; label: TranslationKey }[] = [
  { example: 'from:anna', insert: 'from:', label: 'search_op_from' },
  { example: 'to:bob@example.com', insert: 'to:', label: 'search_op_to' },
  { example: 'cc:carl@example.com', insert: 'cc:', label: 'search_op_cc' },
  { example: 'subject:invoice', insert: 'subject:', label: 'search_op_subject' },
  { example: 'has:attachment', insert: 'has:attachment', label: 'search_op_has' },
  { example: 'is:unread', insert: 'is:unread', label: 'search_op_unread' },
  { example: 'is:flagged', insert: 'is:flagged', label: 'search_op_flagged' },
  { example: 'before:2026-01-31', insert: 'before:', label: 'search_op_before' },
  { example: 'after:2026-01-01', insert: 'after:', label: 'search_op_after' },
  { example: 'older_than:7d', insert: 'older_than:', label: 'search_op_older' },
  { example: 'newer_than:2w', insert: 'newer_than:', label: 'search_op_newer' },
  { example: 'in:sent', insert: 'in:', label: 'search_op_in' },
  { example: '"exact phrase"', insert: '""', label: 'search_op_phrase' },
  { example: '-newsletter', insert: '-', label: 'search_op_negate' },
];

const BUTTON_TONE = {
  surface: 'text-fg-subtle hover:text-accent-fg hover:bg-surface-2',
  /** On the branded header (bg-header) */
  header: 'text-header-fg hover:bg-header-overlay/20 focus-visible:outline-header-fg',
} as const;

/** "?" button next to the search field with a popover listing the operators. */
export function SearchOperatorsHelp({ onInsert, tone = 'surface' }: {
  onInsert: (token: string) => void;
  tone?: keyof typeof BUTTON_TONE;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t('search_help')}
        title={t('search_help')}
        className={`p-1 rounded ${BUTTON_TONE[tone]}`}
      >
        <HelpCircle size={tone === 'header' ? 16 : 14} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('search_help')}
          className="absolute right-0 top-full mt-1 w-80 bg-surface border border-line rounded-lg shadow-xl z-50 p-3 animate-fly-in origin-top-right"
        >
          <p className="text-xs font-semibold text-fg">{t('search_help')}</p>
          <p className="text-[11px] text-fg-subtle mt-0.5 mb-2">{t('search_help_intro')}</p>
          <ul className="space-y-0.5 max-h-72 overflow-y-auto">
            {OPERATORS.map((op) => (
              <li key={op.example}>
                <button
                  type="button"
                  onClick={() => { onInsert(op.insert); setOpen(false); }}
                  className="w-full flex items-center justify-between gap-2 px-1.5 py-1 rounded text-left hover:bg-surface-2"
                >
                  <code className="text-[11px] font-mono text-accent-fg">{op.example}</code>
                  <span className="text-[11px] text-fg-muted text-right">{t(op.label)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Parsed operators of the current search as removable chips. */
export function SearchChips({ chips, onRemove }: { chips: SearchChip[]; onRemove: (chip: SearchChip) => void }) {
  const t = useT();
  if (chips.length === 0) return null;
  return (
    <ul className="px-3 pb-2 flex flex-wrap gap-1" aria-label={t('search_help')}>
      {chips.map((c) => (
        <li
          key={c.raw}
          title={c.valid ? c.raw : `${c.raw} — ${t('search_chip_invalid')}`}
          className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] border ${
            !c.valid
              ? 'border-danger-line text-danger-fg bg-danger-bg line-through'
              : c.negate
                ? 'border-line-strong text-fg-muted bg-surface-2'
                : 'border-accent/40 text-accent-fg bg-accent/5'
          }`}
        >
          <span>
            {c.negate && '−'}
            {c.key === 'text' ? `"${c.value}"` : <><span className="font-semibold">{c.key}:</span>{c.value}</>}
          </span>
          <button
            type="button"
            onClick={() => onRemove(c)}
            aria-label={`${t('search_chip_remove')}: ${c.raw}`}
            className="p-0.5 rounded-full hover:bg-scrim/10"
          >
            <X size={10} />
          </button>
        </li>
      ))}
    </ul>
  );
}
