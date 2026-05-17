import { Sun, Moon, Monitor, Mail, ChevronDown, LogOut, Languages } from 'lucide-react';
import { useState } from 'react';
import { useThemeStore, resolveIsDark, type ThemeMode } from '../store/theme.js';
import { useLanguageStore, type Lang } from '../store/language.js';
import { clearToken, getToken } from '../api/client.js';
import { useT } from '../i18n/useT.js';

// ── JWT-Payload ohne jsonwebtoken (nur base64-Decode, kein Verify) ────────────
function decodeJwtPayload(token: string): { email?: string; role?: string } {
  try {
    const payload = token.split('.')[1] ?? '';
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as {
      email?: string;
      role?: string;
    };
  } catch {
    return {};
  }
}

function formatRole(role: string): string {
  return role.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark'];

const LANG_OPTIONS: { value: Lang; flag: string; label: string; labelEn: string }[] = [
  { value: 'de', flag: '🇩🇪', label: 'Deutsch',  labelEn: 'German'  },
  { value: 'en', flag: '🇬🇧', label: 'English',  labelEn: 'English' },
];

export function TopBar() {
  const t = useT();
  const { theme, setTheme } = useThemeStore();
  const { pending, setPending, applyPending } = useLanguageStore();
  const [profileOpen, setProfileOpen] = useState(false);

  const token = getToken();
  const { email = '', role = '' } = token ? decodeJwtPayload(token) : {};
  const initials = email.charAt(0).toUpperCase() || '?';

  const THEME_META: Record<ThemeMode, { icon: React.ElementType; label: string }> = {
    system: { icon: Monitor, label: t('topbar_theme_system') },
    light:  { icon: Sun,     label: t('topbar_theme_light')  },
    dark:   { icon: Moon,    label: t('topbar_theme_dark')   },
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

  return (
    <header className="h-11 bg-gray-900 border-b border-gray-700 flex items-center px-4 gap-3 shrink-0 z-40">
      {/* Brand */}
      <div className="flex items-center gap-2">
        <Mail size={17} className="text-accent" />
        <span className="text-white font-semibold text-sm">{t('topbar_brand')}</span>
        <span className="text-gray-500 text-xs hidden md:block">{t('topbar_subtitle')}</span>
      </div>

      <div className="flex-1" />

      {/* Theme-Toggle */}
      <button
        onClick={cycleTheme}
        title={`${t('topbar_theme_hint')}: ${themeLabel}`}
        className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
      >
        <ThemeIcon size={16} />
      </button>

      {/* User-Profil */}
      <div className="relative">
        <button
          onClick={() => setProfileOpen((o) => !o)}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-gray-300 hover:text-white hover:bg-gray-800 transition-colors"
        >
          <div className="w-6 h-6 rounded-full bg-accent/30 flex items-center justify-center text-xs font-bold text-white select-none">
            {initials}
          </div>
          <span className="text-xs hidden sm:block max-w-[160px] truncate">{email}</span>
          <ChevronDown size={12} />
        </button>

        {profileOpen && (
          <>
            {/* Klick außerhalb schließt Dropdown */}
            <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />

            <div className="absolute right-0 top-full mt-1 w-64 bg-white dark:bg-gray-800 shadow-xl border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden z-50">

              {/* Avatar + Info */}
              <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 text-center">
                <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-base font-bold text-accent mx-auto mb-2 select-none">
                  {initials}
                </div>
                <p className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate">{email}</p>
                {role && (
                  <span className="inline-block mt-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                    {formatRole(role)}
                  </span>
                )}
              </div>

              {/* Sprache */}
              <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">
                  <Languages size={12} />
                  {t('topbar_language')}
                </p>
                <div className="flex gap-2">
                  {LANG_OPTIONS.map(({ value, flag, label }) => (
                    <button
                      key={value}
                      onClick={() => setPending(value)}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                        pending === value
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-gray-300'
                      }`}
                    >
                      <span className="text-base leading-none">{flag}</span>
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={handleLangSave}
                  className="mt-2 w-full py-1.5 rounded-lg text-xs font-semibold bg-accent text-white hover:bg-accent/90 transition-colors"
                >
                  {t('topbar_lang_save')}
                </button>
              </div>

              {/* Abmelden */}
              <button
                onClick={() => { clearToken(); window.location.href = '/bcp/login'; }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <LogOut size={14} />
                {t('topbar_sign_out')}
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
