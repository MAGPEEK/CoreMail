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
