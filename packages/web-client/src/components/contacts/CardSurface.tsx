/**
 * Card frame of the contacts panes (sidebar, list, detail): rounded, token
 * border and surface, clips its content. Local wrapper on existing tokens only —
 * to be replaced by the shared webmail card surface.
 */
import type { ReactNode } from 'react';

interface Props {
  /** Accessible name of the region */
  label: string;
  /** Layout classes (width, visibility) */
  className?: string;
  children: ReactNode;
}

export function CardSurface({ label, className = '', children }: Props) {
  return (
    <section aria-label={label} className={`flex-col min-h-0 min-w-0 rounded-xl border border-line bg-surface overflow-hidden ${className}`}>
      {children}
    </section>
  );
}
