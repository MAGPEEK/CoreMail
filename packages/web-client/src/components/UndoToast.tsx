import toast from 'react-hot-toast';

interface UndoOptions {
  message: string;
  onUndo: () => void | Promise<unknown>;
  duration?: number;
}

/**
 * Zeigt einen Toast mit „Rückgängig"-Button.
 * Der Toast verschwindet nach `duration` ms automatisch.
 */
export function showUndoToast({ message, onUndo, duration = 5000 }: UndoOptions): void {
  toast.custom((t) => (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 bg-gray-900 text-white rounded-md shadow-lg text-sm ${
        t.visible ? 'animate-in fade-in slide-in-from-top-2' : 'animate-out fade-out'
      }`}
      style={{ minWidth: 280 }}
    >
      <span className="flex-1">{message}</span>
      <button
        onClick={() => {
          void onUndo();
          toast.dismiss(t.id);
        }}
        className="font-semibold text-blue-300 hover:text-blue-200 transition-colors"
      >
        Rückgängig
      </button>
      <button
        onClick={() => toast.dismiss(t.id)}
        className="text-gray-400 hover:text-white"
        aria-label="Schließen"
      >
        ×
      </button>
    </div>
  ), { duration });
}
