import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { verifyMfa, verifyMfaWebAuthn, startMfaWebAuthn, type MfaMethod } from '../api/client.js';
import { ApiError } from '../lib/errors.js';
import { webauthnAuthenticate, webauthnErrorMessage, webauthnSupported } from '../lib/webauthn.js';

type Tokens = { accessToken: string; refreshToken: string };
type Mode = 'totp' | 'backup' | 'webauthn';

interface Props {
  challengeToken: string;
  /** Method announced by /auth/login ('totp' | 'webauthn') */
  method: string;
  /** All second factors of the user (login response `methods`); falls back to `method` */
  methods?: MfaMethod[] | undefined;
  email: string;
  onSuccess: (tokens: Tokens) => Promise<void>;
  /** Back to the password step; `reason` is shown there (e.g. too many failed codes) */
  onBack: (reason?: string) => void;
}

const EMPTY_DIGITS = ['', '', '', '', '', ''];

/** Normalises a typed backup code: letters, digits and dashes only. */
function cleanBackupCode(v: string): string {
  return v.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
}

/**
 * Second login step: 6-digit TOTP, backup code (letters/digits/dashes) or a
 * WebAuthn security key, depending on the user's MFA setup.
 */
export function MfaChallengeForm({ challengeToken, method, methods, email, onSuccess, onBack }: Props) {
  const available: MfaMethod[] = methods && methods.length > 0
    ? methods
    : [method === 'webauthn' ? 'webauthn' : 'totp', 'backup_code'];
  const hasTotp = available.includes('totp');
  const canWebAuthn = available.includes('webauthn') && webauthnSupported();
  const [mode, setMode] = useState<Mode>(canWebAuthn ? 'webauthn' : hasTotp ? 'totp' : 'backup');
  const [digits, setDigits] = useState<string[]>(EMPTY_DIGITS);
  const [backupCode, setBackupCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const digitRefs = useRef<(HTMLInputElement | null)[]>([]);
  const backupRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (mode === 'totp') digitRefs.current[0]?.focus();
      if (mode === 'backup') backupRef.current?.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [mode]);

  const run = async (fn: () => Promise<Tokens>, onFail?: () => void) => {
    setError('');
    setLoading(true);
    try {
      await onSuccess(await fn());
    } catch (err) {
      // After 5 failed codes the challenge is dead → back to the password step
      if (err instanceof ApiError && err.code === 'MFA_CHALLENGE_EXHAUSTED') {
        onBack(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : 'Überprüfung fehlgeschlagen');
      onFail?.();
    } finally {
      setLoading(false);
    }
  };

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'totp') {
      const code = digits.join('');
      if (code.length < 6) { setError('Bitte alle 6 Ziffern eingeben'); return; }
      void run(() => verifyMfa(challengeToken, code), () => {
        setDigits(EMPTY_DIGITS);
        setTimeout(() => digitRefs.current[0]?.focus(), 50);
      });
    } else if (mode === 'backup') {
      const code = backupCode.trim();
      if (code.length < 6) { setError('Bitte den vollständigen Backup-Code eingeben'); return; }
      void run(() => verifyMfa(challengeToken, code), () => backupRef.current?.select());
    }
  };

  const signInWithKey = () => {
    void run(async () => {
      try {
        const options = await startMfaWebAuthn(challengeToken);
        const assertion = await webauthnAuthenticate(options);
        return await verifyMfaWebAuthn(challengeToken, assertion);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new Error(webauthnErrorMessage(err));
      }
    });
  };

  const handleDigitChange = (i: number, val: string) => {
    const digit = val.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[i] = digit;
    setDigits(next);
    if (digit && i < 5) digitRefs.current[i + 1]?.focus();
  };

  const handleDigitKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) digitRefs.current[i - 1]?.focus();
  };

  const handleDigitPaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      setDigits(pasted.split(''));
      digitRefs.current[5]?.focus();
    }
  };

  const switchMode = (m: Mode) => { setMode(m); setError(''); };

  return (
    <form onSubmit={submitCode} className="space-y-5">
      <div className="text-center">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {mode === 'totp' && 'Geben Sie den 6-stelligen Code aus Ihrer Authenticator-App ein.'}
          {mode === 'backup' && 'Geben Sie einen Ihrer Backup-Codes ein. Jeder Code ist nur einmal gültig.'}
          {mode === 'webauthn' && 'Melden Sie sich mit Ihrem Sicherheitsschlüssel oder Passkey an.'}
        </p>
        <p className="text-xs text-gray-400 mt-1">{email}</p>
      </div>

      {mode === 'totp' && (
        <div className="flex justify-center gap-2" onPaste={handleDigitPaste}>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => { digitRefs.current[i] = el; }}
              type="text"
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              aria-label={`Ziffer ${i + 1}`}
              maxLength={1}
              value={d}
              onChange={(e) => handleDigitChange(i, e.target.value)}
              onKeyDown={(e) => handleDigitKeyDown(i, e)}
              className="w-10 h-12 text-center text-xl font-bold border-2 rounded-lg focus:outline-none focus:border-accent transition-colors"
              style={{ borderColor: d ? 'var(--color-accent)' : undefined }}
            />
          ))}
        </div>
      )}

      {mode === 'backup' && (
        <input
          ref={backupRef}
          type="text"
          value={backupCode}
          onChange={(e) => setBackupCode(cleanBackupCode(e.target.value))}
          autoComplete="one-time-code"
          spellCheck={false}
          aria-label="Backup-Code"
          placeholder="z. B. ABCD-1234"
          className="input text-center font-mono tracking-wider"
        />
      )}

      {mode === 'webauthn' && (
        <button
          type="button"
          onClick={signInWithKey}
          disabled={loading}
          className="btn-primary w-full justify-center py-2 disabled:opacity-60"
        >
          <KeyRound size={15} /> {loading ? 'Warte auf Schlüssel…' : 'Mit Sicherheitsschlüssel anmelden'}
        </button>
      )}

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700 text-center">
          {error}
        </div>
      )}

      {mode !== 'webauthn' && (
        <button
          type="submit"
          disabled={loading || (mode === 'totp' ? digits.join('').length < 6 : backupCode.trim().length < 6)}
          className="btn-primary w-full justify-center py-2 disabled:opacity-60"
        >
          {loading ? 'Prüfen...' : 'Bestätigen'}
        </button>
      )}

      <div className="flex flex-col items-center gap-1 text-xs">
        {mode !== 'backup' && (
          <button type="button" onClick={() => switchMode('backup')} className="text-accent hover:underline">
            Backup-Code verwenden
          </button>
        )}
        {mode !== 'totp' && hasTotp && (
          <button type="button" onClick={() => switchMode('totp')} className="text-accent hover:underline">
            Code aus der Authenticator-App verwenden
          </button>
        )}
        {mode !== 'webauthn' && canWebAuthn && (
          <button type="button" onClick={() => switchMode('webauthn')} className="text-accent hover:underline">
            Sicherheitsschlüssel verwenden
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => onBack()}
        className="w-full flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 py-1"
      >
        <ArrowLeft size={13} /> Zurück zur Anmeldung
      </button>
    </form>
  );
}
