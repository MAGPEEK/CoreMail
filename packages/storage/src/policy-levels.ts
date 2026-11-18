/**
 * 9.4: resolution of settings that exist on the levels server → domain → user
 * (protocol access switches, webmail policies). Pure — no I/O.
 *
 *  - switches are tri-state (`inherit | on | off`); the most specific
 *    non-inherit level wins, nothing set = the built-in default
 *  - values (lists, numbers, modes) are `null` for inherit; the most specific
 *    non-null level wins, nothing set = the built-in default
 *
 * Levels are always passed broadest first; index 0 = server, 1 = domain,
 * 2 = user (a caller may pass fewer, e.g. server + domain for a domain view).
 */

export const SWITCH_SETTINGS = ['inherit', 'on', 'off'] as const;
export type SwitchSetting = typeof SWITCH_SETTINGS[number];

/** The server level has no broader level to inherit from: only on / off. */
export const SERVER_SWITCH_SETTINGS = ['on', 'off'] as const;

export const POLICY_LEVELS = ['global', 'domain', 'user'] as const;
export type PolicyLevel = typeof POLICY_LEVELS[number];

/** One level of a policy: the server, a domain or a user. */
export type PolicyScope =
  | { level: 'global' }
  | { level: 'domain'; domainId: string }
  | { level: 'user'; userId: string };

/** Where an effective value comes from: a level, or the built-in default. */
export type ValueSource = PolicyLevel | 'default';

/** The database enum of a tri-state switch (Prisma `ProtocolSwitch`). */
export type SwitchColumn = 'INHERIT' | 'ON' | 'OFF';

export const switchFromColumn = (v: SwitchColumn | null | undefined): SwitchSetting =>
  (v === 'ON' ? 'on' : v === 'OFF' ? 'off' : 'inherit');
export const switchToColumn = (s: SwitchSetting): SwitchColumn =>
  (s === 'on' ? 'ON' : s === 'off' ? 'OFF' : 'INHERIT');

/** `fn` applied to every key. */
export function mapKeys<K extends string, T>(keys: readonly K[], fn: (k: K) => T): Record<K, T> {
  return Object.fromEntries(keys.map((k) => [k, fn(k)])) as Record<K, T>;
}

/** Every key `inherit`. */
export function inheritAllSwitches<K extends string>(keys: readonly K[]): Record<K, SwitchSetting> {
  return mapKeys(keys, () => 'inherit');
}

/** One switch: value + the level that decided it. */
export function resolveSwitch(
  levels: ReadonlyArray<SwitchSetting | undefined>,
  fallback: boolean,
): { value: boolean; source: ValueSource } {
  for (let i = levels.length - 1; i >= 0; i--) {
    const s = levels[i];
    if (s !== undefined && s !== 'inherit') return { value: s === 'on', source: POLICY_LEVELS[i] ?? 'user' };
  }
  return { value: fallback, source: 'default' };
}

/** Effective switches from `levels` (broadest first). */
export function resolveSwitches<K extends string>(
  keys: readonly K[],
  levels: ReadonlyArray<Readonly<Record<K, SwitchSetting>>>,
  defaults: Readonly<Record<K, boolean>>,
): Record<K, boolean> {
  return mapKeys(keys, (k) => resolveSwitch(levels.map((l) => l[k]), defaults[k]).value);
}

/** One value (null / undefined = inherit): value + the level that decided it. */
export function resolveValue<T>(
  levels: ReadonlyArray<T | null | undefined>,
  fallback: T,
): { value: T; source: ValueSource } {
  for (let i = levels.length - 1; i >= 0; i--) {
    const v = levels[i];
    if (v !== null && v !== undefined) return { value: v, source: POLICY_LEVELS[i] ?? 'user' };
  }
  return { value: fallback, source: 'default' };
}
