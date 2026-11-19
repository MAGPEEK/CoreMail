# Mailbox management (9.4)

Three features for user mailboxes and Shared Mailboxes:

1. **Shared mailbox grants** — auto-mapping per grant and separate "save sent
   items in the shared mailbox" switches for *send as* and *send on behalf*.
2. **Per-mailbox mail flow** — hide from the address list, admin forwarding,
   accept-only-from / reject-from lists and limits that replace the global ones.
3. **Mailbox access audit** — what delegates and Shared Mailbox users do in a
   mailbox that is not their own, from every client, with aggregation and a
   retention setting; the owner sees it in webmail Settings → Sicherheit.
4. **Folder permissions** (w3) — a role on one folder for another user or for
   everyone in the organisation, like a folder's "Permissions" in Outlook.

## 1. Shared mailbox grants

### Auto-mapping ("Automatisch einblenden")

`SharedMailboxPerm.autoMap` and `MailboxDelegate.autoMap` (default `true`).

| autoMap | Webmail folder pane | IMAP `LIST` (`Shared/…`, `Other Users/…`) | Access (SELECT, REST, JMAP) |
|---|---|---|---|
| on | shown (the user may hide it) | listed | yes |
| off | hidden until the user adds it ("Postfach öffnen") | listed only after the user added it | yes |

A Shared Mailbox counts as auto-mapped when any of the user's read grants
(FULL_ACCESS / READ_ONLY) has it on. Adding is stored in
`UserSettings.addedSharedMailboxes` (refs `shared:<id>` / `delegated:<mailboxId>`),
hiding in `hiddenSharedMailboxes`; `PATCH /api/v1/user/accessible-mailboxes/:ref
{hidden:false}` adds, `{hidden:true}` hides. Mapping never changes access.

Set it: BCP → Freigegebene Postfächer → Berechtigungen ("Automatisch einblenden"),
BCP → Postfächer → Zugriffsrechte, `POST /api/v1/admin/shared-mailboxes/:id/permissions
{userId, permissions, autoMap}`, `POST /api/v1/admin/mailboxes/:id/delegates
{granteeId, permission, autoMap}`, `coremail shared grant <box> <user> <perms…> --no-automap`.

### Sent items in the shared mailbox

`SharedMailbox.sentCopySendAs` / `sentCopySendOnBehalf` (default off). When on, a
message the user sends *as* / *on behalf of* the box is also stored in the box's
`Sent` folder (through the message store, raw original kept) — in addition to
the sender's own Sent copy.

One helper decides and writes: `afterForeignSend()` in
`packages/storage/src/shared-sent-copy.ts`. It classifies From: / Sender: of the
message (From = a box address or alias with SEND_AS/FULL_ACCESS → send as;
From = a box with SEND_ON_BEHALF and Sender = the user → on behalf), writes the
audit entry (`mailbox.foreign.send_as` / `send_on_behalf`) and the copy.

| Path | When |
|---|---|
| Webmail (`/mail/send`, drafts, undo send, scheduled send) | outbound worker, first processing of the job (`foreignSendSource: 'webmail'`) — a cancelled / undone send leaves no copy |
| JMAP `EmailSubmission/set` from the personal account | outbound worker (`foreignSendSource: 'jmap'`) |
| JMAP `EmailSubmission/set` from the Shared Mailbox account | outbound worker, audit only (`foreignSendAuditOnly`): the Email already lives in that mailbox |
| SMTP submission (587/465) | after delivery / queueing |
| ActiveSync SendMail / SmartReply / SmartForward | after queueing |

The sender's own Sent copy (webmail `/mail/send`; drafts become the Sent copy
themselves) is built from the same message as the outbound job
(`sentCopyMailOptions()` in api-gateway `routes/mail.ts`): it shows the Shared
Mailbox as From and, on behalf, the user as Sender — plus Bcc.

Set it: BCP → Freigegebene Postfächer → Bearbeiten, `PUT
/api/v1/admin/shared-mailboxes/:id {sentCopySendAs, sentCopySendOnBehalf}`,
`coremail shared sent-copy <box> --send-as on|off --on-behalf on|off`.

## 2. Per-mailbox mail flow

