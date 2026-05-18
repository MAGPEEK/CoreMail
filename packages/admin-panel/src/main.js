import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { StrictMode, Component, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { useThemeStore, resolveIsDark, ECP_ACCENT_RGB } from './store/theme.js';
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
import { PublicFoldersPage } from './pages/PublicFoldersPage.js';
import { ComplianceInfoPage } from './pages/ComplianceInfoPage.js';
import { SmtpConfigPage } from './pages/SmtpConfigPage.js';
import { LdapPage } from './pages/LdapPage.js';
import { SsoPage } from './pages/SsoPage.js';
import { getToken } from './api/client.js';
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
        if (theme !== 'system')
            return;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => document.documentElement.classList.toggle('dark', mq.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [theme]);
    return null;
}
// ── Error Boundary ───────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error, info) {
        console.error('[ErrorBoundary]', error, info.componentStack);
    }
    render() {
        if (this.state.error) {
            return (_jsx("div", { className: "p-8 space-y-4 max-w-2xl mx-auto mt-16", children: _jsxs("div", { className: "bg-red-50 border border-red-200 rounded-lg p-6 space-y-3", children: [_jsx("h2", { className: "text-lg font-semibold text-red-800", children: "Seite konnte nicht geladen werden" }), _jsx("p", { className: "text-sm text-red-700", children: this.state.error.message }), _jsx("pre", { className: "text-xs text-red-600 bg-red-100 rounded p-3 overflow-auto max-h-48", children: this.state.error.stack }), _jsx("button", { onClick: () => { this.setState({ error: null }); window.location.reload(); }, className: "btn-secondary text-sm", children: "Seite neu laden" })] }) }));
        }
        return this.props.children;
    }
}
function AuthGuard({ children }) {
    if (!getToken())
        return _jsx(Navigate, { to: "/login", replace: true });
    return _jsx(_Fragment, { children: children });
}
function AdminLayout({ children }) {
    return (_jsxs("div", { className: "h-full flex flex-col", children: [_jsx(TopBar, {}), _jsxs("div", { className: "flex-1 flex overflow-hidden", children: [_jsx(Sidebar, {}), _jsx("main", { className: "flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950", children: _jsx(ErrorBoundary, { children: children }) })] })] }));
}
createRoot(document.getElementById('root')).render(_jsxs(StrictMode, { children: [_jsx(ThemeApplier, {}), _jsx(QueryClientProvider, { client: queryClient, children: _jsxs(BrowserRouter, { basename: "/bcp", children: [_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { path: "/*", element: _jsx(AuthGuard, { children: _jsx(AdminLayout, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/dashboard", element: _jsx(DashboardPage, {}) }), _jsx(Route, { path: "/mailboxes", element: _jsx(MailboxesPage, {}) }), _jsx(Route, { path: "/domains", element: _jsx(DomainsPage, {}) }), _jsx(Route, { path: "/queues", element: _jsx(QueuesPage, {}) }), _jsx(Route, { path: "/logs", element: _jsx(LogsPage, {}) }), _jsx(Route, { path: "/protection", element: _jsx(ProtectionPage, {}) }), _jsx(Route, { path: "/servers", element: _jsx(ServersPage, {}) }), _jsx(Route, { path: "/services", element: _jsx(ServicesPage, {}) }), _jsx(Route, { path: "/certificates", element: _jsx(CertificatesPage, {}) }), _jsx(Route, { path: "/shared-mailboxes", element: _jsx(SharedMailboxesPage, {}) }), _jsx(Route, { path: "/quarantine", element: _jsx(QuarantinePage, {}) }), _jsx(Route, { path: "/transport-rules", element: _jsx(TransportRulesPage, {}) }), _jsx(Route, { path: "/message-trace", element: _jsx(MessageTracePage, {}) }), _jsx(Route, { path: "/connectors", element: _jsx(Navigate, { to: "/services", replace: true }) }), _jsx(Route, { path: "/organisation", element: _jsx(OrganisationPage, {}) }), _jsx(Route, { path: "/groups", element: _jsx(GroupsPage, {}) }), _jsx(Route, { path: "/resources", element: _jsx(ResourcesPage, {}) }), _jsx(Route, { path: "/ext-contacts", element: _jsx(ExternalContactsPage, {}) }), _jsx(Route, { path: "/rbac", element: _jsx(RbacPage, {}) }), _jsx(Route, { path: "/ediscovery", element: _jsx(EDiscoveryPage, {}) }), _jsx(Route, { path: "/journaling", element: _jsx(JournalingPage, {}) }), _jsx(Route, { path: "/retention", element: _jsx(RetentionPage, {}) }), _jsx(Route, { path: "/audit-log", element: _jsx(AuditLogPage, {}) }), _jsx(Route, { path: "/oauth-clients", element: _jsx(OAuthClientsPage, {}) }), _jsx(Route, { path: "/public-folders", element: _jsx(PublicFoldersPage, {}) }), _jsx(Route, { path: "/reports", element: _jsx(ReportsPage, {}) }), _jsx(Route, { path: "/settings", element: _jsx(SettingsPage, {}) }), _jsx(Route, { path: "/compliance-info", element: _jsx(ComplianceInfoPage, {}) }), _jsx(Route, { path: "/smtp-config", element: _jsx(SmtpConfigPage, {}) }), _jsx(Route, { path: "/ldap", element: _jsx(LdapPage, {}) }), _jsx(Route, { path: "/sso", element: _jsx(SsoPage, {}) }), _jsx(Route, { path: "/", element: _jsx(Navigate, { to: "/dashboard", replace: true }) })] }) }) }) })] }), _jsx(Toaster, { position: "top-right", toastOptions: { duration: 3000 } })] }) })] }));
