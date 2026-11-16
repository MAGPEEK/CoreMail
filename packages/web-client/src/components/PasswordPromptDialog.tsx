import { useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { Modal } from './Modal.js';

/** What the user entered: the current password or (allowMfaCode) an authenticator/backup code. */
export type ReauthKind = 'password' | 'mfa';

interface Props {
  title: string;
  description?: string;
  confirmLabel?: string;
  /**
   * v8.1: also offer "authenticator or backup code" instead of the password
   * (SSO accounts have no CoreMail password). The caller sends `mfaCode` then.
   */
  allowMfaCode?: boolean;
  /** Runs the protected action with the entered secret; a thrown error keeps the dialog open */
  onConfirm: (secret: string, kind: ReauthKind) => Promise<void>;
  onClose: () => void;
}

/**
 * Re-authentication prompt for sensitive account changes (MFA on/off, backup
 * codes, security keys, app passwords). The caller sends the password as
 * `currentPassword` (or, with allowMfaCode, the code as `mfaCode`).
 */
export function PasswordPromptDialog({ title, description, confirmLabel = 'Bestätigen', allowMfaCode = false, onConfirm, onClose }: Props) {
  const [secret, setSecret] = useState('');
  const [kind, setKind] = useState<ReauthKind>('password');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(kind === 'mfa' ? secret.trim() : secret, kind);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Aktion fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  const switchKind = () => {
    setKind((k) => (k === 'password' ? 'mfa' : 'password'));
    setSecret('');
    setError('');
  };

  return (
    <Modal onClose={onClose} labelledBy="pw-prompt-title" className="bg-surface rounded-lg shadow-2xl w-full max-w-sm p-5">
      <form onSubmit={submit} className="space-y-3">
        <h2 id="pw-prompt-title" className="text-base font-semibold text-fg flex items-center gap-2">
          <Lock size={15} /> {title}
        </h2>
        <p className="text-xs text-fg-subtle">
          {kind === 'mfa'
            ? 'Bitte bestätigen Sie diese Änderung mit einem Code aus Ihrer Authenticator-App oder einem Backup-Code.'
            : (description ?? 'Bitte bestätigen Sie diese Änderung mit Ihrem aktuellen Passwort.')}
        </p>
        {kind === 'mfa' ? (
          <input
            key="mfa"
            type="text"
            inputMode="text"
            autoFocus
            autoComplete="one-time-code"
            aria-label="Authenticator- oder Backup-Code"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="input font-mono tracking-wider"
            placeholder="123456 oder XXXX-XXXX"
          />
        ) : (
          <input
            key="password"
            type="password"
            autoFocus
            autoComplete="current-password"
            aria-label="Aktuelles Passwort"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="input"
            placeholder="Aktuelles Passwort"
          />
        )}
        {allowMfaCode && (
          <button type="button" onClick={switchKind} className="text-xs text-accent-fg hover:underline">
            {kind === 'mfa' ? 'Stattdessen Passwort verwenden' : 'Stattdessen Authenticator- oder Backup-Code verwenden'}
          </button>
        )}
        {error && <p role="alert" className="text-xs text-danger-fg">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary text-xs">Abbrechen</button>
          <button type="submit" disabled={busy || !secret} className="btn-primary text-xs flex items-center gap-1.5 disabled:opacity-50">
            {busy && <Loader2 size={12} className="animate-spin" />} {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
