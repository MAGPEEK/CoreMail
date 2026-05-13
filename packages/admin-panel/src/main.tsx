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
import { ReportsPage } from './pages/ReportsPage.js';
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
      <BrowserRouter>
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
                  <Route path="/reports" element={<ReportsPage />} />
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
