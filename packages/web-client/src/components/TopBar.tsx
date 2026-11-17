import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Search, Bell, Settings, LogOut, ChevronDown, Inbox } from 'lucide-react';
import { useAuthStore } from '../store/auth.js';
import { useQueryClient } from '@tanstack/react-query';
import { logoutSession } from '../api/client.js';
import { logoutWithDraftFlush } from '../lib/compose-flush.js';
import { Avatar } from './Avatar.js';
import { OpenSharedMailboxModal } from './OpenSharedMailboxModal.js';
import { SearchOperatorsHelp } from './SearchOperatorsHelp.js';
import { GLOBAL_SEARCH_INPUT_ID } from '../hooks/useGlobalShortcuts.js';
import { BrandLogo } from './BrandLogo.js';
import { useBranding } from '../hooks/useBranding.js';

interface Props {
  onSearch: (q: string) => void;
}

const HEADER_BTN = 'p-1.5 rounded text-header-fg focus-visible:outline-header-fg hover:bg-header-overlay/20 transition-all duration-150 active:scale-90';

/**
 * Header: brand (logo + product name) left, the mail search centred, notifications /
 * settings / profile right. Colours come from the branding tokens (bg-header,
 * text-header-fg); app switching lives in the app rail (AppRail.tsx).
 */
export function TopBar({ onSearch }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { displayName, email } = useAuthStore();
  const { productName } = useBranding();
  const [search, setSearch] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  const [sharedOpen, setSharedOpen]   = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(search);
  };

  /** Search operators help: append the operator and keep typing in the field. */
  const insertOperator = (token: string) => {
    const base = search.trim();
    setSearch(base ? `${base} ${token}` : token);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const pos = token === '""' ? el.value.length - 1 : el.value.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    // Brand and actions share the free space equally (flex 1 1 0) → the search stays centred;
    // on narrow screens only the search shrinks.
    <header className="h-12 bg-header text-header-fg flex items-center gap-3 px-3 shrink-0 z-50">
      {/* Brand */}
      <div className="flex-1 basis-0 flex items-center gap-2 font-semibold text-base">
        <BrandLogo className="max-h-8 max-w-[10rem]" fallback={<Mail size={18} aria-hidden="true" />} />
        <span className="truncate min-w-0 max-md:hidden">{productName}</span>
      </div>

      {/* Search (centre) */}
      <form role="search" onSubmit={handleSearch} className="flex-[0_1_42rem] flex items-center gap-1 min-w-0">
        <div className="relative group flex-1 min-w-0">
          <Search size={15} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-header-fg group-focus-within:text-fg-subtle transition-colors" />
          <input
            ref={inputRef}
            id={GLOBAL_SEARCH_INPUT_ID}
            type="text"
            aria-label="Suchen"
            aria-keyshortcuts="/"
            placeholder="Suchen..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-header-overlay/20 text-header-fg placeholder-header-fg border border-header-fg/40 rounded px-3 py-1 pl-8 text-sm outline-none transition-all duration-150 focus:bg-surface focus:text-fg focus:placeholder-fg-subtle focus:shadow-md focus:border-header-fg"
          />
        </div>
        <SearchOperatorsHelp onInsert={insertOperator} tone="header" />
      </form>

      {/* Right actions */}
      <div className="flex-1 basis-0 flex items-center justify-end gap-1">
        <button aria-label="Benachrichtigungen" className={`group/bell ${HEADER_BTN}`} title="Benachrichtigungen">
          <Bell size={17} className="transition-transform duration-150 group-hover/bell:rotate-12" />
        </button>
        <button aria-label="Einstellungen" onClick={() => navigate('/settings')} className={`group/gear ${HEADER_BTN}`} title="Einstellungen">
          <Settings size={17} className="transition-transform duration-150 group-hover/gear:rotate-45" />
        </button>

        {/* Profile */}
        <div className="relative">
          <button
            onClick={() => setProfileOpen((o) => !o)}
            aria-label={displayName || email || 'Profil'}
            aria-expanded={profileOpen}
            className="flex items-center gap-1.5 ml-1 px-2 py-1 rounded text-header-fg focus-visible:outline-header-fg hover:bg-header-overlay/20 transition-all duration-150"
          >
            <div className="ring-2 ring-transparent hover:ring-header-fg/40 rounded-full transition-all duration-150">
              <Avatar seed={email || displayName || 'user'} initials={(displayName?.charAt(0) || email?.charAt(0) || '?').toUpperCase()} size="sm" />
            </div>
            <ChevronDown size={13} className="transition-transform duration-150" style={{ transform: profileOpen ? 'rotate(180deg)' : 'rotate(0)' }} />
          </button>

          {profileOpen && (
            <div className="absolute right-0 top-full mt-1 w-60 bg-surface shadow-lg border border-line rounded py-1 z-50 animate-fly-in origin-top-right">
              <div className="px-3 py-3 border-b border-line flex items-center gap-2.5">
                <Avatar seed={email || displayName || 'user'} initials={(displayName?.charAt(0) || email?.charAt(0) || '?').toUpperCase()} size="md" />
                <div className="min-w-0">
                  <p className="font-medium text-sm text-fg truncate">{displayName}</p>
                  <p className="text-xs text-fg-subtle truncate">{email}</p>
                </div>
              </div>
              <button
                onClick={() => { setProfileOpen(false); setSharedOpen(true); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fg-muted hover:bg-surface-2 transition-colors"
              >
                <Inbox size={14} />
                Weiteres Postfach öffnen
              </button>
              <div className="border-t border-line my-1" />
              <button
                onClick={() => {
                  setProfileOpen(false);
                  // 8.1: save open compose drafts first (max 3 s), then end the
                  // session and drop the cached data of this user
                  void logoutWithDraftFlush({ logout: logoutSession, clearCache: () => queryClient.clear() })
                    .finally(() => navigate('/login'));
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-fg-muted hover:bg-surface-2 transition-colors"
              >
                <LogOut size={14} />
                Abmelden
              </button>
            </div>
          )}
        </div>
      </div>
      {sharedOpen && <OpenSharedMailboxModal onClose={() => setSharedOpen(false)} />}
    </header>
  );
}
