/**
 * App rail: vertical icon bar on the left (md and up), a bottom bar on narrow
 * screens. 10.7: there is no top bar any more — the rail starts with the brand
 * logo mark, then the apps (lib/appRail.ts), and at its bottom the
 * notifications bell (panel: components/NotificationsPanel.tsx), the settings
 * gear and the avatar with the profile menu (components/ProfileMenu.tsx;
 * lib/shellMenus.ts RAIL_BOTTOM). On the bottom bar bell and gear are entries
 * of the avatar menu. Every app entry is a link with its label as accessible
 * name; wide screens show the label as a tooltip on hover/focus (Escape hides
 * it), the bottom bar shows it under the icon. Arrow keys move between all
 * entries of the rail.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Mail, Calendar, Users, CheckSquare, StickyNote, Bell, Settings } from 'lucide-react';
import { activeAppForPath, RAIL_ITEMS, type AppId, type RailItem } from '../lib/appRail.js';
import { RAIL_BOTTOM, type RailBottomId } from '../lib/shellMenus.js';
import { fmt, useT } from '../i18n/useT.js';
import { nextRovingIndex } from '../lib/toolbarNav.js';
import { isAppEnabled } from '../lib/webmailFeatures.js';
import { useWebmailFeatures } from '../hooks/useWebmailFeatures.js';
import { useLayoutMode } from '../hooks/useLayoutMode.js';
import { useBranding } from '../hooks/useBranding.js';
import { ON_PICTURE } from '../lib/paneLayout.js';
import { unreadCount } from '../lib/notifications.js';
import { useNotifications } from '../store/notifications.js';
import { BrandLogo } from './BrandLogo.js';
import { NotificationsPanel } from './NotificationsPanel.js';
import { ProfileMenu } from './ProfileMenu.js';

const ICONS: Record<AppId, ReactNode> = {
  mail: <Mail size={20} />,
  calendar: <Calendar size={20} />,
  contacts: <Users size={20} />,
  tasks: <CheckSquare size={20} />,
  notes: <StickyNote size={20} />,
};

/** Shape of every rail entry (apps and the bottom buttons). */
const ITEM_SHAPE = 'group relative flex flex-col items-center justify-center gap-0.5 w-full md:w-12 h-14 md:h-12 rounded-md transition-colors';
const ITEM_IDLE = 'text-fg-muted hover:bg-surface-2 hover:text-fg';

function RailLink({ item, label, active, tipHidden, onHideTip, onShowTip }: {
  item: RailItem;
  label: string;
  active: boolean;
  tipHidden: boolean;
  onHideTip: () => void;
  onShowTip: () => void;
}) {
  return (
    <li className="relative flex max-md:flex-1">
      <Link
        to={item.path}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        data-rail-item
        onKeyDown={(e) => {
          // Escape only dismisses the tooltip here (SC 1.4.13), not the mail selection
          if (e.key === 'Escape') { e.stopPropagation(); onHideTip(); }
        }}
        onFocus={onShowTip}
        onMouseEnter={onShowTip}
        className={`${ITEM_SHAPE} ${active ? 'text-accent-fg bg-accent/10' : ITEM_IDLE}`}
      >
        {/* Selection indicator: left bar (rail), top bar (bottom bar) */}
        {active && (
          <span aria-hidden="true" className="absolute bg-accent rounded-full md:left-0 md:top-2 md:bottom-2 md:w-[3px] max-md:top-0 max-md:left-3 max-md:right-3 max-md:h-[3px]" />
        )}
        <span aria-hidden="true">{ICONS[item.id]}</span>
        <span aria-hidden="true" className="md:hidden max-w-full truncate px-0.5 text-[11px] leading-tight">{label}</span>
        {/* Tooltip (wide screens): hoverable — no gap between link and bubble */}
        <span
          aria-hidden="true"
          className={`max-md:hidden absolute left-full top-1/2 -translate-y-1/2 pl-2 z-50 invisible ${
            tipHidden ? '' : 'group-hover:visible group-focus-visible:visible'
          }`}
        >
          <span className="block whitespace-nowrap rounded bg-fg text-surface text-xs font-medium px-2 py-1 shadow-md">{label}</span>
        </span>
      </Link>
    </li>
  );
}

