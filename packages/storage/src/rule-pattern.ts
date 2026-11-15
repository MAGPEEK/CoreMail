/**
 * Linear-time matcher for user-supplied mail-rule `regex` conditions.
 *
 * Inbox rules run inside `storeInboundMessage()` on the SMTP delivery path. A
 * user pattern executed by the backtracking JS engine (`new RegExp(value)`)
 * can take exponential (or large polynomial) time on a crafted subject/body —
 * one rule would stall inbound mail for every user (ReDoS).
 *
 * Patterns are therefore compiled into a Thompson NFA and run with a Pike VM
 * (no backtracking): time is O(input length × program size) whatever the
 * pattern. The accepted syntax is the common JS subset — literals, `.`,
 * classes `[...]`, `\d \w \s \D \W \S \b \B`, `^ $`, groups `( )` / `(?: )`,
 * alternation `|`, quantifiers `* + ? {n} {n,} {n,m}` (lazy forms behave the
 * same for a yes/no match). Backreferences, lookarounds, named groups and
 * Unicode property escapes are refused (they have no linear-time form).
 * Matching is case-insensitive (like the former `new RegExp(value, 'i')`);
 * `^`/`$` anchor the whole input (no multiline flag).
 *
 * Limits: pattern ≤ MAX_RULE_PATTERN_LENGTH characters, compiled program ≤
 * MAX_RULE_PROGRAM_SIZE instructions, matched input ≤ MAX_RULE_MATCH_INPUT
 * characters (longer input is truncated).
 */

export const MAX_RULE_PATTERN_LENGTH = 200;
export const MAX_RULE_MATCH_INPUT = 64 * 1024;
export const MAX_RULE_PROGRAM_SIZE = 1000;
const MAX_REPEAT_BOUND = 100;

type Pred = (c: number) => boolean;

type Node =
  | { t: 'char'; pred: Pred }
  | { t: 'assert'; k: '^' | '$' | 'b' | 'B' }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number }
  | { t: 'empty' };

class PatternError extends Error {}

const isWordCode = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isDigitCode = (c: number): boolean => c >= 48 && c <= 57;
const isSpaceCode = (c: number): boolean =>
  (c >= 9 && c <= 13) || c === 32 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const isLineTerminator = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

/** Case-insensitive wrapper: the predicate is tried on the char, its lower and upper case. */
function caseless(pred: Pred): Pred {
  return (c) => {
    if (pred(c)) return true;
    const s = String.fromCharCode(c);
    const lo = s.toLowerCase();
    const up = s.toUpperCase();
    return (lo.length === 1 && pred(lo.charCodeAt(0))) || (up.length === 1 && pred(up.charCodeAt(0)));
  };
}

class Parser {
  private i = 0;
  constructor(private readonly src: string) {}

  parse(): Node {
    const node = this.parseAlt();
    if (this.i < this.src.length) throw new PatternError(`unexpected '${this.src[this.i]}' at ${this.i}`);
    return node;
  }

  private peek(): string | undefined { return this.src[this.i]; }

  private parseAlt(): Node {
    const items = [this.parseSeq()];
    while (this.peek() === '|') {
      this.i++;
      items.push(this.parseSeq());
    }
    return items.length === 1 ? items[0]! : { t: 'alt', items };
  }

