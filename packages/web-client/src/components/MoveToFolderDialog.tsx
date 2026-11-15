import { useMemo, useState } from 'react';
import { Folder as FolderIcon } from 'lucide-react';
import { Modal } from './Modal.js';
import type { Folder } from '../api/types.js';
import { useT } from '../i18n/useT.js';

/** Keyboard-friendly folder picker for "Move to …" (shortcut `v`). */
export function MoveToFolderDialog({
  folders, excludeFolderId, onPick, onClose,
}: {
  folders: Folder[];
  excludeFolderId?: string | null;
  onPick: (folderId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return folders
      .filter((f) => f.id !== excludeFolderId)
      .filter((f) => !needle || (f.displayName ?? f.name).toLowerCase().includes(needle) || f.name.toLowerCase().includes(needle));
  }, [folders, excludeFolderId, q]);
  const idx = Math.min(active, Math.max(0, list.length - 1));

  const pick = (f: Folder | undefined) => { if (f) { onPick(f.id); onClose(); } };

  return (
    <Modal
      onClose={onClose}
      labelledBy="move-dialog-title"
      className="bg-white dark:bg-gray-900 rounded-lg shadow-2xl w-full max-w-sm flex flex-col max-h-[70vh]"
    >
      <div className="px-4 pt-4 pb-2">
        <h2 id="move-dialog-title" className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2">{t('move_dialog_title')}</h2>
        <input
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, list.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(list[idx]); }
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="move-dialog-list"
          aria-activedescendant={list[idx] ? `move-opt-${list[idx]!.id}` : undefined}
          placeholder={t('move_dialog_filter')}
          className="w-full px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 dark:text-gray-100 outline-none focus:border-accent"
        />
      </div>
      <ul id="move-dialog-list" role="listbox" aria-labelledby="move-dialog-title" className="flex-1 overflow-y-auto pb-2">
        {list.length === 0 && <li className="px-4 py-3 text-xs text-gray-500">{t('move_dialog_none')}</li>}
        {list.map((f, i) => (
          <li
            key={f.id}
            id={`move-opt-${f.id}`}
            role="option"
            aria-selected={i === idx}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => { e.preventDefault(); pick(f); }}
            className={`px-4 py-1.5 text-sm flex items-center gap-2 cursor-pointer ${
              i === idx ? 'bg-accent/10 text-accent' : 'text-gray-700 dark:text-gray-200'
            }`}
          >
            <FolderIcon size={14} style={f.color ? { color: f.color } : undefined} aria-hidden="true" />
            <span className="truncate">{f.displayName ?? f.name}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