Model `MailFlowPolicy` (one row per user mailbox or Shared Mailbox; no row =
defaults). Logic in `packages/storage/src/mail-flow.ts`.

| Field | Meaning |
|---|---|
| `hiddenFromGal` | not in the webmail GAL (`/contacts/gal`), the compose autocomplete (`/contacts?q=`), the ActiveSync GAL (Search, ResolveRecipients) and JMAP `Principal/*` (unless the caller has an account for it) |
| `forwardTo`, `forwardKeepCopy` | admin forwarding of every delivered message; keep copy off = forward only |
| `acceptFrom`, `rejectFrom` | addresses (`a@b.example`) or domains (`b.example`, also its subdomains); empty = no restriction |
| `maxReceiveSizeMb` | largest message delivered to the mailbox |
| `maxSendSizeMb`, `maxRecipients` | user mailboxes only: largest message / most recipients the user may send |

### Enforcement

* **Sender lists** — reject-from refuses when the envelope sender *or* the header
  From: matches; accept-only-from needs every known sender to match and refuses
  a message without any sender (null reverse-path and no From:). Internationalized
  domains are stored as punycode and compared in canonical form, so an entry and a
  sender match in either spelling (Unicode or punycode).
  * Port 25 `RCPT TO`: envelope sender → `550 5.7.1 Recipient does not accept mail from this sender`.
    A null reverse-path is judged at DATA / delivery, where the header From: is known.
  * Port 25 `DATA`: when every local recipient refuses (header From:, size) and
    there is no external one, the DATA reply refuses (550 5.7.1 / 552 5.2.3).
  * Every local delivery (port 25, submission, outbound worker for webmail /
    JMAP / ActiveSync, rule redirects): `storeInboundMessage` returns `policy`
    → not stored, NDR `5.7.1` to the sender (never for a null sender).
  * The server's own notices — local DSNs / NDRs and dead-letter notices
    (`StoreOptions.systemNotice`, internal flag) — pass the sender lists and the
    receive size limit: a restricted mailbox still gets the NDRs of its own mail.
* **Receive size** — `552 5.2.3 Message exceeds the size limit of the recipient (N MB)`
  at DATA / NDR at delivery.
* **Send limits** — one helper for every client submission path (storage
  `submission-limits.ts`: `submissionLimitsForUser` / `checkSubmissionLimits`):
  global size = the stricter of the SMTP and the server max. message size, global
  recipients = BCP SMTP *max. recipients*; a per-mailbox value replaces the global
  one. Webmail (`413`, recipients `400`; `MAIL_SEND_MAX_RECIPIENTS` stays the
  request's upper bound), SMTP submission (`552 5.3.4` / `550 5.5.3` at DATA; the
  listener's own SIZE / RCPT limits are the global part),
  JMAP (`tooLarge` / `tooManyRecipients`), ActiveSync (size → Status 122
  AttachmentIsTooLarge, the only size status of the MS-ASCMD common status codes;
  recipients → 120 MailSubmissionFailed, as there is no specific code; protocol
  12.1: HTTP 413 / 500), MAPI (`ecMaxSubmissionExceeded` / `ecTooManyRecips` at
  RopSubmitMessage; `PidTagMaximumSubmitMessageSize` of the logon). The
  listener-level message size (SMTP `SIZE`, the webmail request limit) stays the
  transport's upper bound: a per-mailbox value above it has no effect beyond it.
* **Forwarding** — like a rule `forward`: `Resent-*` fields, envelope sender =
  the forwarding mailbox (aligned with our SPF/DKIM, no SRS), queued through the
  outbound queue before the local copy is committed (a transaction retry does
  not forward twice). Loop protection: a message that already carries
  `X-CoreMail-RuleForwarded` (forwarded by a rule or an admin forwarding) is not
  forwarded again and is always kept locally — the header is internal: a copy
  supplied by a sender (port 25, submission, webmail / JMAP / ActiveSync) is
  stripped on receipt, only CoreMail's own forwards carry it; null-sender messages (bounces,
  DSNs) are never forwarded. Forwarding to the mailbox's own address or alias is
  refused by the API. Transport rules run first; a transport rule that stops the
  delivery stops the forwarding too. An S/MIME message decrypted for storage is
  forwarded as received (still encrypted, with the transport rules' header
  edits) — the plaintext never leaves the server. A Shared Mailbox forwards with
  its primary address as envelope sender.