  private parseSeq(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.peek() !== '|' && this.peek() !== ')') {
      const atom = this.parseAtom();
      items.push(this.parseQuantifier(atom));
    }
    if (items.length === 0) return { t: 'empty' };
    return items.length === 1 ? items[0]! : { t: 'cat', items };
  }

  /** `{n}`, `{n,}`, `{n,m}` at the current position, or null (then `{` is a literal). */
  private readBraces(): { min: number; max: number; len: number } | null {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
    if (!m) return null;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
    return { min, max, len: m[0].length };
  }

  private parseQuantifier(atom: Node): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === '*') { min = 0; max = Infinity; this.i++; }
    else if (c === '+') { min = 1; max = Infinity; this.i++; }
    else if (c === '?') { min = 0; max = 1; this.i++; }
    else if (c === '{') {
      const b = this.readBraces();
      if (!b) return atom;
      min = b.min; max = b.max; this.i += b.len;
      if (min > max) throw new PatternError('numbers out of order in {} quantifier');
      if (min > MAX_REPEAT_BOUND || (max !== Infinity && max > MAX_REPEAT_BOUND)) {
        throw new PatternError(`repetition bound above ${MAX_REPEAT_BOUND}`);
      }
    } else {
      return atom;
    }
    if (this.peek() === '?') this.i++; // lazy: same yes/no answer
    if (atom.t === 'assert') throw new PatternError('quantified assertion');
    const next = this.peek();
    if (next === '*' || next === '+' || next === '?' || (next === '{' && this.readBraces())) {
      throw new PatternError('nothing to repeat');
    }
    return { t: 'rep', node: atom, min, max };
  }

  private parseAtom(): Node {
    const c = this.src[this.i++]!;
    switch (c) {
      case '(': {
        if (this.peek() === '?') {
          if (this.src[this.i + 1] !== ':') throw new PatternError('lookaround and named groups are not supported');
          this.i += 2;
        }
        const inner = this.parseAlt();
        if (this.peek() !== ')') throw new PatternError('unterminated group');
        this.i++;
        return inner;
      }
      case ')': throw new PatternError('unmatched )');
      case '*': case '+': case '?': throw new PatternError('nothing to repeat');
      case '{':
        this.i--;
        if (this.readBraces()) throw new PatternError('nothing to repeat');
        this.i++;
        return { t: 'char', pred: caseless((x) => x === 123) };
      case '.': return { t: 'char', pred: (x) => !isLineTerminator(x) };
      case '^': return { t: 'assert', k: '^' };
      case '$': return { t: 'assert', k: '$' };
      case '[': return { t: 'char', pred: caseless(this.parseClass()) };
      case '\\': return this.parseEscape();
      default: {
        const code = c.charCodeAt(0);
        return { t: 'char', pred: caseless((x) => x === code) };
      }
    }
  }

  /** Escape outside a class. */
  private parseEscape(): Node {
    const c = this.src[this.i];
    if (c === undefined) throw new PatternError('\\ at end of pattern');
    if (c === 'b' || c === 'B') { this.i++; return { t: 'assert', k: c }; }
    const pred = this.escapePred(false);
    return { t: 'char', pred: caseless(pred) };
  }

  /** Shared escape decoding (inside and outside classes); `this.i` points after the backslash. */
  private escapePred(inClass: boolean): Pred {
    const c = this.src[this.i++];
    if (c === undefined) throw new PatternError('\\ at end of pattern');
    const lit = (code: number): Pred => (x) => x === code;
    switch (c) {
      case 'd': return isDigitCode;
      case 'D': return (x) => !isDigitCode(x);
      case 'w': return isWordCode;
      case 'W': return (x) => !isWordCode(x);
      case 's': return isSpaceCode;
      case 'S': return (x) => !isSpaceCode(x);
      case 'n': return lit(10);
      case 'r': return lit(13);
      case 't': return lit(9);
      case 'f': return lit(12);
      case 'v': return lit(11);
      case 'b': if (inClass) return lit(8); break;
      case '0': if (!/[0-9]/.test(this.peek() ?? '')) return lit(0); break;
      case 'x': {
        const m = /^[0-9a-fA-F]{2}/.exec(this.src.slice(this.i));
        if (!m) throw new PatternError('invalid \\x escape');
        this.i += 2;
        return lit(parseInt(m[0], 16));
      }
      case 'u': {
        const m = /^[0-9a-fA-F]{4}/.exec(this.src.slice(this.i));
        if (!m) throw new PatternError('invalid \\u escape');
        this.i += 4;
        return lit(parseInt(m[0], 16));
      }
      default:
        // identity escape for punctuation (\. \* \/ \- ...)
        if (!/[A-Za-z0-9]/.test(c)) return lit(c.charCodeAt(0));
    }
    if (/[1-9]/.test(c) || c === 'k') throw new PatternError('backreferences are not supported');
    throw new PatternError(`unsupported escape \\${c}`);
  }

  /** `[...]` — `this.i` points after `[`. */
  private parseClass(): Pred {
    let negated = false;
    if (this.peek() === '^') { negated = true; this.i++; }
    const parts: Pred[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw new PatternError('unterminated character class');
      if (c === ']') { this.i++; break; } // `[]` matches nothing / `[^]` anything (JS)
      const lo = this.classAtom();
      if (this.peek() === '-' && this.src[this.i + 1] !== undefined && this.src[this.i + 1] !== ']') {
        this.i++;
        const hi = this.classAtom();
        if (lo.code === null || hi.code === null) {
          // `[\d-x]`: '-' is a literal (Annex B)
          parts.push(lo.pred, (x) => x === 45, hi.pred);
          continue;
        }
        if (lo.code > hi.code) throw new PatternError('range out of order in character class');
        const a = lo.code, b = hi.code;
        parts.push((x) => x >= a && x <= b);
        continue;
      }
      parts.push(lo.pred);
    }
    const any: Pred = (x) => parts.some((p) => p(x));
    return negated ? (x) => !any(x) : any;
  }

  /** One class member: a single code (usable in ranges) or a class escape. */
  private classAtom(): { pred: Pred; code: number | null } {
    const c = this.src[this.i++]!;
    if (c !== '\\') {
      const code = c.charCodeAt(0);
      return { pred: (x) => x === code, code };
    }
    const nextCh = this.peek();
    const isClassEscape = nextCh !== undefined && 'dDwWsS'.includes(nextCh);
    const start = this.i;
    const pred = this.escapePred(true);
    if (isClassEscape) return { pred, code: null };
    const raw = this.src.slice(start, this.i);
    const code = singleEscapeCode(raw);
    return { pred, code };
  }
}

