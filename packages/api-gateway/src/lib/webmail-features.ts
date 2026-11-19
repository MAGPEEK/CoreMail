/**
 * Webmail module switches (9.4) on the REST API — see @coremail/storage
 * webmail-policy.ts and docs/webmail-policies.md.
 *
 * Every session-authenticated request runs through requireAuth; after the
 * Webmail protocol switch, `featureRefusal()` refuses a request whose path
 * belongs to a module that is off for the user: 403
 * `{ code: 'FEATURE_DISABLED', feature }`. Paths without a module (mail,
 * settings, admin API, event stream) cost nothing.
 *
 * Exceptions handled in the routes themselves:
 *  - GET /contacts?q= (compose autocomplete) stays available without the
 *    contacts module and then returns address-list entries only;
 *  - themes and signature defaults inside PUT/PATCH /user/preferences
 *    (routes/user-settings.ts);
 *  - app passwords are served by the auth-service (router/app-passwords.ts);
 *  - profile photo (9.5): only the upload (PUT /user/photo) needs the module —
 *    removing the own photo and seeing other photos stay available.
 */
import type { Request } from 'express';
import {
  effectiveWebmailPolicy, externalImageDecisionFor, featureDisabledBody,
  type ExternalImageDecision, type WebmailFeature, type PolicySubject,
} from '@coremail/storage';

export { featureDisabledBody };

/** API path prefix → module (most specific first). */
const PREFIXES: ReadonlyArray<readonly [string, WebmailFeature]> = [
  ['/api/v1/mail/delegated-mailboxes', 'sharedMailboxes'],
  ['/api/v1/mail/shared-mailboxes', 'sharedMailboxes'],
  ['/api/v1/user/shared-mailboxes', 'sharedMailboxes'],
  ['/api/v1/user/accessible-mailboxes', 'sharedMailboxes'],
  ['/api/v1/mail/recoverable', 'recoverItems'],
  ['/api/v1/calendar', 'calendar'],
  ['/api/v1/contacts', 'contacts'],
  ['/api/v1/tasks', 'tasks'],
  ['/api/v1/notes', 'notes'],
  ['/api/v1/user/rules', 'rules'],
  ['/api/v1/user/signatures', 'signatures'],
  ['/api/v1/user/signature', 'signatures'],
  ['/api/v1/categories', 'categories'],
  ['/api/v1/user/change-password', 'changePassword'],
  ['/api/v1/user/client-config', 'externalClients'],
  ['/api/v1/user/apple-profile', 'externalClients'],
];

function under(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Recover deleted items of a shared / delegated mailbox needs that module too. */
const FOREIGN_RECOVERABLE = /^\/api\/v1\/(user\/shared-mailboxes|mail\/delegated-mailboxes)\/[^/]+\/recoverable(\/|$)/;

/** 9.5: uploading / changing the own profile photo. */
const OWN_PHOTO = '/api/v1/user/photo';

/** w3: sharing an own folder (folder permissions) belongs to the shared-mailboxes module. */
const OWN_FOLDER_PERMISSIONS = /^\/api\/v1\/mail\/folders\/[^/]+\/permissions$/;

/**
 * The modules a request needs (pure; empty = none). `query` matters for one
 * exception: GET /api/v1/contacts with a search term is the compose
 * autocomplete, which works without the contacts module.
 *
 * The path is compared lower-case: Express routes case-insensitively, so
 * `/api/v1/Calendar/events` reaches the calendar router and must need the
 * calendar module too.
 */
export function featuresForRequest(method: string, originalUrl: string | undefined, query: Record<string, unknown> = {}): WebmailFeature[] {
  const path = ((originalUrl ?? '').split('?')[0] ?? '').toLowerCase().replace(/\/+$/, '') || '/';
  const out: WebmailFeature[] = [];
  const hit = PREFIXES.find(([prefix]) => under(path, prefix));
  const autocomplete = method === 'GET' && path === '/api/v1/contacts' && String(query['q'] ?? '').trim().length >= 2;
  if (hit && !autocomplete) out.push(hit[1]);
  if (FOREIGN_RECOVERABLE.test(path)) out.push('recoverItems');
  if (OWN_FOLDER_PERMISSIONS.test(path)) out.push('sharedMailboxes');
  if (path === OWN_PHOTO && method === 'PUT') out.push('profilePhoto');
  return out;
}

/**
 * External-image decision for a mail the request's user reads. An unreadable
 * policy falls back to 'ask' (nothing loads by itself; the image proxy checks
 * the policy again) instead of failing the message.
 */
export async function imageDecisionFor(subject: PolicySubject, fromAddr: string, warn: (err: unknown) => void): Promise<ExternalImageDecision> {
  try {
    return await externalImageDecisionFor(subject, fromAddr);
  } catch (err) {
    warn(err);
    return 'ask';
  }
}

export interface FeatureRefusal {
  status: 403 | 503;
  body: Record<string, unknown>;
}

/**
 * null when the request may proceed, else the answer: 403 FEATURE_DISABLED, or
 * 503 when the policy cannot be read (fails closed).
 */
export async function featureRefusal(
  subject: PolicySubject,
  req: Pick<Request, 'method' | 'originalUrl' | 'query'>,
  load: (s: PolicySubject) => ReturnType<typeof effectiveWebmailPolicy> = effectiveWebmailPolicy,
): Promise<FeatureRefusal | null> {
  const needed = featuresForRequest(req.method, req.originalUrl, (req.query ?? {}) as Record<string, unknown>);
  if (needed.length === 0) return null;
  let features;
  try {
    features = (await load(subject)).features;
  } catch {
    return { status: 503, body: { error: 'Service temporarily unavailable' } };
  }
  const off = needed.find((f) => !features[f]);
  return off ? { status: 403, body: featureDisabledBody(off) } : null;
}
