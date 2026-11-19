/**
 * App rail: vertical icon bar on the left (md and up), a bottom bar on narrow
 * screens. Every entry is a link with its label as accessible name; wide screens
 * show the label as a tooltip on hover/focus (Escape hides it), the bottom bar shows
 * it under the icon. Arrow keys move between the entries. Items: lib/appRail.ts;
 * settings are reached through the gear in the header (TopBar), not the rail.
 */
import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Mail, Calendar, Users, CheckSquare, StickyNote } from 'lucide-react';
import { activeAppForPath, RAIL_ITEMS, type AppId, type RailItem } from '../lib/appRail.js';
import { useT } from '../i18n/useT.js';
import { nextRovingIndex } from '../lib/toolbarNav.js';
import { isAppEnabled } from '../lib/webmailFeatures.js';
import { useWebmailFeatures } from '../hooks/useWebmailFeatures.js';
import { ON_PICTURE } from '../lib/paneLayout.js';

const ICONS: Record<AppId, ReactNode> = {
  mail: <Mail size={20} />,
  calendar: <Calendar size={20} />,
  contacts: <Users size={20} />,
  tasks: <CheckSquare size={20} />,
  notes: <StickyNote size={20} />,
};

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
        className={`group relative flex flex-col items-center justify-center gap-0.5 w-full md:w-12 h-14 md:h-12 rounded-md transition-colors ${
          active ? 'text-accent-fg bg-accent/10' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
        }`}
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const links = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-rail-item]'));
    const next = nextRovingIndex(links.indexOf(document.activeElement as HTMLElement), e.key, links.length, 'both');
    if (next === null) return;
    e.preventDefault();
    links[next]?.focus();
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

  return (
    <nav
      aria-label={t('rail_nav_label')}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHiddenTip(null)}
      className={`shrink-0 flex md:flex-col bg-surface border-line max-md:border-t md:border-r md:w-16 md:py-2 max-md:px-1 ${ON_PICTURE}`}
    >
      <ul className="flex md:flex-col items-center gap-1 max-md:flex-1">{RAIL_ITEMS.filter((i) => isAppEnabled(i.id, features)).map(link)}</ul>
    </nav>
  );
}
