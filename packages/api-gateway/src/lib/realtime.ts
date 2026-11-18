/**
 * Realtime announcements of the REST writers (9.4).
 *
 *   announceOnWrite(event)   router middleware: after every successful
 *                            POST/PUT/PATCH/DELETE the acting user's other tabs
 *                            and devices hear about it
 *   announceUserSettings     /api/v1/user: settings writes by area
 *
 * Calendar data (owner + grantees) and folder lists use the storage helpers
 * announceCalendarChange / announceFolderListChange; message changes need
 * nothing (the message store publishes them).
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { SettingsSection, UserEvent, UserEventAction } from '@coremail/core';
import { announceUserEvent } from '@coremail/storage';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** HTTP method → event action. */
export function actionOf(method: string): UserEventAction {
  if (method === 'POST') return 'create';
  if (method === 'DELETE') return 'delete';
  return 'update';
}

/** One successful write as the middleware saw it on entry. */
export interface WriteInfo { method: string; path: string }

/**
 * Router middleware: after a successful write, announce `event` (or what the
 * function derives from the write; null = nothing) to the acting user.
 */
export function announceOnWrite(event: UserEvent | ((write: WriteInfo) => UserEvent | null)): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (MUTATING.has(req.method)) {
      // captured now: Express rewrites req.path while descending into sub-routers
      const write: WriteInfo = { method: req.method, path: req.path };
      res.on('finish', () => {
        const userId = req.apiUser?.userId;
        if (!userId || res.statusCode >= 400) return;
        const e = typeof event === 'function' ? event(write) : { action: actionOf(write.method), ...event };
        if (e) announceUserEvent(userId, e);
      });
    }
    next();
  };
}

/**
 * Settings area of a /api/v1/user write (pure). Paths that change something
 * other than settings (passwords, folders, messages) return null.
 */
export function settingsSectionOf(path: string): SettingsSection | null {
  if (path === '/profile') return 'profile';
  if (path === '/signature') return 'signature';
  if (path === '/oof') return 'oof';
  if (path === '/preferences') return 'preferences';
  if (path === '/rules' || path.startsWith('/rules/')) return path.endsWith('/run-now') ? null : 'rules';
  if (path.startsWith('/accessible-mailboxes/')) return 'mailboxes';
  return null;
}

/** /api/v1/user middleware: settings writes reach the user's other tabs and devices. */
export const announceUserSettings: RequestHandler = announceOnWrite(({ path }) => {
  const section = settingsSectionOf(path);
  return section ? { type: 'settings', section } : null;
});
