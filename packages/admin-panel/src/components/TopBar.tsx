import { Sun, Moon, Monitor, Mail, ChevronDown, LogOut, Languages } from 'lucide-react';
import { useRef, useState } from 'react';
import { usePopoverDismiss } from './usePopoverDismiss.js';
import { useThemeStore, resolveIsDark, type ThemeMode } from '../store/theme.js';
import { useLanguageStore, type Lang } from '../store/language.js';
import { getToken, logoutSession } from '../api/client.js';
import { useT } from '../i18n/useT.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useBranding } from '../hooks/useBranding.js';
import { BrandLogo } from './BrandLogo.js';

// ── JWT payload without jsonwebtoken (base64 decode only, no verify) ──────────
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
  const { productName } = useBranding();
  const profileTriggerRef = useRef<HTMLButtonElement>(null);
  const profilePanelRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(profileOpen, () => setProfileOpen(false), profileTriggerRef, profilePanelRef);

  const token = getToken();
  const { email = '', role: tokenRole = '' } = token ? decodeJwtPayload(token) : {};
  // The effective role (server: stricter of token and current DB role) wins over the token claim
  const role = usePermissions().role ?? tokenRole;
  const initials = email.charAt(0).toUpperCase() || '?';

  const THEME_META: Record<ThemeMode, { icon: React.ElementType; label: string }> = {
    system: { icon: Monitor, label: t('topbar_theme_system') },
    light:  { icon: Sun,     label: t('topbar_theme_light')  },
    dark:   { icon: Moon,    label: t('topbar_theme_dark')   },
  };

  // Next theme in the cycle: system → light → dark → system …
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
    <header className="h-11 bg-surface border-b border-line flex items-center px-4 gap-3 shrink-0 z-40">
      {/* Brand */}
      <div className="flex items-center gap-2 min-w-0">
        <BrandLogo className="max-h-7 max-w-[8rem]" fallback={<Mail size={17} className="text-accent-fg" aria-hidden="true" />} />
        <span className="text-fg font-semibold text-sm truncate max-w-[14rem]">{productName} BCP</span>
        <span className="text-fg-subtle text-xs hidden md:block">{t('topbar_subtitle')}</span>
      </div>

      <div className="flex-1" />

      {/* Theme-Toggle */}
      <button
        type="button"
        onClick={cycleTheme}
        title={`${t('topbar_theme_hint')}: ${themeLabel}`}
        aria-label={`${t('topbar_theme_hint')}: ${themeLabel}`}
        className="p-1.5 rounded text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors"
      >
        <ThemeIcon size={16} aria-hidden="true" />
      </button>

      {/* User profile */}
      <div className="relative">
        <button
          ref={profileTriggerRef}
          type="button"
          onClick={() => setProfileOpen((o) => !o)}
          aria-haspopup="dialog"
          aria-expanded={profileOpen}
          aria-label={email ? `Profil: ${email}` : 'Profil'}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors"
        >
          <div className="w-6 h-6 rounded-full bg-accent flex items-center justify-center text-xs font-bold text-white select-none">
            {initials}
          </div>
          <span className="text-xs hidden sm:block max-w-[160px] truncate">{email}</span>
          <ChevronDown size={12} />
        </button>

        {profileOpen && (
          <>
            {/* Click outside closes the dropdown */}
            <div className="fixed inset-0 z-40" onClick={() => setProfileOpen(false)} />

            <div ref={profilePanelRef} role="dialog" aria-label={email || 'Profil'} className="absolute right-0 top-full mt-1 w-64 bg-surface shadow-xl border border-line rounded-lg overflow-hidden z-50">

              {/* Avatar + Info */}
              <div className="px-4 py-3 border-b border-line text-center">
                <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-base font-bold text-accent-fg mx-auto mb-2 select-none">
                  {initials}
                </div>
                <p className="text-sm font-semibold text-fg truncate">{email}</p>
                {role && (
                  <span className="inline-block mt-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent-fg">
                    {formatRole(role)}
                  </span>
                )}
              </div>

              {/* Language */}
              <div className="px-4 py-3 border-b border-line">
                <p className="flex items-center gap-1.5 text-xs font-semibold text-fg-subtle mb-2">
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
                          ? 'border-accent bg-accent/10 text-accent-fg'
                          : 'border-line-strong text-fg-muted hover:bg-surface-2'
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

              {/* Logout */}
              <button
                onClick={() => { setProfileOpen(false); void logoutSession().finally(() => { window.location.href = '/bcp/login'; }); }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-fg-muted hover:bg-surface-2 transition-colors"
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
