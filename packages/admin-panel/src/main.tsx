import { StrictMode, Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { useThemeStore, resolveIsDark, ECP_ACCENT_RGB } from './store/theme.js';
import { LoginPage } from './pages/LoginPage.js';
import { MfaRequiredPage } from './pages/MfaRequiredPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { MailboxesPage } from './pages/MailboxesPage.js';
import { DomainsPage } from './pages/DomainsPage.js';
import { QueuesPage } from './pages/QueuesPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { ProtectionPage } from './pages/ProtectionPage.js';
import { ServersPage } from './pages/ServersPage.js';
import { ReportsPage } from './pages/ReportsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { CertificatesPage } from './pages/CertificatesPage.js';
import { SharedMailboxesPage } from './pages/SharedMailboxesPage.js';
import { QuarantinePage } from './pages/QuarantinePage.js';
import { TransportRulesPage } from './pages/TransportRulesPage.js';
import { MessageTracePage } from './pages/MessageTracePage.js';
import { ServicesPage } from './pages/ServicesPage.js';
import { GroupsPage } from './pages/GroupsPage.js';
import { ExternalContactsPage } from './pages/ExternalContactsPage.js';
import { RbacPage } from './pages/RbacPage.js';
// eDiscovery & Legal Hold komplett entfernt in v3.18.5
// Journaling-Feature komplett entfernt in v3.13.6
import { RetentionPage } from './pages/RetentionPage.js';
import { AuditLogPage } from './pages/AuditLogPage.js';
import { OAuthClientsPage } from './pages/OAuthClientsPage.js';
import { PublicFoldersPage } from './pages/PublicFoldersPage.js';
import { ComplianceInfoPage } from './pages/ComplianceInfoPage.js';
import { SmtpConfigPage } from './pages/SmtpConfigPage.js';
import { LdapPage } from './pages/LdapPage.js';
import { SsoPage } from './pages/SsoPage.js';
import { getToken } from './api/client.js';
import { useInactivityLogout } from './hooks/useInactivityLogout.js';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

// ── ThemeApplier — reagiert auf Store-Änderungen (kein OWA-Sync!) ───────────
function ThemeApplier() {
  const { theme } = useThemeStore();

  // Dark Mode auf document anwenden wenn sich Store ändert
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolveIsDark(theme));
    // Akzentfarbe ist im BCP immer Microsoft-Blau — unabhängig vom OWA-Theme
    document.documentElement.style.setProperty('--color-accent', ECP_ACCENT_RGB);
  }, [theme]);

  // System-Präferenz bei theme==='system' live übernehmen
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => document.documentElement.classList.toggle('dark', mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  return null;
}

// ── Error Boundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-8 space-y-4 max-w-2xl mx-auto mt-16">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 space-y-3">
            <h2 className="text-lg font-semibold text-red-800">Seite konnte nicht geladen werden</h2>
            <p className="text-sm text-red-700">{this.state.error.message}</p>
            <pre className="text-xs text-red-600 bg-red-100 rounded p-3 overflow-auto max-h-48">
              {this.state.error.stack}
            </pre>
            <button
              onClick={() => { this.setState({ error: null }); window.location.reload(); }}
              className="btn-secondary text-sm"
            >
              Seite neu laden
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminLayout({ children }: { children: React.ReactNode }) {
  // Automatischer Logout bei Inaktivität — konfigurierbar in Global Settings
  useInactivityLogout();

  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950">
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeApplier />
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/bcp">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/mfa-required" element={<MfaRequiredPage />} />
          <Route path="/*" element={
            <AuthGuard>
              <AdminLayout>
                <Routes>
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/mailboxes" element={<MailboxesPage />} />
                  <Route path="/domains" element={<DomainsPage />} />
                  <Route path="/queues" element={<QueuesPage />} />
                  <Route path="/logs" element={<LogsPage />} />
                  <Route path="/protection" element={<ProtectionPage />} />
                  <Route path="/servers" element={<ServersPage />} />
                  <Route path="/services" element={<ServicesPage />} />
                  <Route path="/certificates"    element={<CertificatesPage />} />
                  <Route path="/shared-mailboxes" element={<SharedMailboxesPage />} />
                  <Route path="/quarantine"      element={<QuarantinePage />} />
                  <Route path="/transport-rules" element={<TransportRulesPage />} />
                  <Route path="/message-trace"  element={<MessageTracePage />} />
                  <Route path="/connectors"     element={<Navigate to="/services" replace />} />
                  <Route path="/groups"         element={<GroupsPage />} />
                  <Route path="/ext-contacts"   element={<ExternalContactsPage />} />
                  <Route path="/rbac"           element={<RbacPage />} />
                  <Route path="/retention"      element={<RetentionPage />} />
                  <Route path="/audit-log"     element={<AuditLogPage />} />
                  <Route path="/oauth-clients" element={<OAuthClientsPage />} />
                  <Route path="/public-folders" element={<PublicFoldersPage />} />
                  <Route path="/reports" element={<ReportsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/compliance-info" element={<ComplianceInfoPage />} />
                  <Route path="/smtp-config" element={<SmtpConfigPage />} />
                  <Route path="/ldap"        element={<LdapPage />} />
                  <Route path="/sso"         element={<SsoPage />} />
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </AdminLayout>
            </AuthGuard>
          } />
        </Routes>
        <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
