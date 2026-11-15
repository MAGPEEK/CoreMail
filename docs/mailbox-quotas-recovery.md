# Mailbox quotas, Recover deleted items, Out of office (v8.1)

CoreMail follows the Exchange 2019 mailbox model for these three features.

## Quota levels

| Exchange | CoreMail field | Effect |
|---|---|---|
| IssueWarningQuota | `quotaWarningBytes` (User / SharedMailbox) | warning mail into the mailbox, at most once per 24 h |
| ProhibitSendQuota | `quotaProhibitSendBytes` | the mailbox can no longer send |
| ProhibitSendReceiveQuota | `quotaBytes` (the existing mailbox quota; 0 = unlimited) | receiving is refused as well |

A level left empty (`null`) uses the server default: a percentage of `quotaBytes`
(`ServerSettings.quotaWarningPercent`, default 83, and `quotaProhibitSendPercent`,
default 87, the Exchange ratios 1.9 / 2.0 / 2.3 GB).

Usage = the size of all live messages of the mailbox (deleted items and
"Recoverable Items" folders are not counted). It is computed once per mailbox
and process and cached for `QUOTA_USAGE_CACHE_SEC` seconds (default 60), then
adjusted on every delivery, so deliveries never scan the mailbox. The value is
written back to `usedBytes`.

Enforcement:

- **Sending** (usage ≥ prohibit-send): SMTP submission (587/465) answers MAIL FROM
  with `552 5.2.2`; `POST /api/v1/mail/send`, send-from-draft and the undo-send
  hold (`performSend()`) answer `403 {code: "MAILBOX_QUOTA_EXCEEDED"}`; JMAP
  `EmailSubmission/set` returns the SetError `overQuota`; ActiveSync
  SendMail/SmartReply/SmartForward return Status 113 (MailboxQuotaExceeded).
- **Receiving** (usage ≥ prohibit-send-receive): port 25 refuses at RCPT TO;
  every other local delivery (submission, outbound worker for MWA/JMAP/EAS,
  rule redirects) is not stored and the sender gets an NDR with status 5.2.2.
  `QUOTA_FULL_PERMANENT` selects the reply code at RCPT TO:
  - unset / `true` (default, like Exchange): `552 5.2.2`
  - `false`: `452 4.2.2` (the sending MTA retries)
  - a number ≥ 100: `452 4.2.2` while usage is below that percentage of the quota, `552 5.2.2` above
- A database error never blocks mail flow (fail-open, logged).

Admin: `PUT /api/v1/admin/mailboxes/:id` and `PUT /api/v1/admin/shared-mailboxes/:id`
accept `quotaWarningBytes` / `quotaProhibitSendBytes` (`null` = server default;
warning ≤ prohibit-send ≤ quota is enforced). Server defaults:
`GET/PUT /api/v1/admin/mailboxes/quota-defaults`. CLI:
`coremail mailbox quota <user> 10GB --warning 8GB --prohibit-send 9GB`
(`default` resets a level). BCP: mailbox edit modal + detail panel.

Users: `GET /api/v1/user/quota` (usage, level, limits); the web client shows a
usage bar under the folder tree (amber at the warning level, red when blocked).

## Recover deleted items

Every user deletion keeps a soft-delete tombstone (message-store `expunge()`:
row, raw message object and attachments stay): IMAP EXPUNGE, JMAP Email/set
destroy, ActiveSync Delete, POP3 DELE, and — since v8.1 — deleting in the Trash,
emptying Trash/Junk and `DELETE /mail/messages/:id?hard=true` in the web client.
Tombstones are recoverable for `DELETED_ITEM_RETENTION_DAYS` (default 14;
`0` keeps them until purged by hand). Items the Managed Folder Assistant moved
to "Recoverable Items/Deletions" are listed and restorable too.

- `GET /api/v1/mail/recoverable[?q=&limit=]`
- `POST /api/v1/mail/recoverable/restore {ids, folderId?}` — back into the folder
  the item was deleted from (Trash or retention → INBOX), or `folderId`. Restored
  items get NEW UIDs and a new modSeq through the message store
  (`restoreMessages()`), so IMAP (CONDSTORE/QRESYNC), JMAP and ActiveSync see
  them as new messages; the old UID is never reused.
- `POST /api/v1/mail/recoverable/purge {ids}` — permanent removal
- Admin: `POST /api/v1/admin/mailboxes/:id/recoverable/purge {ids?}` (audited)

The api-gateway removes tombstones past the retention hourly (Redis lock
`storage:deleted-items-purge:lock`). No modSeq is allocated for that: tombstones
are already invisible, QRESYNC reports UIDs without a row as vanished, and JMAP
counts only live rows. Raw message and attachment objects are content-addressed
and never removed by the object-storage cleaner (it only expires temporary
prefixes), so the content is available for the whole retention window. There is
no legal-hold feature (removed in v3.18.5) that could extend the retention.

Web client: Settings → "Gelöschte Elemente wiederherstellen" and the Trash
folder context menu.

## Out of office

`UserSettings.oof*`: separate internal/external texts, external replies on/off,
"external only to my contacts", optional schedule (start/end). All writers (MWA
`PUT /api/v1/user/oof`, JMAP VacationResponse/set, ActiveSync Settings Oof) save
through `saveOofSettings()`, which renews `oofPeriodId` whenever OOF is switched
on or its texts/schedule change.

Each sender gets exactly ONE reply per OOF period: the Redis marker
`oof:sent:<user>:<period+texts hash>:<sender hash>` lives until the scheduled end
(+1 day), for an open-ended OOF for `OOF_REPLY_MEMORY_DAYS` (default 366), never
less than the RFC 3834 7 days.

Never answered (RFC 3834): null sender, the user's own addresses, automated
senders (MAILER-DAEMON, noreply/no-reply/donotreply, `*-request`, `owner-*`,
bounces), `Auto-Submitted` ≠ `no`, `Precedence: bulk|list|junk`, any `List-*`
header, `X-Auto-Response-Suppress: All|OOF`, mail delivered to Junk, and mail
that does not name the user in To/Cc/Bcc/Resent-*.

## Environment

| Variable | Default | |
|---|---|---|
| `QUOTA_FULL_PERMANENT` | `true` | RCPT TO reply when the mailbox is full (see above) |
| `QUOTA_USAGE_CACHE_SEC` | `60` | usage cache per process |
| `DELETED_ITEM_RETENTION_DAYS` | `14` | recovery window; `0` = never purge automatically |
| `OOF_REPLY_MEMORY_DAYS` | `366` | reply memory for an open-ended OOF period |