### Admin API, BCP, CLI

```
GET|PUT /api/v1/admin/mailboxes/:userId/mail-flow
GET|PUT /api/v1/admin/shared-mailboxes/:id/mail-flow     (no send limits)
```

PUT takes any subset of the fields (absent = unchanged; `forwardTo: null` or `""`
clears) and answers with the stored policy; area `recipients`, admin mailboxes
Organization Management only. Every change is audited as
`mailbox.mailflow.update` with the changed fields.

BCP: Postfächer → Bearbeiten → "Nachrichtenfluss"; Freigegebene Postfächer →
Bearbeiten → "Nachrichtenfluss".

```
coremail mailbox flow bob@example.com                      # show
coremail mailbox flow bob@example.com --hide-gal --forward boss@example.com --keep-copy off
coremail mailbox flow bob@example.com --reject-from spam.example,x@y.example --max-send 10 --max-recipients 50
coremail shared flow team@example.com --accept-from example.com --max-receive 20
```

## 3. Mailbox access audit

Every event is an `AuditLog` row with an action under `mailbox.foreign.`
(`packages/storage/src/mailbox-access-audit.ts`):

| Action | Webmail | IMAP | JMAP | ActiveSync / SMTP |
|---|---|---|---|---|
| `open` (aggregated) | any request to the foreign mailbox | SELECT / EXAMINE | use of the account | — |
| `send_as`, `send_on_behalf` | ✓ | — | ✓ | ✓ |
| `message.move` | move | MOVE (out of / into a foreign folder) | Email/set `mailboxIds` | — |
| `message.delete` | delete | EXPUNGE, UID EXPUNGE, CLOSE | Email/set destroy | — |
| `folder.create/update/delete/empty` | ✓ | CREATE / RENAME / DELETE | Mailbox/set | — |

`targetType` is `sharedMailbox` (SharedMailbox id) or `mailbox` (Mailbox id of
the delegating user); `changes` holds `mailboxId`, `source`
(`webmail|imap|jmap|activesync|smtp`) and counts / folder names.

* **Aggregation** — `open` is written at most once per actor, mailbox and client
  type per hour across all processes: `SET NX EX` on the process's shared Redis
  client (`claimShared()`, via core `peekRedisClient()` — it never opens a
  connection itself); a key the process already holds is answered without Redis.
  While Redis is not ready, fails or does not answer within 500 ms, a bounded
  per-process window takes over (at most one row per process and hour). Writes
  and sends are written every time, one row per command with a count.
* **On / off** — `ServerSettings.mailboxAccessAuditEnabled` (default on) and the
  global audit switch `auditLogEnabled`; BCP → Einstellungen → Sicherheit.
* **Retention** — `ServerSettings.mailboxAccessAuditRetentionDays` (default 180,
  0 = keep): the api-gateway purges older `mailbox.foreign.*` rows hourly
  (Redis lock `storage:mailbox-access-audit-purge:lock`). Other audit entries are
  never purged.
* **Admin view** — BCP → Audit-Log, filter "Postfachzugriffe"
  (`GET /api/v1/admin/audit-log?category=mailbox-access`).
* **Owner view** — webmail Settings → Sicherheit → "Zugriffe auf mein Postfach"
  (`GET /api/v1/user/mailbox-access-log?limit=`): who, when, what, which client;
  no IP addresses.

Reads of single messages are not logged separately — the hourly `open` covers
read access.

## 4. Folder permissions (w3)

A mailbox owner grants another user — or **Standard** (Default = every user of
the organisation) — a role on one of their folders. **Anonym** (Anonymous) is
shown but always "Keine": mail folders are never shared anonymously.

Model `FolderPermission` (folder, mailbox, grantee `user:<id>` or `default`,
`rights`, `applyToSubfolders`); `Message.createdBy` marks items a grantee
created in a foreign folder (IMAP APPEND / COPY, a move from another mailbox) —
the "own items". Logic: `packages/storage/src/folder-permissions.ts` (rights,
roles, combination — pure) and `folder-access.ts` (the central access check).

