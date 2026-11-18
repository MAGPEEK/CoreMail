# MAPI over HTTP (classic Outlook)

Since 9.4 CoreMail serves MAPI over HTTP, the protocol classic Win32 Outlook uses for an account of
the "Exchange" type. It is implemented from the public Microsoft Open Specifications
(MS-OXCMAPIHTTP, MS-OXCRPC, MS-OXCROPS, MS-OXCDATA, MS-OXCSTOR, MS-OXCFOLD, MS-OXCTABL, MS-OXCMSG,
MS-OXCPRPT, MS-OXCNOTIF, MS-OXNSPI, MS-OXOABK, MS-OXDSCLI, MS-OXPROPS) in the service
`packages/mapi-server` (port 3007, loopback only). The api-gateway forwards `/mapi/*` to it.

**Status:** the mailbox endpoint (`/mapi/emsmdb`: connect, log on, folders, tables, reading,
composing, sending, notifications), the address book endpoint (`/mapi/nspi`) and the Autodiscover
announcement (`mapiHttp` block) work, so classic Outlook can create an account of the "Exchange"
type against CoreMail. Online mode only: cached mode (ICS synchronisation) is not implemented yet,
see [Limits](#limits).

## Set up classic Outlook

Prerequisites:

1. **MAPI switched on** for the account (server, domain or mailbox level, see below).
2. **HTTPS with a trusted certificate** on the public host name: the integrated HTTPS proxy serves a
   Let's Encrypt (production) or uploaded certificate (BCP → SSL/TLS, *aktiv für HTTPS*), or an
   external reverse proxy terminates TLS with a trusted certificate — then set
   `MAPI_HTTPS_TRUSTED=true` (the server cannot see that certificate). Self-signed and Let's Encrypt
   staging certificates are not enough: Autodiscover then announces no MAPI.
3. **Autodiscover reachable** (DNS `autodiscover.<domain>` or the SRV record, see
   [autodiscover.md](autodiscover.md)).

Then in Outlook: *File → Add account*, enter the address, *Connect*. Outlook asks Autodiscover
(with `X-MapiHttpCapability`), gets the `mapiHttp` block (mailbox and address book URLs, the
account's LegacyDN) and creates an account of the "Exchange" type. It asks for the password once
(Windows security dialog, Basic authentication — tick *Remember my credentials*). Accounts with MFA
enter an **app password** (Webmail → Einstellungen → Sicherheit), as on every mail protocol.

Outlook works **online** (no cached mode, see Limits): in *Account settings → Change* turn
*Use Cached Exchange Mode* off if Outlook turned it on.

With MAPI off for the account (or no trusted HTTPS), Autodiscover announces IMAP + SMTP as before
and Outlook creates an IMAP account.

## Enable it

MAPI is off by default. It is the protocol switch `mapi` (see [protocol-access.md](protocol-access.md)):

```bash
coremail protocol set --scope user alice@example.com --mapi on    # one mailbox
coremail protocol set --scope domain example.com --mapi on         # a domain
coremail protocol set --mapi on                                    # the whole server
```

or in the BCP (*Services → Protokollzugriff*, *Domain bearbeiten*, mailbox dialog). With the switch
off the endpoint answers 403 (no password prompt) after a correct password; turning it off ends the
running MAPI sessions of the affected accounts at once.

Clients reach `https://<host>/mapi/emsmdb/` (mailbox) and `https://<host>/mapi/nspi/` (address book);
Autodiscover announces exactly these URLs (host: the https webmail URL of BCP → Server, else the
public host name).

## Authentication

**Basic over TLS** — the only scheme. Every request carries `Authorization: Basic`, checked by the
shared mail-protocol check (MFA accounts: app passwords, shared lockout, LDAP verifier, the `mapi`
switch after the password). A request over a connection the gateway verified as plain HTTP is refused
(403); `MAPI_ALLOW_PLAIN_HTTP=true` only for test setups. The challenge is
`WWW-Authenticate: Basic realm="CoreMail"` — no `NTLM` or `Negotiate` is offered, and a request that
sends one of them gets the Basic challenge again; Outlook then uses Basic (it asks for the password
once and can store it). Autodiscover uses the same rule (`Basic realm="CoreMail Autodiscover"`).

Why no NTLM / Negotiate:

- **NTLM** (MS-NLMP) needs the NT hash (MD4 of the UTF-16 password) on the server. CoreMail stores
  passwords only as `bcrypt(sha256(password + pepper))` and never keeps a reversible or
  password-equivalent secret — an NT hash is password-equivalent (pass-the-hash), so storing one would
  weaken every account, and it would not exist for existing passwords and app passwords anyway.
- **Negotiate / Kerberos** (MS-SPNG) needs an Active Directory realm, a service principal and a keytab
  for the MAPI host. That belongs to a directory-integrated deployment (LDAP/AD connector) and is not
  part of 9.4; Negotiate is not announced.

Consequence: Outlook shows a password prompt (Windows security dialog) instead of signing in with the
Windows account. Passwords only travel inside TLS.

Refusals before a session exists:

| Situation | HTTP | X-ResponseCode | Notes |
|-----------|------|----------------|-------|
| No / wrong credentials, NTLM / Negotiate header | 401 + `WWW-Authenticate: Basic` | 8 Anonymous Not Allowed | the only answer that makes Outlook ask for the password |
| MAPI switched off, plain HTTP | 403 | 11 No Privilege | |
| Per-account request limit (`MAPI_RATE_LIMIT`), account locked by the shared mail-login lockout, temporary failure | 503 + `Retry-After` | 1 Unknown Failure | MS-OXCMAPIHTTP has no throttling code (2.2.3.3.3) and reserves non-200 statuses for authentication and exceptional conditions (2.2.2.2): throttling is a 5xx with `Retry-After`, never 401 (no password prompt) and never a misused X-ResponseCode |

## Autodiscover

Autodiscover v1 (Outlook schema) adds the block below when **all** hold: the client sends
`X-MapiHttpCapability` ≥ 1 (MS-OXDSCLI 3.2.5.1; version 1 is served), the account's `mapi` switch is
on, a public host name is configured and HTTPS has a trusted certificate (see prerequisites). The
IMAP / POP3 / SMTP blocks stay as before; `EXCH` / `EXPR` blocks are never sent.

```xml
<Protocol Type="mapiHttp" Version="1">
  <MailStore>
    <InternalUrl>https://mail.example.com/mapi/emsmdb/</InternalUrl>
    <ExternalUrl>https://mail.example.com/mapi/emsmdb/</ExternalUrl>
  </MailStore>
  <AddressBook>
    <InternalUrl>https://mail.example.com/mapi/nspi/</InternalUrl>
    <ExternalUrl>https://mail.example.com/mapi/nspi/</ExternalUrl>
  </AddressBook>
</Protocol>
```

`<User><LegacyDN>` is the DN the MAPI `Connect` names (storage `legacyDnFor`). The version 1 format
has only `MailStore` and `AddressBook` (MS-OXDSCLI 3.2.5.1), so no `ServerExclusiveConnect` element.
Autodiscover v2 answers `Protocol=MapiHttp` with `{ "Protocol": "MapiHttp", "Url": "<mailbox URL>" }`
while `mapi` is on for the mail domain and HTTPS is trusted, else `404 NoSuchProtocol` (anonymous,
domain level only, as every v2 answer). Details: [autodiscover.md](autodiscover.md).

## What works

| Area | Details |
|------|---------|
| Envelope | POST only; `X-RequestType` `Connect`, `Execute`, `Disconnect`, `NotificationWait`, `PING` (mailbox) and the 19 address book request types; `X-RequestId` / `X-ClientInfo` echoed; `X-ResponseCode`, `X-PendingPeriod`, `X-ExpirationInfo`, `X-ServerApplication`; streamed `PROCESSING` / `PENDING` / `DONE` with `X-ElapsedTime` and `X-StartTime` |
| Sessions | Mailbox: cookies `MapiContext` / `MapiSequence` (path `/mapi/`); address book: `NspiContext` / `NspiSequence` (path `/mapi/nspi`, created by `Bind`, ended by `Unbind`). The sequence cookie rotates per request (a replayed or concurrent request gets 15 "Invalid Sequence"); a session is bound to its endpoint and the credentials it was created with (else 10 "Context Not Found"; PING refreshes only the caller's own session); idle timeout 30 min (`MAPI_SESSION_IDLE_MS`); at most 16 sessions per account (both endpoints); a failure after `PROCESSING` still ends with `DONE` and X-ResponseCode 1 (a malformed address book body: 12) |
| Execute | RPC_HEADER_EXT payloads, also XOR-obfuscated and LZ77/DIRECT2-compressed requests; an empty body or ROP buffer only fetches notifications; responses uncompressed; output limited to `MaxRopOut` and 32 KB, `RopBufferTooSmall` when a response does not fit |
| Logon | Own mailbox; shared and delegated mailboxes the account may read (Essdn = their legacy DN), read-only ones refuse writes |
| Folders | Root, Top of Information Store, Outbox and the other special folders, the CoreMail folders below; open, create (subfolders `Parent.Name`), delete (mail moves to Deleted Items; default folders cannot be deleted), hierarchy tables (with depth) |
| Tables | `SetColumns`, `SortTable`, `Restrict` (and/or/not, content, property, compare, bitmask, size, exist), `QueryRows` (forward/backward), `SeekRow`, `QueryPosition` |
| Messages | Open (recipients, subject), properties (specific/all, large values via streams), read flag, delete (tombstones, recoverable 30 days), move/copy (also between logons), attachments (table, open, create, save) |
| Streams | Read the plain-text and HTML body and attachment data; write bodies and attachment data of new messages |
| Composing | `CreateMessage` in Drafts (saved as a draft, visible to every client) or in the Outbox (kept in the session), `SetProperties`, `ModifyRecipients` (SMTP addresses, X500 DNs of CoreMail accounts), `SaveChangesMessage`, `SubmitMessage` |
| Sending | Same rules as webmail, SMTP submission, JMAP and ActiveSync: the submission limits of the user (storage `submissionLimitsForUser` — recipients: BCP SMTP *max. recipients* → `ecTooManyRecips`; size: the stricter max. message size → `ecMaxSubmissionExceeded`, also reported as `PidTagMaximumSubmitMessageSize`; a per-mailbox value of the user's mail flow policy replaces either), send quota, sender identity (own address, aliases, shared mailboxes with Send As / Full Access), queue `smtp-outbound`, copy in Sent Items unless `PidTagDeleteAfterSubmit`, the draft is removed; folder associated messages are never sent |
| Named properties | `GetPropertyIdsFromNames` / `GetNamesFromPropertyIds` (registered IDs from 0x8001, stable per mailbox while the service runs; PS_MAPI LIDs are the property ID; only internet header names are case-insensitive; a read-only mailbox registers nothing; no names on the store object lists every ID) |
| Notifications | `RopRegisterNotification` (whole store or one folder) and every open hierarchy / contents table (unless opened with `NoNotifications`) get events of every client and protocol (Redis `mailbox:changes`, [realtime.md](realtime.md)): **NewMail** for each message that appeared in a folder (not in Sent Items / Drafts; at most 50 per change), **ObjectModified** with the new total / unread counts of a changed folder, **TableModified / TableChanged** for tables showing the change (their snapshot is dropped, the client re-reads). `NotificationWait` returns at once when something is queued, else when an event arrives (typically within a second) or after 5 minutes; the next `Execute` carries the events as `RopNotify` (and `RopPending` when they do not all fit). One outstanding `NotificationWait` per session: a second one is answered at once with `ecRejected` (0x7EE, MS-OXCRPC 3.3.4.1); ending the session (Disconnect, idle timeout, credential change, MAPI switched off) ends a waiting request with EventPending 0. Up to 512 notifications are queued per session (newer replace older ones of the same object) |
| Address book | One container, the Global Address List (ContainerID 0, `GetSpecialTable` with version 1): the active users and Shared Mailboxes of the account's own domain (the GAL scope of every CoreMail directory lookup), sorted by display name. Entries are addressed as type `EX` with their legacy DN; `PidTagSmtpAddress` and `PidTagAddressBookProxyAddresses` carry the SMTP addresses (`SMTP:` primary, `smtp:` aliases). Minimal Entry IDs are derived from the directory id — stable across sessions and restarts. `QueryRows` (paged, STAT positioning incl. fractional), `SeekEntries` (display name), `UpdateStat`, `CompareMIds`, `ResortRestriction`, `GetMatches` (restriction filter, ANR on `PidTagAnr`, more matches than requested → `TableTooBig`), `ResolveNames` (ANR: an exact address or alias, else prefixes of the display name, its words and the local parts; MID_UNRESOLVED / MID_AMBIGUOUS / the entry's MID), `DNToMId`, `GetProps` (permanent or — `fEphID` — ephemeral EntryIDs), `GetPropList`, `QueryColumns`, `GetMailboxUrl` / `GetAddressBookUrl` (the announced URLs). Mailboxes hidden from the address list (mail flow policy) are not listed and never found by name, but a known DN still resolves (`DNToMId`) and the session may then read that entry by its MID (`GetProps`, `GetPropList`, explicit `QueryRows`) — Outlook needs its own entry even when hidden, and the own entry is always readable. A MID alone never reveals a hidden entry (MIDs are 31-bit and could be enumerated). Result bounds: at most 100 000 cells (rows × columns) per answer — paged reads (`QueryRows`, `SeekEntries`) return fewer rows, explicit MID lists, `GetMatches` and `ResolveNames` answer `TableTooBig`; at most 1000 names per `ResolveNames`, 256 nodes per `GetMatches` filter (else `TooComplex`). The sessions of one domain share one snapshot, reloaded after 60 s |

## Limits

- **No cached mode.** Unknown ROPs fail the whole Execute with `ecRpcFormat` (as the specification
  requires) — Outlook operations that need further ROPs (cached mode / ICS synchronisation, rules,
  permissions, search folders, `ReadRecipients`, `GetPropertiesList`, bookmarks …) do not work yet.
  Outlook turns *Use Cached Exchange Mode* on for new accounts by default: turn it off (account
  settings, or the Outlook policy for managed clients).
- The address book is read-only (`ModProps` / `ModLinkAtt` → NotSupported), has no address creation
  or details templates (`GetTemplateInfo` → NotFound; Outlook shows its built-in details page) and no
  distribution lists.
- Notifications carry no per-message ObjectCreated / ObjectDeleted / ObjectModified events: views
  refresh through TableChanged.
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
  at most 1024 restriction nodes (`ecTooComplex`, also for `GetMatches`). An address book request
  names at most 10 000 MIDs / names, a `QueryRows` answer holds at most 1000 rows, an address book at
  most 20 000 users and 20 000 Shared Mailboxes.

## Operations

- Service: supervisord program `mapi-server`; health `GET http://127.0.0.1:3007/health`.
- Environment: `MAPI_PORT` (3007), `MAPI_SESSION_IDLE_MS` (1 800 000), `MAPI_PENDING_MS` (15 000),
  `MAPI_ALLOW_PLAIN_HTTP` (false), `MAPI_RATE_LIMIT` (3000, 0 = off), `MAPI_RATE_WINDOW_SEC` (300),
  `MAPI_SESSION_MEMORY_MB` (64), gateway `MAPI_SERVICE_URL` (`http://localhost:3007`);
  `MAPI_HTTPS_TRUSTED` (false; read by Autodiscover — `true` when an external TLS terminator presents
  a trusted certificate for the public host).
- Rate-limit counters: Redis `ratelimit:mapi:<userId>:<window>` (in-process fallback while Redis is down).
- Session records: Redis `mapi:ctx:<sha256(cookie)>` with the idle TTL (both endpoints); the open
  server objects, notification queues and address book snapshots live in the service process, so
  after a restart clients connect / bind again ("Context Not Found").
- The service subscribes to Redis `mailbox:changes` (one connection) for notifications.
- e2e: step `mapi` (`scripts/e2e/steps/mapi.mjs`); the client used by the tests and the e2e step is
  `packages/mapi-server/src/testing/mapi-client.ts`.
