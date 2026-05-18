import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { TopBar } from './components/TopBar.js';
import { ComposeWindow } from './components/ComposeWindow.js';
import { LoginPage } from './pages/LoginPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { MailPage } from './pages/MailPage.js';
import { CalendarPage } from './pages/CalendarPage.js';
import { ContactsPage } from './pages/ContactsPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { NotesPage } from './pages/NotesPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { useAuthStore } from './store/auth.js';
import { useUiStore, useThemeStore, resolveIsDark } from './store/ui.js';
import { useMailEvents } from './hooks/useMailEvents.js';
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
        const handler = () => { if (theme === 'system')
            apply(); };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [theme]);
    return null;
}
const APP_MAP = {
    '/mail': 'mail',
    '/calendar': 'calendar',
    '/contacts': 'contacts',
    '/tasks': 'tasks',
    '/notes': 'notes',
};
function AuthGuard({ children }) {
    const token = useAuthStore((s) => s.accessToken);
    if (!token)
        return _jsx(Navigate, { to: "/login", replace: true });
    return _jsx(_Fragment, { children: children });
}
function Layout({ children }) {
    const location = useLocation();
    const navigate = useNavigate();
    const { composeOpen } = useUiStore();
    useMailEvents();
    const currentApp = APP_MAP[location.pathname] ?? 'mail';
    const handleSearch = (q) => {
        if (q)
            navigate(`/mail?q=${encodeURIComponent(q)}`);
    };
    return (_jsxs("div", { className: "h-full flex flex-col", children: [_jsx(TopBar, { onSearch: handleSearch, currentApp: currentApp }), _jsx("main", { className: "flex-1 flex overflow-hidden", children: children }), composeOpen && _jsx(ComposeWindow, {})] }));
}
// Prüft beim Start ob Setup erforderlich ist
function SetupGuard({ children }) {
    const navigate = useNavigate();
    const [checked, setChecked] = useState(false);
    useEffect(() => {
        fetch('/api/v1/setup/status')
            .then((r) => r.json())
            .then((data) => {
            if (data.setupRequired)
                navigate('/setup', { replace: true });
        })
            .catch(() => { })
            .finally(() => setChecked(true));
    }, [navigate]);
    if (!checked) {
        return (_jsx("div", { className: "min-h-screen bg-[#0078D4] flex items-center justify-center", children: _jsx("div", { className: "text-white text-sm animate-pulse", children: "CoreMail wird geladen\u2026" }) }));
    }
    return _jsx(_Fragment, { children: children });
}
export function App() {
    return (_jsxs(_Fragment, { children: [_jsx(ThemeApplier, {}), _jsxs(Routes, { children: [_jsx(Route, { path: "/setup", element: _jsx(SetupPage, {}) }), _jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { path: "/*", element: _jsx(SetupGuard, { children: _jsx(AuthGuard, { children: _jsx(Layout, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/mail", element: _jsx(MailPage, {}) }), _jsx(Route, { path: "/calendar", element: _jsx(CalendarPage, {}) }), _jsx(Route, { path: "/contacts", element: _jsx(ContactsPage, {}) }), _jsx(Route, { path: "/tasks", element: _jsx(TasksPage, {}) }), _jsx(Route, { path: "/notes", element: _jsx(NotesPage, {}) }), _jsx(Route, { path: "/settings", element: _jsx(SettingsPage, {}) }), _jsx(Route, { path: "/", element: _jsx(Navigate, { to: "/mail", replace: true }) })] }) }) }) }) })] })] }));
}
