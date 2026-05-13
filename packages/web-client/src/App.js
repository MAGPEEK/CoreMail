import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
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
const APP_MAP = {
    '/mail': 'mail',
    '/calendar': 'calendar',
    '/contacts': 'contacts',
    '/tasks': 'tasks',
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
export function App() {
    return (_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { path: "/*", element: _jsx(AuthGuard, { children: _jsx(Layout, { children: _jsxs(Routes, { children: [_jsx(Route, { path: "/mail", element: _jsx(MailPage, {}) }), _jsx(Route, { path: "/calendar", element: _jsx(CalendarPage, {}) }), _jsx(Route, { path: "/contacts", element: _jsx(ContactsPage, {}) }), _jsx(Route, { path: "/tasks", element: _jsx(TasksPage, {}) }), _jsx(Route, { path: "/settings", element: _jsx(SettingsPage, {}) }), _jsx(Route, { path: "/", element: _jsx(Navigate, { to: "/mail", replace: true }) })] }) }) }) })] }));
}