function singleEscapeCode(raw: string): number {
  switch (raw[0]) {
    case 'n': return 10;
    case 'r': return 13;
    case 't': return 9;
    case 'f': return 12;
    case 'v': return 11;
    case 'b': return 8;
    case '0': return 0;
    case 'x': case 'u': return parseInt(raw.slice(1), 16);
    default: return raw.charCodeAt(0);
  }
}

// ── Compilation (Thompson construction) ──────────────────────────────────────

type Inst =
  | { op: 'char'; pred: Pred }
  | { op: 'split'; x: number; y: number }
  | { op: 'jmp'; x: number }
  | { op: 'assert'; k: '^' | '$' | 'b' | 'B' }
  | { op: 'match' };

class Compiler {
  readonly prog: Inst[] = [];

  private emit(inst: Inst): number {
    if (this.prog.length >= MAX_RULE_PROGRAM_SIZE) throw new PatternError('pattern too complex');
    this.prog.push(inst);
    return this.prog.length - 1;
  }

  compile(node: Node): void {
    switch (node.t) {
      case 'empty': return;
      case 'char': this.emit({ op: 'char', pred: node.pred }); return;
      case 'assert': this.emit({ op: 'assert', k: node.k }); return;
      case 'cat': for (const n of node.items) this.compile(n); return;
      case 'alt': {
        const jumps: number[] = [];
        for (let k = 0; k < node.items.length; k++) {
          if (k < node.items.length - 1) {
            const split = this.emit({ op: 'split', x: 0, y: 0 });
            (this.prog[split] as { x: number }).x = this.prog.length;
            this.compile(node.items[k]!);
            jumps.push(this.emit({ op: 'jmp', x: 0 }));
            (this.prog[split] as { y: number }).y = this.prog.length;
          } else {
            this.compile(node.items[k]!);
          }
        }
        for (const j of jumps) (this.prog[j] as { x: number }).x = this.prog.length;
        return;
      }
      case 'rep': {
        for (let k = 0; k < node.min; k++) this.compile(node.node);
        if (node.max === Infinity) {
          const split = this.emit({ op: 'split', x: 0, y: 0 });
          (this.prog[split] as { x: number }).x = this.prog.length;
          this.compile(node.node);
          this.emit({ op: 'jmp', x: split });
          (this.prog[split] as { y: number }).y = this.prog.length;
        } else {
          const splits: number[] = [];
          for (let k = node.min; k < node.max; k++) {
            const split = this.emit({ op: 'split', x: 0, y: 0 });
            (this.prog[split] as { x: number }).x = this.prog.length;
            splits.push(split);
            this.compile(node.node);
          }
          for (const s of splits) (this.prog[s] as { y: number }).y = this.prog.length;
        }
        return;
      }
    }
  }
}

