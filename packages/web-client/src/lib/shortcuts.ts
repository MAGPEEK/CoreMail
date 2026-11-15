/**
 * Keyboard shortcut definitions + matcher (framework-free, unit-tested).
 *
 * Two switchable sets modelled on Exchange OWA 2019:
 *  - "gmail"    — the Gmail set OWA offers (c/r/a/f, e, #, !, s, v, z, j/k, g-sequences …)
 *  - "coremail" — the default: the Gmail set plus Outlook-style Ctrl combinations
 *                 (Ctrl+N/R/Shift+R/F, Ctrl+Q/U, Insert, Ctrl+Z) and Delete.
 *
 * Keys are written as normalised combos: "c", "shift+i", "ctrl+shift+r",
 * "delete", "#", "?" and sequences as "g i" (g, then i within the timeout).
 * Symbols (# ! ? /) are matched by the produced character, so they work on
 * any keyboard layout (on a German layout "#" has its own key, "?" is Shift+ß).
 */

export type ShortcutSetId = 'coremail' | 'gmail';
export type ShortcutContext = 'mail' | 'calendar' | 'other';

export type ShortcutAction =
  | 'compose.new' | 'compose.send'
  | 'mail.reply' | 'mail.replyAll' | 'mail.forward'
  | 'mail.archive' | 'mail.delete' | 'mail.deletePermanent' | 'mail.spam'
  | 'mail.flag' | 'mail.move' | 'mail.markRead' | 'mail.markUnread'
  | 'mail.next' | 'mail.prev' | 'mail.open' | 'mail.back' | 'mail.select'
  | 'mail.nextInConversation' | 'mail.prevInConversation'
  | 'undo'
  | 'go.inbox' | 'go.flagged' | 'go.sent' | 'go.drafts' | 'go.all' | 'go.contacts' | 'go.calendar'
  | 'search' | 'help'
  | 'calendar.new' | 'calendar.today' | 'calendar.day' | 'calendar.week' | 'calendar.month';

export interface Binding {
  keys: string;
  action: ShortcutAction;
  /** Only active in these contexts (default: everywhere). Context bindings win. */
  contexts?: ShortcutContext[];
  /** Also fires while typing in an input/editor (only Ctrl+Enter in compose). */
  allowInEditable?: boolean;
}

export type ShortcutGroup = 'compose' | 'actions' | 'navigation' | 'goto' | 'calendar' | 'general';

export const ACTION_GROUP: Record<ShortcutAction, ShortcutGroup> = {
  'compose.new': 'compose', 'compose.send': 'compose',
  'mail.reply': 'compose', 'mail.replyAll': 'compose', 'mail.forward': 'compose',
  'mail.archive': 'actions', 'mail.delete': 'actions', 'mail.deletePermanent': 'actions',
  'mail.spam': 'actions', 'mail.flag': 'actions', 'mail.move': 'actions',
  'mail.markRead': 'actions', 'mail.markUnread': 'actions', undo: 'actions',
  'mail.next': 'navigation', 'mail.prev': 'navigation', 'mail.open': 'navigation',
  'mail.back': 'navigation', 'mail.select': 'navigation',
  'mail.nextInConversation': 'navigation', 'mail.prevInConversation': 'navigation',
  'go.inbox': 'goto', 'go.flagged': 'goto', 'go.sent': 'goto', 'go.drafts': 'goto',
  'go.all': 'goto', 'go.contacts': 'goto', 'go.calendar': 'goto',
  search: 'general', help: 'general',
  'calendar.new': 'calendar', 'calendar.today': 'calendar', 'calendar.day': 'calendar',
  'calendar.week': 'calendar', 'calendar.month': 'calendar',
};

const MAIL: ShortcutContext[] = ['mail'];
const CAL: ShortcutContext[] = ['calendar'];

