/**
 * Shared command bar (mail, reading pane, calendar ribbon).
 *
 * - role="toolbar" with roving focus (WAI-ARIA APG): one tab stop, ←/→ move between
 *   the controls, Home/End jump; disabled commands stay focusable (aria-disabled)
 *   and expose their reason as description + tooltip.
 * - Commands that do not fit move to a "…" menu (lib/toolbarNav.ts computeOverflow);
 *   widths come from an invisible, inert copy of the bar.
 * - A command with `menu` opens a dropdown; with `onClick` and `menu` it is a split
 *   button. Menus are ContextMenus with arrow-key navigation; focus returns to the
 *   button when a menu closes (before the chosen command runs, so a dialog it opens
 *   hands focus back to the button too), unless focus already moved elsewhere.
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { computeOverflow, nextRovingIndex, type CommandPlacement } from '../lib/toolbarNav.js';
import { fmt, useT } from '../i18n/useT.js';
import { useLanguageStore } from '../store/language.js';

export interface CommandItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Main action; gets the button (to anchor an own popover and give focus back to it). */
  onClick?: (anchor: HTMLElement) => void;
  /** Dropdown entries, built when opened. Together with onClick → split button. */
  menu?: () => ContextMenuItem[];
  disabled?: boolean;
  /** Tooltip: the full action, or why the command is disabled. */
  tooltip?: string;
  /** onClick opens a popover dialog of its own: aria-haspopup="dialog" + aria-expanded. */
  dialogOpen?: boolean;
  /** Toggle state (aria-pressed); undefined = not a toggle. */
  pressed?: boolean;
  keyshortcuts?: string | undefined;
  /** pinned = never in "…", overflow = always in "…", auto (default) = while it fits */
  placement?: CommandPlacement;
  tone?: 'primary' | 'danger';
  /** 10.1: a primary command that is ready (Senden with a valid recipient) gets a soft ring. */
  highlight?: boolean;
  /** Inline bars: the icon alone (the label is the accessible name and the tooltip; a dropdown shows no extra arrow). */
  iconOnly?: boolean;
}

export interface CommandGroup {
  id: string;
  /** Caption under the group (ribbon) */
  title?: string;
  items: CommandItem[];
}

export type CommandBarVariant = 'ribbon' | 'inline';

interface Props {
  /** Accessible name of the toolbar */
  label: string;
  groups: CommandGroup[];
  variant?: CommandBarVariant;
  /** Content after the toolbar, outside the roving focus (e.g. the selection counter). */
  end?: ReactNode;
  className?: string;
  /** Hairlines between the groups (default); false = quiet bar without dividers. */
  dividers?: boolean;
}

interface OpenMenu { key: string; x: number; y: number; items: ContextMenuItem[]; trigger: HTMLElement }

const MORE_KEY = '__more';

// ── Styles ────────────────────────────────────────────────────────────────────
const DISABLED = 'aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:active:scale-100';

function toneClass(item: CommandItem): string {
  if (item.tone === 'primary') {
    return `bg-accent text-white hover:bg-accent-hover aria-disabled:hover:bg-accent transition-shadow ${item.highlight ? 'shadow-md ring-2 ring-accent/30' : ''}`;
  }
  if (item.pressed) return 'bg-accent/10 text-accent-fg ring-1 ring-inset ring-accent/30';
  if (item.tone === 'danger') return 'text-danger-fg hover:bg-danger-bg aria-disabled:hover:bg-transparent';
  return 'text-fg-muted hover:bg-surface-2 hover:text-fg aria-disabled:hover:bg-transparent aria-disabled:hover:text-fg-muted';
}

