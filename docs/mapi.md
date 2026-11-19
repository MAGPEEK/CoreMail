# MAPI over HTTP (classic Outlook)

Since 9.4 CoreMail serves MAPI over HTTP, the protocol classic Win32 Outlook uses for an account of
the "Exchange" type. It is implemented from the public Microsoft Open Specifications
(MS-OXCMAPIHTTP, MS-OXCRPC, MS-OXCROPS, MS-OXCDATA, MS-OXCSTOR, MS-OXCFOLD, MS-OXCTABL, MS-OXCMSG,
MS-OXCPRPT, MS-OXCNOTIF, MS-OXNSPI, MS-OXOABK, MS-OXDSCLI, MS-OXPROPS) in the service
`packages/mapi-server` (port 3007, loopback only). The api-gateway forwards `/mapi/*` to it.

**Status:** the mailbox endpoint (`/mapi/emsmdb`: connect, log on, folders, tables, reading,
composing, sending, notifications), the address book endpoint (`/mapi/nspi`) and the Autodiscover
announcement (`mapiHttp` block) work, so classic Outlook can create an account of the "Exchange"
type against CoreMail. Since 9.5 the mailbox endpoint also speaks incremental change
synchronization (ICS, MS-OXCFXICS), the protocol of Outlook's cached mode (the OST file), see
[Cached mode](#cached-mode-ics) and [Limits](#limits).

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

Outlook turns *Use Cached Exchange Mode* on for new accounts and builds its OST through ICS
(see [Cached mode](#cached-mode-ics)); online mode (*Account settings → Change*, cached mode off)
works as well.

With MAPI off for the account (or no trusted HTTPS), Autodiscover announces IMAP + SMTP as before
and Outlook creates an IMAP account.

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

Successful checks are cached for up to 60 s per credential and dropped at once when the account's
credentials, MFA, app passwords, role or active state change (auth invalidation bus). A cached
check is also dropped when the account got a "revoke all" mark after it (the Redis mark of a
deactivation, deletion or password reset, shared by every instance), so a deactivated account
loses MAPI access at once even on an instance that missed the invalidation message.

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
| Sessions | Mailbox: cookies `MapiContext` / `MapiSequence` (path `/mapi/`); address book: `NspiContext` / `NspiSequence` (path `/mapi/nspi`, created by `Bind`, ended by `Unbind`). The sequence cookie rotates per request (a replayed or concurrent request gets 15 "Invalid Sequence"); a session is bound to its endpoint and the credentials it was created with (else 10 "Context Not Found"; PING refreshes only the caller's own session); idle timeout 30 min (`MAPI_SESSION_IDLE_MS`); at most 16 sessions per account (both endpoints) across every MAPI server instance — a new session beyond it ends the least recently used one, wherever it lives (Redis index `mapi:user-ctx:<userId>`); a failure after `PROCESSING` still ends with `DONE` and X-ResponseCode 1 (a malformed address book body: 12) |
| Execute | RPC_HEADER_EXT payloads, also XOR-obfuscated and LZ77/DIRECT2-compressed requests; an empty body or ROP buffer only fetches notifications; responses uncompressed; output limited to `MaxRopOut` and 32 KB, `RopBufferTooSmall` when a response does not fit |
| Logon | Own mailbox; shared and delegated mailboxes the account may read (Essdn = their legacy DN), read-only ones refuse writes. Revoking the permission or delegation (or deactivating / deleting the owner) ends that logon in open sessions at once — its folders, tables, messages and synchronization contexts are released and no further notification of that mailbox arrives; a permission reduced to read-only applies to the next write |
| Folders | Root, Top of Information Store, Outbox and the other special folders, the CoreMail folders below; open, create (subfolders `Parent.Name`), delete (mail moves to Deleted Items; default folders cannot be deleted), hierarchy tables (with depth). The default folders always carry the names Outlook expects — Inbox, Drafts, Sent Items, Deleted Items, Junk Email, Archive — whatever display name the folder row has (it depends on how the mailbox was created: admin API, setup wizard, older versions); they cannot be renamed over MAPI |
| Tables | `SetColumns`, `SortTable`, `Restrict` (and/or/not, content, property, compare, bitmask, size, exist), `QueryRows` (forward/backward), `SeekRow`, `QueryPosition` |
| Messages | Open (recipients, subject), properties (specific/all, large values via streams), read flag, delete (tombstones, recoverable 30 days), move/copy (also between logons), attachments (table, open, create, save) |
| Streams | Read the plain-text and HTML body and attachment data; write bodies and attachment data of new messages |
| Composing | `CreateMessage` in Drafts (saved as a draft, visible to every client) or in the Outbox (kept in the session), `SetProperties`, `ModifyRecipients` (SMTP addresses, X500 DNs of CoreMail accounts), `SaveChangesMessage`, `SubmitMessage` |
| Sending | Same rules as webmail, SMTP submission, JMAP and ActiveSync: the submission limits of the user (storage `submissionLimitsForUser` — recipients: BCP SMTP *max. recipients* → `ecTooManyRecips`; size: the stricter max. message size → `ecMaxSubmissionExceeded`, also reported as `PidTagMaximumSubmitMessageSize`; a per-mailbox value of the user's mail flow policy replaces either), send quota, sender identity (own address, aliases, shared mailboxes with Send As / Full Access), queue `smtp-outbound`, copy in Sent Items unless `PidTagDeleteAfterSubmit`, the draft is removed; folder associated messages are never sent |
| Named properties | `GetPropertyIdsFromNames` / `GetNamesFromPropertyIds` (registered IDs from 0x8001, stable per mailbox while the service runs; PS_MAPI LIDs are the property ID; only internet header names are case-insensitive; a read-only mailbox registers nothing; no names on the store object lists every ID) |
| Notifications | `RopRegisterNotification` (whole store or one folder) and every open hierarchy / contents table (unless opened with `NoNotifications`) get events of every client and protocol (Redis `mailbox:changes`, [realtime.md](realtime.md)): **NewMail** for each message that appeared in a folder (not in Sent Items / Drafts; at most 50 per change), **ObjectModified** with the new total / unread counts of a changed folder, **TableModified / TableChanged** for tables showing the change (their snapshot is dropped, the client re-reads). `NotificationWait` returns at once when something is queued, else when an event arrives (typically within a second) or after 5 minutes; the next `Execute` carries the events as `RopNotify` (and `RopPending` when they do not all fit). One outstanding `NotificationWait` per session: a second one is answered at once with `ecRejected` (0x7EE, MS-OXCRPC 3.3.4.1); ending the session (Disconnect, idle timeout, credential change, MAPI switched off) ends a waiting request with EventPending 0. Up to 512 notifications are queued per session (newer replace older ones of the same object) |
| Cached mode (ICS) | Download and upload of incremental change synchronization, see [Cached mode](#cached-mode-ics); `RopLongTermIdFromId` / `RopIdFromLongTermId` |
| Address book code page | `Bind` names the session's 8-bit code page (`STAT.CodePage`): CP_WINUNICODE (1200) or a code page the server does not serve is refused with `InvalidCodepage` (0x8004011E) and no session. Strings requested as `PtypString8` are converted into the request STAT's code page, or the session's when the STAT asks for Unicode (MS-OXNSPI 3.1.4.3.3); characters the code page cannot represent become `?`. Served: the Windows and ISO single-byte code pages, 932 / 936 / 949 / 950, UTF-8 (65001), US-ASCII (20127) and CP_TELETEX (20261, ASCII) |
| Address book | One container, the Global Address List (ContainerID 0, `GetSpecialTable` with version 1): the active users and Shared Mailboxes of the account's own domain (the GAL scope of every CoreMail directory lookup), sorted by display name. Entries are addressed as type `EX` with their legacy DN; `PidTagSmtpAddress` and `PidTagAddressBookProxyAddresses` carry the SMTP addresses (`SMTP:` primary, `smtp:` aliases). Minimal Entry IDs are derived from the directory id — stable across sessions and restarts. `QueryRows` (paged, STAT positioning incl. fractional), `SeekEntries` (display name), `UpdateStat`, `CompareMIds`, `ResortRestriction`, `GetMatches` (restriction filter, ANR on `PidTagAnr`, more matches than requested → `TableTooBig`), `ResolveNames` (ANR: an exact address or alias, else prefixes of the display name, its words and the local parts; MID_UNRESOLVED / MID_AMBIGUOUS / the entry's MID), `DNToMId`, `GetProps` (permanent or — `fEphID` — ephemeral EntryIDs), `GetPropList`, `QueryColumns`, `GetMailboxUrl` / `GetAddressBookUrl` (the announced URLs). Mailboxes hidden from the address list (mail flow policy) are not listed and never found by name, but a known DN still resolves (`DNToMId`) and the session may then read that entry by its MID (`GetProps`, `GetPropList`, explicit `QueryRows`) — Outlook needs its own entry even when hidden, and the own entry is always readable. A MID alone never reveals a hidden entry (MIDs are 31-bit and could be enumerated). Result bounds: at most 100 000 cells (rows × columns) per answer — paged reads (`QueryRows`, `SeekEntries`) return fewer rows, explicit MID lists, `GetMatches` and `ResolveNames` answer `TableTooBig`; at most 1000 names per `ResolveNames`, 256 nodes per `GetMatches` filter (else `TooComplex`). The sessions of one domain share one snapshot, reloaded after 60 s |

## Cached mode (ICS)

Classic Outlook in cached mode keeps an OST file and synchronizes it with incremental change
synchronization (MS-OXCFXICS). The server keeps no per-client state: the client uploads its
**ICS state** before each round and gets the new one at the end.

**Download** (`RopSynchronizationConfigure` on a folder, contents or hierarchy →
`RopSynchronizationUploadStateStreamBegin / Continue / End` → `RopFastTransferSourceGetBuffer`
until TransferStatus Done):

| Stream element | What CoreMail sends |
|----------------|---------------------|
| messageChange (`IncrSyncChg` header, `IncrSyncMessage`, properties, recipients, attachments with their data) | messages the client has not seen in this state, oldest first (newest first with *OrderByDeliveryTime*); the header carries PidTagSourceKey, PidTagLastModificationTime, PidTagChangeKey, PidTagPredecessorChangeList, PidTagAssociated and on request PidTagMid, PidTagMessageSize, PidTagChangeNumber |
| `IncrSyncRead` (MetaTagIdsetRead / IdsetUnread) | messages the client has whose only change is the read state (*ReadState* flag) |
| `IncrSyncDel` (MetaTagIdsetDeleted / IdsetNoLongerInScope) | messages of the client's IdsetGiven no longer in the folder (deleted — tombstoned / recoverable or purged —, moved away); messages that left the restriction of the synchronization (no longer in scope) |
| folderChange | new and changed folders below the synchronization root (parents first; the root's children have a zero-length PidTagParentSourceKey), with display name, container class and hidden flag |
| `IncrSyncStateBegin` … `IncrSyncStateEnd`, `IncrSyncEnd` | the final ICS state: MetaTagIdsetGiven, MetaTagCnsetSeen and — for contents — MetaTagCnsetSeenFAI and MetaTagCnsetRead |

The stream is produced message by message and handed out in buffers of the size the client asks
for (also `0xBABE` + maximum, bounded by the output buffer): TransferStatus Partial until the last
buffer, then Done. A buffer ends between two atoms or inside a variable-size value, never inside a
property tag or fixed-size value. `RopSynchronizationGetTransferState` returns the uploaded state
before the download, the state of what was handed out completely during it (checkpoint) and the
final state afterwards.

An uploaded state property may be at most 16 MB; decoded, its ranges count against the session's
memory budget (`MAPI_SESSION_MEMORY_MB`, about 96 bytes per range, at most 1 000 000 ranges per
property): a larger state ends `RopSynchronizationUploadStateStreamEnd` with `ecMAPIOOM`, a malformed
IDSET with `RpcFormat` (MS-OXCFXICS 3.1.5.4.3.2); the context stays usable.

Identifiers: IDs are those of online mode (message ID = UID, folder ID from the folder id);
PidTagSourceKey = replica GUID + the ID's 6-byte counter. The **change number** of a message is its
modSeq (the message store gives every changed row the mailbox's next modSeq); folders have no
modSeq — their change number is derived from what the hierarchy shows (name, parent, class, hidden).
Such a change number recurs when a folder returns to an earlier state (renamed or moved back), so
the final hierarchy state's MetaTagCnsetSeen names exactly the change numbers of the folders in
scope rather than every one ever seen — a folder renamed back is sent again. A folder that left the
synchronized subtree (deleted, or moved elsewhere) is reported deleted.
PidTagChangeKey = replica GUID + the change number; PidTagPredecessorChangeList holds that change
key. IDSETs (MetaTag*) are encoded as GLOBSETs (Push / Range / Pop / End; Bitmask is understood when
decoding).

Read state: CoreMail never rewrites a stored message (saving a draft again, a move or a copy gives
a new UID, so a new ID — a draft saved again may keep its ID, but it carries `\Draft`); an ID the
client has can therefore only change its flags. Such a change is
sent as a read-state change, unless the message carries `\Answered`, `$Forwarded` or `\Draft` (the
icon or the draft state may have changed too) — then it is a full message change. Clearing one of
these flags (another client removes `\Answered`) is not detected: the message store keeps no
separate change number for the read state, see [Limits](#limits).

**Upload** (`RopSynchronizationOpenCollector` on a folder): every write goes through the message
store and the folder helpers, like online mode.

| ROP | Effect |
|-----|--------|
| `RopSynchronizationImportMessageChange` + `SetProperties` / `ModifyRecipients` / attachments + `SaveChangesMessage` | a new message is stored as raw MIME — as a draft when PidTagMessageFlags has *Unsent* (unread when *Read* is clear), else as a regular message with the uploaded read state and date; a change to a stored draft replaces the draft (the message keeps its ID); a change to a received message applies its read state (CoreMail keeps the original MIME); a change to a message the server no longer has (deleted, moved away) is dropped (the deletion wins); folder associated information is accepted and not kept. Conflict detection, see below |
| `RopSynchronizationImportReadStateChanges` | read / unread (`\Seen` through the message store) |
| `RopSynchronizationImportDeletes` | messages: tombstoned like `RopDeleteMessages` (recoverable 30 days, also with *HardDelete*); folders: deleted with their subfolders, mail to Deleted Items; default and special folders → `ecAccessDenied`; objects already gone are ignored |
| `RopSynchronizationImportMessageMove` | move through the message store (new UID in the target); the moved message takes the destination ID the client assigned |
| `RopSynchronizationImportHierarchyChange` | new folder; rename / move of a stored folder (default and special folders keep name and place → `ecAccessDenied`; an unchanged one is accepted) |
| `RopGetLocalReplicaIds`, `RopSetLocalReplicaMidsetDeleted` | ID ranges for objects the client creates offline (above every UID and every client ID the mailbox's objects keep, Redis counter `mapi:local-ids:<mailboxId>`, seeded from the clock; at most 0x10000 per request and 256 × 0x10000 per session, beyond that `ecQuotaExceeded`); unused ranges need nothing on the server |

**Client-assigned IDs** (MS-OXCFXICS 3.3.5.2.1): a folder or message the client created keeps the
ID it assigned — when that ID comes from a range `RopGetLocalReplicaIds` handed out for the
mailbox and no object has used it yet. The binding is stored in the database (`mapi_objects`,
model MapiObject: mailbox, client ID, message or folder row) and survives restarts: the object
answers to that ID at once (`RopOpenFolder` / `RopOpenMessage`, tables, downloads, a collector on a
folder the client just created), a later change updates it, and a draft saved again — by the
client or online — keeps it (the new row takes over the binding). A message moved to another
mailbox shows its UID there. When the object goes, the row stays (its object reference becomes
empty), so the retired ID is still reported deleted to clients that have it. An ID that cannot be
kept (outside the handed-out ranges, already used, a new folder whose name exists) is replaced: the
object is stored under a server ID, the client ID is remembered (`mapi:replaced-ids:<mailboxId>`,
90 days, the newest 100 000 per mailbox) and the next download reports it deleted and sends the
server's copy. Read-only (shared / delegated) logons refuse every import with `ecAccessDenied`.

**Upload state**: every change an import writes is recorded in the collector's ICS state —
the change number in MetaTagCnsetSeen (message changes, moves, folder changes) or MetaTagCnsetRead
(`ImportReadStateChanges`), 3.2.5.9.4.3–3.2.5.9.4.6 — which `RopSynchronizationGetTransferState` on
the collector returns. The client merges it into its download state, so the next download sends
none of its own changes back (a change number in CnsetRead that the client has is skipped as its
own read-state change). A replaced ID's object is not recorded: its server copy has to come down.

**Conflict detection** (`ImportMessageChange`, 3.1.5.6.1): the uploaded
PidTagPredecessorChangeList is compared with the PCL of the stored version — the PCL the client
uploaded with it, else the row's creation (CoreMail never rewrites a stored message, a read flag
is no new version). The stored version includes the client's → the server already has the change
(`IgnoreFailure` 0x80040801); the client's includes the stored one → the change applies and its PCL
is kept with the message (downloads send it merged with the current change key, so the uploading
client sees the server version as a successor of its own); neither → **conflict**: with
*FailOnConflict* the ROP fails with `SyncConflict` (0x80040802), otherwise the ROP succeeds, the
server version is kept and the client receives it with its next download (CoreMail's resolution:
the server wins; no conflict resolve message, no last-writer-wins comparison).

## Limits

- Cached mode: no folder associated information is stored (Outlook's view settings and similar
  configuration messages stay in its OST only; a new profile starts with defaults); no partial
  message changes, no progress elements (*Progress* flag), no RTF bodies (*BestBody* is the
  default: plain text and HTML as stored); the FastTransfer copy ROPs (`RopFastTransferSourceCopyTo`
  / `CopyMessages` / `CopyFolder` / `CopyProperties`, `RopFastTransferDestination*`) are not
  implemented; strings for a client without the *Unicode* flag are Latin-1. Changes of received
  messages other than the read state (categories, follow-up flags of the client) are not uploaded.
  Conflicts of message changes are resolved for the server version (no conflict resolve message);
  hierarchy changes have no conflict detection (the last change wins). A flag cleared by another
  client (`\Answered`, `$Forwarded`, `\Draft`) keeps the old icon / draft state in Outlook until the
  message changes otherwise (the message store keeps no separate change number for flags).
- Unknown ROPs fail the whole Execute with `ecRpcFormat` (as the specification requires) — Outlook
  operations that need further ROPs (rules, permissions, search folders, `ReadRecipients`,
  `GetPropertiesList`, bookmarks …) do not work yet.
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
- Session records: Redis `mapi:ctx:<sha256(cookie)>` with the idle TTL (both endpoints) and the
  per-account index `mapi:user-ctx:<userId>` (sorted set by last use, the session cap across
  instances); the open server objects, notification queues, synchronization contexts and address
  book snapshots live in the service process, so after a restart clients connect / bind again
  ("Context Not Found").
- Cached mode: database table `mapi_objects` (client-assigned IDs and uploaded PCLs, additive
  schema), Redis `mapi:local-ids:<mailboxId>` (next client ID; recreated above every kept ID when
  lost) and `mapi:replaced-ids:<mailboxId>` (client IDs replaced by server IDs, 90 days).
- The service subscribes to the auth invalidation bus: credential changes and deactivations end
  sessions, `permission-change` (and a deactivated owner) end the affected shared / delegated logons.
- The service subscribes to Redis `mailbox:changes` (one connection) for notifications.
- e2e: step `mapi` (`scripts/e2e/steps/mapi.mjs`); the client used by the tests and the e2e step is
  `packages/mapi-server/src/testing/mapi-client.ts`.
