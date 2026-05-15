import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Globe, ListOrdered, ScrollText, Shield, Server, BarChart3, Mail, LogOut, } from 'lucide-react';
import { clearToken } from '../api/client.js';
const NAV = [
    { path: '/dashboard', label: 'Übersicht', icon: LayoutDashboard },
    { path: '/mailboxes', label: 'Postfächer', icon: Mail },
    { path: '/domains', label: 'Domains', icon: Globe },
    { path: '/queues', label: 'Warteschlangen', icon: ListOrdered },
    { path: '/logs', label: 'Protokolle', icon: ScrollText },
    { path: '/protection', label: 'Schutz', icon: Shield },
    { path: '/servers', label: 'Server & Health', icon: Server },
    { path: '/reports', label: 'Berichte', icon: BarChart3 },
];
export function Sidebar() {
    return (_jsxs("aside", { className: "w-52 shrink-0 bg-gray-900 text-gray-300 flex flex-col h-full", children: [_jsx("div", { className: "px-4 py-4 border-b border-gray-700", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Mail, { size: 18, className: "text-accent" }), _jsxs("div", { children: [_jsx("p", { className: "text-white font-semibold text-sm", children: "CoreMail ECP" }), _jsx("p", { className: "text-gray-500 text-xs", children: "Admin-Konsole" })] })] }) }), _jsx("nav", { className: "flex-1 overflow-y-auto py-2", children: NAV.map(({ path, label, icon: Icon }) => (_jsxs(NavLink, { to: path, className: ({ isActive }) => `flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${isActive ? 'bg-gray-800 text-white border-l-2 border-accent' : 'hover:bg-gray-800 hover:text-white'}`, children: [_jsx(Icon, { size: 15 }), label] }, path))) }), _jsx("div", { className: "p-3 border-t border-gray-700", children: _jsxs("button", { onClick: () => { clearToken(); window.location.href = '/login'; }, className: "w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors", children: [_jsx(LogOut, { size: 14 }), "Abmelden"] }) })] }));
}
