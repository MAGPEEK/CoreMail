/**
 * Integer field with bounds: the text is typed freely and clamped on blur
 * (clamping on every keystroke made values like "15" untypeable with min 5).
 * Empty or invalid text keeps the previous value.
 */
export function clampNumber(text: string, min: number, max: number, previous: number): number {
  const n = parseInt(text, 10);
  if (!Number.isFinite(n)) return previous;
  return Math.min(max, Math.max(min, n));
}
