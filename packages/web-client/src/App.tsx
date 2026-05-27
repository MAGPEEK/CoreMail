import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { TopBar } from './components/TopBar.js';
import { ComposeWindow } from './components/ComposeWindow.js';
import { LoginPage } from './pages/LoginPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { ResetPasswordPage } from './pages/ResetPasswordPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { MailPage } from './pages/MailPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { ContactsPage } from './pages/ContactsPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { NotesPage } from './pages/NotesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { SharedMailboxPage } from './pages/SharedMailboxPage.js';
import { OAuthConsentPage } from './pages/OAuthConsentPage.js';
import { useAuthStore } from './store/auth.js';
import { useUiStore, useThemeStore, resolveIsDark } from './store/ui.js';
import { useMailEvents } from './hooks/useMailEvents.js';
import { useInactivityLogout } from './hooks/useInactivityLogout.js';

// ── Theme-Applier ─────────────────────────────────────────────────────────────
function ThemeApplier() {
  const { theme, accentRgb } = useThemeStore();

  useEffect(() => {
    // Accent-Farbe als CSS-Variable setzen
    document.documentElement.style.setProperty('--color-accent', accentRgb);
  }, [accentRgb]);

  useEffect(() => {
    const apply = () => {
      const isDark = resolveIsDark(theme);
      document.documentElement.classList.toggle('dark', isDark);
    };
    apply();

    // System-Präferenz überwachen
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (theme === 'system') apply(); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  return null;
}

const APP_MAP: Record<string, 'mail' | 'calendar' | 'contacts' | 'tasks' | 'notes'> = {
  '/mail': 'mail',
  '/calendar': 'calendar',
  '/contacts': 'contacts',
  '/tasks': 'tasks',
  '/notes': 'notes',
};

function AuthGuard({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.accessToken);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { composeOpen } = useUiStore();
  useMailEvents();
  useInactivityLogout();

  const currentApp = APP_MAP[location.pathname] ?? 'mail';

  const handleSearch = (q: string) => {
    if (q) navigate(`/mail?q=${encodeURIComponent(q)}`);
  };

  return (
    <div className="h-full flex flex-col">
      <TopBar onSearch={handleSearch} currentApp={currentApp} />
      <main key={location.pathname} className="flex-1 flex overflow-hidden animate-page-in">
        {children}
      </main>
      {composeOpen && <ComposeWindow />}
    </div>
  );
}

// Prüft beim Start ob Setup erforderlich ist.
// Wirkt als TOP-LEVEL-Guard und blockt ALLE Routen (auch /login, /forgot-password),
// solange Setup nicht abgeschlossen ist.  Nach Setup-Abschluss leitet ein direkter
// Aufruf von /setup zurück auf /login.
function SetupGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/v1/setup/status')
      .then((r) => r.json() as Promise<{ setupRequired: boolean }>)
      .then((data) => setSetupRequired(!!data.setupRequired))
      .catch(() => setSetupRequired(false)); // Bei Netzwerkfehler durchlassen
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
      <div className="min-h-screen bg-[#0078D4] flex items-center justify-center">
        <div className="text-white text-sm animate-pulse">CoreMail wird geladen…</div>
      </div>
    );
  }
  // Während Navigate-Redirect noch läuft, falsche Routes nicht rendern
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
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        {/* v3.18.22 D1: OAuth2-Consent — braucht Auth, aber kein Layout */}
        <Route path="/oauth-consent" element={
          <AuthGuard>
            <OAuthConsentPage />
          </AuthGuard>
        } />
        <Route path="/*" element={
          <AuthGuard>
            <Layout>
              <Routes>
                <Route path="/mail" element={<MailPage />} />
                <Route path="/shared-mailbox/:id" element={<SharedMailboxPage />} />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/contacts" element={<ContactsPage />} />
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
