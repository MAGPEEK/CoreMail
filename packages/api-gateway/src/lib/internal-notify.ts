/**
 * Internal Notification Helper (v3.18.16) — moved to @coremail/storage in v8.1
 * (internal-notify.ts) so the smtp-server can deliver quota warnings with it.
 * Re-exported here for the existing api-gateway callers.
 */
export { notifyUserInbox, notifyMailboxInbox, type InternalNotifyOpts, type InternalNotifyContent } from '@coremail/storage';
