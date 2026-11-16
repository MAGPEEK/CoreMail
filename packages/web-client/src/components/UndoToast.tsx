import toast from 'react-hot-toast';
import { toastError } from '../lib/errors.js';
import { createUndoStack, UNDO_TTL_MS } from '../lib/undo-stack.js';
import { translate } from '../i18n/useT.js';

interface UndoOptions {
  message: string;
  onUndo: () => void | Promise<unknown>;
  duration?: number;
}

/** Live undo entries — `z` / Ctrl+Z (shortcut "undo") runs the newest one. */
const undoStack = createUndoStack();
const toastIdByEntry = new Map<string, string>();

function runUndo(onUndo: () => void | Promise<unknown>): void {
  // A failed undo must be visible (toastError is deduplicated per message)
  Promise.resolve()
    .then(onUndo)
    .then(() => { toast.success(translate('undo_done'), { duration: 2000 }); })
    .catch(toastError);
}

/**
 * Shows a toast with an "Undo" button for `duration` ms (default 8 s, OWA).
 * The action is also registered for the keyboard undo (`z`).
 */
export function showUndoToast({ message, onUndo, duration = UNDO_TTL_MS }: UndoOptions): void {
  const entry = undoStack.push(message, onUndo, duration);
  const id = toast.custom((t) => (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-3 px-4 py-2.5 bg-surface text-fg border border-line rounded-md shadow-lg text-sm ${
        t.visible ? 'animate-in fade-in slide-in-from-top-2' : 'animate-out fade-out'
      }`}
      style={{ minWidth: 280 }}
    >
      <span className="flex-1">{message}</span>
      <button
        onClick={() => {
          toast.dismiss(t.id);
          toastIdByEntry.delete(entry.id);
          if (undoStack.remove(entry.id)) runUndo(onUndo);
        }}
        aria-keyshortcuts="Z"
        className="font-semibold text-accent-fg hover:underline transition-colors"
      >
        {translate('undo')}
      </button>
      <button
        onClick={() => { toast.dismiss(t.id); toastIdByEntry.delete(entry.id); undoStack.remove(entry.id); }}
        className="text-fg-subtle hover:text-fg"
        aria-label={translate('close')}
      >
        ×
      </button>
    </div>
  ), { duration });
  toastIdByEntry.set(entry.id, id);
}

/** Keyboard undo: reverts the newest action whose toast is still live. */
export function triggerLatestUndo(): boolean {
  const entry = undoStack.takeLatest();
  if (!entry) {
    toast(translate('undo_nothing'), { duration: 1500 });
    return false;
  }
  const tid = toastIdByEntry.get(entry.id);
  if (tid) toast.dismiss(tid);
  toastIdByEntry.delete(entry.id);
  runUndo(entry.undo as () => void | Promise<unknown>);
  return true;
}
