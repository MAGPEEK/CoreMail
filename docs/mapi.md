# MAPI over HTTP (classic Outlook)

Since 9.4 CoreMail serves MAPI over HTTP, the protocol classic Win32 Outlook uses for an account of
the "Exchange" type. It is implemented from the public Microsoft Open Specifications
(MS-OXCMAPIHTTP, MS-OXCRPC, MS-OXCROPS, MS-OXCDATA, MS-OXCSTOR, MS-OXCFOLD, MS-OXCTABL, MS-OXCMSG,
MS-OXCPRPT, MS-OXPROPS) in the service `packages/mapi-server` (port 3007, loopback only). The
api-gateway forwards `/mapi/*` to it.

**Status:** the mailbox endpoint works (connect, log on, folders, tables, reading, composing,
sending). The address book endpoint (`/mapi/nspi`), push notifications, Autodiscover announcement
and NTLM/Negotiate authentication follow in the next package — until then Outlook cannot create an
Exchange profile on its own; the endpoint is meant for testing with MAPI clients.

## Enable it

MAPI is off by default. It is the protocol switch `mapi` (see [protocol-access.md](protocol-access.md)):

```bash
coremail protocol set --scope user alice@example.com --mapi on    # one mailbox
coremail protocol set --scope domain example.com --mapi on         # a domain
coremail protocol set --mapi on                                    # the whole server
```

or in the BCP (*Protokolle & Dienste*, *Domain bearbeiten*, mailbox dialog). With the switch
off the endpoint answers 403 (no password prompt) after a correct password; turning it off ends the
running MAPI sessions of the affected accounts at once.

Clients reach `https://<host>/mapi/emsmdb/` (mailbox) and `https://<host>/mapi/nspi/` (address book).
Basic authentication is accepted over HTTPS only (a connection the gateway verified as plain HTTP is
refused); set `MAPI_ALLOW_PLAIN_HTTP=true` only for test setups. Accounts with MFA use an app password,
as on every mail protocol.

Refusals before a session exists:

| Situation | HTTP | X-ResponseCode | Notes |
|-----------|------|----------------|-------|
| No / wrong credentials | 401 + `WWW-Authenticate: Basic` | 8 Anonymous Not Allowed | the only answer that makes Outlook ask for the password |
| MAPI switched off, plain HTTP | 403 | 11 No Privilege | |
| Per-account request limit (`MAPI_RATE_LIMIT`), account locked by the shared mail-login lockout, temporary failure | 503 + `Retry-After` | 1 Unknown Failure | MS-OXCMAPIHTTP has no throttling code (2.2.3.3.3) and reserves non-200 statuses for authentication and exceptional conditions (2.2.2.2): throttling is a 5xx with `Retry-After`, never 401 (no password prompt) and never a misused X-ResponseCode |

## What works

