import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Info, Loader2, LogOut, ShieldCheck } from 'lucide-react';
import { api, apiFetch, logoutSession } from '../api/client.js';
import { AuthShell, AuthBrandHeader } from '../components/AuthShell.js';
import { SecuritySection } from './SettingsPage.js';
import { hasEnrolledFactor, type MfaEnforcementInfo } from '../lib/mfaEnforcement.js';
import { useT } from '../i18n/useT.js';

interface MfaStatus { totpEnabled: boolean; webauthnCount: number; backupCodesCount: number }

/**
 * 10.5: mandatory enrolment page of "MFA für alle Benutzer erzwingen"
 * (route MFA_ENROLMENT_ROUTE, outside the app frame). Shown when the grace
 * period is over: only the TOTP / security-key setup of Settings → Sicherheit
 * and sign-out. "Weiter zum Webmail" appears once a factor is enrolled — the
 * setup stays visible until then so the backup codes can be saved.
 * SSO-only accounts cannot confirm an enrolment (no password): they get the
 * hint to sign in through their provider with MFA.
 */
export function MfaEnrolmentPage() {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Own key: the enrolment invalidates ['mfa-enforcement'] — this page must not
  // jump away before the backup codes were seen.
  const { data: enforcement, isLoading, isError } = useQuery<MfaEnforcementInfo>({
    queryKey: ['mfa-enrolment-page'],
    queryFn: () => api.get<MfaEnforcementInfo>('/user/mfa-enforcement'),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const { data: mfaStatus } = useQuery<MfaStatus>({
    queryKey: ['mfa-status'],
    queryFn: async () => {
      const res = await apiFetch('/auth/mfa/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<MfaStatus>;
    },
    staleTime: 0,
  });

  const signOut = () => {
    void logoutSession().finally(() => { qc.clear(); navigate('/login', { replace: true }); });
  };
  const proceed = () => {
    void qc.invalidateQueries({ queryKey: ['mfa-enforcement'] });
    qc.removeQueries({ queryKey: ['mfa-enrolment-page'] });
    navigate('/mail', { replace: true });
  };

  if (isLoading) {
    return (
      <AuthShell>
        <div className="bg-surface rounded-lg shadow-2xl p-8 w-full max-w-lg flex items-center justify-center gap-2 text-sm text-fg-muted">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />{t('mfa_enrol_loading')}
        </div>
      </AuthShell>
    );
  }
  // Nothing to enrol (switch off, already satisfied, still in the grace period) → the app
  if (!isError && enforcement && enforcement.state !== 'required') return <Navigate to="/mail" replace />;

  const enrolled = hasEnrolledFactor(mfaStatus);
  const canEnrol = enforcement?.canEnrol !== false;

  return (
    <AuthShell>
      <main className="bg-surface rounded-lg shadow-2xl p-8 w-full max-w-lg border border-transparent">
        <AuthBrandHeader
          subtitle={t('mfa_enrol_subtitle')}
          icon={
            <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center">
              <ShieldCheck size={22} className="text-white" aria-hidden="true" />
            </div>
          }
        />
        <h2 className="text-lg font-semibold text-fg">{t('mfa_enrol_title')}</h2>
        <p className="mt-1 text-sm text-fg-muted">{t('mfa_enrol_text')}</p>

        {canEnrol ? (
          <>
            <p className="mt-3 flex items-start gap-2 rounded border border-info-line bg-info-bg px-3 py-2 text-xs text-info-fg">
              <Info size={14} aria-hidden="true" className="shrink-0 mt-px" />{t('mfa_enrol_mail_clients')}
            </p>
            <div className="mt-5">
              <SecuritySection enrolmentOnly />
            </div>
          </>
        ) : (
          <p className="mt-4 flex items-start gap-2 rounded border border-warning-line bg-warning-bg px-3 py-2 text-sm text-warning-fg">
            <Info size={16} aria-hidden="true" className="shrink-0 mt-px" />{t('mfa_enrol_sso')}
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {enrolled && (
            <>
              <p role="status" className="w-full flex items-center gap-1.5 text-sm font-medium text-success-fg">
                <CheckCircle2 size={16} aria-hidden="true" />{t('mfa_enrol_done')}
              </p>
              <button type="button" onClick={proceed} className="btn-primary text-sm">
                {t('mfa_enrol_continue')}
              </button>
            </>
          )}
          <button type="button" onClick={signOut} className="btn-secondary text-sm inline-flex items-center gap-1.5 ml-auto">
            <LogOut size={14} aria-hidden="true" />{t('mfa_enrol_sign_out')}
          </button>
        </div>
      </main>
    </AuthShell>
  );
}