export interface CompiledRulePattern {
  readonly prog: readonly Inst[];
}

/** Compiles a pattern or throws an Error with a user-readable message. */
export function compileRulePattern(pattern: string): CompiledRulePattern {
  if (typeof pattern !== 'string') throw new PatternError('pattern must be a string');
  if (pattern.length > MAX_RULE_PATTERN_LENGTH) throw new PatternError(`pattern longer than ${MAX_RULE_PATTERN_LENGTH} characters`);
  try {
    new RegExp(pattern, 'i'); // must also be valid JavaScript syntax
  } catch (err) {
    throw new PatternError(`invalid regular expression: ${(err as Error).message}`);
  }
  const ast = new Parser(pattern).parse();
  const c = new Compiler();
  c.compile(ast);
  c.prog.push({ op: 'match' });
  return { prog: c.prog };
}

/** Validation for API routes: `{ ok: true }` or the reason the pattern is refused. */
export function validateRulePattern(pattern: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof pattern !== 'string') return { ok: false, error: 'pattern must be a string' };
  try {
    compileRulePattern(pattern);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Pike VM: unanchored search, O(input × program). */
export function runRulePattern(compiled: CompiledRulePattern, input: string): boolean {
  const prog = compiled.prog;
  const s = input.length > MAX_RULE_MATCH_INPUT ? input.slice(0, MAX_RULE_MATCH_INPUT) : input;
  const n = s.length;
  const mark = new Int32Array(prog.length).fill(-1);
  let matched = false;
  const stack: number[] = [];

  const add = (list: number[], start: number, pos: number): void => {
    stack.push(start);
    while (stack.length > 0) {
      const pc = stack.pop()!;
      if (mark[pc] === pos) continue;
      mark[pc] = pos;
      const inst = prog[pc]!;
      switch (inst.op) {
        case 'jmp': stack.push(inst.x); break;
        case 'split': stack.push(inst.y, inst.x); break;
        case 'match': matched = true; break;
        case 'char': list.push(pc); break;
        case 'assert': {
          let ok: boolean;
          if (inst.k === '^') ok = pos === 0;
          else if (inst.k === '$') ok = pos === n;
          else {
            const before = pos > 0 && isWordCode(s.charCodeAt(pos - 1));
            const after = pos < n && isWordCode(s.charCodeAt(pos));
            ok = inst.k === 'b' ? before !== after : before === after;
          }
          if (ok) stack.push(pc + 1);
          break;
        }
      }
    }
  };

  let clist: number[] = [];
  for (let pos = 0; ; pos++) {
    add(clist, 0, pos); // a new match attempt starts at every position
    if (matched) return true;
    if (pos >= n) return false;
    const code = s.charCodeAt(pos);
    const nlist: number[] = [];
    for (const pc of clist) {
      const inst = prog[pc] as { op: 'char'; pred: Pred };
      if (inst.pred(code)) add(nlist, pc + 1, pos + 1);
    }
    if (matched) return true;
    clist = nlist;
  }
}

const cache = new Map<string, CompiledRulePattern | null>();
const CACHE_MAX = 256;

/**
 * Case-insensitive linear-time regex test for mail rules. Invalid or unsupported
 * patterns never match (and are refused at rule creation by validateRulePattern()).
 */
export function matchRulePattern(pattern: string, input: string): boolean {
  return tryMatchRulePattern(pattern, input) ?? false;
}

/**
 * Like matchRulePattern, but returns null for an invalid/unsupported pattern
 * (callers that log or skip such entries, e.g. admin blacklist patterns stored
 * before validation existed).
 */
export function tryMatchRulePattern(pattern: string, input: string): boolean | null {
  let compiled = cache.get(pattern);
  if (compiled === undefined) {
    try {
      compiled = compileRulePattern(pattern);
    } catch {
      compiled = null;
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(pattern, compiled);
  }
  return compiled ? runRulePattern(compiled, input) : null;
}
