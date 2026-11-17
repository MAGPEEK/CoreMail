/**
 * Strict SVG sanitiser for branding uploads (9.3).
 *
 * A small, strict XML tokenizer builds a tree; every element and attribute is
 * checked against an allowlist of what logos use (shapes, paths, text,
 * gradients, clip paths, masks, simple filters, <style>). Anything unsafe or
 * unknown makes the upload fail with {@link SvgUnsafeError} (HTTP 400
 * SVG_UNSAFE) — nothing is silently rewritten:
 *   - DOCTYPE / ENTITY declarations, processing instructions other than the
 *     leading XML declaration, named entities other than the five XML ones
 *   - script, foreignObject, image, a, animation elements (set / animate*),
 *     any element or attribute not on the allowlist
 *   - event-handler attributes (on*), href / xlink:href other than `#fragment`
 *   - javascript: / vbscript: / data: anywhere, url(…) other than url(#id),
 *     backslashes (CSS escapes), expression(), -moz-binding, behavior
 *   - <style> containing url( / @import / @font-face / @namespace
 *   - oversized input, deep nesting, too many nodes / attributes
 *   - more than 50 <use> elements, or a <use> referencing an element that is
 *     or contains <use> (exponential instancing)
 *
 * Editor metadata (Inkscape/Sodipodi/RDF namespaces, <metadata>) and comments
 * are dropped. The output is re-serialised from the checked tree — what is
 * stored is exactly what was validated (no parser differential between this
 * tokenizer and the browser).
 */

export class SvgUnsafeError extends Error {
  readonly code = 'SVG_UNSAFE';
  constructor(message: string) {
    super(message);
    this.name = 'SvgUnsafeError';
  }
}

export interface SanitizedSvg {
  svg: string;
  /** Intrinsic size in CSS px from width/height (or the viewBox), null when unknown. */
  width: number | null;
  height: number | null;
}

export interface SanitizeOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'symbol', 'use', 'switch',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker',
  'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feComposite', 'feFlood',
  'feMerge', 'feMergeNode', 'feDropShadow', 'feMorphology',
  'style',
]);

/** Elements refused with a specific reason (they are not on the allowlist anyway). */
const FORBIDDEN_ELEMENTS: Record<string, string> = {
  script: 'script elements are not allowed',
  foreignObject: 'foreignObject is not allowed',
  image: 'embedded or linked images are not allowed',
  feImage: 'embedded or linked images are not allowed',
  a: 'links are not allowed',
  iframe: 'iframe is not allowed', embed: 'embed is not allowed', object: 'object is not allowed',
  set: 'animation elements are not allowed', animate: 'animation elements are not allowed',
  animateTransform: 'animation elements are not allowed', animateMotion: 'animation elements are not allowed',
  animateColor: 'animation elements are not allowed', handler: 'handler is not allowed', listener: 'listener is not allowed',
};

/** Dropped together with their content (editor metadata). */
const DROPPED_ELEMENT_PREFIXES = ['sodipodi:', 'inkscape:', 'rdf:', 'cc:', 'dc:'];
const DROPPED_ELEMENTS = new Set(['metadata']);
const DROPPED_ATTR_PREFIXES = ['sodipodi:', 'inkscape:', 'sketch:', 'serif:'];

/** Elements that may reference a local fragment through href / xlink:href. */
const HREF_ELEMENTS = new Set(['use', 'textPath', 'linearGradient', 'radialGradient', 'pattern', 'filter']);

