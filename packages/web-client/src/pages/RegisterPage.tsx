/**
 * 10.6: self-registration (docs/self-registration.md) — reachable from the
 * login page only while GET /auth/register/config answers (switch on and at
 * least one allowed domain). Fields: name, local part + domain, password +
 * confirmation, invite code when required. A hidden honeypot field (`website`)
 * and the signed form token of the config answer go with every request.
 * Approval mode ends on "Konto wartet auf Freigabe".
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle, Clock, UserPlus } from 'lucide-react';
import { AuthShell, AuthBrandHeader } from '../components/AuthShell.js';
import { useT, fmt } from '../i18n/useT.js';
import {
  REGISTER_CONFIG_URL, REGISTER_URL, checkRegisterForm, parseRegisterConfig, registerBody, registerErrorOf,
  type RegisterConfig, type RegisterField, type RegisterForm,
} from '../lib/selfRegistration.js';
import type { TranslationKey } from '../i18n/translations.js';

type Phase = 'loading' | 'off' | 'form' | 'done';

/** Field → id suffix of its input. */
const FIELD_INPUT: Record<Exclude<RegisterField, 'form'>, string> = {
  displayName: 'name', localPart: 'local', password: 'pw', passwordConfirm: 'pw2', inviteCode: 'invite',
};

const EMPTY: RegisterForm ={ displayName: '', localPart: '', domainId: '', password: '', passwordConfirm: '', inviteCode: '' };

