import { Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useLayoutEffect, useState } from 'react';
import { TopBar } from './components/TopBar.js';
import { AppRail } from './components/AppRail.js';
import { LoginPage } from './pages/LoginPage.js';
import { ComposePopoutPage } from './pages/ComposePopoutPage.js';
import { SsoCallbackPage } from './pages/SsoCallbackPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { RecoveryEmailConfirmPage } from './pages/RecoveryEmailConfirmPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { loadResume } from './lib/setupWizard.js';
import { MailPage } from './pages/MailPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { ContactsPage } from './pages/ContactsPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { NotesPage } from './pages/NotesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { MfaEnrolmentPage } from './pages/MfaEnrolmentPage.js';
import { MfaGraceBanner } from './components/MfaGraceBanner.js';
import { useMfaEnforcement } from './hooks/useMfaEnforcement.js';
import { MFA_ENROLMENT_ROUTE, enforcementView } from './lib/mfaEnforcement.js';
import { useAuthStore } from './store/auth.js';
import { useSessionChecked } from './api/client.js';
import { useThemeStore, resolveIsDark } from './store/ui.js';
import { usePreferencesSync } from './hooks/usePreferencesSync.js';
import { useRealtime } from './hooks/useRealtime.js';
import { useServiceWorkerNavigation } from './hooks/useWebPush.js';
import { useInactivityLogout } from './hooks/useInactivityLogout.js';
import { useTaskReminders } from './hooks/useTaskReminders.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ShortcutHelpDialog } from './components/ShortcutHelpDialog.js';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts.js';
import { useSendGuard } from './components/DelayedSendToast.js';
import { useComposeRouting } from './hooks/useComposeRouting.js';
import { usePopoutBridge } from './hooks/usePopoutBridge.js';
import { useWebmailFeatures } from './hooks/useWebmailFeatures.js';
import { featureForPath } from './lib/webmailFeatures.js';
import { POPOUT_ROUTE } from './lib/composePopout.js';
import { brandCssVars, headerHex, resolveAccentChannels } from './lib/branding.js';
import { useBranding, useBrandingSync } from './hooks/useBranding.js';
import { mailPageUrl, parseMailboxKey } from './lib/mailboxContext.js';
import { useAppBackground } from './hooks/useAppBackground.js';
import { APP_BODY_CLASS } from './lib/paneLayout.js';

