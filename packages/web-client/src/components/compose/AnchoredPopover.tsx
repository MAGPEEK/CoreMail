/**
 * Small non-modal dialog under (or above) the button that opened it: takes
 * focus, Escape and a click outside close it and give focus back to the button.
 * Used by "Senden planen" and "Emoji".
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  anchor: HTMLElement;
  label: string;
  /** Escape gives focus back to the anchor; a choice that moves focus on closes without. */
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

export function AnchoredPopover({ anchor, label, onClose, children, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Placed before paint, straight on the element (it must stay focusable meanwhile)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const below = a.bottom + 4 + r.height <= window.innerHeight - 8;
    el.style.left = `${Math.max(8, Math.min(a.left, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${below ? a.bottom + 4 : Math.max(8, a.top - r.height - 4)}px`;
  }, [anchor]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      close.current();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close.current();
        if (anchor.isConnected) anchor.focus();
      }}
      className={`fixed left-0 top-0 z-[110] bg-surface border border-line rounded-md shadow-lg ${className}`}
    >
      {children}
    </div>,
    document.body,
  );
}
