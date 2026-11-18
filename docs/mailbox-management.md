# Mailbox management (9.4)

Three features for user mailboxes and Shared Mailboxes:

1. **Shared mailbox grants** — auto-mapping per grant and separate "save sent
   items in the shared mailbox" switches for *send as* and *send on behalf*.
2. **Per-mailbox mail flow** — hide from the address list, admin forwarding,
   accept-only-from / reject-from lists and limits that replace the global ones.
3. **Mailbox access audit** — what delegates and Shared Mailbox users do in a
   mailbox that is not their own, from every client, with aggregation and a
   retention setting; the owner sees it in webmail Settings → Sicherheit.

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
  a message without any sender (null reverse-path and no From:).
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
* **Send limits** — a per-mailbox value replaces the global one: webmail
  (`413`, recipients `400`), SMTP submission (`552 5.3.4` / `550 5.5.3` at DATA),
  JMAP (`tooLarge` / `tooManyRecipients`), ActiveSync (size → Status 122
  AttachmentIsTooLarge, the only size status of the MS-ASCMD common status codes;
  recipients → 120 MailSubmissionFailed, as there is no specific code; protocol
  12.1: HTTP 413 / 500). The
  listener-level message size (SMTP `SIZE`, the webmail request limit) stays the
  transport's upper bound: a per-mailbox value above it has no effect beyond it.
* **Forwarding** — like a rule `forward`: `Resent-*` fields, envelope sender =
  the forwarding mailbox (aligned with our SPF/DKIM, no SRS), queued through the
  outbound queue before the local copy is committed (a transaction retry does
  not forward twice). Loop protection: a message that already carries
  `X-CoreMail-RuleForwarded` (forwarded by a rule or an admin forwarding) is not
  forwarded again and is always kept locally; null-sender messages (bounces,
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
  type per hour across all processes: `SET NX EX` on the shared Redis client
  (`claimShared()`); a key the process already holds is answered without Redis.
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

## Tests

* storage: `mail-flow.test.ts`, `mailbox-access-audit.test.ts`, `shared-sent-copy.test.ts`, `mailbox-access.test.ts`
* smtp-server: `handlers/mail-flow-enforcement.test.ts` (RCPT, DATA, local delivery, NDR, forwarding plan, submission limits, foreign-send step)
* imap-server: `server/imap-shared.test.ts` (auto-mapping in LIST, audit of SELECT / EXPUNGE / MOVE / folder changes)
* jmap-server: `mailbox-mgmt.test.ts`; activesync: `commands/directory-hidden.test.ts`, `commands/send-mail.test.ts`
* api-gateway: `routes/mailbox-mgmt.test.ts`, `routes/contacts.test.ts`; cli: `commands/mail-flow.test.ts`
* BCP `lib/mailFlow.test.ts`, webmail `lib/mailboxAccessLog.test.ts`
* e2e step `mailbox-mgmt` (GAL hidden, forwarding with / without copy, reject-from 550 on port 25, send-as copy in `Shared/<box>/Sent`, From of the own Sent copy of a webmail send as, audit filter, auto-mapping)
