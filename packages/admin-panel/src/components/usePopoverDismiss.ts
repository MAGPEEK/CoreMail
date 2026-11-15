import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keyboard support for a non-modal popover (dropdown/menu): Escape closes it and
 * returns focus to the trigger; on open, focus moves to the first focusable
 * element inside the panel. Outside clicks are handled by the caller's backdrop.
 */
export function usePopoverDismiss(
  open: boolean,
  close: () => void,
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, triggerRef, panelRef]);
}
