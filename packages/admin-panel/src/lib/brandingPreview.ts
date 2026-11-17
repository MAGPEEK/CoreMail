/**
 * Live preview of the branding page (BCP): the light and the dark look side by
 * side, whatever theme the admin uses. The preview container gets the token
 * values of the theme it shows as inline CSS variables, so the ordinary token
 * classes (bg-surface, text-fg, bg-accent, bg-header …) inside it resolve to
 * that theme. brandingPreview.test.ts checks the values against tokens.css.
 */
import { brandCssVars, hexToChannels, headerHex, normalizeHex, DEFAULT_ACCENT_RGB, DEFAULT_PRIMARY_COLOR } from './branding.ts';

export const PREVIEW_TOKEN_NAMES = ['canvas', 'surface', 'surface-2', 'surface-3', 'fg', 'fg-muted', 'fg-subtle', 'line', 'line-strong', 'scrim'] as const;

export const PREVIEW_THEME_VARS: Record<'light' | 'dark', Record<(typeof PREVIEW_TOKEN_NAMES)[number], string>> = {
  light: {
    canvas: '243 244 246', surface: '255 255 255', 'surface-2': '246 247 249', 'surface-3': '232 234 238',
    fg: '17 24 39', 'fg-muted': '75 85 99', 'fg-subtle': '93 100 112',
    line: '226 229 233', 'line-strong': '122 129 141', scrim: '0 0 0',
  },
  dark: {
    canvas: '17 19 24', surface: '27 30 37', 'surface-2': '34 38 46', 'surface-3': '44 49 59',
    fg: '238 240 243', 'fg-muted': '182 188 198', 'fg-subtle': '155 162 173',
    line: '50 56 67', 'line-strong': '122 130 145', scrim: '0 0 0',
  },
};

/**
 * Inline style for a preview container: theme tokens + the brand variables
 * derived from the (unsaved) colours, exactly as the apps compute them
 * (BCP/webmail default accent = primary colour).
 */
export function previewStyle(
  draft: { primaryColor: string; headerColor: string | null },
  dark: boolean,
): Record<string, string> {
  const primary = normalizeHex(draft.primaryColor) ?? DEFAULT_PRIMARY_COLOR;
  const accent = hexToChannels(primary) ?? DEFAULT_ACCENT_RGB;
  const header = headerHex({ primaryColor: primary, headerColor: normalizeHex(draft.headerColor) });
  const vars: Record<string, string> = { colorScheme: dark ? 'dark' : 'light' };
  for (const [k, v] of Object.entries(PREVIEW_THEME_VARS[dark ? 'dark' : 'light'])) vars[`--${k}`] = v;
  return { ...vars, ...brandCssVars(accent, header, dark) };
}
