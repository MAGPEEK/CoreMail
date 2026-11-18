import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Modal } from './Modal.js';

export interface PromptDialogProps {
  title: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
  /** Validation hook; returns error text or null if ok */
  validate?: (value: string) => string | null;
  /** Error text for an empty value */
  requiredText?: string;
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
  requiredText = 'Bitte einen Namen eingeben',
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-Focus + Auto-Select (Escape + focus handling: Modal)
    const t = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const handleConfirm = async () => {
    const v = value.trim();
    if (!v) { setError(requiredText); return; }
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
    <Modal
      onClose={onCancel}
      labelledBy="prompt-dialog-title"
      overlayClassName="fixed inset-0 z-[200] flex items-center justify-center bg-scrim/40"
      className="bg-surface rounded-lg shadow-xl w-[420px] max-w-[90vw]"
    >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <h3 id="prompt-dialog-title" className="text-base font-semibold text-fg">{title}</h3>
          <button onClick={onCancel} aria-label="Schließen" className="text-fg-subtle hover:text-fg-muted">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4">
          {label && <label className="block text-sm text-fg-muted mb-1.5">{label}</label>}
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleConfirm(); }}
            className="w-full px-3 py-2 border border-line-strong rounded-md bg-surface text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent-fg"
          />
          {error && <p className="text-xs text-danger-fg mt-1.5">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 bg-surface-2 rounded-b-lg">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-2 rounded disabled:opacity-50"
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
    </Modal>,
    document.body,
  );
}
