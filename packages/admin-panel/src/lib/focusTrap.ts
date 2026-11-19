/**
 * Pure logic of the dialog focus trap (components/Modal.tsx): what a Tab key
 * press does, given the dialog's tabbable elements and the focused element.
 */

export type TrapAction<T> =
  | { kind: 'default' }
  | { kind: 'block' }
  | { kind: 'focus'; target: T };

/**
 * Tab stays inside the dialog: it wraps at both ends, and focus that sits outside
 * the tabbable elements (the page behind after a click, or the dialog panel itself)
 * is pulled to the first / last one. Elsewhere the browser's own order applies.
 */
export function trapTab<T>(items: readonly T[], active: T | null, shift: boolean): TrapAction<T> {
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return { kind: 'block' };
  const index = active === null ? -1 : items.indexOf(active);
  if (index === -1) return { kind: 'focus', target: shift ? last : first };
  if (shift && index === 0) return { kind: 'focus', target: last };
  if (!shift && index === items.length - 1) return { kind: 'focus', target: first };
  return { kind: 'default' };
}
