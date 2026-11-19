/**
 * List of the contacts page: a listbox with the columns "Name" and
 * "Kontaktinformationen" (contacts, contact lists and address-book entries share
 * it). Roving focus: one tab stop, ↑/↓/Home/End move, Enter/Space select (click too).
 */
import { useRef, type ReactNode } from 'react';
import { nextRovingIndex } from '../../lib/toolbarNav.js';

export interface EntryRow {
  id: string;
  name: string;
  /** Primary e-mail / phone (or the member count of a list) */
  info: string[];
  avatar: ReactNode;
}

interface Props {
  label: string;
  rows: readonly EntryRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  empty: string;
}

export function EntryList({ label, rows, selectedId, onSelect, empty }: Props) {
  const listRef = useRef<HTMLUListElement>(null);
  if (rows.length === 0) return <p className="py-8 text-center text-fg-subtle text-sm">{empty}</p>;

  const stopIndex = Math.max(0, rows.findIndex((r) => r.id === selectedId));
  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const options = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const current = options.findIndex((o) => o === document.activeElement);
    const next = nextRovingIndex(current, e.key, options.length, 'vertical');
    if (next === null) return;
    e.preventDefault();
    options[next]?.focus();
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div aria-hidden="true" className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle border-b border-line">
        <span>Name</span>
        <span>Kontaktinformationen</span>
      </div>
      <ul ref={listRef} role="listbox" aria-label={label} onKeyDown={onKeyDown} className="flex-1 overflow-y-auto">
        {rows.map((r, i) => {
          const selected = r.id === selectedId;
          return (
            <li
              key={r.id} role="option" aria-selected={selected} tabIndex={i === stopIndex ? 0 : -1}
              onClick={() => onSelect(r.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.id); } }}
              className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 px-4 py-2 border-b border-line cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent hover:bg-surface-2 transition-colors ${selected ? 'bg-accent/10' : ''}`}
            >
              <span className="flex items-center gap-3 min-w-0">
                {r.avatar}
                <span className="text-sm font-medium text-fg truncate">{r.name}</span>
              </span>
              <span className="min-w-0 text-xs text-fg-muted">
                {r.info.map((line, k) => <span key={k} className="block truncate">{line}</span>)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