| Area | Details |
|------|---------|
| Envelope | POST only; `X-RequestType` `Connect`, `Execute`, `Disconnect`, `NotificationWait`, `PING`; `X-RequestId` / `X-ClientInfo` echoed; `X-ResponseCode`, `X-PendingPeriod`, `X-ExpirationInfo`, `X-ServerApplication`; streamed `PROCESSING` / `PENDING` / `DONE` with `X-ElapsedTime` and `X-StartTime` |
| Sessions | Cookies `MapiContext` (session) and `MapiSequence` (rotated per Execute/Disconnect: a replayed or concurrent request gets 15 "Invalid Sequence"); the session is bound to the credentials it was created with (else 10 "Context Not Found"; PING refreshes only the caller's own session); idle timeout 30 min (`MAPI_SESSION_IDLE_MS`); at most 16 sessions per account; one outstanding NotificationWait per session (a newer one ends the older with EventPending 0); a failure after `PROCESSING` still ends with `DONE` and X-ResponseCode 1 |
| Execute | RPC_HEADER_EXT payloads, also XOR-obfuscated and LZ77/DIRECT2-compressed requests; responses uncompressed; output limited to `MaxRopOut` and 32 KB, `RopBufferTooSmall` when a response does not fit |
| Logon | Own mailbox; shared and delegated mailboxes the account may read (Essdn = their legacy DN), read-only ones refuse writes |
| Folders | Root, Top of Information Store, Outbox and the other special folders, the CoreMail folders below; open, create (subfolders `Parent.Name`), delete (mail moves to Deleted Items; default folders cannot be deleted), hierarchy tables (with depth) |
| Tables | `SetColumns`, `SortTable`, `Restrict` (and/or/not, content, property, compare, bitmask, size, exist), `QueryRows` (forward/backward), `SeekRow`, `QueryPosition` |
| Messages | Open (recipients, subject), properties (specific/all, large values via streams), read flag, delete (tombstones, recoverable 30 days), move/copy (also between logons), attachments (table, open, create, save) |
| Streams | Read the plain-text and HTML body and attachment data; write bodies and attachment data of new messages |
| Composing | `CreateMessage` in Drafts (saved as a draft, visible to every client) or in the Outbox (kept in the session), `SetProperties`, `ModifyRecipients` (SMTP addresses, X500 DNs of CoreMail accounts), `SaveChangesMessage`, `SubmitMessage` |
| Sending | Same rules as webmail, SMTP submission, JMAP and ActiveSync: the submission limits of the user (storage `submissionLimitsForUser` — recipients: BCP SMTP *max. recipients* → `ecTooManyRecips`; size: the stricter max. message size → `ecMaxSubmissionExceeded`, also reported as `PidTagMaximumSubmitMessageSize`; a per-mailbox value of the user's mail flow policy replaces either), send quota, sender identity (own address, aliases, shared mailboxes with Send As / Full Access), queue `smtp-outbound`, copy in Sent Items unless `PidTagDeleteAfterSubmit`, the draft is removed; folder associated messages are never sent |
| Named properties | `GetPropertyIdsFromNames` / `GetNamesFromPropertyIds` (registered IDs from 0x8001, stable per mailbox while the service runs; PS_MAPI LIDs are the property ID; only internet header names are case-insensitive; a read-only mailbox registers nothing; no names on the store object lists every ID) |

## Limits

- Unknown ROPs fail the whole Execute with `ecRpcFormat` (as the specification requires) — Outlook
  operations that need further ROPs (cached mode / ICS synchronisation, rules, permissions, search
  folders, `ReadRecipients`, `GetPropertiesList`, bookmarks …) do not work yet.
- No address book yet (`/mapi/nspi` answers 16 "Endpoint Disabled" except `PING`), so recipients must
  be SMTP addresses; no NotificationWait events (the request ends after 5 minutes without events);
  Autodiscover does not announce MAPI yet.
- Bodies are plain text and HTML (no RTF); categorized views are returned flat.
- Properties CoreMail has no column for (flags, categories, custom properties of received mail) are
  accepted but not stored; saving an opened received message does not change it.
- Named property IDs are kept in memory (per mailbox, per service process).
- Requests are limited per mail account (`MAPI_RATE_LIMIT` requests per `MAPI_RATE_WINDOW_SEC`, default
  3000 per 5 minutes; above it HTTP 503 with `Retry-After`). The api-gateway's global API limit (per user / per IP,
  [api-gateway-security.md](api-gateway-security.md)) does not count `/mapi` (Outlook is chatty and clients often share a NAT address); password guessing stays
  bounded by the shared mail-login lockout.
- Each session holds its open messages, attachments and streams in memory, at most
  `MAPI_SESSION_MEMORY_MB` (64) — beyond it writes fail (`STG_E_MEDIUMFULL` / `ecMAPIOOM`); a single
  stream holds at most 32 MB; a message at most 250 attachments (`ecMaxAttachmentExceeded` at `RopCreateAttachment`) and
  10 000 recipients (`ecTooManyRecips` at `RopSubmitMessage`; `RopModifyRecipients` has no count error,
  the session memory budget bounds it); a table filter
  at most 1024 restriction nodes (`ecTooComplex`).

## Operations

- Service: supervisord program `mapi-server`; health `GET http://127.0.0.1:3007/health`.
- Environment: `MAPI_PORT` (3007), `MAPI_SESSION_IDLE_MS` (1 800 000), `MAPI_PENDING_MS` (15 000),
  `MAPI_ALLOW_PLAIN_HTTP` (false), `MAPI_RATE_LIMIT` (3000, 0 = off), `MAPI_RATE_WINDOW_SEC` (300),
  `MAPI_SESSION_MEMORY_MB` (64), gateway `MAPI_SERVICE_URL` (`http://localhost:3007`).
- Rate-limit counters: Redis `ratelimit:mapi:<userId>:<window>` (in-process fallback while Redis is down).
- Session records: Redis `mapi:ctx:<sha256(cookie)>` with the idle TTL; the open server objects live
  in the service process, so after a restart clients connect again ("Context Not Found").
- e2e: step `mapi` (`scripts/e2e/steps/mapi.mjs`); the client used by the tests and the e2e step is
  `packages/mapi-server/src/testing/mapi-client.ts`.
