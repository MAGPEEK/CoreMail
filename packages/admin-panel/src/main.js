import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
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
function AuthGuard({ children }) {
    if (!getToken())
        return _jsx(Navigate, { to: "/login", replace: true });
    return _jsx(_Fragment, { children: children });
}
function AdminLayout({ children }) {
    return (_jsxs("div", { className: "h-full flex", children: [_jsx(Sidebar, {}), _jsx("main", { className: "flex-1 overflow-y-auto bg-gray-50", children: children })] }));
}
createRoot(document.getElementById('root')).render(_jsx(StrictMode, { children: _jsx(QueryClientProvider, { client: queryClient, children: _jsxs(BrowserRouter, { children: [_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { path: "/*", element: _jsx(AuthGuard, { children: _jsx(AdminLayout, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/dashboard", element: _jsx(DashboardPage, {}) }), _jsx(Route, { path: "/mailboxes", element: _jsx(MailboxesPage, {}) }), _jsx(Route, { path: "/domains", element: _jsx(DomainsPage, {}) }), _jsx(Route, { path: "/queues", element: _jsx(QueuesPage, {}) }), _jsx(Route, { path: "/logs", element: _jsx(LogsPage, {}) }), _jsx(Route, { path: "/protection", element: _jsx(ProtectionPage, {}) }), _jsx(Route, { path: "/servers", element: _jsx(ServersPage, {}) }), _jsx(Route, { path: "/reports", element: _jsx(ReportsPage, {}) }), _jsx(Route, { path: "/", element: _jsx(Navigate, { to: "/dashboard", replace: true }) })] }) }) }) })] }), _jsx(Toaster, { position: "top-right", toastOptions: { duration: 3000 } })] }) }) }));
