# w2-hygiene-eas — changelog text (Keep a Changelog)

SemVer: MINOR (new BCP settings and features, additive schema). Behaviour changes worth a
release note are listed under "Changed"; none removes an endpoint or a setting.

### Added
- BCP → Schutzfilter → **Absenderlisten**: sender block and allow lists per scope (global,
  domain, mailbox) with EXACT / WILDCARD / REGEX patterns, search, on/off per entry, CSV export and
  an all-or-nothing CSV import (`/api/v1/admin/security/sender-lists`, hygiene permission, every
  change audited as `security.sender-list.*`). New column `Blacklist.listType` (`BLOCK` | `ALLOW`,
  default `BLOCK` — additive).
- Sender lists are enforced per recipient at RCPT TO (`550 5.7.1`, before greylisting); the most
  specific scope decides (mailbox > domain > global), ALLOW wins within a scope. An allow-listed
  sender skips the spam verdict only when its envelope domain is authenticated (SPF/DKIM);
  SPF/DKIM/DMARC, attachment filter and virus scan always apply.
- BCP → Schutzfilter → **Spoofing**: the local-domain anti-spoofing action, the trusted senders
  and the trusted ARC sealers are BCP settings (`/api/v1/admin/security/spoofing`, audited as
  `settings.spoofing.update`, applied at once through the settings reload). New columns
  `SecuritySettings.localSpoofAction` / `localSpoofAllow` / `arcTrustedSealers` (additive). The
  9.0 environment variables `LOCAL_SPOOF_ACTION`, `LOCAL_SPOOF_ALLOW`, `ARC_TRUSTED_SEALERS` keep
  working and override the BCP value when set (shown read-only in the BCP).
- DNSBL zones with the action **Score** (`SCORE_ONLY`) now add their weight to the spam score of
  the message (before: no effect) — only with rspamd active and not for SMTP AUTH sessions. The
  BCP disables the option when rspamd is not deployed.
- BCP → Einstellungen → Sicherheit → **API-Ratenbegrenzung**: the global api-gateway limit is
  configurable (on/off, window, per user, per IP; new `ServerSettings.apiRateLimit*` columns,
  additive) and can be overridden by `API_RATE_LIMIT_ENABLED` / `_WINDOW_MIN` / `_PER_USER` /
  `_PER_IP`.
- ActiveSync: Ping without `X-MS-PolicyKey` is served for a known device in status OK with a final
  policy key ([MS-ASPROV]: Ping does not carry the policy key).
- ActiveSync: retries of SendMail / SmartReply / SmartForward without ClientId (always in 12.1)
  are recognised by Message-ID + device for 10 minutes and not sent twice.
- One storage helper for the maximum outgoing message size (`maxOutgoingMessageBytes`, the
  stricter of the SMTP and the global setting) used by REST `/mail/send`, JMAP and ActiveSync.
- e2e: `admin` checks sender-list blocking at RCPT TO, the spoofing setting reload and the API
  rate-limit configuration; `eas-legacy` checks Ping without policy key, the size limit (applied at
  once after the settings save) and the request-body cap.

### Changed
- The global API rate limit counts signed-in requests per **user** (default 3000 per 15 min) and
  anonymous requests per IP (default 500 per 15 min, as before); static files and the live-event
  stream (valid tickets) no longer count; the one-time stream ticket counts per user. Protocol
  clients with Basic authentication (ActiveSync, CalDAV/CardDAV, JMAP) still count per IP. Before:
  500 per 15 min per IP for everything, so users behind one NAT address shared one budget.
- ActiveSync 14.x: a successful SendMail / SmartReply / SmartForward returns an **empty response**
  (HTTP 200, no body) as [MS-ASCMD] 2.2.1.17 specifies; before it returned `<Status>1</Status>`.
  Failures keep the `<Status>` body.
- ActiveSync: a message above the configured maximum message size (including the original appended
  by SmartReply / SmartForward) is refused with Status 122 AttachmentIsTooLarge (14.x) / HTTP 413
  (12.1) — the size status of [MS-ASCMD] 2.2.2 (115 SendQuotaExceeded is a quota).
- ActiveSync: the request-body cap follows the maximum message size (× 4/3 + 1 MB protocol margin,
  at most 150 MB) instead of a fixed 25 MB; a larger configured size now works over ActiveSync, a
  smaller one also limits the request bodies. A settings save applies the size limit at once in
  ActiveSync, JMAP and the REST API (before: up to 60 s cache).
- JMAP: `EmailSubmission/set`, `Email/import` and `Email/set` create refuse a message above the
  maximum message size with SetError `tooLarge` (+ `maxSize`).
- Installations with DNSBL zones set to „Score“ (built-in: PSBL, weight 3) see these weights in
  the spam score — a message close to the Junk threshold may now land in Junk.

### Fixed
- Domain- and mailbox-scoped sender-list entries were never applied (the security filter only
  received global context); the BCP had no UI for the sender lists at all.
- The DNSBL action „Score (rspamd)“ had no effect.
- Review fixes: environment-set spoofing / API rate-limit fields are read-only in the BCP (the
  spoofing page shows the value in effect and no longer saves it); a sender-list change that would
  duplicate another entry is refused (409).
