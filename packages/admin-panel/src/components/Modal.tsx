import { useEffect, useRef, type ReactNode } from 'react';
import { trapTab } from '../lib/focusTrap.js';

// Stack of open dialogs — only the topmost one reacts to Escape/Tab
const openStack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const DIALOG_SAFE_PANEL = 'max-h-[calc(100dvh-2rem)] overflow-y-auto';

interface ModalProps {
  onClose: () => void;
  /** Accessible name of the dialog (aria-label) — or use labelledBy */
  label?: string;
  /** id of the element that names the dialog (aria-labelledby) */
  labelledBy?: string;
  children: ReactNode;
  /** Classes of the dialog panel */
  className?: string;
  /** Classes of the backdrop (positioning / z-index / background) */
  overlayClassName?: string;
  /** Close when clicking the backdrop (default true) */
  closeOnBackdrop?: boolean;
  /**
   * 'dialog' (default): the panel never grows beyond the viewport, tall content scrolls inside it.
   * 'drawer': the caller sizes the panel (full-height side panel with its own scrolling body).
   */
  layout?: 'dialog' | 'drawer';
}

/**
 * Accessible modal wrapper: role="dialog" + aria-modal, Escape closes,
 * focus moves into the dialog on open, Tab stays inside, and focus returns
 * to the previously focused element on close.
 */
export function Modal({
  onClose, label, labelledBy, children,
  className = 'bg-surface rounded-lg shadow-2xl',
  overlayClassName = 'fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 p-4',
  closeOnBackdrop = true,
  layout = 'dialog',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const id = Symbol('modal');
    openStack.push(id);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const autofocus = panel.querySelector<HTMLElement>('[autofocus]');
      const first = autofocus ?? panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      const action = trapTab(items, document.activeElement as HTMLElement | null, e.shiftKey);
      if (action.kind === 'default') return;
      e.preventDefault();
      if (action.kind === 'focus') action.target.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      const idx = openStack.indexOf(id);
      if (idx >= 0) openStack.splice(idx, 1);
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      className={`${overlayClassName} ${layout === 'dialog' ? 'overflow-y-auto' : ''}`}
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        // a backdrop click that does not close must not move focus out of the dialog either
        if (closeOnBackdrop) onClose(); else e.preventDefault();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        {...(label ? { 'aria-label': label } : {})}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        tabIndex={-1}
        className={`${className} ${layout === 'dialog' ? DIALOG_SAFE_PANEL : ''} outline-none`}
      >
        {children}
      </div>
    </div>
  );
}
