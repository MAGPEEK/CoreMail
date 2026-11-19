/**
 * Searchable folder picker ("Ordner freigeben…"): ARIA combobox with a listbox,
 * type-ahead over folder paths, ArrowUp/Down + Enter, Escape cancels.
 */
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { MAX_FOLDER_HITS, moveHighlight, searchFolders, type FolderChoice } from '../lib/folderPicker.js';

export function FolderPicker({ choices, onPick, onCancel }: {
  choices: readonly FolderChoice[];
  onPick: (folderId: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const hits = useMemo(() => searchFolders(choices, query), [choices, query]);
  const optionId = (i: number) => `${id}-opt-${i}`;
  const active = hits[highlight];

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(moveHighlight(highlight, hits.length, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active) onPick(active.id);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div className="border border-line rounded-lg p-3 space-y-2">
      <label htmlFor={`${id}-input`} className="field-label">Ordner suchen</label>
      <input
        id={`${id}-input`} className="input w-full" autoFocus autoComplete="off"
        role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
        {...(active ? { 'aria-activedescendant': optionId(highlight) } : {})}
        placeholder="Name oder Pfad eingeben"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
        onKeyDown={onKeyDown}
      />
      <p className="text-xs text-fg-subtle" role="status" aria-live="polite">
        {hits.length === 0
          ? 'Kein Ordner gefunden.'
          : hits.length >= MAX_FOLDER_HITS
            ? `Die ersten ${MAX_FOLDER_HITS} Treffer – Suche eingrenzen, um weitere zu sehen.`
            : `${hits.length} Ordner gefunden.`}
      </p>
      <ul id={`${id}-list`} role="listbox" aria-label="Ordner" className="border border-line rounded divide-y divide-line max-h-48 overflow-y-auto">
        {hits.map((c, i) => (
          <li key={c.id} id={optionId(i)} role="option" aria-selected={i === highlight}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(c.id)}
            onMouseMove={() => setHighlight(i)}
            className={`px-3 py-1.5 text-sm cursor-pointer ${i === highlight ? 'bg-accent/10 text-accent-fg' : 'text-fg hover:bg-surface-2'}`}>
            <span className="font-medium">{c.label}</span>
            {c.path !== c.label && <span className="block text-xs text-fg-subtle truncate">{c.path}</span>}
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <button type="button" onClick={onCancel} className="btn-secondary">Abbrechen</button>
      </div>
    </div>
  );
}