const GMAIL_BINDINGS: Binding[] = [
  { keys: 'c', action: 'compose.new' },
  { keys: 'ctrl+enter', action: 'compose.send', allowInEditable: true },
  { keys: 'r', action: 'mail.reply', contexts: MAIL },
  { keys: 'a', action: 'mail.replyAll', contexts: MAIL },
  { keys: 'f', action: 'mail.forward', contexts: MAIL },
  { keys: 'e', action: 'mail.archive', contexts: MAIL },
  { keys: '#', action: 'mail.delete', contexts: MAIL },
  { keys: 'delete', action: 'mail.delete', contexts: MAIL },
  { keys: 'shift+delete', action: 'mail.deletePermanent', contexts: MAIL },
  { keys: '!', action: 'mail.spam', contexts: MAIL },
  { keys: 's', action: 'mail.flag', contexts: MAIL },
  { keys: 'v', action: 'mail.move', contexts: MAIL },
  { keys: 'z', action: 'undo' },
  { keys: 'shift+i', action: 'mail.markRead', contexts: MAIL },
  { keys: 'shift+u', action: 'mail.markUnread', contexts: MAIL },
  { keys: 'j', action: 'mail.next', contexts: MAIL },
  { keys: 'k', action: 'mail.prev', contexts: MAIL },
  { keys: 'o', action: 'mail.open', contexts: MAIL },
  { keys: 'enter', action: 'mail.open', contexts: MAIL },
  { keys: 'u', action: 'mail.back', contexts: MAIL },
  { keys: 'x', action: 'mail.select', contexts: MAIL },
  { keys: 'n', action: 'mail.nextInConversation', contexts: MAIL },
  { keys: 'p', action: 'mail.prevInConversation', contexts: MAIL },
  { keys: 'g i', action: 'go.inbox' },
  { keys: 'g s', action: 'go.flagged' },
  { keys: 'g t', action: 'go.sent' },
  { keys: 'g d', action: 'go.drafts' },
  { keys: 'g a', action: 'go.all' },
  { keys: 'g c', action: 'go.contacts' },
  { keys: 'g k', action: 'go.calendar' },
  { keys: '/', action: 'search' },
  { keys: '?', action: 'help' },
  // Calendar (both sets): c = new event, t = today, d/w/m = views
  { keys: 'c', action: 'calendar.new', contexts: CAL },
  { keys: 't', action: 'calendar.today', contexts: CAL },
  { keys: 'd', action: 'calendar.day', contexts: CAL },
  { keys: 'w', action: 'calendar.week', contexts: CAL },
  { keys: 'm', action: 'calendar.month', contexts: CAL },
];

/** Outlook-like extras of the CoreMail default set. */
const COREMAIL_EXTRAS: Binding[] = [
  { keys: 'ctrl+n', action: 'compose.new' },
  { keys: 'ctrl+r', action: 'mail.reply', contexts: MAIL },
  { keys: 'ctrl+shift+r', action: 'mail.replyAll', contexts: MAIL },
  { keys: 'ctrl+f', action: 'mail.forward', contexts: MAIL },
  { keys: 'ctrl+q', action: 'mail.markRead', contexts: MAIL },
  { keys: 'ctrl+u', action: 'mail.markUnread', contexts: MAIL },
  { keys: 'insert', action: 'mail.flag', contexts: MAIL },
  { keys: 'ctrl+shift+v', action: 'mail.move', contexts: MAIL },
  { keys: 'ctrl+z', action: 'undo' },
];

export const SHORTCUT_SETS: Record<ShortcutSetId, Binding[]> = {
  gmail: GMAIL_BINDINGS,
  coremail: [...GMAIL_BINDINGS, ...COREMAIL_EXTRAS],
};

export const SEQUENCE_TIMEOUT_MS = 1500;

/** Minimal shape of a KeyboardEvent (testable without a DOM). */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  target?: unknown;
}

const NAMED: Record<string, string> = {
  Enter: 'enter', Delete: 'delete', Backspace: 'backspace', Escape: 'escape', Insert: 'insert',
  ArrowDown: 'arrowdown', ArrowUp: 'arrowup', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright',
  Tab: 'tab', ' ': 'space', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
};
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Dead']);

/**
 * Normalises a key event to a combo string, or null for bare modifiers.
 * Meta (⌘) counts as Ctrl. Shift is only part of the combo for letters and
 * named keys — symbols are matched by the character they produce.
 */
export function normalizeKey(e: KeyLike): string | null {
  if (!e.key || MODIFIER_KEYS.has(e.key)) return null;
  let key: string;
  let shiftRelevant: boolean;
  if (NAMED[e.key]) { key = NAMED[e.key]!; shiftRelevant = true; }
  else if (e.key.length === 1) {
    const lower = e.key.toLowerCase();
    const isLetter = lower !== e.key.toUpperCase();
    key = lower;
    shiftRelevant = isLetter;
  } else { key = e.key.toLowerCase(); shiftRelevant = true; }
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey && shiftRelevant) mods.push('shift');
  return [...mods, key].join('+');
}

interface ElementLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  getAttribute?: (n: string) => string | null;
  closest?: (sel: string) => unknown;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** True for text inputs, textareas, selects and rich-text editors (contenteditable). */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as ElementLike;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase());
  if (el.isContentEditable) return true;
  if (el.getAttribute?.('role') === 'textbox') return true;
  return !!el.closest?.('[contenteditable="true"],[contenteditable=""]');
}

