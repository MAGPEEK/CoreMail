import { StrictMode, Component, useEffect, useLayoutEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryCache, MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import toast, { Toaster } from 'react-hot-toast';
import { Lock, Loader2 } from 'lucide-react';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { useThemeStore, resolveIsDark } from './store/theme.js';
import { useBranding, useBrandingSync } from './hooks/useBranding.js';
import { brandCssVars, headerHex, hexToChannels, DEFAULT_ACCENT_RGB } from './lib/branding.js';
import { LoginPage } from './pages/LoginPage.js';
import { MfaRequiredPage } from './pages/MfaRequiredPage.js';
import { SsoCallbackPage } from './pages/SsoCallbackPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { MailboxesPage } from './pages/MailboxesPage.js';
import { DomainsPage } from './pages/DomainsPage.js';
import { QueuesPage } from './pages/QueuesPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { BackupsPage } from './pages/BackupsPage.js';
import { ProtectionPage } from './pages/ProtectionPage.js';
import { ServersPage } from './pages/ServersPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { CertificatesPage } from './pages/CertificatesPage.js';
import { SharedMailboxesPage } from './pages/SharedMailboxesPage.js';
import { QuarantinePage } from './pages/QuarantinePage.js';
import { TransportRulesPage } from './pages/TransportRulesPage.js';
import { MessageTracePage } from './pages/MessageTracePage.js';
import { ServicesLegacyRedirect, ServicesPage } from './pages/ServicesPage.js';
import { WebmailPoliciesPage } from './pages/WebmailPoliciesPage.js';
// ExternalContactsPage completely removed in v3.18.33
import { RbacPage } from './pages/RbacPage.js';
// eDiscovery & Legal Hold completely removed in v3.18.5
// Journaling feature completely removed in v3.13.6
import { RetentionPage } from './pages/RetentionPage.js';
import { AuditLogPage } from './pages/AuditLogPage.js';
// PublicFoldersPage completely removed in v3.18.31
import { ComplianceInfoPage } from './pages/ComplianceInfoPage.js';
import { SmtpConfigPage } from './pages/SmtpConfigPage.js';
import { LdapPage } from './pages/LdapPage.js';
import { SsoPage } from './pages/SsoPage.js';
import { BrandingPage } from './pages/BrandingPage.js';
import { McpPage } from './pages/McpPage.js';
import { getToken, useSessionChecked } from './api/client.js';
import { useAccessStore } from './store/access.js';
import { firstAllowedPath } from './lib/adminAreas.js';
import { usePermissions, usePermissionsLoader } from './hooks/usePermissions.js';
import { ForbiddenPage } from './pages/ForbiddenPage.js';
import { useT } from './i18n/useT.js';
import { ApiError } from './lib/errors.js';
import { useInactivityLogout } from './hooks/useInactivityLogout.js';
import './index.css';

function toastError(err: unknown) {
  const msg = err instanceof Error && err.message ? err.message : 'Unbekannter Fehler';
  // Redirect cases are handled by the API client
  if (msg === 'Session expired' || msg === 'MFA_REQUIRED') return;
  toast.error(msg, { id: `err:${msg}` });
}

// Global error reporting: failed queries/mutations show a toast unless the query
// opts out (meta.silentError) or the mutation has its own onError handler.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err, query) => {
      // 403 on background reads = area not granted (e.g. dashboard widgets of other areas) — no toast spam
      if (query.meta?.['silentError'] || (err instanceof ApiError && err.status === 403)) return;
      toastError(err);
    },
  }),
  mutationCache: new MutationCache({
    onError: (err, _v, _c, mutation) => { if (!mutation.options.onError && !mutation.meta?.['silentError']) toastError(err); },
  }),
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

// ── ThemeApplier — reacts to store changes (no OWA sync!) ───────────────────
function ThemeApplier() {
  const { theme } = useThemeStore();
  const branding = useBranding();
  useBrandingSync('bcp');
  // 9.3: the BCP accent is always the brand primary colour (no per-user accent),
  // fill darkened for white text >= 4.5:1, accent text derived per theme.
  const accent = hexToChannels(branding.primaryColor) ?? DEFAULT_ACCENT_RGB;
  const header = headerHex(branding);

  // layout effect: colours are set before the first paint (no flash of the default accent)
  useLayoutEffect(() => {
    const apply = (isDark: boolean) => {
      document.documentElement.classList.toggle('dark', isDark);
      for (const [k, v] of Object.entries(brandCssVars(accent, header, isDark))) {
        document.documentElement.style.setProperty(k, v);
      }
    };
    apply(resolveIsDark(theme));

    // Follow the system preference live when theme==='system'
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => apply(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme, accent, header]);

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
          <div className="bg-danger-bg border border-danger-line rounded-lg p-6 space-y-3">
            <h2 className="text-lg font-semibold text-danger-fg">Seite konnte nicht geladen werden</h2>
            <p className="text-sm text-danger-fg">{this.state.error.message}</p>
            <pre className="text-xs text-danger-fg bg-danger-bg rounded p-3 overflow-auto max-h-48">
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
  // v8.1: the access token is memory-only — after a reload wait for the
  // cookie-based session check (cm_rt_bcp) before showing the login page.
  const sessionChecked = useSessionChecked();
  if (!getToken() && !sessionChecked) return null;
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// ── Setup-Guard ───────────────────────────────────────────────────────────────
// As long as no admin exists in the DB yet, the user MUST first complete the
// initial setup in the MWA (/setup).  BCP has no setup page of its own —
// so we redirect to the MWA path (leaves the /bcp basename entirely).
function SetupGuard({ children }: { children: React.ReactNode }) {
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const { productName } = useBranding();

  useEffect(() => {
    fetch('/api/v1/setup/status')
      .then((r) => r.json() as Promise<{ setupRequired: boolean }>)
      .then((data) => setSetupRequired(!!data.setupRequired))
      .catch(() => setSetupRequired(false)); // Let through on network errors
  }, []);

  useEffect(() => {
    if (setupRequired === true) {
      // Full hard redirect — leaves the /bcp basename and lands in the MWA setup wizard
      window.location.href = '/setup';
    }
  }, [setupRequired]);

  if (setupRequired === null || setupRequired === true) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="text-fg-muted text-sm animate-pulse">{productName} wird geladen…</div>
      </div>
    );
  }
  return <>{children}</>;
}

