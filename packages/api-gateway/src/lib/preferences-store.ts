/**
 * 9.4: reads and writes UserSettings.preferences (lib/user-preferences.ts).
 *
 * Writes are read-modify-write on one JSON column; concurrent PATCHes (two tabs,
 * two devices) are serialized optimistically on `updatedAt` so no field update is
 * lost. A missing row is created; a create race (unique userId) is retried.
 */
import { prisma } from '@coremail/storage';
import {
  applyPreferencesPatch, readPreferences, type PreferencesPatch, type UserPreferences,
} from './user-preferences.js';

const MAX_ATTEMPTS = 5;

export async function loadPreferences(userId: string): Promise<UserPreferences> {
  const row = await prisma.userSettings.findUnique({ where: { userId }, select: { preferences: true } });
  return readPreferences(row?.preferences);
}

export interface SaveOptions {
  /**
   * One-time import of browser values: applied only while nothing was written
   * yet (`migratedAt` null) — afterwards the server copy wins.
   */
  onlyIfUnmigrated?: boolean;
}

export interface SaveResult {
  preferences: UserPreferences;
  /** false when `onlyIfUnmigrated` found already written preferences. */
  applied: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

export async function savePreferencesPatch(userId: string, patch: PreferencesPatch, opts: SaveOptions = {}): Promise<SaveResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await prisma.userSettings.findUnique({ where: { userId }, select: { preferences: true, updatedAt: true } });
    const current = readPreferences(row?.preferences);
    if (opts.onlyIfUnmigrated && current.migratedAt) return { preferences: current, applied: false };
    const next = applyPreferencesPatch(current, patch);
    const json = next as unknown as object;
    if (!row) {
      try {
        await prisma.userSettings.create({ data: { userId, preferences: json } });
        return { preferences: next, applied: true };
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    const { count } = await prisma.userSettings.updateMany({
      where: { userId, updatedAt: row.updatedAt },
      data: { preferences: json },
    });
    if (count === 1) return { preferences: next, applied: true };
  }
  throw new Error('Preferences update conflict — please retry');
}