export function RegisterPage() {
  const t = useT();
  const id = useId();
  const [phase, setPhase] = useState<Phase>('loading');
  const [cfg, setCfg] = useState<RegisterConfig | null>(null);
  const [f, setF] = useState<RegisterForm>(EMPTY);
  const [honeypot, setHoneypot] = useState('');
  const [error, setError] = useState<{ field: RegisterField; key: TranslationKey } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: 'pending' | 'active'; email: string } | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  const loadConfig = useCallback(async (): Promise<RegisterConfig | null> => {
    try {
      const r = await fetch(REGISTER_CONFIG_URL, { headers: { Accept: 'application/json' } });
      return r.ok ? parseRegisterConfig(await r.json()) : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void loadConfig().then((c) => {
      setCfg(c);
      if (c) setF((prev) => ({ ...prev, domainId: prev.domainId || c.domains[0]!.id }));
      setPhase(c ? 'form' : 'off');
    });
  }, [loadConfig]);

  useEffect(() => { if (phase === 'done') resultHeading.current?.focus(); }, [phase]);
  // WCAG 3.3.1: move the focus to the field the error belongs to (form errors are announced by role=alert)
  useEffect(() => {
    if (!error || error.field === 'form') return;
    document.getElementById(`${id}-${FIELD_INPUT[error.field]}`)?.focus();
  }, [error, id]);

  const set = (k: keyof RegisterForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setF((prev) => ({ ...prev, [k]: e.target.value }));
    if (error && (error.field === k || (k === 'password' && error.field === 'passwordConfirm'))) setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cfg || busy) return;
    const problem = checkRegisterForm(f, cfg);
    if (problem) { setError(problem); return; }
    setError(null);
    setBusy(true);
    try {
      const r = await fetch(REGISTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(registerBody(f, cfg, honeypot)),
      });
      const body = (await r.json().catch(() => ({}))) as { status?: string; email?: string; code?: string };
      if (r.status === 201 && (body.status === 'pending' || body.status === 'active') && typeof body.email === 'string') {
        setResult({ status: body.status, email: body.email });
        setPhase('done');
        return;
      }
      if (r.status === 404) { setPhase('off'); return; }
      setError(registerErrorOf(r.status, body.code));
      // a used / expired form token: fetch a fresh one for the next attempt
      if (body.code === 'INVALID_FORM') {
        const fresh = await loadConfig();
        if (fresh) setCfg(fresh); else setPhase('off');
      }
    } catch {
      setError({ field: 'form', key: 'register_err_generic' });
    } finally {
      setBusy(false);
    }
  };

  const errText = (key: TranslationKey) => fmt(t(key), { n: cfg?.minPasswordLength ?? 8 });
  const fieldError = (field: RegisterField) => (error?.field === field ? errText(error.key) : null);
  const errId = (field: RegisterField) => `${id}-${field}-err`;
  const describe = (field: RegisterField, hintId?: string) =>
    [hintId, error?.field === field ? errId(field) : null].filter(Boolean).join(' ') || undefined;

  const fieldErrorText = (field: RegisterField) => {
    const msg = fieldError(field);
    return msg ? <p id={errId(field)} className="mt-1 text-xs text-danger-fg">{msg}</p> : null;
  };

  return (
    <AuthShell>
      <div className="bg-surface rounded-lg shadow-2xl p-8 w-full max-w-sm">
        <AuthBrandHeader
          subtitle={t('register_title')}
          icon={
            <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
              <UserPlus size={22} className="text-white" aria-hidden="true" />
            </div>
          }
        />

        {phase === 'loading' && (
          <p className="text-sm text-fg-muted text-center" role="status">{t('register_loading')}</p>
        )}

        {phase === 'off' && (
          <div className="text-center space-y-4">
            <h1 className="font-semibold text-fg">{t('register_unavailable_title')}</h1>
            <p className="bg-warning-bg border border-warning-line rounded-lg px-4 py-3 text-sm text-warning-fg">
              {t('register_unavailable')}
            </p>
            <Link to="/login" className="flex items-center justify-center gap-1.5 text-sm text-accent-fg hover:underline py-1">
              <ArrowLeft size={13} aria-hidden="true" /> {t('register_back')}
            </Link>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="text-center space-y-4">
            {result.status === 'pending'
              ? <Clock size={48} className="mx-auto text-warning-fg" aria-hidden="true" />
              : <CheckCircle size={48} className="mx-auto text-success-fg" aria-hidden="true" />}
            <h1 ref={resultHeading} tabIndex={-1} className="font-semibold text-fg outline-none">
              {t(result.status === 'pending' ? 'register_pending_title' : 'register_active_title')}
            </h1>
            <p className="text-sm text-fg-muted" role="status">
              {fmt(t(result.status === 'pending' ? 'register_pending_text' : 'register_active_text'), { email: result.email })}
            </p>
            <Link to="/login" className="btn-primary w-full justify-center py-2">{t('register_to_login')}</Link>
          </div>
        )}

        {phase === 'form' && cfg && (
          <form onSubmit={submit} className="space-y-4" noValidate aria-describedby={`${id}-intro`}>
            <div id={`${id}-intro`} className="text-sm text-fg-muted space-y-1">
              <h1 className="sr-only">{t('register_title')}</h1>
              <p>{t('register_intro')}</p>
              {cfg.mode === 'approval' && <p>{t('register_intro_approval')}</p>}
            </div>

            <div>
              <label htmlFor={`${id}-name`} className="block text-sm font-medium text-fg-muted mb-1">{t('register_name')}</label>
              <input
                id={`${id}-name`} className="input" value={f.displayName} onChange={set('displayName')}
                autoComplete="name" required maxLength={100} autoFocus
                aria-invalid={error?.field === 'displayName' || undefined} aria-describedby={describe('displayName')}
              />
              {fieldErrorText('displayName')}
            </div>

            <fieldset>
              <legend className="block text-sm font-medium text-fg-muted mb-1">{t('register_address')}</legend>
              <div className="flex items-center gap-1.5">
                <label htmlFor={`${id}-local`} className="sr-only">{t('register_local_part')}</label>
                <input
                  id={`${id}-local`} className="input min-w-0 flex-1" value={f.localPart} onChange={set('localPart')}
                  autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={64}
                  aria-invalid={error?.field === 'localPart' || undefined} aria-describedby={describe('localPart', `${id}-local-hint`)}
                />
                <span aria-hidden="true" className="text-fg-muted">@</span>
                <label htmlFor={`${id}-domain`} className="sr-only">{t('register_domain')}</label>
                <select
                  id={`${id}-domain`} className="input w-auto max-w-[50%]" value={f.domainId} onChange={set('domainId')}
                >
                  {cfg.domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <p id={`${id}-local-hint`} className="mt-1 text-xs text-fg-subtle">{t('register_local_part_hint')}</p>
              {fieldErrorText('localPart')}
            </fieldset>

            <div>
              <label htmlFor={`${id}-pw`} className="block text-sm font-medium text-fg-muted mb-1">{t('register_password')}</label>
              <input
                id={`${id}-pw`} type="password" className="input" value={f.password} onChange={set('password')}
                autoComplete="new-password" required minLength={cfg.minPasswordLength} maxLength={128}
                aria-invalid={error?.field === 'password' || undefined} aria-describedby={describe('password', `${id}-pw-hint`)}
              />
              <p id={`${id}-pw-hint`} className="mt-1 text-xs text-fg-subtle">{fmt(t('register_password_hint'), { n: cfg.minPasswordLength })}</p>
              {fieldErrorText('password')}
            </div>

            <div>
              <label htmlFor={`${id}-pw2`} className="block text-sm font-medium text-fg-muted mb-1">{t('register_password_confirm')}</label>
              <input
                id={`${id}-pw2`} type="password" className="input" value={f.passwordConfirm} onChange={set('passwordConfirm')}
                autoComplete="new-password" required maxLength={128}
                aria-invalid={error?.field === 'passwordConfirm' || undefined} aria-describedby={describe('passwordConfirm')}
              />
              {fieldErrorText('passwordConfirm')}
            </div>

            {cfg.inviteRequired && (
              <div>
                <label htmlFor={`${id}-invite`} className="block text-sm font-medium text-fg-muted mb-1">{t('register_invite')}</label>
                <input
                  id={`${id}-invite`} className="input font-mono" value={f.inviteCode} onChange={set('inviteCode')}
                  autoComplete="off" autoCapitalize="characters" spellCheck={false} required maxLength={40}
                  aria-invalid={error?.field === 'inviteCode' || undefined} aria-describedby={describe('inviteCode', `${id}-invite-hint`)}
                />
                <p id={`${id}-invite-hint`} className="mt-1 text-xs text-fg-subtle">{t('register_invite_hint')}</p>
                {fieldErrorText('inviteCode')}
              </div>
            )}

            {/* Honeypot: invisible and unreachable for people and assistive technology */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
              <label htmlFor={`${id}-website`}>{t('register_honeypot')}</label>
              <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
            </div>

            <div aria-live="assertive">
              {error?.field === 'form' && (
                <p role="alert" className="bg-danger-bg border border-danger-line rounded px-3 py-2 text-sm text-danger-fg">
                  {errText(error.key)}
                </p>
              )}
            </div>

            <button type="submit" disabled={busy} className="btn-primary w-full justify-center py-2 disabled:opacity-60">
              {busy ? t('register_submitting') : t('register_submit')}
            </button>

            <Link to="/login" className="w-full flex items-center justify-center gap-1.5 text-sm text-fg-subtle hover:text-fg-muted py-1">
              <ArrowLeft size={13} aria-hidden="true" /> {t('register_back')}
            </Link>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