const ATTRIBUTES = new Set([
  // core / structure
  'id', 'class', 'style', 'lang', 'xml:space', 'xml:lang', 'version', 'baseProfile', 'role', 'focusable', 'tabindex',
  'width', 'height', 'x', 'y', 'viewBox', 'preserveAspectRatio', 'transform', 'requiredFeatures', 'systemLanguage',
  // geometry
  'd', 'pathLength', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'points',
  // presentation
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'color',
  'clip-path', 'clip-rule', 'mask', 'filter', 'display', 'visibility', 'overflow', 'shape-rendering',
  'text-rendering', 'image-rendering', 'color-rendering', 'color-interpolation', 'color-interpolation-filters',
  'vector-effect', 'paint-order', 'mix-blend-mode', 'isolation', 'enable-background',
  'marker-start', 'marker-mid', 'marker-end',
  // text
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'font-size-adjust',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'letter-spacing', 'word-spacing',
  'text-decoration', 'writing-mode', 'direction', 'unicode-bidi', 'dx', 'dy', 'rotate', 'textLength',
  'lengthAdjust', 'startOffset', 'method', 'spacing', 'side',
  // gradients / paint servers / clipping
  'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'fx', 'fy', 'fr', 'patternUnits', 'patternContentUnits', 'patternTransform',
  'clipPathUnits', 'maskUnits', 'maskContentUnits',
  'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient',
  // filters
  'filterUnits', 'primitiveUnits', 'in', 'in2', 'result', 'stdDeviation', 'edgeMode', 'mode', 'type',
  'values', 'operator', 'k1', 'k2', 'k3', 'k4', 'flood-color', 'flood-opacity', 'radius',
  // style element
  'media', 'title',
  // accessibility
  'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden',
  // links (fragment only, see HREF_ELEMENTS)
  'href', 'xlink:href',
]);

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const FRAGMENT_RE = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;

interface SvgNode { name: string; attrs: Array<[string, string]>; children: Array<SvgNode | string> }

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&([^;&\s<]{0,32});?/g, (whole, body: string) => {
    if (!whole.endsWith(';')) throw new SvgUnsafeError('bare "&" (not a valid entity reference)');
    if (body in XML_ENTITIES) return XML_ENTITIES[body]!;
    const m = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(body);
    if (!m) throw new SvgUnsafeError(`entity &${body}; is not allowed`);
    const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2]!, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new SvgUnsafeError('invalid character reference');
    return String.fromCodePoint(cp);
  });
}

