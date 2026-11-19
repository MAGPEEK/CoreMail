/**
 * 10.2: a labelled pane card of the floating layout (lib/paneLayout.ts
 * PANE_CARD_CLASS: rounded, token border, the surface — translucent with a light
 * blur over a background picture; flat and full width below 768 px). The pages
 * that lay out their own panes (`PageShell bodyCard={false}`) use it.
 */
import type { ReactNode } from 'react';
import { PANE_CARD_CLASS } from '../lib/paneLayout.js';

interface Props {
  /** Accessible name of the region. */
  label: string;
  /** Layout classes (width, visibility, flex). */
  className?: string;
  children: ReactNode;
}

export function PaneCard({ label, className = '', children }: Props) {
  return (
    <section aria-label={label} className={`flex flex-col min-h-0 min-w-0 ${PANE_CARD_CLASS} ${className}`}>
      {children}
    </section>
  );
}