// ── Theme-Applier ─────────────────────────────────────────────────────────────
function ThemeApplier() {
  const { theme, accentRgb } = useThemeStore();
  const branding = useBranding();
  useBrandingSync('mwa');
  // 9.3 accent rule (lib/branding.ts): brand primary by default, the user's own
  // choice only while the branding allows it.
  const accent = resolveAccentChannels(branding, accentRgb);
  const header = headerHex(branding);

  // layout effect: colours are set before the first paint (no flash of the default accent)
  useLayoutEffect(() => {
    const apply = () => {
      const isDark = resolveIsDark(theme);
      document.documentElement.classList.toggle('dark', isDark);
      // Accent fill (white text >= 4.5:1), accent text/icons/focus rings per theme
      // (theme/contrast.ts) and the top-bar colours (text >= 4.5:1)
      for (const [k, v] of Object.entries(brandCssVars(accent, header, isDark))) {
        document.documentElement.style.setProperty(k, v);
      }
    };
    apply();

    // Watch system preference
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') apply(); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme, accent, header]);

  return null;
}

// 9.3: shared mailboxes open in the mail view (folder pane → Freigegebene Postfächer);
// old /shared-mailbox/:id links redirect there.
function SharedMailboxRedirect() {
  const { id = '' } = useParams<{ id: string }>();
  return <Navigate to={mailPageUrl(parseMailboxKey(`shared:${id}`))} replace />;
}

/** Top-level page of a path — deep links inside a page (/mail/…, /calendar/event/…) do not remount it. */
function pageKey(pathname: string): string {
  return `/${pathname.split('/')[1] ?? ''}`;
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.accessToken);
  // v8.1: the access token is memory-only — after a reload wait for the
  // cookie-based session check before deciding to show the login page.
  const sessionChecked = useSessionChecked();
  if (!token && !sessionChecked) return null;
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * 10.5: "MFA für alle Benutzer erzwingen" — after the grace period the app is
 * replaced by the mandatory enrolment page. Waits for the state once (the app's
 * own requests would only be refused); a failed request shows the app (the
 * server enforces, api/client.ts follows a 403 MFA_ENROLMENT_REQUIRED).
 */
function MfaEnforcementGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useMfaEnforcement();
  if (isLoading) return null;
  if (enforcementView(data, new Date()).redirect) return <Navigate to={MFA_ENROLMENT_ROUTE} replace />;
  return <>{children}</>;
}

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  // 9.4: roaming preferences (server copy, debounced writes)
  usePreferencesSync();
  useRealtime();
  useServiceWorkerNavigation();
  useInactivityLogout();
  // Task reminders fire on every page, not only while /tasks is open
  useTaskReminders();
  // Keyboard shortcuts (Settings → View) + undo-send unload guard
  useGlobalShortcuts();
  useSendGuard();
  // 9.4: compose opens inline in the mail view; drafts in their own windows talk back here
  useComposeRouting();
  usePopoutBridge();
  const { features } = useWebmailFeatures();
  const pageFeature = featureForPath(location.pathname);
  const background = useAppBackground();
  const pageDisabled = pageFeature !== null && !features[pageFeature];
  // 10.5: grace period of "MFA für alle Benutzer erzwingen" → banner
  const { data: mfaEnforcement } = useMfaEnforcement();
  const mfaBanner = enforcementView(mfaEnforcement, new Date()).banner;

  // MessageList picks up ?q= and runs a mailbox-wide server search
  const handleSearch = (q: string) => {
    const trimmed = q.trim();
    if (trimmed) navigate(`/mail?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="h-full flex flex-col">
      {/* SC 2.4.1: bypass block — first focusable element, visible on focus */}
      <a
        href="#main-content"
        onClick={(e) => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[100] focus:px-3 focus:py-2 focus:rounded focus:bg-surface focus:text-fg focus:shadow-lg"
      >
        Zum Inhalt springen
      </a>
      {mfaBanner && <MfaGraceBanner daysLeft={mfaBanner.daysLeft} deadline={mfaBanner.deadline} />}
      <TopBar onSearch={handleSearch} />
      {/* App rail left (md+), bottom bar below md (column-reverse puts it last) */}
      {/* 10.1: the canvas below the top bar — plain, or the background picture (Einstellungen → Darstellung) */}
      <div className={APP_BODY_CLASS} data-bg={background.imageUrl ? 'on' : 'off'}
        style={background.imageUrl ? { backgroundImage: `url("${background.imageUrl}")` } : undefined}>
        <AppRail />
        <main id="main-content" tabIndex={-1} key={pageKey(location.pathname)} className="flex-1 flex min-h-0 min-w-0 overflow-hidden animate-page-in outline-none">
          <ErrorBoundary resetKey={pageKey(location.pathname)}>
            {/* 9.4: pages of a module the webmail policy switched off lead to the mail view */}
            {pageDisabled ? <Navigate to="/mail" replace /> : children}
          </ErrorBoundary>
        </main>
      </div>
      <ShortcutHelpDialog />
    </div>
  );
}

// Checks on startup whether setup is required.
// Acts as a TOP-LEVEL guard and blocks ALL routes (including /login, /forgot-password)
// as long as setup is not complete.  After setup completion, a direct
// call to /setup redirects back to /login — except in the tab that just ran
// the wizard (10.4: resume marker), which continues with DNS / certificate.
function SetupGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const { productName } = useBranding();
  const wizardRunning = location.pathname === '/setup' && loadResume() !== null;

  useEffect(() => {
    fetch('/api/v1/setup/status')
      .then((r) => r.json() as Promise<{ setupRequired: boolean }>)
      .then((data) => setSetupRequired(!!data.setupRequired))
      .catch(() => setSetupRequired(false)); // Let through on network errors
  }, []);

  useEffect(() => {
    if (setupRequired === null) return;
    if (setupRequired && location.pathname !== '/setup') {
      navigate('/setup', { replace: true });
    } else if (!setupRequired && location.pathname === '/setup' && !wizardRunning) {
      navigate('/login', { replace: true });
    }
  }, [setupRequired, location.pathname, navigate, wizardRunning]);

  if (setupRequired === null) {
    return (
      <div className="min-h-screen bg-accent flex items-center justify-center">
        <div className="text-white text-sm animate-pulse">{productName} wird geladen…</div>
      </div>
    );
  }
  // Do not render wrong routes while the Navigate redirect is still in progress
  if (setupRequired && location.pathname !== '/setup') return null;
  if (!setupRequired && location.pathname === '/setup' && !wizardRunning) return null;
  return <>{children}</>;
}

export function App() {
  return (
    <>
      <ThemeApplier />
    <SetupGuard>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/sso/callback" element={<SsoCallbackPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        {/* 10.6: confirmation link of a recovery address (no session needed) */}
        <Route path="/recovery-email/confirm" element={<RecoveryEmailConfirmPage />} />
        {/* OAuth2 consent route removed in v5.6.0 (OAuth2 dropped entirely) */}
        {/* 9.4: a draft in its own window (no app frame) */}
        <Route path={POPOUT_ROUTE} element={<AuthGuard><ComposePopoutPage /></AuthGuard>} />
        {/* 10.5: mandatory enrolment page of "MFA für alle Benutzer erzwingen" (no app frame) */}
        <Route path={MFA_ENROLMENT_ROUTE} element={<AuthGuard><MfaEnrolmentPage /></AuthGuard>} />
        <Route path="/*" element={
          <AuthGuard>
            <MfaEnforcementGate>
            <Layout>
              <Routes>
                <Route path="/mail/*" element={<MailPage />} />
                <Route path="/shared-mailbox/:id" element={<SharedMailboxRedirect />} />
                <Route path="/calendar/*" element={<CalendarPage />} />
                <Route path="/contacts/*" element={<ContactsPage />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/notes" element={<NotesPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/" element={<Navigate to="/mail" replace />} />
              </Routes>
            </Layout>
            </MfaEnforcementGate>
          </AuthGuard>
        } />
      </Routes>
    </SetupGuard>
    </>
  );
}