const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => escText(s).replace(/"/g, '&quot;');

/** Lower-cased, whitespace/control-free view of a value for scheme checks. */
// eslint-disable-next-line no-control-regex
const squash = (s: string): string => s.toLowerCase().replace(/[\s\x00-\x1f]+/g, '');

function checkValue(where: string, value: string, isStyle: boolean): void {
  const v = squash(value);
  if (value.includes('\\')) throw new SvgUnsafeError(`${where}: backslashes (CSS escapes) are not allowed`);
  for (const bad of ['javascript:', 'vbscript:', 'data:', 'expression(', '-moz-binding', 'behavior:']) {
    if (v.includes(bad)) throw new SvgUnsafeError(`${where}: "${bad}" is not allowed`);
  }
  // CSS functions that load resources without url(…)
  if (/(image-set|image|cross-fade|element|src)\(/.test(v)) {
    throw new SvgUnsafeError(`${where}: CSS resource functions are not allowed`);
  }
  // url(…) only as url(#fragment), optionally quoted
  const urlRe = /url\(([^)]*)\)?/gi;
  for (const m of value.matchAll(urlRe)) {
    const inner = (m[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    if (!m[0].endsWith(')') || !FRAGMENT_RE.test(inner)) throw new SvgUnsafeError(`${where}: only url(#id) references are allowed`);
  }
  if (isStyle && /@(import|font-face|namespace)/i.test(v)) throw new SvgUnsafeError(`${where}: @-rules are not allowed`);
}

function checkStyleElement(css: string): void {
  if (/url\(/i.test(css)) throw new SvgUnsafeError('<style>: url( is not allowed');
  if (/@import/i.test(squash(css))) throw new SvgUnsafeError('<style>: @import is not allowed');
  checkValue('<style>', css, true);
}

class Tokenizer {
  private pos = 0;
  nodes = 0;
  constructor(private readonly s: string, private readonly opts: Required<SanitizeOptions>) {}

  private fail(msg: string): never { throw new SvgUnsafeError(msg); }
  private startsWith(t: string): boolean { return this.s.startsWith(t, this.pos); }
  private skipWs(): void { while (this.pos < this.s.length && /\s/.test(this.s[this.pos]!)) this.pos++; }

  parse(): SvgNode {
    this.skipWs();
    if (this.startsWith('<?xml') && /^<\?xml[\s?]/.test(this.s.slice(this.pos, this.pos + 6))) {
      const end = this.s.indexOf('?>', this.pos);
      if (end < 0) this.fail('unterminated XML declaration');
      const decl = this.s.slice(this.pos, end + 2);
      if (!/^<\?xml\s+version\s*=\s*(["'])1\.\d\1(\s+encoding\s*=\s*(["'])utf-8\3)?(\s+standalone\s*=\s*(["'])(yes|no)\5)?\s*\?>$/i.test(decl)) {
        this.fail('unsupported XML declaration (UTF-8 only)');
      }
      this.pos = end + 2;
    }
    let root: SvgNode | null = null;
    for (;;) {
      this.skipWs();
      if (this.pos >= this.s.length) break;
      if (this.startsWith('<!--')) { this.comment(); continue; }
      if (this.startsWith('<?')) this.fail('processing instructions are not allowed');
      if (this.startsWith('<!')) this.fail('DOCTYPE / ENTITY declarations are not allowed');
      if (!this.startsWith('<')) this.fail('text outside the root element');
      if (root) this.fail('more than one root element');
      const el = this.element(0);
      if (!el) this.fail('unexpected closing tag');
      root = el;
    }
    if (!root) this.fail('no <svg> root element');
    if (root.name !== 'svg') this.fail(`root element must be <svg>, got <${root.name}>`);
    return root;
  }

  private comment(): void {
    const end = this.s.indexOf('-->', this.pos + 4);
    if (end < 0) this.fail('unterminated comment');
    this.pos = end + 3;
  }

  /** Parses one element starting at '<' (null for a closing tag, which the caller handles). */
  private element(depth: number): SvgNode | null {
    if (depth > this.opts.maxDepth) this.fail('elements nested too deeply');
    if (++this.nodes > this.opts.maxNodes) this.fail('too many elements');
    this.pos++; // '<'
    if (this.s[this.pos] === '/') return null;
    const name = this.name();
    const attrs: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (;;) {
      const before = this.pos;
      this.skipWs();
      if (this.startsWith('/>')) { this.pos += 2; return { name, attrs, children: [] }; }
      if (this.startsWith('>')) { this.pos++; break; }
      if (this.pos === before) this.fail(`malformed tag <${name}>`);
      const an = this.name();
      this.skipWs();
      if (this.s[this.pos] !== '=') this.fail(`attribute ${an} without a value`);
      this.pos++;
      this.skipWs();
      const q = this.s[this.pos];
      if (q !== '"' && q !== "'") this.fail(`attribute ${an} value must be quoted`);
      const end = this.s.indexOf(q, this.pos + 1);
      if (end < 0) this.fail(`unterminated attribute ${an}`);
      const raw = this.s.slice(this.pos + 1, end);
      if (raw.includes('<')) this.fail(`"<" in attribute ${an}`);
      if (raw.length > 200_000) this.fail(`attribute ${an} too long`);
      this.pos = end + 1;
      if (seen.has(an)) this.fail(`duplicate attribute ${an}`);
      seen.add(an);
      if (attrs.length >= 100) this.fail('too many attributes');
      attrs.push([an, decodeEntities(raw)]);
    }
    const children: Array<SvgNode | string> = [];
    for (;;) {
      if (this.pos >= this.s.length) this.fail(`unclosed element <${name}>`);
      if (this.startsWith('<!--')) { this.comment(); continue; }
      if (this.startsWith('<![CDATA[')) {
        const end = this.s.indexOf(']]>', this.pos);
        if (end < 0) this.fail('unterminated CDATA section');
        children.push(this.s.slice(this.pos + 9, end));
        this.pos = end + 3;
        continue;
      }
      if (this.startsWith('<?')) this.fail('processing instructions are not allowed');
      if (this.startsWith('<!')) this.fail('DOCTYPE / ENTITY declarations are not allowed');
      if (this.startsWith('</')) {
        this.pos += 2;
        const close = this.name();
        this.skipWs();
        if (this.s[this.pos] !== '>') this.fail(`malformed closing tag </${close}>`);
        this.pos++;
        if (close !== name) this.fail(`mismatched closing tag </${close}> for <${name}>`);
        return { name, attrs, children };
      }
      if (this.startsWith('<')) {
        const child = this.element(depth + 1);
        if (!child) this.fail('unexpected closing tag');
        children.push(child);
        continue;
      }
      const next = this.s.indexOf('<', this.pos);
      const end = next < 0 ? this.s.length : next;
      children.push(decodeEntities(this.s.slice(this.pos, end)));
      this.pos = end;
    }
  }

  private name(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(this.s.slice(this.pos, this.pos + 256));
    if (!m) this.fail('invalid name');
    this.pos += m[0].length;
    return m[0];
  }
}

interface CheckState { usesXlink: boolean; uses: number }

/** At most this many <use> elements per SVG. */
export const MAX_USE_ELEMENTS = 50;

/**
 * Rejects a <use> whose target is a <use> or contains one. Nested <use>
 * instancing multiplies (n uses of a group with n uses …), so only one level
 * of instancing is allowed. With duplicate ids every element carrying the id
 * counts. Self / ancestor references are covered (the target contains the <use>).
 */
function checkUseReferences(root: SvgNode): void {
  const byId = new Map<string, SvgNode[]>();
  const uses: SvgNode[] = [];
  const walk = (n: SvgNode): void => {
    const id = n.attrs.find(([k]) => k === 'id')?.[1];
    if (id !== undefined) byId.set(id, [...(byId.get(id) ?? []), n]);
    if (n.name === 'use') uses.push(n);
    for (const c of n.children) if (typeof c !== 'string') walk(c);
  };
  walk(root);
  const memo = new Map<SvgNode, boolean>();
  const hasUse = (n: SvgNode): boolean => {
    let v = memo.get(n);
    if (v === undefined) {
      v = n.name === 'use' || n.children.some((c) => typeof c !== 'string' && hasUse(c));
      memo.set(n, v);
    }
    return v;
  };
  for (const u of uses) {
    const ref = u.attrs.find(([k]) => k === 'href' || k === 'xlink:href')?.[1];
    if (!ref) continue;
    if ((byId.get(ref.slice(1)) ?? []).some(hasUse)) {
      throw new SvgUnsafeError(`<use> must not reference an element that is or contains <use> (${ref})`);
    }
  }
}

/** Validates one element (recursively) → the node to serialise, or null when dropped. */
function checkNode(node: SvgNode, st: CheckState, inStyle = false): SvgNode | null {
  const { name } = node;
  if (DROPPED_ELEMENTS.has(name) || DROPPED_ELEMENT_PREFIXES.some((p) => name.startsWith(p))) return null;
  if (FORBIDDEN_ELEMENTS[name]) throw new SvgUnsafeError(FORBIDDEN_ELEMENTS[name]!);
  if (!ELEMENTS.has(name)) throw new SvgUnsafeError(`element <${name}> is not allowed`);
  if (inStyle) throw new SvgUnsafeError('<style> may contain text only');
  if (name === 'use' && ++st.uses > MAX_USE_ELEMENTS) throw new SvgUnsafeError(`too many <use> elements (at most ${MAX_USE_ELEMENTS})`);

  const attrs: Array<[string, string]> = [];
  for (const [an, value] of node.attrs) {
    if (!NAME_RE.test(an)) throw new SvgUnsafeError(`invalid attribute name ${an}`);
    if (/^on/i.test(an)) throw new SvgUnsafeError(`event handler attribute ${an} is not allowed`);
    if (an === 'xmlns') {
      if (value !== SVG_NS) throw new SvgUnsafeError('default namespace must be the SVG namespace');
      continue; // re-added on the root
    }
    if (an.startsWith('xmlns:')) {
      if (an === 'xmlns:xlink' && value !== XLINK_NS) throw new SvgUnsafeError('xmlns:xlink must be the XLink namespace');
      if (an === 'xmlns:svg' && value !== SVG_NS) throw new SvgUnsafeError('xmlns:svg must be the SVG namespace');
      checkValue(an, value, false);
      continue; // declarations are re-created on output (xlink only)
    }
    if (DROPPED_ATTR_PREFIXES.some((p) => an.startsWith(p))) continue;
    if (an === 'href' || an === 'xlink:href') {
      if (!HREF_ELEMENTS.has(name)) throw new SvgUnsafeError(`${an} is not allowed on <${name}>`);
      if (!FRAGMENT_RE.test(value.trim())) throw new SvgUnsafeError(`${an} must be a local #fragment reference`);
      if (an === 'xlink:href') st.usesXlink = true;
      attrs.push([an, value.trim()]);
      continue;
    }
    if (!ATTRIBUTES.has(an) && !/^data-[a-z0-9-]{1,40}$/.test(an)) throw new SvgUnsafeError(`attribute ${an} is not allowed`);
    if (name === 'style' && an === 'type' && !/^\s*text\/css\s*$/i.test(value)) throw new SvgUnsafeError('<style type> must be text/css');
    checkValue(an, value, an === 'style');
    attrs.push([an, value]);
  }

  const children: Array<SvgNode | string> = [];
  for (const c of node.children) {
    if (typeof c === 'string') {
      // Text is inert everywhere except in <style> (script elements are refused).
      if (name === 'style') checkStyleElement(c);
      children.push(c);
      continue;
    }
    if (name === 'style') throw new SvgUnsafeError('<style> may contain text only');
    const checked = checkNode(c, st);
    if (checked) children.push(checked);
  }
  return { name, attrs, children };
}

function serialize(node: SvgNode, root: boolean, st: CheckState): string {
  const attrs = [...node.attrs];
  if (root) {
    if (st.usesXlink) attrs.unshift(['xmlns:xlink', XLINK_NS]);
    attrs.unshift(['xmlns', SVG_NS]);
  }
  const open = `<${node.name}${attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('')}`;
  if (!node.children.length) return `${open}/>`;
  const inner = node.children.map((c) => (typeof c === 'string' ? escText(c) : serialize(c, false, st))).join('');
  return `${open}>${inner}</${node.name}>`;
}

const UNIT_PX: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };

function lengthPx(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]!) * UNIT_PX[(m[2] ?? '').toLowerCase()]!;
  return Number.isFinite(n) ? n : null;
}

