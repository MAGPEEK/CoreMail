/**
 * Semantic colour tokens for Tailwind (values live in tokens.css).
 * KEEP IDENTICAL in web-client and admin-panel.
 *
 *   bg-canvas            app background
 *   bg-surface           cards, panels, dialogs, menus, inputs
 *   bg-surface-2         subtle/sunken areas, table headers, hover
 *   bg-surface-3         selected / pressed / stronger hover
 *   text-fg              primary text        text-fg-muted   secondary text
 *   text-fg-subtle       tertiary text, icons (still >= 4.5:1)
 *   text-fg-disabled     disabled controls only (WCAG-exempt)
 *   border-line          decorative separators   border-line-strong  control borders (>= 3:1)
 *   bg-scrim/50          modal backdrop
 *   bg-accent            solid accent fill (white text)   text-accent-fg / ring-accent-fg  accent text, icons, focus
 *   bg-header text-header-fg  bg-header-overlay/NN   webmail top bar (branding colour, text >= 4.5:1)
 *   bg-danger|success|warning|info          solid fill (white text)
 *   text-*-fg  bg-*-bg  border-*-line       status text, tint, border
 */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;
const status = (name: string) => ({ DEFAULT: v(name), fg: v(`${name}-fg`), bg: v(`${name}-bg`), line: v(`${name}-line`) });

export const themeColors = {
  canvas: v('canvas'),
  surface: { DEFAULT: v('surface'), 2: v('surface-2'), 3: v('surface-3') },
  fg: { DEFAULT: v('fg'), muted: v('fg-muted'), subtle: v('fg-subtle'), disabled: v('fg-disabled') },
  line: { DEFAULT: v('line'), strong: v('line-strong') },
  scrim: v('scrim'),
  accent: {
    DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
    hover: 'rgb(var(--color-accent) / 0.85)',
    active: 'rgb(var(--color-accent) / 0.7)',
    light: 'rgb(var(--color-accent) / 0.08)',
    fg: 'rgb(var(--color-accent-fg) / <alpha-value>)',
  },
  header: { DEFAULT: v('header'), fg: v('header-fg'), overlay: v('header-overlay') },
  danger: status('danger'),
  success: status('success'),
  warning: status('warning'),
  info: status('info'),
};
