/**
 * 10.1: floating panes. The app body below the top bar is a canvas (bg-canvas,
 * or the background picture — App.tsx marks it `group/app` with
 * `data-bg="on"`); on it, with 8 px gaps and an 8 px outer margin, the command
 * card (ribbon), the folder pane, the message list card and the reading-pane card
 * (the compose card takes its place while a draft is shown). Cards: rounded-xl,
 * 1 px token border, the surface — at PANE_SURFACE_ALPHA (92 %) with a light blur
 * while a picture is shown, opaque otherwise. Below 768 px the single-pane flow
 * keeps full-width panes without gaps or rounding.
 * Literal class names so Tailwind finds them. No imports — unit-tested.
 */

/** Translucent surface while the app body shows a picture (lib/paneSurface.test.ts checks the contrast). */
export const ON_PICTURE = 'group-data-[bg=on]/app:bg-surface/[0.92] group-data-[bg=on]/app:backdrop-blur-sm';

/** Card without its background colour (a pane that keeps its own tint, e.g. bg-surface-2). */
export const PANE_CARD_BASE = `border-line md:rounded-xl md:border overflow-hidden ${ON_PICTURE}`;

/** A card of the floating layout (from 768 px; flat and full width below). */
export const PANE_CARD_CLASS = `bg-surface ${PANE_CARD_BASE}`;

/**
 * The folder pane: directly on the plain canvas (no card), but a translucent card
 * while a picture is shown — text straight on a picture is not legible.
 */
export const FOLDER_PANE_CLASS = 'bg-canvas group-data-[bg=on]/app:md:rounded-xl group-data-[bg=on]/app:md:border group-data-[bg=on]/app:border-line '
  + `overflow-hidden ${ON_PICTURE}`;

/** The page area on the canvas: 8 px margin and gaps from 768 px. */
export const PANE_CANVAS_CLASS = 'md:p-2 md:gap-2';

/** The app body (rail + page) below the top bar; App.tsx sets the picture as its background image. */
export const APP_BODY_CLASS = 'group/app relative flex-1 flex flex-col-reverse md:flex-row min-h-0 bg-canvas bg-cover bg-center';