function svgSize(root: SvgNode): { width: number | null; height: number | null } {
  const get = (k: string) => root.attrs.find(([n]) => n === k)?.[1];
  let width = lengthPx(get('width'));
  let height = lengthPx(get('height'));
  const vb = get('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb.every(Number.isFinite)) {
    if (width === null && height === null) { width = vb[2]!; height = vb[3]!; }
    else if (width === null && height !== null && vb[3]! > 0) width = (height * vb[2]!) / vb[3]!;
    else if (height === null && width !== null && vb[2]! > 0) height = (width * vb[3]!) / vb[2]!;
  }
  return { width, height };
}

/** Validates and re-serialises an SVG. Throws {@link SvgUnsafeError}. */
export function sanitizeSvg(input: Buffer | string, options: SanitizeOptions = {}): SanitizedSvg {
  const opts: Required<SanitizeOptions> = { maxBytes: 512 * 1024, maxDepth: 64, maxNodes: 20_000, ...options };
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (bytes.length > opts.maxBytes) throw new SvgUnsafeError('SVG too large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SvgUnsafeError('SVG must be UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\0')) throw new SvgUnsafeError('NUL characters are not allowed');
  const tree = new Tokenizer(text, opts).parse();
  const st: CheckState = { usesXlink: false, uses: 0 };
  const checked = checkNode(tree, st)!;
  checkUseReferences(checked);
  return { svg: `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(checked, true, st)}\n`, ...svgSize(checked) };
}
