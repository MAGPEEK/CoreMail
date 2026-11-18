/**
 * 9.4 webmail policies — what the administrator switched on for this account
 * (GET /api/v1/user/features) and the pure visibility logic the UI applies:
 * rail entries, routes, settings sections, attachments, external images. The
 * server enforces every switch itself; hiding only keeps the UI honest.
 * Only type imports — unit-tested with `node --test`.
 */
import type { AppId } from './appRail.ts';

export const WEBMAIL_FEATURES = [
  'calendar', 'contacts', 'tasks', 'notes', 'rules', 'signatures', 'categories', 'recoverItems',
  'changePassword', 'themes', 'externalClients', 'appPasswords', 'sharedMailboxes',
] as const;
export type WebmailFeature = typeof WEBMAIL_FEATURES[number];
export type WebmailFeatures = Record<WebmailFeature, boolean>;

export type ExternalImageMode = 'ask' | 'contacts' | 'block';

export interface ContentPolicy {
  blockedExtensions: string[];
  downloadOnlyExtensions: string[];
  /** Max. size of one attachment in bytes; null = only the message size limit. */
  maxUploadBytes: number | null;
  externalImages: ExternalImageMode;
}

/** GET /api/v1/user/features. */
export interface FeaturesResponse {
  features: WebmailFeatures;
  content: ContentPolicy;
}

/** TanStack Query key (lib/realtimeEvents.ts refreshes it on `settings` / `policies`). */
export const FEATURES_QUERY_KEY = ['webmail-features'] as const;

/** Until the answer is there: today's behaviour (everything on, nothing blocked). */
export const DEFAULT_FEATURES: FeaturesResponse = Object.freeze({
  features: Object.freeze(Object.fromEntries(WEBMAIL_FEATURES.map((f) => [f, true])) as WebmailFeatures),
  content: Object.freeze({ blockedExtensions: [], downloadOnlyExtensions: [], maxUploadBytes: null, externalImages: 'ask' as const }),
}) as FeaturesResponse;

/** The module behind an app of the rail (mail has none). */
const APP_FEATURES: Partial<Record<AppId, WebmailFeature>> = {
  calendar: 'calendar', contacts: 'contacts', tasks: 'tasks', notes: 'notes',
};

export function isAppEnabled(app: AppId, features: WebmailFeatures): boolean {
  const f = APP_FEATURES[app];
  return f === undefined || features[f];
}

/** The module of a route path (`/calendar/…` → calendar), or null. */
export function featureForPath(pathname: string): WebmailFeature | null {
  const first = pathname.split('/').filter(Boolean)[0] ?? '';
  if (first === 'shared-mailbox') return 'sharedMailboxes';
  return APP_FEATURES[first as AppId] ?? null;
}

/** Settings sections that belong to a module (section ids of pages/SettingsPage.tsx). */
const SECTION_FEATURES: Readonly<Record<string, WebmailFeature>> = {
  rules: 'rules',
  signature: 'signatures',
  categories: 'categories',
  recover: 'recoverItems',
  password: 'changePassword',
  theme: 'themes',
  externalClients: 'externalClients',
  appPasswords: 'appPasswords',
  calendar: 'calendar',
};

export function isSettingsSectionVisible(section: string, features: WebmailFeatures): boolean {
  const f = SECTION_FEATURES[section];
  return f === undefined || features[f];
}

// ── Attachments ──────────────────────────────────────────────────────────────

/** Extension of a file name (trailing dots / spaces ignored, like the server). */
export function fileExtension(filename: string): string {
  const name = filename.replace(/[\s.]+$/, '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * How the attachment list shows a file: `blocked` (no download), `save`
 * (download only, never previewed) or `open`. By name only — the server also
 * checks the declared type and the content and has the last word.
 */
export function attachmentAccess(filename: string, policy: ContentPolicy): 'blocked' | 'save' | 'open' {
  const ext = fileExtension(filename);
  if (!ext) return 'open';
  if (policy.blockedExtensions.includes(ext)) return 'blocked';
  return policy.downloadOnlyExtensions.includes(ext) ? 'save' : 'open';
}

/** True when an inline (cid:) image may be shown in the mail body. */
export function inlinePreviewAllowed(att: { filename?: string | null }, policy: ContentPolicy): boolean {
  return attachmentAccess(att.filename ?? '', policy) === 'open';
}

/** The first file over the per-attachment limit, or null. */
export function oversizedAttachment<T extends { size: number }>(files: readonly T[], maxBytes: number | null): T | null {
  if (maxBytes === null) return null;
  return files.find((f) => f.size > maxBytes) ?? null;
}

// ── External images ──────────────────────────────────────────────────────────

/** The server's decision for one mail (GET message → `externalImages`). */
export type ExternalImageDecision = 'load' | 'ask' | 'block';

export function parseImageDecision(v: unknown): ExternalImageDecision {
  return v === 'load' || v === 'block' ? v : 'ask';
}

/** Whether the external images of a mail are shown, given the decision and the reader's click. */
export function showExternalImages(decision: ExternalImageDecision, clicked: boolean): boolean {
  if (decision === 'block') return false;
  return decision === 'load' || clicked;
}
