/**
 * 10.7: the primary button at the top of a left card ("Neue E-Mail", "Neuer
 * Termin", contacts "Neu"): full width, accent fill (the only accent-filled
 * control of the card). With `menu` it is a split button — the chevron (and
 * Alt+↓ on the main part) opens the menu; focus returns to the button when the
 * menu closes. Module level — never define components inside components.
 */
import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { fmt, useT } from '../i18n/useT.js';

interface Props {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  /** Entries of the chevron menu (built when opened); without it a plain button. */
  menu?: () => ContextMenuItem[];
  /** Tooltip of the main part. */
  tooltip?: string;
  keyshortcuts?: string | undefined;
  className?: string;
}

const MAIN = 'flex-1 min-w-0 inline-flex items-center justify-center gap-2 h-9 px-3 text-sm font-semibold text-white bg-accent hover:bg-accent-hover transition-colors active:scale-[0.98]';

export function SplitButton({ label, icon, onClick, menu, tooltip, keyshortcuts, className = '' }: Props) {
  const t = useT();
  const [open, setOpen] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  const lastTrigger = useRef<HTMLElement | null>(null);

  const openMenu = (trigger: HTMLElement) => {
    if (!menu) return;
    const r = (mainRef.current ?? trigger).getBoundingClientRect();
    lastTrigger.current = trigger;
    setOpen({ x: r.left, y: r.bottom + 2, items: menu() });
  };
  const close = () => {
    setOpen(null);
    const trigger = lastTrigger.current;
    const active = document.activeElement;
    if (trigger?.isConnected && (!active || active === document.body || !!active.closest('[data-coremail-contextmenu]'))) trigger.focus();
  };

  return (
    <div className={`flex items-stretch rounded-lg overflow-hidden shadow-sm ${className}`}>
      <button
        ref={mainRef}
        type="button"
        onClick={onClick}
        onKeyDown={menu ? (e) => { if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); openMenu(e.currentTarget); } } : undefined}
        {...(tooltip ? { title: tooltip } : {})}
        {...(keyshortcuts ? { 'aria-keyshortcuts': keyshortcuts } : {})}
        className={`${MAIN} ${menu ? '' : 'rounded-lg'}`}
      >
        {icon && <span aria-hidden="true" className="inline-flex shrink-0">{icon}</span>}
        <span className="truncate">{label}</span>
      </button>
      {menu && (
        <button
          ref={chevronRef}
          type="button"
          aria-label={fmt(t('cmdbar_more_options'), { label })}
          aria-haspopup="menu"
          aria-expanded={open !== null}
          onClick={(e) => (open ? close() : openMenu(e.currentTarget))}
          className="inline-flex items-center justify-center w-9 shrink-0 text-white bg-accent hover:bg-accent-hover border-l border-white/30 transition-colors"
        >
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
      {open && <ContextMenu x={open.x} y={open.y} items={open.items} onClose={close} autoFocus />}
    </div>
  );
}