const SHAPE: Record<CommandBarVariant, { main: string; arrow: string; group: string; more: string }> = {
  ribbon: {
    main: 'flex flex-col items-center justify-between w-[80px] h-[62px] px-1 py-1.5 rounded',
    arrow: 'flex items-end justify-center w-5 h-[62px] pb-2 rounded',
    group: 'flex flex-col items-center px-3 py-1',
    more: 'flex flex-col items-center justify-center w-[52px] h-[62px] rounded',
  },
  inline: {
    main: 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded text-sm whitespace-nowrap',
    arrow: 'inline-flex items-center justify-center h-8 w-6 rounded',
    group: 'flex items-center gap-0.5 px-1',
    more: 'inline-flex items-center justify-center h-8 w-8 rounded',
  },
};

/** Icon-only buttons of inline bars: the icon centred, at least 32 px wide (WCAG 2.2 target size). */
const ICON_ONLY = 'min-w-8 justify-center';

// ── Pieces (module level: never define components inside components) ─────────
interface ButtonProps {
  item: CommandItem;
  variant: CommandBarVariant;
  /** Copy in the invisible measuring row: no handlers, no tab stop */
  measure?: boolean;
  tabStop?: string;
  openKey?: string | null;
  descId?: string;
  onOpenMenu?: (key: string, el: HTMLElement, items: ContextMenuItem[]) => void;
}

function Label({ item, variant, arrow, iconOnly }: { item: CommandItem; variant: CommandBarVariant; arrow: boolean; iconOnly: boolean }) {
  const lang = useLanguageStore((s) => s.lang);
  if (variant === 'ribbon') {
    return (
      <>
        <span className="h-6 flex items-center justify-center mt-0.5" aria-hidden="true">{item.icon}</span>
        {/* 10.1: long German words (Ansichtseinstellungen) hyphenate / wrap instead of being cut off */}
        <span lang={lang} className="text-[11px] leading-tight text-center w-full flex items-center justify-center gap-0.5 line-clamp-2 hyphens-auto [overflow-wrap:anywhere]">
          {item.label}
          {arrow && <ChevronDown size={10} className="opacity-60 shrink-0" aria-hidden="true" />}
        </span>
      </>
    );
  }
  return (
    <>
      {item.icon && <span className="inline-flex shrink-0" aria-hidden="true">{item.icon}</span>}
      <span className={iconOnly ? 'sr-only' : undefined}>{item.label}</span>
      {arrow && <ChevronDown size={12} className="opacity-70 shrink-0" aria-hidden="true" />}
    </>
  );
}

