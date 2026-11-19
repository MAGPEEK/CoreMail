/**
 * Internationalized domain names for display (pure, 9.5). The server stores and compares
 * domains as A-labels (`xn--…`, see storage `idn.ts`); the BCP shows the U-label first and
 * keeps the A-label as secondary text. Only decoding is needed here — input is normalised
 * server-side, so the A-label shown is exactly what is stored.
 */

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const ACE_PREFIX = 'xn--';

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digitValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 22; // 0-9 -> 26-35
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97;
  return -1;
}

/** Punycode (the label without `xn--`) to Unicode; null when it is not valid punycode. */
export function punycodeDecode(input: string): string | null {
  const delimiter = input.lastIndexOf('-');
  const output: number[] = [];
  for (let i = 0; i < Math.max(delimiter, 0); i++) {
    const code = input.charCodeAt(i);
    if (code >= 128) return null;
    output.push(code);
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  for (let pos = delimiter > 0 ? delimiter + 1 : 0; pos < input.length;) {
    const oldI = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (pos >= input.length) return null;
      const digit = digitValue(input.charCodeAt(pos++));
      if (digit < 0) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
    }
    const len = output.length + 1;
    bias = adapt(i - oldI, len, oldI === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

export type DomainLabelState = 'ascii' | 'idn' | 'invalid';

export interface DisplayDomain {
  /** Domain as stored / typed (lower case). */
  ascii: string;
  /** U-label form; equals `ascii` when there is nothing to decode. */
  unicode: string;
  state: DomainLabelState;
  /** A label of the Unicode form mixes scripts (possible look-alike domain). */
  mixedScript: boolean;
}

// Scripts that legitimately occur together within one label (Japanese, Korean, Chinese).
const COMPOSITE_SCRIPTS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['Han', 'Hiragana', 'Katakana']),
  new Set(['Han', 'Hangul']),
  new Set(['Han', 'Bopomofo']),
];
const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Hebrew', 'Arabic', 'Han', 'Hiragana', 'Katakana', 'Hangul',
  'Bopomofo', 'Thai', 'Devanagari', 'Georgian'] as const;
const SCRIPT_TESTS = SCRIPTS.map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')] as const);

function scriptOf(char: string): string | null {
  if (/[\p{N}\p{M}\p{P}]/u.test(char)) return null; // digits, marks, hyphen: script-neutral
  return SCRIPT_TESTS.find(([, re]) => re.test(char))?.[0] ?? 'Other';
}

/** True when one label mixes letters of different scripts (Latin + Cyrillic, ...). */
export function labelMixesScripts(label: string): boolean {
  const found = new Set<string>();
  for (const char of label) {
    const script = scriptOf(char);
    if (script) found.add(script);
  }
  if (found.size < 2) return false;
  return !COMPOSITE_SCRIPTS.some((allowed) => [...found].every((s) => allowed.has(s)));
}

function decodeLabel(label: string): { text: string; state: DomainLabelState } {
  if (!label.startsWith(ACE_PREFIX)) return { text: label, state: 'ascii' };
  const decoded = punycodeDecode(label.slice(ACE_PREFIX.length));
  // A real A-label always decodes to at least one non-ASCII character.
  if (decoded === null || !/[^\u0000-\u007f]/.test(decoded)) return { text: label, state: 'invalid' };
  return { text: decoded, state: 'idn' };
}

/** Pure: display forms of a domain name (wildcard labels `*` pass through). */
export function describeDomain(domain: string): DisplayDomain {
  const ascii = domain.trim().toLowerCase();
  const labels = ascii.split('.').map(decodeLabel);
  const state: DomainLabelState = labels.some((l) => l.state === 'invalid') ? 'invalid'
    : labels.some((l) => l.state === 'idn') ? 'idn' : 'ascii';
  const unicodeLabels = labels.map((l) => l.text);
  return {
    ascii,
    unicode: state === 'idn' ? unicodeLabels.join('.') : ascii,
    state,
    mixedScript: state === 'idn' && unicodeLabels.some(labelMixesScripts),
  };
}

/**
 * Pure: display forms of an address pattern (`user@domain`, `*@domain`, `*.domain`).
 * The part after the last `@` is the domain; a pattern without `@` is read as a domain.
 * Regular expressions are never converted — use `describeText` for them.
 */
export function describePattern(pattern: string): DisplayDomain {
  const lower = pattern.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  const domain = describeDomain(at >= 0 ? lower.slice(at + 1) : lower);
  if (at < 0) return domain;
  const local = lower.slice(0, at + 1);
  return { ...domain, ascii: lower, unicode: `${local}${domain.unicode}` };
}

/** Plain text without a domain meaning (regular expressions). */
export function describeText(text: string): DisplayDomain {
  return { ascii: text, unicode: text, state: 'ascii', mixedScript: false };
}

/** Pure: true when the search text occurs in the A-label or the U-label form. */
export function matchesDisplay(display: DisplayDomain, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || display.ascii.includes(q) || display.unicode.toLowerCase().includes(q);
}
