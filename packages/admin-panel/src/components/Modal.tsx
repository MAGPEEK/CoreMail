import { useEffect, useRef, type ReactNode } from 'react';

// Stack of open dialogs — only the topmost one reacts to Escape/Tab
const openStack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
}

/**
 * Accessible modal wrapper: role="dialog" + aria-modal, Escape closes,
 * focus moves into the dialog on open, Tab stays inside, and focus returns
 * to the previously focused element on close.
 */
export function Modal({
  onClose, label, labelledBy, children,
  className = 'bg-white dark:bg-gray-900 rounded-lg shadow-2xl',
  overlayClassName = 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4',
  closeOnBackdrop = true,
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
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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
      className={overlayClassName}
      onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        {...(label ? { 'aria-label': label } : {})}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        tabIndex={-1}
        className={`${className} outline-none`}
      >
        {children}
      </div>
    </div>
  );
}
