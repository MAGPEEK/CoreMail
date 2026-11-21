/**
 * Sets a new password with a reset link (10.6, docs/password-reset.md). For an
 * account with a second factor the page also asks for a TOTP or backup code —
 * a wrong code keeps the link usable (the server burns it after 5 wrong codes).
 */
import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { Lock, CheckCircle, XCircle, Eye, EyeOff, KeyRound, ArrowLeft, ShieldCheck } from 'lucide-react';
import { api } from '../api/client.js';
import { ApiError } from '../lib/errors.js';
import { AuthShell, AuthBrandHeader } from '../components/AuthShell.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';

const STRENGTH_KEYS: TranslationKey[] = ['sspr_strength_1', 'sspr_strength_2', 'sspr_strength_3', 'sspr_strength_4', 'sspr_strength_5'];

function PasswordStrengthBar({ password, minLen }: { password: string; minLen: number }) {
  const t = useT();
  const len = password.length;
  let score = 0;
  if (len >= minLen)  score++;
  if (len >= 12)      score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  const colors  = ['', 'bg-danger', 'bg-warning', 'bg-warning', 'bg-success', 'bg-success'];
  const widths  = ['', 'w-1/5', 'w-2/5', 'w-3/5', 'w-4/5', 'w-full'];

  if (!password) return null;
  return (
    <div className="mt-1 space-y-1">
      <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden" aria-hidden="true">
        <div className={`h-full rounded-full transition-all ${colors[score]} ${widths[score]}`} />
      </div>
      {score > 0 && <p className="text-xs text-fg-subtle">{t(STRENGTH_KEYS[score - 1]!)}</p>}
    </div>
  );
}

interface VerifyAnswer { valid?: boolean; mfaRequired?: boolean; methods?: string[] }

