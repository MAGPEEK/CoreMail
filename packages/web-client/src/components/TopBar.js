import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Calendar, Users, CheckSquare, Search, Bell, Settings, LogOut, ChevronDown } from 'lucide-react';
import { useAuthStore } from '../store/auth.js';
export function TopBar({ onSearch, currentApp }) {
    const navigate = useNavigate();
    const { displayName, email, logout } = useAuthStore();
    const [search, setSearch] = useState('');
    const [profileOpen, setProfileOpen] = useState(false);
    const apps = [
        { id: 'mail', label: 'Mail', icon: Mail, path: '/mail' },
        { id: 'calendar', label: 'Kalender', icon: Calendar, path: '/calendar' },
        { id: 'contacts', label: 'Kontakte', icon: Users, path: '/contacts' },
        { id: 'tasks', label: 'Aufgaben', icon: CheckSquare, path: '/tasks' },
    ];
    const handleSearch = (e) => {
        e.preventDefault();
        onSearch(search);
    };
    return (_jsxs("header", { className: "h-12 bg-accent flex items-center px-3 gap-3 shrink-0 z-50", children: [_jsxs("div", { className: "flex items-center gap-2 text-white font-semibold text-base mr-2", children: [_jsx(Mail, { size: 18 }), _jsx("span", { children: "CoreMail" })] }), _jsx("nav", { className: "flex items-center gap-0.5", children: apps.map(({ id, label, icon: Icon, path }) => (_jsxs("button", { onClick: () => navigate(path), className: `flex items-center gap-1.5 px-3 py-1.5 rounded text-sm text-white/90 hover:bg-white/20 transition-colors ${currentApp === id ? 'bg-white/20 font-medium' : ''}`, children: [_jsx(Icon, { size: 15 }), label] }, id))) }), _jsx("form", { onSubmit: handleSearch, className: "flex-1 max-w-xl mx-4", children: _jsxs("div", { className: "relative", children: [_jsx(Search, { size: 15, className: "absolute left-3 top-1/2 -translate-y-1/2 text-white/60" }), _jsx("input", { type: "text", placeholder: "Suchen...", value: search, onChange: (e) => setSearch(e.target.value), className: "w-full bg-white/20 text-white placeholder-white/60 border border-white/30 rounded px-3 py-1 pl-8 text-sm outline-none focus:bg-white/30 transition-colors" })] }) }), _jsxs("div", { className: "ml-auto flex items-center gap-1", children: [_jsx("button", { className: "p-1.5 rounded text-white/80 hover:bg-white/20 transition-colors", children: _jsx(Bell, { size: 17 }) }), _jsx("button", { onClick: () => navigate('/settings'), className: "p-1.5 rounded text-white/80 hover:bg-white/20 transition-colors", children: _jsx(Settings, { size: 17 }) }), _jsxs("div", { className: "relative", children: [_jsxs("button", { onClick: () => setProfileOpen((o) => !o), className: "flex items-center gap-1.5 ml-1 px-2 py-1 rounded text-white/90 hover:bg-white/20 transition-colors", children: [_jsx("div", { className: "w-7 h-7 rounded-full bg-white/30 flex items-center justify-center text-xs font-bold text-white", children: displayName?.charAt(0).toUpperCase() ?? '?' }), _jsx(ChevronDown, { size: 13 })] }), profileOpen && (_jsxs("div", { className: "absolute right-0 top-full mt-1 w-52 bg-white shadow-lg border border-gray-200 rounded py-1 z-50", children: [_jsxs("div", { className: "px-3 py-2 border-b border-gray-100", children: [_jsx("p", { className: "font-medium text-sm text-gray-800", children: displayName }), _jsx("p", { className: "text-xs text-gray-500", children: email })] }), _jsxs("button", { onClick: () => { logout(); navigate('/login'); }, className: "w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50", children: [_jsx(LogOut, { size: 14 }), "Abmelden"] })] }))] })] })] }));
}
