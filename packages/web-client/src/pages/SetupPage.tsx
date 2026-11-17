import { useEffect, useState, type FormEvent } from 'react';
import { useBranding } from '../hooks/useBranding.js';
import { useT, fmt } from '../i18n/useT.js';

export function SetupPage() {
  const t = useT();
  const [step, setStep] = useState<'form' | 'done'>('form');
  const { productName } = useBranding();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [domain, setDomain]           = useState('');
  const [email, setEmail]             = useState('');
  const [emailEdited, setEmailEdited] = useState(false);
  const [password, setPassword]       = useState('');
  const [confirm, setConfirm]         = useState('');
  // One-time setup token (printed in the container log / SETUP_TOKEN env)
  const [setupToken, setSetupToken]   = useState('');
  const [tokenRequired, setTokenRequired] = useState(true);

  useEffect(() => {
    fetch('/api/v1/setup/status')
      .then((r) => r.json() as Promise<{ setupTokenRequired?: boolean }>)
      .then((d) => { if (d.setupTokenRequired === false) setTokenRequired(false); })
      .catch(() => undefined);
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError(t('setup_err_mismatch'));
      return;
    }
    if (tokenRequired && !setupToken.trim()) {
      setError(t('setup_err_token'));
      return;
    }
    if (password.length < 8) {
      setError(t('setup_err_length'));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/v1/setup/complete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(setupToken.trim() ? { 'X-Setup-Token': setupToken.trim() } : {}),
        },
        body: JSON.stringify({ domain, email, password, ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}) }),
      });
      const data = await res.json() as { error?: string; success?: boolean };
      if (!res.ok) {
        setError(data.error ?? t('setup_err_failed'));
        return;
      }
      setStep('done');
    } catch {
      setError(t('setup_err_network'));
    } finally {
      setLoading(false);
    }
  };

  if (step === 'done') {
    return (
      <div className="min-h-screen bg-accent flex items-center justify-center p-4">
        <div className="bg-surface rounded-lg shadow-xl p-8 w-full max-w-md text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-2xl font-semibold text-fg mb-2">{t('setup_done_title')}</h2>
          <p className="text-fg-subtle mb-6">
            {t('setup_done_text')}
          </p>
          <button
            onClick={() => {
              // Hard reload (no react-router navigate!) so SetupGuard
              // fetches the setup status fresh and no longer redirects
              // back to /setup.  Without a reload, setupRequired in
              // SetupGuard is still true (from the first mount) → loop.
              window.location.href = '/login';
            }}
            className="w-full bg-accent hover:bg-accent-hover text-white font-medium py-2 px-4 rounded transition-colors"
          >
            {t('setup_to_login')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-accent flex items-center justify-center p-4">
      <div className="bg-surface rounded-lg shadow-xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="bg-accent px-8 py-6">
          <div className="flex items-center gap-3 mb-1">
            <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
            </svg>
            <span className="text-white text-xl font-semibold">{productName}</span>
          </div>
          <p className="text-white text-sm">{t('setup_subtitle')}</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-8 py-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-fg">{fmt(t('setup_welcome'), { name: productName })}</h2>
            <p className="text-sm text-fg-subtle mt-1">
              {t('setup_intro')}
            </p>
          </div>

          {error && (
            <div className="bg-danger-bg border border-danger-line text-danger-fg text-sm px-3 py-2 rounded">
              {error}
            </div>
          )}

          {/* Setup token */}
          {tokenRequired && (
            <div>
              <label htmlFor="setup-token" className="block text-sm font-medium text-fg-muted mb-1">
                {t('setup_token_label')}
              </label>
              <input
                id="setup-token"
                type="text"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder={t('setup_token_placeholder')}
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                className="w-full border border-line-strong rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg focus:border-transparent"
              />
              <p className="text-xs text-fg-subtle mt-1">
                {t('setup_token_hint_log')} <code className="bg-surface-2 px-1 rounded">docker logs coremail | grep -i "setup token"</code> —
                {' '}{t('setup_token_hint_env')} <code className="bg-surface-2 px-1 rounded">SETUP_TOKEN</code>{t('setup_token_hint_end')}
              </p>
            </div>
          )}

          {/* Domain */}
          <div>
            <label className="block text-sm font-medium text-fg-muted mb-1">
              {t('setup_domain')}
            </label>
            <input
              type="text"
              required
              placeholder={t('setup_domain_placeholder')}
              value={domain}
              onChange={(e) => {
                const val = e.target.value.toLowerCase();
                setDomain(val);
                if (!emailEdited) {
                  setEmail(val ? `admin@${val}` : '');
                }
              }}
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg focus:border-transparent"
            />
            <p className="text-xs text-fg-subtle mt-1">
              {t('setup_domain_hint')}
            </p>
          </div>

          {/* E-Mail */}
          <div>
            <label className="block text-sm font-medium text-fg-muted mb-1">
              {t('setup_admin_email')}
            </label>
            <input
              type="email"
              required
              placeholder="admin@firma.de"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmailEdited(true); }}
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg focus:border-transparent"
            />
          </div>

          {/* Password */}
          <div>
            <label className="block text-sm font-medium text-fg-muted mb-1">
              {t('auth_password')}
            </label>
            <input
              type="password"
              required
              placeholder={t('setup_password_placeholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg focus:border-transparent"
            />
          </div>

          {/* Confirm password */}
          <div>
            <label className="block text-sm font-medium text-fg-muted mb-1">
              {t('setup_confirm_password')}
            </label>
            <input
              type="password"
              required
              placeholder={t('setup_repeat_password')}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full border border-line-strong rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg focus:border-transparent"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-accent hover:bg-accent-hover disabled:opacity-60 text-white font-medium py-2 px-4 rounded transition-colors mt-2"
          >
            {loading ? t('setup_submitting') : t('setup_submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
