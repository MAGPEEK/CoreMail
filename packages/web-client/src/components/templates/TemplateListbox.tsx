/**
 * 10.1: list of the user's mail templates (picker and manager). One tab stop
 * (role listbox, aria-activedescendant): ↑ / ↓ / Home / End move the selection,
 * Enter and double-click run `onActivate`. Each entry shows the name and the
 * subject (or the start of the text).
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { FileText } from 'lucide-react';
import { stepSelection, type TemplateSummary } from '../../lib/mailTemplates.js';
import { useT } from '../../i18n/useT.js';

interface Props {
  id: string;
  label: string;
  templates: TemplateSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onActivate?: (id: string) => void;
}

export const optionDomId = (listId: string, templateId: string) => `${listId}-opt-${templateId}`;

/** Key handling shared with the search field of the picker (↑ / ↓ there move the list). */
export function listKeyDown(e: KeyboardEvent, p: Pick<Props, 'templates' | 'selectedId' | 'onSelect' | 'onActivate'>): void {
  if (e.key === 'Enter' && p.selectedId && p.onActivate) { e.preventDefault(); p.onActivate(p.selectedId); return; }
  const next = stepSelection(p.templates, p.selectedId, e.key);
  if (next === null) return;
  e.preventDefault();
  p.onSelect(next);
}

export function TemplateListbox({ id, label, templates, selectedId, onSelect, onActivate }: Props) {
  const t = useT();
  const listRef = useRef<HTMLUListElement>(null);
  // keep the selected entry in view while the keyboard moves it
  useEffect(() => {
    if (!selectedId) return;
    document.getElementById(optionDomId(id, selectedId))?.scrollIntoView({ block: 'nearest' });
  }, [id, selectedId]);

  return (
    <ul
      ref={listRef}
      id={id}
      role="listbox"
      tabIndex={0}
      aria-label={label}
      {...(selectedId ? { 'aria-activedescendant': optionDomId(id, selectedId) } : {})}
      onKeyDown={(e) => listKeyDown(e, { templates, selectedId, onSelect, ...(onActivate ? { onActivate } : {}) })}
      className="flex-1 min-h-0 overflow-y-auto py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-fg rounded"
    >
      {templates.map((tpl) => {
        const selected = tpl.id === selectedId;
        return (
          <li
            key={tpl.id}
            id={optionDomId(id, tpl.id)}
            role="option"
            aria-selected={selected}
            onClick={() => { onSelect(tpl.id); listRef.current?.focus(); }}
            onDoubleClick={() => onActivate?.(tpl.id)}
            className={`flex items-start gap-2.5 px-3 py-2 min-h-[44px] cursor-pointer border-l-2 ${
              selected ? 'bg-accent/10 border-accent' : 'border-transparent hover:bg-surface-2'
            }`}
          >
            <FileText size={16} aria-hidden="true" className={`mt-0.5 shrink-0 ${selected ? 'text-accent-fg' : 'text-fg-subtle'}`} />
            <span className="min-w-0">
              <span className={`block text-sm truncate ${selected ? 'font-semibold text-fg' : 'text-fg'}`}>{tpl.name}</span>
              <span className="block text-xs text-fg-muted truncate">{tpl.subject || tpl.preview || t('compose_no_subject')}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
