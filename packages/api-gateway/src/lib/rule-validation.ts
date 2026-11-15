/**
 * Save-time validation of admin/user-configured `regex` patterns (v8.1).
 *
 * Mail rules, transport rules and blacklist REGEX entries run against
 * attacker-controlled mail data with the linear-time matcher from
 * @coremail/storage (rule-pattern.ts). Patterns it cannot run (backreferences,
 * lookarounds, > 200 characters, invalid syntax) would silently never match, so
 * they are refused with a readable 400 message when the rule is saved.
 */
import { validateRulePattern } from '@coremail/storage';

/**
 * First refused `regex` pattern in a list of conditions, as a readable message,
 * or null. Accepts the shapes used by the APIs: `{ op, value }` (transport
 * rules), `{ operator, value }` (mail rules) and EMS-style `{ Op|Operator, Value }`.
 */
export function invalidRegexConditionMessage(conditions: ReadonlyArray<unknown> | undefined): string | null {
  for (const c of conditions ?? []) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const op = o['op'] ?? o['operator'] ?? o['Op'] ?? o['Operator'];
    if (typeof op !== 'string' || op.toLowerCase() !== 'regex') continue;
    const value = o['value'] ?? o['Value'];
    const v = validateRulePattern(value);
    if (!v.ok) return `Invalid regular expression "${String(value).slice(0, 80)}": ${v.error}`;
  }
  return null;
}