export function ResetPasswordPage() {
  const t = useT();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  // Read the reset token once, then remove it from the address bar (history,
  // screenshots, Referer of later requests) — it stays in component state only.
  const [token] = useState(() => searchParams.get('token') ?? '');
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const [tokenValid, setTokenValid]   = useState<boolean | null>(null); // null = loading
  const [mfaRequired, setMfaRequired] = useState(false);
  const [totpOffered, setTotpOffered] = useState(false);
  const [password, setPassword]       = useState('');
  const [confirm, setConfirm]         = useState('');
  const [mfaCode, setMfaCode]         = useState('');
  const [showPw, setShowPw]           = useState(false);
  const [loading, setLoading]         = useState(false);
  const [success, setSuccess]         = useState(false);
  const [error, setError]             = useState('');
  // Strength-bar reference only — the server enforces the real policy minimum
  const minLen = 8;

  useEffect(() => {
    if (!token) { setTokenValid(false); return; }
    // POST with the token in the body — never in a URL (proxy/access logs)
    fetch('/auth/reset-password/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((r) => r.json())
      .then((d: VerifyAnswer) => {
        setTokenValid(d.valid ?? false);
        setMfaRequired(d.mfaRequired === true);
        setTotpOffered((d.methods ?? []).includes('totp'));
      })
      .catch(() => setTokenValid(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) { setError(t('sspr_enter_pw')); return; }
    if (password !== confirm) { setError(t('sspr_mismatch')); return; }
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/reset-password', { token, newPassword: password, ...(mfaRequired ? { mfaCode: mfaCode.trim() } : {}) });
      setSuccess(true);
      setTimeout(() => navigate('/login'), 3000);
    } catch (err: unknown) {
      if (err instanceof ApiError && (err.code === 'INVALID_TOKEN' || err.code === 'MFA_LOCKED')) {
        setTokenValid(false);
        return;
      }
      if (err instanceof ApiError && err.code === 'MFA_INVALID') setMfaCode('');
      setError(err instanceof Error ? err.message : t('sspr_failed'));
    } finally {
      setLoading(false);
    }
  };

  const mfaMissing = mfaRequired && mfaCode.trim().length < 6;

  return (
    <AuthShell>
      <div className="bg-surface rounded-lg shadow-2xl p-8 w-full max-w-sm">
        <AuthBrandHeader
          subtitle={t('sspr_reset_subtitle')}
          icon={
            <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
              <KeyRound size={22} className="text-white" aria-hidden="true" />
            </div>
          }
        />

        {tokenValid === null && (
          <div className="text-center py-8" role="status" aria-live="polite">
            <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" aria-hidden="true" />
            <p className="text-sm text-fg-subtle mt-3">{t('sspr_checking')}</p>
          </div>
        )}

        {tokenValid === false && !success && (
          <div className="text-center space-y-4" role="alert">
            <XCircle size={48} className="mx-auto text-danger-fg" aria-hidden="true" />
            <h2 className="font-semibold text-fg">{t('sspr_invalid_title')}</h2>
            <p className="text-sm text-fg-muted">{t('sspr_invalid_text')}</p>
            <Link to="/forgot-password" className="btn-primary w-full justify-center py-2 text-sm">
              {t('sspr_request_new')}
            </Link>
            <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm text-fg-subtle hover:text-fg-muted py-1">
              <ArrowLeft size={13} aria-hidden="true" /> {t('sspr_back_to_login')}
            </Link>
          </div>
        )}

        {success && (
          <div className="text-center space-y-4" role="status" aria-live="polite">
            <CheckCircle size={48} className="mx-auto text-success-fg" aria-hidden="true" />
            <h2 className="font-semibold text-fg">{t('sspr_done_title')}</h2>
            <p className="text-sm text-fg-muted">{t('sspr_done_text')}</p>
          </div>
        )}

        {tokenValid === true && !success && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-fg-muted">{t('sspr_reset_intro')}</p>

            <div>
              <label htmlFor="sspr-new-pw" className="block text-sm font-medium text-fg-muted mb-1">{t('sspr_new_pw')}</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
                <input
                  id="sspr-new-pw"
                  type={showPw ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9 pr-9"
                  placeholder={t('sspr_new_pw')}
                  required
                  autoFocus
                  autoComplete="new-password"
                />
                <button aria-label={showPw ? t('sspr_hide_pw') : t('sspr_show_pw')}
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-muted"
                >
                  {showPw ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                </button>
              </div>
              <PasswordStrengthBar password={password} minLen={minLen} />
            </div>

            <div>
              <label htmlFor="sspr-confirm-pw" className="block text-sm font-medium text-fg-muted mb-1">{t('sspr_confirm_pw')}</label>
              <div className="relative">
                <Lock size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
                <input
                  id="sspr-confirm-pw"
                  type={showPw ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="input pl-9"
                  placeholder={t('sspr_confirm_pw_placeholder')}
                  required
                  autoComplete="new-password"
                  aria-describedby={confirm && password !== confirm ? 'sspr-mismatch' : undefined}
                />
              </div>
              {confirm && password !== confirm && (
                <p id="sspr-mismatch" className="text-xs text-danger-fg mt-1">{t('sspr_mismatch')}</p>
              )}
            </div>

            {mfaRequired && (
              <fieldset className="space-y-2 border-t border-line pt-4">
                <legend className="flex items-center gap-1.5 text-sm font-medium text-fg">
                  <ShieldCheck size={15} className="text-accent-fg" aria-hidden="true" /> {t('sspr_mfa_title')}
                </legend>
                <p id="sspr-mfa-hint" className="text-xs text-fg-muted">
                  {totpOffered ? t('sspr_mfa_text_totp') : t('sspr_mfa_text_backup')}
                </p>
                <label htmlFor="sspr-mfa" className="block text-sm font-medium text-fg-muted">{t('sspr_mfa_label')}</label>
                <input
                  id="sspr-mfa"
                  type="text"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  className="input font-mono tracking-widest"
                  inputMode={totpOffered ? 'numeric' : 'text'}
                  autoComplete="one-time-code"
                  maxLength={16}
                  required
                  aria-describedby="sspr-mfa-hint"
                />
                <p className="text-xs text-fg-subtle">{t('sspr_mfa_kept')}</p>
              </fieldset>
            )}

            {error && (
              <div role="alert" className="bg-danger-bg border border-danger-line rounded px-3 py-2 text-sm text-danger-fg">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !password || password !== confirm || mfaMissing}
              className="btn-primary w-full justify-center py-2 disabled:opacity-60"
            >
              {loading ? t('sspr_saving') : t('sspr_submit')}
            </button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