function PermissionsLoading() {
  const t = useT();
  return (
    <div className="p-8 flex items-center justify-center gap-2 text-sm text-fg-subtle" role="status">
      <Loader2 size={16} className="animate-spin" aria-hidden="true" /> {t('perm_loading')}
    </div>
  );
}

function AdminLayout({ children }: { children: React.ReactNode }) {
  // Automatic logout on inactivity — configurable in Global Settings
  useInactivityLogout();
  // Permissions (GET /admin/me/permissions) — consumed via usePermissions() / <Can>
  usePermissionsLoader();
  const location = useLocation();
  const t = useT();
  const { ready, pageAccess } = usePermissions();

  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <main
          className="flex-1 overflow-y-auto bg-canvas"
          {...(ready && pageAccess === 'read' ? { 'data-area-readonly': '' } : {})}
        >
          {ready && pageAccess === 'read' && (
            <div role="status" className="m-4 mb-0 flex items-center gap-2 px-3 py-2 rounded border border-warning-line bg-warning-bg text-warning-fg text-xs">
              <Lock size={13} aria-hidden="true" /> {t('perm_readonly_banner')}
            </div>
          )}
          <ErrorBoundary key={location.pathname}>
            {/* Pages render only once the permissions are known: a forbidden
                route shows the 403 page instead of firing API calls that fail. */}
            {!ready ? <PermissionsLoading /> : pageAccess === 'none' ? <ForbiddenPage /> : children}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

/** "/" → first page the admin may see */
function HomeRedirect() {
  const areas = useAccessStore((s) => s.areas);
  return <Navigate to={firstAllowedPath(areas)} replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeApplier />
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/bcp">
        <SetupGuard>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/mfa-required" element={<MfaRequiredPage />} />
          <Route path="/sso/callback" element={<SsoCallbackPage />} />
          <Route path="/*" element={
            <AuthGuard>
              <AdminLayout>
                <Routes>
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/mailboxes" element={<MailboxesPage />} />
                  <Route path="/domains" element={<DomainsPage />} />
                  <Route path="/queues" element={<QueuesPage />} />
                  <Route path="/logs" element={<LogsPage />} />
                  <Route path="/backups" element={<BackupsPage />} />
                  <Route path="/protection" element={<ProtectionPage />} />
                  <Route path="/servers" element={<ServersPage />} />
                  <Route path="/services" element={<ServicesPage />} />
                  <Route path="/services/:sub" element={<ServicesLegacyRedirect />} />
                  <Route path="/webmail-policies" element={<WebmailPoliciesPage />} />
                  <Route path="/certificates"    element={<CertificatesPage />} />
                  <Route path="/shared-mailboxes" element={<SharedMailboxesPage />} />
                  <Route path="/quarantine"      element={<QuarantinePage />} />
                  <Route path="/transport-rules" element={<TransportRulesPage />} />
                  <Route path="/message-trace"  element={<MessageTracePage />} />
                  <Route path="/connectors"     element={<Navigate to="/services" replace />} />
                  {/* /groups route removed in v5.6.1 (DistributionGroups dropped) */}
                  {/* /ext-contacts route removed in v3.18.33 */}
                  <Route path="/rbac"           element={<RbacPage />} />
                  <Route path="/retention"      element={<RetentionPage />} />
                  <Route path="/audit-log"     element={<AuditLogPage />} />
                  {/* /oauth-clients route removed in v5.6.0 (OAuth2 dropped entirely) */}
                  {/* /public-folders route removed in v3.18.31 */}
                  {/* /reports removed in the 9.1 BCP review (static placeholder data; the dashboard shows the real mail flow) */}
                  <Route path="/reports" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/compliance-info" element={<ComplianceInfoPage />} />
                  <Route path="/smtp-config" element={<SmtpConfigPage />} />
                  <Route path="/ldap"        element={<LdapPage />} />
                  <Route path="/sso"         element={<SsoPage />} />
                  <Route path="/branding"    element={<BrandingPage />} />
                  <Route path="/mcp"         element={<McpPage />} />
                  <Route path="/" element={<HomeRedirect />} />
                </Routes>
              </AdminLayout>
            </AuthGuard>
          } />
        </Routes>
        </SetupGuard>
        <Toaster position="top-right" toastOptions={{ duration: 3000 }} />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
