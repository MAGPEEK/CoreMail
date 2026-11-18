### Added

- **MAPI over HTTP for classic Outlook (mailbox endpoint)** — new service `mapi-server` (port 3007,
  loopback; the api-gateway forwards `/mapi/*`). Implemented from the public Open Specifications:
  - Envelope: POST `/mapi/emsmdb` with `Connect`, `Execute`, `Disconnect`, `NotificationWait`,
    `PING`; `X-RequestId`/`X-ClientInfo` echoed, `X-ResponseCode`, `X-PendingPeriod`,
    `X-ExpirationInfo`; streamed `PROCESSING`/`PENDING`/`DONE` responses.
  - Sessions: cookies `MapiContext` + `MapiSequence` (rotated per request, replays and concurrent
    requests get "Invalid Sequence"), bound to the credentials they were created with, idle timeout
    30 min, record in Redis (`mapi:ctx:*`), at most 16 per account; credential changes and the MAPI
    switch turned off end them at once; one outstanding NotificationWait per session.
  - Authentication: Basic over HTTPS with the shared mail-protocol check (MFA accounts: app
    passwords, shared lockout, LDAP); the protocol switch `mapi` applies (off by default, 403
    without a password prompt).
  - ROP engine with the server object handle table, `RopBufferTooSmall` and 39 ROPs: logon (own,
    shared and delegated mailboxes), folders (open, create, delete, hierarchy/contents tables), tables
    (columns, sort, restrict, query, seek, position), messages (open, create, save as draft,
    recipients, read flag, delete, move/copy, submit), attachments, streams, properties, named
    properties, notification registration. Sending uses the same rules as SMTP submission and JMAP
    (SMTP recipient and size limits, send quota, sender identity, queue, Sent copy).
  - Limits: requests per mail account (`MAPI_RATE_LIMIT`, default 3000 per `MAPI_RATE_WINDOW_SEC` = 300;
    429 + Retry-After), memory of the open objects per session (`MAPI_SESSION_MEMORY_MB`, 64), 1000
    recipients and 250 attachments per message, 1024 restriction nodes per table filter.
  - `/mapi/nspi` is routed and authenticated (`PING`); the address book follows.
- One storage helper for the limits of a submitted message (`submission-limits.ts`, replaces
  `message-size-limit.ts`): `loadSubmissionLimits()` (global: the stricter max. message size, SMTP
  max. recipients; 60 s cache), `submissionLimitsForUser()` / `checkSubmissionLimits()` (global +
  the user's per-mailbox mail flow values) — used by REST `/mail/send`, JMAP EmailSubmission,
  ActiveSync SendMail / SmartReply / SmartForward and MAPI RopSubmitMessage. JMAP and ActiveSync now
  also refuse more recipients than BCP SMTP *max. recipients* (as SMTP submission already did); the
  webmail applies it below `MAIL_SEND_MAX_RECIPIENTS`.
- MAPI writes announce themselves like every other writer (message store `mailbox:changes`, folder
  list changes) and logons to shared / delegated mailboxes are in the mailbox access audit
  (source `mapi`: open, folder create / delete, message move / delete); a send as / on behalf of
  a Shared Mailbox gets the outbound worker's audit + the box's Sent copy.
- `@coremail/core` `createFixedWindowLimiter()`: the per-key fixed-window counter (Redis with in-process
  fallback) of the api-gateway's per-user limits, now shared with the MAPI server; its in-process
  counter `FixedWindowCounter` is also the counter of the api-gateway's global API limit.
- Storage helpers `storeRawInFolder()` (file raw MIME into a folder: raw object, message-store row,
  attachment rows, counters) and `legacyDnFor()` / `directoryIdFromLegacyDn()` (shared with
  Autodiscover).
- e2e step `mapi`; docs `docs/mapi.md`.

### Changed

- `/mapi/*` is no longer answered 404 by the api-gateway: it is forwarded to the MAPI server (which
  answers 403 for every account until the `mapi` switch is turned on).
- The api-gateway's global API rate limit (per user / per IP) does not count `/mapi`; the MAPI server
  limits per authenticated account instead.