export function AppRail() {
  const t = useT();
  const { pathname } = useLocation();
  const active = activeAppForPath(pathname);
  const [hiddenTip, setHiddenTip] = useState<AppId | null>(null);
  // 9.4: apps whose module the webmail policy switched off are not on the rail
  const { features } = useWebmailFeatures();
  const { productName } = useBranding();
  const narrow = useLayoutMode() === 'single';
  const unread = useNotifications((s) => unreadCount(s.items));
  const [panelAnchor, setPanelAnchor] = useState<HTMLElement | null>(null);
  const bellRef = useRef<HTMLButtonElement>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-rail-item]'));
    const next = nextRovingIndex(items.indexOf(document.activeElement as HTMLElement), e.key, items.length, 'both');
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };

  const link = (item: RailItem) => (
    <RailLink
      key={item.id}
      item={item}
      label={t(item.labelKey)}
      active={active === item.id}
      tipHidden={hiddenTip === item.id}
      onHideTip={() => setHiddenTip(item.id)}
      onShowTip={() => setHiddenTip((h) => (h === item.id ? h : null))}
    />
  );

  const bellLabel = unread > 0 ? fmt(t('notifications_open'), { count: unread }) : t('notifications_title');
  const bottom: Record<RailBottomId, ReactNode> = {
    notifications: (
      <li key="notifications" className="flex">
        <button
          ref={bellRef}
          type="button"
          data-rail-item
          aria-label={bellLabel}
          title={bellLabel}
          aria-haspopup="dialog"
          aria-expanded={panelAnchor !== null}
          onClick={(e) => setPanelAnchor((a) => (a ? null : e.currentTarget))}
          className={`${ITEM_SHAPE} ${panelAnchor ? 'text-accent-fg bg-accent/10' : ITEM_IDLE}`}
        >
          <Bell size={20} aria-hidden="true" className="transition-transform duration-150 group-hover:rotate-12" />
          {unread > 0 && (
            <span aria-hidden="true" className="absolute top-2 right-2.5 min-w-4 h-4 px-1 rounded-full bg-accent text-white text-[10px] font-bold leading-4 text-center">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      </li>
    ),
    settings: (
      <li key="settings" className="flex">
        <Link
          to="/settings"
          data-rail-item
          aria-label={t('rail_settings')}
          title={t('rail_settings')}
          aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
          className={`${ITEM_SHAPE} ${pathname.startsWith('/settings') ? 'text-accent-fg bg-accent/10' : ITEM_IDLE}`}
        >
          <Settings size={20} aria-hidden="true" className="transition-transform duration-150 group-hover:rotate-45" />
        </Link>
      </li>
    ),
    profile: (
      <li key="profile" className="flex max-md:flex-1">
        <ProfileMenu
          narrow={narrow}
          unread={unread}
          onNotifications={(anchor) => setPanelAnchor(anchor)}
          className={`${ITEM_SHAPE} ${ITEM_IDLE}`}
          label={<span aria-hidden="true" className="md:hidden text-[11px] leading-tight">{t('rail_profile').split(' ')[0]}</span>}
        />
      </li>
    ),
  };

  return (
    <nav
      aria-label={t('rail_nav_label')}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHiddenTip(null)}
      className={`shrink-0 flex md:flex-col bg-surface border-line max-md:border-t md:border-r md:w-16 md:py-2 max-md:px-1 ${ON_PICTURE}`}
    >
      {/* Brand logo mark (wide screens): leads to the mail view */}
      <Link
        to="/mail"
        data-rail-item
        aria-label={fmt(t('rail_brand'), { product: productName })}
        title={productName}
        className="max-md:hidden flex items-center justify-center w-12 h-12 mx-auto mb-2 rounded-md hover:bg-surface-2"
      >
        <BrandLogo
          className="max-h-8 max-w-[2.5rem]"
          fallback={<span className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent text-white"><Mail size={17} aria-hidden="true" /></span>}
        />
      </Link>
      <ul className="flex md:flex-col items-center gap-1 max-md:flex-1">
        {RAIL_ITEMS.filter((i) => isAppEnabled(i.id, features)).map(link)}
        {narrow && bottom.profile}
      </ul>
      {!narrow && (
        <ul className="mt-auto flex flex-col items-center gap-1 pt-2">
          {RAIL_BOTTOM.map((id) => bottom[id])}
        </ul>
      )}
      {panelAnchor && <NotificationsPanel anchor={panelAnchor} onClose={() => setPanelAnchor(null)} />}
    </nav>
  );
}
