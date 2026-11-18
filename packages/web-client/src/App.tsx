import { Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useLayoutEffect, useState } from 'react';
import { TopBar } from './components/TopBar.js';
import { AppRail } from './components/AppRail.js';
import { ComposeWindow } from './components/ComposeWindow.js';
import { LoginPage } from './pages/LoginPage.js';
import { SsoCallbackPage } from './pages/SsoCallbackPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { MailPage } from './pages/MailPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { ContactsPage } from './pages/ContactsPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { NotesPage } from './pages/NotesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { useAuthStore } from './store/auth.js';
import { useSessionChecked } from './api/client.js';
import { useUiStore, useThemeStore, resolveIsDark } from './store/ui.js';
import { usePreferencesSync } from './hooks/usePreferencesSync.js';
import { useRealtime } from './hooks/useRealtime.js';
import { useServiceWorkerNavigation } from './hooks/useWebPush.js';
import { useInactivityLogout } from './hooks/useInactivityLogout.js';
import { useTaskReminders } from './hooks/useTaskReminders.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ShortcutHelpDialog } from './components/ShortcutHelpDialog.js';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts.js';
import { useSendGuard } from './components/DelayedSendToast.js';
import { brandCssVars, headerHex, resolveAccentChannels } from './lib/branding.js';
import { useBranding, useBrandingSync } from './hooks/useBranding.js';
import { mailPageUrl, parseMailboxKey } from './lib/mailboxContext.js';

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

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { composeOpen } = useUiStore();
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

  // MessageList picks up ?q= and runs a mailbox-wide server search
  const handleSearch = (q: string) => {
    const trimmed = q.trim();
    if (trimmed) navigate(`/mail?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <div className="h-full flex flex-col">
      <TopBar onSearch={handleSearch} />
      {/* App rail left (md+), bottom bar below md (column-reverse puts it last) */}
      <div className="flex-1 flex flex-col-reverse md:flex-row min-h-0">
        <AppRail />
        <main key={pageKey(location.pathname)} className="flex-1 flex min-h-0 min-w-0 overflow-hidden animate-page-in">
          <ErrorBoundary resetKey={pageKey(location.pathname)}>{children}</ErrorBoundary>
        </main>
      </div>
      {composeOpen && <ComposeWindow />}
      <ShortcutHelpDialog />
    </div>
  );
}

// Checks on startup whether setup is required.
// Acts as a TOP-LEVEL guard and blocks ALL routes (including /login, /forgot-password)
// as long as setup is not complete.  After setup completion, a direct
// call to /setup redirects back to /login.
function SetupGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const { productName } = useBranding();

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
    } else if (!setupRequired && location.pathname === '/setup') {
      navigate('/login', { replace: true });
    }
  }, [setupRequired, location.pathname, navigate]);

  if (setupRequired === null) {
    return (
      <div className="min-h-screen bg-accent flex items-center justify-center">
        <div className="text-white text-sm animate-pulse">{productName} wird geladen…</div>
      </div>
    );
  }
  // Do not render wrong routes while the Navigate redirect is still in progress
  if (setupRequired && location.pathname !== '/setup') return null;
  if (!setupRequired && location.pathname === '/setup') return null;
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
        {/* OAuth2 consent route removed in v5.6.0 (OAuth2 dropped entirely) */}
        <Route path="/*" element={
          <AuthGuard>
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
          </AuthGuard>
        } />
      </Routes>
    </SetupGuard>
    </>
  );
}
