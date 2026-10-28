# JMAP in CoreMail

Since **v5.7.1**, CoreMail includes a JMAP server (`packages/jmap-server/`, port 3006),
reachable through the api-gateway at `/jmap/*` and `/.well-known/jmap`.
JMAP (JSON Meta Application Protocol) is the IETF standard for accessing
mailboxes over HTTPS/JSON and replaces IMAP + SMTP submission for modern clients.

## Implemented RFCs

| RFC | Scope | Capability |
|-----|--------|------------|
| [8620](https://www.rfc-editor.org/rfc/rfc8620) | Core: session, request/response, `/get` `/changes` `/set` `/query`, blobs, push | `urn:ietf:params:jmap:core` |
| [8621](https://www.rfc-editor.org/rfc/rfc8621) | Mail: Mailbox, Thread, Email, SearchSnippet, Identity, EmailSubmission, VacationResponse | `urn:ietf:params:jmap:mail`, `…:submission`, `…:vacationresponse` |
| [8887](https://www.rfc-editor.org/rfc/rfc8887) | JMAP over WebSocket | `urn:ietf:params:jmap:websocket` |
| [9404](https://www.rfc-editor.org/rfc/rfc9404) | Blob management (`Blob/upload`, `Blob/get`, `Blob/lookup`) | `urn:ietf:params:jmap:blob` |
| [9425](https://www.rfc-editor.org/rfc/rfc9425) | Quotas | `urn:ietf:params:jmap:quota` |
| [9670](https://www.rfc-editor.org/rfc/rfc9670) | Sharing: Principal, ShareNotification | `urn:ietf:params:jmap:principals`, `…:principals:owner` |
| [9749](https://www.rfc-editor.org/rfc/rfc9749) | VAPID for Web Push | `urn:ietf:params:jmap:webpush-vapid` |

## Endpoints

| Method/path | Purpose |
|--------------|-------|
| `GET /.well-known/jmap` | Discovery, 301 → `/jmap/session` |
| `GET /jmap/session` | Session resource (capabilities, accounts, URLs, `state`) |
| `POST /jmap/api` | Method calls, `Content-Type: application/json`, max. 10 MB, 64 calls |
| `POST /jmap/upload/{accountId}/` | Blob upload (max. 50 MB) → `{ accountId, blobId, type, size }` |
| `GET /jmap/download/{accountId}/{blobId}/{name}?accept=` | Blob download |
| `GET /jmap/eventsource?types=*&closeafter=no&ping=30` | Push (Server-Sent Events) |
| `GET /jmap/ws` (Upgrade) | JMAP over WebSocket, subprotocol `jmap` |

All paths except `/.well-known/jmap` require authentication.

## Architecture

```
JMAP client (web app, Thunderbird, Ltt.rs, curl)
   │  HTTPS: POST /jmap/api · GET /jmap/eventsource · WSS /jmap/ws
   ▼
api-gateway (port 3000, optional TLS proxy 443)
   │  Proxies /jmap/* and /.well-known/jmap, WebSocket upgrade passed through
   ▼
jmap-server (port 3006)
   ├─ auth.ts          Basic (app password) / Bearer (session JWT), 60s cache
   ├─ accounts.ts      own mailbox · shared-<id> · delegated mailboxes
   ├─ dispatcher.ts    request → method calls, result references, errors
   ├─ methods/         Mailbox · Email · Thread · Identity · EmailSubmission ·
   │                   SearchSnippet · VacationResponse · Quota · Blob ·
   │                   Principal/ShareNotification · PushSubscription
   ├─ mail/            Message ↔ Email mapper, RFC 5322 raw data, keywords, threads
   └─ push/            Redis bus → EventSource · WebSocket · Web Push (VAPID)
   │
   ├─ PostgreSQL (Prisma)   Folder / Message / Attachment / User / SharedMailbox …
   ├─ MinIO                 raw messages, attachments, upload blobs (jmap-upload/, 7 days)
   ├─ Redis                 mail:new / mail:update, settings:reload, EmailSubmission objects
   └─ BullMQ smtp-outbound  sending (same path as SMTP submission and webmail)
```

JMAP is an additional view of the same data as IMAP and the webmail — there is
no second mail database. A change made via JMAP (flag, move, draft) is
immediately visible in IMAP clients and in the MWA, and vice versa.

## Authentication

- **Basic**: `email:password`. With MFA enabled, only an **app password** is valid
  (MWA → Settings → Security → App passwords). LDAP/OIDC accounts without a local
  hash are verified through the auth-service.
- **Bearer**: session JWT from `POST /auth/login` (for MWA/web apps). For EventSource
  and WebSocket, which cannot set headers, also as `?access_token=…`.

## Accounts

| accountId | Mailbox | Rights |
|-----------|----------|--------|
| `<userId>` | own mailbox | full |
| `shared-<id>` | Shared Mailbox | `FULL_ACCESS` → writable, `READ_ONLY` → `isReadOnly` |
| `<ownerUserId>` | delegated mailbox (MailboxDelegate) | according to the delegation right |

`primaryAccounts` points to the own mailbox for mail/submission/quota/blob/principals.

## Data model mapping

| JMAP | CoreMail |
|------|----------|
| Mailbox | `Folder`; `role` derived from the folder name (`INBOX`→inbox, `Drafts`, `Sent`, `Trash`, `Junk`, `Archive`) |
| Email | `Message` (+ `Attachment`); `blobId = m-<id>`; an email lives in **exactly one** folder |
| keywords | IMAP flags: `$seen`↔`\Seen`, `$flagged`↔`\Flagged`, `$answered`, `$draft`, `$forwarded` |
| Thread | `Message.threadId` (lazy: `inReplyTo` → known message → its thread) |
| Identity | primary address `u-<userId>`, aliases `al-<id>`, Shared Mailbox with SEND_AS `sm-<id>`; signature from the MWA settings |
| EmailSubmission | Redis (7 days); sending via the BullMQ queue `smtp-outbound`; `sendAt` in the future → delayed, `undoStatus: canceled` cancels |
| VacationResponse | `UserSettings.oof*` (out of office) |
| Quota | `quotaBytes` / `usedBytes` (user or Shared Mailbox), resource `octets` |
| Principal | active users (`individual`), Shared Mailboxes (`group`) |
| PushSubscription | table `jmap_push_subscriptions`, verification via `PushVerification` POST |

## State strings

- **Email/Thread**: `<maxModSeq>.<highestModSeq>.<maxCreatedMs>.<count>` — captures both
  REST/JMAP changes (`modSeq = Date.now()`) and SMTP/IMAP counters.
- **Mailbox**: `<count>.<maxCreatedMs>.<hash>`.
- Deleted objects have no tombstones. After a hard delete, `/changes` returns
  `cannotCalculateChanges`; the client reloads the list (RFC-compliant).
- `*/queryChanges` is not implemented (`cannotCalculateChanges`).

## Push

- **EventSource**: `event: state` with a `StateChange` object (`Email`, `Thread`, `Mailbox`),
  `event: ping` at the chosen interval, `closeafter=state` terminates after the first event.
- **WebSocket**: `{"@type":"Request",…}` → `{"@type":"Response",…}`; `WebSocketPushEnable`
  enables `StateChange` messages; errors as `RequestError`.
- **Web Push**: verified `PushSubscription`s receive `StateChange` encrypted
  (RFC 8291) with a VAPID signature when `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are set.
  The public key is in the session under `urn:ietf:params:jmap:webpush-vapid`.

The source of changes is the Redis channel `mail:new` / `mail:update`, which SMTP inbound,
the REST API and the jmap-server itself feed — this keeps MWA and JMAP clients in sync.

## Setup

1. **Switch**: BCP → Server → "JMAP" card (default: on). Off → `/jmap/*` returns 404;
   the switch takes effect without a restart.
2. **Hostname**: The session URLs are built from BCP → Server → hostname/HTTPS/port.
3. **DNS (optional, RFC 8620 §2.2)**: `_jmap._tcp.example.com. SRV 0 1 443 mail.example.com.`
4. **Reverse proxy**: For `/jmap/ws` the proxy must pass WebSocket upgrades through
   (`Upgrade`/`Connection` headers). The integrated TLS proxy already does this.
5. **Environment variables** (set in `docker-compose.yml`): `JMAP_PORT=3006`,
   `JMAP_SERVICE_URL=http://localhost:3006`; optionally `VAPID_*`.

## Quick test

See [Examples with curl](#examples-with-curl).

## Setting up clients

Prerequisites: `https://mail.example.com/.well-known/jmap` is reachable from outside
(DNS + certificate), and accounts with MFA have an **app password** (MWA →
Settings → Security → App passwords).

| Client | Setup |
|--------|-------------|
| **Ltt.rs** (Android, open source) | Add account → email address + app password. The app discovers the server via `/.well-known/jmap`. If the hostname cannot be derived from the domain, enter the session URL `https://mail.example.com/jmap/session` manually. |
| **Thunderbird** | JMAP support in Thunderbird is in progress and not included in all versions. Check under *Add account* in your version whether "JMAP" is offered as an account type; otherwise use IMAP. |
| **Your own web app** (`jmap-client`, `jmap-js`, Fastmail `jmap-client-ts`) | `sessionUrl: 'https://mail.example.com/jmap/session'`, auth header `Authorization: Bearer <JWT>` from `POST /auth/login` or `Basic`. CORS is enabled for `/jmap/*`. |
| **Scripts / automation** | `curl` with Basic auth, see examples below. |

The server announces what it supports in the session (`capabilities`) — clients that do
not know an extension ignore it.

## Examples with curl

All examples use `U=user@example.com:APP-PASSWORD` and `H=https://mail.example.com`.
`ACCOUNT` is the `accountId` from the session (`primaryAccounts["urn:ietf:params:jmap:mail"]`).

**Read the session**
```bash
curl -s -u "$U" "$H/jmap/session" | jq '{username, primaryAccounts, accounts: (.accounts | keys)}'
```

**Folders and the 10 newest mails in the inbox**
```bash
curl -s -u "$U" -H 'Content-Type: application/json' "$H/jmap/api" -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [
    ["Mailbox/get", { "accountId": "ACCOUNT", "ids": null,
       "properties": ["id", "name", "role", "totalEmails", "unreadEmails"] }, "m"],
    ["Email/query", { "accountId": "ACCOUNT",
       "filter": { "inMailbox": "INBOX-ID" },
       "sort": [{ "property": "receivedAt", "isAscending": false }], "limit": 10 }, "e"],
    ["Email/get", { "accountId": "ACCOUNT",
       "#ids": { "resultOf": "e", "name": "Email/query", "path": "/ids" },
       "properties": ["subject", "from", "receivedAt", "preview", "keywords"] }, "g"]
  ]}' | jq .
```
(Insert `INBOX-ID` from the `Mailbox/get` result — the folder with `"role": "inbox"`.)

**Mark as read and move to the trash**
```bash
curl -s -u "$U" -H 'Content-Type: application/json' "$H/jmap/api" -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [[ "Email/set", { "accountId": "ACCOUNT", "update": {
    "EMAIL-ID": { "keywords/$seen": true, "mailboxIds": { "TRASH-ID": true } } } }, "s" ]]}'
```

**Send a mail (create draft → submit → move to "Sent")**
```bash
curl -s -u "$U" -H 'Content-Type: application/json' "$H/jmap/api" -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
  "methodCalls": [
    ["Identity/get", { "accountId": "ACCOUNT" }, "i"],
    ["Email/set", { "accountId": "ACCOUNT", "create": { "draft": {
        "mailboxIds": { "DRAFTS-ID": true }, "keywords": { "$draft": true, "$seen": true },
        "from": [{ "name": "John Doe", "email": "user@example.com" }],
        "to":   [{ "email": "recipient@example.org" }],
        "subject": "Hello via JMAP",
        "textBody": [{ "partId": "t", "type": "text/plain" }],
        "bodyValues": { "t": { "value": "This mail was sent via JMAP." } } } } }, "d"],
    ["EmailSubmission/set", { "accountId": "ACCOUNT",
        "create": { "sub": { "identityId": "u-USER-ID", "emailId": "#draft" } },
        "onSuccessUpdateEmail": { "#sub": {
          "mailboxIds/DRAFTS-ID": null, "mailboxIds/SENT-ID": true, "keywords/$draft": null } } }, "x"]
  ]}' | jq .
```
The `identityId` (`u-<userId>`, `al-<aliasId>`, `sm-<sharedId>`) is returned by `Identity/get`.
The From header must match the identity (`forbiddenFrom`). With `"sendAt": "2026-11-01T08:00:00Z"`
sending is delayed; `EmailSubmission/set` with `update: { "<id>": { "undoStatus": "canceled" } }`
cancels as long as `undoStatus` is still `pending`.

**Upload an attachment and send it along**
```bash
BLOB=$(curl -s -u "$U" -H 'Content-Type: application/pdf' --data-binary @quote.pdf \
  "$H/jmap/upload/ACCOUNT/" | jq -r .blobId)
# … then in the Email/set create: "attachments": [{ "blobId": "'$BLOB'", "type": "application/pdf", "name": "quote.pdf" }]
```

**Push via EventSource**
```bash
curl -N -s -u "$U" "$H/jmap/eventsource?types=Email,Mailbox&closeafter=no&ping=30"
# event: state
# data: {"@type":"StateChange","changed":{"ACCOUNT":{"Email":"…","Thread":"…","Mailbox":"…"}}}
```

**Push via WebSocket** (e.g. with `websocat`)
```bash
websocat --protocol jmap -H "Authorization: Basic $(printf %s "$U" | base64)" "wss://mail.example.com/jmap/ws"
{"@type":"WebSocketPushEnable","dataTypes":["Email","Mailbox"]}
{"@type":"Request","id":"1","using":["urn:ietf:params:jmap:core"],"methodCalls":[["Core/echo",{"hello":"jmap"},"c"]]}
```

**Blob contents via method (RFC 9404) and quota (RFC 9425)**
```bash
curl -s -u "$U" -H 'Content-Type: application/json' "$H/jmap/api" -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:blob", "urn:ietf:params:jmap:quota"],
  "methodCalls": [
    ["Blob/get",  { "accountId": "ACCOUNT", "ids": ["m-EMAIL-ID"], "properties": ["size", "digest:sha-256"] }, "b"],
    ["Quota/get", { "accountId": "ACCOUNT" }, "q"]
  ]}' | jq .
```

## FAQ

**`/jmap/session` returns 404.** JMAP is switched off in the BCP (Server → "JMAP") or the
reverse proxy does not forward `/jmap/*` or `/.well-known/jmap` to CoreMail.

**401 despite the correct password.** MFA is enabled for the account — JMAP then accepts only
app passwords. LDAP/OIDC accounts without a local hash are verified through the auth-service;
check its reachability in the log (`jmap:auth`).

**The client reports `cannotCalculateChanges`.** Intended: after a hard delete or with an
invalid `sinceState` the server knows no delta and the client reloads the list.
JMAP clients handle this by default.

**WebSocket does not connect, EventSource does.** The upstream proxy (Traefik, Caddy,
nginx, DSM) must pass `Upgrade`/`Connection` through for `/jmap/ws`. CoreMail's integrated
TLS proxy already does this.

**Where are Shared Mailboxes?** As separate accounts in the session (`shared-<id>`), as soon as
the user has `FULL_ACCESS` or `READ_ONLY`. Send as a Shared Mailbox via the identity
`sm-<id>` (requires `SEND_AS` or `FULL_ACCESS`).

**Why do I see the same changes immediately in the webmail?** JMAP writes to the same
tables and publishes `mail:update` on Redis — the same source the MWA uses via SSE
and the jmap-server uses for push.

**Can I read calendars and contacts via JMAP?** Not yet. JMAP for Calendars/Contacts
(JSCalendar/JSContact) are not included; CalDAV/CardDAV remain responsible for that.

**Difference from IMAP?** One HTTPS endpoint instead of two protocols (IMAP + SMTP), JSON
instead of a text protocol, batched calls, real push instead of IDLE/polling, and a
state model (`state`) that lets clients synchronize efficiently.

## Limitations (as of v5.7.1)

- `Email/query`: filters `header`, `allInThreadHaveKeyword` and similar → `unsupportedFilter`;
  sorting by `to` → `unsupportedSort`. Maximum 10,000 hits per query.
- `bodyStructure` is synthesized from the stored fields
  (text/plain, text/html, attachments) — not a 1:1 image of nested MIME trees.
- `Mailbox` does not allow role changes; system folders cannot be deleted.
- `ShareNotification` is not generated yet (empty lists).
- Calendars/contacts via JMAP (JSCalendar/JSContact) are not included — CalDAV/CardDAV
  remain responsible for that.