const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'option', 'tab', 'checkbox', 'switch']);

/** Buttons, links and widgets where Enter/Space already do something. */
export function isInteractiveTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as ElementLike;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return true;
  if (tag === 'INPUT') return true;
  return INTERACTIVE_ROLES.has(el.getAttribute?.('role') ?? '');
}

export type MatchResult =
  | { kind: 'action'; action: ShortcutAction; binding: Binding }
  | { kind: 'pending'; prefix: string }
  | null;

export interface MatchOptions {
  set: ShortcutSetId;
  context: ShortcutContext;
}

function activeBindings(set: ShortcutSetId, context: ShortcutContext): Binding[] {
  const all = SHORTCUT_SETS[set].filter((b) => !b.contexts || b.contexts.includes(context));
  // Context-specific bindings first (calendar "c" beats global "c")
  return [...all.filter((b) => b.contexts), ...all.filter((b) => !b.contexts)];
}

/**
 * Stateful matcher (holds a pending sequence prefix such as "g").
 * `now` is injectable for tests.
 */
export function createShortcutMatcher(opts: { timeoutMs?: number; now?: () => number } = {}) {
  const timeoutMs = opts.timeoutMs ?? SEQUENCE_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  let pending: { prefix: string; at: number } | null = null;

  return {
    get pendingPrefix(): string | null {
      if (pending && now() - pending.at > timeoutMs) pending = null;
      return pending?.prefix ?? null;
    },
    reset(): void { pending = null; },
    match(e: KeyLike, o: MatchOptions): MatchResult {
      if (e.isComposing) return null;
      const combo = normalizeKey(e);
      if (!combo) return null;
      const editable = isEditableTarget(e.target);
      const bindings = activeBindings(o.set, o.context);
      // Enter/Space on a focused button or link keeps its native meaning
      if ((combo === 'enter' || combo === 'space') && isInteractiveTarget(e.target)) return null;

      if (editable) {
        pending = null;
        const b = bindings.find((x) => x.allowInEditable && x.keys === combo);
        return b ? { kind: 'action', action: b.action, binding: b } : null;
      }

      if (pending && now() - pending.at <= timeoutMs) {
        const seq = `${pending.prefix} ${combo}`;
        pending = null;
        const b = bindings.find((x) => x.keys === seq);
        // An unknown second key cancels the sequence (it is not re-interpreted)
        return b ? { kind: 'action', action: b.action, binding: b } : null;
      }
      pending = null;

      const single = bindings.find((x) => x.keys === combo);
      if (single) return { kind: 'action', action: single.action, binding: single };
      if (bindings.some((x) => x.keys.startsWith(`${combo} `))) {
        pending = { prefix: combo, at: now() };
        return { kind: 'pending', prefix: combo };
      }
      return null;
    },
  };
}

export type ShortcutMatcher = ReturnType<typeof createShortcutMatcher>;

/** All key combos bound to an action in a set (for help texts and aria-keyshortcuts). */
export function keysFor(set: ShortcutSetId, action: ShortcutAction): string[] {
  return SHORTCUT_SETS[set].filter((b) => b.action === action).map((b) => b.keys);
}

const ARIA_NAMES: Record<string, string> = {
  ctrl: 'Control', shift: 'Shift', alt: 'Alt', enter: 'Enter', delete: 'Delete', insert: 'Insert',
  escape: 'Escape', backspace: 'Backspace', space: 'Space',
};

/**
 * aria-keyshortcuts value (space-separated alternatives, e.g. "R Control+R").
 * Sequences ("g i") cannot be expressed and are skipped.
 */
export function ariaKeyShortcuts(set: ShortcutSetId, action: ShortcutAction): string | undefined {
  const parts = keysFor(set, action)
    .filter((k) => !k.includes(' '))
    .map((k) => k.split('+').map((p) => ARIA_NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join('+'));
  return parts.length ? parts.join(' ') : undefined;
}

/** Display form: [["Ctrl", "Shift", "R"]] per alternative, sequences as ["G", "then", "I"]. */
export function displayKeys(keys: string, isMac = false): string[][] {
  return keys.split(' ').map((part) => part.split('+').map((p) => {
    if (p === 'ctrl') return isMac ? '⌘' : 'Ctrl';
    if (p === 'shift') return isMac ? '⇧' : 'Shift';
    if (p === 'alt') return isMac ? '⌥' : 'Alt';
    if (p === 'enter') return 'Enter';
    if (p === 'delete') return isMac ? 'Del' : 'Entf/Del';
    if (p === 'insert') return 'Einfg/Ins';
    return p.length === 1 ? p.toUpperCase() : p;
  }));
}
