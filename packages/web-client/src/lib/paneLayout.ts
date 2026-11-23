/**
 * 10.1: floating panes. 10.7: three columns — there is no top bar and no ribbon;
 * the app body is the whole window: the app rail and, beside it, a canvas
 * (bg-canvas, or the background picture — App.tsx marks it `group/app` with
 * `data-bg="on"`). On the canvas, with 8 px gaps and an 8 px outer margin, the
 * page's cards: in the mail view the folder card, the message list card and the
 * content card (reading pane, or the compose card while a draft is shown).
 * Cards: rounded-xl, 1 px token border, the surface — at PANE_SURFACE_ALPHA
 * (92 %) with a light blur while a picture is shown, opaque otherwise. Below
 * 768 px the single-pane flow keeps full-width panes without gaps or rounding.
 * Literal class names so Tailwind finds them. No imports — unit-tested.
 */

/** Translucent surface while the app body shows a picture (lib/paneSurface.test.ts checks the contrast). */
export const ON_PICTURE = 'group-data-[bg=on]/app:bg-surface/[0.92] group-data-[bg=on]/app:backdrop-blur-sm';

/** Card without its background colour (a pane that keeps its own tint, e.g. bg-surface-2). */
export const PANE_CARD_BASE = `border-line md:rounded-xl md:border overflow-hidden ${ON_PICTURE}`;

/** A card of the floating layout (from 768 px; flat and full width below). */
export const PANE_CARD_CLASS = `bg-surface ${PANE_CARD_BASE}`;

/**
 * The folder card (mail folders, calendar list, contact folders). 10.7: a card
 * like the other two — three separate cards with gaps.
 */
export const FOLDER_PANE_CLASS = PANE_CARD_CLASS;

/** The page area on the canvas: 8 px margin and gaps from 768 px. */
export const PANE_CANVAS_CLASS = 'md:p-2 md:gap-2';

/** The app body (rail + page): the whole window; App.tsx sets the picture as its background image. */
export const APP_BODY_CLASS = 'group/app relative flex-1 flex flex-col-reverse md:flex-row min-h-0 bg-canvas bg-cover bg-center';

/** The column beside the rail: the MFA banners (slim cards) above the page. */
export const CANVAS_COLUMN_CLASS = 'flex-1 flex flex-col min-w-0 min-h-0';

/** 10.7: an MFA banner at the top of the canvas — a slim card from 768 px, a full-width strip below. */
export const BANNER_CARD_CLASS = 'shrink-0 border-warning-line max-md:border-b md:mx-2 md:mt-2 md:rounded-xl md:border';
