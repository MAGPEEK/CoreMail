import { Sun, Moon, Monitor, Mail, ChevronDown, LogOut } from 'lucide-react';
import { useState } from 'react';
import { useThemeStore, resolveIsDark, type ThemeMode } from '../store/theme.js';
import { clearToken, getToken } from '../api/client.js';

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
const THEME_META: Record<ThemeMode, { icon: React.ElementType; label: string }> = {
  system: { icon: Monitor, label: 'System'  },
  light:  { icon: Sun,     label: 'Hell'    },
  dark:   { icon: Moon,    label: 'Dunkel'  },
};

export function TopBar() {
  const { theme, setTheme } = useThemeStore();
  const [profileOpen, setProfileOpen] = useState(false);

  const token = getToken();
  const { email = '', role = '' } = token ? decodeJwtPayload(token) : {};
  const initials = email.charAt(0).toUpperCase() || '?';

  // Nächstes Theme im Zyklus: system → light → dark → system …
  const cycleTheme = () => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
    setTheme(next);
    // Direkt anwenden (gleicher Tab — kein StorageEvent)
    const isDark = resolveIsDark(next);
    document.documentElement.classList.toggle('dark', isDark);
  };

  const { icon: ThemeIcon, label: themeLabel } = THEME_META[theme];

  return (
    <header className="h-11 bg-gray-900 border-b border-gray-700 flex items-center px-4 gap-3 shrink-0 z-40">
      {/* Brand */}
      <div className="flex items-center gap-2">
        <Mail size={17} className="text-accent" />
        <span className="text-white font-semibold text-sm">CoreMail ECP</span>
        <span className="text-gray-500 text-xs hidden md:block">Admin-Konsole</span>
      </div>

      <div className="flex-1" />

      {/* Theme-Toggle */}
      <button
        onClick={cycleTheme}
        title={`Design: ${themeLabel} — klicken zum Wechseln`}
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
            <div
              className="fixed inset-0 z-40"
              onClick={() => setProfileOpen(false)}
            />
            <div className="absolute right-0 top-full mt-1 w-60 bg-white dark:bg-gray-800 shadow-xl border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden z-50">
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

              {/* Abmelden */}
              <button
                onClick={() => { clearToken(); window.location.href = '/ecp/login'; }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                <LogOut size={14} />
                Abmelden
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
