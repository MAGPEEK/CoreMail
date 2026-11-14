import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { Modal } from './Modal.js';

interface Props {
  title: string;
  description?: string;
  confirmLabel?: string;
  /** Runs the protected action with the entered password; a thrown error keeps the dialog open */
  onConfirm: (currentPassword: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Re-authentication prompt for sensitive account changes (MFA on/off, backup
 * codes, security keys). The password is sent as `currentPassword` by the caller.
 */
export function PasswordPromptDialog({ title, description, confirmLabel = 'Bestätigen', onConfirm, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(password);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aktion fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="pw-prompt-title" className="bg-white dark:bg-gray-900 rounded-lg shadow-2xl w-full max-w-sm p-5">
      <form onSubmit={submit} className="space-y-3">
        <h2 id="pw-prompt-title" className="text-base font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Lock size={15} /> {title}
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {description ?? 'Bitte bestätigen Sie diese Änderung mit Ihrem aktuellen Passwort.'}
        </p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          aria-label="Aktuelles Passwort"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input"
          placeholder="Aktuelles Passwort"
        />
        {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary text-xs">Abbrechen</button>
          <button type="submit" disabled={busy || !password} className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-50">
            {busy && <Loader2 size={12} className="animate-spin" />} {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
