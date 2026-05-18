import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Sun, Moon, Monitor, Mail, ChevronDown, LogOut, Languages } from 'lucide-react';
import { useState } from 'react';
import { useThemeStore, resolveIsDark } from '../store/theme.js';
import { useLanguageStore } from '../store/language.js';
import { clearToken, getToken } from '../api/client.js';
import { useT } from '../i18n/useT.js';
// ── JWT-Payload ohne jsonwebtoken (nur base64-Decode, kein Verify) ────────────
function decodeJwtPayload(token) {
    try {
        const payload = token.split('.')[1] ?? '';
        return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    }
    catch {
        return {};
    }
}
function formatRole(role) {
    return role.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
const THEME_CYCLE = ['system', 'light', 'dark'];
const LANG_OPTIONS = [
    { value: 'de', flag: '🇩🇪', label: 'Deutsch', labelEn: 'German' },
    { value: 'en', flag: '🇬🇧', label: 'English', labelEn: 'English' },
];
export function TopBar() {
    const t = useT();
    const { theme, setTheme } = useThemeStore();
    const { pending, setPending, applyPending } = useLanguageStore();
    const [profileOpen, setProfileOpen] = useState(false);
    const token = getToken();
    const { email = '', role = '' } = token ? decodeJwtPayload(token) : {};
    const initials = email.charAt(0).toUpperCase() || '?';
    const THEME_META = {
        system: { icon: Monitor, label: t('topbar_theme_system') },
        light: { icon: Sun, label: t('topbar_theme_light') },
        dark: { icon: Moon, label: t('topbar_theme_dark') },
    };
    // Nächstes Theme im Zyklus: system → light → dark → system …
    const cycleTheme = () => {
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
        setTheme(next);
        const isDark = resolveIsDark(next);
        document.documentElement.classList.toggle('dark', isDark);
    };
    const { icon: ThemeIcon, label: themeLabel } = THEME_META[theme];
    function handleLangSave() {
        applyPending();
        setProfileOpen(false);
    }
    return (_jsxs("header", { className: "h-11 bg-gray-900 border-b border-gray-700 flex items-center px-4 gap-3 shrink-0 z-40", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Mail, { size: 17, className: "text-accent" }), _jsx("span", { className: "text-white font-semibold text-sm", children: t('topbar_brand') }), _jsx("span", { className: "text-gray-500 text-xs hidden md:block", children: t('topbar_subtitle') })] }), _jsx("div", { className: "flex-1" }), _jsx("button", { onClick: cycleTheme, title: `${t('topbar_theme_hint')}: ${themeLabel}`, className: "p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800 transition-colors", children: _jsx(ThemeIcon, { size: 16 }) }), _jsxs("div", { className: "relative", children: [_jsxs("button", { onClick: () => setProfileOpen((o) => !o), className: "flex items-center gap-1.5 px-2 py-1 rounded text-gray-300 hover:text-white hover:bg-gray-800 transition-colors", children: [_jsx("div", { className: "w-6 h-6 rounded-full bg-accent/30 flex items-center justify-center text-xs font-bold text-white select-none", children: initials }), _jsx("span", { className: "text-xs hidden sm:block max-w-[160px] truncate", children: email }), _jsx(ChevronDown, { size: 12 })] }), profileOpen && (_jsxs(_Fragment, { children: [_jsx("div", { className: "fixed inset-0 z-40", onClick: () => setProfileOpen(false) }), _jsxs("div", { className: "absolute right-0 top-full mt-1 w-64 bg-white dark:bg-gray-800 shadow-xl border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden z-50", children: [_jsxs("div", { className: "px-4 py-3 border-b border-gray-100 dark:border-gray-700 text-center", children: [_jsx("div", { className: "w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-base font-bold text-accent mx-auto mb-2 select-none", children: initials }), _jsx("p", { className: "text-sm font-semibold text-gray-800 dark:text-gray-100 truncate", children: email }), role && (_jsx("span", { className: "inline-block mt-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent", children: formatRole(role) }))] }), _jsxs("div", { className: "px-4 py-3 border-b border-gray-100 dark:border-gray-700", children: [_jsxs("p", { className: "flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2", children: [_jsx(Languages, { size: 12 }), t('topbar_language')] }), _jsx("div", { className: "flex gap-2", children: LANG_OPTIONS.map(({ value, flag, label }) => (_jsxs("button", { onClick: () => setPending(value), className: `flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${pending === value
                                                        ? 'border-accent bg-accent/10 text-accent'
                                                        : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-gray-300'}`, children: [_jsx("span", { className: "text-base leading-none", children: flag }), label] }, value))) }), _jsx("button", { onClick: handleLangSave, className: "mt-2 w-full py-1.5 rounded-lg text-xs font-semibold bg-accent text-white hover:bg-accent/90 transition-colors", children: t('topbar_lang_save') })] }), _jsxs("button", { onClick: () => { clearToken(); window.location.href = '/bcp/login'; }, className: "w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors", children: [_jsx(LogOut, { size: 14 }), t('topbar_sign_out')] })] })] }))] })] }));
}
