import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export interface PromptDialogProps {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
  /** Validierungs-Hook; gibt Fehlertext zurück oder null wenn ok */
  validate?: (value: string) => string | null;
}

export function PromptDialog({
  title,
  label,
  placeholder,
  initialValue = '',
  confirmText = 'OK',
  cancelText = 'Abbrechen',
  onConfirm,
  onCancel,
  validate,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-Focus + Auto-Select
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const handleConfirm = async () => {
    const v = value.trim();
    if (!v) { setError('Bitte einen Namen eingeben'); return; }
    if (validate) {
      const err = validate(v);
      if (err) { setError(err); return; }
    }
    setBusy(true);
    try {
      await onConfirm(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fehler');
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-[420px] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4">
          {label && <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1.5">{label}</label>}
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleConfirm(); }}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-accent"
          />
          {error && <p className="text-xs text-red-600 mt-1.5">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 bg-gray-50 dark:bg-gray-900/50 rounded-b-lg">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={busy}
            className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '…' : confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
