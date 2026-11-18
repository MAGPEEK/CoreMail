import toast from 'react-hot-toast';
import { tooLargeText } from './errorTexts.js';
import { useLanguageStore } from '../store/language.js';

/** Error with the machine-readable code of the auth/API error body (e.g. REAUTH_FAILED). */
export class ApiError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// Readable texts for the error codes of the auth API contract
const CODE_MESSAGES: Record<string, string> = {
  MFA_INVALID_CODE:        'Der Code ist ungültig.',
  MFA_CHALLENGE_EXHAUSTED: 'Zu viele Fehlversuche. Bitte melden Sie sich erneut an.',
  REAUTH_REQUIRED:         'Bitte bestätigen Sie die Änderung mit Ihrem aktuellen Passwort.',
  REAUTH_FAILED:           'Das Passwort ist falsch.',
  REAUTH_LOCKED:           'Zu viele Fehlversuche. Bitte warten Sie einige Minuten.',
  TOTP_ALREADY_ENABLED:    'Die Zwei-Faktor-Authentifizierung ist bereits aktiv.',
  MFA_NOT_VERIFIED:        'Diese Aktion erfordert eine Anmeldung mit zweitem Faktor.',
  SESSION_REVOKED:         'Ihre Sitzung wurde beendet. Bitte melden Sie sich erneut an.',
  REFRESH_INVALID:         'Sitzung abgelaufen',
  REFRESH_EXPIRED:         'Sitzung abgelaufen',
  REFRESH_REUSED:          'Sitzung abgelaufen',
  REFRESH_INACTIVE:        'Sitzung abgelaufen',
  // 9.4: the Webmail protocol switch is off for the account
  PROTOCOL_DISABLED:       'Webmail ist für dieses Konto deaktiviert. Bitte wenden Sie sich an Ihren Administrator.',
};

/**
 * Builds an ApiError from a JSON error body. Understands `{ error, code, message }`
 * where `error` may itself be a code (e.g. `{ error: 'MFA_INVALID_CODE' }`).
 */
export function apiErrorFromBody(body: unknown, status: number, fallback = `HTTP ${status}`): ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; code?: unknown; message?: unknown };
  const error = typeof b.error === 'string' ? b.error : undefined;
  const code = typeof b.code === 'string' ? b.code
    : error && /^[A-Z][A-Z0-9_]+$/.test(error) ? error : undefined;
  if (status === 429 && !code) return new ApiError('Zu viele Versuche. Bitte warten Sie kurz.', 'RATE_LIMITED', status);
  // 9.4: message / draft over the size limit (body: { maxBytes }) — say what to do, in the UI language
  if (status === 413 && !code) {
    return new ApiError(tooLargeText((b as { maxBytes?: unknown }).maxBytes, useLanguageStore.getState().lang), 'MESSAGE_TOO_LARGE', status);
  }
  const known = code ? CODE_MESSAGES[code] : undefined;
  const message = known
    ?? (typeof b.message === 'string' && b.message ? b.message : undefined)
    ?? error
    ?? fallback;
  return new ApiError(message, code, status);
}

/** Human-readable message of an unknown error value. */
export function errorMessage(err: unknown, fallback = 'Unbekannter Fehler'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/** Shows an error toast; usable directly as `.catch(toastError)`. Deduplicated per message. */
export function toastError(err: unknown): void {
  const msg = errorMessage(err);
  // Redirects after an expired session are not worth a toast
  if (msg === 'Session expired' || msg === 'Sitzung abgelaufen') return;
  toast.error(msg, { id: `err:${msg}` });
}
