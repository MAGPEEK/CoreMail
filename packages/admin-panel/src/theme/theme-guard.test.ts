/**
 * Theme guard: UI code must use the semantic tokens (tokens.css + tailwind config),
 * never raw palette colours that only work in one theme or miss WCAG contrast.
 * KEEP IDENTICAL in web-client and admin-panel.
 *
 * Forbidden (also with variant prefixes such as hover:, focus:, group-hover:):
 *   - `dark:` variants              → tokens switch automatically
 *   - neutral palette classes       → bg-/text-/border-/divide-/ring-/placeholder-(gray|slate|zinc|neutral|stone)-N
 *   - bg-white, bg-black, text-black → bg-surface, bg-scrim/NN, text-fg
 *   - coloured text/border/ring     → text-danger-fg, border-info-line, …
 *   - one-theme tints               → bg-HUE-50..300 / 800..950 (use bg-*-bg)
 *   - arbitrary colour values       → bg-[#1e2433], text-[rgb(…)] (use a token)
 *   - translucent white text        → text-white/80 (use text-white; darken the fill with bg-scrim/NN instead)
 * Allowed: text-white (on solid fills), bg-white/NN + border-white/NN (on accent/solid fills),
 *   solid decorative fills bg-HUE-400..700, every token class.
 * Justified exception: put `theme-guard-ignore: <reason>` on the same or the preceding line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUE = '(?:red|green|yellow|amber|blue|orange|purple|emerald|indigo|sky|teal|rose|pink|violet|lime|cyan|fuchsia)';
const NEUTRAL = '(?:gray|slate|zinc|neutral|stone)';
const B = '(?<![\\w-])';
const E = '(?![\\w-])';
const PROPS = '(?:bg|text|border|border-[trblxy]|divide|ring|ring-offset|outline|placeholder|from|via|to|fill|stroke|decoration|caret)';
const LINE_PROPS = '(?:text|border|border-[trblxy]|divide|ring|ring-offset|outline|placeholder|decoration|fill|stroke|caret)';
const RULES: Array<[RegExp, string]> = [
  [new RegExp(`${B}dark:[\\w-]`), 'dark: variant (tokens switch automatically)'],
  [new RegExp(`${B}${PROPS}-${NEUTRAL}-\\d{2,3}(?:/\\d+)?${E}`), 'neutral palette colour'],
  [new RegExp(`${B}(?:bg-white|bg-black|text-black|border-black)(?![\\w/-])`), 'absolute white/black'],
  [new RegExp(`${B}bg-black/\\d+`), 'black scrim (use bg-scrim/NN)'],
  [new RegExp(`${B}${LINE_PROPS}-${HUE}-\\d{2,3}(?:/\\d+)?${E}`), 'raw coloured text/border (use status tokens)'],
  [new RegExp(`${B}bg-${HUE}-(?:50|100|200|300|800|900|950)(?:/\\d+)?${E}`), 'raw coloured tint (use bg-*-bg)'],
  [new RegExp(`${B}${PROPS}-\\[(?:#|rgb|hsl)`), 'arbitrary colour value (use a token)'],
  [new RegExp(`${B}(?:text|placeholder)-white/\\d+`), 'translucent white text loses contrast (use text-white)'],
];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p !== join(src, 'theme')) yield* files(p);
    } else if (/\.(tsx?|css)$/.test(name) && !/\.test\.ts$/.test(name)) {
      yield p;
    }
  }
}

test('UI code uses semantic colour tokens only (WCAG-checked, both themes)', () => {
  const problems: string[] = [];
  for (const f of files(src)) {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.includes('theme-guard-ignore') || (lines[i - 1] ?? '').includes('theme-guard-ignore')) return;
      for (const [re, why] of RULES) {
        const m = re.exec(line);
        if (m) { problems.push(`${relative(src, f).split(sep).join('/')}:${i + 1}  ${m[0]}  — ${why}`); break; }
      }
    });
  }
  assert.equal(problems.length, 0, `${problems.length} raw colour classes:\n${problems.join('\n')}`);
});
