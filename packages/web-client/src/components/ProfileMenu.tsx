/**
 * 10.7: the avatar button at the bottom of the rail and its profile menu (the
 * former top-bar profile menu + the former Hilfe tab): name / e-mail, Weiteres
 * Postfach öffnen, Tastenkombinationen (`?`), Über CoreMail, Abmelden (open
 * drafts are saved first). On the narrow bottom bar the menu also offers
 * Benachrichtigungen and Einstellungen (lib/shellMenus.ts profileMenuItems).
 */
import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Inbox, Info, Keyboard, LogOut, Settings } from 'lucide-react';
import { useAuthStore } from '../store/auth.js';
import { useUiStore } from '../store/ui.js';
import { logoutSession } from '../api/client.js';
import { logoutWithDraftFlush } from '../lib/compose-flush.js';
import { profileMenuItems, type ProfileMenuId } from '../lib/shellMenus.js';
import { Avatar } from './Avatar.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { OpenSharedMailboxModal } from './OpenSharedMailboxModal.js';
import { AboutDialog } from './AboutDialog.js';
import { useBranding } from '../hooks/useBranding.js';
import { useOwnPhoto, useOwnProfile } from '../hooks/useUserPhoto.js';
import { fmt, useT } from '../i18n/useT.js';

interface Props {
  /** Bottom bar (< 768 px): bell and settings are entries of this menu. */
  narrow: boolean;
  /** Opens the notifications panel (narrow layout), anchored at the avatar button. */
  onNotifications: (anchor: HTMLElement) => void;
  /** Unread notifications (badge on the avatar in the narrow layout). */
  unread: number;
  /** Classes of the avatar button (rail item shape). */
  className?: string;
  label?: ReactNode;
}

export function ProfileMenu({ narrow, onNotifications, unread, className = '', label }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const auth = useAuthStore();
  const { productName } = useBranding();
  // A session restored from the cookie (page reload) has no name / address in the
  // auth store — only the login answer sets them — so the profile fills the gap.
  const { data: profile } = useOwnProfile();
  const displayName = auth.displayName || profile?.displayName || '';
  const email = auth.email || profile?.email || '';
  const photoUrl = useOwnPhoto();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [sharedOpen, setSharedOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const closeMenu = () => {
    setMenu(null);
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('[data-coremail-contextmenu]')) buttonRef.current?.focus();
  };

  const signOut = () => {
    // 8.1: save open compose drafts first (max 3 s), then end the session and
    // drop the cached data of this user
    void logoutWithDraftFlush({ logout: logoutSession, clearCache: () => queryClient.clear() })
      .finally(() => navigate('/login'));
  };

  const entries: Record<ProfileMenuId, ContextMenuItem> = {
    notifications: {
      label: unread > 0 ? fmt(t('notifications_open'), { count: unread }) : t('notifications_title'), icon: <Bell size={14} />,
      onClick: () => { if (buttonRef.current) onNotifications(buttonRef.current); },
    },
    settings: { label: t('rail_settings'), icon: <Settings size={14} />, onClick: () => navigate('/settings') },
    openMailbox: { label: t('profile_open_mailbox'), icon: <Inbox size={14} />, onClick: () => setSharedOpen(true) },
    shortcuts: { label: t('profile_shortcuts'), icon: <Keyboard size={14} />, onClick: () => useUiStore.getState().setShortcutHelpOpen(true) },
    about: { label: fmt(t('profile_about'), { product: productName }), icon: <Info size={14} />, onClick: () => setAboutOpen(true) },
    signOut: { label: t('profile_sign_out'), icon: <LogOut size={14} />, onClick: signOut },
  };
  const ids = profileMenuItems(narrow);
  const items: ContextMenuItem[] = [
    {
      type: 'custom',
      render: () => (
        <div className="px-3 py-2.5 flex items-center gap-2.5 min-w-[14rem]">
          <Avatar seed={email || displayName || 'user'} name={displayName} photoUrl={photoUrl} size="md" />
          <div className="min-w-0">
            <p className="font-medium text-sm text-fg truncate">{displayName}</p>
            <p className="text-xs text-fg-subtle truncate">{email}</p>
          </div>
        </div>
      ),
    },
    { type: 'divider' },
    ...ids.flatMap((id): ContextMenuItem[] => [...(id === 'signOut' || id === 'openMailbox' ? [{ type: 'divider' as const }] : []), entries[id]])
      .filter((item, i, all) => !(item.type === 'divider' && all[i - 1]?.type === 'divider')),
  ];

  const open = () => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    // right of the rail, bottom-aligned (ContextMenu moves it up into the viewport); on the bottom bar
    // above it (estimated height: identity row + entries + dividers)
    setMenu(narrow ? { x: r.right, y: Math.max(8, r.top - 8 - (64 + ids.length * 34 + 24)) } : { x: r.right + 8, y: r.bottom });
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-rail-item
        onClick={() => (menu ? closeMenu() : open())}
        aria-label={`${t('rail_profile')}: ${displayName || email}`}
        title={displayName || email || t('rail_profile')}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        className={className}
      >
        <span className="relative" aria-hidden="true">
          <Avatar seed={email || displayName || 'user'} name={displayName} photoUrl={photoUrl} size="sm" />
          {narrow && unread > 0 && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-accent ring-2 ring-surface" />}
        </span>
        {label}
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={closeMenu} autoFocus />}
      {sharedOpen && <OpenSharedMailboxModal onClose={() => setSharedOpen(false)} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </>
  );
}
