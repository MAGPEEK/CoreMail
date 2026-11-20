# Per-account send rate for every submission path

Change note for the next release (Keep a Changelog). Version classification is up to the
release lead (target 10.5.0 — additive schema, new settings, compatible behaviour).

### Added

- **Hourly send rate per account across every submission path** — SMTP submission
  (587/465), webmail / REST (`/mail/send`, draft send, undo hold), ActiveSync SendMail /
  SmartReply / SmartForward, JMAP `EmailSubmission/set` and MAPI `RopSubmitMessage` share one
  limiter (`packages/storage/src/submission-rate.ts`) that counts the messages **and** the
  recipients an account sends per sliding hour. Defaults: 200 messages / 1000 recipients per
  hour, on. Settings in BCP → SMTP & Routing → **Sendelimit** (new ServerSettings columns
  `sendRateLimitEnabled`, `sendRateMessagesPerHour`, `sendRateRecipientsPerHour`,
  `sendRateBlockOnExceed`; admin API `GET/PUT /api/v1/admin/smtp-config/send-rate`, audited as
  `settings.send-rate.updated`); per account in the mailbox's Nachrichtenfluss
  (`MailFlowPolicy.maxMessagesPerHour` / `maxRecipientsPerHour`, user mailboxes only). Mail
  sent as / on behalf of a Shared Mailbox counts against the sending user.
- Protocol answers (all temporary): SMTP `451 4.7.1` at the end of DATA and — once the
  account is at its message limit or blocked — at `MAIL FROM`; REST `429` + `Retry-After`,
  code `SEND_RATE_LIMITED`; ActiveSync Status `111` ServerErrorRetryLater (12.1: HTTP `503`,
  the retry key is released); JMAP SetError `rateLimit`; MAPI `ecQuotaExceeded`.
- Option **"Konto bei Überschreitung vorübergehend für den Versand sperren"** (default off):
  after the first refusal the account may not send at all for one hour.

### Security

- **Compromised-account alert**: the first time an account hits the limit within an hour it
  gets an audit entry `mail.send.rate-limited`, an `AttackEvent` of type `SEND_RATE_LIMIT`
  (BCP dashboard) and a notice „Konto X hat das Sendelimit erreicht — möglicherweise
  kompromittiert" in the inbox of the organisation's administrator address (`adminEmail`
  when it is a local mailbox, else the ORGANIZATION_MANAGEMENT admins) — at most one per
  account and hour across all processes.
- Counting in Redis (sliding-window counter, check + increment in one Lua script); Redis
  unavailable → per-process counter with a log line (fail-open across processes), an
  unexpected limiter error never blocks mail.

### Notes

- The existing REST burst limit `MAIL_SEND_RATE_LIMIT` (30 requests / 60 s) is unchanged; it
  counts requests per minute, the new limiter counts sent messages per hour.
- Schema change is additive (4 ServerSettings columns, 2 MailFlowPolicy columns, all with
  defaults / nullable) — schema-sync applies it without data loss.
- Docs: docs/mail-protocol-limits.md (new section), docs/smtp.md, docs/mailbox-management.md,
  docs/api-gateway-security.md.
