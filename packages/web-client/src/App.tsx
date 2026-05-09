import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TopBar } from './components/TopBar.js';
import { ComposeWindow } from './components/ComposeWindow.js';
import { LoginPage } from './pages/LoginPage.js';
import { MailPage } from './pages/MailPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { ContactsPage } from './pages/ContactsPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { useAuthStore } from './store/auth.js';
import { useUiStore } from './store/ui.js';
import { useMailEvents } from './hooks/useMailEvents.js';

const APP_MAP: Record<string, 'mail' | 'calendar' | 'contacts' | 'tasks'> = {
  '/mail': 'mail',
  '/calendar': 'calendar',
  '/contacts': 'contacts',
  '/tasks': 'tasks',
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
  const [searchQ, setSearchQ] = useState('');
  useMailEvents();

  const currentApp = APP_MAP[location.pathname] ?? 'mail';

  const handleSearch = (q: string) => {
    setSearchQ(q);
    // navigate to mail search results
    if (q) navigate(`/mail?q=${encodeURIComponent(q)}`);
  };

  return (
    <div className="h-full flex flex-col">
      <TopBar onSearch={handleSearch} currentApp={currentApp} />
      <main className="flex-1 flex overflow-hidden">
        {children}
      </main>
      {composeOpen && <ComposeWindow />}
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={
        <AuthGuard>
          <Layout>
            <Routes>
              <Route path="/mail" element={<MailPage />} />
              <Route path="/calendar" element={<CalendarPage />} />
              <Route path="/contacts" element={<ContactsPage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/" element={<Navigate to="/mail" replace />} />
            </Routes>
          </Layout>
        </AuthGuard>
      } />
    </Routes>
  );
}
