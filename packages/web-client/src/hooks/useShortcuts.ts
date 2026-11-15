/**
 * Central keyboard shortcut manager.
 *
 * - `useShortcutManager()` (once, in the app layout) listens to keydown on the
 *   document, matches the active set (Settings → View) with lib/shortcuts.ts and
 *   dispatches to the registered handlers. Keys typed into inputs/editors are
 *   ignored (except Ctrl+Enter), as are keys while a Modal is open or inside the
 *   compose window (`data-shortcut-scope="compose"`).
 * - `useShortcutHandlers({...})` registers handlers for actions while the
 *   component is mounted. The most recently mounted handler wins; a handler that
 *   returns `false` passes the key on to the next one.
 */
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { createShortcutMatcher, ariaKeyShortcuts, type ShortcutAction, type ShortcutContext } from '../lib/shortcuts.js';
import { useUiPrefs } from '../store/ui.js';
import { isModalOpen } from '../components/Modal.js';

export type ShortcutHandler = () => boolean | void;
type HandlerMap = Partial<Record<ShortcutAction, ShortcutHandler>>;

interface Registration { id: symbol; ref: { current: HandlerMap } }
const registrations: Registration[] = [];

/** Runs the newest handler for an action; returns true when one handled it. */
export function dispatchShortcut(action: ShortcutAction): boolean {
  for (let i = registrations.length - 1; i >= 0; i--) {
    const fn = registrations[i]!.ref.current[action];
    if (fn && fn() !== false) return true;
  }
  return false;
}

export function useShortcutHandlers(handlers: HandlerMap): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const reg: Registration = { id: Symbol('shortcuts'), ref };
    registrations.push(reg);
    return () => {
      const i = registrations.indexOf(reg);
      if (i >= 0) registrations.splice(i, 1);
    };
  }, []);
}

/** aria-keyshortcuts value for an action in the active set (undefined when shortcuts are off). */
export function useAriaKeys(): (action: ShortcutAction) => string | undefined {
  const enabled = useUiPrefs((s) => s.shortcutsEnabled);
  const set = useUiPrefs((s) => s.shortcutSet);
  return (action) => (enabled ? ariaKeyShortcuts(set, action) : undefined);
}

function contextFor(pathname: string): ShortcutContext {
  if (pathname.startsWith('/mail')) return 'mail';
  if (pathname.startsWith('/calendar')) return 'calendar';
  return 'other';
}

export function useShortcutManager(): void {
  const location = useLocation();
  const contextRef = useRef<ShortcutContext>(contextFor(location.pathname));
  contextRef.current = contextFor(location.pathname);

  useEffect(() => {
    const matcher = createShortcutMatcher();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const { shortcutsEnabled, shortcutSet } = useUiPrefs.getState();
      if (!shortcutsEnabled) return;
      if (isModalOpen()) { matcher.reset(); return; }
      const target = e.target as Element | null;
      if (target && typeof target.closest === 'function' && target.closest('[data-shortcut-scope="compose"]')) return;
      const res = matcher.match(e, { set: shortcutSet, context: contextRef.current });
      if (!res) return;
      if (res.kind === 'pending') { e.preventDefault(); return; }
      if (dispatchShortcut(res.action)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
