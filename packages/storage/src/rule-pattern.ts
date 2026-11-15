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

// ── Case folding (ECMAScript Canonicalize, non-unicode ignoreCase) ───────────
//
// Two code units match case-insensitively when Canonicalize(a) ===
// Canonicalize(b) (ES2024 §22.2.2.7.3): toUpperCase, unless that yields more
// than one unit or maps a non-ASCII unit into ASCII. A character set matches a
// unit when ANY of its members has the same canonical value — for a negated
// class the negation is applied AFTER that (`[^a-z]` must not match "H").
// The input is folded once per character; every set is evaluated on the
// canonical value via the (tiny) equivalence class of that value.

let canonTable: Uint16Array | null = null;
let groupStart: Int32Array | null = null;
let groupMembers: Uint16Array | null = null;

function buildFoldTables(): void {
  const table = new Uint16Array(0x10000);
  const counts = new Int32Array(0x10001);
  for (let c = 0; c < 0x10000; c++) {
    const up = String.fromCharCode(c).toUpperCase();
    let k = up.length === 1 ? up.charCodeAt(0) : c;
    if (c >= 128 && k < 128) k = c;
    table[c] = k;
    counts[k + 1]!++;
  }
  for (let k = 1; k <= 0x10000; k++) counts[k]! += counts[k - 1]!;
  const start = Int32Array.from(counts);
  const members = new Uint16Array(0x10000);
  const fill = Int32Array.from(counts);
  for (let c = 0; c < 0x10000; c++) members[fill[table[c]!]!++] = c;
  canonTable = table;
  groupStart = start;
  groupMembers = members;
}

/** Canonical (case-folded) value of a UTF-16 code unit. */
export function canonicalizeCodeUnit(c: number): number {
  if (!canonTable) buildFoldTables();
  return canonTable![c]!;
}

/**
 * A character set evaluated on canonical values: `positive` is the set as
 * written (union of its members), `negated` the `[^...]` flag. Results for
 * canonical values < 256 are cached.
 */
class CharSet {
  private readonly cache = new Int8Array(256);
  constructor(private readonly positive: Pred, private readonly negated: boolean, private readonly fold: boolean) {}

  /** `k` is a canonical value (fold=true) or the raw code unit (fold=false). */
  matches(k: number, raw: number): boolean {
    if (!this.fold) return this.negated !== this.positive(raw);
    if (k < 256) {
      const v = this.cache[k]!;
      if (v !== 0) return v === 1;
      const r = this.compute(k);
      this.cache[k] = r ? 1 : 2;
      return r;
    }
    return this.compute(k);
  }

  private compute(k: number): boolean {
    let any = false;
    const start = groupStart!, members = groupMembers!;
    for (let j = start[k]!; j < start[k + 1]!; j++) {
      if (this.positive(members[j]!)) { any = true; break; }
    }
    return this.negated ? !any : any;
  }
}

const folded = (pred: Pred, negated = false): CharSet => new CharSet(pred, negated, true);

