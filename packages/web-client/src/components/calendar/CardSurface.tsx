/**
 * Floating card on the page canvas (rounded, token border, surface fill, 8 px margin).
 * Local stand-in: swap for the shared card surface of the webmail shell.
 */
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  className?: string;
  /** Landmark name; renders the section labelled with it. */
  label?: string;
}

export function CardSurface({ children, className = '', label }: Props) {
  return (
    <section
      {...(label ? { 'aria-label': label } : {})}
      className={`m-2 rounded-xl border border-line bg-surface overflow-hidden ${className}`}
    >
      {children}
    </section>
  );
}
