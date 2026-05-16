import { StrictMode, Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { Sidebar } from './components/Sidebar.js';
import { LoginPage } from './pages/LoginPage.js';
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
import { OrganisationPage } from './pages/OrganisationPage.js';
import { GroupsPage } from './pages/GroupsPage.js';
import { ResourcesPage } from './pages/ResourcesPage.js';
import { ExternalContactsPage } from './pages/ExternalContactsPage.js';
import { RbacPage } from './pages/RbacPage.js';
import { EDiscoveryPage } from './pages/EDiscoveryPage.js';
import { JournalingPage } from './pages/JournalingPage.js';
import { RetentionPage } from './pages/RetentionPage.js';
import { AuditLogPage } from './pages/AuditLogPage.js';
import { OAuthClientsPage } from './pages/OAuthClientsPage.js';
import { GatewayPage } from './pages/GatewayPage.js';
import { PublicFoldersPage } from './pages/PublicFoldersPage.js';
import { ComplianceInfoPage } from './pages/ComplianceInfoPage.js';
import { getToken } from './api/client.js';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

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
  return (
    <div className="h-full flex">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-gray-50">
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/ecp">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
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
                  <Route path="/organisation"   element={<OrganisationPage />} />
                  <Route path="/groups"         element={<GroupsPage />} />
                  <Route path="/resources"      element={<ResourcesPage />} />
                  <Route path="/ext-contacts"   element={<ExternalContactsPage />} />
                  <Route path="/rbac"           element={<RbacPage />} />
                  <Route path="/ediscovery"     element={<EDiscoveryPage />} />
                  <Route path="/journaling"     element={<JournalingPage />} />
                  <Route path="/retention"      element={<RetentionPage />} />
                  <Route path="/audit-log"     element={<AuditLogPage />} />
                  <Route path="/oauth-clients" element={<OAuthClientsPage />} />
                  <Route path="/gateway"       element={<GatewayPage />} />
                  <Route path="/public-folders" element={<PublicFoldersPage />} />
                  <Route path="/reports" element={<ReportsPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="/compliance-info" element={<ComplianceInfoPage />} />
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