### Rights and roles

Member-rights bitmask of the public MS-OXCPERM specification:

| Bit | Right | | Bit | Right |
|---|---|---|---|---|
| 0x1 | read items | | 0x80 | create subfolders |
| 0x2 | create items | | 0x100 | folder owner (rename / move / delete the folder, administer its permissions) |
| 0x8 / 0x20 | edit own / all items | | 0x200 | folder contact |
| 0x10 / 0x40 | delete own / all items | | 0x400 | folder visible |

| Role (webmail) | Rights |
|---|---|
| Besitzer (Owner) | 0x7FB — everything |
| Veröffentlichender Bearbeiter (Publishing Editor) | 0x4FB — all items + subfolders |
| Bearbeiter (Editor) | 0x47B — read, create, edit / delete all |
| Veröffentlichender Autor (Publishing Author) | 0x49B — read, create, edit / delete own, subfolders |
| Autor (Author) | 0x41B — read, create, edit / delete own |
| Nicht bearbeitender Autor (Nonediting Author) | 0x413 — read, create, delete own |
| Prüfer (Reviewer) | 0x401 — read |
| Mitwirkender (Contributor) | 0x402 — create only |
| Keine (None) | 0 — nothing, not even visible |

Any other combination is "Benutzerdefiniert" (Custom). "All" implies "own".

### Effective rights

1. the own mailbox → everything;
2. mailbox **FULL_ACCESS** (Shared Mailbox permission or delegation) → everything
   except administering permissions — folder grants change nothing;
3. otherwise the user's folder grant — the folder's own entry, else the nearest
   ancestor entry with "Auch für Unterordner" — or, when the user has none, the
   Default grant found the same way (the user-specific entry wins, so a user
   entry "Keine" excludes that user from Default); plus the mailbox
   **READ_ONLY** floor (read + visible on every folder) when the user holds it.

Mailbox-level grants are a floor that folder grants only add to. Paths that
know only mailbox-level grants (JMAP, MAPI, the pre-9.3 REST routes,
recover deleted items) therefore never grant more than the folder rules allow;
a user who reaches a mailbox only through folder grants does not see it there.

The parent of a folder is its `parentId` (webmail), else the folder whose name
is its "." prefix (IMAP, `Projects.2026` → `Projects`). A webmail folder without
parent is not a subfolder of INBOX for the permissions (the webmail only shows
it there).

### Limits for grantees and administrators

* A grantee (folder permissions, no mailbox-level FULL_ACCESS) may not create,
  rename, move or delete a folder when that would move OTHER folders of the
  mailbox — e.g. creating `Mr` below a shared folder would otherwise adopt the
  owner's top-level folder `Mr. Smith` through the name rule above (storage
  `reparentedFolders`; REST 403 `NO_PERMISSION`, IMAP `NO [NOPERM]`).
* The folder owner right on one folder does not reach the folders below it: a
  grantee may change an entry that applies to subfolders (before or after the
  change) only when it holds the folder owner right on every subfolder (storage
  `subfolderAuthorizer`; REST 403 `SUBFOLDERS_NOT_ADMINISTERED`, IMAP
  `NO [CANNOT]`).
* Administrators other than ORGANIZATION_MANAGEMENT never give rights to
  themselves or to Default (which includes them) — 403 `FORBIDDEN_GRANTEE`; a
  scoped administrator gives rights only to users of its domains (others answer
  like an unknown user). Lowering and removing entries is always allowed.
* `GET /api/v1/mail/delegated-mailboxes` lists the folders of a delegation only
  for FULL_ACCESS / READ_ONLY of an active owner (SEND_AS / SEND_ON_BEHALF:
  `folders: []`).

### Where it is enforced

