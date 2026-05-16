import { StrictMode } from 'react';
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
import { ServicesPage } from './pages/ServicesPage.js';
import { ReportsPage } from './pages/ReportsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { CertificatesPage } from './pages/CertificatesPage.js';
import { SharedMailboxesPage } from './pages/SharedMailboxesPage.js';
import { QuarantinePage } from './pages/QuarantinePage.js';
import { TransportRulesPage } from './pages/TransportRulesPage.js';
import { MessageTracePage } from './pages/MessageTracePage.js';
import { ConnectorsPage } from './pages/ConnectorsPage.js';
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
import { getToken } from './api/client.js';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

function AuthGuard({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex">
      <Sidebar />
      <main className="flex-1 overflow-y-auto bg-gray-50">{children}</main>
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
                  <Route path="/connectors"     element={<ConnectorsPage />} />
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