function CommandButton({ item, variant, measure = false, tabStop, openKey, descId, onOpenMenu }: ButtonProps) {
  const t = useT();
  const split = !!(item.onClick && item.menu);
  const dropdownOnly = !item.onClick && !!item.menu;
  const shape = SHAPE[variant];
  const common = `transition-all duration-150 active:scale-95 ${DISABLED} ${toneClass(item)}`;
  const disabledProps = item.disabled
    ? { 'aria-disabled': true as const, ...(descId ? { 'aria-describedby': descId } : {}) }
    : {};
  const iconOnly = !!(item.iconOnly && item.icon) && variant === 'inline';
  const title = item.tooltip && item.tooltip !== item.label ? item.tooltip : (iconOnly ? item.label : undefined);
  const menuKey = split ? `${item.id}:menu` : item.id;

  const openMenu = (el: HTMLElement) => {
    if (item.disabled || !item.menu) return;
    onOpenMenu?.(menuKey, el, item.menu());
  };
  const stop = (key: string) => (measure
    ? { tabIndex: -1 }
    : { tabIndex: tabStop === key ? 0 : -1, 'data-roving-stop': key });

  const main = (
    <button
      type="button"
      {...stop(item.id)}
      {...disabledProps}
      {...(title ? { title } : {})}
      {...(item.pressed !== undefined ? { 'aria-pressed': item.pressed } : {})}
      {...(item.keyshortcuts ? { 'aria-keyshortcuts': item.keyshortcuts } : {})}
      {...(dropdownOnly ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': openKey === item.id } : {})}
      {...(!dropdownOnly && item.dialogOpen !== undefined ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': item.dialogOpen } : {})}
      onClick={measure ? undefined : (e) => {
        if (item.disabled) return;
        if (dropdownOnly) openMenu(e.currentTarget);
        else item.onClick?.(e.currentTarget);
      }}
      onKeyDown={measure || !item.menu ? undefined : (e) => {
        // Alt+↓ opens the dropdown of a split button / dropdown (the main action stays on Enter / Space)
        if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); openMenu(e.currentTarget); }
      }}
      className={`${shape.main} ${iconOnly ? ICON_ONLY : ''} ${common} ${split ? 'rounded-r-none' : ''}`}
    >
      <Label item={item} variant={variant} arrow={dropdownOnly && !iconOnly} iconOnly={iconOnly} />
    </button>
  );
  if (!split) return main;
  return (
    <span className="inline-flex items-stretch">
      {main}
      <button
        type="button"
        {...stop(menuKey)}
        {...disabledProps}
        aria-label={fmt(t('cmdbar_more_options'), { label: item.label })}
        aria-haspopup="menu"
        aria-expanded={openKey === menuKey}
        onClick={measure ? undefined : (e) => openMenu(e.currentTarget)}
        className={`${shape.arrow} ${common} rounded-l-none border-l ${item.tone === 'primary' ? 'border-white/30' : 'border-line'}`}
      >
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    </span>
  );
}

function MoreButton({ variant, measure = false, tabStop, open, onOpen }: {
  variant: CommandBarVariant;
  measure?: boolean;
  tabStop?: string;
  open?: boolean;
  onOpen?: (el: HTMLElement) => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      {...(measure ? { tabIndex: -1 } : { tabIndex: tabStop === MORE_KEY ? 0 : -1, 'data-roving-stop': MORE_KEY })}
      aria-label={t('cmdbar_more')}
      title={t('cmdbar_more')}
      aria-haspopup="menu"
      aria-expanded={!!open}
      onClick={measure ? undefined : (e) => onOpen?.(e.currentTarget)}
      className={`${SHAPE[variant].more} text-fg-muted hover:bg-surface-2 hover:text-fg transition-all duration-150 active:scale-95`}
    >
      <MoreHorizontal size={variant === 'ribbon' ? 20 : 16} aria-hidden="true" />
    </button>
  );
}

function GroupBox({ group, variant, first, dividers, children }: {
  group: CommandGroup; variant: CommandBarVariant; first: boolean; dividers: boolean; children: ReactNode;
}) {
  const border = first || !dividers ? '' : 'border-l border-line';
  if (variant === 'ribbon') {
    return (
      <div role="group" aria-label={group.title ?? group.id} className={`${SHAPE.ribbon.group} ${border}`} data-measure-group={group.id}>
        <div className="flex items-stretch gap-1 mb-1">{children}</div>
        {group.title && <div className="text-[10px] text-fg-subtle uppercase tracking-wide" aria-hidden="true">{group.title}</div>}
      </div>
    );
  }
  return (
    <div role="group" {...(group.title ? { 'aria-label': group.title } : {})} className={`${SHAPE.inline.group} ${border}`} data-measure-group={group.id}>
      {children}
    </div>
  );
}

/** A command as a menu entry ("…" overflow, or a menu of other commands; split buttons: main action first). */
export function commandMenuItem(item: CommandItem, anchor: () => HTMLElement): ContextMenuItem {
  const icon = item.icon ? <span className="inline-flex [&>svg]:size-4">{item.icon}</span> : undefined;
  const sub = item.menu?.();
  const children = sub && item.onClick
    ? [{ label: item.label, icon, onClick: () => item.onClick?.(anchor()) }, { type: 'divider' as const }, ...sub]
    : sub;
  return {
    label: item.label,
    icon,
    ...(item.disabled ? { disabled: true } : {}),
    // a toggle keeps its state in the "…" menu (menuitemcheckbox)
    ...(item.pressed !== undefined && !children && item.dialogOpen === undefined ? { checked: item.pressed } : {}),
    ...(item.tooltip && item.tooltip !== item.label ? { title: item.tooltip } : {}),
    ...(item.tone === 'danger' ? { danger: true } : {}),
    ...(children ? { children } : { onClick: () => item.onClick?.(anchor()) }),
  };
}

/**
 * A menu entry as a command (10.1: the ribbon shows entries of the compose
 * card's menus as buttons — same handlers): a submenu becomes a dropdown, a
 * checkable entry a toggle.
 */
export function commandFromMenuItem(id: string, item: ContextMenuItem): CommandItem {
  return {
    id,
    label: item.label ?? id,
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.children ? { menu: () => item.children! } : { onClick: () => item.onClick?.() }),
    ...(item.disabled ? { disabled: true } : {}),
    ...(item.checked !== undefined && !item.children ? { pressed: item.checked } : {}),
    ...(item.title ? { tooltip: item.title } : {}),
    ...(item.danger ? { tone: 'danger' as const } : {}),
  };
}

function layoutSignature(groups: CommandGroup[], variant: CommandBarVariant): string {
  return variant + groups.map((g) => `${g.id}:${g.title ?? ''}[${g.items.map((i) =>
    `${i.id}|${i.label}|${i.placement ?? 'auto'}|${i.menu ? 'm' : ''}${i.onClick ? 'c' : ''}`).join(',')}]`).join('');
}

// ── Command bar ───────────────────────────────────────────────────────────────
export function CommandBar({ label, groups, variant = 'inline', end, className = '', dividers = true }: Props) {
  const baseId = useId();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(Number.POSITIVE_INFINITY);
  const [widths, setWidths] = useState<{ items: Record<string, number>; more: number }>({ items: {}, more: 0 });
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  // A click on the open menu's own button closes it (mousedown) — do not reopen on the click
  const lastClosed = useRef<{ trigger: HTMLElement; at: number } | null>(null);

  const all = groups.flatMap((g) => g.items);
  const signature = layoutSignature(groups, variant);

  // Widths of every command (+ its group's padding/caption) from the measuring copy
  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;
    const items: Record<string, number> = {};
    for (const groupEl of Array.from(root.querySelectorAll<HTMLElement>('[data-measure-group]'))) {
      const itemEls = Array.from(groupEl.querySelectorAll<HTMLElement>('[data-measure-item]'));
      const sum = itemEls.reduce((s, el) => s + el.getBoundingClientRect().width, 0);
      itemEls.forEach((el, i) => {
        const chrome = i === 0 ? groupEl.getBoundingClientRect().width - sum : 0;
        items[el.dataset.measureItem!] = el.getBoundingClientRect().width + chrome;
      });
    }
    const more = root.querySelector<HTMLElement>('[data-measure-more]')?.getBoundingClientRect().width ?? 0;
    setWidths({ items, more });
  }, [signature]);

  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    setAvailable(el.clientWidth);
    const ro = new ResizeObserver(() => setAvailable(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visibleFlags = computeOverflow({
    widths: all.map((i) => (i.placement === 'overflow' ? 0 : widths.items[i.id] ?? 0)),
    placements: all.map((i) => i.placement ?? 'auto'),
    available,
    overflowButtonWidth: widths.more,
  });
  const visible = new Set(all.filter((_, i) => visibleFlags[i]).map((i) => i.id));
  const overflowGroups = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !visible.has(i.id)) }))
    .filter((g) => g.items.length > 0);

  const stops = [
    ...all.filter((i) => visible.has(i.id)).flatMap((i) => (i.onClick && i.menu ? [i.id, `${i.id}:menu`] : [i.id])),
    ...(overflowGroups.length ? [MORE_KEY] : []),
  ];
  const tabStop = activeKey && stops.includes(activeKey) ? activeKey : stops[0];

  const openMenu = (key: string, trigger: HTMLElement, items: ContextMenuItem[]) => {
    if (lastClosed.current?.trigger === trigger && performance.now() - lastClosed.current.at < 300) return;
    const r = trigger.getBoundingClientRect();
    setMenu({ key, x: r.left, y: r.bottom + 2, items, trigger });
  };
  const closeMenu = () => {
    const trigger = menu?.trigger;
    setMenu(null);
    if (!trigger) return;
    lastClosed.current = { trigger, at: performance.now() };
    const active = document.activeElement;
    const inMenuOrNowhere = !active || active === document.body || !!active.closest('[data-coremail-contextmenu]');
    if (trigger.isConnected && inMenuOrNowhere) trigger.focus();
  };
  const openOverflow = (trigger: HTMLElement) => {
    const anchor = () => trigger;
    const items = overflowGroups.flatMap((g, gi) => [
      ...(gi > 0 ? [{ type: 'divider' as const }] : []),
      ...g.items.map((i) => commandMenuItem(i, anchor)),
    ]);
    openMenu(MORE_KEY, trigger, items);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const els = Array.from(toolbarRef.current?.querySelectorAll<HTMLElement>('[data-roving-stop]') ?? []);
    const next = nextRovingIndex(els.indexOf(document.activeElement as HTMLElement), e.key, els.length, 'horizontal');
    if (next === null) return;
    e.preventDefault();
    els[next]?.focus();
  };

  const descId = (item: CommandItem) => `${baseId}-${item.id}-why`;
  let firstGroup = true;

  return (
    <div className={`relative flex items-center min-w-0 ${className}`} data-coremail-toolbar>
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label={label}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onFocus={(e) => { const key = (e.target as HTMLElement).dataset.rovingStop; if (key) setActiveKey(key); }}
        className={`flex flex-1 min-w-0 overflow-hidden ${variant === 'ribbon' ? 'items-stretch' : 'items-center'}`}
      >
        {groups.map((g) => {
          const items = g.items.filter((i) => visible.has(i.id));
          if (items.length === 0) return null;
          const isFirst = firstGroup;
          firstGroup = false;
          return (
            <GroupBox key={g.id} group={g} variant={variant} first={isFirst} dividers={dividers}>
              {items.map((item) => (
                <CommandButton
                  key={item.id}
                  item={item}
                  variant={variant}
                  {...(tabStop ? { tabStop } : {})}
                  openKey={menu?.key ?? null}
                  descId={descId(item)}
                  onOpenMenu={openMenu}
                />
              ))}
            </GroupBox>
          );
        })}
        {overflowGroups.length > 0 && (
          <div className={`flex items-center ${firstGroup || !dividers ? '' : 'border-l border-line'} px-1`}>
            <MoreButton variant={variant} {...(tabStop ? { tabStop } : {})} open={menu?.key === MORE_KEY} onOpen={openOverflow} />
          </div>
        )}
        {/* Reasons of disabled commands (aria-describedby) */}
        {all.filter((i) => i.disabled && i.tooltip && visible.has(i.id)).map((i) => (
          <span key={i.id} id={descId(i)} className="sr-only">{i.tooltip}</span>
        ))}
      </div>
      {end}

      {/* Invisible copy of the bar: widths for the overflow calculation */}
      <div ref={measureRef} aria-hidden="true" inert className="absolute left-0 top-0 w-max h-0 overflow-hidden invisible pointer-events-none flex whitespace-nowrap">
        {groups.map((g, gi) => {
          const items = g.items.filter((i) => i.placement !== 'overflow');
          if (items.length === 0) return null;
          return (
            <GroupBox key={g.id} group={g} variant={variant} first={gi === 0} dividers={dividers}>
              {items.map((item) => (
                <span key={item.id} data-measure-item={item.id} className="inline-flex shrink-0">
                  <CommandButton item={item} variant={variant} measure />
                </span>
              ))}
            </GroupBox>
          );
        })}
        <span data-measure-more className={`inline-flex px-1 ${dividers ? 'border-l border-line' : ''}`}>
          <MoreButton variant={variant} measure />
        </span>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} autoFocus />}
    </div>
  );
}
