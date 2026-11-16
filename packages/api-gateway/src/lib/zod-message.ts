/**
 * Readable 400 message from a zod error (9.1.x BCP review): the admin panel
 * shows `error` as is, so "Invalid input" alone never told the admin WHICH
 * field was wrong. Keeps `details` / `issues` for API clients.
 */
import type { ZodError } from 'zod';

export function invalidInputMessage(err: ZodError, prefix = 'Ungültige Eingabe'): string {
  const first = err.issues[0];
  if (!first) return prefix;
  const path = first.path.map(String).join('.');
  return `${prefix}: ${path ? `${path} — ` : ''}${first.message}`;
}