| Path | Behaviour |
|---|---|
| Webmail folder pane (`GET /user/accessible-mailboxes`) | mailboxes with a visible folder appear (`folderScoped`, permissions `FOLDER_PERMISSIONS`); auto-mapped when a grant names the user, Default-only mailboxes are added by the user ("Postfach öffnen") |
| REST `/mail/{shared,delegated}-mailboxes/:id/…` | folder list = visible folders + their path (`noSelect`, no counts), `myRights` per folder; every read / write checked per folder; no access → 403 `NO_ACCESS`, write without any write right → 403 `READ_ONLY`, else 403 `NO_PERMISSION`; invisible folder / message → 404 |
| Attachment download, reply / forward headers | the folder's read right (`canReadFolderOf`) |
| IMAP `Other Users/`, `Shared/` | see docs/imap.md "ACL"; SETACL / DELETEACL map to folder permissions |
| Realtime | user grantees get `mailbox` events for their readable folders only; Default grantees refresh on the safety refetch |
| JMAP, MAPI | mailbox-level grants only (open point); ActiveSync serves the own mailbox only |

Every foreign access is audited as before (`mailbox.foreign.*` through
`recordMailboxAccess()`); every permission change as
`mailbox.folder.permission.set` / `.remove` (targetType `folder`, `changes`:
mailbox, grantee, before / after role, source `webmail|imap|admin`) — always,
independent of the audit switches. A change publishes `permission-change` for
the grantees (for a Default change once): IMAP drops its cached rights and
closes a selected folder whose read right is gone (`* OK [CLOSED]`), REST checks
every request anyway.

### API, webmail, BCP

```
GET|PUT /api/v1/mail/folders/:folderId/permissions                 own folders (module "Freigegebene Postfächer")
GET|PUT /api/v1/mail/{shared,delegated}-mailboxes/:id/folders/:folderId/permissions   folder owner right
GET     /api/v1/admin/mailboxes/:id/folder-permissions             every folder with its entries (area recipients)
GET|PUT /api/v1/admin/mailboxes/:id/folders/:folderId/permissions
GET     /api/v1/admin/shared-mailboxes/:id/folder-permissions
GET|PUT /api/v1/admin/shared-mailboxes/:id/folders/:folderId/permissions
```

GET answers `{ folderId, folderName, entries, inherited }` — Default and
Anonymous first. PUT takes the complete list `{ entries: [{ grantee:
"default" | "anonymous" | {userId} | {email}, role? | rights?, applyToSubfolders? }] }`
(400 for unknown users, the mailbox owner, Anonymous with rights). Admin
mailboxes: ORGANIZATION_MANAGEMENT only (403 `FORBIDDEN`).

Webmail: folder context menu → "Berechtigungen…" (own folders; foreign folders
with the folder owner right). BCP: Postfächer / Freigegebene Postfächer →
Bearbeiten → "Ordnerberechtigungen".

## Tests

* storage: `mail-flow.test.ts`, `mailbox-access-audit.test.ts`, `shared-sent-copy.test.ts`, `mailbox-access.test.ts`
* smtp-server: `handlers/mail-flow-enforcement.test.ts` (RCPT, DATA, local delivery, NDR, forwarding plan, submission limits, foreign-send step)
* imap-server: `server/imap-shared.test.ts` (auto-mapping in LIST, audit of SELECT / EXPUNGE / MOVE / folder changes)
* jmap-server: `mailbox-mgmt.test.ts`; activesync: `commands/directory-hidden.test.ts`, `commands/send-mail.test.ts`
* api-gateway: `routes/mailbox-mgmt.test.ts`, `routes/contacts.test.ts`; cli: `commands/mail-flow.test.ts`
* BCP `lib/mailFlow.test.ts`, webmail `lib/mailboxAccessLog.test.ts`
* w3 folder permissions: storage `folder-permissions.test.ts` (rights table, roles, inheritance),
  `folder-access.test.ts` (listing, per-folder rights, writer + audit, realtime audience);
  api-gateway `routes/folder-permissions.test.ts`; imap-server `commands/acl-rights.test.ts`,
  `server/imap-shared.test.ts` ("w3: folder permissions"), `server/imap-protocol.test.ts` (SETACL);
  webmail / BCP `lib/folderPermissions.test.ts`; e2e step `folder-permissions`
* e2e step `mailbox-mgmt` (GAL hidden, forwarding with / without copy, reject-from 550 on port 25, send-as copy in `Shared/<box>/Sent`, From of the own Sent copy of a webmail send as, audit filter, auto-mapping)
