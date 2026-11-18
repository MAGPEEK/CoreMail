# w2b-webmail-policies — changelog text (Keep a Changelog)

### Added
- **Webmail policies** on the server, domain and mailbox level (the resolution of the protocol
  switches: domain / mailbox `inherit | on | off`, the most specific wins; server two-state). New
  tables `webmail_policies` and `trusted_image_senders` (additive). Defaults keep today's behaviour.
  See `docs/webmail-policies.md`.
- **Module switches**: Kalender, Kontakte, Aufgaben, Notizen, Regeln, Signaturen, Kategorien,
  Gelöschte Elemente wiederherstellen, Passwort ändern (local accounts), Designs / Akzentfarbe,
  Externe Clients, App-Passwörter, Freigegebene Postfächer im Webmail. A module that is off is hidden
  in the webmail (rail, pages, settings sections, menus) and refused by the server: REST 403
  `FEATURE_DISABLED`, CalDAV / CardDAV 403 on the calendar / address book collections, ActiveSync
  MeetingResponse Status 2 without calendar, ResolveRecipients without personal contacts, app
  passwords cannot be listed or created (revoking stays possible).
- **Attachment and content policy**: blocked file types for the webmail download (403
  `ATTACHMENT_BLOCKED`; extension, declared type and content / magic bytes), "save only" types
  (download only, no inline display: `?inline=1` → 403 `INLINE_PREVIEW_DISABLED`), max. size per
  uploaded attachment (413 `ATTACHMENT_TOO_LARGE`, capped by the server value), external images
  "always ask" / "allow from contacts" / "always block" (image proxy 403
  `EXTERNAL_IMAGES_BLOCKED`).
- Messages carry `externalImages: load | ask | block` for the reader; trusted senders per user
  (address or `@domain`, `GET|POST|DELETE /api/v1/user/trusted-senders`), webmail button
  "Immer von diesem Absender" and Settings → Lesen → Externe Bilder.
- `GET /api/v1/user/features` (modules + content policy of the signed-in account), refreshed live by
  the user event `settings` / `policies` that every policy change sends to the accounts in scope.
- Admin API `GET|PUT /api/v1/admin/webmail-policies[/domains/:id|/users/:id]` with effective values
  and their source; audited as `settings.webmail-policy.update` (before/after). BCP page
  *Infrastruktur → Webmail-Richtlinien* and sections in the domain and mailbox dialogs.
- CLI `coremail policy show|set` (`--calendar off`, `--blocked-extensions exe,js`,
  `--max-upload-mb 20`, `--external-images block`, `--scope domain|user`).
- e2e step `policies`.

### Changed
- The tri-state level resolution of the protocol switches lives in
  `packages/storage/src/policy-levels.ts` and is shared with the webmail policies; the file
  extension rules of the inbound attachment filter moved to `packages/storage/src/file-types.ts`
  (same behaviour). Realtime settings section `policies` added.
- Inline (cid:) images are requested with `?inline=1`.

### Security (review)
- Module switches could be bypassed with a differently cased path: Express routes
  `/api/v1/Calendar/…` and `/dav/Calendars/…` case-insensitively to the module routers, the
  FEATURE_DISABLED gates compared case-sensitively. Both gates now compare lower-case.
- With the module "App-Passwörter" switched off, existing app passwords stop working on every mail
  protocol (IMAP, POP3, SMTP submission, ActiveSync, JMAP, CalDAV / CardDAV, MAPI): answered like a
  wrong password (no oracle, checked before the protocol switch); an unreadable policy is a
  temporary failure. Accounts whose module goes from on to off get the auth event
  `app-password-revoked` — live app-password connections end, credential caches drop the account.
  The primary password and web sessions are not affected; stored app passwords work again when the
  module is switched on. Accounts with MFA have no mail-protocol access while the module is off.
- File type matching folds compatibility characters (NFKC) and drops invisible format / control
  characters before taking the extension (`a.ex​e`, full-width `ｅｘｅ`, trailing bidi
  controls). Also applies to the inbound attachment filter (stricter only).
- An unexpected failure of the requireAuth policy checks answers 503 instead of leaving the request
  open.

## Review notes (independent review, 2026-11-18)

Verdict: **approve after fixes** (fixes on branch `review-webmail-policies`).

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | High | `featuresForRequest` (api-gateway `lib/webmail-features.ts`) matched case-sensitively; Express routes case-insensitively → `GET /api/v1/Calendar/events` reached the calendar router without the FEATURE_DISABLED check (every module). | Lower-case path; unit + routed regression test (`webmail-features.test.ts`). |
| 2 | High | Same for `davFeatureOf` (caldav-server `auth.ts`): `/dav/Calendars/…`, `/dav/AddressBooks/…` bypassed the calendar / contacts gate. | Lower-case path; tests in `auth.test.ts`. |
| 3 | Lead decision | App passwords kept working on the mail protocols with the module off. | `verifyMailCredentials` refuses `method app_password` (`invalid`, before the protocol switch; policy error → `error`); `updateWebmailPolicy` publishes `app-password-revoked` to accounts switched on → off (`appPasswordsSwitchedOff`, batch resolution `effectiveForUsers`); audit row carries `appPasswordsDisabled`. Tests `storage/src/webmail-policy-app-passwords.test.ts`, admin audit test, e2e check in `steps/policies.mjs`. |
| 4 | Low | `fileExtension` did not normalise Unicode: zero-width / bidi / NUL / full-width characters could hide an extension from the block list. | NFKC + strip `\p{Cf}\p{Cc}`; tests in `file-types.test.ts`. |
| 5 | Low | Policy cache: a load in flight during a per-user auth invalidation could cache a stale policy (only the global reload bumped the generation). | Auth invalidation bumps the generation too. |
| 6 | Low | `enforceWebmailSwitch` had no rejection handler — an exception in the checks left the request hanging (unhandled rejection). | Rejection → 503. |
| 7 | Info | protocol-access.ts refactor onto policy-levels.ts is behaviour-identical (every call site passes complete level records; server two-state, MAPI default off, JMAP server level from `ServerSettings.jmapEnabled`, unreadable → throw / temporary failure unchanged). | Exhaustive parity test against the pre-refactor resolver (`protocol-access.test.ts`). |
| 8 | Info | Trusted senders / contacts mode match the stored header `From` (forgeable). | Documented in `docs/webmail-policies.md` (impact: images load through the proxy — read tracking only). |
| 9 | Info | The block list covers the webmail download only (not IMAP / EAS / JMAP / raw source); archive contents are not inspected. | Documented. |
| 10 | Info | SSE user events (calendar / tasks / contacts) are still delivered with a module off — ids only, no content. | Documented; unchanged. |

Checked without findings: admin API RBAC (servers / domain readers / recipients +
`canManageAccount`), zod validation (strict, lists ≤ 200 × 32 chars, upload 1..10240, server level
refuses `inherit` / null), audit `settings.webmail-policy.update`, `CHANNEL_SETTINGS_RELOAD` + user
event `policies`; the upload limit is capped by the server value; attachment / upload / image-proxy
checks fail closed (503 / 500); the `imageDecisionFor` fallback `ask` is safe (the image proxy
re-checks `block`); trusted senders are per user only (no enumeration, ≤ 500).

Open: the BCP label "App-Passwörter" does not say that switching it off disables existing app
passwords on the mail protocols (UI text left to the lead).
