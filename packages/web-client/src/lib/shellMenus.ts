/**
 * 10.7: the app shell has no top bar any more. The bottom of the app rail holds
 * the notifications bell, the settings gear and the avatar with the profile
 * menu; below 768 px (the rail is the bottom bar) bell and settings move into the
 * avatar menu. Pure — unit-tested with `node --test`.
 */

/** Top of the rail: the brand logo mark (the product name is its accessible name); the app entries follow. */
export const RAIL_TOP = ['brand'] as const;

/** Buttons at the bottom of the rail (md and up), top to bottom. */
export const RAIL_BOTTOM = ['notifications', 'settings', 'profile'] as const;
export type RailBottomId = typeof RAIL_BOTTOM[number];

export type ProfileMenuId = 'notifications' | 'settings' | 'openMailbox' | 'shortcuts' | 'about' | 'signOut';

/** Entries of the avatar (profile) menu; on the narrow bottom bar it also offers the bell and the gear. */
export function profileMenuItems(narrow: boolean): ProfileMenuId[] {
  const base: ProfileMenuId[] = ['openMailbox', 'shortcuts', 'about', 'signOut'];
  return narrow ? ['notifications', 'settings', ...base] : base;
}

/** Every entry the profile menu can show (narrow layout). */
export const PROFILE_MENU_ALL: readonly ProfileMenuId[] = profileMenuItems(true);

/** "Über CoreMail": the newest released version of GET /changelog (not "Unreleased"), or null. */
export function latestReleasedVersion(versions: readonly { version: string }[] | null | undefined): string | null {
  return versions?.find((v) => /^\d+\.\d+\.\d+/.test(v.version))?.version ?? null;
}
