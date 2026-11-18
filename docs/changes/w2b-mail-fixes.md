# w2b-mail-fixes — changelog text (review fixes: mail flow, ingress, IDN, EAS, realtime)

SemVer: PATCH. No schema or configuration change, no removed endpoint. Additive exports:
`@coremail/storage` (`INTERNAL_MAIL_HEADERS` now complete + `RULE_FORWARDED_HEADER`,
`internalHeadersExcept`, IDN helpers `canonicalAddress` / `canonicalDomain` /
`canonicalAddressPattern` / `domainVariants` / `addressVariants`, subpath `@coremail/storage/idn`,
`CRLF_STREAM_TRANSPORT` / `buildCrlfMime`, `evaluateSubmissionSender` /
`checkSubmissionSenderIdentity`), `@coremail/core` settings section `security` for realtime
`settings` events, outbound job field `ruleForward`.

### Security
- Inbox-rule forwards and redirects of an S/MIME message that was decrypted for storage now send
  the original encrypted message (like the admin forwarding) — the plaintext never leaves the server.
- Scheduled sends, undo-send holds and delayed JMAP submissions are checked again for send-as /
  send-on-behalf rights and the sender identity when they are sent. With revoked rights (or a
  deactivated account) nothing is sent; the sending user gets an NDR (5.7.1) in their own mailbox,
  the scheduled message is shown as cancelled and the job fails without a second NDR. The NDR
  names only the recipients still open (not those delivered on an earlier attempt), and an admin
  "Retry" of the failed message sends no further NDR.
- Internal `X-CoreMail-*` headers (rule-forward loop protection, draft pending recipients,
  quarantine release trace, virus-scan verdict) are one complete list and are stripped at every
  ingress before any rule or forward is evaluated: port 25, device relay, SMTP submission and the
  local delivery of webmail / JMAP / ActiveSync submissions. An external sender can no longer
  suppress the admin forwarding or influence internal logic with a forged header; the genuine
  headers CoreMail adds afterwards (and the loop header of its own rule forwards) are kept.
- The ActiveSync WBXML decoder has explicit nesting-depth (64) and node-count (100 000) limits; a
  hostile body is answered with HTTP 400 instead of deep recursion. Runs of code-page switches are
  no longer read recursively.

### Fixed
- Internationalized domains: sender block / allow lists (global, domain, mailbox scope, webmail
  junk senders) and the per-mailbox accept-only-from / reject-from lists compare addresses in one
  canonical form (lower case, domain as punycode) — an entry in Unicode spelling matches a sender
  in punycode spelling and vice versa, both spellings are one entry, Unicode domains are accepted
  as entries, and recipients (RCPT TO) and domain / mailbox targets are found in either spelling.
  A sender-list entry whose domain is no valid internationalized domain name is refused (400), and
  marking mail as junk again no longer adds a second entry next to one in Unicode spelling.
- Sender identity checks (SMTP submission, JMAP, ActiveSync, MAPI and the send-time re-check of
  held messages) accept an allowed address in either spelling of an internationalized domain — the
  webmail writes the punycode spelling into From / Sender, so a scheduled send from an address
  stored in Unicode spelling was cancelled.
- Generated messages use CRLF line ends everywhere: JMAP Email/set built bare LF line ends, and
  out-of-office replies with multi-line text kept bare LF. Every in-memory MIME builder now uses
  one shared option (a repository test guards against new builders without it).
- A changed mailbox permission or delegation (including auto-mapping) updates the grantee's open
  webmail folder pane at once.
- Ending one or all other sessions and saving the S/MIME options update the user's other open
  webmail tabs and devices at once (Settings → Sicherheit).