type Node =
  | { t: 'char'; set: CharSet }
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
        return { t: 'char', set: folded((x) => x === 123) };
      case '.': return { t: 'char', set: new CharSet((x) => !isLineTerminator(x), false, false) };
      case '^': return { t: 'assert', k: '^' };
      case '$': return { t: 'assert', k: '$' };
      case '[': return { t: 'char', set: this.parseClass() };
      case '\\': return this.parseEscape();
      default: {
        const code = c.charCodeAt(0);
        return { t: 'char', set: folded((x) => x === code) };
      }
    }
  }

  /** Escape outside a class. */
  private parseEscape(): Node {
    const c = this.src[this.i];
    if (c === undefined) throw new PatternError('\\ at end of pattern');
    if (c === 'b' || c === 'B') { this.i++; return { t: 'assert', k: c }; }
    const pred = this.escapePred(false);
    return { t: 'char', set: folded(pred) };
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
  private parseClass(): CharSet {
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
    // fold the POSITIVE set, then negate (ES Canonicalize semantics)
    return folded(any, negated);
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
  | { op: 'char'; set: CharSet }
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
      case 'char': this.emit({ op: 'char', set: node.set }); return;
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

// ── Step budget (all patterns of one message) ────────────────────────────────

/** Default VM steps for all regex conditions evaluated for one message. */
export const DEFAULT_RULE_PATTERN_STEP_BUDGET = 5_000_000;

/**
 * Shared step budget: every VM step (thread scheduled or tested) of every
 * pattern run against one message counts. Once it is used up the remaining
 * patterns do not match (`onExhausted` runs once, e.g. to log).
 */
export interface RulePatternBudget {
  remaining: number;
  exhausted: boolean;
  onExhausted?: () => void;
}

/** RULE_PATTERN_STEP_BUDGET (default 5e6; <= 0 or invalid → default). */
export function rulePatternStepBudget(env: Record<string, string | undefined> = process.env): number {
  const n = Number((env['RULE_PATTERN_STEP_BUDGET'] ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RULE_PATTERN_STEP_BUDGET;
}

export function createRulePatternBudget(opts: { steps?: number; onExhausted?: () => void } = {}): RulePatternBudget {
  return {
    remaining: opts.steps ?? rulePatternStepBudget(),
    exhausted: false,
    ...(opts.onExhausted ? { onExhausted: opts.onExhausted } : {}),
  };
}

/**
 * Default VM steps for all rules of one message together (RULE_PATTERN_MESSAGE_STEP_BUDGET).
 * Every rule gets its own RULE_PATTERN_STEP_BUDGET, bounded by what is left of this cap.
 */
export const DEFAULT_RULE_PATTERN_MESSAGE_STEP_BUDGET = 4 * DEFAULT_RULE_PATTERN_STEP_BUDGET;

/** RULE_PATTERN_MESSAGE_STEP_BUDGET (default 4 × the per-rule budget; never below it). */
export function ruleMessageStepBudget(env: Record<string, string | undefined> = process.env): number {
  const perRule = rulePatternStepBudget(env);
  const n = Number((env['RULE_PATTERN_MESSAGE_STEP_BUDGET'] ?? '').trim());
  const value = Number.isFinite(n) && n > 0 ? Math.floor(n) : Math.max(DEFAULT_RULE_PATTERN_MESSAGE_STEP_BUDGET, 4 * perRule);
  return Math.max(value, perRule);
}

/**
 * Runs one rule with its own step budget (RULE_PATTERN_STEP_BUDGET), bounded by
 * what is left of the message budget; the steps used are charged to the
 * message budget afterwards. A sender who pads a message so that one rule's
 * patterns run out of steps cannot thereby starve the following rules.
 */
export function withRuleBudget<T>(
  message: RulePatternBudget,
  fn: (rule: RulePatternBudget) => T,
  perRule: number = rulePatternStepBudget(),
): T {
  const start = Math.max(0, Math.min(perRule, message.remaining));
  const rule = createRulePatternBudget({ steps: start });
  if (message.exhausted || start === 0) rule.exhausted = true;
  try {
    return fn(rule);
  } finally {
    message.remaining = Math.max(0, message.remaining - (start - rule.remaining));
    if (message.remaining === 0 && !message.exhausted) exhaust(message);
  }
}

/**
 * Tri-state pattern evaluation: `exhausted` when the budget ran out before an
 * answer was found (callers decide fail-closed / fail-open), `invalid` for a
 * pattern that does not compile.
 */
export function evaluateRulePattern(
  pattern: string,
  input: string,
  budget: RulePatternBudget,
): 'match' | 'nomatch' | 'exhausted' | 'invalid' {
  if (budget.exhausted) return 'exhausted';
  const r = tryMatchRulePattern(pattern, input, budget);
  if (r === null) return 'invalid';
  if (r) return 'match';
  return budget.exhausted ? 'exhausted' : 'nomatch';
}

function exhaust(budget: RulePatternBudget): false {
  if (!budget.exhausted) {
    budget.exhausted = true;
    budget.remaining = 0;
    budget.onExhausted?.();
  }
  return false;
}

/**
 * Pike VM: unanchored search, O(input × program). The input is case-folded
 * once per character. With a budget, the run stops (no match) when the steps
 * are used up.
 */
export function runRulePattern(compiled: CompiledRulePattern, input: string, budget?: RulePatternBudget): boolean {
  if (budget?.exhausted) return false;
  const prog = compiled.prog;
  const s = input.length > MAX_RULE_MATCH_INPUT ? input.slice(0, MAX_RULE_MATCH_INPUT) : input;
  const n = s.length;
  const mark = new Int32Array(prog.length).fill(-1);
  let matched = false;
  const stack: number[] = [];
  let steps = 0;
  if (!canonTable) buildFoldTables();
  const canon = canonTable!;

  const add = (list: number[], start: number, pos: number): void => {
    stack.push(start);
    while (stack.length > 0) {
      const pc = stack.pop()!;
      steps++;
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

  const limit = budget ? budget.remaining : Infinity;
  const finish = (result: boolean): boolean => {
    if (budget) budget.remaining = Math.max(0, budget.remaining - steps);
    return result;
  };

  let clist: number[] = [];
  for (let pos = 0; ; pos++) {
    add(clist, 0, pos); // a new match attempt starts at every position
    if (matched) return finish(true);
    if (pos >= n) return finish(false);
    if (steps > limit) { finish(false); return exhaust(budget!); }
    const code = s.charCodeAt(pos);
    const k = canon[code]!; // folded once per input character
    const nlist: number[] = [];
    steps += clist.length;
    for (const pc of clist) {
      const inst = prog[pc] as { op: 'char'; set: CharSet };
      if (inst.set.matches(k, code)) add(nlist, pc + 1, pos + 1);
    }
    if (matched) return finish(true);
    clist = nlist;
  }
}

// ── Per-user limit ────────────────────────────────────────────────────────────

/** Most `regex` conditions (conditions + exceptions over all rules) one user may have. */
export const MAX_REGEX_CONDITIONS_PER_USER = 20;

/** Pure: number of `regex` conditions in condition lists (shapes `{ operator }` / `{ op }`). */
export function countRegexConditions(lists: ReadonlyArray<ReadonlyArray<unknown> | null | undefined>): number {
  let n = 0;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const o = c as Record<string, unknown>;
      const op = o['operator'] ?? o['op'] ?? o['Operator'] ?? o['Op'];
      if (typeof op === 'string' && op.toLowerCase() === 'regex') n++;
    }
  }
  return n;
}

const cache = new Map<string, CompiledRulePattern | null>();
const CACHE_MAX = 256;

/**
 * Case-insensitive linear-time regex test for mail rules. Invalid or unsupported
 * patterns never match (and are refused at rule creation by validateRulePattern()).
 */
export function matchRulePattern(pattern: string, input: string, budget?: RulePatternBudget): boolean {
  return tryMatchRulePattern(pattern, input, budget) ?? false;
}

/**
 * Like matchRulePattern, but returns null for an invalid/unsupported pattern
 * (callers that log or skip such entries, e.g. admin blacklist patterns stored
 * before validation existed).
 */
export function tryMatchRulePattern(
  pattern: string,
  input: string,
  /** Shared budget of the message; without one, a fresh RULE_PATTERN_STEP_BUDGET per call. */
  budget: RulePatternBudget = createRulePatternBudget(),
): boolean | null {
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
  return compiled ? runRulePattern(compiled, input, budget) : null;
}
