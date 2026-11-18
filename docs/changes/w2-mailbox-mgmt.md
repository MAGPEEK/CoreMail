# w2-mailbox-mgmt — changelog text (Keep a Changelog)

SemVer: MINOR (additive schema, new endpoints/fields/options; no removed or changed contract).

### Added
- Shared mailboxes: "Automatisch einblenden" per permission grant (`SharedMailboxPerm.autoMap`, `MailboxDelegate.autoMap`, default on). Without it the mailbox appears in the webmail folder pane and the IMAP `Shared/` / `Other Users/` listing only after the user adds it; access is unchanged. BCP, admin API (`autoMap` on the permission and delegate endpoints) and `coremail shared grant --no-automap`.
- Shared mailboxes: "Gesendete Elemente im freigegebenen Postfach ablegen", separately for send as and send on behalf (`sentCopySendAs`, `sentCopySendOnBehalf`) — a copy goes into the shared mailbox's Sent folder in addition to the sender's own, from webmail, SMTP submission, JMAP and ActiveSync (one helper, storage `afterForeignSend`). `coremail shared sent-copy`.
- Per-mailbox mail flow for user mailboxes and shared mailboxes (`MailFlowPolicy`): hide from the global address list (webmail GAL and autocomplete, ActiveSync GAL, JMAP principals), admin forwarding with or without a kept copy (loop-protected, bounces never forwarded), accept-only-from / reject-from lists (addresses or domains; 550 5.7.1 at SMTP RCPT/DATA and an NDR on every local delivery path), per-mailbox max receive size, and for users max send size and max recipients replacing the global limits. BCP "Nachrichtenfluss", `GET|PUT /api/v1/admin/{mailboxes,shared-mailboxes}/:id/mail-flow` (audited as `mailbox.mailflow.update`), `coremail mailbox flow` / `coremail shared flow`.
- Mailbox access audit (`mailbox.foreign.*`): delegates and shared mailbox users opening a foreign mailbox (aggregated: once per user, mailbox and client per hour), sending as / on behalf, deleting, moving and changing folders — from webmail, IMAP (SELECT/EXAMINE, EXPUNGE, CLOSE, MOVE, CREATE/RENAME/DELETE), JMAP (account use, Email/set, Mailbox/set), ActiveSync and SMTP sends. Switch and retention in BCP → Einstellungen → Sicherheit (`mailboxAccessAuditEnabled`, `mailboxAccessAuditRetentionDays`, default 180 days, hourly purge of these entries only), BCP audit-log filter "Postfachzugriffe" (`?category=mailbox-access`), and webmail Settings → Sicherheit "Zugriffe auf mein Postfach" (`GET /api/v1/user/mailbox-access-log`).
- e2e step `mailbox-mgmt`; docs `docs/mailbox-management.md`.

### Changed
- `GET /api/v1/user/accessible-mailboxes` entries carry `autoMap`; `hidden` is also true for a grant without auto-mapping the user has not added yet.
- The 9.3 webmail foreign-mailbox audit (`mailbox.foreign.*` writes) now goes through the storage mailbox access audit: `changes.source` is set and it follows the new mailbox access audit switch.
- Local delivery has a new refusal outcome `policy` (NDR 5.7.1) next to `unknown` and `quota` (delivery ledger, local NDRs, outbound worker).

### Fixed (review)
- Webmail send as / on behalf of a Shared Mailbox: the sender's own Sent copy showed the user's address as From and no Sender. It is now built from the same message as the outbound job (From = the box, Sender = the user for on behalf, the job's Date and Message-ID, plus Bcc).
- Mailbox access audit: the hourly `open` aggregation is shared across processes (Redis `SET NX EX` on the shared client) with the per-process window as fallback while Redis is unavailable.
- ActiveSync: a message over the sender's per-mailbox size limit is refused with Status 122 (AttachmentIsTooLarge, the MS-ASCMD size status) instead of 120; protocol 12.1 devices get HTTP 413 instead of 500 (no endless resend). Too many recipients stays 120 (no specific status exists).
- Accept-only-from no longer refuses a null reverse-path at RCPT TO before the header From: is known (now judged at DATA / delivery, as documented).
- The server's own DSNs / NDRs and dead-letter notices reach mailboxes with accept-only-from / reject-from lists or a receive size limit.
- Admin forwarding of an S/MIME message that was decrypted for storage forwards the received (encrypted) message instead of the plaintext; a Shared Mailbox's forwarding job no longer carries the box id as sender user id.
- JMAP: a submission from a Shared Mailbox account is audited as send as / on behalf (audit only — the Email is already in that mailbox).
