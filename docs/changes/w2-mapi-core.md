### Added

- **MAPI over HTTP for classic Outlook (mailbox endpoint)** — new service `mapi-server` (port 3007,
  loopback; the api-gateway forwards `/mapi/*`). Implemented from the public Open Specifications:
  - Envelope: POST `/mapi/emsmdb` with `Connect`, `Execute`, `Disconnect`, `NotificationWait`,
    `PING`; `X-RequestId`/`X-ClientInfo` echoed, `X-ResponseCode`, `X-PendingPeriod`,
    `X-ExpirationInfo`; streamed `PROCESSING`/`PENDING`/`DONE` responses.
  - Sessions: cookies `MapiContext` + `MapiSequence` (rotated per request, replays and concurrent
    requests get "Invalid Sequence"), bound to the credentials they were created with, idle timeout
    30 min, record in Redis (`mapi:ctx:*`), at most 16 per account; credential changes and the MAPI
    switch turned off end them at once.
  - Authentication: Basic over HTTPS with the shared mail-protocol check (MFA accounts: app
    passwords, shared lockout, LDAP); the protocol switch `mapi` applies (off by default, 403
    without a password prompt).
  - ROP engine with the server object handle table, `RopBufferTooSmall` and 39 ROPs: logon (own,
    shared and delegated mailboxes), folders (open, create, delete, hierarchy/contents tables), tables
    (columns, sort, restrict, query, seek, position), messages (open, create, save as draft,
    recipients, read flag, delete, move/copy, submit), attachments, streams, properties, named
    properties, notification registration. Sending uses the same rules as SMTP submission and JMAP
    (send quota, sender identity, queue, Sent copy).
  - `/mapi/nspi` is routed and authenticated (`PING`); the address book follows.
- Storage helpers `storeRawInFolder()` (file raw MIME into a folder: raw object, message-store row,
  attachment rows, counters) and `legacyDnFor()` / `directoryIdFromLegacyDn()` (shared with
  Autodiscover).
- e2e step `mapi`; docs `docs/mapi.md`.

### Changed

- `/mapi/*` is no longer answered 404 by the api-gateway: it is forwarded to the MAPI server (which
  answers 403 for every account until the `mapi` switch is turned on).
