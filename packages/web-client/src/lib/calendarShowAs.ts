import type { ShowAs } from '../api/types.js';
import { readableTextOn } from './readableText.ts';

/**
 * Outlook-style rendering of an event's "Anzeigen als" (show-as) value in the
 * calendar grid (FullCalendar) and the day agenda:
 *
 *   BUSY (default) — solid fill in the calendar colour, black/white text (readableTextOn)
 *   TENTATIVE      — diagonal stripes of the calendar colour over a light tint of it,
 *                    3px solid left edge, normal foreground text
 *   FREE           — surface background, 1px border + 3px left edge in the calendar colour,
 *                    normal foreground text
 *   OOF            — always purple (independent of the calendar colour), solid fill,
 *                    dashed border (theme-dependent edge colour)
 *
 * Stripes, edges and dashes live in index.css (`.fc-event.cm-show-*`); they read the
 * calendar colour from the `--cm-cal` custom property set on the event element.
 */

/** Fixed "Abwesend" purple — white text on it reaches 6.8:1. */
export const OOF_COLOR = '#7B3FA0';
/** Fallback calendar colour (same as the calendar page default). */
export const DEFAULT_CALENDAR_COLOR = '#0078D4';

/** Theme foreground / surface tokens (rgb triplets in tokens.css). */
const FG = 'rgb(var(--fg))';
const SURFACE = 'rgb(var(--surface))';
/** Dashed OOF edge: darker purple in light mode, lighter purple in dark mode (index.css). */
const OOF_EDGE = 'var(--cm-oof-edge)';

export interface ShowAsLook {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  classNames: string[];
  /** CSS custom properties to set on the event element (eventDidMount). */
  cssVars: Record<string, string>;
}

/** Unknown or missing values count as BUSY (the server default). */
export function normalizeShowAs(showAs: string | null | undefined): ShowAs {
  return showAs === 'FREE' || showAs === 'TENTATIVE' || showAs === 'OOF' ? showAs : 'BUSY';
}

function tint(color: string): string {
  return `color-mix(in srgb, ${color} 20%, ${SURFACE})`;
}

/** FullCalendar event colours + classes for one event. */
export function showAsLook(showAs: string | null | undefined, calendarColor: string | null | undefined): ShowAsLook {
  const color = calendarColor || DEFAULT_CALENDAR_COLOR;
  switch (normalizeShowAs(showAs)) {
    case 'TENTATIVE':
      return {
        backgroundColor: tint(color),
        borderColor: color,
        textColor: FG,
        classNames: ['cm-show-tentative'],
        cssVars: { '--cm-cal': color },
      };
    case 'FREE':
      return {
        backgroundColor: SURFACE,
        borderColor: color,
        textColor: FG,
        classNames: ['cm-show-free'],
        cssVars: { '--cm-cal': color },
      };
    case 'OOF':
      return {
        backgroundColor: OOF_COLOR,
        borderColor: OOF_EDGE,
        textColor: readableTextOn(OOF_COLOR),
        classNames: ['cm-show-oof'],
        cssVars: { '--cm-cal': OOF_COLOR },
      };
    default:
      return {
        backgroundColor: color,
        // Calendar colours are user data: black or white text, whichever reaches 4.5:1
        textColor: readableTextOn(color),
        borderColor: 'transparent',
        classNames: [],
        cssVars: {},
      };
  }
}

/** Inline style of the day agenda's colour bar (same rule as the grid). */
export function showAsBarStyle(showAs: string | null | undefined, calendarColor: string | null | undefined): Record<string, string> {
  const color = calendarColor || DEFAULT_CALENDAR_COLOR;
  switch (normalizeShowAs(showAs)) {
    case 'TENTATIVE':
      return {
        backgroundColor: tint(color),
        backgroundImage: `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 4px)`,
      };
    case 'FREE':
      return { backgroundColor: SURFACE, border: `1px solid ${color}` };
    case 'OOF':
      return { backgroundColor: OOF_COLOR };
    default:
      return { backgroundColor: color };
  }
}

/** Sets the look's custom properties on a rendered event element (FullCalendar eventDidMount). */
export function applyShowAsVars(el: HTMLElement, cssVars: unknown): void {
  if (!cssVars || typeof cssVars !== 'object') return;
  for (const [name, value] of Object.entries(cssVars as Record<string, unknown>)) {
    if (name.startsWith('--') && typeof value === 'string') el.style.setProperty(name, value);
  }
}
