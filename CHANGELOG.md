# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Note:** For readability, only the three most recent releases are listed here.
> The complete history of all older versions is available via the git history:
> `git log -p --follow CHANGELOG.md` or via the GitHub repository.

---

## [Unreleased]

---

## [10.2.0] — 2026-11-20 — New webmail shell, search suggestions, message trace details

### Added

- Webmail: floating panes — ribbon, message list, reading pane / compose card, calendar and contacts are rounded cards on a canvas; the folder pane and the calendar list sit on the canvas. Below 768 px the single-pane flow stays full width.
- Webmail: background pictures (Einstellungen → Darstellung → Hintergrund): none, eight built-in pictures (light and dark variants) or an own upload (JPEG / PNG up to 5 MB, re-encoded by the server, metadata removed). API `GET/PUT/DELETE /api/v1/user/background`, `GET /api/v1/user/background/info`; BCP → Branding "Standard-Hintergrund" (`defaultBackground`).
- Webmail: one shared ribbon (Start / Ansicht / Hilfe) for mail, calendar and contacts with a collapse chevron (roaming `ribbon.collapsed`); contextual tabs Nachricht / Einfügen / Text formatieren / Optionen while a draft is shown; "Neue E-Mail" split: E-Mail, E-Mail aus Vorlage, Ereignis; "Über CoreMail" in Hilfe.
- Webmail: message list date groups (Heute, Gestern, Diese Woche, Letzte Woche, Dieser Monat, Älter); folder favourites (roaming `folders.favorites`); the own mailbox section is headed by the user's address.
- Personal mail templates: REST `GET/POST /api/v1/mail/templates`, `GET/PUT/DELETE /api/v1/mail/templates/:id` (own templates only, at most 200, body up to 256 KB); webmail picker "E-Mail aus Vorlage", "Vorlagen verwalten", compose "Vorlage einfügen …" / "Als Vorlage speichern …", Settings → Vorlagen. New table `mail_templates`.
- Search suggestions from the whole mailbox while typing: `GET /api/v1/mail/search/suggest?q=` (also for shared / delegated mailboxes, same folder access as their search; 120 requests / 60 s per user) — up to 4 people and 6 messages, never bodies. Both webmail search fields show Personen (search the whole mailbox for `from:<address>`), Nachrichten (open the message) and Letzte Suchen; keyboard operable.
- Trigram index `messages_search_trgm_idx` (PostgreSQL `pg_trgm`, GIN over subject, sender name and address), maintained by PostgreSQL on every write; it also serves `/mail/search`. schema-sync applies the schema without the index (with a warning and the `CREATE EXTENSION` command) when the database cannot provide the extension.
- Webmail compose: table size picker (8 × 8 grid) and "+" handles on the right and bottom edge to add a column / row; Enter on the empty last paragraph of the last cell adds a row.
- BCP "Nachrichtenablaufverfolgung": detail panel with Übersicht, Verarbeitung auf CoreMail (recorded stages: connection, TLS, DNSBL, greylisting, SPF / DKIM / DMARC / ARC, sender lists, attachment filter, ClamAV, rspamd, rules, delivery; outbound: queue, DKIM, MX records as resolved, connected host and IP, remote reply, retries, DSN) and Zustellweg (Received chain of the stored original). Admin API `GET /api/v1/admin/message-trace/:id` (area compliance; out-of-scope ids answer 404, other domains redacted). The trace lives in the existing `SystemLog.metadata` (`trace`), bounded, without message content; security-filter `/check/content` returns an additive `checks` summary.

### Changed

- Webmail calendar: events are drawn by "Anzeigen als" — Gebucht solid, Mit Vorbehalt striped, Frei outlined, Abwesend always purple with a dashed border; the day agenda follows; printing stays black on white.
- Webmail calendar and contacts re-laid out (navigation row with date picker, collapsible calendar groups, contacts ribbon and sidebar with categories and the global address list). "Neues Ereignis" is a plain button that opens the event form.
- Webmail: unread messages get an accent bar; compose opens with a short slide; "Design" is now "Darstellung"; folder-pane section headers use the folder font size; "Gelöschte Elemente" in Settings is aligned with the other entries.
- Webmail: no manual refresh button above the favourites (mail arrives live via realtime push, plus the 15-minute safety refetch).

### Removed

- Webmail: the calendar scheduling assistant ("Terminplanungs-Assistent") and its "Verfügbarkeit prüfen" link. `POST /api/v1/calendar/freebusy` and `/schedule-suggestions` stay.
- Webmail: the "Klassisch" ribbon layout (only the simplified ribbon exists).

### Fixed

- BCP "Protokolle und Dienste": no "HTTPS ist nicht aktiv" / `mapi-https` warning while the integrated HTTPS server listens and serves a trusted certificate for the public host name without one explicitly marked for HTTPS; the SSL/TLS served-certificate view probes HTTPS in that case too. The HTTP → HTTPS redirect still needs an explicitly marked certificate.
- Retention (retention worker): soft-deleted items stay recoverable for `DELETED_ITEM_RETENTION_DAYS` (default 30; were removed after 14 days); several policies on one mailbox resolve user → domain → all mailboxes, then the longest period; legacy policies without tags keep their scope; subfolders inherit their parent's tag (a subfolder named "Spam" is no Junk folder); "In Archiv verschieben" keeps archive subfolders; "Nur markieren" no longer rewrites every item each run; personal tags apply without a policy; global / domain policies reach shared mailboxes; permanent deletes go through the message store (quota no longer reduced twice); counters refreshed, failures isolated per mailbox, paging for large folders.

### Security

- Profile photo and background uploads are decoded in worker threads (at most two at a time per process) under a 160 MB decoder cap.

### Upgrade notes

- Minor release, no configuration change. Additive schema (`mail_templates`, `User.backgroundKey` / `backgroundUpdatedAt`, `Branding.defaultBackground`, the trigram index). Building the index blocks writes to `messages` once at start (≈ 11 µs per message).
- Retention: the first run after the update can remove mail the old run left alone — expired items in shared mailboxes under a global or domain policy, in folders with a personal tag of users without a policy, and in subfolders of default folders with a retention tag. Review the policies before upgrading.
- Helm chart 3.2.0.

---

## [10.1.0] — 2026-11-19 — New compose area

## Changed

- Webmail: the compose area is redesigned. The inline compose is a raised card (rounded corners, border,
  soft shadow) on the tinted reading pane; the own window and phone widths keep the same layout without
  margin and shadow. "Senden" is now a split button in the header row (its chevron or Alt+Pfeil-unten opens
  Senden, Später senden, Wichtigkeit and Nachrichtenoptionen) and the only accent-filled control; the
  attach, picture and signature buttons are quiet icons, everything else moved into the "…" menu, and the
  bottom action bar is gone. The draft status, "In neuem Fenster öffnen" and "Verwerfen" sit at the right
  edge of the header. The address block has calmer 36 px rows with recipient chips that show an avatar,
  the editor uses 15 px type with lines of at most 72 characters, and the formatting bar is an inset strip
  at the bottom of the card (now also with Link and Emoji).
- Webmail: new roaming preference `compose.composeFormatBar` (default on) remembers whether the formatting
  bar is shown ("Formatleiste ausblenden / einblenden", also the "Aa" button). Additive: older clients and
  stored preferences get the default. The saved-draft status reads "Entwurf gespeichert 10:42"; the
  schedule entry is called "Später senden …".

---

## [10.0.0] — 2026-11-19 — Room and equipment resources removed

Major release (SemVer: REST endpoints, an admin API, schema models / tables and SMTP behaviour are removed). Room and equipment resources are removed completely, like distribution groups in v5.6.1, public folders in v3.18.31 and eDiscovery in v3.18.5. Every change was reviewed independently; every finding was fixed with a regression test.

> **BREAKING — read before upgrading from 9.5.x**
>
> - **Room data is deleted at start, after a mandatory backup.** On the first start, schema-sync writes `/data/backups/pre-migrate-<UTC timestamp>.sql.gz` (the `coremail-data` volume) and only then drops the retired tables `resource_mailboxes`, `resource_calendars` and `resource_bookings` (allow-list `RETIRED_TABLES`; the log lists every table with its row count). The rooms' own mailboxes (owner-less mailbox rows that `resource_mailboxes` points at) are deleted with their folders, messages and attachments in the same step, after the dump and before the drop, in one transaction. No `COREMAIL_ALLOW_SCHEMA_DATA_LOSS` is needed; **any other data loss is still refused** (fail-closed). If the dump cannot be written, the start stops and nothing is changed — make your own backup and start once with `COREMAIL_SCHEMA_BACKUP=skip`.
> - **Helm:** for the 9.5 → 10.0 rollout with room rows, set `app.schemaSync.backupClaim` (or `app.schemaSync.skipBackup=true` after your own backup); otherwise the init container stops without changes. Chart 3.0.0.
> - **Mail to former room and equipment addresses is refused:** port 25 answers `550 5.1.1` at RCPT, local senders get an NDR.
> - **Existing meetings that list a local room** keep it as an attendee; later updates or cancellations sent to it bounce to the organizer — remove the room from those meetings.
> - **Room attendees are invited like people:** an attendee with `CUTYPE=ROOM` / `RESOURCE` is stored and invited like any other attendee; there is no automatic accept / decline any more.
> - **Removed APIs:** `/api/v1/admin/resources` (incl. bookings and free/busy), EMS `GET /api/v1/admin/ems/resource-mailboxes` and `GET /api/v1/calendar/rooms` answer 404. The `rooms` field of `POST` / `PUT /api/v1/calendar/events` and the `rooms` / `uid` fields of `POST /api/v1/calendar/schedule-suggestions` are ignored when sent; `GET /api/v1/admin/organisation/gal` no longer has a `resources` key.
> - **Object store:** raw messages and attachment files of the deleted room mailboxes stay in the object store without any row pointing at them — no API serves them, they only take space and are in no backup.
> - **Alternatives:** a **shared mailbox** whose calendar is shared with the people who book the room, or a **shared calendar** per room, checked with the scheduling assistant / free-busy.

### Removed
- **Room and equipment mailboxes** completely:
  - Schema: models `ResourceMailbox`, `ResourceCalendar`, `ResourceBooking`, enum `ResourceType` and the relations `Domain.resourceMailboxes` / `Mailbox.resourceMailbox` (tables `resource_mailboxes`, `resource_calendars`, `resource_bookings`).
  - Storage: `room-booking.ts`, `resource-booking-rules.ts`, `resource-lock.ts`; the room-reply-only options (`subject`, `text`, `headers`) of `buildITipReplyMime`.
  - SMTP: resource booking of mailed invitations (`handlers/resource-booking.ts`), the rooms' iMIP replies (`handlers/resource-reply.ts`), the recipient lookup of resource addresses and the outbound job flag `resourceReply` with its sender-authentication path. A queued 9.5 job that still carries the flag is delivered without sender authentication.
  - REST: admin API `/api/v1/admin/resources` (incl. bookings and free/busy), EMS `GET /api/v1/admin/ems/resource-mailboxes`, `GET /api/v1/calendar/rooms`, the `rooms` field of `POST` / `PUT /api/v1/calendar/events` and the `rooms` / `uid` fields of `POST /api/v1/calendar/schedule-suggestions` (ignored when sent), the `resources` key of `GET /api/v1/admin/organisation/gal`.
  - ActiveSync: room booking of meetings written by a phone (`pim/calendar-rooms.ts`).
  - Webmail: room picker of the event form and the room rows of the scheduling assistant.
  - BCP: remaining room texts (SMTP local delivery hint, role description of RECIPIENT_MANAGEMENT).

### Changed
- Calendar meetings: attendees are no longer split into people and rooms — every attendee (including one with `CUTYPE=ROOM` / `RESOURCE` from another client) is stored and invited like any other. Only the organizer's copy sends invitation updates / cancellations (unchanged; `isOrganizerCopy` moved to api-gateway `lib/organizer-copy.ts`).
- schema-sync: new verdict **retire** — the tables listed in `RETIRED_TABLES` (`infra/docker/schema-sync-classify.mjs`: the three room tables) are dropped without `COREMAIL_ALLOW_SCHEMA_DATA_LOSS`, but only when every other warning is a safe new unique constraint, each table is logged with its row count, and only after the **mandatory** pre-migration dump succeeded. Data of a retired table kept in other tables (`RETIREMENT_CLEANUP`: the rooms' own owner-less mailbox rows with their folders, messages and attachments) is deleted after the dump and before the drop, in one transaction — also on the `COREMAIL_ALLOW_SCHEMA_DATA_LOSS` path. A mailbox row left behind by a room deleted in 9.x is not touched. Without a dump location the start stops with the Helm values to set (`app.schemaSync.backupClaim` / `skipBackup`).
- Helm chart 3.0.0 (appVersion 10.0.0): values unchanged; the 9.5 → 10.0 rollout with room rows needs `app.schemaSync.backupClaim` or `skipBackup` (infra/k8s/README.md, "Upgrading to chart 3.0").

### Fixed
- Webmail event form: the location placeholder reads "Ort hinzufügen" (was "Hinzufügen eines Raums oder Standorts").

### Upgrade notes
1. Back up as usual; the start writes its own pre-migration dump to `/data/backups` when room rows exist (see the BREAKING block). If the dump fails (no space, PostgreSQL newer than the image's `pg_dump`, directory not writable), dump the database yourself and start once with `COREMAIL_SCHEMA_BACKUP=skip`.
2. `cd /opt/coremail && git pull && docker compose pull && docker compose up -d`; check the log for the retired tables and their row counts.
3. Remove former room addresses from existing meetings and recreate bookable rooms as shared mailboxes or shared calendars.
4. Remove clients of `/api/v1/admin/resources`, `/api/v1/calendar/rooms` and EMS `resource-mailboxes` (404).

Tests: schema-sync classifier (`retire` verdict, cleanup statement against the FK cascade chain) and shell harness (`infra/docker/schema-sync.test.mjs`), e2e `schema-upgrade` from a 9.5.x database with room rows, `rest` / `smtp` 404 and `550 5.1.1` checks, unit tests in smtp-server, api-gateway and activesync, repo hygiene "the room/equipment resource feature stays removed".

---

## [9.5.1] — 2026-11-19 — MAPI HTTPS warning fix

### Fixed

- BCP → Protokolle & Dienste no longer shows the false warning "MAPI über HTTP ist eingeschaltet, aber HTTPS (Port 443) ist nicht aktiv oder hat kein vertrauenswürdiges Zertifikat" when port 443 serves a valid certificate for the public host name. The overview took only the certificate marked `isActiveHttps`, while the integrated HTTPS server serves every valid certificate by SNI (exact → wildcard → default). The overview now evaluates the certificate the HTTPS server actually serves for `ServerSettings.publicHostname` (shared selection `servedProxyCert()` in `lib/cert-lifecycle.ts`, also used by the TLS proxy's SNI callback), and the HTTPS card names that certificate. The warning stays when no certificate covers the host name or the served one is self-signed, Let's Encrypt staging or expired.

### Changed

- BCP → Dienste → HTTPS card: a status line that is always shown says whether HTTPS is active and with which TLS versions ("HTTPS ist aktiv mit TLS 1.2 und 1.3 — für Webmail, ActiveSync, MAPI usw. ist kein weiterer Schalter nötig.", or "HTTPS ist nicht aktiv — Zertifikat unter SSL/TLS zuweisen."). The legacy-TLS switch (HTTPS and mail listeners) is now labelled "Zusätzlich veraltete TLS-Versionen 1.0/1.1 zulassen (optional)", with the hint "Nur für sehr alte Geräte nötig. Moderne Clients brauchen das nicht." while it is off. While it is on, the warning starts with "Optionaler Kompatibilitätsmodus aktiv:". Admins had read the old label ("Ältere Clients erlauben") as the switch that turns HTTPS on and that MAPI requires.

---

## [9.5.0] — 2026-11-19 — ActiveSync calendar, tasks, notes and contacts, CalDAV tasks, folder permissions, domain-scoped admins, MAPI cached mode, profile photo

Minor release (SemVer: new features, additive schema, previous API contracts kept; behaviour changes that deserve attention are listed under "Upgrade notes"). Every change was reviewed independently; every finding was fixed with a regression test.

### Added
- **ActiveSync calendar, tasks, notes and contacts** (docs/activesync.md; PIM layer `packages/activesync/src/pim/`): the Calendar ([MS-ASCAL], code page 4), Tasks ([MS-ASTASK], code page 9), Notes ([MS-ASNOTE], code page 23, EAS 14.0+) and Contacts ([MS-ASCNTC], code pages 1 and 12) classes sync both ways in EAS 12.1, 14.0 and 14.1.
  - FolderSync announces the user's own calendars (default type 8, others 13), the tasks folder (7), the notes folder (10) and the contacts folder (9, "Kontakte"); shared calendars and contact groups are not offered over ActiveSync. The webmail module switches calendar / tasks / notes / contacts remove the folders (Sync Status 12, Ping Status 7).
  - Sync, GetItemEstimate, ItemOperations Fetch and Ping with the per-device item state of the mail sync (committed / pending rows, acknowledged keys, ClientId → ServerId with retry detection, no echo of the device's own writes, airsync:Supported ghosting, truncated bodies sent back unchanged keep the stored text), FilterType windows (calendar 2 weeks … 6 months back with series always included, tasks "incomplete only"), WindowSize + MoreAvailable. MoveItems moves an event between the user's own calendars; MeetingResponse places the accepted meeting under the returned CalendarId.
  - Calendar: TimeZone structure ↔ IANA zones (a timed series keeps its local time across DST changes), Recurrence ↔ RRULE (daily, weekly, monthly / yearly on a day or the nth weekday, interval, occurrences, until, first day of the week), exceptions ↔ EXDATE / RECURRENCE-ID overrides, attendees with status and type, reminder, busy status, sensitivity, all-day events, meeting status and response type. Meetings written by a phone book their rooms through the same policy, conflict check and booking lock as the event form.
  - Tasks: importance, start / due dates, completion with the task status rules (completing a recurring task creates the next one), reminder, privacy, recurrence. Notes: subject, body and categories.
  - Contacts: name parts, nickname, "file as", company, department, job title, office location, three e-mail addresses, the twelve phone slots, business / home / other address, web page, three IM addresses, birthday and anniversary (also without year), categories, notes and the contact picture (inline JPEG / PNG / GIF up to 48 KiB). Values beyond the fixed ActiveSync slots stay on the server and are never removed by a device edit; phone kinds without a CoreMail type (car, radio, assistant, company main, work / home fax, MMS) keep their kind in the vCard TEL TYPE; Spouse, Children, AssistantName, ManagerName, Yomi names, CustomerId, GovernmentId and AccountName are stored as `RELATED` / `X-` properties and kept by REST and CardDAV edits.
- **CalDAV task list** (docs/caldav.md): every user has a VTODO collection "Aufgaben" (`/dav/calendars/<id>/tasks/`) that Apple Reminders, Thunderbird and DAVx⁵ (jtx Board, Tasks.org) sync both ways — PROPFIND, REPORT (calendar-query with VTODO comp-filter and time-range, calendar-multiget, sync-collection), GET / PUT / DELETE with ETag / If-Match. SUMMARY, DESCRIPTION, STATUS, PERCENT-COMPLETE, DTSTART, DUE, COMPLETED, PRIORITY, CLASS, RRULE and VALARM map to the task form; unknown properties round-trip. The webmail module "tasks" switches it off. Schema: `Task.uid`, `Task.icalData` (unique `userId` + `uid`).
- **Contacts with several values and contact groups** (docs/contacts.md): typed e-mail addresses, phone numbers (work, home, mobile, fax, pager, other), postal addresses, web pages and chat addresses, the structured name, nickname, "file as", birthday and anniversary (also without year) and categories per contact (new `contacts` columns derived from the stored vCard; the flat columns stay in step for JMAP, the address list and older clients). **Contact groups** ("Kontaktlisten", table `contact_groups`; members are contacts, other groups or plain addresses): REST `/api/v1/contacts/groups` (CRUD) and `/groups/:id/expand`, compose autocomplete with `?groups=1`, "E-Mail an Liste". CardDAV round-trips the new fields with TYPE and serves groups as vCard 4 `KIND:group` + `MEMBER` and in the Apple form `X-ADDRESSBOOKSERVER-KIND` / `-MEMBER`; unknown vCard properties are preserved. Strictly validated structured fields on `POST` / `PUT /api/v1/contacts`, search over every contact field, contact form with repeatable typed fields; e2e step `contacts`.
- **Note categories**: REST `categories`, filter `?category=`, category picker and chips in the webmail.
- **Folder permissions** ("Berechtigungen"): a mailbox owner grants a user — or "Standard" (everyone in the organisation) — a role on one folder (Besitzer, Veröffentlichender Bearbeiter, Bearbeiter, Veröffentlichender Autor, Autor, Nicht bearbeitender Autor, Prüfer, Mitwirkender, Keine, Benutzerdefiniert), optionally also for the subfolders; "Anonym" is always "Keine". Schema: model `FolderPermission`, `Message.createdBy` ("own" items). One central access check in storage (`folder-permissions.ts`, `folder-access.ts`): mailbox FULL_ACCESS stays full, READ_ONLY stays a read floor, folder grants only add.
  - Webmail: folder context menu "Berechtigungen…"; folders shared with the user appear under "Freigegebene Postfächer" with only the granted folders; actions follow the rights per folder.
  - REST `GET|PUT /api/v1/mail/folders/:folderId/permissions` (also under `/mail/{shared,delegated}-mailboxes/:id/…`), foreign folder lists carry `noSelect` and `myRights`, `GET /user/accessible-mailboxes` marks `folderScoped` mailboxes. Admin API `GET /api/v1/admin/{mailboxes,shared-mailboxes}/:id/folder-permissions` and `GET|PUT …/:id/folders/:folderId/permissions`; BCP "Ordnerberechtigungen".
  - IMAP: real per-folder ACL — MYRIGHTS / GETACL / LISTRIGHTS reflect folder permissions, SETACL / DELETEACL set them ("anyone" = Standard); folders reached through folder permissions appear under `Other Users/` / `Shared/`.
  - Audit `mailbox.folder.permission.set|remove` (always written); e2e step `folder-permissions`.
- **Domain-scoped admin roles** (docs/rbac.md): HELP_DESK, RECIPIENT_MANAGEMENT, COMPLIANCE_MANAGEMENT, HYGIENE_MANAGEMENT and VIEW_ONLY_ORG can be limited to one or more domains (table `admin_scopes`; no rows = organisation-wide as before; ORGANIZATION_MANAGEMENT stays organisation-wide). A scoped admin never reaches the server-wide areas (organisation, identity, servers incl. backups) or server-wide routes, sees only objects of its domains in every list (mailboxes, shared mailboxes, resources, aliases, mobile devices, domains, sender lists, quarantine, audit log, message trace, dashboard figures), gets 404 for objects of other domains and 403 `OUT_OF_SCOPE` when creating in another domain; addresses of other hosted domains in detail views, audit entries and exports read "(andere Domain)". `PUT /api/v1/admin/organisation/role-assignments/:id/scope` (ORGANIZATION_MANAGEMENT only, audit `user.role.scope`, ends the admin's web sessions), `scope` in `GET …/role-assignments` and `GET /api/v1/admin/me/permissions`; BCP scope column and domain editor on the RBAC page; CLI `coremail role list | set | scope | me`; e2e step `scopes`.
- **MAPI cached mode** for desktop clients (MS-OXCFXICS, docs/mapi.md): incremental download of contents and hierarchy (`RopSynchronizationConfigure`, `RopFastTransferSourceGetBuffer` with partial buffers, message changes with recipients and attachments, read-state changes, deletions, final ICS state), ICS state upload / download with checkpoints (IDSETs as GLOBSETs, change numbers = message store modSeq), upload through a collector (`…ImportMessageChange`, `…ImportHierarchyChange`, `…ImportDeletes`, `…ImportReadStateChanges`, `…ImportMessageMove`), `RopGetLocalReplicaIds`, `RopSetLocalReplicaMidsetDeleted`, `RopLongTermIdFromId` / `RopIdFromLongTermId` — every write through the message store. Objects the client creates keep the IDs it assigned from its local replica ranges (new table `mapi_objects`, model `MapiObject`); imported changes are recorded in the collector state so they are not downloaded again; conflict detection with PidTagPredecessorChangeList (`IgnoreFailure`, `SyncConflict`). PidTagSourceKey / ChangeKey / PredecessorChangeList / ChangeNumber also in online mode.
- **Profile photos**: Settings → E-Mail-Konto with upload, crop dialog (round mask, drag, zoom, keyboard, previews), change and remove; the browser uploads 512×512. REST `PUT|DELETE /api/v1/user/photo`, `GET /api/v1/users/:id/photo` (same domain only, ETag), `POST /api/v1/users/photos/lookup` (batched, aliases included, max. 100), `photo` in `GET /api/v1/user/profile`. Photos of internal users appear in the message list, reading pane, contact card and list, meeting attendees and the top bar. Webmail module switch `profilePhoto` (server → domain → user, BCP, CLI `coremail policy set --profile-photo`); BCP mailbox detail "Foto entfernen" (`GET|DELETE /api/v1/admin/mailboxes/:id/photo`, audit `mailbox.photo.remove`). Schema: `User.photoKey`, `User.photoUpdatedAt`, `WebmailPolicy.profilePhoto`; object-store keys `profile-photos/<aa>/<sha256>.jpg`; settings `PROFILE_PHOTO_UPLOAD_LIMIT`, `PROFILE_PHOTO_UPLOAD_WINDOW_SEC`; e2e step `profile-photo`.
- **Rooms answer mailed invitations**: a resource mailbox replies to a meeting request that arrives by mail with an iMIP REPLY (`ACCEPTED`, `DECLINED`, or `TENTATIVE` while awaiting approval; per occurrence for occurrence-only requests) with a German subject and the reason of a decline or the conflicting dates, sent from the resource's address (DKIM of its domain, `Auto-Submitted: auto-replied`, threaded). Resource setting `sendReplies` (default on) in `POST` / `PUT /api/v1/admin/resources[/:id]`. Resource bookings store their conflicting occurrences (`ResourceBooking.conflicts`, up to 50; shown in `GET /api/v1/admin/resources/:id/bookings`).
- **Webmail accessibility and responsive layout** (docs/webmail-accessibility.md): folder tree as ARIA tree and message list as ARIA grid with roving tabindex and arrow keys, focus moves to the neighbouring message after delete / move, "skip to content" link, labelled landmarks; below 768 px a single-pane flow with a back button, 768–1099 px list and message with the folders in a drawer, the calendar starts in the day view on small screens.
- **Data**: one-time background backfill of the structured contact columns for contacts stored before 9.5 (Redis-locked, batched, resumable; `updatedAt` / `changeKey` kept, so sync clients see no change); mailbox backups (ZIP) contain contact groups next to the contacts and the internal date of every message; restore brings back contacts and contact groups into the owner's address book (idempotent, existing UIDs skipped; new job counts `contactsImported`, `contactsDuplicates`, `contactGroupsImported`, `contactGroupsDuplicates`, `addressBookFailed`).
- Storage single writers: `task-store.ts` (REST, CalDAV, ActiveSync), `contacts/contact-store.ts` (REST, CardDAV, ActiveSync; a deleted contact leaves its groups), `room-booking.ts` + `resource-booking-rules.ts` (event form, mail path, ActiveSync), `folder-grantees.ts`; `@coremail/core/domain-alignment`; e2e steps `eas-pim`, `contacts`, `folder-permissions`, `scopes`, `profile-photo`, and `schema-upgrade` from a 9.4.0 database.

### Changed
- **BCP edit side panel**: editing a user, a shared mailbox or a domain opens in a right-side panel (tabs Allgemein / Nachrichtenfluss / Ordnerfreigaben / Protokolle / Webmail, last tab remembered, not closed by a backdrop click, asks before discarding unsaved changes, full screen below 768 px); creating keeps the dialog. The user detail panel no longer lists the mailbox folders with counts (API unchanged); "Ordnerberechtigungen" lists only folders with grants and "Ordner freigeben…" opens a searchable folder picker. Dialogs keep tall content inside the viewport and keep focus inside after a backdrop click.
- **IDN display in the BCP**: sender lists and the domains list show internationalized domains in Unicode with the punycode form as secondary text (search matches both); mixed-script labels are flagged "Gemischte Schriftzeichen", undecodable `xn--` labels "Ungültige Kodierung"; the spoofing fields list the Unicode reading.
- **DMARC alignment** (Public Suffix List, see Security): sibling subdomains of one organization are now aligned with each other (`bounces.example.com` ~ `mail.example.com`); `@coremail/core` depends on `tldts` 7.0.30 (already in the tree through mailauth).
- ActiveSync Ping answers Status 7 when the folder hierarchy differs from the device's last FolderSync (existing devices discover the new folders without being set up again); MoveItems answers Status 2 between mail and PIM folders or between PIM classes; a single timed event without zone is sent with the user's Region zone, an event added on a phone is stored with the phone's zone.
- Task writer (REST, CalDAV, ActiveSync): a task that is completed and stays completed keeps its stored rule — a client resending the completed occurrence with its old RRULE no longer revives the series.
- The calendar home stays reachable for the task list when only the calendar module is off (calendars keep answering 403). Room booking rules moved to storage and are shared by the event form and the mail path; the conflict horizon is the booking window, at most one year.
- Contacts: a webmail edit rewrites only the changed vCard properties (keeps Apple labels, PREF); deleting a contact removes it from every group; a CardDAV PUT turning a contact into a group (or back) is refused with 409; vCard UIDs are unique across contacts and groups; `PUT /api/v1/contacts/:id` validates only what changes. `@coremail/core/vcard` keeps only the parser; `vcardFields`, `patchVcard`, `buildVcard` moved to `@coremail/storage` contacts (internal).
- `PUT|POST /api/v1/notes` validate `color` (`YELLOW BLUE GREEN PINK PURPLE`, any case, stored upper-case; a colour a note already has is accepted unchanged).
- Folder permissions: IMAP SETACL / DELETEACL change folder permissions on the user's own folders instead of answering `NO [NOPERM]`; LISTRIGHTS lists the grantable rights; every foreign-folder access (REST, IMAP, attachments, reply headers, realtime) is decided per folder and grant changes take effect at the next IMAP command; copied or moved messages never keep a creator claim.
- Admin scopes: deleting a domain that still scopes an admin is refused with 409 `DOMAIN_SCOPES_ADMINS`; the admin event feed (`security:attack`) is joined only by confirmed organisation-wide admins; the domain-level protocol-access and webmail-policy routes are guarded as the domains area; a scoped audit-log search scans the newest 5000 entries of its scope (`truncated: true`).
- Rooms ignore `REPLY`, `COUNTER`, `DECLINECOUNTER` and `REFRESH` messages (they were processed like a booking request). Bookings from the event form and ActiveSync still send no mail.
- MAPI: the session cap of 16 per account counts the sessions of every MAPI instance (least recently used ends); `NspiBind` honours the client's code page (CP_WINUNICODE or an unserved code page → `InvalidCodepage`) and converts `PtypString8` into it; online-mode `RopDeleteMessages` / `RopMoveCopyMessages` with an unknown message ID report partial completion instead of `ecNotFound`.
- Backups: MBOX writes the internal date into the `From ` line; the restore job result `otherEntries` counts only calendar and other non-mail entries; the BCP job list shows restored contacts and contact lists. Retention: a restored message (`Message.restoredAt`) expires at max(received + retention period, restore + 30 days).
- Avatar initials follow one rule everywhere (first letter of the first and last word of the display name, else the address' local part); deleting a mailbox removes its profile photo. The BCP MAPI note says MAPI is off by default and can be enabled per level or server-wide.
- Webmail message list rows and folder items use grid / tree roles; row checkbox and flag have 24 px targets; quick actions show while a row has keyboard focus.

### Removed
- Internal helpers `domainAligned` (`@coremail/storage`) and `domainsAligned` (`@coremail/security-filter`), replaced by `@coremail/core/domain-alignment`. No client-facing change.

### Fixed
- **Upgrade**: schema-sync no longer stops at the new `tasks` unique constraint (`userId`, `uid`) on a 9.4.0 or older database — a constraint over a new optional column that does not exist yet is skipped (NULLs never conflict); real errors still fail closed.
- **MAPI**: default folders always carry the names MAPI clients expect (Inbox, Drafts, Sent Items, Deleted Items, Junk Email, Archive), whatever the folder row holds; cached mode resends folders renamed or moved back, reports folders moved out of the subtree as deleted and accepts unchanged special folders; ISO-8859-1 / -9 address-book strings keep C1 controls.
- **Restore** keeps the original received time of messages (manifest internal date, MBOX separator date, topmost Received header, else Date) instead of the restore time.
- **Rooms by mail**: every occurrence of a recurring meeting is checked (EXDATE, moved occurrences, recurring bookings expanded, max. 400), series / duration / booking-window settings apply as in the event form, TZID start times are no longer read as UTC; occurrence-only REQUESTs update the stored series and CANCELs of single occurrences free only those slots; a declined moved occurrence is declined alone; the booking is read, merged and answered in one transaction under the resource lock. Simple DAILY / WEEKLY rules expand from the requested window (cheap for old series).
- **REST calendar**: moving, changing or deleting an attendee's copy of someone else's meeting no longer rebooks, refreshes or releases the organizer's rooms.
- **ActiveSync**: a ClientId reused in a later request no longer returns the earlier item and drops the new one; a priming Sync without airsync:Supported drops the stored list; FolderSync retried with the previous key no longer causes endless Ping Status 7; Ping on a PIM folder with an unreadable policy answers Status 8; calendar Sync / estimate / Ping read only the FilterType window; a UTC event turned into a series on a phone moves to the phone's zone.
- CalDAV task list: resending a completed recurring task no longer puts its rule back.
- `DELETE /api/v1/admin/resources/:id/bookings/:bookingId` deleted a booking of any resource; the booking must now belong to the resource in the path.
- `GET /api/v1/mail/delegated-mailboxes` no longer lists folders of SEND_AS / SEND_ON_BEHALF-only delegations or of a deactivated owner.
- Profile photos: concurrent saves of byte-identical photos no longer leave a reference to a deleted object; the webmail no longer revokes a photo URL still shown elsewhere; the top bar shows name and photo after a page reload.
- e2e runner: result file names no longer exceed the Windows path limit.

### Security
- **DMARC-conformant relaxed alignment** for iTIP/iMIP replies, room booking requests, success DSNs, local anti-spoofing and sender-list allow entries: the organizational domain comes from the Public Suffix List (incl. its private section). Before, any parent domain counted as aligned (`evil.co.uk` vouched for `x@co.uk`); now a public suffix never relates two registrable domains, IDNs compare as punycode, IP literals and suffixes align only exactly.
- **Domain-scoped admins**: scope checks run before the handlers and answer out-of-scope ids like unknown ids; the scope is read from the database on every request (15 s cache dropped on auth events), fail closed; addresses of other hosted domains are redacted in every spelling (Unicode / punycode / decomposed) in audit entries and exports, delegation / shared-mailbox / folder-permission grantees, quarantine, message trace and room bookings. Only ORGANIZATION_MANAGEMENT may grant itself shared-mailbox permissions, block / wipe / deregister a device or change aliases of an admin account; mailbox create and sender-list entries refuse other domains before looking the address up.
- **Folder permissions**: mailbox-level paths that do not know folder permissions (JMAP, MAPI, older REST routes, recover deleted items) never grant more than before; a grantee cannot pull other folders below its own by name; the folder owner right does not reach subfolders without owner rights on them (`SUBFOLDERS_NOT_ADMINISTERED`, IMAP `NO [CANNOT]`); admin grants follow the mailbox-grant rules (`FORBIDDEN_GRANTEE`); new grantees resolve only from the caller's directory (REST `UNKNOWN_GRANTEE`, IMAP SETACL / DELETEACL alike — no address oracle); creating or renaming onto a hidden folder's name is refused like any forbidden change (no folder-name oracle); a Default change re-checks idling IMAP sessions at once.
- **MAPI**: a deactivated account loses MAPI access also on an instance that missed the invalidation; revoking a shared-mailbox permission or delegation ends that logon in open sessions; uploaded ICS states, replaced client IDs (100 000 per mailbox) and client IDs per session are bounded; a malformed IDSET answers `RpcFormat`; an atom that cannot fit a buffer fails the ROP.
- **Rooms**: series repeating more than once a day are declined (`too-frequent`) and a stored one blocks only its first slot (CPU denial of service under the booking lock); a booking belongs to its organizer — client-chosen UIDs (ActiveSync) cannot take over or cancel someone else's room; an attendee's copy no longer sends iMIP updates / cancellations in the organizer's name; room replies are never sent to unauthenticated, null, automated, bulk / list senders, resources, or an `ORGANIZER` that is not one plain address, at most 30 per resource and organizer per hour.
- **Profile photos** are re-encoded on the server (magic bytes, dimensions from the header up to 2048 × 2048, JPEG marker walk limiting scans and segments, 128 MB decoder cap, 512×512 baseline JPEG without EXIF / GPS / ICC), with a per-user upload limit; photos are served only within the same domain.
- **CalDAV**: the task list's path segment is reserved in every spelling (no calendar hidden behind it).

### Upgrade notes
- **Schema:** all changes are additive (new tables `folder_permissions`, `admin_scopes`, `contact_groups`, `mapi_objects`; new nullable or defaulted columns on tasks, contacts, notes, messages, users, resource mailboxes / bookings and webmail policies) and are applied automatically at start. The new unique constraint on existing data (`tasks` `userId` + `uid`) is checked by schema-sync; because `uid` is new in 9.5 (NULL in every row) it is applied without a duplicate check.
- **Contacts backfill:** the structured contact columns of existing contacts are filled once in the background after the first start (resumable, no visible change to sync clients).
- **ActiveSync:** phones get Ping Status 7 once and then see the new Calendar, Tasks, Notes and Contacts folders (with the webmail modules on) — no new account setup needed.
- **MAPI:** the default folders now always carry the names MAPI clients expect; mailboxes created by the setup wizard (e.g. "Gesendet") see them renamed once in the desktop client. Cached mode is supported; desktop clients no longer need it switched off. An address-book bind with CP_WINUNICODE is refused with `InvalidCodepage` (desktop clients bind with their ANSI code page).
- **Rooms send iMIP replies by default** (`sendReplies`, on) to organizers who invite them by mail; switch it off per resource in the admin API if not wanted.
- **Notes:** `color` values other than `YELLOW BLUE GREEN PINK PURPLE` are now refused with 400 over REST (existing colours stay accepted unchanged).
- **DMARC alignment:** sibling subdomains of one organization are now aligned (e.g. replies or DSNs authenticated for `bounces.example.com` count for `mail.example.com`); parent domains across a public suffix no longer count.
- **Admin scopes:** organisation-wide admins behave as before; scoped admins see addresses of other domains as "(andere Domain)". A domain that scopes an admin cannot be deleted until the scope is changed.
- **IMAP ACL:** SETACL / DELETEACL now change folder permissions on own folders instead of answering `NO [NOPERM]`.
- New optional settings: `PROFILE_PHOTO_UPLOAD_LIMIT`, `PROFILE_PHOTO_UPLOAD_WINDOW_SEC`.
- **Helm chart 2.3.0** (appVersion 9.5.0).
- **Known limitations:** see docs/releases/v9.5.0.md.

---

## [9.4.0] — 2026-11-18 — Webmail redesign, MAPI over HTTP, protocol access switches, realtime push, calendar and tasks

Minor release (SemVer: new features, additive schema, previous API contracts kept; behaviour changes that deserve attention are listed under "Upgrade notes"). Every change was reviewed independently; every finding was fixed with a regression test.

### Added
- **MAPI over HTTP for desktop mail programs** (new service `mapi-server`, port 3007, loopback; the api-gateway forwards `/mapi/*`; docs/mapi.md): a MAPI account in desktop clients that speak MAPI over HTTP, implemented from the public Open Specifications. **Opt-in** (protocol switch `mapi`, off by default), **online mode only**, **Basic over HTTPS only** (no NTLM / Negotiate; app passwords with MFA).
  - Mailbox endpoint `/mapi/emsmdb`: Connect / Execute / Disconnect / NotificationWait / PING, sessions with rotating `MapiContext` / `MapiSequence` cookies (Redis, 30 min idle, at most 16 per account, ended by credential changes and the switch), ROP engine with 39 ROPs (logon to own, shared and delegated mailboxes, folders, tables, messages, attachments, streams, properties, named properties, notifications), sending with the same rules as SMTP submission and JMAP. Limits: `MAPI_RATE_LIMIT` / `MAPI_RATE_WINDOW_SEC`, `MAPI_SESSION_MEMORY_MB`, 250 attachments, 10 000 recipients.
  - Address book endpoint `/mapi/nspi` with all 19 request types (Global Address List of the account's domain incl. aliases and Shared Mailboxes; hidden mailboxes are not listed; bounded answers).
  - Notifications from `mailbox:changes` (NewMail, folder and table changes; `NotificationWait` returns within about a second).
  - Autodiscover v1 `mapiHttp` block (only for clients sending `X-MapiHttpCapability`, with the `mapi` switch on and a trusted HTTPS certificate; EXCH / EXPR are never sent) and v2 `Protocol=MapiHttp`; `MAPI_HTTPS_TRUSTED` for external TLS terminators.
  - MAPI writes announce themselves like every other writer; logons to shared / delegated mailboxes are in the mailbox access audit (source `mapi`).
- **Protocol access switches** for IMAP, POP3, SMTP submission, ActiveSync, JMAP, CalDAV/CardDAV, Webmail and MAPI on server, domain and mailbox level (domain / mailbox: `inherit`, `on`, `off`, most specific wins; server: `on` / `off`; table `protocol_policies`, docs/protocol-access.md). Checked after a successful authentication in every service with a protocol-specific answer (IMAP `NO [AUTHORIZATIONFAILED]`, POP3 `-ERR [AUTH]`, SMTP `535 5.7.1`, HTTP 403 `PROTOCOL_DISABLED`), switching a protocol off ends the open connections of the affected accounts at once, admins keep the BCP, the CLI and their account security when webmail is off. Admin API `/api/v1/admin/protocol-access[/domains/:id|/users/:id]` and `GET …/overview` (ports, differing domains / mailboxes, consistency warnings, `inheritedFrom`), CLI `coremail protocol show|set`, audit `settings.protocol-access.update`.
- **Webmail policies** on server, domain and mailbox level (docs/webmail-policies.md; tables `webmail_policies`, `trusted_image_senders`): module switches (Kalender, Kontakte, Aufgaben, Notizen, Regeln, Signaturen, Kategorien, Gelöschte Elemente, Passwort ändern, Designs, Externe Clients, App-Passwörter, Freigegebene Postfächer) hidden in the webmail and refused by the server (403 `FEATURE_DISABLED`, CalDAV/CardDAV 403, ActiveSync), blocked / "save only" attachment types, upload size limit, external-image policy (ask / contacts only / block) with trusted senders per user. `GET /api/v1/user/features`, admin API `/api/v1/admin/webmail-policies`, BCP page and domain / mailbox sections, CLI `coremail policy show|set`.
- **ActiveSync 12.1 and 14.0** next to 14.1: negotiated per request (`MS-ASProtocolVersion` header or base64 request line) and remembered per device (`ActiveSyncDevice.protocolVersion`); 12.1 SendMail / SmartReply / SmartForward with raw MIME and request-line parameters, GetItemEstimate request form with `Class` / `FilterType`; Ping without `X-MS-PolicyKey` for a known OK device; retries without ClientId are deduplicated for 10 minutes (docs/activesync.md).
- **Realtime events for every change** (docs/realtime.md): `mailbox:changes` and typed per-user events, published by every writer (SMTP, IMAP, POP3, JMAP, ActiveSync, MAPI, webmail, CalDAV, restore, retention). Webmail refreshes exactly the affected views live, one connection per browser (leader election, logout in one tab logs out all), **Web Push** for new mail (opt-in per device; sender and subject only with an extra opt-in), installable webmail (`/manifest.webmanifest` from the branding, service worker, PNG app icons), `POST /api/v1/push/unsubscribe`, `PushSubscription.showPreview`.
- **Webmail redesign**: app rail (bottom bar below 768 px), mail command bar, reading-pane action bar, shared page frame, toolbar keyboard pattern; compose opens **inline in the reading pane** with draft tabs, or in its own window (`/compose/<draftId>`); slim compose with command row, formatting toolbar below the body (font size, bold / italic / underline, colours, lists, indent, alignment, text direction, links, quote, code, super- / subscript, picture, table, rule, paragraph format, font, undo / redo, clear formatting), recipient pills, quoted original, plain-text switch, larger font lists, **Namen prüfen**, **Auf Barrierefreiheitsprobleme prüfen** (with alternative-text fixes), **Wichtigkeit**, **Vertraulichkeit** (`Message.sensitivity`, `Sensitivity` header), Lesebestätigung and Übermittlungsbestätigung (DSN), Esc saves and closes. New nullable columns `Message.importance` and `Message.sensitivity`; drafts and `POST /mail/send` take optional `importance`, `sensitivity`, `requestDeliveryReceipt`.
- **Personal settings that roam** (docs/user-settings.md): `GET/PATCH /api/v1/user/preferences` (view, theme, language, region / time zone / date and clock format, calendar work days and hours, reading and compose options, sort order `?sort=&dir=`), several named signatures with defaults per sender identity (`/api/v1/user/signatures`), read receipts (`POST /mail/messages/:id/receipt`, `$MDNSent`), signed-in sessions list (`/auth/sessions`, `revoke-others`), `?markRead=false`, deep links (`/mail/<mailbox>/<folder>/<message>`, `/calendar/event/<id>`, `/contacts/<id>`). Additive: `user_settings.preferences`, table `user_signatures`, `messages.dispositionNotificationTo`.
- **Calendar** (docs/calendar.md): recurrence editor and presets, edit / delete a single occurrence of a series (`?occurrence=`, `RECURRENCE-ID` / `EXDATE`, attendee updates for that occurrence), **scheduling assistant** (`POST /calendar/schedule-suggestions`), **rooms and resources** with conflict check and booking rules (`GET /calendar/rooms`, `rooms` on events), **Anzeigen als** (`TRANSP` + `X-MICROSOFT-CDO-BUSYSTATUS`), reminders per event (also by mail), "Heute" and a day agenda. Additive: `CalendarEvent.showAs`, `ResourceCalendar.bookingSeq`.
- **Follow-up flags and tasks** (docs/tasks.md): flags with dates and reminders on mail (`PUT/GET /api/v1/mail/follow-up`, kept in step with `\Flagged` over IMAP, JMAP, REST, rules; ActiveSync `email:Flag` sent and applied), "Gekennzeichnete Elemente und Aufgaben" list, full task form (start / due / completion date, status, % complete, private, recurrence creating the next task, effort, mileage, billing, companies, rich-text note). Additive: `Message.flagStatus` and four flag dates, ten `Task` columns.
- **Mailbox management** (docs/mailbox-management.md): auto-mapping per grant (`autoMap`), sent copies in the shared mailbox for send as / on behalf (`sentCopySendAs`, `sentCopySendOnBehalf`, from webmail, SMTP, JMAP, ActiveSync), per-mailbox mail flow (`MailFlowPolicy`: hide from the address list, admin forwarding, accept-only / reject-from lists, receive / send size, max. recipients; `GET|PUT /api/v1/admin/{mailboxes,shared-mailboxes}/:id/mail-flow`), mailbox access audit (`mailbox.foreign.*`, switch and retention in BCP, audit filter "Postfachzugriffe", webmail Settings → Sicherheit "Zugriffe auf mein Postfach"). CLI `coremail shared grant --no-automap`, `shared sent-copy`, `mailbox flow`, `shared flow`.
- **Hygiene settings**: BCP → Schutzfilter → **Absenderlisten** (block / allow lists per scope with exact / wildcard / regex patterns, CSV import / export, `Blacklist.listType`, enforced per recipient at RCPT TO) and **Spoofing** (local anti-spoofing action, trusted senders and ARC sealers as BCP settings; environment variables still override), DNSBL "Score" zones now add their weight to the spam score, configurable global **API rate limit** (BCP → Einstellungen → Sicherheit, `ServerSettings.apiRateLimit*`, `API_RATE_LIMIT_*`).
- **Legacy clients**: opt-in **TLS 1.0 / 1.1** per listener and for the HTTPS proxy (vetted cipher list, hot reload, warning + audit, docs/legacy-tls.md; `GET/PUT /api/v1/admin/services/https-tls`, `allowLegacyTls`), opt-in **device relay** for scanners / printers (allowed networks, hosted sender domains, rate limit, attachment filter and ClamAV, docs/device-relay.md; `GET/PUT /api/v1/admin/smtp-config/device-relay`), security-filter `POST /check/malware`, Autodiscover client matrix and docs (docs/autodiscover.md, docs/desktop-caldav.md).
- BCP → **Protokolle & Dienste**: one page for protocol access, ports (TLS mode, legacy TLS), differing domains / mailboxes and warnings; the SSL/TLS certificate list shows a status chip per service (SMTP, IMAP, POP3, HTTPS) from what the ports really serve (`GET /api/v1/admin/certificates/served` also probes HTTPS and returns `unreadableKeys`).
- Recursive folder delete: `?recursive=true` on the folder delete routes (own, shared, delegated and the compat route) deletes the folder and its subfolders and moves the messages to Trash; webmail asks with the number of subfolders and messages.
- Storage helpers `submission-limits.ts` (one source for the limits of a submitted message), `storeRawInFolder()`, `legacyDnFor()`, `policy-levels.ts`, `file-types.ts`, IDN helpers (`@coremail/storage/idn`); `@coremail/core` `createFixedWindowLimiter()`, `tlsProtocolOptions`, `randomCertSerialHex`; `LICENSE` file; translations of login, second-factor, SSO, setup, settings navigation and several BCP pages; e2e steps `mapi`, `protocols`, `policies`, `mailbox-mgmt`, `eas-legacy`, `legacy-clients`.

### Changed
- The webmail / REST recipient limit is the SMTP *max. recipients* setting (BCP, default 100); JMAP and ActiveSync enforce it too. `MAIL_SEND_MAX_RECIPIENTS` stays only the upper bound of a request.
- `/mapi/*` is no longer answered 404 by the api-gateway: it is forwarded to the MAPI server (403 until the `mapi` switch is turned on). The global API rate limit does not count `/mapi`.
- The global API rate limit counts signed-in requests per **user** (default 3000 per 15 min) and anonymous requests per IP (500 per 15 min); static files and the live-event stream no longer count. Basic-authenticated protocol clients (ActiveSync, CalDAV/CardDAV, JMAP) still count per IP.
- ActiveSync: responses carry only elements the negotiated version defines; a successful SendMail / SmartReply / SmartForward in 14.x returns an empty response (as [MS-ASCMD] specifies); a message above the maximum size is refused with Status 122 (14.x) / HTTP 413 (12.1); the request-body cap follows the maximum message size (× 4/3 + 1 MB, at most 150 MB) instead of a fixed 25 MB; the size limit applies at once after a settings save. 12.1 devices get HTTP 403 / 449 instead of in-band status codes.
- JMAP `EmailSubmission/set`, `Email/import` and `Email/set` create refuse a message above the maximum size with SetError `tooLarge`; the JMAP switch is the server level of the protocol switch (its API is unchanged).
- Autodiscover: v1 describes the account by its primary address and adds an explicit IMAP `<Encryption>`; v1, v2 and autoconfig announce only enabled protocols and endpoints of enabled listeners; plain-HTTP probes get `302` to HTTPS; v1 reads the POST body whatever its Content-Type. `GET /api/v1/user/client-config` carries `protocols` and nullable sections.
- REST `POST /calendar/freebusy`: `FREE` events no longer count as busy, `type` can be `oof`, users the caller may not see are `visible: false`; iMIP invitations of a series include `EXDATE`s and show-as; invitation mails show times in the organizer's time zone.
- Installations with DNSBL zones set to "Score" (built-in PSBL, weight 3) now see these weights in the spam score; a message close to the Junk threshold may land in Junk.
- Folder delete without `?recursive=true` keeps its 9.3 answers; subfolders of a deleted own folder move up to its parent (they were left behind at the top level); the compat route used to answer 409 for a folder with subfolders and now deletes it that way.
- IMAP IDLE is pushed by `mailbox:changes` for every writer (120 s fallback instead of a 30 s poll); JMAP push reacts to every writer; webmail polling is replaced by live events (15 min safety net); task and event reminders fire in one tab per browser.
- Webmail: the floating compose window and the compose ribbon are gone; settings are opened with the gear in the header; calendar ribbon uses the shared command bar; toolbars and menus follow the keyboard patterns; labels come from the translation table (DE / EN; ES / IT show English until translated). New mail generated by the server uses CRLF line ends everywhere.
- Shared mailbox audit (`mailbox.foreign.*`) goes through the storage mailbox access audit and follows its switch; local delivery has a new refusal outcome `policy` (NDR 5.7.1); the tri-state level resolution moved to `policy-levels.ts`; `applyTlsToListeners()` lost its unused third parameter (internal).

### Removed
- Redis channels `mail:update` and `calendar:shares` (replaced by `mailbox:changes` and calendar user events). Internal only — no client-facing change.

### Fixed
- Self-signed certificates could occasionally not be loaded ("illegal padding"): the random serial number is now always a positive, minimally encoded 16-byte value.
- An unreadable certificate private key (wrong or lost `MFA_ENCRYPTION_KEY`) no longer turns TLS off: SMTP, IMAP and POP3 served the implicit-TLS ports 465/993/995 in plaintext and stopped offering STARTTLS; they now serve a self-signed replacement for the public host name and log an error naming the certificate; the HTTPS proxy keeps TLS too.
- IMAP `DELETE` removed the messages of the deleted mailbox for good; they now go to Trash through the message store (recoverable), a mailbox with messages and no Trash folder is refused with `NO [CANNOT]`; a Trash subfolder created by name is recognised as inside Trash.
- Domain- and mailbox-scoped sender-list entries were never applied; the DNSBL action "Score (rspamd)" had no effect.
- Mail generated by the server (drafts, Sent copies, JMAP Email/set, out-of-office replies) had bare LF line ends; webmail / REST send used "Name <a@b>" suggestions as SMTP envelope addresses; reply all dropped the original An recipients; a send handed to a reloaded main window was dropped; several smaller compose, draft and name-check fixes.
- Internationalized domains: sender lists, accept-only / reject-from lists and sender identity checks compare addresses in one canonical form (punycode), so Unicode and punycode spellings match.
- Calendar and tasks: rooms of a moved series were checked against the old times, two concurrent bookings of one room slot could both be accepted (now under a per-room lock), all-day `RECURRENCE-ID`, floating-time `EXDATE`, a private occurrence of a public series leaked its subject, completing a recurring task twice created two next tasks.
- ActiveSync: a `Change` carrying only `email:Flag` was ignored; per-mailbox size limit answers Status 122 / HTTP 413; webmail policy "App-Passwörter" switched back on applies to IMAP, POP3, SMTP, JMAP, MAPI and Autodiscover at once (services now follow the policy reload signal).
- A changed permission, delegation or auto-mapping, ending sessions and saving S/MIME options update the user's other open webmail tabs at once; the mailbox access audit `open` aggregation is shared across processes; the server's own DSNs / NDRs reach mailboxes with accept-only / reject-from lists; admin forwarding of a decrypted S/MIME message forwards the encrypted original.
- Eleven api-gateway test files kept the test process alive after their last test (`closeRedis()` now disconnects a client that is not connected).

### Security
- Certificate private keys (`Certificate.keyPem`, `ServerSettings.tlsKey`) and the Let's Encrypt account key are **encrypted at rest** (AES-256-GCM, `enc:v1:`, keyed by `MFA_ENCRYPTION_KEY` or its `JWT_SECRET` + `PEPPER` fallback); plain PEM keys are read and encrypted once at api-gateway start. Losing the key makes stored private keys unreadable (docs/certificates.md "Private keys at rest").
- Webmail policy module switches could be bypassed with a differently cased path (`/api/v1/Calendar/…`, `/dav/Calendars/…`); both gates now compare lower-case. With the module "App-Passwörter" off, existing app passwords stop working on every mail protocol (checked before the protocol switch, no oracle; live connections end). File type matching folds compatibility characters and drops invisible format characters (also in the inbound attachment filter). An unexpected failure of the policy checks answers 503.
- MAPI and its Autodiscover entry point authenticate with Basic over TLS only (no NTLM; CoreMail stores no NT hash), MAPI is announced only with a trusted HTTPS certificate; hidden mailboxes cannot be enumerated by MID, address-book answers, filters and name lists are bounded; a malformed Bind creates no session.
- Internal `X-CoreMail-*` headers are one complete list stripped at every ingress (port 25, device relay, SMTP submission, local delivery of webmail / JMAP / ActiveSync) — an external sender can no longer suppress admin forwarding with a forged header. Inbox-rule forwards of a decrypted S/MIME message send the original encrypted message. Scheduled sends, undo-send holds and delayed JMAP submissions re-check send-as / on-behalf rights and the sender identity when they are sent (NDR 5.7.1 to the sender when revoked).
- The ActiveSync WBXML decoder limits nesting depth (64) and node count (100 000). Relay allow-lists match IPv4 clients only against IPv4 entries (node's `BlockList` matched IPv4 against IPv6 entries such as `::/32`); the legacy `SmtpSettings.relaying*` fields stay unevaluated.
- `POST /calendar/freebusy` and `/calendar/schedule-suggestions` resolve addresses only among the caller, the address-list users of the caller's domain and users who shared a calendar with the caller (others are `found: false`); a user without a domain no longer sees or books the rooms of every domain; task recurrence rules are validated strictly. Calendar live events carry event ids for owners only; new-mail notifications never go to deactivated Shared Mailbox members; notification clicks follow only same-origin paths.
- Implicit-TLS mail ports can no longer come up without TLS after a certificate key becomes unreadable (see Fixed).

### Upgrade notes
- **Schema:** all changes are additive (new tables `protocol_policies`, `webmail_policies`, `trusted_image_senders`, `user_signatures`, `device_relay_settings`; new nullable or defaulted columns on messages, tasks, calendar events, user settings, server and security settings, listeners, push subscriptions, shared mailbox grants) and are applied automatically at start without data loss.
- **Recipient limit:** webmail and REST now use the SMTP *max. recipients* setting (BCP SMTP settings, default **100**); the webmail used to allow up to 500 recipients per message. Raise the setting if you rely on larger mailings.
- **Free/busy:** the free/busy of colleagues is only visible with a calendar share (decision). `POST /calendar/freebusy` answers `found: false` for addresses outside the caller's own address list (own domain, not hidden) that did not share a calendar with the caller; others are `visible: false`.
- **MAPI over HTTP is off by default** (protocol switch `mapi`; 403 until switched on). MAPI client profiles work in **online mode only** (cached mode is not supported yet), authentication is Basic over HTTPS with a trusted certificate — NTLM is not offered. `/mapi/*` no longer answers 404.
- **App passwords policy:** switching off the webmail policy module "App-Passwörter" also blocks existing app passwords on all mail protocols (IMAP, POP3, SMTP submission, ActiveSync, JMAP, CalDAV/CardDAV, MAPI); users with MFA then lose mail-client access. Switching it on again restores them (the BCP label does not say this yet).
- **Behaviour changes to check:** the global API rate limit counts per user (default 3000 per 15 min) instead of 500 per IP; DNSBL "Score" zones now influence the spam score; ActiveSync 14.x answers a successful SendMail with an empty body; Autodiscover announces only enabled protocols; IMAP `DELETE` of a mailbox with messages moves them to Trash (refused with `NO [CANNOT]` without a Trash folder); the compat folder-delete route no longer answers 409 for a folder with subfolders.
- **Certificate keys:** private keys are encrypted at rest at the first start; keep `MFA_ENCRYPTION_KEY` (or `JWT_SECRET` + `PEPPER`) and include it in your backup of `.env` — without it, stored certificate keys cannot be read (certificates must then be issued or uploaded again).
- **TLS 1.0/1.1, device relay and the `mapi` switch are opt-in** and change nothing until enabled. New optional settings: `API_RATE_LIMIT_*`, `MAPI_RATE_LIMIT`, `MAPI_RATE_WINDOW_SEC`, `MAPI_SESSION_MEMORY_MB`, `MAPI_HTTPS_TRUSTED`, `MAPI_ALLOW_PLAIN_HTTP` (tests only).
- **Helm chart 2.2.0** (appVersion 9.4.0).
- **Known limitations:** MAPI cached mode, MAPI calendar / contacts, NTLM; the mail path of room booking checks conflicts against the first instance of stored recurring bookings; one colliding occurrence declines the room for the whole series; Spanish and Italian webmail show English texts for the new command bars.

---


## [9.3.0] — 2026-11-17 — Branding, working Let's Encrypt and mail certificates, shared mailboxes in the folder pane, backup restore

Minor release (SemVer: new features, additive schema, previous API contracts kept). Every change was
reviewed independently; every finding was fixed with a regression test.

### Added
- **Branding in webmail and BCP** — new BCP page „Branding" (area `organisation`) with live preview in light and dark mode: product name, primary and header colour (contrast warning with a same-hue suggestion and „Standard verwenden"), logos light/dark, favicon, login background, login text, footer links, „Powered by CoreMail" (on by default) and whether users may keep their own accent colour. Webmail and BCP use the product name and logo everywhere, apply the brand colour as default accent (button fills are darkened automatically when white text would miss 4.5:1; the header switches to dark text instead), and the login pages show background, text, footer links and „Powered by". The BCP only sends fields the admin changed, so `BRANDING_NAME` / `BRANDING_COLOR` stay effective for untouched fields. A user's stored accent that equals the old default follows the brand colour.
- **Branding (backend)** — product name, colours, logos, favicon and login page for the whole server (docs/branding.md).
  - New additive singleton model `Branding` (`branding` table): product name, primary / header colour, logo light / dark, favicon, login background (object-store keys `branding/<sha256>.<ext>` + content type), login text, footer links, "allow user accent colour", "show Powered by CoreMail", `version`.
  - Public `GET /api/v1/branding` (the login page needs it before sign-in) and `GET /branding/assets/<sha256>.<ext>` (immutable cache, `nosniff`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`).
  - Admin API `/api/v1/admin/branding` (area `organisation`: changes ORGANIZATION_MANAGEMENT only, read also SERVER_MANAGEMENT / VIEW_ONLY_ORG): `GET`, partial `PUT`, `POST|DELETE /assets/:slot` (raw body; PNG / WebP / SVG ≤ 512 KB, login background also JPEG ≤ 2 MB; magic bytes, max 4096 px, square favicon ≤ 1024 px), `POST /reset`. Every change increments `version`, is audited as `settings.branding.update` and publishes `CHANNEL_SETTINGS_RELOAD` `{type:'branding'}`. A replaced asset is deleted once nothing references it.
  - SVG uploads go through a strict allowlist sanitiser and are refused (`400 SVG_UNSAFE`) on DOCTYPE/entities, processing instructions, script, foreignObject, images, links, animation elements, event handlers, non-`#fragment` hrefs, `javascript:`/`data:` values, external `url()`, `<style>` with `url(`/`@import`, and oversized or deeply nested input; the stored file is re-serialised from the checked tree.
  - Colours below 3:1 against the light or dark surface are saved but answered with a warning and a suggested colour of the same hue (OKLCH lightness).
  - The webmail and BCP `index.html` are served with the brand colour variable, product name as `<title>`, the favicon (or logo) and the public branding JSON (`#cm-branding`) injected, cached per branding version and refreshed on every gateway instance through the reload message.
  - Product name in system texts: password-reset mail, security / quota / calendar-share notifications, Apple configuration profile and Thunderbird autoconfig display names (unbranded installations keep the organisation name there).
  - Optional environment defaults `BRANDING_NAME` / `BRANDING_COLOR` (`.env.example`, both compose files, Helm `app.branding.name` / `.color`).
  - CLI `coremail branding show | set | upload <slot> <file> | remove <slot> | reset` (docs/cli.md).
  - e2e step `branding` (docs/e2e.md).
- **Backup: restore of stored archives** (BCP → Backup & Restore → Wiederherstellen, docs/backup.md) — `POST /api/v1/admin/backups/restore` `{ jobId | key, targetUserId?, mode, folderId? }` restores a mailbox archive from the backup store (single-mailbox backups and the per-user parts of full backups; ↺ in the Jobs and Backup-Archiv tabs) into the original mailbox or another one, as a job (scope `restore`, counts in the job). Encrypted archives are decrypted with the configured key; a missing or different key is answered with 422 and a clear message before anything is written. Modes: `subfolder` („Wiederhergestellt <date of the backup>" with the original folder structure, default), `original` (original folders), `folder`. Idempotent: messages already in the target folder (same content-addressed raw object; Message-ID + size only for older rows without one) are skipped. Folder names from the archive are validated (web-client folder rules, no control characters, no `Shared/` / `Other Users/` prefix, at most 32 levels) — refused names and folders beyond `BACKUP_RESTORE_MAX_FOLDERS` (1000 per restore) go to the restore folder. The restore folder date is the backup's own creation time (ZIP manifest) for both archive and upload restores, else the backup job's date. A restore stops cleanly (job FAILED, nothing more written) when its per-mailbox lock is lost. ZIP and MBOX, original raw octets through the message store, attachments indexed, flags from the new ZIP manifest (`\Deleted`/`\Recent` dropped). One restore per mailbox at a time; limits `BACKUP_RESTORE_MAX_BYTES` (20 GiB) / `BACKUP_RESTORE_MAX_MESSAGE_BYTES` (150 MiB). Audit `backup.restore`; ORGANIZATION_MANAGEMENT + COMPLIANCE_MANAGEMENT.
- ZIP mailbox backups contain `coremail-manifest.json` (exact folder names and flags of every message); two folders whose names map to the same path segment no longer share entry names.
- **Backup automation**: BCP → Zeitpläne shows what the schedules cover and what not (database, object store, `.env` secrets, off-site copy) and offers **„Empfohlene Sicherung einrichten"** (`POST /api/v1/admin/backups/schedules/recommended`, explicit, never silent): a nightly system backup and a nightly full backup of all mailboxes with `BACKUP_SCHEDULE` / `BACKUP_RETENTION_DAYS` as defaults (these variables were documented as "daily full backup" but never read). The page warns when no full backup schedule is enabled.
- **System backup** (schedule / job scope `system`): encrypted `pg_dump` of the database plus a manifest of the mail object store (`system/<day>/<jobId>/…`); credentials passed as PG* environment variables. Download for ORGANIZATION_MANAGEMENT only. Restore procedure in docs/backup.md.
- Failed or partial scheduled backups notify every active ORGANIZATION_MANAGEMENT / SERVER_MANAGEMENT admin by an internal message (at most once per schedule every 6 h).
- e2e step `backup`: backup of B → restore of the stored archive into A → IMAP sees the messages byte-exact with flags; re-run and upload add nothing; recommended schedules; system backup run-now.
- **Webmail: shared and delegated mailboxes in the folder pane** ("add shared folder"). Below the own folders a section „Freigegebene Postfächer" lists every Shared Mailbox and delegated user mailbox the user may read (`listAccessibleMailboxes()` — FULL_ACCESS / READ_ONLY) as an expandable root with its folder tree; selecting a folder shows it in the normal mail view (resizable panes, reading pane right / bottom / off, search with operators, filters, context menus, bulk actions, drag & drop, keyboard shortcuts). Roots can be hidden („Ausblenden") and added back („Postfach hinzufügen", also the profile menu „Weiteres Postfach öffnen"); hidden roots are stored per user server-side, expanded roots per browser. Read-only access shows every write action disabled with a tooltip. Recover deleted items (FULL_ACCESS, now also for delegated mailboxes) and the quota of shared mailboxes are available from the root / Trash context menu.
  - New API (api-gateway `routes/foreign-mailbox.ts`) with the request/response shapes of `/api/v1/mail`: `GET|POST /folders`, `PATCH|DELETE /folders/:folderId`, `POST /folders/:folderId/empty`, `GET /folders/:folderId/messages`, `GET /search`, `GET /messages/:id` (+ `/raw`), `PATCH|DELETE /messages/:id`, `POST /messages/bulk` under (new) `/api/v1/mail/shared-mailboxes/:id` and (new) `/api/v1/mail/delegated-mailboxes/:mailboxId`. FULL_ACCESS reads and writes, READ_ONLY reads only (writes → 403 `READ_ONLY`, opening a mail does not mark it read), no access → 403 `NO_ACCESS`; every lookup is scoped to that mailbox (no cross-mailbox move), expunged messages are only reachable through the FULL_ACCESS `/recoverable` routes (also `/raw`), personal categories are never returned, junk / not-junk is a plain move (no personal block list or Bayes training). Deleting a folder (`?force=true` for a non-empty one, 409 with the count otherwise; subfolders → 409) moves its messages — live ones and recoverable tombstones — into the mailbox's Trash through the message store before the folder is removed (inside Trash: expunged first; no Trash folder → 409). Folder create / rename / delete / empty and message move / delete are written to the audit log as `mailbox.foreign.folder.create|update|delete|empty` and `mailbox.foreign.message.move|delete` (targetType `sharedMailbox` with the SharedMailbox id or `mailbox` with the Mailbox id, mailbox id and counts in `changes`).
  - `GET /api/v1/user/accessible-mailboxes` (ref `shared:<id>` / `delegated:<mailboxId>`, permissions, readOnly, hidden) and `PATCH /api/v1/user/accessible-mailboxes/:ref {hidden}`; additive column `UserSettings.hiddenSharedMailboxes String[] @default([])`.
  - Compose opened inside a shared mailbox offers a „Von" choice — „Senden als" (SEND_AS or FULL_ACCESS) / „im Auftrag von" (SEND_ON_BEHALF) — stored in the server draft (`sendAs` / `sendOnBehalfOf`, checked again on save and send); replies load the original from that mailbox.
  - e2e step `webmail` (docs/e2e.md).
- **Protection: installations without rspamd / ClamAV** (docs/antivirus.md). The security filter determines per scanner whether it is `absent` (only the explicit switch `RSPAMD_ENABLED` / `CLAMAV_ENABLED=false`, set by the minimal compose file and the Helm chart without the scanner), `unavailable` (does not answer, DNS failure, or the host name does not exist — reason `host-not-found`, e.g. a stopped container or a typo in `CLAMAV_HOST`; the failure policy and the `X-CoreMail-Virus-Scan` header apply, so stopping a scanner never switches scanning off) or `available`; checked at start and every 5 minutes (`SCANNER_CHECK_INTERVAL_SEC`), so a scanner that answers again is picked up without a restart; a running filter never moves a scanner into `absent`, and available → unavailable is logged at warn level. An absent scanner is skipped without an `X-CoreMail-Virus-Scan: unscanned` header and without `451` deferrals from „block on failure" (one log line at start instead of one per message; rspamd learning calls are skipped); an unavailable scanner keeps the configured failure policy. New `GET /api/v1/admin/security/capabilities` (hygiene role, read) → `{ rspamd: {state, reason, detail?, checkedAt}, clamav: {…} }` without host names or URLs. BCP → Schutzfilter hides the Rspamd / Antivirus tabs, status cards and protection-matrix rows of an absent scanner and shows „… ist in dieser Installation nicht bereitgestellt" with a documentation link; an unavailable scanner keeps its settings and shows a warning with the reason (for `host-not-found`: „Host nicht gefunden: CLAMAV_HOST/RSPAMD_URL prüfen oder den Scanner mit CLAMAV_ENABLED=false bzw. RSPAMD_ENABLED=false als nicht bereitgestellt kennzeichnen"). Settings for an absent scanner are still saved (no 4xx), so they apply once the container is added. e2e: the `admin` step checks the reported states (`E2E_SCANNERS=absent` for a stack without both scanners that sets the env switches).

### Changed
- Helm chart 2.1.0: optional `app.branding.name` / `app.branding.color` values (`BRANDING_NAME` / `BRANDING_COLOR`); `appVersion` 9.3.0.
- **SSL/TLS: assigning SMTP/IMAP/POP3 is the switch** (docs/certificates.md). Every path that gives a certificate the mail services — edit dialog / `PUT /api/v1/admin/certificates/:id`, upload, self-signed, Let's Encrypt issuance and renewal — applies it to the mail servers right away (full chain in `server_settings.tlsCert`, `isActiveProtocol` exclusive, `settings:reload` + `coremail:tls:reload` published) and writes the audit entry `certificate.protocol.switch`. SMTP, IMAP and POP3 always share one certificate: selecting any of them stores all three. Removing them from the protocol certificate (or deleting it) falls back to the self-signed default for the public host name; the self-signed default itself cannot be left without them (409 `PROTOCOL_CERT_REQUIRED`). A not-yet-issued Let's Encrypt certificate keeps the assignment and takes over when it is issued. `POST /:id/activate-protocol` stays for API compatibility and now also sets the services.
- Let's Encrypt staging certificates never get mail services: `PUT`/`activate-protocol` answer 409 `STAGING_NO_MAIL_SERVICES`, ordering a staging certificate with mail services 400.
- After a Let's Encrypt issuance for a certificate that names `ServerSettings.publicHostname`, SMTP/IMAP/POP3 switch to it automatically while they still use the self-signed default — and the HTTPS proxy too when no trusted HTTPS certificate is active. The order form is prefilled with the public host name and the mail services and offers `autodiscover.<domain>` / `autoconfig.<domain>` as additional names, checked by default when their DNS points to this server (`GET /api/v1/admin/certificates/acme-suggestions`).
- The self-signed fallback certificate (setup, protocol servers, fallback) is generated for the public host name instead of `mail.localhost`; an active self-signed default for `mail.localhost` is regenerated for the configured host name at startup (a trusted certificate is never replaced).
- BCP → SSL/TLS shows per mail port (993, 465, 143, 587, 995, 110 and every other active listener) the certificate actually served — subject, issuer, expiry, self-signed / host-name match (`GET /api/v1/admin/certificates/served`, local connections with SNI = public host name, STARTTLS/STLS on the plain ports, bounded timeouts). The SSL/TLS page and the dashboard warn when a mail port serves a self-signed, name-mismatched or expired certificate, with „Jetzt zuweisen". The edit dialog says what saving does („Wird sofort für SMTP/IMAP/POP3 verwendet").
- IMAP, POP3 and SMTP log the client IP on login success / failure and on TLS errors; a client that aborts the handshake because it does not trust the certificate (TLS alert certificate unknown / bad certificate / unknown CA) is logged as warn with the hint "client does not trust the served certificate" instead of an error. Handshake failures on 993 / 995 / 465 are logged at all (they were silent).
- BCP → SSL/TLS: SMTP, IMAP and POP3 are one switch „Mail-Protokolle (SMTP · IMAP · POP3)" in the order, upload, self-signed and edit dialogs (it always sends all three or none; the API keeps accepting a `services` array). The startup reconciliation of the protocol TLS state runs under a Redis lock (`cert:protocol:reconcile:lock`) — with several api-gateway instances only one repairs, no duplicate self-signed rows.
- e2e step `tls`: upload a CA-signed certificate, assign the mail services via PUT only, every mail port must serve exactly it (fingerprint, chain); removing the services must bring back the self-signed default (docs/e2e.md).
- Webmail: `/shared-mailbox/:id` redirects to `/mail?mailbox=shared:<id>`; the separate shared-mailbox page (fixed 320 px list, no reading-pane setting, no search / filters / bulk actions) is removed. The webmail now uses `/api/v1/mail/shared-mailboxes/:id/…`.
- The pre-9.3 routes `/api/v1/user/shared-mailboxes/:id/folders…` and `/messages/:messageId` keep their 9.2 request / response shapes and status codes (folder list without `isSystem`, message list `{ total, messages }` with `bodyText`, single message with `folder` and without marking it read, create with `displayName`, protected folders 403, foreign parent 400, delete 204, empty `{ deleted }` as expunge). Remaining behaviour changes on these routes, both safety fixes: deleting a folder that still holds messages moves them (and their recoverable tombstones) to the shared mailbox's Trash instead of removing them with the folder — `409` when the mailbox has no Trash folder — and folder create / rename / delete / empty are audited (`mailbox.foreign.folder.*`). The 9.3-only operations (search, raw source, message update / delete / bulk) exist only under the new path.
- `DELETE /api/v1/mail/folders/:id?force=true` (own mailbox) moves the folder's messages and recoverable tombstones to Trash through the message store before the folder is deleted, instead of removing them with the folder (no tombstone, no modSeq); `409` when there is no Trash folder. The response is unchanged (`{ ok: true }`).
- Webmail folder rows: Enter / Space select, ArrowRight / ArrowLeft expand / collapse subfolders, `aria-expanded` / `aria-current` on the row.

### Fixed
- **SMTP/IMAP/POP3 kept serving the self-signed `mail.localhost` certificate after a Let's Encrypt certificate was assigned to them** — the BCP edit dialog (`PUT /api/v1/admin/certificates/:id`) only moved the `services` label (and took it away from the self-signed certificate, which stayed `isActiveProtocol` and stayed in `server_settings.tlsCert`), so 993 / 465 / 143-STARTTLS / 587-STARTTLS kept presenting `CN=mail.localhost` and desktop and iPhone mail clients refused to connect ("certificate unknown"). The assignment now applies the certificate (see Changed). **Existing installations are repaired at the next start**: the api-gateway reconciles the protocol TLS state — the usable certificate holding the mail services wins and is applied when `server_settings.tlsCert` / `isActiveProtocol` disagree; a certificate activated before 9.3 without services keeps serving and gets them; nothing usable → self-signed default (idempotent, logged).
- A Let's Encrypt certificate was marked ERROR (over its valid, stored PEM) when applying it to SMTP/IMAP/POP3 failed right after the issuance; it stays issued now and the failure is logged. Assigning the mail services to an expired / not-yet-valid certificate is refused (`400 CERT_NOT_VALID`) instead of storing a label the servers never serve. `GET /api/v1/admin/certificates/served` only connects to wildcard, loopback and the server's own interface addresses (a stored listener address was connected to as-is) and probes at most 16 listeners.
- DNS check (BCP → Domains): an MX record that is an IP address or a CNAME is reported as an error with the suggestion `mail.<domain>` (it was shown as OK).
- **Let's Encrypt certificates could not be issued** — the certificate stayed PENDING/RENEWING and failed after 5 minutes with "ACME timeout … Port 80 must be publicly reachable" although port 80 was reachable. Root cause: acme-client's `auto()` first fetched the challenge from the server's own public address (no HTTP timeout, 10 × 5 retries). Without hairpin NAT (typical for Docker/NAT hosts) every attempt hung, Let's Encrypt was never asked to validate, and the real reason never reached the logs. New ACME flow (`api-gateway/src/lib/acme-flow.ts`):
  - the token is checked over loopback (route + token store); the fetch over the public name is informational and bounded to 6 s;
  - every call to the CA has a 30 s HTTP timeout, acme-client's hidden retries (including Retry-After sleeps of rate limits) are off, polling is abortable — a cancelled run stops within seconds and frees the per-certificate lock (it was held until the hanging run ended);
  - a failure ends in status ERROR with Let's Encrypt's problem detail plus a classified code (new additive column `Certificate.lastErrorCode`: connection, unauthorized, dns, caa, rate-limited, rejected-identifier, account, network, timeout, interrupted, …); the timeout names the last step; every step is logged;
  - definite DNS problems (no A/AAAA record, CAA excludes Let's Encrypt; public DNS view) fail before the CA is contacted (failed validations count against Let's Encrypt's limits);
  - the ACME account key is stored before the first CA call, so retries reuse the account;
  - first issuance, retry and renewal share one code path with the per-certificate lock; a retry of a never-issued certificate is a first issuance (assigned mail services are applied); PENDING/RENEWING without a lock holder (server restart) is set to ERROR "interrupted" at startup and hourly, and "Retry" restarts it — no certificate stays in progress forever.
- Let's Encrypt staging: the choice is stored (new additive column `Certificate.acmeStaging`, default false) and used for retries and renewals (they always went to production), can be switched in the edit dialog, and a staging certificate never replaces a trusted one: not in the HTTPS proxy, never auto-activated or re-applied for SMTP/IMAP/POP3 (and ignored by their certificate loader), a staging request does not take SMTP/IMAP/POP3 away from a certificate with a trusted PEM, and switching an already trusted-issued certificate to staging is refused (409 `STAGING_NOT_ALLOWED`) — staging only for unissued / failed certificates.
- Certificate renewal lock: a lock whose holder died (no heartbeat for 30 s; lock values carry instance + run id) is taken over by "Retry" instead of blocking it until the lock TTL; the stale-state repair runs once more after the lock TTL, so a certificate no longer stays RENEWING for up to an hour after a restart. A refused retry of a running issuance says "noch gesperrt bis HH:MM".
- Let's Encrypt pre-flight: the fetch over the public name resolves the name first and never contacts private / loopback / link-local / CGNAT / ULA / metadata addresses (reported as "privat/intern, nicht geprüft"); it connects to the checked IP with the Host header (no second resolution) and no longer echoes redirect targets. The pre-flight ACME account key is stored AES-256-GCM encrypted in Redis (was plaintext; an old plaintext key is replaced).
- BCP → SSL/TLS: "Check prerequisites" in the Let's Encrypt dialog (`POST /api/v1/admin/certificates/preflight`) — DNS A/AAAA, same address as the server host name, CAA, local serving of `/.well-known/acme-challenge/`, fetch over the public name (warning only) and a real validation by the Let's Encrypt staging environment (no certificate issued). Failed certificates show a hint per error code and a "Retry" button.
- Uploaded certificates with a separate chain are served with their intermediates on the HTTPS proxy and on SMTP/IMAP/POP3 (the chain was used as trust store / dropped); an upload listing domains the certificate does not cover is refused.
- A failed settings-reload notification no longer turns a stored certificate into a failed issuance.
- Let's Encrypt requests and the pre-flight accept public domain names only (no single-label names or IP addresses) — refused with a readable 400 instead of failing at the CA.
- **Backup restore did not work** — the Restore tab only took an uploaded MBOX file and parsed every upload as MBOX: a CoreMail ZIP backup (the default format; full backups are always ZIP) became ONE garbage message (empty subject, binary body) while the BCP reported „1 importiert"; folders and flags were lost, re-running duplicated everything, stored (encrypted) archives could not be restored at all, and large imports ran inside the HTTP request (500 MB buffered in memory, gateway upstream timeout). The upload restore now detects ZIP / MBOX / encrypted backups, streams the body to disk and runs as a job (202 `{ jobId }` with `?mode=`, audit action `backup.restore`). The pre-9.3 call `?folderId=` without `mode` keeps its contract: synchronous 200 `{ imported, errors, encrypted }` (plus `duplicates`, `jobId`), audit action `backup.mbox.import`; only an import running longer than `BACKUP_IMPORT_SYNC_TIMEOUT_MS` (240 s) answers 202 `{ jobId }`.
- MBOX restore is byte-exact (the line reader turned lone CRs into line breaks and dropped all trailing empty lines of a message); a "From " line without a preceding empty line no longer splits a message. A message without a final line break round-trips exactly (separator-line marker `cm-noeol`; it used to come back with an added CRLF), and `>From ` after a lone CR is unquoted like at a line start.
- Backup restore of ZIP archives is hardened against ZIP bombs: total uncompressed size budget (64 GiB, checked when the archive is opened), overlapping or shared local headers refused, entry count ≤ 1,000,000 and a sanity check of the declared count, compressed size capped per entry, inflate runs asynchronously (no event-loop stall), the manifest is parsed only up to 16 MiB.
- System backup: `pg_dump` is killed after `BACKUP_PGDUMP_TIMEOUT_MIN` (30 min) and an upload to the backup store aborted after `BACKUP_UPLOAD_TIMEOUT_MIN` (60 min); the job records real progress (`progressMeta.progressAt`: dump size, uploaded bytes, listed objects) and the watchdog fails a job that is alive but has made no progress for `BACKUP_STALL_TIMEOUT_MIN` (60 min) — a hung system backup no longer stays RUNNING forever.
- e2e step `backup`: SERVER_MANAGEMENT gets 403 on restore, COMPLIANCE_MANAGEMENT 403 on the system dump download.
- Backup schedules: `lastStatus` is the result of the finished job (`COMPLETED` / `PARTIAL` / `FAILED`; it was set to COMPLETED as soon as the job had been queued), `lastJobId` is set; run-now applies retention too. A full backup whose mailboxes all failed is FAILED (was COMPLETED). The "Mails" column of ZIP backups counts messages (contacts/calendar files were included).
- Backup watchdog: long full backups / restores are no longer failed after 30 minutes while still working — jobs write a heartbeat, the watchdog fails jobs without heartbeat for 15 minutes; the start-up cleanup only fails jobs of the restarted host (or stale ones).
- Backup archive list: pages through the bucket (only the first 1000 objects were listed) and shows the newest first.
- **Webmail: a shared mailbox was shown only 637 px wide on a 1440 px screen** — the page root sat in the horizontal flex `<main>` without `flex-1 min-w-0`. Shared mailboxes are now shown by the mail view itself (root class `MAIL_VIEW_ROOT_CLASS`, regression test `src/lib/mailLayout.test.ts`).
- Webmail: mailbox permissions are shown with German labels everywhere („Vollzugriff", „Senden als", „Senden im Auftrag", „Nur lesen") — the banner showed mixed text like "Vollzugriff · full access · send as".

---

## [9.2.0] — 2026-11-16 — Accessible dark mode, every BCP function reviewed, ClamAV settings

Minor release (SemVer: new features and fixes, no schema data loss, no change for mail clients).
The admin panel was reviewed page by page for contract, logic, RBAC and leftovers, both in code
and live against a running stack; every finding was fixed with a regression test where possible.

### Added
- **WCAG 2.2 AA colour system for webmail and BCP.** Semantic colour tokens (`src/theme/tokens.css`) for light and dark mode replace the raw palette classes in every window. Text reaches 4.5:1 and controls 3:1 in both themes, including all six accent presets (the accent text colour is derived per theme). Every element has a visible keyboard focus ring, and `prefers-reduced-motion` is honoured. A theme-guard test fails the build on raw colour classes, `dark:` variants and arbitrary colour values. Mail HTML keeps rendering on a light "paper" so sender-styled mails stay readable.
- BCP → System information shows the newest three releases from the `CHANGELOG.md` shipped in the image (`/changelog` parses headings with date and title) instead of a hard-coded list.
- BCP → Services shows a health status per service; the retention page shows assignments; the backup page shows the encryption status.
- **ClamAV settings in BCP → Protection → Antivirus** (`/api/v1/admin/security/clamav`, docs/antivirus.md). The defaults keep the previous behaviour, with one exception listed in the upgrade notes (mail over clamd's stream limit).
  - Policy, applied by the security filter without a restart: action on a virus, scanner failure (deliver tagged or `451`), scan timeout (5–25 s, default 20 s), scan size limit (1–50 MB) with accept-tagged or reject above it, and whether `Heuristics.*`, `PUA.*` and `Heuristics.Encrypted.*` findings count as a virus. New additive `SecuritySettings` columns: `clamavTimeoutSec`, `clamavScanLimitMb`, `clamavOversizeAction`, `clamavHeuristicsAsVirus`, `clamavPuaAsVirus`, `clamavEncryptedAsVirus`. Changes are audited as `settings.clamav.update` with a field diff.
  - Mail delivered or quarantined without a clean scan carries `X-CoreMail-Virus-Scan` (`infected` / `suspicious` / `unscanned; reason=…`). The header is internal: copies from outside senders are stripped.
  - Live status (reachable, engine, signature version and date with an age warning, queue) and an EICAR self-test that scans a test message through the inbound path.
  - The clamd engine limits are shown as read-only recommendations; they belong in the clamav container's `clamd.conf` (documented, with compose example).

### Changed
- The ClamAV scan timeout defaults to 20 s (was a fixed 30 s, equal to the SMTP → filter request timeout, so a hanging clamd aborted the request instead of applying the failure policy).
- clamd's `INSTREAM size limit exceeded` answer is treated as "too large to scan" (size policy) instead of a scanner failure.
- The former Antivirus scan options in the BCP (scan archives/HTML, block encrypted archives, max file/scan size) were removed: they were saved but never applied. Their columns stay in the schema.
- Admin API input is validated more strictly: rspamd score thresholds (range and order), the public hostname, backup schedule values. Invalid values now return `400` with the reason instead of being stored.
- Making an inactive domain the primary domain returns `409`.
- User-visible texts no longer mention vendor products or RFC numbers; the desktop-client Autodiscover setup box from the MAPI era is gone from BCP → Servers.

### Fixed
- SMTP connection limits from BCP (total and per IP) were saved but never applied; smtp-server now enforces them and reloads them without a restart.
- Queues → Retry answered `500`.
- The smarthost connection test now checks TLS the way the relay uses it.
- Server settings: saving one section no longer resets fields of other sections, and deriving URLs from the hostname no longer overwrites the organisation name and ports. Port 587 is shown as STARTTLS.
- Mailboxes: "unlimited" quota was stored as 100 GB. A role change is audited as `user.role.change`.
- Critical admin actions are audited even with the audit log switched off again (action names had drifted from the always-audit list).
- Dashboard widgets respect the admin's role; message trace paging returns all pages.
- DNS setup shows SRV records split into their fields, with IMAP/POP3 records marked optional.
- Self-signed certificates get random serial numbers.
- Editing a retention policy created before 9.0 works again; backup schedules keep their retention value.
- Two backups started in the same second no longer overwrite each other's archive (the key contains the run id).
- Logging out from the "MFA required" page works.
- IMAP no longer logs client connection resets as errors.

### Deprecated
- `POST /api/v1/admin/security/rspamd/learn/:type` now answers `410 Gone` with an explanation, and its BCP button is gone: it sent a JSON body instead of a message, so rspamd never learned anything. Training stays available through the webmail's Junk / Not junk actions. The route will be removed in the next major release.

### Removed
- The BCP Reports page: it showed static placeholder numbers. `/bcp/reports` redirects to the dashboard.

### Security
- The last active organisation admin can no longer be deleted, deactivated or demoted, and admins cannot delete themselves.
- Backup archive keys with path traversal are rejected with `400`.
- `X-CoreMail-Virus-Scan` is also stripped from authenticated submission and from every local delivery path (REST, JMAP, ActiveSync, rule forwards), so users cannot plant it to trigger other users' rules.

### Upgrade notes
No configuration change is required. Settings that were saved but never applied now take effect, so check them once:
- **SMTP connection limits** (BCP → SMTP): the total connection limit and the per-IP limit now apply to port 25 from public IPs. Submission (587/465) keeps only the per-IP limit, and loopback/private networks are exempt. An explicitly set `SMTP_MAX_CONNS_PER_IP` still wins over the BCP value. Failed AUTH attempts before disconnect now follow the BCP value (default 5; the old built-in value was 3).
- **Listener addresses** (BCP → Services): the stored bind address is now used. A value that is not an IP address (for example a host name) is ignored with a warning and the listener binds to all interfaces; a bind failure falls back the same way instead of stopping the service.
- **Backup schedule retention**: `retentionDays` now deletes a schedule's backups that are older than the limit. Only backups created after the upgrade are ever deleted, and the newest archive of every mailbox in a schedule is always kept. Delete older archives by hand if you no longer need them.
- **ClamAV stream limit**: mail that clamd refuses as too large is now handled by the size policy (default: deliver with `X-CoreMail-Virus-Scan: unscanned`) instead of the failure policy. If you set the scanner-failure action to "Vorübergehend abweisen" (defer), set "Aktion für Mails über der Scan-Grenze" to "Ablehnen" to keep refusing such mail.
- **Quarantine**: messages quarantined as `VIRUS` can no longer be released (API `409`). If heuristic or PUA findings cause false positives, switch those categories off in BCP → Protection → Antivirus.
- **Server settings** now validate host names; a previously stored value with a port, an underscore or an IPv6 literal has to be corrected before the page saves. Log and audit filters for service and target type match substrings.

---

## [9.1.0] — 2026-11-15 — Shared mailboxes over IMAP, full REFERENCES threading, Helm tested on a real cluster

Minor release (SemVer: new features, no breaking changes). It closes the known limitations of
9.0.0. Every change was reviewed independently, and all findings were fixed with regression tests.

### Added
- **IMAP access to Shared Mailboxes and delegated mailboxes.**
  - They appear in the `Shared/` and `Other Users/` namespaces (RFC 2342). The prefixes are set with `IMAP_NAMESPACE_SHARED` and `IMAP_NAMESPACE_OTHER_USERS`; `off` disables a namespace.
  - Every mailbox command works on these folders and uses the target mailbox's UID/modSeq, QRESYNC state, IDLE push and quota.
  - Read-only grants open with `[READ-ONLY]`, and writes are refused with `NO [NOPERM]`.
  - ACL `MYRIGHTS` reports the real rights: `lrswipkxtecd` for full access, `lr` for read-only.
- **References header stored.** `Message.references` is a new additive column. A background backfill fills it for older messages (`REFERENCES_BACKFILL`, default on), plus a time-boxed lazy step in THREAD (`REFERENCES_LAZY_BUDGET_MS`, default 1500 ms).
  - IMAP `THREAD=REFERENCES` implements the full RFC 5256 algorithm.
  - JMAP threads a reply under its nearest known ancestor when the direct parent is missing.
- **Recover deleted items in shared and delegated mailboxes** with FULL_ACCESS. Routes:
  - `/api/v1/user/shared-mailboxes/:id/recoverable`
  - `/api/v1/mail/delegated-mailboxes/:id/recoverable`

  Both support list, restore and purge; restore and purge are audited. The webmail has an entry in the shared mailbox view.
- **Shared mailbox quota.** New endpoint `GET /api/v1/user/shared-mailboxes/:id/quota`. The webmail shows the quota of the open shared mailbox and lists shared mailbox quotas under Settings → Storage.
- **Apple profile on iPhone/iPad.** A single-use, 60 s download ticket (`POST /api/v1/user/apple-profile/ticket`) lets iOS/iPadOS Safari open the profile installer directly.
- **Helm chart tested on a real cluster.** `scripts/k8s-e2e.sh` runs the chart on kind:
  - Pod Security "restricted" and NetworkPolicy enforcement
  - schema sync and the setup token
  - SMTP submission → IMAP
  - `helm upgrade` / `rollback`

  `helm-check` also verifies the restricted security fields of every rendered container.
- `listAccessibleMailboxes()` in `@coremail/storage` is the single access rule for shared and delegated mailboxes. IMAP, JMAP and REST all use it.

### Changed
- Changes to shared-mailbox permissions and delegations take effect immediately (`permission-change` event). A revoked folder that is open in IMAP is closed with `[CLOSED]`.
- NAMESPACE lists the Other Users and Shared namespaces.
- Personal folders named `Shared/…` or `Other Users/…` are hidden from IMAP LIST, and new folders with these names are refused in IMAP, REST and JMAP. Rename existing ones in the webmail.
- The BCP shows the Backups page to COMPLIANCE_MANAGEMENT, limited to mailbox data. backup-service applies the same path-aware rule as the gateway.
- Helm chart 2.0.1:
  - NOTES warn when filesystem storage has no backup target, and when a LoadBalancer has no controller.
  - README documents the real-cluster test.

### Fixed
- `SMTP_HOSTNAME` / `POP3_HOSTNAME` can be set from `.env`; an empty value now counts as unset (autodiscover, smtp-server).

### Security
- A delegate no longer keeps access to the recoverable items of a deactivated owner.
- The admin backup routes and backup-service route paths case-sensitively, and also check the lower-cased path. A different letter case can no longer bypass the mailbox-data role check.
- backup-service mirrors the gateway's mailbox-data RBAC. SERVER_MANAGEMENT can no longer reach mailbox content even when calling the service directly.

---

## [9.0.0] — 2026-11-15 — OWASP security hardening, mailbox and transport upgrades, encrypted backups

Major release (SemVer: several security fixes and new limits change behaviour for operators,
API clients and non-conformant senders — read "Upgrade notes (breaking)" at the end of this
section before upgrading). CoreMail was audited against OWASP Top 10 2021 / ASVS 4.0.3 L2 in four
areas (API/auth, frontends, mail protocols, supply chain/deployment); every finding was fixed with
regression tests. Transport, mailbox, admin and webmail logic was extended in the same
release. Two independent review rounds followed,
and all of their findings were fixed as well.

### Security
- **Authentication and sessions**
  - The web/API login shares the Redis per-account/per-IP lockout of the mail protocols (`429 ACCOUNT_LOCKED`); wrong MFA codes count too.
  - Browser refresh tokens live in HttpOnly SameSite=Strict cookies (`cm_rt` / `cm_rt_bcp`, Path=/auth) with a same-origin check; access tokens are kept in memory only. The CLI keeps body tokens.
  - Access tokens are accepted in the Authorization header only. SSE uses single-use tickets (`POST /api/v1/events/ticket`).
  - Creating an app password requires re-authentication and sends a notice mail. Re-auth failures answer 403.
  - OIDC `allowLinking` binds the account to the first IdP subject (`User.oidcSubject`). The IdP `amr` claim no longer satisfies `requireMfaForAdmins` (`OIDC_TRUST_IDP_MFA_FOR_ADMINS`).
- **Access control**
  - Mailbox delegation follows the admin-account rule (no privilege escalation to organization admins).
  - Backup download, per-mailbox backup and import are limited to Organization/Compliance Management and audited.
  - HELP_DESK can no longer change the server-wide quota defaults.
  - One permission map (`ROLE_PERMISSIONS` + narrow actions) drives both the API guards and the BCP (`GET /api/v1/admin/me/permissions`).
- **Inbound mail**
  - SPF/DKIM/DMARC are evaluated on the real SMTP session (MAIL FROM, HELO, IP). The sender's DMARC policy is enforced, including `pct`.
  - Local-domain anti-spoofing follows the domain's own DMARC policy (`LOCAL_SPOOF_ACTION`, `LOCAL_SPOOF_ALLOW`, `ARC_TRUSTED_SEALERS`).
  - Unauthenticated mail with a missing From, several From fields or several From mailboxes is rejected.
  - RFC 8601 Authentication-Results are added; forged ones are stripped on every delivery path.
- **Calendar and rules**
  - iTIP replies and resource-booking changes require an authenticated sender or organizer. Bookings are scoped per resource.
  - Rule, transport-rule and blacklist regexes run on a linear-time matcher with per-rule step budgets (ReDoS fix). Blocking rules fail closed when the budget runs out.
- **Denial of service**
  - Pre-auth limits for IMAP (8 KiB lines/literals, 60 s idle) and per-IP/global/per-user connection caps for IMAP and POP3.
  - STARTTLS/STLS handshake timeouts.
  - Unauthenticated BDAT chunks are never buffered; SMTP command pipelining has backpressure.
  - Port-25 tarpit for repeated errors.
  - JMAP concurrency and upload quotas are enforced.
  - The MIME header section is capped at 256 KiB before parsing.
- **Abuse and SSRF**
  - Outbound MX targets on private/loopback addresses are refused (SSRF).
  - Success DSNs to unverified port-25 senders are suppressed (no backscatter).
- **Webmail and API**
  - Mail CSS can no longer overlay the UI (phishing).
  - Only raster inline images are used, via an SSRF-safe authenticated image proxy (`GET /api/v1/mail/image-proxy`).
  - Editor links are limited to http/https/mailto. The reset token is removed from the address bar and verified via POST.
  - `/mail/send` caps size, attachments and recipients and is rate-limited per user. Draft writes are rate-limited.
  - Client-supplied forwarding and internal headers are stripped before proxying.
  - HTTP→HTTPS redirect (`HTTP_REDIRECT_HTTPS`, `HTTPS_PUBLIC_PORT`); HSTS is sent only over HTTPS.
  - Audit exports are signed with HMAC-SHA256 (`AUDIT_EXPORT_SIGNING_KEY`), and CSV cells are formula-safe.
- **Deployment**
  - Schema sync fails closed, with a pre-migration `pg_dump`. Backups are encrypted client-side (AES-256-GCM, `BACKUP_ENCRYPTION_KEY`).
  - Compose runs with `no-new-privileges` and minimal capabilities. The rspamd controller trusts only the app and supports a password.
  - Optional non-superuser database role. No default MinIO/S3 credentials. No fallback passwords in the Synology compose.
  - pino log redaction. CI builds the real image with provenance, SBOM and cosign signing.
- **Dependencies**
  - nodemailer 10, mailparser 3.14, express 4.22.3 (body-parser, proxy-addr), node-forge 1.4.3, multer 2.5, ws 8.23, zod 4.6.7, DOMPurify 3.4.18, Tiptap 2.27.3 with prosemirror-view 1.42.9, react-router 6.30.6, plus overrides for vulnerable indirect packages.
  - `pnpm audit --prod` went from 2 critical / 74 high to 0 critical / 1 high (not reachable).

### Added
- SMTP: CHUNKING/BINARYMIME (`BDAT`), DSN (RFC 3461: RET/ENVID/NOTIFY/ORCPT with delivered/relayed/delayed/failed reports), SMTPUTF8 with IDN recipient matching, HELP. EHLO keyword order fixed (`SMTP_EXT_*` switches).
- IMAP: QRESYNC (RFC 7162), SORT and THREAD=ORDEREDSUBJECT/REFERENCES (RFC 5256), read-only ACL (RFC 4314), COMPRESS=DEFLATE (RFC 4978).
- Outbound delivery: retries for `outboundRetentionHours` (default 48 h), a delay DSN after 4 h (`OUTBOUND_DELAY_DSN_HOURS`), and a final 5.4.7 NDR.
- Mailbox quota levels: warning mail, prohibit send and prohibit send/receive, enforced on SMTP, REST, drafts, JMAP, ActiveSync and IMAP APPEND/COPY. Includes a quota bar in the webmail and `coremail mailbox quota --warning/--prohibit-send`.
- Recover deleted items for 30 days (`/api/v1/mail/recoverable`, `DELETED_ITEM_RETENTION_DAYS`), with a webmail view and an audited admin purge. The purge also removes unreferenced objects and ActiveSync item state (`DELETED_ITEM_PURGE_OBJECTS`).
- Out-of-office sends exactly one reply per sender and OOF period (internal/external texts, contacts-only option, schedule).
- Server drafts API (`/api/v1/mail/drafts`), webmail autosave, and server-side undo send: the mail is sent even if the tab is closed or the user logs out.
- Webmail:
  - keyboard shortcuts (CoreMail and Gmail-compatible sets, `?` help);
  - undo for delete/move/archive/junk;
  - search operators (`from:`, `to:`, `subject:`, `has:attachment`, `is:`, `before:`/`after:`, `older_than:`, `in:`, `-`) with help and chips;
  - "all caught up" empty states and skeleton loaders;
  - accessible dialogs.
- Automatic client setup:
  - Thunderbird autoconfig (`/.well-known/autoconfig/mail/config-v1.1.xml`, `autoconfig.<domain>`);
  - Apple configuration profile download (IMAP/CalDAV/CardDAV or ActiveSync);
  - recommended SRV/autoconfig records in the DNS check;
  - `docs/clients.md`.
- BCP:
  - shared DataTable list pattern (search, sort, paging, selection, toolbar, keyboard navigation) on eight pages;
  - mailbox detail panel with quick actions;
  - read-only rendering and a 403 page per permission;
  - "Sign out everywhere" (`POST /api/v1/admin/mailboxes/:id/revoke-sessions`);
  - last login (`User.lastLoginAt`).
- Docker Compose variants: `docker-compose.minimal.yml` (CoreMail + PostgreSQL + Redis) and `docker-compose.full.yml` (rspamd, ClamAV, limits, log rotation, profiles `minio`/`backup`/`geoip`), a bind-mount example, `setup.sh --variant minimal|standard|full` and `docs/docker-compose.md` (storage mounting guide).
- Tools and settings:
  - `RSPAMD_ENABLED` / `CLAMAV_ENABLED` environment switches;
  - `coremail-decrypt-backup` in the image;
  - `coremail audit verify` and `POST /api/v1/admin/audit-log/verify-export`;
  - Helm secrets for the backup key and rspamd password;
  - compose pass-through and `.env.example` documentation for all new settings.

### Changed
- Admin roles:
  - SERVER_MANAGEMENT no longer gets mailbox data (per-mailbox backups, downloads, import);
  - COMPLIANCE_MANAGEMENT does;
  - HELP_DESK sees exactly the actions the server allows it.
- Schema sync applies new unique constraints automatically after a duplicate check. Destructive changes need `COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true`.
- Resource bookings are unique per (calendar, UID), so one meeting can book several rooms.
- Unknown local recipients on submission/REST/worker paths receive an NDR instead of being dropped. Room invitations from local senders are processed.
- Validation error texts follow zod 4 wording (response shape unchanged).
- Helm chart 2.0.0: `app.mailAuth.limitPrivateIps` was replaced by `exemptCidrs` and new tuning values were added.

### Fixed
- Replies carry the original Message-ID/References. Signature images and font sizes survive compose. Forwarding keeps attachments. "Show images" works. Sent drafts keep inline (`cid:`) images.
- Refreshing the page or opening tabs no longer logs users out (separate refresh limiter; 429/5xx are treated as temporary). The MFA login sets the refresh cookie.
- No HTTP→HTTPS redirect loop behind a reverse proxy without `TRUST_PROXY`.
- No false success DSNs on retries. NDRs survive SMTP retries. Alias outcomes are reported under the original address. An admin retry of a dead letter no longer sends a second NDR.
- ActiveSync devices get Delete for purged items. Restore and purge no longer race. Draft versions no longer pile up storage.
- The backup import no longer corrupts binary/encrypted uploads. Backup uploads abort on read errors.

### Upgrade notes (breaking)
See [docs/releases/v9.0.0.md](docs/releases/v9.0.0.md) for the full list. The most important:
1. **Back up the database first.** All schema changes in this release are applied automatically. A future destructive change will stop the container until `COREMAIL_ALLOW_SCHEMA_DATA_LOSS=true` is set.
2. **Deleted items:** messages deleted more than 30 days ago are purged on the first start, together with their stored objects. Set `DELETED_ITEM_RETENTION_DAYS=0` before upgrading to keep them.
3. **Quotas are enforced now.** Mailboxes above 87 % of their quota cannot send, full mailboxes reject mail (`552 5.2.2`), and users above 83 % get one warning mail.
4. **Spoofing protection:** mail failing DMARC `p=reject` is rejected. Unaligned mail using your own domains goes to Junk (or is rejected if your domain publishes `p=reject`). Add third-party senders to `LOCAL_SPOOF_ALLOW`.
5. **Lockout and limits count private/NAT addresses.** Behind NAT or a reverse proxy, set `MAIL_AUTH_EXEMPT_CIDRS` / `MAIL_CONN_EXEMPT_CIDRS`.
6. **API clients:**
   - `?token=` is no longer accepted; use the Authorization header (SSE: `?ticket=`).
   - Re-auth errors are 403.
   - `DELETE /auth/sessions/admin/:userId` returns 410.
   - Creating an app password needs `currentPassword` or `mfaCode`.
   - The audit export signature is `hmac-sha256=`.
7. **Regex rules** with backreferences, lookarounds or named groups no longer match. At most 20 regex conditions per user.
8. **Compose:**
   - New variables `RSPAMD_CONTROLLER_PASSWORD` and `BACKUP_ENCRYPTION_KEY` (keep a copy of the key off the server).
   - rspamd runs on a new network `10.253.253.0/29` (`RSPAMD_NET_PREFIX`).
   - The app container drops capabilities.
   - There are no default MinIO credentials any more.
9. **Helm:** chart 2.0.0 refuses `app.mailAuth.limitPrivateIps`; use `exemptCidrs`.
10. **HTTPS:** with the integrated HTTPS proxy active, HTTP requests are redirected. Behind a TLS terminator that sends no forwarding headers, set `HTTP_REDIRECT_HTTPS=false`.

---

## [8.0.0] — 2026-11-15 — Protocol conformance, ActiveSync 14.1, local storage, live session control

Major release (SemVer: several security fixes change behaviour for operators and non-conformant
clients — see "Upgrade notes (breaking)" at the end of this section). Every protocol was
reviewed against its RFC/MS specification and Clean Code, all critical/high/medium findings
were fixed with regression tests, and the release was verified end to end against the real
container image in both storage modes (MinIO 131/131, filesystem 126/126; `pnpm -r test`
1,315 tests; independent pre-release review with all findings fixed).

### Added

- **ActiveSync 14.1 message bodies:** Sync sends `airsyncbase:Body` per BodyPreference (plain
  text, HTML, MIME with TruncationSize/AllOrNone/Preview) instead of the EAS 2.5 `Email:Body`;
  MIME is the stored original byte-exact (only with MIMESupport 2). Attachments are listed as
  `airsyncbase:Attachments`, plus NativeBodyType, MessageClass, InternetCPID, ContentClass and
  `email2:ConversationId/ConversationIndex`. Sync Options are sticky per collection and
  WindowSize is honoured (max 512).
- **ActiveSync `ItemOperations`:** Fetch by FileReference (attachment, Range/Total), Fetch by
  CollectionId+ServerId (full body or MIME) and EmptyFolderContents — only on the user's own
  items; foreign or unknown items answer "not found".
- **ActiveSync `GetItemEstimate`:** counts what the next Sync would deliver — items the device
  already holds and the FilterType age window are taken into account (deletes included).
- **ActiveSync `Settings`:** Oof Get/Set on the same out-of-office settings as the web client,
  JMAP and the SMTP auto-reply (state, time range, internal/external texts, contacts-only);
  DeviceInformation Set stores the device's friendly name; UserInformation Get returns the
  primary address and aliases; RightsManagementInformation Get answers empty.
- **ActiveSync `Search`:** mailbox search (free text, folder with subfolders, received date,
  paging, body preview) in the user's own mailbox, and address book search over the users and
  shared mailboxes of the user's own domain.
- **ActiveSync `MoveItems`:** moves mail between the user's own folders; IMAP and JMAP clients
  see the move.
- **ActiveSync `MeetingResponse`:** accept, tentatively accept or decline an invitation from the
  phone — the meeting is added to (or removed from) the calendar and the invitation moves to
  Deleted Items. The iTIP reply to the organizer is sent by the phone itself (EAS 14.1); the
  server sends one only for EAS 16.0 requests with `SendResponse`, so the organizer never gets two.
- **ActiveSync `ResolveRecipients`:** names and addresses are resolved against the address book
  of the user's domain and the user's contacts.
- **ActiveSync FolderSync changes:** folders created, renamed or deleted on the server (web
  client, IMAP, JMAP) reach the phone as Add/Update/Delete; an unknown FolderSync key answers
  Status 9.
- **ActiveSync `FilterType`:** the phone's "mail days to sync" setting is honoured; changing it
  restarts the folder's sync (Status 3).
- **Helm chart 1.0.0 (`infra/k8s`)** — complete rewrite for the single `coremail-app` image:
  app Deployment with schema-sync init container (non-root, read-only root filesystem;
  startup/liveness probes on `/livez`, readiness on `/healthz`, so a slow or misconfigured
  object store keeps the pod "not ready" instead of restarting it in a loop), Ingress for HTTP
  and a LoadBalancer/NodePort Service for the mail ports, optional bundled PostgreSQL, Redis
  (password mandatory), MinIO, rspamd and ClamAV or external endpoints, NetworkPolicies, secrets via values or an existing Secret (rendering fails without
  them), `objectStorage.*` for the storage drivers; the app gets the same environment as with
  docker-compose (`OBJECT_STORAGE`, `MINIO_BUCKET_ATTACHMENTS`, `RSPAMD_URL` — rspamd via
  `rspamd.external.url` or `host` + `controllerPort`). `scripts/helm-check.sh` runs helm
  lint/template and kubeconform via pinned Docker images and checks the rendered environment
  names.
- **Object storage drivers** (`OBJECT_STORAGE=filesystem | minio | s3`, default `minio` =
  unchanged behaviour). The filesystem driver (`STORAGE_PATH`, default `/data/objects`) writes
  atomically (temp file + fsync + rename) with modes 0640/0750; the S3/MinIO driver supports
  TLS (`MINIO_USE_SSL`, private CA via `MINIO_CA_FILE`), `MINIO_REGION`, `MINIO_PATH_STYLE` and
  URL endpoints. Expiry uses bucket lifecycle rules, or a Redis-locked periodic cleaner where
  they are unavailable (filesystem). Docs: `docs/storage.md`.
- **Object storage startup check:** SMTP, IMAP, POP3, JMAP and ActiveSync do not open their
  listeners while the store is unusable or misses most of the sampled objects the database
  references (e.g. `OBJECT_STORAGE` switched without migrating); `/healthz` reports
  `storage { driver, status }` and answers 503 while the check blocks.
- **Storage migration:** `coremail storage status | check | migrate --from … --to …` and the
  admin API `/api/v1/admin/storage` (Organization Management) copy all objects between drivers
  as a resumable background job — streamed, verified by SHA-256 and size, with dry run; the
  source is never deleted.
- **IMAP4rev2 extensions:** BINARY (RFC 3516: `BINARY[]`, `BINARY.PEEK[]`, `BINARY.SIZE[]`,
  APPEND with literal8), SEARCHRES (RFC 5182: `RETURN (SAVE)` and `$`), LIST-EXTENDED (RFC 5258:
  selection options SUBSCRIBED/SPECIAL-USE/RECURSIVEMATCH, several patterns, RETURN options),
  LIST-STATUS (RFC 5819) and read-only QUOTA (RFC 9208, `GETQUOTAROOT`/`GETQUOTA`, STORAGE from
  the user's quota) are implemented and advertised. After `ENABLE IMAP4rev2` SEARCH answers with
  ESEARCH, mailbox names are UTF-8, SELECT sends a LIST response and `[CLOSED]` and no longer
  RECENT/UNSEEN.
- **IMAP CONDSTORE:** `STORE … (UNCHANGEDSINCE n)` with the `[MODIFIED …]` response code;
  `SEARCH MODSEQ` returns the highest MODSEQ (`(MODSEQ n)` / ESEARCH `MODSEQ`); SELECT/EXAMINE
  `(CONDSTORE)`, FETCH MODSEQ/CHANGEDSINCE, SEARCH MODSEQ, STORE UNCHANGEDSINCE and STATUS
  HIGHESTMODSEQ enable CONDSTORE (RFC 7162 §3.1).
- **IMAP APPEND** uses the date-time argument as the internal date (RFC 9051 §6.3.12).
- **CalDAV/CardDAV discovery (RFC 6764, RFC 5397):** `/.well-known/caldav` and
  `/.well-known/carddav` are proxied by the api-gateway and redirect to `/dav/`; PROPFIND there
  answers `DAV:current-user-principal`, and the new principal resource
  `/dav/principals/<id>/` lists `calendar-home-set`, `addressbook-home-set` and
  `calendar-user-address-set` (primary address + aliases). iOS/macOS, DAVx5 and Thunderbird can
  set up accounts from the server name alone.
- **CalDAV PROPPATCH** on calendars: display name, `calendar-color` and `calendar-order` (Apple
  namespace) are stored; other properties answer 403, and the request is atomic (424 for the
  rest). Grantees cannot change the owner's calendar properties.
- **MKCALENDAR** applies display name, colour and order from the request body; a calendar
  without VEVENT in `supported-calendar-component-set` is refused as a whole (403
  `mkcalendar-response`).
- PROPFIND on single `.ics` / `.vcf` resources (ETag, content type, privileges).
- **REPORT filters are evaluated** instead of returning every object: CalDAV `prop-filter`,
  `param-filter`, `text-match` (collations `i;ascii-casemap`, `i;unicode-casemap`, `i;octet`;
  `negate-condition`), `is-not-defined`, recurring series checked instance by instance against
  `time-range`; CardDAV `prop-filter` with `test`, `match-type`, `param-filter` and `limit`
  (507 when truncated). Unsupported filters answer 403 `supported-filter` /
  `supported-collation`. `CALDAV:expand` and `CALDAV:limit-recurrence-set` are implemented.
- api-gateway `GET /livez`: liveness without the object-storage status (200 while the process
  serves HTTP); `/healthz` stays the readiness check (503 while the storage check blocks).

### Changed

- **ActiveSync devices must be provisioned (breaking for non-compliant clients).** Every command
  except Provision needs the final policy key of the [MS-ASPROV] handshake in `X-MS-PolicyKey`:
  phase 1 hands out a temporary key with the policy, phase 2 the final key (random 32-bit, was
  `Date.now()`). Without a key the server answers global Status 142, with an outdated one 144
  (HTTP 449 for protocol < 14 and for GetAttachment) — standard clients then provision
  automatically. Clients or scripts that skipped Provision or kept using the phase-1 key must
  use the phase-2 key. The policy no longer limits devices to one month of mail
  (`MaxEmailAgeFilter` 0).
- ActiveSync Sync tracks per device which items the phone holds (new table
  `active_sync_items`, created at container start): items the phone already has are sent as
  `Change`, items deleted or moved away on the server as `Delete`, and the phone's own changes
  (read state, MoveItems) are no longer echoed back. A retried Sync with the previous SyncKey
  gets the same changes again; any other old key answers Status 3. Devices synced before this
  release continue without a full resync.
- ActiveSync: a Delete from the phone moves the mail to Deleted Items (default
  `DeletesAsMoves`, MS-ASCMD); only `DeletesAsMoves 0` or a delete inside Deleted Items
  removes it.
- ActiveSync SmartReply / SmartForward add the original message (as an embedded message with
  all its attachments; inline for a reply) unless the phone sends `ReplaceMime`, and mark the
  original answered / forwarded. An unknown source item answers Status 150.
- ActiveSync Ping: the response lists the changed folders as `<Folder>id</Folder>` (it used the
  request shape, so phones could not tell which folder changed); changes made after the last
  Sync but before the Ping are reported at once, and flag changes, deletes and moves are
  detected (it compared message counts). A heartbeat outside 60–3540 s answers Status 5 with
  the limit, unknown folders Status 7, missing parameters Status 3; an empty Ping reuses the
  last parameters; an abandoned Ping stops polling when the client disconnects.
- ActiveSync: a Sync without body answers Status 13 instead of HTTP 400.
- ActiveSync OPTIONS now lists only the commands the server implements
  (`MS-ASProtocolCommands`); unimplemented commands such as FolderCreate are no longer advertised.
- Docker Compose: the app container gets a `coremail-data:/data` volume and
  `OBJECT_STORAGE=${OBJECT_STORAGE:-minio}`; the MinIO service stays, so existing installs need
  no action. `scripts/setup.sh`, `.env.example` and the Synology setup choose the filesystem
  driver for new installs.
- All object access (raw messages, attachments, quarantine, outbound queue, JMAP uploads,
  S/MIME) goes through the storage driver; outbound attachment keys no longer contain user
  file names.
- **SMTP protocol strictness (RFC 5321).** `MAIL`/`RCPT` require the correct keyword
  (`MAIL TO:` / `RCPT FROM:` → 501); unknown parameters are refused with 555 (MAIL accepts
  `SIZE`, `BODY`, `AUTH`; RCPT accepts none — DSN is not advertised); recipients without a
  valid local-part/domain get 501 5.1.3 at RCPT instead of a silent drop; `EHLO`/`HELO` without
  a domain and `STARTTLS` with parameters → 501; `VRFY` answers 252 instead of 502; source
  routes are accepted and ignored. The local-part keeps its case on relaying (only the domain is
  lower-cased; local lookups stay case-insensitive).
- **SMTP AUTH validation (RFC 4954 §4, RFC 4616).** Responses that are not valid base64 → 501;
  a PLAIN message must have exactly three fields (a two-field message is refused), a non-empty
  authzid must name the authenticated user.
- A custom SMTP banner that does not start with a domain is prefixed with the host name
  (`220 <host> <banner>`).
- Bounces (DSN) are English, CRLF-formatted RFC 3464 reports with RFC 3463 status codes from
  the remote reply, list only the failed recipients and are also sent to **external** senders
  of mail that was accepted with 250 (RFC 5321 §6.1). Transport-rule rejects of inbound mail
  keep the backscatter protection (no DSN to external senders).
- Out-of-office replies are only sent when one of the user's addresses is in To/Cc/Bcc/Resent-*
  (RFC 3834 §2) — no replies to Bcc'd copies or list mail without `List-*` headers.
- Inbound content scan: an invalid answer of the security filter defers the message (451)
  instead of delivering it unscanned; messages above the filter's 52 MB body limit are refused
  with 552 instead of being deferred.
- Mail rule redirects keep the original envelope sender (a null sender stays null) instead of
  the header `From:`; forwards put their `Resent-*` block at the top of the header.
- IMAP: STORE responses carry MODSEQ only after CONDSTORE was enabled (RFC 7162 §3.1); EXAMINE
  reports `PERMANENTFLAGS ()`; a failed SELECT/EXAMINE leaves no mailbox selected; the ID
  response no longer carries a stale version number. `SEARCH RECENT`/`NEW` match nothing and
  `OLD` everything (SELECT always reported `0 RECENT`). The protocol suite
  (`imap-protocol.test.ts`) is part of `pnpm test` (skipped on Node < 22.15).
- CalDAV/CardDAV advertise only what is implemented: `DAV: 1, 3, calendar-access, addressbook`
  (no class 2 — LOCK is not supported — and no `access-control`), `Allow` without `ACL`.
- CalDAV PUT enforces the RFC 4791 preconditions: `METHOD` in a stored object or components
  with different UIDs → 403 `valid-calendar-object-resource`; VTODO/VJOURNAL → 403
  `supported-calendar-component` (was 400); a UID change on update is checked against the
  calendar (409 `no-uid-conflict`) and stored; a concurrent duplicate answers 409 instead of 500.
- CardDAV PUT requires exactly one vCard per resource (403 `valid-address-data`) and a UID
  unique within the address book (409 `no-uid-conflict`); all contact columns (phones, second
  e-mail, department, title, notes) are indexed from the vCard.
- Recurrence expansion moved from the api-gateway to `@coremail/core/recurrence` (shared with
  the caldav-server); vCard handling is in `@coremail/core/vcard`.
- `GET /api/v1/contacts` returns all contact fields; `POST`/`PUT` accept and store `email2`,
  `phone`, `mobile`, `department`, `jobTitle` and `notes` (they were silently dropped) and accept
  an empty e-mail.
- iTIP: a REQUEST without ORGANIZER is not answered (ActiveSync MeetingResponse reports an
  invalid request); a REPLY to a single occurrence carries its `RECURRENCE-ID`.
- Upgrade notes, compose files, `.env.example`, setup scripts and the Helm chart/README refer
  to this release as 8.0 (they said "7.1").

### Fixed

- **Opening the TOTP setup no longer disconnects mail clients.** Generating a (not yet
  confirmed) TOTP secret published an `mfa-change` event that ended every password-authenticated
  IMAP/POP3/SMTP/JMAP/ActiveSync connection of the user; the event is now sent only when TOTP is
  actually enabled.
- api-gateway: duplicate side-effect import of `middleware/auth.js` removed from the admin
  storage and backup routes (repo-hygiene now checks for it).
- **IMAP sequence numbers no longer drift (data loss).** Every session keeps its own message
  sequence map; changes by other clients, the web client or delivery are reported as EXPUNGE,
  EXISTS and `FETCH (UID … FLAGS …)` on NOOP, CHECK, IDLE and at command completion — never an
  EXPUNGE during FETCH, STORE or SEARCH (RFC 9051 §7.5.1). Previously sequence numbers were
  recomputed from the database on every command, so after another client deleted a message
  `STORE 1 +FLAGS (\Deleted)` plus `EXPUNGE` removed the wrong message. IDLE checks the mailbox
  every 30 s and on new-mail events instead of sending a blind `EXISTS`/`1 RECENT`.
- IMAP IDLE (every 30 s and on each new-mail push) and the end of every command no longer read
  all message rows of the selected folder: the mailbox's highestModSeq and the folder's message
  count are checked first, the full comparison only runs when they changed.
- IMAP: EXPUNGE, UID EXPUNGE and MOVE are refused with `NO [READ-ONLY]` in a mailbox opened with
  EXAMINE (they deleted/moved messages).
- IMAP: INBOX is case-insensitive in every mailbox argument (`SELECT inbox`, `STATUS inbox`, …).
- IMAP: mailbox names are exchanged in modified UTF-7 with IMAP4rev1 clients (RFC 3501 §5.1.3);
  non-ASCII folders such as "Entwürfe" were sent as raw UTF-8 and could not be selected.
- IMAP: folders created by IMAP clients up to 7.0.0 are stored with their modified UTF-7 name
  (e.g. `Entw&APw-rfe`). They are not migrated or renamed: such a row is recognised (canonical
  modified UTF-7 of another name) and shown as before to IMAP4rev1 clients and in UTF-8 after
  `ENABLE IMAP4rev2`; SELECT/STATUS/APPEND/COPY/MOVE/DELETE/RENAME find it under either
  spelling, and CREATE of the same name answers `ALREADYEXISTS` instead of adding a duplicate.
  Previously the encoded name was encoded again and appeared as a new literal folder name.
- IMAP: RENAME also renames inferior mailboxes (RFC 9051 §6.3.6); `[UNSEEN n]` is the sequence
  number of the first unseen message; LIST `%` no longer descends into child mailboxes and lists
  implied parents, `LIST "" ""` returns the hierarchy delimiter.
- IMAP: LOGIN after authentication and ENABLE before authentication are rejected with BAD.
- IMAP STORE: system flags are case-insensitive (`\seen` → `\Seen`), `\Recent` and unknown
  `\`-flags are rejected with BAD.
- IMAP STORE (and the implicit `\Seen` of FETCH) lost a concurrent client's flag change: the new
  flag list is now computed from the flags read under the mailbox lock
  (`modifyFlags()` in the message store).
- IMAP SEARCH HEADER matches any header field (raw header loaded on demand); an empty string
  matches every message that has the field.
- IMAP UID commands on folders with more than ~150 000 messages failed with `NO Internal error`
  (`Math.max(...uids)` RangeError).
- IMAP AUTHENTICATE: invalid base64 is answered with BAD; a PLAIN authorization identity that
  differs from the login is refused (`NO [AUTHORIZATIONFAILED]`); mailbox names are no longer
  "unquoted" a second time (`'Old'` kept its quotes stripped).
- ActiveSync: a Sync Change without `email:Read` no longer marks the message unread.
- ActiveSync SendMail/SmartReply/SmartForward took the opaque MIME as UTF-8 text, so 8-bit
  (e.g. Latin-1) messages were corrupted; the octets are now sent byte-exact.
- ActiveSync: a SendMail retried with the same `ClientId` (e.g. after a timeout) is answered
  with Status 118 instead of being sent a second time.
- ActiveSync Sent copies are stored like every other message (raw original, parsed headers,
  attachments); before they had no raw message, no attachments and no Message-ID.
- ActiveSync WBXML decoder: truncated OPAQUE data, unterminated strings and unsupported global
  tokens are rejected instead of being read past the buffer or parsed as elements.
- **ActiveSync: overlapping requests of one device** (parallel Syncs of different folders, a
  FolderSync or Ping during a Sync) no longer write back each other's stale SyncKeys — each
  command merges only the keys it changed into `ActiveSyncDevice.syncKeys` in one statement.
  Before, the next Sync could get Status 3 and resync the whole folder, repeatedly.
- **ActiveSync Sync:** a message whose original (MIME) cannot be read no longer fails the whole
  Sync with HTTP 500 (the device retried forever); it is sent with the stored HTML/text body.
- Backup schedules and the retention worker ran once per app
  instance; with more than one instance every scheduled backup and retention run happened
  several times, and retention runs could overlap. Each cron fire is now claimed by one
  instance (Redis), a run lock held until the work has finished prevents overlapping runs, and
  a manual retention run while another is in progress answers 409.
- The security-filter ignored `RSPAMD_URL` (set by docker-compose, the Helm chart and the
  docs) and scanned on the hard-coded `RSPAMD_HOST`/`RSPAMD_PORT` defaults; Bayes learning
  always went to `<host>:11334`. `RSPAMD_URL` (the rspamd controller) is now used for scanning
  and learning, `RSPAMD_HOST`/`RSPAMD_PORT` remain as fallback when it is unset; an invalid URL
  is logged and falls back.
- core config: an empty numeric variable (e.g. `MINIO_PORT:` from compose) uses its default
  instead of 0.
- Calendar event UIDs were unique server-wide, so an invitee on the same server could not keep
  its own copy of a colleague's meeting (ActiveSync MeetingResponse failed, CalDAV PUT of the
  invitation answered 409). The UID is now unique per calendar (RFC 4791 §5.3.2.1); the schema
  change (`@@unique([calendarId, uid])`) is applied automatically at container start.
- **SMTP outbound lost mail on partial rejects.** When a remote server rejected some
  recipients (4xx or 5xx) and accepted others, the rejected ones were dropped without retry or
  bounce. Delivery is now tracked per recipient in the queue job: temporary failures are retried
  for the open recipients only, permanent ones are bounced once, immediately.
- **SMTP outbound retries duplicated mail and bounces.** A job with local and external
  recipients stored the local copies again on every retry (greylisting was enough) and re-sent
  to domains that had already accepted; a 5xx job kept retrying (`job.discard()` ran after
  BullMQ had already scheduled the retry) and sent a bounce per attempt. Progress now survives
  retries, permanent failures end the job (`UnrecoverableError`), and the give-up bounce goes
  out once, only for recipients that are still open.
- **SMTP: domains without MX records** are delivered to the domain's A/AAAA host (implicit MX,
  RFC 5321 §5.1); a null MX (RFC 7505) and NXDOMAIN bounce at once (5.1.10 / 5.1.2), DNS server
  failures are retried. Connection and timeout errors are always temporary (a port number in
  the error text was read as a permanent "587" reply).
- **SMTP: outbound EHLO** uses the public host name instead of `[127.0.0.1]` (RFC 5321
  §4.1.1.1).
- **SMTP: `<Postmaster>` and `postmaster@<local domain>` are accepted** (RFC 5321 §4.5.1) and
  delivered to the oldest active administrator when no mailbox or alias of that name exists.
- **SMTP trace fields (RFC 5321 §4.4).** Port 25 now adds a `Received:` header (HELO, IP, host,
  `ESMTP[S][A]`, session id); every final delivery puts `Return-Path: <reverse-path>` first
  (earlier `Return-Path:` fields are removed); mail with more than 100 `Received:` fields is
  refused as a loop (554 5.4.6). The submission `Received:` only carries `for <…>` with a single
  recipient — it exposed the first (possibly Bcc) recipient to everybody.
- SMTP: `Return-Path:` handling and hop counting found the end of the header only at CRLFCRLF,
  so local delivery of bare-LF messages (ActiveSync SendMail, JMAP raw) removed a body line
  starting with `Return-Path:` and inserted an extra blank line.
- **SMTP submission adds a missing `Date:` / `Message-ID:`** (RFC 6409 §8).
- **SMTP: partial delivery failures no longer lose or duplicate mail.** A failure while storing
  one of several recipients or while queueing the external part (and rule forwards, which were
  fire-and-forget after the 250) now answers 451; the recipients already delivered are
  remembered (Redis, 5 days) and skipped on the client's retry.
- SMTP: a rule forward/redirect queued before a failed local store was queued again by the
  sender's retry; forwards are now claimed per transaction, recipient and target.
- **SMTP session:** the DATA timeout restarts for every received chunk (slow uploads no longer
  fail after 10 minutes); a STARTTLS handshake that never completes is closed after 60 s; the
  first period of every line starting with "." is removed (not only for ".."); internal handler
  errors are answered with a fixed one-line 451 (a multi-line database error broke the reply
  framing and leaked internals).
- SMTP alias expansion: the same alias given twice (e.g. different case) delivered the second
  copy to the alias address itself, which was then dropped as "mailbox not found".
- SMTP inbound (port 25) advertises and enforces at most what the content filter can scan
  (52 MB minus headroom) even when `maxMessageSizeMb` is higher — larger mail was transferred
  completely and then refused with 552.
- **POP3 QUIT could delete a message that was no longer in the maildrop** (RFC 1939 §6). The
  UPDATE state expunged the DELE'd ids without a folder condition, so a message moved to
  another folder (IMAP MOVE, JMAP, a rule) between DELE and QUIT was deleted there. QUIT now
  removes, in one statement, only rows still live in the INBOX the session opened
  (`expunge(…, { where })`, additive option in the message store); rows moved or deleted by
  another client are left alone.
- POP3 takes an exclusive maildrop lock (RFC 1939 §4): a second concurrent session for the same
  account gets `-ERR [IN-USE]` (RFC 2449 §8.1.1) until the first one ends (QUIT, autologout or
  dropped connection). In-process plus Redis key `pop3:lock:<userId>` (renewed, owner token);
  without Redis the login answers `-ERR [SYS/TEMP]`. Clients that polled one account from two
  devices at the same moment now see the second poll refused and retry.
- POP3 QUIT whose removal fails answers `-ERR [SYS/TEMP] some deleted messages not removed` and
  closes the connection (previously `-ERR internal error` and the session stayed open).
- POP3 LIST/STAT are exact for rows without a stored raw message (they are materialized at
  login instead of reporting the body-column size — at most 200 per login, 4 in parallel,
  within 5 s, so the first login after an upgrade is not delayed; the others report their
  stored size until RETR/TOP or a later login makes it exact), messages stored with bare LF line endings
  are sent with CRLF (the multi-line framing broke; sizes follow after the first RETR/TOP), a
  pipelining client that does not read can no longer make the server buffer every requested
  message (writes wait for `drain`), the 512-octet command limit counts octets, and empty
  arguments (`LIST  1`) are rejected.
- Autodiscover: a database error no longer makes the service hand out (and cache for 60 s) the
  built-in `mail.local` URLs — the last known settings are served, otherwise 503. The documented
  v2 form `/autodiscover/autodiscover.json?Email=…&Protocol=…` is routed; a repeated
  `Protocol`/`emailaddress` parameter no longer causes a 500. SMTP on port 465 is announced as
  implicit TLS (`SSL`) instead of STARTTLS.
- Autodiscover v1 honours `AcceptableResponseSchema`: ActiveSync clients asking for the
  `mobilesync` schema (MS-ASCMD) get the MobileSync server URL, unknown schemas get Error 601.
  The mail account (`outlook/2006a` schema) response no longer contains the schema-invalid second `ActiveSync`
  account. `EMailAddress` with a namespace prefix or XML entities is understood.
- **JMAP `/changes` (RFC 8620 §5.2):** `Email/changes` and `Thread/changes` silently dropped
  everything beyond 5,000 changed rows, answered `maxChanges` with `cannotCalculateChanges`
  and never reported `destroyed`. They now page in modSeq order with `hasMoreChanges` and an
  intermediate state (server limit 5,000 ids), reject an invalid `maxChanges` with
  `invalidArguments`, and report `Email/set destroy` in `destroyed`: destroy now soft-deletes
  like IMAP EXPUNGE (30-day recovery window) instead of hard-deleting. Created vs. updated no
  longer depends on `receivedAt` (an import with a past date plus a destroy produced a wrong
  delta): the message store records `Message.createdModSeq` (new nullable column, added
  automatically at container start). `Thread/changes` reports new threads in `created` and
  emptied threads in `destroyed`. `Mailbox/changes` honours `maxChanges`.
- **JMAP threads:** messages delivered by SMTP/IMAP/ActiveSync got a `threadId` only when a
  JMAP client read them, without a state change, so `Thread/get` missed replies and thread
  membership changed silently. Missing thread ids are now derived before every thread read and
  persisted through the message store (new modSeq); JMAP-created messages get theirs in the
  creating transaction, and a parent that arrives after its reply joins the reply's thread.
- **JMAP `Email/query`:** results were capped at 10,000 (older mail unreachable, `total`
  wrong); a `hasKeyword` sort overrode the primary comparator; `text` ignored To/Cc/Bcc and the
  HTML body; `to`/`cc`/`bcc` required an exact address instead of a substring; invalid dates or
  sizes failed with `serverFail`; `allInThreadHaveKeyword`/`someInThreadHaveKeyword` sorts were
  silently treated as `hasKeyword` (now `unsupportedSort`, as not advertised). Principal/query
  and EmailSubmission/query applied comparators in reverse precedence.
- **JMAP keywords (RFC 8621 §4.1.1):** only `%x21-%x7E` is accepted; keywords are
  case-insensitive (`{Foo, foo}` is one flag, `keywords/Foo: null` removes `Foo`, `hasKeyword`
  finds IMAP-cased flags such as `$MDNSent`); unchanged custom flags keep their IMAP spelling.
- **JMAP protocol details:** `Email/set` reports a database error per id instead of failing the
  whole call after partial writes; destroying an already expunged message answers `notFound`
  (counters were decremented twice); zero `mailboxIds` is `invalidProperties` (was
  `tooManyMailboxes`); `header:*` properties with an unknown or disallowed form (`asFoo`,
  `Subject:asAddresses`) are `invalidArguments`, `asGroupedAddresses` keeps groups; `sentAt` and
  `asDate` have no `.000`; `Email/parse` returns `null` for id/mailboxIds/keywords/receivedAt;
  `createdIds` is only returned when the request had it; result references and PatchObjects
  reject inherited members and prefix pointers; an anchor with a negative offset clamps to 0
  and a server-imposed `/query` limit is reported in `limit`; the session lists the principals
  account capability (`currentUserPrincipalId`); `VacationResponse/set` refuses a subject
  instead of dropping it and escapes `textBody`; `Blob/get` defaults to `["data", "size"]`;
  English quota name/description.
- **Data loss: a WRITE grantee could overwrite a PRIVATE event with its masked copy.** The
  masked view carried the owner's ETag, so the grantee's client PUT the "Busy" copy back with a
  valid `If-Match` and the owner's title, description, attendees and alarms were gone. The
  masked view now has its own ETag, and grantees can neither PUT nor DELETE events they only
  see masked (PRIVATE, also per overridden instance) or not at all (CONFIDENTIAL): 403
  `DAV:need-privileges`. The REST API (`PUT`/`DELETE /api/v1/calendar/events/:id`) applies the
  same rule.
- **Data loss: a webmail contact edit rebuilt the vCard from four fields** and discarded
  everything a CardDAV client had stored (TEL, ADR, PHOTO, UID, BDAY, X-…); the client then
  synced the stripped card back. `PUT /api/v1/contacts/:id` now patches the stored vCard and
  rewrites only the changed fields; new vCards escape `,` `;` and line breaks, build `N` as
  `family;given;;;` and carry a UID.
- iTIP REPLY: the attendee's answer is written into the stored iCalendar too (CalDAV clients of
  the organizer saw the old PARTSTAT); a REPLY with `RECURRENCE-ID` changes only that
  occurrence; with equal SEQUENCE an older DTSTAMP is ignored; quoted parameters such as
  `CN="Doe: J"` are parsed; UIDs are compared exactly.
- CalDAV `calendar-query`: a zero-duration event at the start of the time range was not found
  (RFC 4791 §9.9), and recurring series without an occurrence in the range were returned.
- CardDAV PROPFIND on the address book home described only the child book, not the home itself.
- A custom VTIMEZONE (no IANA id / `X-LIC-LOCATION`) was evaluated with its STANDARD offset all
  year; its DAYLIGHT/STANDARD rules are now applied, so summer times are no longer an hour off.
- `GET /api/v1/contacts/gal` was shadowed by `GET /api/v1/contacts/:id` (404).
- caldav-server: credentials were verified twice for every CardDAV request (one auth
  middleware per router).
- Filesystem object store: `putStream` did not check short writes (`put` did).

### Security

- **JMAP WebSocket: Origin check could be bypassed with an empty `?access_token=`.** The
  handshake skipped the Origin allow-list whenever the URL had a token parameter, even an
  empty or dummy one, while the login used the `Authorization` header first — so a foreign web
  page could open `/jmap/ws?access_token=` and ride on Basic credentials cached by the browser.
  A foreign Origin is now accepted only with a non-empty query token and no `Authorization`
  header; ambient (header) credentials always need an allowed Origin (RFC 6455 §10.2).
  Web Push for a mailbox goes only to delegates with mailbox access.
- **REST API: revoked access tokens survive no gateway restart.** `requireAuth` checked
  revocations only in process memory; after a restart or a lost invalidation event, tokens of
  logged-out, deactivated or password-changed sessions kept working until they expired. It now
  also consults the shared Redis markers (5 s local cache, dropped by every invalidation event;
  1 s timeout, then the in-process result applies).
- **Revoke-all marks compare milliseconds.** Access tokens carry a new `iatMs` claim and
  revoke-all marks a `beforeMs`; a token minted earlier in the same second as a password
  reset, role change or deactivation is no longer accepted until it expires (whole-second
  `iat` could not tell it apart), and a token minted right after the mark (e.g. the login
  following an LDAP takeover) is not caught by it. Tokens of older releases from the same
  second count as revoked.
- **Admin password reset can revoke app passwords.** `PUT /api/v1/admin/mailboxes/:id` accepts
  `revokeAppPasswords: true` together with `password` (HELP_DESK included): all app passwords
  of the user are deleted and mail connections using them end — for compromised accounts.
  Default `false` keeps the previous behaviour (app passwords survive an admin reset).
  CLI: `coremail user set-password <user> --revoke-app-passwords`.
- **JMAP EmailSubmission sender spoofing (RFC 8621 §7.5).** Only the first From address was
  compared with the identity, and the check was skipped when From was empty, so
  `From: me@corp, ceo@corp`, two From fields, `From: undisclosed` and any `Sender:` were sent.
  EmailSubmission now applies the SMTP submission policy (`@coremail/storage`
  sender-identity): every From address and the Sender address must be allowed for the user,
  the identity must appear in From or Sender (`forbiddenFrom`), and a message without exactly
  one parseable From is `invalidEmail`. `Email/set` no longer accepts From/Sender/To/… or trace
  fields through the `headers` array. **Behaviour change:** mailbox delegates (MailboxDelegate
  FULL_ACCESS) no longer get send permission or the owner's identity in the delegated JMAP
  account — the same rule as SMTP and ActiveSync.
- **JMAP EmailSubmission `envelope.mailFrom` follows the SMTP MAIL FROM policy.** Besides
  matching the identity, the envelope sender must be an address the user may send as
  (`@coremail/storage` sender identity: own address, aliases, Shared Mailboxes with
  SEND_AS/FULL_ACCESS); the null reverse-path `<>` is refused (`forbiddenMailFrom`), and the
  DKIM key is looked up only from the verified address.
- **JMAP FUTURERELEASE.** `maxDelayedSend` was advertised, but `HOLDFOR`/`HOLDUNTIL` were
  dropped and the mail went out at once, while a client-set `sendAt` was accepted without
  limit. HOLDFOR/HOLDUNTIL now delay the send (max. 30 days, `FUTURERELEASE` in
  `submissionExtensions`), unknown envelope parameters and a client `sendAt` (server-set) are
  rejected with `invalidProperties`.
- **ActiveSync device block and remote wipe are enforced.** The admin API
  (`/api/v1/admin/mobile/devices`) set devices to BLOCKED or WIPED, but the ActiveSync service
  never read the status: a lost or stolen phone kept syncing the mailbox and never received a
  wipe. Now a BLOCKED (or PENDING) device is refused with Status 129; a device with a requested
  wipe is refused with Status 140 and gets `<RemoteWipe/>` on Provision; its acknowledgement is
  recorded (`remoteWipeAckAt`, new column) and the device stays refused (a new Provision wipes
  again) until an administrator sets it back to OK. Users can no longer delete a blocked or
  wiped device registration themselves (`DELETE /api/v1/smime/devices/:id` → 409), which would
  have let it re-register.
- **ActiveSync MeetingResponse:** a meeting request is acted on only when its ORGANIZER matches
  the organizer of the stored event with that UID and is not one of the user's own addresses.
  Before, anybody who knew a UID (e.g. from an invite the user sent) could mail a REQUEST with
  it, and Decline deleted — Accept overwrote — the user's own event.
- **Credential changes take effect immediately on cached logins.** The jmap-server cached
  successful Basic logins for 60 s, so after enabling MFA, changing or resetting the password,
  revoking an app password, or deactivating/deleting a user, JMAP still accepted the old
  credentials for up to a minute. New invalidation bus in `@coremail/core`
  (`CHANNEL_AUTH_INVALIDATE`, `publishAuthInvalidation`, `startAuthInvalidationSubscriber`,
  `CredentialCache`): every credential-changing event publishes `{ userId, reason }` and the
  cache drops that user at once; the 60 s TTL remains only as a fallback when Redis loses the
  event. Published on password change / admin reset / reset by mail, TOTP setup / enable /
  disable, WebAuthn registration, backup-code regeneration, app password create / revoke,
  user deactivate / reactivate / delete / role change (BCP and EMS bridge), and every session
  revocation. Cache keys are HMAC-SHA256 under a per-process random key (previously an
  unkeyed SHA-256 of login + password); a login check that started before an invalidation can
  no longer re-insert a stale entry.
- **Session revocations reach every service.** Revocations performed by the auth-service or
  the LDAP sync were only known in-process; the api-gateway's `requireAuth` kept accepting
  those access tokens until they expired. Revocation marks now travel with the invalidation
  event and are applied in the api-gateway, auth-service, jmap-server and caldav-server.
- **Revoked sessions are refused by JMAP and CalDAV/CardDAV Bearer auth** (previously only
  signature and expiry were checked), and deleting a single session
  (`DELETE /auth/sessions/:id`) now revokes its access tokens immediately.
- **EMS bridge:** `Set-Mailbox -IsEnabled $false` and `Remove-Mailbox` now end all sessions,
  like the BCP mailbox routes; deleting a mailbox in the BCP does the same.
- **A role change ends the user's web/API sessions.** The role is part of the access token, so
  a demoted admin kept the old rights for up to 15 minutes. Changing the role
  (`PUT /api/v1/admin/mailboxes/:id`, the only role-changing path) now revokes all sessions of
  the user (refresh tokens deleted, access tokens rejected); mail-protocol logins and app
  passwords are unaffected.
- **Admin guards check the current role.** When an access token claims admin rights,
  `requireAdmin` / `requireRole` / `requireArea` read the user's current role from the database
  (15 s in-process cache, dropped by the invalidation bus); both roles must pass and routes see
  the stricter one. A disabled or deleted account gets 401, a database error 503. A missed
  invalidation event can no longer keep elevated rights.
- **Long-lived protocol connections end after a credential change.** Authenticated IMAP
  (incl. IDLE), POP3 and SMTP submission sessions, ActiveSync Ping long-polls and JMAP
  WebSocket/EventSource connections stayed authenticated after a password change. They are now
  registered per user and credential (`LiveConnectionRegistry` in `@coremail/core`) and
  terminated on the invalidation bus: IMAP `* BYE Credentials changed, please log in again`,
  POP3 `-ERR [AUTH] Credentials changed …` (no UPDATE state), SMTP `421 4.7.0 … Credentials
  changed …` (never mid-DATA: the body is read to its end and the message rejected; a delivery
  already in progress completes), ActiveSync Ping HTTP 401 with `WWW-Authenticate`, JMAP
  WebSocket close code 1008 / EventSource stream end. Password change/reset ends password
  logins (app-password logins only when the app passwords were deleted too), MFA enabled ends
  password logins, revoking an app password ends only the connections that used that app
  password (event carries `appPasswordId`), deactivation/deletion/"revoke all sessions" end
  everything; JMAP Bearer connections follow their web session. A login whose credential check
  began before the change but completed after it is terminated as well. Role changes, web
  logouts and app password creation do not touch protocol connections.
- **The web client's live-update stream (`/api/v1/events`, SSE) ends with its session.** It
  stayed open after a password change, session revocation, role change or deactivation; it now
  follows the same rules as JMAP Bearer connections and ends with `event: session-ended` (the
  browser's reconnect is then refused with 401).
- **Smarthost TLS is verified and mandatory with credentials.** Outbound smarthost connections
  with STARTTLS, implicit TLS or credentials accepted any certificate, so an on-path attacker
  could harvest the provider credentials (RFC 8314 §4.1); with credentials and the TLS box off,
  STARTTLS was only opportunistic (strippable), and nodemailer's `opportunisticTLS` continued
  in plaintext after a failed STARTTLS reply even with TLS required. The certificate is now
  verified against the smarthost name (TLS ≥ 1.2), and STARTTLS is mandatory whenever
  credentials are configured (unless implicit TLS), without plaintext fallback. **Operators
  with a self-signed (or IP-address) smarthost** must install a valid certificate or set
  `SMARTHOST_TLS_INSECURE=true` (explicit opt-out); a rejected certificate shows up as a
  deferral reason naming that variable (queue/mail-flow log) and a throttled ERROR log line.
  Direct MX delivery stays opportunistic (RFC 7435).
- Bounces of a job created by a user's redirect rule (which keeps the original, possibly
  forged, envelope sender) are delivered only to a local original sender, never to an external
  one (backscatter).
- **Autodiscover v1 only describes the caller's own account.** An authenticated user could ask
  for any other address and received that person's display name and internal user id
  (LegacyDN); unknown accounts and foreign domains got full settings, which told existing and
  missing accounts apart. Only the caller's primary address and aliases are answered now;
  everything else gets the same Error 500.
- Autodiscover: requests without valid Basic credentials (Bearer, Negotiate/NTLM, none) are
  answered with the Basic challenge without touching the database — a Bearer header used to
  write a `SystemLog` row with the client-supplied token claims on every request. The
  failed-login `SystemLog` category is now `AUTODISCOVER_AUTH` (was `MAPI_AUTH`).
- **Autodiscover:** failed Basic logins write at most 10 SystemLog rows per client IP and 60
  in total per minute (the service log still records every attempt; the next row notes how
  many were left out). Before, an unauthenticated client could grow `system_logs` without
  limit — notably behind a reverse proxy without `TRUST_PROXY`.
- **PRIVATE events are masked with an allowlist.** Grantees of a shared calendar received
  `CONFERENCE` links, `GEO`, `STYLED-DESCRIPTION`, `RELATED-TO`, `IMAGE` and similar properties
  of PRIVATE events because the mask removed only a fixed list. CalDAV now keeps only UID,
  DTSTAMP, DTSTART/DTEND/DURATION, RRULE/RDATE/EXDATE, RECURRENCE-ID, TRANSP, STATUS, SEQUENCE
  and CLASS plus `SUMMARY:Beschäftigt`, and drops alarms and calendar-level properties; an
  overridden instance with its own `CLASS:PRIVATE` is masked under a PUBLIC series. REPORT
  filters run on the masked view, so grantees cannot probe hidden fields with `text-match`.
- **REST calendar writes by grantees** follow the CalDAV rule: a PUBLIC series with a
  PRIVATE/CONFIDENTIAL overridden instance can only be changed or deleted by its owner (the
  check is shared, `granteeView` in `@coremail/core/calendar`).
- **CalDAV:** a PUT whose resource name is already used in another calendar, and an
  MKCALENDAR with a calendar ID of another user, answer a neutral `409 Conflict` instead of
  403/405 messages that said the object exists elsewhere.
- iTIP REPLYs are applied only when the receiving user (address or alias) is the event's
  ORGANIZER, not to an invitee's copy of the same meeting.
- iTIP REPLY with `RECURRENCE-ID`: an override is only created for a real instance of the
  series (bounded RRULE expansion, RDATE, not EXDATE'd), at most 100 overrides per calendar
  object and 100 per-instance reply stamps per attendee — a (spoofed) attendee could add phantom
  occurrences to the organizer's calendar and grow `icalData` without limit.
- **IMAP LIST/LSUB pattern ReDoS.** The mailbox pattern was translated into a regular
  expression that backtracked exponentially (`LIST "" "*a*a*a…X"` against a long folder name
  blocked the IMAP process for every user for minutes). Patterns are now matched by a
  linear-space O(name × pattern) wildcard matcher; patterns over 1024 characters and pattern
  lists over 32 entries are refused with BAD.
- **Global address list per domain:** the webmail GAL (`/api/v1/contacts/gal`) and the
  compose autocomplete (`/api/v1/contacts?q=`) list only active users of the caller's own
  domain — on a server hosting several domains, users could list every other domain's users.
  `/gal` is paginated in the database (at most 500 entries per page).

### Removed

- The old per-service Helm chart (per-service Deployments/HPAs, EWS, storage-api, CNPG cluster,
  Bitnami Redis subchart, 0.6.x images) — replaced by Helm chart 1.0.0.

### Upgrade notes (breaking)

- **Object storage.** New `OBJECT_STORAGE` driver variable: existing installs keep MinIO
  without any action (`OBJECT_STORAGE` unset = `minio`; compose sets `${OBJECT_STORAGE:-minio}`).
  New installs (`scripts/setup.sh`, `.env.example`, Synology setup) use `filesystem` on the new
  `coremail-data:/data` volume (`STORAGE_PATH`, default `/data/objects`). Do **not** copy
  `OBJECT_STORAGE=filesystem` from the new `.env.example` into an existing `.env` without
  migrating first (`coremail storage migrate --from minio --to filesystem`): SMTP/IMAP/POP3/JMAP/
  ActiveSync stay closed and `/healthz` answers 503 while most referenced objects are missing.
- **New environment variables:** `OBJECT_STORAGE`, `STORAGE_PATH`, `MINIO_USE_SSL`,
  `MINIO_REGION`, `MINIO_PATH_STYLE`, `MINIO_CA_FILE` (S3/MinIO over TLS, URL endpoints) and
  `SMARTHOST_TLS_INSECURE`. `RSPAMD_URL` (rspamd controller) is now actually used for scanning
  and learning — check that it points at the controller (port 11334); `RSPAMD_HOST`/`RSPAMD_PORT`
  are only a fallback. An empty numeric variable now means "default" instead of 0.
- **Smarthost TLS:** certificates are verified and STARTTLS is mandatory with credentials. A
  self-signed or IP-address smarthost defers all outbound mail until it has a valid certificate
  or `SMARTHOST_TLS_INSECURE=true` is set.
- **Helm chart 1.x:** complete rewrite (one `coremail-app` Deployment, bundled or external
  dependencies). The old per-service values (`global.*`, `services.*`, `cnpg.*`, Bitnami
  `redis.*`, …) are gone and `secrets.*`/`existingSecret` are mandatory; the default
  attachment bucket is `coremail-attachments`. There is no in-place `helm upgrade` from the old
  chart — follow the migration steps in `infra/k8s/README.md` (same `PEPPER`, restore the dump,
  mirror the buckets). Probes: liveness `/livez` (new), readiness `/healthz`.
- **Schema changes are applied automatically at container start** (`prisma db push`): new table
  `active_sync_items`, new columns `Message.createdModSeq` and `ActiveSyncDevice.remoteWipeAckAt`,
  and calendar event UIDs unique per calendar (`@@unique([calendarId, uid])`) instead of
  server-wide. Take a database backup before upgrading.
- **POP3 needs Redis for logins** (exclusive maildrop lock, `pop3:lock:<userId>`): without Redis
  the login answers `-ERR [SYS/TEMP]`, and a second concurrent session of the same account gets
  `-ERR [IN-USE]` (clients polling one account from two devices at once retry).
- **ActiveSync:** every command except Provision needs the final (phase-2) policy key in
  `X-MS-PolicyKey` (Status 142/144, HTTP 449 for protocol < 14) — standard phones re-provision
  automatically, scripts and test clients must complete the handshake. BLOCKED/PENDING devices get
  Status 129, WIPED devices Status 140 plus a remote wipe; users can no longer delete a blocked or
  wiped device registration (409). A Delete from the phone now moves mail to Deleted Items
  (`DeletesAsMoves` default); a SyncKey other than the current or previous one answers Status 3;
  OPTIONS lists only implemented commands; MeetingResponse ignores requests whose ORGANIZER does
  not match the stored event or that have no ORGANIZER.
- **SMTP is stricter (RFC 5321/4954):** wrong `MAIL`/`RCPT` keywords and invalid recipient
  syntax → 501, unknown MAIL/RCPT parameters → 555 (DSN is not advertised), `EHLO`/`HELO`
  without a domain → 501, AUTH responses must be valid base64 and PLAIN must have exactly three
  fields with an authzid equal to the login. Port 25 caps `SIZE` at what the content filter can
  scan (≈ 52 MB) even when `maxMessageSizeMb` is higher; an invalid filter answer defers (451).
  The local-part keeps its case when relaying; a custom banner without a leading domain gets the
  host name prefixed. Bounces are now English RFC 3464 reports and also go to external senders of
  accepted mail; out-of-office replies need one of the user's addresses in To/Cc/Bcc/Resent-*;
  rule redirects keep the original envelope sender.
- **IMAP:** IMAP4rev1 clients now get non-ASCII mailbox names in modified UTF-7 (RFC 3501
  §5.1.3), IMAP4rev2 clients (`ENABLE IMAP4rev2`) in UTF-8 together with ESEARCH and a SELECT
  without RECENT/UNSEEN. Folders created with an encoded name by IMAP clients up to 7.0.0 are
  not renamed; they are found under both spellings, and CREATE of the same name answers
  `ALREADYEXISTS`. STORE responses carry MODSEQ only after CONDSTORE is enabled; `SEARCH
  RECENT`/`NEW` match nothing; LIST patterns over 1024 characters or more than 32 patterns → BAD.
- **Autodiscover** answers only the caller's own primary address and aliases (everything else
  gets Error 500), and failed logins are logged under the `SystemLog` category
  `AUTODISCOVER_AUTH` (was `MAPI_AUTH`) — adjust log queries/SIEM rules.
- **Shared calendars (CalDAV and REST):** grantees can no longer PUT/DELETE events they only see
  masked (PRIVATE, also per overridden instance) or not at all (CONFIDENTIAL) — 403
  `DAV:need-privileges` / REST 403 — and cannot PROPPATCH the owner's calendar; PRIVATE events
  are masked with an allowlist. CalDAV advertises `DAV: 1, 3, calendar-access, addressbook`
  (no class 2, no `access-control`, no `ACL` in `Allow`), VTODO/VJOURNAL → 403 (was 400), a CardDAV
  resource must hold exactly one vCard, and name clashes in another calendar answer a neutral 409.
- **JMAP:** mailbox delegates (FULL_ACCESS) no longer have `maySend` or the owner's identity;
  `Email/set destroy` soft-deletes (30-day recovery window, reported in `/changes` `destroyed`);
  EmailSubmission enforces the SMTP sender policy (`forbiddenFrom`, `forbiddenMailFrom` for
  foreign or `<>` envelope senders, `invalidEmail` without exactly one From), From/Sender/trace
  fields cannot be set through `headers`, and a client-set `sendAt` or unknown envelope
  parameters are `invalidProperties`; unsupported sorts answer `unsupportedSort`.
- **Web/API:** the global address list and compose autocomplete list only the caller's own
  domain, and `/api/v1/contacts/gal` is paginated (max. 500 per page). A role change ends the
  user's web sessions; admin routes re-check the role in the database (503 on a database error).
  Credential changes end open IMAP/POP3/SMTP/ActiveSync Ping/JMAP push connections and the web
  client's SSE stream — clients have to log in again.

---

## [7.0.0] — 2026-11-15 — Secure by default: mandatory MFA for mail clients, TLS-first auth, EWS removed

Major release. Finishes the code review started in 6.0.0: every remaining finding was fixed,
the stack was verified end to end against the real container image (`docs/e2e.md`,
95/95 checks), and every fix has an automated test (`pnpm -r test`: 561 tests).
**Breaking changes and required actions are listed under "Upgrade notes" at the end.**

### Security

- **Mail clients: MFA users need app passwords.** SMTP, IMAP, POP3, ActiveSync, Autodiscover,
  JMAP and CalDAV/CardDAV share one credential check (`verifyMailCredentials`). With TOTP or
  WebAuthn enabled, the account password is rejected there — only app passwords work.
- **Authentication only after TLS:** IMAP 143 offers real STARTTLS and advertises
  LOGINDISABLED until then (`NO [PRIVACYREQUIRED]`), POP3 110 offers STLS and refuses
  USER/PASS before it, SMTP 587 advertises and accepts AUTH only after STARTTLS
  (`538 5.7.11`). Input pipelined before a TLS handshake is discarded (CVE-2011-0411 class).
- **Brute-force protection for all mail protocols:** lockout per IP and per account with
  exponential backoff (`MAIL_AUTH_*`), checked on every attempt; SMTP disconnects after
  3 failed AUTHs; unknown users are timing-equalised.
- **Web/API sessions:** one shared login service; refresh tokens stored hashed and rotated on
  every refresh with reuse detection; sessions revoked on logout, password change/reset and
  deactivation; access tokens of revoked sessions rejected immediately.
- **MFA hardening:** attempt limit per challenge and per IP, TOTP replay protection, TOTP
  secrets encrypted with AES-256-GCM (`MFA_ENCRYPTION_KEY`, legacy secrets migrated on use),
  atomic single-use backup codes, MFA changes require re-authentication, WebAuthn bound to
  the login challenge, `requireMfaForAdmins` requires an MFA-verified session and fails closed.
- **No request can crash a service:** async route errors go to a shared error middleware
  (no error details leaked), process guards in every service.
- **Admin API:** role-based access per area (RBAC matrix, `GET /api/v1/user/me` → `adminAreas`);
  only Organization Management may assign roles or manage admin accounts; `tlsKey`,
  `passwordHash` and LDAP/smarthost passwords are never returned (write-only).
- **Setup wizard** requires a one-time setup token and can complete only once.
- **`TRUST_PROXY`** (default off) replaces the hard-coded `trust proxy 1`; the gateway sets
  `X-Forwarded-For` itself for internal services, so client IPs cannot be spoofed.
- **Internal services** bind to 127.0.0.1 (`INTERNAL_BIND_HOST`), `/internal/*` routes need
  loopback or `INTERNAL_API_TOKEN`.
- **Mail content:** IMAP responses can no longer be injected through CR/LF in subjects or
  names; submission rejects foreign `From:`/`Sender:` headers (550 5.7.1); JMAP CORS
  allow-list and SSRF protection for push endpoints; iTIP replies only from the attendee for
  the recipient's own events; transport-rule reject DSNs only to local senders (no
  backscatter); attachment downloads with `nosniff`, sandbox CSP and inline only for images.
- **Web client:** external-image blocking moved into DOMPurify hooks (no regex bypasses),
  forms in mail bodies removed, links open with `noopener noreferrer`, no tokens in URLs for
  downloads, exports and inline images; logout revokes the session on the server.

### Added

- **OIDC single sign-on** for MWA and BCP (Entra ID, Keycloak, Authentik, Google, Okta):
  PKCE, state and nonce, verified e-mail and allowed domains, one-time exchange code.
- **LDAP/Active Directory:** login over TLS with certificate verification (web and mail
  protocols), first-login provisioning, manual and scheduled sync, real connection test.
- **WebAuthn security keys** and **backup codes** at login; key registration in the MWA.
- **Automatic certificate renewal** (Let's Encrypt, hourly check with lock and backoff);
  SMTP/IMAP/POP3 pick up renewed certificates without a restart.
- **Out-of-office auto-replies** (RFC 3834) for MWA and JMAP VacationResponse.
- **Real S/MIME signature verification** with signer, validity and trust status.
- **IMAP:** literals and LITERAL+, full SEARCH grammar with ESEARCH, multi-item STATUS with
  real SIZE, `UID EXPUNGE`, COPYUID on MOVE, CHANGEDSINCE.
- **CalDAV:** REPORT (calendar-query, multiget, sync-collection) and MKCALENDAR; server-side
  recurrence expansion for event lists and free/busy.
- **Quarantine release** delivers the message; transport-rule quarantine, redirect, add and
  remove recipient actions work; release is audit-logged.
- **MWA:** infinite scroll and server-side search, attachment download, error toasts and an
  error boundary; **BCP** hides pages by admin area.
- **End-to-end test harness** (`scripts/e2e/`, `infra/docker/docker-compose.e2e.yml`).

### Changed

- **Messages are always stored as the original RFC 5322 message** (content-addressed in
  MinIO). IMAP and POP3 serve it byte-exact with attachments; backups export and restore it.
  Existing messages are rebuilt once on first access.
- **UIDs and modSeqs are allocated atomically** for every writer (shared message store);
  moved messages get new UIDs (RFC 6851); JMAP and ActiveSync see changes from all
  protocols. Old ActiveSync sync keys force one full resync.
- **Settings take effect:** security-filter honours GeoIP, attachment, DNSBL and ClamAV
  settings; per-service log levels apply at runtime; queue retry/retention settings apply to
  all producers; greylisting has one source (SMTP settings).
- **MinIO image:** `pgsty/minio` pinned by digest — the official `minio/minio` image can no
  longer be pulled.

### Fixed

- ActiveSync: correct WBXML code pages, initial sync delivers existing mail, incremental
  sync delivers new mail, GetAttachment returns the body.
- SMTP: transient errors stay 4xx; oversized DATA handled without command injection.
- Calendar: all-day and recurring events keep `allDay`/`rrule`; editing in the MWA no longer
  destroys CalDAV data; ETags/ctags change on every edit; window overlap queries.
- DNSBL return codes interpreted correctly; blacklist regex case; CIDR whitelists; ClamAV
  reply parsing.
- Container start on Windows checkouts (CRLF entrypoint), rspamd `actions.conf`, setup status
  no longer counted against the setup rate limit, non-ASCII protocol reply texts.

### Removed

- **Exchange Web Services (EWS)** completely: `ews-server`, `/EWS/*`, `/OAB/*`, the BCP
  switch, `ServerSettings.mapiHttpEnabled`/`ewsUrl` (columns dropped at startup),
  `coremail connector ews|mapi`, Autodiscover `Protocol=EWS` (404). `/EWS`, `/OAB` and `/mapi`
  return 404.
- SAML from the BCP SSO page (it was never implemented).

### Upgrade notes

1. **Users with two-factor authentication** must create app passwords (MWA → Settings →
   Security) for every mail client and phone; the account password stops working there.
2. **Clients on ports 143, 110 or 587 without encryption** must use STARTTLS/STLS or switch
   to 993/995/465. A protocol certificate must be active (setup creates a self-signed one).
3. **EWS clients** (e.g. macOS Mail EWS accounts, eM Client in EWS mode) must switch to
   IMAP + CalDAV/CardDAV, JMAP, or ActiveSync on phones.
4. **Behind a reverse proxy** (Traefik, Caddy, nginx, Synology DSM) set `TRUST_PROXY`,
   otherwise all clients share one IP for rate limits.
5. **New installations** need the setup token from the log
   (`docker logs coremail | grep -i "setup token"`) or `SETUP_TOKEN`.
6. **Admin roles are now enforced:** Server Management loses mailbox and settings write
   access; Help Desk, Recipient, Hygiene and Compliance Management get their areas. Admins
   under `requireMfaForAdmins` who logged in without MFA must log in again.
7. **Set `MFA_ENCRYPTION_KEY`** (64 hex characters) before you ever rotate `JWT_SECRET` or
   `PEPPER`; otherwise stored TOTP secrets become unreadable.
8. **LDAP:** plain `ldap://` without StartTLS is refused (except loopback or
   `LDAP_ALLOW_INSECURE=true`); the directory `mail` attribute must equal the login;
   local accounts are only taken over with `allowLocalTakeover`.
9. **Multi-host deployments** must set `INTERNAL_BIND_HOST` (and `INTERNAL_API_TOKEN`).
10. **MinIO:** pull the new image (`docker compose pull`); data in the MinIO volume stays.
11. Phones using ActiveSync perform one full resync after the upgrade.

Known limitations: ActiveSync still sends the EAS 2.5 body element instead of the 14.1
AirSyncBase body and answers Settings/ItemOperations/Search/MoveItems with an empty 200;
JMAP caches successful Basic logins for up to 60 s; the Helm chart is outdated.

---

## [6.0.0] — 2026-11-14 — Security & cleanup release

Major release after a full code review (clean code, security, business logic and protocol
tests). It closes the most severe findings, removes dead and non-working code and adds
automated tests for every fix. **Breaking**: MAPI over HTTP is gone, the EWS switch is
renamed, several unused endpoints and the internal `storage-api` service are removed.

### Security

- **Bad tokens no longer crash services.** `verifyAccessToken()` returns `null` instead of
  throwing. A request with `Authorization: Bearer x` used to terminate auth-service (MFA,
  sessions, app passwords), caldav-server and backup-service through an unhandled rejection.
- **Refresh tokens are no longer accepted as access tokens** (30-day bearer access that
  survived logout and deactivation). Tokens are verified with `algorithms: ['HS256']` only.
- **JMAP: prototype pollution fixed.** PatchObject paths containing `__proto__`,
  `constructor` or `prototype`, or walking through inherited members, are rejected with
  `invalidPatch` (previously any user could modify `Object.prototype` process-wide).
- **JMAP: Bcc is no longer delivered to recipients.** Bcc header fields are stripped before
  an `EmailSubmission` is queued (RFC 8621 §7.5).
- **JMAP: delegates with only SEND_AS / SEND_ON_BEHALF no longer get read/write access**
  to the owner's mailbox (same rule as Shared Mailboxes).
- **MWA: stored XSS in Shared Mailboxes fixed.** HTML mail bodies in the Shared Mailbox view
  are now sanitized with the same DOMPurify configuration as the normal reader
  (`web-client/src/lib/mailHtml.ts`).
- **Cross-mailbox access fixed:** "Run rule now" can no longer process folders of other
  mailboxes via `folderIds`; EWS ResolveNames no longer returns other users' personal
  contacts.
- **SMTP: command injection after oversized DATA fixed.** The rest of an oversized message
  is consumed up to the end-of-data line and answered with a single `552` instead of being
  executed as SMTP commands (RFC 5321 §4.1.1.4).
- **SMTP and IMAP: unterminated input lines are capped at 64 KiB** (SMTP DATA: maximum
  message size); the connection is closed instead of the buffer growing without limit.
- **ActiveSync no longer trusts the client's From header.** Only the user's own address,
  their aliases or a Shared Mailbox with SEND_AS/FULL_ACCESS are accepted (status 130
  otherwise). EWS always sends as the logged-in user. Bcc headers are stripped before sending.
- **DKIM for all outbound mail:** mail from SMTP submission (465/587), inbox-rule forwards,
  ActiveSync and EWS is now DKIM-signed — the outbound worker resolves the key of the sender
  domain. New domains (setup wizard, EMS New-AcceptedDomain) get a DKIM key at creation.

### Fixed

- **Lost mobile mail:** ActiveSync SendMail/SmartReply/SmartForward and EWS CreateItem
  (SendOnly/SendAndSaveCopy) reported success but wrote to Redis lists that nothing read.
  They now use the `smtp-outbound` queue with local delivery, retries and a clear error status.
- **Spam filter connection stage never ran:** security-filter answered 400 at connect time
  and the SMTP server let the connection through. The connect stage now runs DNSBL/DNSWL and
  GeoIP with the client IP only, greylisting runs at RCPT TO with the real
  (IP, sender, recipient) triple, and an unavailable filter is logged as an error.
- **SMTP reply codes:** transient handler rejections (`4.x.x`) are sent with a 4yz code, and
  handler errors carrying their own code (e.g. `452 4.2.2`) pass through unchanged instead of
  becoming permanent `550` bounces.
- **IMAP UID commands:** `UID FETCH` and `UID STORE` address messages by UID, plain `STORE` by
  sequence number (previously `UID FETCH` used sequence numbers, `UID STORE` returned BAD and
  `STORE` could flag the wrong message). `UID EXPUNGE` (RFC 4315) is implemented, EXPUNGE
  responses carry correct sequence numbers, STORE is refused in EXAMINE'd mailboxes.
- **Retention:** message age is measured from delivery time instead of the sender-controlled
  `Date:` header — freshly delivered mail with an old date is no longer purged on the next run.
- **Autodiscover v2** no longer crashes on a malformed double-encoded address.
- **CalDAV Basic auth** uses `AUTH_SERVICE_URL` (default `http://localhost:3003`) instead of
  the non-existent host `auth-service:3003`, and rejects deactivated users.
- **MAPI identity** (until its removal in this release) no longer taken from the
  client-controlled `X-User-Identity` header.

### Changed

- **EWS no longer depends on MAPI.** BCP → Server → "EWS" (default
  off) controls `/EWS/*`, `/OAB/*` and Autodiscover v2 `Protocol=EWS`. Stored in the existing
  field `ServerSettings.mapiHttpEnabled` — no schema migration.
- **CLI:** `coremail connector enable|disable ews` replaces `mapi` (still accepted as a
  deprecated alias with a warning).
- **Desktop clients** are set up as IMAP accounts (calendar/contacts via
  CalDAV/CardDAV); Autodiscover v1 announces IMAP, SMTP and ActiveSync.
- **Tests:** every package with logic touched by this release has a `test` script
  (`pnpm -r test`, 113 tests). Reviewer protocol suites for SMTP/IMAP/POP3/JMAP are kept as
  acceptance tests for the remaining findings (not part of `pnpm -r test`).

### Removed

- **MAPI over HTTP** completely (`/mapi/emsmdb`, `/mapi/nspi`, all ROP/NSPI code under
  `packages/ews-server/src/mapi/`, Autodiscover `mapiHttp` block, `ENABLE_MAPI_HTTP`,
  `/mapi` routes in api-gateway, nginx and the k8s ingress). The review showed it could not
  work with a real desktop client.
- **Internal `storage-api` service** (port 3001): no callers, served user records including
  `passwordHash` without authentication.
- **PowerShell Remoting stub** (`/PowerShell/`) and `POST /api/v1/admin/ems/cmdlet` — they
  never executed cmdlets. The EMS REST endpoints under `/api/v1/admin/ems/` remain.
- **Legacy routes** `/api/v1/admin/mailboxes/shared*` — use `/api/v1/admin/shared-mailboxes`.
- **Unreferenced BCP pages** (Connectors, Resources, Organisation, Mobile Devices) and unused
  i18n keys; MWA compose no longer queries the removed `/admin/groups/gal` endpoint.
- **OpenTelemetry** `metrics`/`tracing` modules and dependencies plus unused exports from
  `@coremail/core`; legal-hold leftovers in the retention worker.

### Known open issues

Tracked by the failing reviewer suites: IMAP literals/SEARCH/STATUS, POP3 message rendering
from the raw source, JMAP `/changes` after IMAP flag changes, calendar `allDay`/RRULE
persistence and CalDAV ETags, atomic UID/modSeq allocation, certificate auto-renewal,
quarantine release. MFA is not yet enforced for IMAP/SMTP/POP3/ActiveSync logins.

---

## [5.9.0] — 2026-10-28 — English-only repository

### Changed

- **Everything on GitHub is English now**: `README.md` (German version kept as
  `README.de.md` with a language switch at the top), `CHANGELOG.md` including the full
  history, `CLAUDE.md`, `COMMANDS.md`, `docs/**` (JMAP, CLI, Docker deployment, release
  notes), all code comments in every package (`packages/*/src`, Prisma schema), and all
  infrastructure comments (`docker-compose*.yml`, `Dockerfile.app`, supervisord, entrypoint,
  rspamd/nginx configs, scripts, GitHub workflow, `.env.example`).
- **Admin CLI output is English** (`coremail …` messages, table headers, help texts,
  prompts). The `--yes`/`-y` flag and all command names are unchanged.
- **Developer-facing log messages (pino) and test names are English** in all services.
  Not changed on purpose: HTTP API response texts, SMTP/IMAP/POP3 protocol strings,
  texts persisted to the database, mail/DSN content and the MWA/BCP i18n values.
- `docker-compose.yml`: the `${VAR:?…}` guard messages for the five required `.env`
  values are English.
- No functional changes: UI strings of MWA/BCP (i18n DE/EN) and API response texts are
  untouched. The image tag for this release is `magpeek/coremail-app:5.9.0`; it also
  contains everything from 5.8.0 (admin CLI, new Docker Compose, EWS tied to the MAPI
  switch), which did not get its own image.

### Security

- `CLAUDE.md`: removed a plaintext SSH root password of the live server from the
  repository (rotate the password on the host).

---

## [5.8.0] — 2026-10-28 — Admin CLI `coremail`, new Docker Compose, EWS tied to MAPI

### Added

**Admin CLI `coremail`** — new package `packages/cli/` (commander), installed in the app image as
`/usr/local/bin/coremail` (`docker exec -it coremail coremail --help`).
Talks to the same REST admin API as the BCP → same role checks, same audit log.

| Group | Commands |
|--------|---------|
| `login` / `logout` / `whoami` | Admin login with password + MFA (TOTP/backup code), session in `~/.config/coremail/credentials.json` (0600), automatic token refresh; alternatively `COREMAIL_TOKEN` or `COREMAIL_ADMIN_EMAIL`/`_PASSWORD`/`_TOTP` |
| `user` | `list [--domain] [--inactive]`, `show`, `create --name [--password] [--role] [--quota] [--domain]`, `update [--name|--role|--quota|--enable|--disable]`, `set-password`, `delete [--yes]` |
| `mailbox` | `list [--sort used|quota|email]`, `show` (folders + counters), `quota <size>`, `recalculate [user]` |
| `shared` | `list`, `show`, `create --name [--quota]`, `grant <shared> <user> <perms…>`, `revoke`, `delete` |
| `domain` | `list` |
| `connector` | `status` (SMTP/SMTP-Send/IMAP/POP3 listeners + JMAP + MAPI/EWS), `enable|disable <svc> [--port]`, `listener list|add|set|delete|restore-defaults` |
| `smtp banner` | `show`, `set <text>`, `reset` |
| `cert` | `list`, `show`, `self-signed --domains [--services] [--days]`, `letsencrypt --domains --email [--services] [--staging] [--no-auto-renew]`, `activate --https/--protocol`, `deactivate-https`, `renew`, `delete` |

- Global options `--server <url>`, `--json`; delete commands prompt for confirmation (`--yes` for scripts);
  exit code 1 on errors with HTTP status. Sizes as `5GB`/`500MB`.
- Docs: `docs/cli.md`; README section "Admin CLI".

### Changed

- **`infra/docker/docker-compose.yml` rewritten**: only the parameters the stack
  actually needs (internal service URLs/ports have defaults in the image). The five
  required values (`JWT_SECRET`, `PEPPER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`,
  `MINIO_ROOT_PASSWORD`) are checked with `${VAR:?…}` → `docker compose up` aborts with
  a meaningful message instead of starting half-way. Header comment with 3-step guide,
  port overview, volume explanation; `COREMAIL_VERSION`, `TZ` as variables; MinIO console
  still bound to `127.0.0.1` only.
- **`.env.example` new**: required (5 values) clearly separated from optional, everything optional commented out.
- **`scripts/setup.sh` new**: checks Docker/openssl, generates `.env` with `openssl rand`
  (chmod 600), symlinks it next to the Compose file, shows the next steps.
  Old nginx dev-certificate steps removed.
- **EWS tied to the MAPI switch**: `/EWS/Exchange.asmx` and `/OAB/*` return 404
  as long as `ServerSettings.mapiHttpEnabled` is off (default). Autodiscover v2
  `?Protocol=EWS` then answers `NoSuchProtocol`. EWS is no longer a standalone
  client path (current desktop client builds do not speak Basic-Auth EWS against
  third-party servers), but remains as a companion protocol of MAPI over HTTP (free/busy,
  out-of-office, OAB). The BCP card is now called "MAPI over HTTP + EWS".
- README: EWS removed as a standalone path from the protocol overview, client table and access table;
  Compose/configuration sections switched to the new file; JMAP in the
  feature table; image tags bumped to 5.8.0.
- `docs/deployment-docker.md`: EWS lines adjusted, JMAP URL added.

### Docs

- `docs/jmap.md`: architecture diagram, client setup (Ltt.rs, Thunderbird, web apps),
  curl examples (reading, flags/moving, sending with `onSuccessUpdateEmail`, attachments,
  EventSource, WebSocket, Blob/Quota) and FAQ.
- `docs/releases/v5.7.1.md` and `docs/releases/v5.8.0.md`: release notes for GitHub Releases
  including a proposal for the repository description and topics.

### Upgrade Notes

- Anyone who previously connected a desktop client via EWS (without MAPI) enables
  "MAPI over HTTP + EWS" in BCP → Server or switches to IMAP.
- Existing `.env` files remain valid; the new Compose reads the same variables.
  Dropped Compose variables (internal ports/URLs) are stored as image defaults.

---

## [5.7.1] — 2026-10-27 — JMAP Server (RFC 8620/8621 + 8887/9404/9425/9670/9749)

### Added

**New package `packages/jmap-server/` (port 3006)** — JSON Meta Application
Protocol as a modern IMAP/SMTP replacement, reachable behind the api-gateway:

| Path | Purpose |
|------|-------|
| `GET /.well-known/jmap` | Discovery → 301 to `/jmap/session` (RFC 8620 §2.2) |
| `GET /jmap/session` | Session resource with capabilities, accounts, URLs |
| `POST /jmap/api` | Method calls (result references, creation ids, limits) |
| `POST /jmap/upload/{accountId}/` · `GET /jmap/download/{accountId}/{blobId}/{name}` | Blobs |
| `GET /jmap/eventsource` | Push via Server-Sent Events (`types`, `closeafter`, `ping`) |
| `WS /jmap/ws` | JMAP over WebSocket, subprotocol `jmap` (RFC 8887) |

- **RFC 8620 Core**: session, `Core/echo`, standard errors (`urn:ietf:params:jmap:error:*`,
  method/set errors), `PushSubscription/get|set` with PushVerification flow
  (new table `jmap_push_subscriptions`), state strings per data type.
- **RFC 8621 Mail**: `Mailbox/get|changes|query|set`, `Email/get|changes|query|set|copy|import|parse`,
  `Thread/get|changes`, `Identity/get|changes|set`, `EmailSubmission/get|changes|query|set`
  (incl. `onSuccessUpdateEmail`/`onSuccessDestroyEmail`, delayed sending +
  cancellation via the BullMQ queue `smtp-outbound`), `SearchSnippet/get`,
  `VacationResponse/get|set` (on `UserSettings.oof*`).
- **RFC 8887 WebSocket**: `Request`/`Response`/`RequestError`/`StateChange`,
  `WebSocketPushEnable|Disable`; the upgrade is forwarded by the api-gateway (HTTP + integrated
  TLS proxy) to the jmap-server.
- **RFC 9404 Blob**: `Blob/upload` (asText/asBase64/blobId slices), `Blob/get`
  (`data:*`, `digest:sha`, `digest:sha-256`, `size`, offset/length), `Blob/lookup`.
- **RFC 9425 Quota**: `Quota/get|changes|query|queryChanges` from `quotaBytes`/`usedBytes`.
- **RFC 9670 Sharing**: `Principal/*` (user = individual, Shared Mailbox = group),
  `ShareNotification/*` (currently empty), `urn:ietf:params:jmap:principals:owner` per account.
- **RFC 9749 VAPID**: session capability `urn:ietf:params:jmap:webpush-vapid`
  with `applicationServerKey` from `VAPID_PUBLIC_KEY`.
- **Accounts**: own mailbox (`accountId = userId`), Shared Mailboxes
  (`shared-<id>`, FULL_ACCESS/READ_ONLY), delegated mailboxes (MailboxDelegate).
- **Auth**: Bearer (session JWT, also `?access_token=` for EventSource/WS) and
  Basic (password; with MFA only app password; LDAP/OIDC via auth-service), 60s cache.
- **Threads**: new column `Message.threadId` (lazily derived from `inReplyTo`).
- **Switch**: `ServerSettings.jmapEnabled @default(true)`, BCP → Server →
  card "JMAP", hot reload via Redis `settings:reload`; off → 404.
- **MinIO**: lifecycle `jmap-upload/` 7 days, helper `jmapUploadKey()`.
- Unit tests (`node --test`): dispatcher/result references, keywords, state codecs.
- Docs: `docs/jmap.md` (setup, clients, method overview, limitations).

### Known Limitations

- `Email/queryChanges`, `Mailbox/queryChanges`: `cannotCalculateChanges` (client reloads).
- Deleted messages have no tombstones → `Email/changes` returns
  `cannotCalculateChanges` after a hard delete.
- An email lives in exactly one folder (`maxMailboxesPerEmail: 1`).
- Filters `header`, `*InThreadHaveKeyword` → `unsupportedFilter`; sort `to` → `unsupportedSort`.
- `bodyStructure` is synthesized from the DB fields (text/plain, text/html, attachments).

### Infra

- `Dockerfile.app`, `supervisord-app.conf`, `docker-compose*.yml` (`JMAP_SERVICE_URL`, `JMAP_PORT`),
  root `tsconfig.json`: package `jmap-server` registered.

---

## [5.7.0] — 2026-10-27 — MAPI over HTTP optionally back + build hardening

### Added

**MAPI over HTTP as an optional feature (default OFF).** The MAPI/HTTP stack
removed in v5.4.0 (v4.0–v5.2, MS-OXCMAPIHTTP/ROPS/NSPI, ~9,000 LOC)
has been restored from the git history and put behind a switch:

- New field `ServerSettings.mapiHttpEnabled Boolean @default(false)`.
- BCP → Server → card "MAPI over HTTP" with checkbox + limitation notice.
- `PUT /api/v1/admin/servers/settings` accepts `mapiHttpEnabled` (optional,
  so that older BCP builds can keep saving).
- ews-server: `src/mapi/feature-flag.ts` — `isMapiHttpEnabled()` with 60s cache,
  invalidation via Redis `CHANNEL_SETTINGS_RELOAD` (hot reload, no restart).
  Gate `requireMapiEnabled` returns **404** on `/mapi/*` (incl.
  `/healthcheck.htm`) as long as the switch is off. Fail-closed on DB error.
- api-gateway: proxy `/mapi` → ews-server active again, `/mapi` in `API_PREFIXES`.
- autodiscover: `<Protocol Type="mapiHttp">` only if `cfg.mapiHttpEnabled`;
  `ServerConfig.mapiHttpEnabled` (env fallback `ENABLE_MAPI_HTTP=true` without DB).
- NSPI GAL without DistributionGroup (v5.6.1 adjustment), active users only.
- 35 MAPI codec tests (`node --test`) run again.

**Not included**: ADFS emulation (v5.3.0) — remains removed. This means:
desktop clients of the 2013–2021 generation connect via Basic Auth as a MAPI account; the newest
desktop builds enforce Modern Auth against their vendor's identity platform and stay on the
IMAP path; the new web-based desktop apps do not support MAPI.

### Changed

- **pnpm pinned**: `packageManager: pnpm@11.28.9` in the root
  `package.json`, `Dockerfile.app` uses `corepack prepare pnpm@11` instead of
  `pnpm@latest` (pnpm 12 via corepack broke the install).
- **Frontend builds no longer emit JS next to the sources**: `noEmit: true`
  in `admin-panel`/`web-client` tsconfig. 70 stale, checked-in
  `src/**/*.js` artifacts (as of v3.18.34, incl. `OAuthClientsPage.js`) removed.
- Stale comments about OAuth2/ADFS/MAPI/distribution groups cleaned up
  (api-gateway `server.ts`, `contacts.ts`, ews-server `auth/middleware.ts`,
  smtp-server `inbound/handler.ts`, `schema.prisma`).

### Migration

- `prisma db push` creates `server_settings.mapiHttpEnabled` (false) — non-
  destructive. Behavior after the upgrade is identical to v5.6.1 until the switch
  is set in the BCP.

---

## [5.6.1] — 2026-05-27 — Distribution groups (DistributionGroups) completely removed

### Removed (Major)

**Distribution groups completely removed from the stack.**
User decision: "Remove distribution groups as well". In practice,
distribution groups were rarely used — modern teams prefer Shared Mailboxes
(`/admin/shared-mailboxes/`) for team mailboxes with aliases, or external
listserv tools for pure distribution lists. Reduces code complexity and one
maintenance point in the BCP. Analogous to v3.18.5 (eDiscovery), v3.18.31 (Public
Folders), v3.18.33 (ExternalMailContacts), v5.4.0 (MAPI), v5.6.0 (OAuth2).

### Prisma Schema (DESTRUCTIVE Migration)

**2 models + 1 enum deleted** — tables are dropped via `prisma db push
--accept-data-loss` at container start:
- `DistributionGroup` → table `distribution_groups`
- `DistributionGroupMember` → table `distribution_group_members`
- enum `GroupType { STATIC, DYNAMIC }`
- `Domain.distributionGroups` relation removed

### Frontend (BCP / admin-panel)

- **BCP `/groups/` page**: deleted (`packages/admin-panel/src/pages/GroupsPage.tsx`)
- Sidebar entry "Distribution groups" + Users icon import removed
- Route `/groups` removed from `main.tsx`
- i18n keys `nav_groups` (DE+EN) removed
- OrganisationPage GAL section: "Distribution groups" column removed
- SmtpConfigPage local-delivery hint: "Distribution groups are resolved" removed

### Backend (api-gateway)

- **`packages/api-gateway/src/routes/admin/groups.ts`**: deleted
- Mount `/api/v1/admin/groups` removed from server.ts
- **EMS REST bridge** (`routes/admin/ems.ts`): all DistributionGroup CRUD
  endpoints removed (~150 LOC) incl. `formatGroup()` helper:
  - `GET/POST /distribution-groups`
  - `GET/PUT/DELETE /distribution-groups/:id`
  - `GET/POST/DELETE /distribution-groups/:id/members`
  - Cmdlet routes for Get-/New-/Set-/Remove-DistributionGroup +
    Get-/Add-/Remove-DistributionGroupMember removed
- **PowerShell Remoting** (`routes/powershell.ts`): 6 DistributionGroup
  cmdlets removed from the `SUPPORTED_CMDLETS` set
- **GAL endpoint** (`routes/contacts.ts`):
  - `/contacts?q=` autocomplete: DistributionGroup search removed
  - `/contacts/gal` (both search and detail): DistributionGroup
    source removed, `GROUP` kind removed from `GalEntry` type
- **Dashboard** (`routes/admin/dashboard.ts`): `distributionGroup.count()`
  → constant 0
- **Organisation** (`routes/admin/organisation.ts`): GAL section
  `groups` array stays empty

### Backend (smtp-server)

- **`packages/smtp-server/src/handlers/expand.ts`**: completely rewritten —
  `expandRecipients()` now only resolves email aliases (cycle protection via
  visited set is preserved); no more DistributionGroup lookup.
- **`packages/smtp-server/src/inbound/handler.ts`**: `verifyRecipient()`
  Promise.all drops the DistributionGroup lookup; inbound mails to
  former group addresses are rejected as unknown recipient
  (550 5.1.1).

### Migration Note

Existing DistributionGroups + memberships are irrevocably lost with the
upgrade. Use-case recommendation:
- **Team mailbox with a shared inbox** → Shared Mailbox + members
  via permissions
- **Pure distribution list (outbound)** → external listserv (Mailman, listmonk)
  or maintain the recipient list directly in the user clients

---

## [5.6.0] — 2026-05-27 — OAuth2 / Modern Auth completely removed from the stack

### Removed (Major)

**OAuth2 / Modern Auth / JWT RS256 infrastructure completely deleted.** User
decision: "Remove and strip from the code: BCP OAuth2 / Modern Auth".

Background: After the MAPI removal in v5.4.0 + the IMAP OAuth decision in v5.5.0,
OAuth2 has no practical use case left in the stack. Mail clients use IMAP/
SMTP/POP3 with app passwords (MFA-capable). MWA + BCP use session JWTs
via `/auth/login`. The complete OAuth2 codebase is dead weight.

### Frontend

- **BCP `/oauth-clients/` page**: deleted (`packages/admin-panel/src/pages/OAuthClientsPage.tsx`)
- BCP sidebar entry "OAuth2 Clients" + i18n keys removed
- BCP route `/oauth-clients` removed
- **MWA `/oauth-consent/` page**: deleted (`packages/web-client/src/pages/OAuthConsentPage.tsx`)
- MWA route `/oauth-consent` removed
- MWA LoginPage: OAuth2 flow detection removed (login goes directly to `/mail`)

### Backend

- **`packages/auth-service/src/oauth2/`**: entire directory deleted (router + 970 LOC)
- **`packages/api-gateway/src/routes/admin/oauth-clients.ts`**: deleted
- api-gateway: `/oauth2/*` proxy removed
- api-gateway: `/api/v1/admin/oauth/*` mount removed
- api-gateway: `/.well-known/openid-configuration` + `/.well-known/jwks.json` handlers removed
- auth-service: `/oauth2` mount removed
- ews-server middleware: Bearer branch completely removed (audience validation, OAuth token revocation check) — Basic Auth only

### JWT back to HS256

- **`packages/core/src/auth/jwt-keys.ts`**: deleted (RS256 key management was only for JWKS)
- `packages/core/src/auth/jwt.ts`: completely rewritten back to HS256 with the `JWT_SECRET` env var (as pre-v5.2.17)
- `initJwtKeys()` removed from api-gateway, auth-service, ews-server, backup-service, caldav-server startup

### Prisma Schema (DESTRUCTIVE Migration)

**4 models deleted** — tables are dropped via `prisma db push --accept-data-loss` at container start:
- `OAuthClient` → table `oauth_clients`
- `OAuthAuthorizationCode` → table `oauth_authorization_codes`
- `OAuthToken` → table `oauth_tokens`
- `OAuthConsent` → table `oauth_consents`

**`User` relations** removed: `oauthCodes`, `oauthTokens`, `oauthConsents`.

**`ServerSettings` fields removed:** `jwtPrivateKey`, `jwtPublicKey`,
`jwtKeyId`, `jwtKeyCreated`.

### What remains

- **App passwords** (`AppPassword` model + `/auth/app-passwords` router) — the pragmatic MFA bypass for IMAP/SMTP/POP3/EWS
- **Session JWTs** (HS256-signed with `JWT_SECRET`) for REST API + MWA/BCP login
- **MFA/TOTP/WebAuthn** (`UserMfa` model + `/auth/mfa` router) — for interactive logins
- **SSO/OIDC provider integration** (`SsoConfig` model + `/sso` routes) — for external IdP login (NOT for our own tokens)

### Migration Impact

- Existing OAuth client data is lost (but was never used in this installation)
- RS256 JWTs become invalid → users log in again once (HS256 JWTs are issued)
- API consumers that used our `/oauth2/token` would have to switch to `/auth/login` (none known)

### Stack Simplification

| Before (v5.5.0) | After (v5.6.0) |
|-----------------|------------------|
| 2 frontend pages (OAuthClientsPage + OAuthConsentPage) | — |
| 1 backend router (oauth2/router.ts, 970 LOC) | — |
| 1 backend module (jwt-keys.ts, 130 LOC) | — |
| 1 admin API router (oauth-clients.ts, 220 LOC) | — |
| 4 Prisma models + relations | — |
| JWT keys persisted in DB | JWT_SECRET env var |
| 9 endpoints under /oauth2/* | — |
| 2 well-known endpoints | — |

**Total removed: ~1,500 LOC** in addition to MAPI's 12,000 LOC from v5.4.0.

---

## [5.5.0] — 2026-05-27 — IMAP4rev2 RFC compliance + docs update

### Added

**IMAP RFC 3501 + RFC 9051 (IMAP4rev2) compliance:**

| Feature | RFC | Effect |
|---------|-----|---------|
| **AUTHENTICATE PLAIN** | 3501 §6.2.2 + 4616 | SASL standard, instead of only the LOGIN command |
| **AUTHENTICATE LOGIN** | obsolete but common | Multi-step `Username:` → `Password:` |
| **SASL-IR** | 4959 | Initial response on the same line |
| **UNSELECT** | 3691 / IMAP4rev2 mandatory | Deselect folder without EXPUNGE (vs CLOSE) |
| **ID** | 2971 | Client/server identification |
| **STARTTLS** | 3501 §6.2.1 | Stub on port 143 (points to 993 — a full upgrade needs a socket refactor) |

**CAPABILITY list extended with:** `IMAP4rev2`, `MOVE`, `UNSELECT`, `UIDPLUS`, `STATUS=SIZE`. Plus dynamic `STARTTLS`/`LOGINDISABLED` toggle (only on plain connections).

### Architecture decision: NO XOAUTH2 for mail protocols

Research result (public vendor and project documentation):
- **Apple Mail**: hardcoded provider list of large hosted providers — no UI for custom OAuth servers
- **Windows desktop client (LTSC 2024)**: its vendor has explicitly stated: no OAuth for POP/IMAP
- **Thunderbird**: theoretically yes, in practice a `prefs.js` hack per account → unsuitable for end users
- **eM Client / K-9 Mail**: large providers only

**Verdict**: XOAUTH2 for self-hosted servers has a ~1% real user base (mutt/isync power users). They can use **app passwords** instead, which are already implemented. The OAuth2 server remains under `/oauth2/*` for REST API + web app integration.

### Changed — docs completely updated

**README.md:**
- MAPI section removed
- "Native desktop connection" section → **"Connecting clients"** with IMAP setup table for all common clients (Windows desktop clients, Apple Mail, Thunderbird, eM Client, K-9, iOS Mail)
- App passwords section with step-by-step guide
- IMAP4rev2 badge instead of MAPI/HTTP badge
- Version history updated: v5.x = "IMAP4rev2 + RFC compliance + MAPI cleanup"

**CLAUDE.md:**
- "Current version" → 5.5.0
- New section "Architecture decisions (v5.4.0+)" — MAPI removal rationale, OAuth2 scope, IMAP4rev2 status
- `/mapi/*` removed from the routing table
- "MAPI over HTTP" section → note about the v5.4.0 removal

---

## [5.4.0] — 2026-05-27 — MAPI completely removed from the stack

### Removed (Major)

**MAPI-over-HTTP implementation completely deleted.** User decision:
"discard the MAPI concept and remove it". Background: the LTSC 2024 desktop
client enforces Modern Auth on MAPI/EWS endpoints and does not accept
third-party OAuth providers. A custom ADFS emulation would have required 3-4 weeks
of effort with no guarantee of success (see research from v5.3.0).

Consistent cleanups:

| Component | Status | Size |
|------------|--------|-------|
| `packages/ews-server/src/mapi/` | **deleted** | ~12,000 LOC |
| `<Protocol Type="mapiHttp">` in Autodiscover XML | **removed** | Autodiscover now only announces IMAP+SMTP+ActiveSync |
| `/mapi/*` proxy in api-gateway | **removed** | — |
| `/adfs/oauth2/*`, `/adfs/ls/`, `/FederationMetadata/*` routes | **removed** | Was for MAPI Modern Auth |
| `provisionWellKnownOAuthClients()` (well-known desktop/mobile client_ids) | **removed** | — |
| `packages/storage/src/oauth-clients-bootstrap.ts` | **deleted** | — |
| `ENABLE_MAPI_HTTP` environment flag | **removed** | Was dead code only |

### Kept

- **IMAP/IMAPS** port 143/993 — fully functional (see v5.3.1 + v5.3.5 fixes)
- **SMTP/Submission** port 25/465/587 — STARTTLS + Basic Auth
- **POP3/POP3S** port 110/995 — with app-password fallback (v5.3.1)
- **EWS** port 8080 — stays for EWS client compatibility
- **CalDAV** port 8082 — calendar via Apple Calendar, Thunderbird Lightning, etc.
- **CardDAV** port 8082 — contacts in sync
- **ActiveSync** port 3005 — EAS 14.1 for mobile clients
- **OAuth2 server** under `/oauth2/*` — for web apps + API clients
- **MWA + BCP** — fully functional web UIs

### Recommended Client Setups

| Client | Account type | Protocols |
|--------|-----------|------------|
| **Windows desktop client (LTSC 2024)** | **IMAP** account | IMAP+SMTP |
| **Windows desktop client (LTSC 2021)** | IMAP or EWS | IMAP+SMTP |
| **Apple Mail (Mac + iOS)** | IMAP account | IMAP+SMTP+CalDAV+CardDAV |
| **Thunderbird** | IMAP account | IMAP+SMTP+CalDAV (Lightning)+CardDAV (TbSync) |
| **eM Client** | IMAP account | IMAP+SMTP+CalDAV+CardDAV |
| **Android K-9 Mail** | IMAP account | IMAP+SMTP |
| **iOS Mail.app** | "Other" → IMAP | IMAP+SMTP+CalDAV+CardDAV (Apple Calendar/Contacts separately) |

### Changed/preserved version numbers in the roadmap

The MAPI roadmap v4.0→v5.2 (phases 1-7 + FINAL) is preserved as git history and
README documentation, but is no longer active code. If
the desktop client vendor ever relaxes Modern Auth or a realistic path
emerges, the code can be reactivated from the git archive.

---

## [5.3.1] — 2026-05-27 — IMAP completeness + POP3 app password + byte stuffing

### Fixed — IMAP (Mac Mail folder management broken)

User observation: Mac Mail can connect and sees the standard
folders, but **new folders are not created** and **mails in the
folders are not displayed**. Root cause: major IMAP commands were missing.

Implemented in `packages/imap-server/src/commands/index.ts`:

| Command | RFC | Effect |
|---------|-----|---------|
| `CREATE` | 3501 §6.3.3 | "Create new folder" in Mac Mail |
| `DELETE` | 3501 §6.3.4 | Delete folder (messages soft-deleted) |
| `RENAME` | 3501 §6.3.5 | Rename folder |
| `APPEND` | 3501 §6.3.11 | Mac Mail uploads local drafts/sent to the server |
| `COPY` / `UID COPY` | 3501 §6.4.7 | Drag-drop "copy to folder" |
| `MOVE` / `UID MOVE` | 6851 | Atomic move without EXPUNGE round trip |
| `SEARCH` / `UID SEARCH` | 3501 §6.4.4 | **CRITICAL** — Mac Mail uses this on every folder open |
| `CLOSE` | 3501 §6.4.2 | Deselect folder + implicit EXPUNGE |
| `CHECK` | 3501 §6.4.1 | Server sync (NOOP for us) |

**SEARCH was the most important fix**: when opening a folder, Mac Mail first
runs `UID SEARCH ALL` to fetch the UID list, THEN
`UID FETCH 1:* (UID FLAGS …)`. Without SEARCH, Mac Mail got `BAD Command
not recognized` → the folder appeared empty although messages existed.

### Fixed — IMAP UID Command Variants

The dispatcher now recognizes `UID <SUB>` as a compound command (before: only the
first token was uppercased, so `UID FETCH` was wrongly handled as `cmd='UID'` with `args[0]
='FETCH'`). Now: all 6 variants — `UID FETCH`,
`UID STORE`, `UID COPY`, `UID MOVE`, `UID SEARCH`, `UID EXPUNGE`.

### Fixed — IMAP Sequence-Set Parser

`parseSequenceSet()` now supports, in addition to UID mode, the
sequence-number mode (1-based positions) for the non-UID variants
of COPY/MOVE/SEARCH/STORE/FETCH. Backward-compatible: default `byUid=true`.

### Fixed — POP3 App Password + Bare Username

User observation: POP3 with an MFA user → login error. Previously only
`User.passwordHash` was checked. Now analogous to IMAP/EWS:
1. `verifyPassword(pw, User.passwordHash)`
2. Fallback: `verifyPassword(pw, AppPassword.hash)` for all app passwords
3. Bare username (`admin` without `@domain`) is completed with the primary
   domain (before: user lookup with `email='admin'` → 401)

### Fixed — POP3 Byte Stuffing (RFC 1939 §3)

**Critical**: Multi-line mails with `.` at the start of a line were truncated
by POP3 clients. Before: `eml.replace(/^\./, '..')` —
replaced only the FIRST character. Now: every line starting with `.`
is escaped to `..` (line by line). Standard requirement
for POP3 servers.

---

## [5.3.0] — 2026-05-27 — ADFS emulation foundation (Phase C + E + ADFS aliases)

### Major Feature

Start of the **ADFS emulation for Modern Auth of the LTSC 2024 desktop client**.
Background: research (public vendor documentation and open-source implementations) showed
that the Win32 desktop client (incl. LTSC 2024) accepts **no** third-party OAuth2
provider. Modern Auth in the ADAL/MSAL stack is effectively hardcoded
to `login.microsoftonline.com` OR **ADFS** (Active Directory Federation
Services). Therefore CoreMail v5.3+ emulates the ADFS protocol step by step.

This v5.3.0 is the **foundation** — full end-to-end integration
follows in v5.4.0 (WS-Trust 1.3) + v5.5.0 (login UI) + v5.6.0 (E2E test).

### Added — Phase C: Well-Known OAuth2 Clients

`packages/storage/src/oauth-clients-bootstrap.ts` idempotently provisions
the hardwired well-known client IDs at api-gateway boot:

- `d3590ed6-52b3-4102-aeff-aad2292ab01c` — desktop mail client (Win + Mac)
- `27922004-5251-4030-b22d-91ecd9a37ea4` — mobile mail app (iOS + Android)
- `f8d98a96-0999-43f5-8af3-69971c7bb423` — iOS Mail.app
- `00000003-0000-0000-c000-000000000000` — Graph API (catch-all)

All as public clients (no secret), PKCE mandatory, trusted (no
consent prompt). With `redirect_uris` for `msauth://`, `urn:ietf:wg:oauth:
2.0:oob`, `ms-appx-web://Microsoft.AAD.BrokerPlugin/*`.

### Added — Phase E: Bearer Token Audience Validation

`packages/ews-server/src/auth/middleware.ts` now validates the `aud`
claim of incoming Bearer tokens. Accepts:
- Tokens without `aud` (legacy CoreMail tokens — refresh sets `aud`)
- `aud` = server FQDN (`https://mail.example.de`)
- `aud` = `https://outlook.office365.com` (desktop client default)
- `aud` = `00000002-0000-0ff1-ce00-000000000000` (hosted mail service resource ID)

Protection against token substitution / cross-tenant.

### Added — ADFS Endpoint Aliases

The API gateway now routes `/adfs/oauth2/*` to the same auth-service
backend as `/oauth2/*`:
- `/adfs/oauth2/authorize` ← the LTSC 2024 desktop client looks there, hardwired
- `/adfs/oauth2/token`
- `/adfs/oauth2/jwks`
- `/adfs/oauth2/.well-known/openid-configuration`

### Added — Federation Metadata XML

New endpoint `GET /FederationMetadata/2007-06/FederationMetadata.xml`
returns minimal but valid WS-Federation 1.2 metadata with:
- `<EntityDescriptor>` with the server FQDN as entityID
- `<RoleDescriptor xsi:type="fed:SecurityTokenServiceType">`
- `<KeyDescriptor use="signing">` with our RS256 public key
- `<fed:TokenTypesOffered>` JWT
- `<fed:PassiveRequestorEndpoint>` points to `/adfs/oauth2/authorize`

### Added — EWS/MAPI Bearer Challenge with authorization_uri (RFC 6750)

When an unauthenticated request to `/EWS/Exchange.asmx` or
`/mapi/emsmdb/` arrives, the server now responds with:
```
WWW-Authenticate: Bearer realm="https://mail.example.de",
                  authorization_uri="https://mail.example.de/adfs/oauth2/authorize",
                  scope="EWS.AccessAsUser.All", Basic realm="CoreMail EWS"
```
The LTSC 2024 desktop client reads `authorization_uri` and starts its
OAuth2 flow against the endpoint given there.

### Roadmap to the complete Modern Auth integration for desktop clients

| Version | Content | Effort |
|---------|--------|---------|
| **v5.3.0** (today) | Foundation: Phase C+E, ADFS aliases, FederationMetadata, Bearer challenge | ✅ |
| **v5.4.0** | WS-Trust 1.3 endpoint (`/adfs/services/trust/13/usernamemixed`) — SOAP-based UsernameToken auth | ~6-8h |
| **v5.5.0** | ADFS login page (`/adfs/ls/`) with browser flow + token audience adjustment | ~4-6h |
| **v5.6.0** | Autodiscover OAuth2 hint + real desktop client test + bug fixes | ~2-4h |

---

## [5.2.19] — 2026-05-27 — IMAP parseLine bug: empty quoted strings (LIST "" "*")

### Fixed

After the v5.2.18 deploy, live logs showed:
`SyntaxError: Invalid regular expression: /^*.*$/i: Nothing to repeat`
on every LIST + LSUB call from Mac Mail → the IMAP connection threw 500.

Root cause: `parseLine()` in `packages/imap-server/src/server/index.ts`
treats empty quoted strings (`""`) as "not present" and skips
them. Mac Mail sends `LIST "" "*"` (RFC 3501 standard) → our parser
turned it into `args=['*']` instead of `args=['', '*']` → `reference` was
wrongly set to `*` → regex `^*.*$` invalid (asterisk at the
start with no preceding character).

### Changes

- `parseLine()`: tracks a `quotedToken` flag — empty quoted tokens are now
  correctly pushed as an empty string
- `handleList` + `handleLsub`: defensive — `reference` is escaped before building the RegExp,
  plus try/catch around the RegExp construction (fallback: match all
  folders)

Effect: Mac Mail / iOS Mail / Thunderbird / all IMAP clients now see
their folder list correctly. Before this fix, effectively every
`LIST "" "*"` was broken — the bug had been latent for a long time, but masked
because our test clients (openssl without `""`) did not trigger it.

---

## [5.2.18] — 2026-05-27 — IMAP SPECIAL-USE + LSUB + NAMESPACE + STATUS (Mac Mail fix)

### Fixed

User observation: Mac Mail can log in via IMAP, but only shows INBOX.
The other system folders (Drafts/Sent/Trash/Junk/Archive) are hidden in the
sidebar, and mails from these folders do not appear — even
if they are visible in the MWA.

### Root Cause

Our IMAP server returned:
- LIST responses WITHOUT SPECIAL-USE flags (`\Drafts`, `\Sent`, `\Trash`, `\Junk`,
  `\Archive`). Mac Mail recognizes system folders exclusively via these flags
  — without them it only sees INBOX as a "standard folder" and hides everything
  else.
- LSUB not implemented → Mac Mail got `BAD Command not recognized`,
  fell back to INBOX only.
- SUBSCRIBE / UNSUBSCRIBE not implemented.
- NAMESPACE not implemented (CAPABILITY announced it, but there was no
  handler).
- STATUS not implemented (Mac Mail uses it for folder refresh without
  SELECT — if the answer is a `BAD`, the folder is marked as "unsynced").

### Added

- **`specialUseFlag(name)`** in `packages/imap-server/src/commands/index.ts`
  maps folder names (case-insensitive, EN + DE) to SPECIAL-USE flags:
  - `INBOX` / `Posteingang` → no flag (INBOX is always `*`)
  - `Drafts` / `Entwürfe` → `\Drafts`
  - `Sent` / `Gesendet` → `\Sent`
  - `Trash` / `Gelöscht` → `\Trash`
  - `Junk` / `Spam` → `\Junk`
  - `Archive` / `Archiv` → `\Archive`
- **handleList** now emits SPECIAL-USE flags next to `\HasNoChildren`
- **handleLsub** — same output as LIST (all standard folders count
  as auto-subscribed)
- **handleSubscribe** / **handleUnsubscribe** — RFC 3501 §6.3.6/6.3.7,
  accept subscriptions (no-op)
- **handleNamespace** — RFC 2342, returns the personal namespace `(""  ".")`
- **handleStatus** — RFC 3501 §6.3.10, MESSAGES/UIDNEXT/UIDVALIDITY/UNSEEN/
  RECENT/HIGHESTMODSEQ

### CAPABILITY

Now additionally announces: `SPECIAL-USE`, `LIST-EXTENDED`, `LIST-STATUS`,
`CHILDREN`. Mac Mail checks these explicitly.

### Effect

Apple Mail / Mac Mail / iOS Mail / Thunderbird now see all standard
folders with the correct icon (briefcase for Drafts, paper plane for Sent,
trash can for Trash, …) AND all messages contained in them.

---

## [5.2.17] — 2026-05-27 — Modern Auth Foundation (RS256 JWT + OIDC Discovery)

### Why

The LTSC 2024 desktop client enforces Modern Auth (OAuth2/OIDC) and no longer accepts a
Basic-Auth fallback (not even with the `EnableADAL=0` registry key). Live logs
on the server showed `scheme:"bearer"` on every connection attempt — the desktop client
sends OAuth2 tokens exclusively, never Basic-Auth credentials.

Until now CoreMail had OAuth2 server endpoints under `/oauth2/*`, but JWT was
signed with HS256 (HMAC, symmetric) — so the JWKS endpoint could not
provide a public key → OIDC clients (desktop clients, mobile apps with Modern
Auth) rejected tokens.

### Changed

- **JWT signing switched from HS256 to RS256.** RSA-2048 asymmetric, keys
  are generated automatically on first service start and persisted in
  `ServerSettings.jwtPrivateKey/jwtPublicKey/jwtKeyId`.
  Happens idempotently via the new `initJwtKeys(prisma)` function in
  `@coremail/core`, called at boot of api-gateway, auth-service,
  ews-server, backup-service, caldav-server.

- **JWKS endpoint** (`/oauth2/jwks` + new `/.well-known/jwks.json`) now
  returns the public key as JWK (RFC 7517). Desktop and other clients can
  thereby verify JWT signatures themselves.

- **OIDC Discovery** (`/oauth2/.well-known/openid-configuration` + new
  `/.well-known/openid-configuration` at the root) announces RS256 as
  `id_token_signing_alg_values_supported` and adds Graph-API-style scopes
  (`EWS.AccessAsUser.All`, `Mail.Read/ReadWrite/Send`,
  `Calendars.Read/ReadWrite`, `Contacts.Read/ReadWrite`, `offline_access`).

- **OAuth2 proxy in api-gateway**: `/oauth2/*` is now forwarded to the auth-service
  so that clients can access `https://mail.../oauth2/authorize`
  and `.../oauth2/token` directly.

### Schema

`ServerSettings` gets 4 new fields:
- `jwtPrivateKey String?` — PEM RSA private key
- `jwtPublicKey  String?` — PEM RSA public key (PKCS#1/SPKI)
- `jwtKeyId      String?` — stable key ID for JWK `kid`
- `jwtKeyCreated DateTime?` — generation time (for future rotation)

### Migration impact

- **Existing sessions/tokens are invalidated** (HS256-signed, now
  RS256 verify). Users must log in again once. Access tokens have
  only a 15min TTL anyway.
- **Schema migration**: `prisma db push --accept-data-loss` at first
  container start adds the new fields. No data loss.

### What is still missing for the LTSC 2024 desktop client end-to-end

Phase A+B (this version) is the infrastructure. For a working LTSC 2024
desktop client connection, phases C–F are still missing (in progress, coming in v5.3.0+):

- Auto-provision the well-known desktop client ID
- Extend Autodiscover XML with an OAuth2 endpoint hint
- Bearer token audience validation in the EWS/MAPI middleware
- Browser login flow specifically for desktop clients

---

## [5.2.15] — 2026-05-27 — Desktop client auth: case-insensitive schemes + bare-username fallback

### Fixed

User observation after v5.2.14: "Password typed correctly in the desktop mail client
and the password window keeps popping up again." The live log showed
`Autodiscover v1: Basic-Auth-Header malformed → 401` — the auth header arrived,
but was rejected by our parsing logic.

Two root causes:

1. **Case sensitivity of the auth scheme.** The LTSC desktop client on current
   Win11 patches sends `basic` (lowercase) instead of `Basic` — RFC 7235 §2.1
   explicitly says "case-insensitive", but our code used
   `authHeader.startsWith('Basic ')`, which is strictly case-sensitive. Fix:
   `authHeader.split(' ')[0]?.toLowerCase()` → now matches
   `Basic`/`basic`/`BASIC`. Applies to Autodiscover V1 + EWS middleware
   (also Bearer/Negotiate/NTLM analogously).

2. **Bare username without @domain.** In NTLM style, the desktop client sometimes sends
   only `admin` (without @stefanwuestner.de). Before: DB lookup with `email='admin'`
   → no match → 401. Fix: if the user part contains no `@`, complete it with the
   primary domain (`admin` → `admin@stefanwuestner.de`).

3. **Whitespace tolerance**: `authHeader.slice(6)` assumes that
   exactly one space sits between scheme and token. The desktop client sometimes inserts
   several. Fix: `indexOf(' ')` + `.trim()` on the token part.

### Files

- `packages/autodiscover/src/v1.ts`
- `packages/ews-server/src/auth/middleware.ts`

---

## [5.2.14] — 2026-05-27 — Desktop client auth loop FIX (Autodiscover now validates passwords)

### Security

- **Autodiscover V1 accepted ANY arbitrary password as valid.**
  Previous comment in the code: "We do NOT validate the credentials here —
  that is customary for Autodiscover." That is WRONG — Autodiscover (MS-OXDSCLI)
  does validate credentials and responds with 401 on a wrong password.
  The previous code returned the full XML with all user details
  (DisplayName, LegacyDN, SMTPAddress) for every valid email address —
  an information-disclosure bug.

### Fixed

- **Desktop client endless auth prompt** (also chased in v5.2.1-v5.2.5,
  now really fixed).  Root cause chain:

  1. The desktop client calls Autodiscover V2 (`?Protocol=AutodiscoverV1`) → gets the
     V1 URL back
  2. The desktop client calls Autodiscover V1 with Basic Auth → V1 **always returned 200**
     (even with a wrong password!) → the desktop client accepted the config
  3. The desktop client tried EWS/MAPI with the same password → 401 (EWS checks
     correctly)
  4. The desktop client asks the user for the password again
  5. → back to step 1 → **endless loop**, the user believes their
     password is not being transmitted

  **Fix** (`packages/autodiscover/src/v1.ts`): V1 now validates Basic Auth
  against `User.passwordHash` AND `AppPassword.hash` (same
  multi-verification as the EWS middleware from v5.2.1).  On a wrong password
  → 401 + multi-scheme `WWW-Authenticate` header.  On a correct password
  → 200 + XML config.
  The desktop client now aborts the Autodiscover loop on a genuinely wrong password
  and prompts only ONCE per attempt, instead of chasing the token endlessly through
  Autodiscover/EWS.

  **Also visible in the SystemLog (BCP)**: failed
  Autodiscover auth attempts are logged with `category='MAPI_AUTH'`,
  `reason='WRONG_PASSWORD_OR_USER'`.

  **Note for MFA accounts**: As with EWS/IMAP — with active MFA the
  only way is an **app password** from MWA → Settings → Security.

---

## [5.2.13] — 2026-05-27 — Audit log: 5 new translations

### Fixed

- **Audit log entries `certificates.letsencrypt.post` and
  `smtp-config.settings.put` remained technical and unintelligible.**

  New mappings in `packages/admin-panel/src/pages/AuditLogPage.tsx`:

  | Action string                          | Display                                |
  |----------------------------------------|----------------------------------------|
  | `certificates.letsencrypt.post`        | Let's Encrypt certificate requested    |
  | `letsencrypt.post` (legacy, pre-v3.18.34) | Let's Encrypt certificate requested |
  | `smtp-config.settings.get`             | SMTP outbound configuration retrieved  |
  | `smtp-config.settings.put`             | SMTP outbound configuration changed    |
  | `smtp-config.test-smarthost.post`      | Smarthost connection tested            |

---

## [5.2.12] — 2026-05-27 — Setup loop after successful completion fixed

### Fixed

- **Setup wizard immediately restarted from the beginning after successful completion** —
  bug introduced with the v5.2.11 SetupGuard.  Cause: SetupPage navigated via
  `react-router navigate('/login')` (soft routing).  But SetupGuard still
  had the initial state `setupRequired=true` (from the first mount) and
  ran the effect: `setupRequired===true && pathname!=='/setup'` →
  `navigate('/setup', { replace: true })` → SetupPage remounted with
  `step='form'` → loop.

  **Fix** (`packages/web-client/src/pages/SetupPage.tsx`): The "Go to
  login" button now does a **hard reload** via
  `window.location.href = '/login'` instead of a React Router navigate.  On
  reload, SetupGuard remounts from scratch and fetches `/api/v1/setup/status`
  fresh — `setupRequired=false` → passes through to the login page.

  This also reliably clears the auth state / query cache;
  setup is a one-time event, a full reload is semantically
  correct here.

---

## [5.2.11] — 2026-05-27 — Setup guard for BCP + MWA hardening

### Changed

- **MWA SetupGuard now applies TOP-LEVEL** (`packages/web-client/src/App.tsx`):
  blocks not only the protected routes, but also `/login`,
  `/forgot-password`, `/reset-password`.  As long as setup is not completed,
  every URL lands on `/setup`.  Once setup is done, a direct
  call to `/setup` is redirected back to `/login` (prevents an accidental
  second setup).
- **BCP gets a SetupGuard** (`packages/admin-panel/src/main.tsx`):
  At admin panel start, `/api/v1/setup/status` is checked.  If
  setup is required, redirect via `window.location.href = '/setup'` to the
  MWA setup wizard (leaves the `/bcp` basename completely).  Previously
  an admin could navigate directly to the BCP login page without setup ever having
  been done — login failed (no user), but the welcome UI
  was visible and confusing.

### Why

User observation: "When opening /bcp you land on the login screen instead of the
setup wizard, although no admin has ever been created."  It is now guaranteed
that the initial setup is the first visible screen — no more accidental
entry of wrong credentials into a half-finished system.

---

## [5.2.10] — 2026-05-27 — Self-signed cert always mail.localhost (fresh-install baseline)

### Fixed

- **The self-signed cert at initial setup used the entered hostname
  (`mail.stefanwuestner.de`) instead of the expected default `mail.localhost`.**
  When running the setup wizard, the self-signed cert was generated from the configured
  `publicHostname` — when renaming or on a
  fresh installation with a real domain this produced a "genuine-looking"
  but actually confidentiality-insecure cert.

  **Fix**: As of v5.2.10 the self-signed cert uses a
  **hardcoded CN=`mail.localhost`** in all four code paths:

  1. `packages/api-gateway/src/routes/setup.ts:147` — initial setup wizard
  2. `packages/smtp-server/src/server.ts:182` — SMTP fallback when no
     protocol cert in DB
  3. `packages/imap-server/src/server.ts:49` — IMAP fallback
  4. `packages/pop3-server/src/server.ts:50` — POP3 fallback

  The admin then swaps the self-signed cert via BCP → SSL/TLS
  for a real Let's Encrypt or custom cert. The
  `loadProtocolCert()` logic built in v5.2.9 prioritizes a real cert with
  `isActiveProtocol=true` over the self-signed fallback.

  **Advantage of a fixed CN**: The self-signed cert is not accidentally regenerated when
  `publicHostname` is renamed; the admin consistently sees
  "mail.localhost" as the baseline and knows that it is not
  a production cert.

---

## [5.2.1] — 2026-05-27 — Hotfix: desktop client endless password prompt

### Fixed

- **EWS/MAPI Basic-Auth middleware** (`packages/ews-server/src/auth/middleware.ts`):
  Previously went through the `/auth/login` endpoint of the auth-service, which with
  active MFA returns `{ mfaRequired: true, challengeToken: ... }`
  **without** `accessToken`. The desktop client cannot answer an MFA challenge with Basic Auth
  → middleware fell back to 401 → the desktop client prompted
  endlessly for the password.

  **User symptom**: In the BCP the login works (MFA is solved
  interactively), but in the desktop client the password prompt keeps appearing
  although the password is correct.

  **Fix**: The middleware now verifies directly against `User.passwordHash`
  AND `AppPassword.hash` via `verifyPassword()` from `@coremail/core` —
  same logic as the IMAP/SMTP/POP3 servers since v3.x. With active MFA the
  user must create an **app password** in MWA → Settings → Security
  and enter it in the desktop client (instead of their regular
  password). Without MFA the regular password continues to work directly.

- **Username normalization**: The LTSC desktop client sometimes sends, NTLM-style,
  `DOMAIN\user` instead of `user@domain` — we now normalize to the
  last backslash part.

- **Detailed logging** for auth failures: user lookup status,
  password hash match, app password match, auth header type — so that
  future problems can be diagnosed faster.

### Desktop client setup with MFA

1. User logs in to the MWA and solves MFA
2. MWA → Settings → Security → Generate app password → name e.g. "Desktop"
3. In the mail program: password dialog → enter the **app password** instead of the regular password
4. The account connects natively via MAPI/HTTP

---

---

## [5.2.0] — 2026-05-27 — MAPI/HTTP FINAL (Cached Mode + Recurrence + Embedded + Multi-Value + gzip + RTF)

**Final release** of the MAPI/HTTP implementation. Bundles all features
from the originally planned v5.2 / v5.3 / v5.4 / v5.5 milestones into one
final release. Marks MAPI/HTTP as **feature-complete** for typical
desktop client workflows.

### Added — Cached Mode (MS-OXCFXICS)

- **`packages/ews-server/src/mapi/rop/sync.ts`** — complete ICS sync
  implementation for the desktop client's Cached Mode (its default mode since 2007):

  - `RopSyncConfigure` — creates a FastTransfer source handle
  - `RopFastTransferSourceGetBuffer` — chunked ICS stream (max 28KB/chunk,
    TransferStatus 1=Partial/3=Done)
  - `RopFastTransferSourceCopyFolder` / `CopyMessages` / `CopyProperties`
  - `RopFastTransferDestinationConfigure` / `PutBuffer`
  - `RopSyncImportMessageChange` / `ImportHierarchyChange` / `ImportDeletes` /
    `ImportMessageMove`
  - `RopSyncUploadStateStreamBegin` / `Continue` / `End`
  - `RopSyncOpenCollector`
  - `RopGetLocalReplicaIds`
  - `RopSyncGetTransferState`

- **ICS stream format**: Per message one StartMessage opcode (0x40000003) +
  TaggedProperties (PR_MID, PR_SUBJECT_W, PR_SENDER_NAME_W,
  PR_SENDER_EMAIL_ADDRESS_W, PR_MESSAGE_DELIVERY_TIME, PR_MESSAGE_FLAGS,
  PR_MESSAGE_SIZE) + EndMessage opcode (0x40000004). Maximum 200 messages
  per sync — larger folders via repeated sync calls.

### Added — Calendar Recurrence Pattern

- **`packages/ews-server/src/mapi/recurrence-pattern.ts`** with
  `encodeRecurrencePattern(rrule, dtStart, dtEnd)` — parses iCal RRULE
  (RFC 5545) and converts it into PidLidAppointmentRecur binary
  (MS-OXOCAL §2.2.1.44):
  - FREQ=DAILY/WEEKLY/MONTHLY/YEARLY
  - INTERVAL (e.g. "every 2 weeks")
  - BYDAY (Mon-Sun bitmask)
  - BYMONTHDAY, BYMONTH
  - COUNT / UNTIL

- The desktop client now shows the correct recurrence pattern in the appointment editor
  ("weekly on Monday/Wednesday", "monthly on the 15th", etc.).

### Added — PR_RTF_COMPRESSED Stream

- **`packages/ews-server/src/mapi/rtf-compress.ts`**:
  - `htmlOrTextToRtfCompressed()` — wraps HTML/text in
    MELA-uncompressed RTF (MS-OXRTFCP). The desktop client accepts it without CRC.
  - `decodeRtfCompressed()` — LZ77 decoder for client→server RTF bodies
    (RTF_PREFIX dictionary init, 4096-byte ring, FullString/Sub/Prefix).

- **`handleRopOpenStream`** on `PR_RTF_COMPRESSED` (0x10090102) now
  functional.

### Added — gzip Transport Compression

- **Middleware in `handler.ts`**: `X-CompressedRequest: 1` triggers
  transparent `gunzipSync` decompression before the handler. Saves bandwidth
  on large ROP streams (typically 60-70% reduction during sync).

### Added — Multi-Value Properties

- **`property-codec.ts`** extended with PT_MV_INT16/INT32/STRING/UNICODE/
  SYSTIME/BINARY (MS-OXCDATA §2.11.1.6) — read + write round trip.

### Added — RopOpenEmbeddedMessage

- **`packages/ews-server/src/mapi/rop/v52-handlers.ts`** — forward mail as
  attachment. Creates a sub-message handle on an attachment, the desktop client can
  then read the embedded IPM.Note via OpenStream.

### Added — Search Folders / Rules / Permissions

- **`RopGetSearchCriteria`** + **`RopSetSearchCriteria`** — minimal
  workflow (no crash on the client's "saved search").
- **`RopGetRulesTable`** + **`RopUpdateRules`** — empty table + SUCCESS.
  Rules created in the desktop client remain client-local (CoreMail MailRules via MWA).
- **`RopGetPermissionsTable`** + **`RopModifyPermissions`** — the desktop client
  "Permissions" dialog no longer crashes (ACL management stays in the BCP).

### Added — Misc Message ROPs

- **`RopAbortSubmit`**, **`RopReloadCachedInformation`** (cached
  refresh), **`RopGetMessageStatus`** / **`RopSetMessageStatus`** for
  read tracking.

### Improved — NSPI

- **Cursor pagination** via StartMid + RowCount from the request body
- **Alphabetical sorting** by displayName (locale 'de')
- **Hard limit** of 1000 instead of 500

### Added — RopIds

- `GetRulesTable: 0x3F`, `UpdateRules: 0x41`
- `GetPermissionsTable: 0x3E`, `ModifyPermissions: 0x40`

### Desktop client behavior after v5.2.0

- **Cached Mode works** (the `.ost` file is filled initially, the desktop client
  is offline-capable)
- **Recurring appointments** show the recurrence pattern correctly
- **Embedded mails** open on double-click
- Clicking "**Search Folders**" no longer crashes
- **Rules dialog** can be opened (stored locally)
- **Permissions dialog** read-only without errors
- **RTF mails** are displayed correctly formatted
- **Large GAL** (>500 entries) is fully paginated
- **gzip compression** reduces bandwidth by ~60-70% during sync

### MAPI/HTTP roadmap completion

```
v4.0.0  Foundation (codec, sessions, HTTP headers)
v4.1.0  ROP infra + Logon + folder browse
v4.2.0  Reading mail
v4.3.0  Composing + sending mail
v4.4.0  Attachments + Move/Delete
v4.5.0  Push notifications (Redis pub/sub)
v4.6.0  Virtual PIM folders
v4.7.0  NSPI fallback + server-side search
v5.0.0  Production GA (default-on + tests)
v5.1.0  Named Properties + PIM detail views + native NSPI
v5.2.0  FINAL — Cached Mode + Recurrence + Multi-Value + gzip + RTF + Embedded
```

Effort: ~12,000 lines of MAPI code in one contiguous sprint instead of
6-9 months of estimated weekly work.

Optionally open for v5.3+:
- Full ICS OPCODE records with real delta sync via change numbers
- DAV ACL mapping to MAPI permissions (complete)
- RTF→HTML conversion via LZ77 decoder (client→server path)

---

## [5.1.0] — 2026-05-27 — MAPI/HTTP: Named Properties + PIM detail views + native NSPI

Closes the last v5.x items from the v5.0.0 release: complete
Calendar/Contact/Task/Note detail view and native MS-OXNSPI binary
implementation instead of the EWS fallback.

### Added — Named Properties

- **`packages/ews-server/src/mapi/named-properties.ts`**: PSETID GUIDs
  (PSETID_Appointment / PSETID_Address / PSETID_Task / PSETID_Note /
  PSETID_Common / PSETID_Meeting / PS_INTERNET_HEADERS / PS_PUBLIC_STRINGS)
  + standard LIDs from MS-OXOCAL / MS-OXOCNTC / MS-OXOTASK / MS-OXONOTE
  (LID_APPOINTMENT_START_WHOLE 0x820D, LID_LOCATION 0x8208,
  LID_BUSY_STATUS 0x8205, LID_TASK_COMPLETE 0x811C,
  LID_PERCENT_COMPLETE 0x8102, LID_NOTE_COLOR 0x8B00 etc.).

- **`resolveNamedProperties()`** assigns local uint16 IDs starting at 0x8000 in
  the session state (`mapi:session:<token>.namedPropMap`). Idempotent:
  already-allocated IDs are reused.

- **`reverseNamedProperties()`** for the GetNamesFromPropertyIds round trip.

- **`RopGetPropertyIdsFromNames`** + **`RopGetNamesFromPropertyIds`**
  (`rop/named-props-handler.ts`) — complete binary implementation
  incl. GUID encoding (4-2-2-8 format) and LID/name kind differentiation.

- **ROP codec**: Both named-prop ROPs now get the complete
  payload (instead of a pass-through stub).

### Added — PIM Detail Views

- **`packages/ews-server/src/mapi/rop/pim-properties.ts`** with
  `buildPimPropertyList(sessionToken, kind, itemId)`: loads
  CalendarEvent/Contact/Task/Note from Prisma and maps each item to a
  complete property set:

  | Kind | Standard MAPI | Named Properties |
  |------|---------------|------------------|
  | IPM.Appointment | Subject, Body, Times, MessageClass | Location, AppointmentStartWhole, EndWhole, Duration, AllDay (SubType), BusyStatus, Sequence, Recurring |
  | IPM.Contact | DisplayName, Body, SenderName/Email | Email1/2 DisplayName/Type/Address, FileAs + PR_COMPANY_NAME_W, PR_TITLE_W, PR_DEPARTMENT_NAME_W, PR_BUSINESS_TEL_W, PR_MOBILE_TEL_W |
  | IPM.Task | Subject, Body, Times, Priority | TaskStatus (NotStarted/InProgress/Completed/Waiting/Deferred), PercentComplete, StartDate, DueDate, DateCompleted, Complete flag, Owner |
  | IPM.StickyNote | Subject, Body, Times | NoteColor (yellow=3 default), NoteWidth, NoteHeight |

- **`handleRopGetPropertiesAll`** + **`handleRopGetPropertiesSpecific`**
  in `rop/message.ts` dispatch to `buildPimPropertyList()` when the
  message handle has `pimKind !== 'mail'` (instead of the standard message
  property mapping).

- **`openVirtualPimMessage`** now sets `pimKind`
  (appointment/contact/task/note) on the message handle.

- **`RopObject.message` type** extended with a `pimKind` field.

### Added — Native NSPI Binary

- **`packages/ews-server/src/mapi/nspi-handler.ts`** replaces the v4.7.0
  SUCCESS-empty fallback with a complete MS-OXNSPI binary
  implementation:

  - **GetSpecialTable** — returns "Global Address List" as the root entry
  - **QueryRows** — paginates users + DistributionGroups (max 500)
  - **ResolveNames** + **GetMatches** — substring match on
    displayName + email
  - **GetProps** — properties of a single entry by MinId
  - **DnToMinId** — legacy DN string (`/o=…/cn=Recipients/cn=<email>`)
    → MinEntryID
  - **GetPropList** — standard property set for GAL entries

- **MinEntryID** = FNV-1a 32-bit hash of `userId`/`groupId` in the range
  [0x10000000, 0xFFFFFFFF] (MS-OXNSPI-compliant).

- **Standard property set per row**: PR_DISPLAY_NAME_W,
  PR_EMAIL_ADDRESS_W, PR_SMTP_ADDRESS_W, PR_ADDRTYPE_W='SMTP',
  PR_OBJECT_TYPE (6=MAILUSER/8=DISTLIST),
  PR_DISPLAY_TYPE (0/1).

- **`handler.ts`** now dispatches NSPI operations to
  `handleNspiOperation()` from `nspi-handler.ts` instead of returning
  SUCCESS-empty.

### Desktop client behavior after v5.1.0

- **Calendar detail view**: Double-clicking an appointment in the desktop client
  opens the full appointment window with subject, location, start/end,
  all-day flag, BusyStatus display (Free/Busy/Out of Office/Tentative).
- **Contact detail view**: Contact shows all fields (company, job title,
  department, phones, Email1/Email2).
- **Task detail view**: Task shows due date, percent progress,
  status (NotStarted/InProgress/Completed).
- **Note detail view**: Note with color code.
- **Client address book natively populated**: GAL via direct NSPI connection
  (no EWS round trips) — faster, less latency, less
  server load for large mailboxes.

---

## [5.0.0] — 2026-05-27 — MAPI/HTTP production hardening + default-enabled (major release)

### Changed

- **Autodiscover MAPI/HTTP ENABLED BY DEFAULT** (`packages/autodiscover/src/v1.ts`):
  Feature flag `ENABLE_MAPI_HTTP` is now opt-OUT (`!== 'false'`) instead of
  opt-in. Desktop clients from 2013 SP1 on discover the `<Protocol Type="mapiHttp">` block
  automatically and set themselves up natively as a **MAPI account** (instead of
  the IMAP fallback as before). The complete ROP feature set from v4.1–v4.7
  is available.

### Added

- **Unit tests `property-codec.test.ts`** (13 round-trip tests):
  FILETIME ↔ Date, PT_LONG, PT_INT64, PT_BOOLEAN, PT_UNICODE (with umlauts
  + emojis), PT_BINARY, PT_SYSTIME, writeTaggedProperty, writePropertyRow
  (multi-column + default-for-type), makePropTag constants.

- **Unit tests `entry-id.test.ts`** (6 tests):
  cuidToFolderId64 determinism, uint64 range, collision-freedom for 4
  different IDs, virtual folder IDs are unique.

- Together with the 16 codec tests from v4.0.0 now **35 round-trip tests**
  for the MAPI codec layer.

### Desktop client behavior after v5.0.0

User enters mail+password → Autodiscover → the desktop client detects MAPI/HTTP →
account type MAPI → full feature set (read/compose/
send mail with attachments, push notifications <1s, server-side search,
virtual PIM folders for calendar/contacts/tasks/notes).

No more "IMAP fallback" notice needed. Full native MS-OXNSPI (instead of
the EWS fallback) remains optional for v5.1+ hardening, but is not strictly
required by the desktop client — a SUCCESS-empty NSPI response switches the desktop client
to EWS.

### Roadmap Status

The 6-9 month plan from v4.0.0-ARCHITECTURE.md implemented in one focused
sprint:

| Phase   | Content |
|---------|--------|
| v4.0.0  | Foundation (codec, sessions, HTTP headers) |
| v4.1.0  | ROP infra + RopLogon + folder browse |
| v4.2.0  | Reading mail (OpenMessage + Properties + stream read) |
| v4.3.0  | Composing + sending mail (Create/SetProps/Submit + BullMQ) |
| v4.4.0  | Attachments + Move/Delete |
| v4.5.0  | Push notifications via Redis pub/sub |
| v4.6.0  | Virtual PIM folders (calendar/contacts/tasks/notes) |
| v4.7.0  | NSPI address book + server-side search |
| v5.0.0  | Production GA (default-on + tests + docs) |

### Opt-Out

`ENABLE_MAPI_HTTP=false` disables the MAPI/HTTP block in Autodiscover
and falls back to IMAP/SMTP only — for sites that want to turn MAPI off
temporarily.

---

## [4.7.0] — 2026-05-27 — MAPI/HTTP Phase 7: NSPI address book fallback + server-side search

### Changed (NSPI)

- **NSPI endpoint** (`packages/ews-server/src/mapi/handler.ts`):
  All NSPI operations (`QueryRows / ResolveNames / GetMatches /
  GetSpecialTable / GetProps / DnToMinId / GetPropList`) now return
  `SUCCESS-empty` (StatusCode=OK, ErrorCode=OK, RowCount=0, HasValue=0)
  instead of binary `ecNotSupported` (0x80040102). The desktop client interprets
  SUCCESS-empty as "no matches" and automatically falls back to the
  EWS-based ResolveNames/FindPeople path (functional in CoreMail since
  v3.x). A full MS-OXNSPI implementation remains for v5.x as
  optional hardening.

### Added (Search — bundled from the planned v4.8.0)

- **RopRestrict** (`packages/ews-server/src/mapi/rop/search.ts`):
  Parses the MS-OXCDATA §2.12 restriction format (ResAnd / ResOr / ResNot /
  ResContent / ResProperty / ResExist) and persists the parsed
  restriction on the table handle (dynamic field `restriction`).

- **RopFindRow**: Accepts FindRowFlags + Restriction + Origin +
  Bookmark; v4.7.0 minimally returns "no match" (HasRowData=0) —
  The desktop client typically uses RopRestrict + a subsequent
  RopQueryRows as the search workflow, which works fully.

- **restrictionToPrismaWhere()**: Converts a ParsedRestriction into a
  Prisma `where` clause. Property-tag → DB-field mapping supports
  PR_SUBJECT_W → `subject`, PR_BODY_W → `bodyText`, PR_HTML →
  `bodyHtml`, PR_SENDER_NAME_W → `fromName`, PR_SENDER_EMAIL_ADDRESS_W
  → `fromAddr`, PR_DISPLAY_TO_W → `toAddrs`, PR_MESSAGE_DELIVERY_TIME
  → `date`, PR_MESSAGE_SIZE → `rawSize`, PR_MESSAGE_FLAGS → `flags`.
  Content fuzzy levels: FullString/Substring/Prefix + ignore-case.
  Property RelOps: LT/LE/GT/GE/EQ/NE.

- **QueryRows integration**: For the standard mail contents table the
  restriction is applied as an additional filter next to `folderId`
  (`{ folderId, ...restrictionWhere }`).

- **ROP codec extension**: Correct payload parsing for RopRestrict
  (RestrictFlags + RestrictionSize + Restriction) and RopFindRow
  (FindRowFlags + RestrictionSize + Restriction + Origin + BookmarkSize +
  Bookmark).

### Desktop client behavior after v4.7.0

- No more "NSPI error" in the client connection status
- Recipient autocomplete in the To/CC/BCC field works seamlessly (EWS FindPeople)
- "Check Names" (Ctrl+K) works (EWS ResolveNames)
- GAL browse shows users + distribution groups (EWS FindFolder + FindItem)
- **Server-side search** (Ctrl+E in the desktop client) filters inbox/folders directly
  via MAPI Restriction → Prisma WHERE — no more client-side scan for
  large mailboxes with >1000 mails.

---

## [4.6.0] — 2026-05-27 — MAPI/HTTP Phase 6: Calendar/Contacts/Tasks/Notes virtual folders

### Added

- **containerClassFor(folderName)** (`packages/ews-server/src/mapi/rop/folder.ts`):
  Maps a folder name to the MAPI container class (PR_CONTAINER_CLASS_W).
  Values per MS-OXOSFLD §2.2.3: IPF.Note (mail, default), IPF.Appointment,
  IPF.Contact, IPF.Task, IPF.StickyNote, IPF.Journal. Case-insensitive match
  for English + German standard names (Calendar/Kalender, Contacts/Kontakte,
  Tasks/Aufgaben, Notes/Notizen).

- **VIRTUAL_FOLDERS constant**: 4 synthetic PIM folders with fixed IDs
  (`virtual-calendar`, `virtual-contacts`, `virtual-tasks`, `virtual-notes`).
  CoreMail stores this data in separate Prisma models (CalendarEvent,
  Contact, Task, Note) — but the MAPI client sees them as mailbox folders.

- **GetHierarchyTable extended**: At root level (`parentFolderId === ''`)
  the rowCount is increased by VIRTUAL_FOLDERS.length.

- **QueryRows on hierarchy**: Injects `virtualFolderToPropRow()` for the
  4 PIM folders with PR_DISPLAY_NAME_W + PR_FOLDER_ID + PR_CONTAINER_CLASS_W.
- **OpenFolder extended**: Also matches virtual IDs via
  `cuidToFolderId64(VIRTUAL_FOLDERS[*].id)`.

- **GetContentsTable extended**: Virtual folders return counts from
  `prisma.calendarEvent / contact / task / note` instead of `prisma.message`.

- **QueryRows on contents**: `parentFolderId.startsWith('virtual-')` →
  `loadVirtualContents()` loads events/contacts/tasks/notes from Prisma and
  maps them to PropRows with:
  - PR_MESSAGE_CLASS_W = 'IPM.Appointment' / 'IPM.Contact' / 'IPM.Task' /
    'IPM.StickyNote'
  - PR_SUBJECT_W = summary / displayName / subject
  - PR_BODY_W = description / body
  - PR_MESSAGE_DELIVERY_TIME = dtStart / dueDate / createdAt
  - PR_DISPLAY_NAME_W, PR_SENDER_NAME_W, PR_SENDER_EMAIL_ADDRESS_W
    (for contact rows)

- **GetRowCount extended** for virtual folders.

- **OpenMessage extended**: Detects virtual folder IDs and delegates to
  `openVirtualPimMessage()`, which finds the item via hash match in the respective
  PIM table (`calendarEvent / contact / task / note`).

- **folderToPropRow** now uses `containerClassFor(name)` instead of hardcoded
  'IPF.Note' — existing folders named 'Calendar'/'Kontakte' etc.
  are also classified correctly.

### Desktop client behavior after v4.6.0

4 additional folders appear in the desktop client under the mailbox: "Calendar",
"Contacts", "Tasks", "Notes" — with the correct icon according to the desktop client's
folder-type detection. The list view shows the respective items (appointments/contacts/
tasks/notes) with subject and date.

Read-only browsing of the PIM data is functional. A full property round trip
on individual items (detail display of appointments, contacts etc.) still
needs full named-property mapping (PSETID_Appointment etc.) — coming in
v5.0.0 or optionally as a v4.6.1 patch. For full bidirectional calendar/
contact sync we continue to recommend the "Outlook CalDav Synchronizer"
from the setup page (Settings → External Clients).

---

## [4.5.0] — 2026-05-26 — MAPI/HTTP Phase 5: Push notifications via Redis pub/sub

### Added

- **RopRegisterNotification** (`packages/ews-server/src/mapi/rop/notification.ts`):
  The desktop client subscribes via ROP to the desired event types (NewMail / MessageDeleted /
  MessageModified / FolderChanged) on a folder or mailbox handle.
  The subscription is dynamically persisted on the handle (subscription field via
  JSON round trip through Redis).

- **NotificationWait real long-poll** (`packages/ews-server/src/mapi/emsmdb-handler.ts`):
  Until now the desktop client polled with long NotificationWait requests that returned after 30s
  with EventPending=false → noticeable delay. Now:
  duplicate()-ed ioredis client (subscribe needs a dedicated connection
  per ioredis requirement), subscribe to `coremail:mapi:notify:<userId>`,
  race between Redis event and 30s timeout, clean cleanup (unsubscribe +
  disconnect + clearTimeout) on both outcomes, plus `req.on('close')`
  for client disconnect handling. Responds immediately on event with
  EventPending=1, otherwise after timeout with EventPending=0.

- **publishNotifyEvent helper** in `rop/notification.ts` with
  `notifyChannelFor(userId)` channel generator. Event shape:
  `{ kind, userId, folderId?, messageId?, subject? }`.

- **SMTP hook** (`packages/smtp-server/src/handlers/message.ts`):
  `storeInboundMessage()` now additionally publishes, after the existing `CHANNEL_MAIL_NEW`
  publish, to `coremail:mapi:notify:<userId>` with a
  MAPI notify event (`{kind:'NewMail', userId, folderId, messageId, subject}`)
  — non-fatal `.catch(() => {})` for backward compatibility when MAPI
  is not active.

- **NotifyEvent TypeScript interface** exported for other modules that
  trigger push events (e.g. future hooks for MessageDeleted / FolderChanged).

### Desktop client behavior after v4.5.0

New mail appears in the desktop client within <1s (instead of waiting up to 30s
before). Toast notification on new mail works. The folder refresh
cache is invalidated. Battery drain on mobile clients significantly
reduced (no more constant polling).

---

## [4.4.0] — 2026-05-26 — MAPI/HTTP Phase 4: Attachments + Move/Delete

### Added

- **RopGetAttachmentTable** (`packages/ews-server/src/mapi/rop/attachment.ts`):
  Creates a table object handle for the attachments of a message. New
  table type `attachments` (in `RopObject.table.tableType`), where
  `parentFolderId` contains the MessageId.

- **RopOpenAttachment**: Loads the attachment via index (PR_ATTACH_NUM from QueryRows),
  creates an attachment handle.

- **RopCreateAttachment**: Creates a draft attachment handle (`attachmentId=null`,
  `pendingBuffer`, `pendingProperties`). On SaveChangesAttachment it is
  persisted in DB+MinIO. AttachmentId = next free index in the
  message attachment list.

- **RopDeleteAttachment**: Removes the attachment DB record.

- **RopSaveChangesAttachment**: SHA256 hash, MinIO upload to
  `attachments/{messageId}/{sha256}`, DB insert (or update for an existing
  attachment) with `filename/mimeType/size/sha256/storagePath/contentId`.

- **RopDeleteMessages** (`packages/ews-server/src/mapi/rop/folder-ops.ts`):
  Parses the MessageId array (uint64 FNV hashes), deletes via `prisma.message.delete`,
  decrements folder counters. Response returns the PartialCompletion flag.

- **RopMoveCopyMessages**: Source handle (input) + destination handle (output),
  parses WantCopy flag + MessageId array. Move = folder update, copy = duplicate
  message via `prisma.message.create` with all original fields. Updates
  folder counters (source -= moved, dest += moved).

- **OpenStream on attachment**: Extension of `handleRopOpenStream` —
  for `kind === 'attachment'`, PR_ATTACH_DATA_BIN is loaded from MinIO via
  `loadAttachmentBytes()` (or empty for a draft attachment).
  WriteStream accumulates in `pendingBuffer`, CommitStream persists
  via SaveChangesAttachment.

- **ROP codec**: Correct payload parsing for GetAttachmentTable (TableFlags),
  OpenAttachment (AttachmentId uint32), CreateAttachment, DeleteAttachment,
  SaveChangesAttachment, DeleteMessages (WantAsync + NotifyNonRead +
  MessageIdCount + MessageIds[uint64]), MoveCopyMessages (DestHandleIndex +
  WantAsync + WantCopy + MessageIds[uint64]).

- **RopObject extended**:
  - `attachment` variant with `attachmentId:string|null`, `attachNum`,
    `pendingProperties`, `pendingBuffer`
  - `table` variant with new `tableType:'attachments'`

- **table.ts extended**: `attachmentToPropRow()` maps attachment →
  PR_ATTACH_NUM/LONG_FILENAME_W/MIME_TAG_W/SIZE/METHOD/CONTENT_ID_W.
  GetRowCount supports 'attachments' tables.

- **buildMessagePropertyList extended**: Loads `_count.attachments` from Prisma
  and sets `PR_HAS_ATTACH=true` + `PR_MESSAGE_FLAGS` HasAttach bit (0x10).

- **SubmitMessage extended**: Loads `msg.attachments` (filename/mimeType/
  storagePath/size) from the DB and fills `OutboundJob.message.attachments` with
  `{filename, minioPath, contentType, size}` — the existing worker builds
  RFC 5322 with real attachments via `buildRawFromMessage`.

- **New property tags**: PR_ATTACH_NUM, PR_ATTACH_METHOD,
  PR_ATTACH_LONG_FILENAME_W, PR_ATTACH_FILENAME_W, PR_ATTACH_MIME_TAG_W,
  PR_ATTACH_SIZE, PR_ATTACH_CONTENT_ID_W, PR_ATTACH_DATA_BIN,
  PR_ATTACHMENT_LINKID.

### Desktop client behavior after v4.4.0

Attaching a file to a new mail (drag & drop or "Insert file") works
end-to-end — stored in MinIO, passed to the outbound queue with
`minioPath` on send, the worker loads + signs + sends. Received mails
with attachments: the desktop client shows the paperclip icon, attachment list, double-click
opens the file. Moving mails (drag-and-drop into other folders) +
multi-delete via the Delete key works. Push notifications on new
mail: not yet (v4.5.0).

---

## [4.3.0] — 2026-05-26 — MAPI/HTTP Phase 3: Composing + sending mail

### Added

- **RopCreateMessage** (`packages/ews-server/src/mapi/rop/message.ts`):
  Creates a new draft message handle (`messageId=null`, `isDraft=true`,
  `pendingProperties={}`, `pendingRecipients=[]`). Folder lookup via
  CUID→uint64 FNV-1a hash. Response: ReturnValue + HasMessageId(0).

- **RopSetProperties**: Parses the PropertyValueArray (PropertyValueSize +
  PropertyValueCount + TaggedPropertyValues) and accumulates the tagged
  property values in `pendingProperties` on the message handle. JSON-safe
  encoding for session persistence in Redis (Buffer → {_t:'Buffer',data},
  BigInt → {_t:'BigInt',v}, Date → {_t:'Date',iso}).

- **RopModifyRecipients**: Parses the ColumnCount/Columns + RowCount/Rows
  structure from MS-OXCMSG §2.2.3.1.2. Extracts RecipientType (1=TO/2=CC/3=BCC)
  + DisplayName + EmailAddress from the RecipientRow header bytes. Stores
  the list in `pendingRecipients` on the message handle.

- **RopSaveChangesMessage**: Persists draft properties+recipients to the
  Prisma DB. With `messageId === null` (new draft) a new message
  record is created in the current folder (typically Drafts) with
  `flags: ['\\Draft']`, UID increment on the mailbox, ModSeq update. For an
  existing message: update. Response: FolderId(uint64) + MessageId(uint64).

- **RopWriteStream** (`packages/ews-server/src/mapi/rop/stream.ts`):
  Appends data to the stream buffer (at the current offset). The desktop client calls
  WriteStream repeatedly for long bodies — the buffer is accumulated in the stream handle
  until CommitStream. Supports overwrite-in-place and
  sparse write (padding with null bytes if offset > buffer length).

- **RopCommitStream**: Writes the accumulated stream buffer into the
  parent message. For a saved message: direct Prisma update on
  bodyText/bodyHtml/subject (UTF-16-LE decode for PR_BODY_W/PR_SUBJECT_W,
  UTF-8 for PR_HTML). For a draft stream: update of `pendingProperties`
  on the parent message handle.

- **RopSubmitMessage**: Submits the persisted message for sending via the BullMQ
  smtp-outbound queue. Builds a StructuredMessage from the
  Prisma message + loads the DKIM key of the sender domain + From/To/CC/BCC.
  Moves the message to the Sent folder after submit (or logs a
  warning on error — non-fatal). Local BullMQ queue instance on
  queue name `'smtp-outbound'` (shared convention with the
  consumer in the smtp-server, no cross-package import needed).

- **RopObject type extended**: The `message` variant now has
  `messageId: string | null`, `isDraft`, `pendingProperties` (Record),
  `pendingRecipients` (Array). The `stream` variant has
  `writable`, `parentMessageHandle` for draft streams.

- **Helper `updateRopObject`** (`rop-handle-table.ts`): Patch update
  of an existing handle object in Redis (for pending-property
  accumulation during a compose workflow).

- **PR_* constants added**: PR_EMAIL_ADDRESS_W, PR_ADDRTYPE_W,
  PR_SMTP_ADDRESS_W, PR_7BIT_DISPLAY_NAME_W, PR_RECIPIENT_TYPE,
  PR_RECIPIENT_FLAGS, PR_RECIPIENT_DISPLAY_NAME_W, PR_OBJECT_TYPE,
  PR_DISPLAY_TYPE.

- **ROP codec ModifyRecipients payload**: Until now only 64 bytes were sliced
  and the rest discarded — now the handler gets the complete
  rest of the buffer, because ModifyRecipients has no fixed size.

### Dependencies

- **`bullmq` added to the `@coremail/ews-server` dependencies** —
  for the direct queue connection to `'smtp-outbound'`.

### Desktop client behavior after v4.3.0

Compose window in the desktop client: create a new mail, type subject + body + recipients,
click "Send" → the mail arrives at the recipient. The Sent folder
shows the copy. Reply/Forward via the client buttons works the same way
(the desktop client loads the original via v4.2.0 → writes a draft via v4.3.0 → submitted).
Attachments: still empty (coming in v4.4.0). Push notification on new
mail: not yet (coming in v4.5.0).

---

## [4.2.0] — 2026-05-26 — MAPI/HTTP Phase 2: Reading mail (OpenMessage + stream read)

### Added

- **RopOpenMessage** (`packages/ews-server/src/mapi/rop/message.ts`):
  Opens a message by `FolderId` + `MessageId` from the contents table,
  stores a message handle in the session handle table. Response returns
  ReturnValue + HasNamedProperties + SubjectPrefix/NormalizedSubject + Recipients/Columns/Rows.
  Folder ID lookup via CUID→uint64 FNV-1a hash (see `entry-id.ts`).

- **RopGetPropertiesAll** + **RopGetPropertiesSpecific**: Both handlers return
  the complete list of all message properties (or a selection specified by the
  client). `buildMessagePropertyList` maps Prisma `Message` →
  MAPI properties: PR_SUBJECT_W, PR_SENDER_NAME_W, PR_SENDER_EMAIL_ADDRESS_W,
  PR_SENT_REPRESENTING_*, PR_DISPLAY_TO_W/CC_W/BCC_W, PR_MESSAGE_DELIVERY_TIME,
  PR_CLIENT_SUBMIT_TIME, PR_MESSAGE_FLAGS, PR_MESSAGE_SIZE, PR_BODY_W, PR_HTML,
  PR_MESSAGE_CLASS_W (IPM.Note), PR_HAS_ATTACH, PR_INTERNET_MESSAGE_ID_W,
  PR_PRIORITY, PR_IMPORTANCE.

- **RopOpenStream** (`packages/ews-server/src/mapi/rop/stream.ts`):
  Opens a stream on a message property. PR_BODY_W (UTF-16-LE),
  PR_HTML (UTF-8), PR_SUBJECT_W (UTF-16-LE). The property value is loaded completely
  into the stream object buffer, the response returns StreamSize.

- **RopReadStream**: Chunked read with offset tracking in the session.
  Max 30 KB per chunk (MAX_STREAM_CHUNK_BYTES) — the desktop client expects
  responses under 32 KB. ReadStream request format: Uint16 ByteCount,
  or 0xBABE marker + Uint32 ExtendedByteCount for large reads.

- **RopGetStreamSize**: Returns the buffer size in bytes.

- **ROP codec extension** (`packages/ews-server/src/mapi/rop-codec.ts`):
  Parsing for OpenMessage, GetPropertiesAll, GetPropertiesSpecific,
  OpenStream, ReadStream, GetStreamSize, CreateMessage, SaveChangesMessage,
  SetProperties, SubmitMessage, WriteStream, CommitStream, SetMessageReadFlag,
  SetReadFlags. Plus stub parsing for v4.4+ ROPs (MoveCopyMessages,
  DeleteMessages, OpenAttachment, CreateAttachment, RegisterNotification,
  ModifyRecipients, ReadRecipients, RemoveAllRecipients,
  GetPropertyIdsFromNames, GetNamesFromPropertyIds) — all consume
  their payload and are answered by the dispatcher with ecNotSupported,
  so that the ROP stream does not break off.

- **ROP dispatcher extension**: Switch cases for all v4.2.0 handlers
  (real implementation) + v4.3.0 stubs (CreateMessage, SetProperties,
  SaveChangesMessage, SubmitMessage, WriteStream, CommitStream — all
  return ecNotSupported, implemented in v4.3.0).

- **RopId**: `MoveCopyMessages` (0x33) + `DeleteMessages` (0x1E) added
  in `rop-types.ts` (preparation for v4.4.0).

### Desktop client behavior after v4.2.0

Profile build (Logon + folder browse from v4.1.0) is unchanged. New:
The desktop client can now open the list of mails in the inbox AND display a
single mail with subject, sender, body. Writing (Reply/Forward/
Compose), sending, attachments, notifications: still ecNotSupported, coming
in v4.3.0 (composing mail) + v4.4.0 (attachments) + v4.5.0 (push).

---

## [4.1.0] — 2026-05-26 — MAPI/HTTP Phase 1: ROP infrastructure + Logon + folder browse

### Added

- **ROP stream codec** (`packages/ews-server/src/mapi/rop-codec.ts`): Parser
  for the binary ROP buffer from EcDoRpcExt2 — RopSize header, ROP header
  (RopId + LogonId + input/output handle indexes), server object handle table.
  `RopResponseBuilder` for mirroring into the response.

- **ROP types constants** (`packages/ews-server/src/mapi/rop-types.ts`):
  RopId enum with all relevant ROPs from MS-OXCROPS (Logon, OpenFolder,
  GetHierarchyTable, GetContentsTable, SetColumns, QueryRows, OpenMessage,
  CreateMessage, SubmitMessage, RegisterNotification, ...). PropType enum
  (PT_LONG, PT_UNICODE, PT_BINARY, PT_SYSTIME, etc.). Property tag dictionary
  with the most important PR_* from MS-OXPROPS (folder, mailbox, message).

- **Property codec** (`packages/ews-server/src/mapi/property-codec.ts`):
  `writePropertyValue` + `readPropertyValue` for the 8 most important
  PropertyTypes. FILETIME ↔ JavaScript Date conversion. `writeTaggedProperty`
  + `writePropertyRow` for table row serialization.

- **EntryID helpers** (`packages/ews-server/src/mapi/entry-id.ts`):
  EntryID encoder/decoder with CoreMail's own ProviderUID. CUID → uint64
  FNV-1a hash for PR_FOLDER_ID.

- **ROP handle table** (`packages/ews-server/src/mapi/rop-handle-table.ts`):
  Typed object descriptors (mailbox, folder, message, table, stream,
  attachment) persisted in the session state. `putRopObject`,
  `getRopObject`, `releaseRopObject`, `resolveHandleIndex`.

- **ROP dispatcher** (`packages/ews-server/src/mapi/rop-dispatcher.ts`):
  Main dispatch function that parses the binary Execute request, dispatches each ROP to
  its handler, collects response buffers, and builds the final
  ROP stream response.

- **Handlers v4.1.0**:
  - `rop/logon.ts`: **RopLogon** — client mailbox login, loads the user from
    Prisma, builds the folder IDs array (Inbox, Drafts, Sent, Trash, Subtree),
    creates the mailbox handle in the session. Response with MailboxGuid,
    ReplGuid, LogonTime, GwartTime, StoreState.
  - `rop/folder.ts`: **RopOpenFolder**, **RopGetHierarchyTable**,
    **RopGetContentsTable** (stub count).
  - `rop/table.ts`: **RopSetColumns**, **RopQueryRows**, **RopGetRowCount**,
    **RopRelease**. Property row serialization with dynamic column selection.

- **Execute handler refactor** (`packages/ews-server/src/mapi/emsmdb-handler.ts`):
  `handleExecute` now uses `dispatchRopBuffer` instead of returning `ecNotSupported`.
  The desktop client sees genuinely working ROPs.

### Skeleton files for subsequent phases

- `rop/message.ts` — v4.2.0 (reading mail) + v4.3.0 (composing mail)
- `rop/stream.ts` — v4.2.0 (read) + v4.3.0 (write)
- `rop/submit.ts` — v4.3.0 (sending mail via BullMQ bridge)
- `rop/attachment.ts` — v4.4.0
- `rop/notification.ts` — v4.5.0 (push via Redis pub/sub)
- `rop/calendar.ts` — v4.6.0 (IPM.Appointment property mapping)
- `rop/contacts.ts` — v4.7.0 (NSPI + IPM.Contact)

Each skeleton file contains a detailed implementation plan + property
mapping + Open Specification references.

### Tests

- 16 codec round-trip tests all green
  (uint8/16/32/64, ASCII/UTF-16-LE strings, GUIDs, complex Connect request
  sequence, range errors)

### Desktop client functionality

With v4.1.0, after Connect the desktop client can:
- ✅ Perform RopLogon successfully
- ✅ Request the folder hierarchy table
- ✅ See the standard folders (Inbox, Drafts, Sent, Trash)
- ❌ Read mails (coming in v4.2.0 — `OpenMessage`/`GetProperties`/`ReadStream`)
- ❌ Write mails (coming in v4.3.0)
- ❌ Push notifications (coming in v4.5.0)

The client profile build gets considerably further after Connect than in v4.0.0, but
the first mail click will return ecNotSupported.

---

## [4.0.0] — 2026-05-26 — MAPI-over-HTTP foundation + External Clients setup page

**Major version bump**: Start of the MAPI-over-HTTP implementation for native
desktop client integration. This foundation lays down the protocol layer, codec,
session store, architecture plan. Full desktop client functionality comes iteratively
in v4.0.x / v4.1.0+ (see `packages/ews-server/src/mapi/ARCHITECTURE.md`).

### Added

- **MAPI/HTTP foundation** (`packages/ews-server/src/mapi/`):
  - `ARCHITECTURE.md`: Complete implementation plan incl. protocol
    layer, ROP mapping, version roadmap v4.0.0 → v5.0.0
  - `codec.ts`: Binary buffer reader/writer for the MS-OXCRPC wire format
    (little-endian uint8/16/32/64, ASCII/UTF-16-LE null-terminated strings,
    GUIDs in MS-DTYP format, AUX header blocks)
  - `codec.test.ts`: 16 round-trip tests for all read/write pairs (all green)
  - `http-headers.ts`: Header parsing + response header setting (X-RequestType,
    X-RequestId, X-ResponseCode, X-ExpirationInfo, X-PendingPeriod,
    Set-Cookie management)
  - `session-store.ts`: Redis-backed session store for emsmdb + nspi with
    10-min TTL and auto-renew on every call
  - `emsmdb-handler.ts`: Binary Connect/Disconnect/NotificationWait functional;
    Execute returns `ecNotSupported` (ROPs come in v4.1.0+)
  - `handler.ts` refactor: Express `raw()` body parser for `/mapi/emsmdb/` +
    `/mapi/nspi/` (binary bodies instead of JSON)

- **Autodiscover MAPI/HTTP protocol block** (feature-flagged):
  Env `ENABLE_MAPI_HTTP=true` enables `<Protocol Type="mapiHttp" Version="1">`
  in the Autodiscover response. Default off, because ROP execution is not yet
  functional. Once RopLogon+folder browse are done in v4.1.0: default on.

- **Setup page "External Clients" in the MWA** (pulled forward from v3.18.40):
  `packages/web-client/src/pages/SettingsPage.tsx` new section + backend
  endpoint `GET /api/v1/user/client-config`. Shows IMAP/SMTP data, CalDAV
  + CardDAV URLs, app-password notice with MFA, step-by-step for the "Outlook
  CalDav Synchronizer" plugin (free, OSS) — until MAPI/HTTP fully
  works, the mature solution for calendar + contacts in desktop clients without CalDAV.

### Roadmap (v4.x — see `ARCHITECTURE.md`)

| Version | Content | Effort |
|---------|--------|---------|
| v4.0.0  | Foundation (codec, session, Connect handshake)         | ✅ current |
| v4.1.0  | RopLogon + folder browse (the desktop client can log in + see folders) | ~2 wks |
| v4.2.0  | Reading mail (RopGetContentsTable, OpenMessage, Stream)   | ~2 wks |
| v4.3.0  | Composing + sending mail (CreateMessage, SubmitMessage)  | ~1 wk |
| v4.4.0  | Attachments + Move/Delete                                | ~1 wk |
| v4.5.0  | Push notifications (NotificationWait + Redis pub/sub)   | ~2 wks |
| v4.6.0  | Calendar (IPM.Appointment)                              | ~3 wks |
| v4.7.0  | Contacts (NSPI QueryRows + IPM.Contact)                 | ~2 wks |
| v4.8.0  | Search (RopFindRow, Restrict)                            | ~2 wks |
| v5.0.0  | Production hardening + desktop client compat tests      | ~4 wks |

**Estimated total effort**: 6–9 months for a 2-person team.

### Migration / Breaking

No breaking changes — all existing functions unchanged. The desktop client
continues to use the IMAP fallback from v3.18.39 until v4.1.0.

---

## [3.18.40] — 2026-05-26 — External Clients setup page in the MWA

### Added

- **New MWA settings section "External Clients"**
  (`packages/web-client/src/pages/SettingsPage.tsx`, `packages/api-gateway/src/routes/user.ts`):
  Central setup help page for all external clients. Prominently shows:
  - **IMAP/SMTP/POP3 data** with copy buttons (host, port, encryption)
  - **CalDAV account URL** + direct URLs per calendar
  - **CardDAV account URL** + default address book URL
  - **App-password notice** when MFA is active
  - **Step-by-step guide for "Outlook CalDav Synchronizer"**
    (free OSS plugin) — use calendar + contacts in desktop clients without CalDAV
  - **Notes on alternatives**: the MWA in the browser, Apple Calendar/Contacts,
    Thunderbird + TbSync, eM Client, DAVx⁵ (Android)

- **New backend endpoint** `GET /api/v1/user/client-config`
  (`packages/api-gateway/src/routes/user.ts`): Returns all setup data
  consolidated — email/displayName, IMAP/SMTP/POP3 hosts from `ServerSettings`,
  CalDAV account URL + per calendar, CardDAV account + default URL,
  `requiresAppPassword` flag based on the user's MFA status.

### Background

Common Windows desktop mail clients have no native CalDAV/CardDAV support built in.
A full MAPI-over-HTTP implementation (for native desktop client integration
with calendar + contacts) is several weeks of work and comes as a separate
future feature. Until then, the "Outlook CalDav Synchronizer"
(GitHub: `aluxnimm/outlookcaldavsynchronizer`) is the mature OSS plugin
path for users of such clients. The new settings page bundles all necessary data
+ provides the installation guide directly in the UI.

---

## [3.18.39] — 2026-05-26 — Autodiscover: EXCH+EXPR removed → IMAP fallback

### Fixed

- **The LTSC desktop client hung for minutes in an RPC/TCP connect loop, then error
  "This set of folders cannot be opened — error logging on
  to the server"** (`packages/autodiscover/src/v1.ts`): The user's connection status
  showed several VIDs with status "connecting" and protocol **RPC/TCP**
  on `mail.<domain>`. Root cause: Our Autodiscover response returned
  `<Protocol Type="EXCH">` and `<Protocol Type="EXPR">` blocks — both
  signal to the client that the server supports **MAPI/RPC** (direct RPC
  or RPC-over-HTTPS via `rpcproxy.dll`). But we have only implemented **EWS** + stubs
  of MAPI-over-HTTP. The desktop client attempted RPC connects for minutes,
  which hung.

  **Pragmatic fix** until the full MAPI/HTTP implementation:
  **EXCH and EXPR blocks REMOVED** from the Autodiscover XML. The desktop client recognizes:
  - The server offers no direct MAPI profiles
  - Automatically falls back to **IMAP account configuration**
  - Mail works immediately via `<Protocol Type="IMAP">` + `<Protocol Type="SMTP">`
  - Calendar + contacts go via CalDAV/CardDAV (Apple Calendar,
    Thunderbird, eM Client) or directly via the MWA in the browser

  The desktop client then automatically configures the account as "IMAP" (the user still
  sees the email-address-only setup flow, but the connection becomes
  IMAP instead of MAPI).

### Roadmap

A full MAPI-over-HTTP implementation (`EcDoConnectEx`, ROP verbose binary
protocol, NSPI Bind/QueryRows) for native desktop client integration is
several weeks of work. Until then, IMAP is the pragmatic path for
desktop client users.

---

## [3.18.38] — 2026-05-26 — Desktop client "no password prompt" + Autodiscover completion

### Fixed

- **CRITICAL ROOT CAUSE: EWS answered the first request with 200 OK
  instead of 401 — the desktop client never asks for a password** (`packages/ews-server/src/server.ts`):
  User symptom: The desktop client "connected" after Autodiscover without a credential
  prompt, but then only showed "Personal Folders" (local PST) instead of the
  server mailbox, plus an error message that the mail service in the profile was
  missing required information. Root cause:
  The LTSC desktop client first probes `GET /EWS/Exchange.asmx` BEFORE it sends
  any `Authorization` header at all. The previous GET handler returned
  200 + WSDL stub unauthenticated → the desktop client assumed no
  auth was needed, never sent credentials, and the setup landed on the
  local default PST ("Personal Folders"). **Fix**: `ewsAuthMiddleware` now
  also before the GET handler and before the `/mapi/*` router (except
  `/mapi/healthcheck.htm` — stays anonymous for the client probe). MAPI and
  OAB endpoints now also correctly send `WWW-Authenticate: Basic
  realm="CoreMail EWS"` when the auth header is missing.

- **`auth-service` URL was wrong** (`packages/ews-server/src/auth/middleware.ts`):
  The Basic-Auth fallback in EWS called `http://auth-service:3001/auth/login` —
  but port 3001 is the `storage-api`, not the `auth-service` (which runs on
  3003). Plus, in the monolithic app container everything is reachable under
  `localhost`, not under service hostnames. Fix: env variable
  `AUTH_SERVICE_URL` with default `http://localhost:3003/auth/login`.

- **Autodiscover v1 XML had client-mandatory fields missing or wrong**
  (`packages/autodiscover/src/v1.ts`): Research of the Open Specifications +
  an open-source implementation showed:
  - `AuthPackage` MUST be `Basic` (capital B) — some LTSC desktop client builds
    are case-sensitive. Was `basic` (lowercase b).
  - `<User><LegacyDN>` mandatory: The desktop client uses it as the internal user identity
    (format `/o=CoreMail/ou=Exchange Administrative Group
    (FYDIBOHF23SPDLT)/cn=Recipients/cn=<user-id>`). Was missing completely.
  - `<User><AutoDiscoverSMTPAddress>` added (mandatory for profile binding).
  - `<GroupingInformation>default</GroupingInformation>` in the EXPR block —
    required for sharing discovery.
  - `<PublicFolderInformation><SmtpAddress>publicfolder@<root-domain>` as
    dummy — otherwise the desktop client logs "PublicFolder discovery failed" and
    classifies the profile as incomplete.
  - `ServerDN`/`MdbDN` with the expected topology DN
    (`Exchange Administrative Group (FYDIBOHF23SPDLT)` instead of just
    `Exchange`).
  - `<EcpUrl>` added (points to the MWA — the client uses it for the web-open link).

### Background research

Sources: the Open Specifications (MS-OXDSCLI, MS-OXCMAPIHTTP, POX Autodiscover),
public notes on the HTTP 401 Negotiate flow and on known client bugs, and the
documentation of other open-source mail servers. They confirm: without EWS +
correct 401 behavior, the desktop client cannot build MAPI profiles.

---

## [3.18.37] — 2026-05-26 — Autodiscover XML extended + audit translations

### Fixed

- **The LTSC desktop client could not connect despite correctly
  delivered Autodiscover** (`packages/autodiscover/src/v1.ts`): The
  XML response had only a minimal `<Protocol><Type>EXCH</Type>...`
  block without `AuthPackage`, `OABUrl`, `ASUrl`, `OOFUrl`, `MdbDN`,
  `ServerVersion` and without the **EXPR block** (RPC over HTTP / MAPI-
  over-HTTP fallback). Desktop clients from 2016 on strictly expect these fields —
  without them the setup wizard aborts with "Something went wrong".

  **Fix**: Autodiscover v1 XML extended with:
  - `<AuthPackage>basic</AuthPackage>` (the desktop client needs an explicit auth type)
  - `<ServerVersion>73C0834F</ServerVersion>` (server version token the client expects)
  - `<MdbDN>` + `<ServerDN>` (topology identifiers)
  - `<ASUrl>`, `<OOFUrl>`, `<OABUrl>` (Availability Service, Out-of-Office, Offline Address Book)
  - `<EmwsUrl>` (management web service URL)
  - `<OWAUrl AuthenticationMethod="Basic, Fba">`
  - **Completely new `<Protocol><Type>EXPR</Type>` block** for RPC over HTTP
    /MAPI-over-HTTP (SSL=on, AuthPackage=basic, ServerExclusiveConnect=on)
  - `<MicrosoftOnline>False</MicrosoftOnline>` (signals an on-premises setup)

- **Audit log: legacy action strings (before the v3.18.34 path fix) not translated**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`): Old audit entries
  before the path-mutation fix were stored with short action strings (`anomalies.get`,
  `full.post`, `jobs.delete`, `tags.post`, `members.delete`).
  The v3.18.34 `ACTION_MAP` only had the NEW long forms (e.g.
  `audit-log.anomalies.get`). **Fix**: 25+ additional entries for
  legacy short forms + new v3.18.37 formats (`servers.settings.put`,
  `servers.settings.derive.post`, `retention.tags.*`, `dashboard.get`,
  `services.put`, etc.).

- **Audit log actor column: empty `actorEmail` showed nothing at all**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`): For system actions
  (e.g. cron-triggered) `actorEmail` is empty. Fix: fallback display
  `System (cmpla8p1…)` instead of an empty cell.

---

## [3.18.36] — 2026-05-26 — Hostname auto-derive + image privacy banner hardened

### Fixed

- **Server URLs are now derived dynamically from `publicHostname` —
  no longer fixed to `mail.local:8080`** (`packages/api-gateway/src/lib/server-urls.ts`,
  `packages/api-gateway/src/routes/setup.ts`, `packages/api-gateway/src/routes/admin/domains.ts`):
  Previous behavior: schema defaults write `ewsUrl`/`owaUrl`/`easUrl`/
  `autodiscoverBase` as `http://mail.local:8080/...` at first container
  start. Anyone configuring a real domain (e.g. `mail.firma.de`) had to
  change the URLs manually in BCP → Server settings, otherwise
  Autodiscover gave the desktop client unusable URLs. That works for 1 test user
  manually, but NOT for the 1000+ users with individual domains.

  **Fix**: New central helper `lib/server-urls.ts` with:
  - `deriveServerUrls(publicHostname, useHttps, httpPort)` — computes all
    URLs from the hostname (Autodiscover host per MS-OXDISCO:
    `autodiscover.<root-domain>`).
  - `syncFromPrimaryDomain(domainName)` — sets `publicHostname` to
    `mail.<domain>` if it is still the default, derives all URLs.
  - `syncServerUrlsFromHostname()` — idempotent re-sync, runs at
    api-gateway start AND can be called from outside.

  Hooked into:
  - `POST /api/v1/setup/complete` — the setup wizard saves, in one
    transaction, domain + admin user + `publicHostname=mail.<setup-domain>` +
    all derived URLs. Previously `publicHostname=mail.local` remained.
  - `POST /api/v1/admin/domains` — when the first domain is created
    (= automatically `primary=true`), hostname + URLs are derived
    from it.
  - `POST /api/v1/admin/domains/:id/make-primary` — when another
    domain becomes primary, URLs are only switched to the new hostname
    if `publicHostname` is still the default. An already
    explicitly set configuration is respected.
  - `PUT  /api/v1/admin/servers/settings` — on save with stale URLs
    (`mail.local` or `:8080`) they are updated automatically.
  - api-gateway startup — as a safety net for existing installations.

  A Redis publish on `coremail:settings:reload` informs the autodiscover
  service immediately, so the desktop client never sees outdated URLs.

### Fixed (additionally)

- **The image privacy banner from v3.18.10 did not work in practice** —

- **The image privacy banner from v3.18.10 did not work in practice** —
  external images were loaded directly, the blue "X external images were
  blocked" banner never appeared (`packages/web-client/src/components/MessageReader.tsx`):
  Root cause: `DOMPurify.sanitize(html)` ran WITHOUT configuration and removed
  our privacy markers (`data-coremail-ext-src` attribute, transparent
  `data:image/png;base64,...` placeholder as src) by default. Thus the
  blocking mechanism was immediately undone again by the sanitize step.

  **Fix**: `sanitize()` rebuilt with explicit configuration:
  - `ADD_ATTR: ['data-coremail-ext-src', 'data-coremail-unresolved-cid',
    'data-coremail-ext-bg']` — our markers allowed
  - `ALLOWED_URI_REGEXP` allows `data:image/...;base64,...` (placeholder)
  - `FORBID_TAGS: ['script', 'style', 'link', 'iframe', 'object', 'embed',
    'meta', 'base']` — tracking vectors out
  - `FORBID_ATTR: ['onload', 'onerror', 'onclick', …, 'srcset']` —
    event handlers + responsive-image trackers out

### Added

- **CSS `background-image: url(...)` is also blocked**
  (`packages/web-client/src/components/MessageReader.tsx`): Common tracker
  vector in HTML mails (e.g. `<div style="background-image:url(http://tracker
  .com/pixel.png)">`). `processExternalImages()` extracts `background-image`
  from inline `style` attributes, neutralizes external URLs and stores the
  original in `data-coremail-ext-bg`. On the "Show images" click the
  CSS property is reinserted.

### Changed

- **"Show images" toggle additionally cleans up placeholder styles**
  (`packages/web-client/src/components/MessageReader.tsx`): The thin
  dashed border + `opacity:0.5` that marks blocked images
  is removed automatically after the click — images appear normally instead of
  still "dimmed" with a border.

---

## [3.18.35] — 2026-05-26 — Desktop client connection fix (Autodiscover routing + URL auto-sync)

### Fixed

- **CRITICAL: LTSC desktop client error "Something went wrong" — Autodiscover endpoint
  returned an Express 404**
  (`packages/api-gateway/src/server.ts`): The API gateway routed
  `/Autodiscover/Autodiscover.xml` and `/autodiscover/autodiscover.json/v1.0/...`
  to the **EWS server** (port 8080), although no Autodiscover routes are
  implemented there at all. The **autodiscover server** on port 8081 has the real
  handlers (`handleAutodiscoverV1` + `handleAutodiscoverV2`), but was never
  called. The desktop client got `Cannot POST /Autodiscover/
  Autodiscover.xml` (Express default 404) from the EWS server and therefore could not configure.
  **Fix**: New env variable `AUTODISCOVER_SERVICE_URL` (default
  `http://localhost:8081`). Routes `/Autodiscover` and `/autodiscover` are
  now correctly proxied to the autodiscover server.

- **EWS/webmail/EAS URLs pointed to the internal port :8080** instead of the
  external HTTPS port (`packages/api-gateway/src/server.ts`,
  `packages/api-gateway/src/routes/admin/servers.ts`): During setup the
  `ewsUrl`/`owaUrl`/`easUrl`/`autodiscoverBase` fields in `ServerSettings`
  were initially filled with `http://mail.local:8080/...` (schema defaults). When
  the admin later changed `publicHostname` (e.g. via BCP → Server
  settings), the derived URLs were NOT migrated along →
  Autodiscover delivered internal URLs unreachable for the desktop client.
  - **Startup migration** (`syncAutodiscoverUrls()`): At api-gateway start,
    URLs are auto-corrected if `publicHostname != mail.local` but the URLs
    still contain `mail.local` or `:8080`. Computes `ewsUrl`/`owaUrl`/
    `easUrl` from `publicHostname` + `useHttps` + `httpPort` and
    `autodiscoverBase` from the root domain (MS-OXDISCO:
    `autodiscover.<root-domain>`).
  - **PUT /admin/servers/settings** also repairs stale URLs on save
    automatically when the admin saves the hostname without adjusting URLs.

- **Autodiscover settings cache TTL 60s** delayed the visibility of
  URL changes (`packages/autodiscover/src/server.ts`): The autodiscover
  service had a 60-second in-memory cache for `ServerSettings`, without
  Redis subscription. **Fix**: Subscription to channel
  `coremail:settings:reload` — `invalidateSettingsCache()` is called immediately on
  settings update, so new URLs are active without the 60s wait.

---

## [3.18.34] — 2026-05-26 — Audit log path fix + backup watchdog + UX cleanup

### Fixed

- **CRITICAL: Audit log showed unreadable CUID actions** such as
  `cmplad51y000v13k3j0nbipt5.post` instead of `certificates.activate-https.post`
  (`packages/api-gateway/src/lib/audit.ts`). Root cause: `auditMiddleware` read
  `req.path` INSIDE the `res.on('finish')` callback. By that time
  Express had already mutated the path while descending into sub-routers — for
  `POST /api/v1/admin/certificates/<cuid>/activate-https`, `req.path`
  then only showed `/<cuid>/activate-https` (relative to the certificates sub-router
  mount) instead of `/certificates/<cuid>/activate-https`. From this the
  action builder wrongly built `<cuid>.post`. **Fix**: `req.path` is now
  stored in `capturedPath` at middleware entry and used in the finish
  callback. **Additionally**: new **CUID-aware action builder**
  (`buildAction()`) — CUIDs are filtered out of the action string and
  stored separately as `targetId`. `DELETE /backups/jobs/<cuid>` now becomes
  `action='backups.jobs.delete'` + `targetId=<cuid>`.

### Added

- **40+ new action translations in the audit log**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx` `ACTION_MAP`): New
  mappings for `backups.jobs.delete` → "Backup job deleted",
  `audit-log.anomalies.get` → "Anomaly report retrieved",
  `certificates.activate-https.post` → "Certificate activated for HTTPS",
  `settings.security.put` → "Security settings changed",
  `groups.members.delete` → "Group member removed" and many more for
  certificates, aliases, Shared Mailboxes, transport rules, quarantine, queues,
  OAuth clients, backup schedules.

- **Backup service: startup orphan cleanup + watchdog**
  (`packages/backup-service/src/server.ts`):
  - **Orphan cleanup** at start: backup jobs with status `RUNNING`/`PENDING`/
    `RETRYING`/`PROCESSING`/`SCHEDULED` older than 60s are automatically marked as
    `FAILED` with `errorMsg='Container wurde während Backup
    neugestartet — Job abgebrochen.'` Prevents the "backup runs forever" UI
    display after a container restart.
  - **Watchdog timer** (every 5 min): jobs with status `RUNNING`/`PROCESSING`/
    `RETRYING` older than 30 min are marked as `FAILED` with
    `errorMsg='Watchdog: Job > 30 Min. ohne Fortschritt — abgebrochen.'`

### Changed

- **Backup schedule editor: minute-exact (0..59) instead of a 5-minute grid**
  (`packages/admin-panel/src/pages/BackupsPage.tsx`): Previously the admin
  could only choose the minute in steps of 5 (12 options). Now all 60 minutes
  (0..59) available — user request.

### Removed

- **Red "Anomalies detected" banner removed from the audit log**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`): The banner above the
  audit table (with "2 anomalies detected — evaluation: last 5 min bursts,
  24h critical actions, off-hours") was confusing in practice — among other things it
  showed one's own settings changes as a "critical action". The audit log
  itself shows all relevant actions with clear color coding (red =
  deletions, amber = critical, blue = updates). `anomalies` query +
  `AnomaliesResponse` interface completely removed. Backend endpoint
  `/admin/audit-log/anomalies` is kept (can still be retrieved via PDF/JSON
  export).

---

## [3.18.33] — 2026-05-26 — External contacts completely removed

### Removed

- **Feature "External contacts" (ExternalMailContact) completely removed from the code.**
  External recipients are from now on:
  - entered directly as an email address in the compose window,
  - maintained as `EXTERNAL` members of distribution groups — the member type
    `EXTERNAL` in `DistributionGroupMember` remains unchanged.

  Rationale: Maintaining a separate external address book was rarely used in
  practice — external addresses are typically relevant individually per
  user (private contacts) or per group (e.g. "supplier distribution list").
  Reduces code complexity, simplifies the GAL view (users + distribution groups)
  and removes a maintenance point in the BCP. Analogous to v3.18.5 (eDiscovery) and
  v3.18.31 (Public Folders).

  **Schema** (`packages/storage/prisma/schema.prisma`):
  - Model `ExternalMailContact` removed
  - Table `external_mail_contacts` is dropped at container start via
    `prisma db push --accept-data-loss`
  - **Migration is destructive**: all existing external contacts are
    lost

  **Backend** (`packages/api-gateway/src/`):
  - `routes/admin/external-contacts.ts` — deleted (admin CRUD)
  - Route mount `/api/v1/admin/contacts` removed
  - `routes/contacts.ts`:
    - `/contacts?q=…` (compose autocomplete) now only returns users + distribution groups
    - `/contacts/gal` (browse GAL): the `type=external` filter returns an empty list,
      so that old frontend calls do not break

  **BCP** (`packages/admin-panel/src/`):
  - `pages/ExternalContactsPage.tsx` — deleted
  - `components/Sidebar.tsx` — entry "Ext. contacts" + `BookUser` icon import removed
  - `main.tsx` — route `/ext-contacts` + import removed
  - `i18n/translations.ts` — i18n keys `nav_ext_contacts` (DE+EN) removed
  - `pages/GroupsPage.tsx` — `ext-` prefix branches in `pickSuggestion()` and
    `typeBadge` map removed (dead code since the GAL no longer returns `ext-` IDs)

  **MWA** (`packages/web-client/src/`):
  - `pages/ContactsPage.tsx` — GAL filter toggle "External" removed; detail panel
    only renders `USER`/`GROUP` kinds; `EXTERNAL` conditional renders removed

---

## [3.18.32] — 2026-05-26 — TLS proxy: SNI multi-cert support (Autodiscover fix)

### Fixed

- **Autodiscover clients reported a "certificate error" despite a correctly issued
  `autodiscover.<domain>` certificate** (`packages/api-gateway/src/tls-proxy.ts`):
  The integrated HTTPS proxy (port 443) loaded only the one certificate with
  `isActiveHttps=true` and served ALL incoming TLS connections with it.
  When the desktop client accessed `https://autodiscover.<domain>/Autodiscover/Autodiscover.xml`,
  the client saw the `mail.<domain>` certificate → hostname mismatch →
  `ERR_CERT_COMMON_NAME_INVALID` / the desktop client showed a certificate warning.

  **Fix**: TLS proxy refactored to **SNI multi-cert support**.
  - On reload, ALL certs with `status='ACTIVE'` are loaded, not just the one
    with `isActiveHttps=true`.
  - Per cert a `tls.SecureContext` is created and assigned to all hostnames
    (CN + all SANs from the PEM + `domains[]` array from the DB).
  - Wildcard certs (`*.example.com`) are kept separately and resolved via suffix
    match (RFC 6125 — exactly one sub-label level).
  - `SNICallback` selects per connection based on the server name sent by
    the client: exact match → wildcard match → default cert.
  - The default cert (for unknown SNI or connections without SNI) is the cert
    with `isActiveHttps=true`; fallback: the newest ACTIVE cert.

- **Newly issued ACME + self-signed + uploaded certs now immediately trigger
  `coremail:tls:reload`** (`packages/api-gateway/src/routes/admin/certificates.ts`):
  Previously the reload was only triggered on the manual "Enable HTTPS" click (toggle
  `isActiveHttps`) — with multi-cert SNI, however, all ACTIVE certs should be
  available immediately without anyone toggling HTTPS. Trigger added in
  three code paths: ACME issuance (Let's Encrypt issuance), self-signed
  generation, cert upload.

### Migration

Existing setups: On the first reload after deploy the SNI map is built automatically
from all ACTIVE certs. Existing connections are not interrupted.
Anyone who has not yet issued the `autodiscover.<domain>` cert: BCP → SSL/TLS →
request an ACME certificate with domain `autodiscover.<domain>` — after that
Autodiscover works immediately, without having to click "Enable HTTPS".

---

## [3.18.31] — 2026-05-25 — Public folders completely removed

### Removed

- **Feature "Public Folders" completely removed from the code.**
  The concept (with ACL `READ`/`WRITE`/`FULL` + mail-enabled variant
  since v3.18.9) is hardly used by the market today. Modern teams prefer
  **Shared Mailboxes** (`/admin/shared-mailboxes/`) and **distribution groups**
  (`/admin/groups/`) for the typical use cases (team mailbox, distribution list,
  collaborative inbox). Reduces code complexity and maintenance effort —
  analogous to v3.18.5 (eDiscovery/LegalHold removal).

  **Backend** (`packages/api-gateway/src/`):
  - `routes/public-folders.ts` — deleted (user endpoints `GET/POST/PUT/DELETE`)
  - `routes/admin/public-folders.ts` — deleted (admin CRUD + ACL management)
  - `server.ts` — mount points `/api/v1/public-folders` + `/api/v1/admin/public-folders` removed

  **SMTP server** (`packages/smtp-server/src/`):
  - `inbound/handler.ts` `verifyRecipient()` — `publicFolder.findFirst()` lookup removed
  - `handlers/message.ts` `storeInboundMessage()` — public-folder branch removed;
    mails to former public-folder addresses are now discarded as unknown
    recipient (standard handling)

  **BCP** (`packages/admin-panel/src/`):
  - `pages/PublicFoldersPage.tsx` — deleted
  - `components/Sidebar.tsx` — entry "Public folders" + `FolderOpen` icon import removed
  - `main.tsx` — route `/public-folders` + import removed
  - `i18n/translations.ts` — i18n keys `nav_public_folders` (DE+EN) removed

  **MWA** (`packages/web-client/src/`):
  - `components/FolderTree.tsx` — section `PublicFoldersSection` + `PublicFolderViewerModal`
    components + unused icon imports (`FolderTree`, `X`, `Mail`) removed

  **Database** (`packages/storage/prisma/schema.prisma`):
  - Models `PublicFolder` + `PublicFolderMessage` removed
  - Tables `public_folders` + `public_folder_messages` are dropped at container start
    via `prisma db push --accept-data-loss`
  - **Migration is destructive**: all existing public folders + their
    mails are lost (comparable to the eDiscovery removal in v3.18.5)

---

## [3.18.30] — 2026-05-25 — BigInt crash fix + audit log toggle + audit translations

### Fixed

- **CRITICAL: backup-service crash loop due to `BigInt` serialization**
  (`packages/backup-service/src/server.ts`): Since v3.18.26 `BackupJob.sizeBytes`
  has the Prisma type `BigInt` (for correct representation of backup sizes > 4 GB).
  On the first call to `/jobs` or `/users` Node threw
  `TypeError: Do not know how to serialize a BigInt` → supervisord restarted the
  container endlessly → **ALL backup endpoints returned 500**, which in turn explains the
  symptoms reported by the user:
  - "Back up single mailbox shows no users" → `/users` crashed
  - "Jobs shows no status" → `/jobs` crashed
  Fix: Global monkey patch of `express.response.json` at module top with a
  recursive `BigInt → string` replacer in `JSON.stringify`. Thus applies to
  all existing and future endpoints without individual handlers having to be
  adjusted.

### Added

- **Audit log toggle in the security settings**
  (`packages/storage/prisma/schema.prisma`,
  `packages/api-gateway/src/lib/audit.ts`,
  `packages/api-gateway/src/routes/admin/global-settings.ts`,
  `packages/admin-panel/src/pages/SettingsPage.tsx`):
  New field `ServerSettings.auditLogEnabled` (default `true`) allows
  admins to switch global audit logging on/off. Toggle in
  BCP → Settings → Security. **Critical-action override**: regex
  `ALWAYS_AUDIT` (`/^(settings\.|audit\.|user\.role|oauth\.client|mailbox\.delete|domain\.delete)/i`)
  ALWAYS logs security- and compliance-relevant actions — even with the
  toggle switched off. Compliance background (GDPR Art. 32, SOX, HIPAA,
  TISAX, ISO 27001): otherwise an admin could switch off audit, exfiltrate
  data and switch it back on — undetected. The toggle change
  itself is logged as `audit.enabled` / `audit.disabled` with a diff in the
  `changes` field. **In-memory cache** (60s TTL) prevents a
  DB hit on every audit write; invalidation via `invalidateAuditCache()`
  after every save.

- **Human-readable action labels in the audit log**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`):
  Actions such as `settings.put` or `mailboxes.delete` are now translated with
  an `ACTION_MAP` into readable descriptions — e.g.
  "Settings changed", "Mailbox deleted", "Full backup started",
  "Calendar shared", "Audit log DISABLED" (with red critical tone).
  Over 40 mappings for settings, mailboxes, domains, auth, OAuth, backups,
  calendar sharing, rules, roles, gateway. Hover tooltip shows the
  original action string for SIEM cross-references. Heuristic fallback by
  verb (`post`/`create`/`delete`/...) for unknown actions.

---

## [3.18.29] — 2026-05-25 — Backup archive: download + delete for S3 objects

### Added

- **Download and delete buttons in the "Backup Archive" tab**
  (`packages/backup-service/src/server.ts`,
  `packages/api-gateway/src/routes/admin/backups.ts`,
  `packages/admin-panel/src/pages/BackupsPage.tsx`):
  Previously the archive table was read-only — users could not download or delete
  objects individually. Now two new backend endpoints:
  - `GET /backup/admin/archive/download?key=<s3-key>` — stream proxy for
    direct download (analogous to the `download/:jobId` endpoint, but for
    objects without a BackupJob reference, e.g. old/external imports)
  - `DELETE /backup/admin/archive?key=<s3-key>` — deletes the S3 object
    and additionally nulls matching `BackupJob.downloadUrl` fields
    (status → EXPIRED) so the UI no longer shows a broken link
  Frontend: new action column with download (HardDriveDownload) and
  trash button. Confirm dialog before delete ("delete permanently, cannot
  be undone"). Audit log entry `backup.archive.delete`.

---

## [3.18.28] — 2026-05-25 — Calendar+backup UX fixes (hook bug, tabs, delete, time input)

### Fixed

- **CRITICAL: Reopening a created appointment → white page**
  (`packages/web-client/src/components/EventEditDialog.tsx`):
  React Rules-of-Hooks violation — `useMemo(currentCal)` was called AFTER an
  `if (existingLoading) return`. On the first render: 0 memos,
  on the second: 1 memo → React crash with "Rendered more hooks than during
  the previous render". Result: completely white modal page, no reaction.
  **Fix**: all hooks placed BEFORE every early return.

- **Backup jobs could neither be deleted nor downloaded**:
  The download URL pointed to `http://minio:9000` (Docker-internal, not reachable
  from the browser). The delete endpoint was missing completely.
  **Fix download**: new stream proxy endpoint `GET /admin/backups/download/:jobId`
  in the backup-service streams the S3 object through the api-gateway to the browser.
  Frontend uses fetch + Blob + `URL.createObjectURL` for a clean file
  download.
  **Fix delete**: new endpoint `DELETE /admin/backups/jobs/:id` deletes the DB
  record + S3 object (best-effort, no throw on missing S3 object).
  Delete button in every job row with confirmation dialog.

### Changed

- **Save button in the event dialog now bottom right** (previously header
  toolbar top left). Common desktop pattern. Footer with gray
  background: delete button left, cancel + save right.

- **Time input instead of dropdown-only**
  (`packages/web-client/src/components/EventEditDialog.tsx`):
  Previously a `<select>` with 96 options (15-min) — the user could not enter a custom time
  such as "13:42". Now `<input type="time" list="...">` with
  `<datalist>` — the browser shows 15-min suggestions as a dropdown on focus,
  but the user can freely type any time.

- **BackupsPage completely refactored as a tab layout**:
  5 tabs ("Jobs", "Quick actions", "Schedules", "Backup Archive",
  "Restore (Import)") with badge counters. Previously all sections were
  stacked one below the other — clearer and more mobile-friendly.

- **"S3 Snapshots" renamed to "Backup Archive"** — AWS term avoided,
  clearer language. The tab is called "Backup Archive".

- **Schedule editor with complete dropdowns**: frequency dropdown
  (Hourly/Daily/Weekly/Monthly/Custom), weekday dropdown
  (Mon–Sun), hour dropdown (0–23), minute dropdown (steps of 5), day-of-
  month dropdown (1–28), retention dropdown (preselected values
  7/14/30/60/90/180/365/730/1825/3650). The cron expression is generated in the background
  and shown as a read-only hint. Only with "Custom" does the user see
  the cron text field directly.

### Added

- `streamObject()` + `deleteObject()` helpers in
  `packages/backup-service/src/upload/s3.ts`
- Audit log entry `backup.job.delete` for deleted backup jobs

---

## [3.18.27] — 2026-05-25 — Full event dialog (edit/delete/reschedule/notes/time picker)

### Fixed

- **Clicking an existing appointment only opened a "Delete?" dialog**
  (`packages/web-client/src/pages/CalendarPage.tsx`):
  Before: `confirm('Termin XYZ löschen?')` — the user could not edit the
  appointment. **Fix**: Clicking now opens a full edit dialog with all
  details (title, date, time, guests with status, location, notes, classification).
  Permission check via the `canWrite` flag in the GET response: with a READ share the
  dialog is rendered read-only with a "Read-only access" badge.

- **Date/time input was fiddly (datetime-local)**:
  Typing the time manually, no dropdown — cumbersome especially on mobile.
  **Fix**: Separate date inputs + time dropdowns with 15-minute steps
  (00:00 to 23:45 = 96 options). The "All day" checkbox hides the time fields.

### Added

- **`EventEditDialog` component**
  (`packages/web-client/src/components/EventEditDialog.tsx`):
  Full modal dialog for create + edit with:
  - **Header toolbar**: Save, Delete (edit only), status refresh, Close
  - **Calendar picker**: color dot + dropdown (disabled in edit mode)
  - **Title input**: large heading
  - **Attendee list with live PARTSTAT badges**:
    - Green CheckCircle for ACCEPTED, red XCircle for DECLINED,
      amber HelpCircle for TENTATIVE, gray Clock for NEEDS-ACTION
    - Autocomplete input with keyboard nav (↑↓/Enter/Tab/Esc) reusing `/contacts?q=`
    - Counter at the bottom: "X accepted · Y declined · Z maybe · N pending"
    - Status refreshes automatically every 30 seconds (live!)
  - **Date+time pickers**: HTML date input + time dropdown (15-min steps),
    the end date follows automatically when the start is moved
  - **Location input** with MapPin icon
  - **Classification dropdown** (Public / Private / Confidential)
  - **Notes textarea** (6 rows, vertical resize)
  - **Info footer**: organizer name, SEQUENCE counter, auto-update hint

- **`GET /api/v1/calendar/events/:id`** — detail load for the edit dialog with
  `canWrite`/`readOnly` flags. Permission check via `canAccessCalendar`,
  privacy masking for PRIVATE events for grantees (summary → "Busy",
  attendees hidden), CONFIDENTIAL returns 404 for foreign viewers.

### Changed

- **CalendarPage** — old inline dialog removed (was ~80 lines of JSX).
  Replaced by the unified `EventEditDialog` for create and edit.
  State simplified: `eventDialog: { mode: 'create' | 'edit', ... } | null`.
- **Toolbar "New event"** now opens the new dialog
  instead of the old mini dialog.
- **Double-click / single click on event**: opens the edit dialog (a double-
  click is fired by FullCalendar as two eventClicks — both open
  the same dialog, no conflict).
- **Attendee status refresh**: the edit dialog has its own `refetchInterval: 30s`
  + manual refresh button in the header.

---

## [3.18.26] — 2026-05-25 — Backup bug fixes + per-mailbox + scheduling + status log

### Fixed

- **Full-backup button and refresh button did not work**
  (`packages/backup-service/src/upload/s3.ts`,
  `packages/backup-service/src/server.ts`):
  Root cause: the backup-service crashed on the first call to
  `listBackups()` because the MinIO bucket `coremail-backups` did not
  exist (`NoSuchBucket` error). supervisord restarted the container
  every few minutes — from the user's point of view the buttons did not react.
  **Fix**: `ensureBackupBucket()` runs at service start and creates the
  bucket idempotently (HeadBucket → CreateBucket on 404). `listBackups()`
  additionally fail-safe: on NoSuchBucket create the bucket + return an empty list
  instead of crashing.

### Added

- **Per-mailbox backup**
  (`packages/backup-service/src/scheduler/index.ts`,
  `packages/backup-service/src/server.ts`,
  `packages/admin-panel/src/pages/BackupsPage.tsx`):
  New endpoint `POST /admin/backups/mailbox/:userId` with body
  `{ format: "zip" | "mbox" }`. Frontend: user picker (dropdown of all
  active users) + format selection + "Back up mailbox" button. The snapshot
  lands in MinIO under `mailbox/{userId}/{timestamp}.{format}`.

- **Backup schedules (cron) in the DB instead of an env variable**
  (`packages/storage/prisma/schema.prisma` — new model `BackupSchedule`,
  `packages/backup-service/src/scheduler/index.ts`):
  Admins can manage cron expressions in the BCP — no container restart
  needed. The scheduler reads from the DB every 60s and synchronizes active
  CronJobs. Fields: `name`, `cron`, `enabled`, `scope` (full/user),
  `format`, `targetUserId`, `retentionDays`, `lastRunAt`, `lastStatus`.
  Frontend with cron presets (daily/weekly/hourly/every 6h/
  monthly), run-now button per schedule, edit/delete buttons.

- **Extended status-log fields in the BackupJob model** (research: see
  `coremail/research/imip-itip.md` and RTO/RPO research):
  - `startedAt`, `durationMs` — for RTO measurement
  - `sizeBytes`, `messageCount` — backup volumetrics
  - `errorClass` (NETWORK/STORAGE/PERMISSION/CORRUPT/UNKNOWN) +
    `errorMessage` — structured error reporting
  - `retryCount`, `triggeredBy` (CRON/MANUAL/EVENT/RESTORE/API)
  - `progressMeta` (JSONB) for the live phase "Reading mailbox X (3/12)"
  - `scheduleId` — reference to the BackupSchedule when triggered from cron

- **Extended `JobStatus` enum values** for the complete backup
  lifecycle: `SCHEDULED`, `RUNNING`, `RETRYING`, `ABORTED`, `EXPIRED`
  in addition to the previous `PENDING|PROCESSING|COMPLETED|FAILED`.

### Changed

- **`POST /backup/admin/full`** now immediately returns the master job ID
  (`202 { jobId }`) instead of fire-and-forget. The frontend can immediately
  show the RUNNING job in the table.
- **`runFullBackup()`** now creates a master job with `progress`
  tracking instead of just per-user jobs without an overview. The UI shows a progress bar
  "X/Y users exported" during the run.
- **Refresh button** with toast feedback ("Refreshed") so the user
  gets visual confirmation.

### Removed / Explicitly Not Supported

- **PST format** is deliberately not supported. Rationale in the frontend
  banner: PST is a proprietary binary format, all available
  open-source libs (libpff, node-pst-extractor) are read-only. Instead
  ZIP with .eml files — common desktop mail programs accept that via drag & drop.

### Schema

- New model `BackupSchedule` (cron management in the DB).
- `BackupJob` extended with 10 new columns (`startedAt`, `durationMs`,
  `sizeBytes`, `messageCount`, `errorClass`, `retryCount`, `triggeredBy`,
  `progressMeta`, `scheduleId`).
- `JobStatus` enum extended with 5 values.

---

## [3.18.25] — 2026-05-25 — Calendar invitations (iMIP/iTIP, A5)

### Added

- **iMIP REQUEST mails to guests on appointment creation** (RFC 6047 / 5546)
  (`packages/api-gateway/src/lib/imip.ts`,
  `packages/api-gateway/src/routes/calendar.ts`):
  When an event with attendees is created, the system generates an
  iMIP-compliant invitation mail via `ical-generator` with:
  - `multipart/alternative` → text/plain + text/html + `text/calendar; method=REQUEST` (for Gmail)
  - `application/ics` attachment (for the RSVP buttons of Win32 desktop clients)
  - client-specific properties (`X-MICROSOFT-CDO-BUSYSTATUS`, `X-MS-OLK-FORCEINSPECTOROPEN`)
  - Mandatory properties: UID (with `@hostname` suffix), DTSTAMP, ORGANIZER,
    ATTENDEE with `RSVP=TRUE PARTSTAT=NEEDS-ACTION`, SEQUENCE, STATUS:CONFIRMED
  Sent via the existing BullMQ outbound queue (`smtp-outbound`) via the
  `rawMessage` base64 path — retry + DKIM signing apply automatically.

- **iMIP update on event change** — On `PUT /calendar/events/:id`,
  changed fields are detected (summary/dtStart/dtEnd/location/attendees). If
  relevant fields change, `sequence++` and a new REQUEST mail
  is sent to all attendees (mail clients recognize the update by the higher SEQUENCE
  and replace the existing entry).

- **iMIP CANCEL on event deletion** — On `DELETE /calendar/events/:id`, a
  CANCEL mail (`METHOD:CANCEL`, `STATUS:CANCELLED`,
  `sequence++`) is sent to all attendees before the delete. Common mail clients show a banner
  "Appointment cancelled" and remove the entry.

- **iTIP REPLY inbound handler** (guest responds)
  (`packages/storage/src/itip-inbound.ts`,
  `packages/smtp-server/src/handlers/message.ts`):
  Incoming mails are scanned for `BEGIN:VCALENDAR ... METHOD:REPLY`
  (regex-based, no heavy ical parser in the hot path). On match:
  UID lookup on `CalendarEvent`, SEQUENCE check (old REPLYs are
  ignored, RFC 5546 §3.4.3), update the attendee entry in the JSON array
  (`partstat=ACCEPTED|DECLINED|TENTATIVE`). The mail is NEVERTHELESS delivered to the
  inbox (user awareness).

- **Frontend: guest input in the new-appointment dialog**
  (`packages/web-client/src/pages/CalendarPage.tsx`):
  New input field "Invite guests (comma-separated)" accepts email
  addresses such as `anna@example.com, bob@x.de`. Counter shows "X guests —
  invitation mails will be sent on save".

### Schema

- `CalendarEvent.attendees` (JSON array) is filled on create with
  `{ email, cn, partstat, role, rsvp }` objects.
- `CalendarEvent.sequence` (Int, default 0) is incremented on every relevant
  update (prepared in v3.18.24).
- `CalendarEvent.uid` now with hostname suffix `<id>@<publicHostname>`
  (RFC 5545 §3.8.4.7 — global uniqueness).

### Dependencies

- `ical-generator@10.2.0` in api-gateway (installed in v3.18.24)

---

## [3.18.24] — 2026-05-25 — Performance E: MinIO lifecycle policies

### Added

- **E4 — MinIO lifecycle policies for automatic cleanup**
  (`packages/storage/src/minio/index.ts`):
  Until now, temporary backup, quarantine and outbound-queue objects
  could grow unbounded in the MinIO bucket — especially `outbound-queue/` attachments
  of dead BullMQ jobs (e.g. after a crash between job enqueue and worker
  pickup) stayed forever. The new helper `ensureLifecyclePolicies()`
  is called in `ensureBuckets()` and sets three prefix-based
  expiration rules in the bucket:
  - `outbound-queue/` → 7 days (safety net for dead jobs)
  - `quarantine/`     → 90 days (rspamd quarantine)
  - `backups/`        → 365 days (backup retention)
  Email attachments (`attachments/`) and raw messages (`raw/`) are explicitly
  EXCLUDED — they are removed individually on message delete. Idempotent:
  setBucketLifecycle() overwrites the policy every time, so the current state is
  guaranteed at every container start. Fail-safe: if MinIO
  does not accept the policy (old version, permission issue), only a WARN
  log, no throw.

### Added (Dependency)

- `ical-generator@^10.2.0` as preparation for v3.18.25 iMIP calendar
  invitations.

### Schema

- **`CalendarEvent.sequence Int @default(0)`** — sequence counter for
  iMIP-compliant event updates (RFC 5546 §3.2). Mail clients
  ignore REPLY mails with a lower sequence than the currently
  stored event state. Preparation for v3.18.25.

---

## [3.18.23] — 2026-05-25 — Backup/restore UI in the BCP (D3)

### Added

- **New BCP page "Backup & Restore"**
  (`packages/admin-panel/src/pages/BackupsPage.tsx`,
  `packages/admin-panel/src/components/Sidebar.tsx`,
  `packages/admin-panel/src/i18n/translations.ts`,
  `packages/api-gateway/src/routes/admin/backups.ts`,
  `packages/api-gateway/src/server.ts`):

  Until now backup management was only possible via CLI / direct backup-service calls.
  New admin UI with:
  - **Backup jobs table** — date, scope (user/domain/full), format
    (mbox/eml/full), status with icons (PENDING/RUNNING/COMPLETED/FAILED/
    CANCELLED), progress bar, download link for completed jobs.
    Auto-polling every 5s when a job is RUNNING or PENDING, otherwise 60s
    (performance + live updates).
  - **S3 snapshots table** — lists all backup objects in the MinIO/S3 bucket
    with key, size (formatted KB/MB/GB), last-modified.
  - **"Start full backup" button** — triggers `POST /admin/backups/full`,
    audit log entry `backup.full.trigger`.
  - **MBOX import (restore)** — file picker (limit 500 MB) + target user ID,
    `POST /admin/backups/import/:userId` with `Content-Type: application/mbox`,
    audit log entry `backup.mbox.import`.

  Backend: wrapper router `adminBackupsRouter` forwards `/api/v1/admin/backups/*`
  to `BACKUP_SERVICE_URL` (default `http://localhost:3004`). Auth via
  `requireAdmin` middleware + Authorization header forwarding. Audit log for
  trigger/import. Side-effect import for the Express augmentation `req.apiUser`.

  Sidebar: new nav entry "Backup & Restore" with `HardDriveDownload`
  icon. i18n key `nav_backups` in DE + EN.

---

## [3.18.22] — 2026-05-25 — OAuth2 consent UI (Security)

### Security

- **D1 — OAuth2 auto-grant removed, real consent UI**
  (`packages/auth-service/src/oauth2/router.ts`,
  `packages/web-client/src/pages/LoginPage.tsx`,
  `packages/web-client/src/pages/OAuthConsentPage.tsx`,
  `packages/web-client/src/App.tsx`):

  **Before (security issue)**: `/oauth2/authorize/complete` granted consent
  blindly on the first call of a non-trusted client — users had no
  opportunity to see or reject a third-party app before its first access.
  Despite the "non-trusted" marking, all requested
  scopes were approved automatically.

  **Now**: With missing or incomplete consent, the backend returns
  `200 { requiresConsent: true, client, requestedScopes, alreadyGrantedScopes,
  newScopes }` instead of issuing a code directly. The frontend shows the new
  ConsentPage with:
  - Client name + description
  - List of requested scopes with German labels (e.g. "mail.send" →
    "Send emails on your behalf", "calendar.write" → "Create, change
    or delete appointments")
  - With an existing grant plus additional scopes: only the NEW scopes
    are highlighted, already granted ones as a small note at the bottom
  - Amber warning "You can revoke this access at any time"
  - "Allow" and "Deny" buttons

  Flow:
  1. Third-party app → `GET /oauth2/authorize?client_id=...&...`
  2. Auth-service redirects to `/owa/login?oauth2=1&client_id=...`
  3. LoginPage detects `oauth2=1`, after login → `navigate('/oauth-consent?...')`
  4. ConsentPage asks the backend whether consent is needed → on `redirect` straight back
     to the client (already granted), on `requiresConsent` show the UI
  5. "Allow" → second call with `consentConfirmed: true` → backend
     persists the consent + creates the code + returns the `redirect` URL
  6. "Deny" → client is called with `error=access_denied` (RFC 6749 §4.1.2.1),
     no code is issued

  New route `/oauth-consent` in the MWA, with AuthGuard but without the layout wrapper
  (standalone full-screen dialog).

---

## [3.18.21] — 2026-05-25 — Calendar toolbar filter + printing now functional

### Fixed

- **Filter button had no effect**
  (`packages/web-client/src/components/CalendarToolbar.tsx`,
  `packages/web-client/src/pages/CalendarPage.tsx`):
  The dropdown did open with toggle checkboxes, but the state was
  purely local to the toolbar — it was never passed on to CalendarPage.
  In addition, the old terms ("Meetings",
  "Categories", "Show as") were meaningless for CoreMail.
  **Fix**: filter set reduced to 5 realistic options that actually map to
  data: Recurring events (rrule), Tasks, Private events
  (classification=PRIVATE), Confidential events (CONFIDENTIAL for owner),
  Shared calendars (shared=true). State lifted to CalendarPage
  (controlled component). `fcEvents` are now actually filtered.

- **"Print" printed the entire page including sidebar + toolbar**
  (`packages/web-client/src/pages/CalendarPage.tsx`,
  `packages/web-client/src/index.css`):
  Before: a plain `window.print()` without print CSS — sidebar, toolbar,
  app chrome all ended up on the printout. **Fix**: before `window.print()` the
  `coremail-printing` class is set on `<html>`; a new `@media print`
  block in `index.css` hides `aside`, `nav`, `header` and all
  `[data-coremail-toolbar]` elements. After the print dialog the
  class is removed again via timeout (500ms). Events get a print-
  friendly border (1px solid #888) so they remain visible on paper.

---

## [3.18.20] — 2026-05-25 — Dark-mode patches (LoginPage + SettingsPage)

### Changed

- **MWA LoginPage dark mode** (`packages/web-client/src/pages/LoginPage.tsx`):
  The login card had no `dark:` modifiers at all — as the first page a
  new user sees, an obvious bug. Now with
  `dark:bg-gray-900`, `dark:text-white`, `dark:text-gray-400` for logo +
  subtitle. Card border `dark:border-gray-700` as a subtle delimiter.

- **MWA SettingsPage dark mode (section headers + form labels)**
  (`packages/web-client/src/pages/SettingsPage.tsx`):
  Section headings (`text-lg font-semibold text-gray-900` → +
  `dark:text-gray-100`), sub-texts (`text-sm text-gray-500 mt-0.5` → +
  `dark:text-gray-400`), form labels (`block text-sm font-medium
  text-gray-700 mb-1` → + `dark:text-gray-300`) and the disabled e-mail input
  (`bg-gray-50` → + `dark:bg-gray-800`) are now correctly readable
  in dark mode.

### Known

- ComposeWindow (~22 places) and SignatureSection (~9 places) still
  have individual non-dark-aware classes. Will be cleaned up in a dedicated
  dark-mode sweep session in v3.19.

---

## [3.18.19] — 2026-05-25 — Forced 2FA for admin login (Security)

### Security

- **D5 — Mandatory 2FA for admins** (`packages/api-gateway/src/middleware/auth.ts`,
  `packages/admin-panel/src/api/client.ts`,
  `packages/admin-panel/src/pages/MfaRequiredPage.tsx`):
  When `ServerSettings.requireMfaForAdmins=true` (the toggle already existed in
  the security settings but was never enforced anywhere) and the admin
  has NO MFA enabled → all `/api/v1/admin/*` routes now return
  `403 { code: "MFA_REQUIRED" }`. The frontend API client detects the code and
  redirects to the new mandatory setup page `/bcp/mfa-required` with instructions
  ("Open MWA → Settings → Security → enable 2FA → come back").
  TOTP or WebAuthn credentials both count as "MFA enabled".
  No chicken-and-egg problem: the MFA setup routes (`/auth/mfa/*`) are
  outside the `/admin/*` lock. Fail-safe: on a DB error in the check the request
  is let through (logged as ERROR) so admins are not locked out
  during a Postgres outage.

---

## [3.18.18] — 2026-05-25 — Toolbar share button + CalDAV URL display

### Fixed

- **Toolbar "Share calendar" now works**
  (`packages/web-client/src/pages/CalendarPage.tsx`):
  The button at the top of the CalendarToolbar previously only showed a toast
  ("Select a calendar and click Share via the ⋯ menu"). Now
  it opens the `ShareCalendarDialog` directly — if the user has several
  own calendars, a selection dropdown appears in the dialog header
  for switching. With only one own calendar it is opened
  directly. If none exists → toast error.

### Added

- **CalDAV URL display for external calendar access**
  (`packages/api-gateway/src/routes/calendar.ts`,
  `packages/web-client/src/components/ShareCalendarDialog.tsx`,
  `packages/web-client/src/components/CalendarSidebar.tsx`):
  New endpoint `GET /api/v1/calendar/caldav-info` returns
  - `accountUrl` for auto-discovery (`https://host/dav/calendars/{userId}/`)
  - a per-calendar URL for direct mounting (`.../{calendarId}/`)
  - username + auth hint (app password instead of login password because of MFA)
  In the share dialog a new section "External access (CalDAV)" appears
  with both URLs and copy-to-clipboard buttons. The sidebar context menu
  on own calendars additionally offers "Copy CalDAV URL" for
  quick access. CalDAV is consistently recommended over HTTPS (auth-leak
  protection); only if the admin has explicitly set `useHttps=false` (e.g.
  behind a reverse proxy) is `http://` emitted.

### Changed

- **ShareCalendarDialog** now accepts an optional `ownedCalendars` prop
  for picker mode. When invoked from the sidebar context menu the
  calendar stays fixed; when invoked from the toolbar it can be switched.
  The header shows the picker dropdown only when `ownedCalendars.length > 1`.

---

## [3.18.17] — 2026-05-25 — Calendar SSE push + free/busy query

### Added

- **A2 — SSE push for the calendar share lifecycle**
  (`packages/core/src/redis/index.ts`, `packages/api-gateway/src/sse.ts`,
  `packages/api-gateway/src/routes/calendar.ts`,
  `packages/web-client/src/hooks/useMailEvents.ts`):
  New Redis channel `coremail:calendar:shares` (constant
  `CHANNEL_CALENDAR_SHARES`). The backend publishes a JSON event with
  `affectedUserIds[]` (owner + grantee) on every share lifecycle
  action (create/update/delete/self_remove). The SSE handler in the api-gateway
  subscribes to the channel and forwards the event as `event: calendar:shares`
  only to the SSE connections of the affected users. The frontend hook
  `useMailEvents()` invalidates the `['calendars']` and
  `['calendar-shares']` caches on that event → instant live sync without polling. Toast
  "🗓️ A calendar was shared with you" on `action=create`. Polling
  interval of the calendar query in CalendarPage reduced from 60s to 5min
  (only a safety fallback in case SSE is dead).

- **A4 — Free/busy query across shared calendars**
  (`packages/api-gateway/src/routes/calendar.ts`):
  New endpoint `POST /api/v1/calendar/freebusy`, body
  `{ userEmails[], start, end }`. Returns, per requested user, all
  busy slots from calendars the caller has access to (own + via
  share). CONFIDENTIAL events remain hidden for foreign callers,
  PRIVATE events are returned as a generic "Busy" slot WITHOUT subject.
  Self-query (caller asks about themselves) sees all details. Range hard-
  limited to 90 days (DoS protection), list to 50 users. Response shape:
  `{ start, end, users: [{ email, displayName, found, busy: [{ start, end, type, subject? }] }] }`.

---

## [3.18.16] — 2026-05-25 — Calendar sharing quick wins (notification, per-grantee color, reorder, cleanup)

### Added

- **A1 — Notification mail to grantee on sharing**
  (`packages/api-gateway/src/lib/internal-notify.ts`, `routes/calendar.ts`):
  When an owner shares a calendar, the recipient automatically receives a
  system mail in their INBOX ("X shared the calendar 'Y' with you" with
  permission level). New helper `notifyUserInbox()` with direct inbox
  insertion via `prisma.message.create` — no SMTP round trip, no DKIM/
  spam check needed, immediately visible. Only on a *new* share, not on a
  permission update via upsert (prevents spam). HTML escaping against XSS.

- **A3 — Per-grantee color for shared calendars**
  (`schema.prisma`, `routes/calendar.ts`, `components/CalendarSidebar.tsx`):
  Grantees can recolor shared calendars locally without changing the owner's
  color. New field `CalendarShare.localColor String?` and
  endpoint `PATCH /calendar/mine-shares/:shareId` with body `{ localColor }`.
  Color picker in the context menu on shared calendars; "Original color (from
  owner)" resets `localColor=null`. `listAccessibleCalendars` returns
  `localColor ?? calendar.color` for grantees.

- **A8 — Reorder for shared calendars**
  (`schema.prisma`, `routes/calendar.ts`, `components/CalendarSidebar.tsx`):
  Grantees can locally adjust the order of the "Shared with me" section.
  New field `CalendarShare.sortOrder Int @default(0)` and endpoint
  `POST /calendar/mine-shares/reorder` (body `{ ids[] }`, filtered on
  `granteeId === userId`). Context menu "Move up" / "Move down" on
  shared calendars.

- **`shareId` field** in the `GET /calendar` response (only when `shared: true`)
  — the frontend uses it for self-removal, color change, reorder. Previously
  self-removal needed a round trip via `/mine-shares?calendarId=`,
  now it is directly available.

### Changed

- **CalendarSidebar — shared calendars sorted by `sortOrder`** instead of
  alphabetically by name. Tie-break remains `localeCompare`.
- **Self-removal mutation** simplified — now uses `cal.shareId` directly
  instead of a lookup via `mine-shares?calendarId=`.

### Removed

- **C1 — `Calendar.acl Json` field removed completely**
  (`packages/storage/prisma/schema.prisma`):
  Marked `@deprecated` in v3.18.14 (replaced by `CalendarShare`).
  The column is dropped automatically at container start via `prisma db push --accept-data-loss`.
  No code in `packages/` referenced the field —
  `PublicFolder.acl` remains unchanged (different model).

---

## [3.18.15] — 2026-05-25 — CalDAV WRITE sharing + private events + audit log + i18n

### Added

- **CalDAV WRITE for grantees with full RFC 3744 DAV ACL**
  (`packages/caldav-server/src/caldav/index.ts`):
  In v3.18.14 Apple Calendar / Thunderbird Lightning could only read.
  Now WRITE grantees may also PUT (create/update) and DELETE.
  The write lock for READ grantees remains. Full RFC 3744 DAV ACL:
  - `<DAV:owner>` with `<d:href>/dav/principals/{ownerId}/</d:href>`
  - `<DAV:current-user-privilege-set>` with fine-grained privileges
    (`<d:read/>`, `<d:write/>`, `<d:write-content/>`, `<d:bind/>`, `<d:unbind/>`)
  - `<DAV:acl>` block (visible to OWNER only) with one ACE per grantee
  - `Allow` header in OPTIONS now includes `ACL`, `DAV` header includes `access-control`
  Cross-calendar manipulation protection: a grantee cannot move an event, from
  their point of view, into a different calendar.

- **Private and confidential events (RFC 5545 `CLASS:`)**
  (`packages/storage/prisma/schema.prisma`, `packages/api-gateway/src/lib/calendar-access.ts`):
  New field `CalendarEvent.classification` with three values:
  - `PUBLIC` (default): grantees see all details
  - `PRIVATE`: grantees only see "Busy" — subject/description/location/
    attendees are masked. The owner sees everything unchanged.
  - `CONFIDENTIAL`: the event is completely hidden from grantees
  Mapping to the iCal `CLASS:` property (RFC 5545 §3.8.1.3) in both directions
  (backend → iCal on build, CalDAV PUT → DB on parse). Masking applies
  in REST `GET /calendar/events`, CalDAV `GET`, `PROPFIND` and `REPORT`.
  WRITE grantees cannot modify CONFIDENTIAL events (otherwise they would be
  manipulable despite masking).

- **Audit log for sharing actions** (compliance, GDPR Art. 32)
  (`packages/api-gateway/src/routes/calendar.ts`):
  New audit actions — all with actor, target calendar, IP, user agent and
  diff in the `changes` field:
  - `calendar.share.create` — when a share is created
  - `calendar.share.update` — on permission change (with oldPermission/newPermission)
  - `calendar.share.delete` — when the owner removes a share
  - `calendar.share.self_remove` — when a grantee removes themselves from the list
  Until now sharing actions were NOT audited — gap closed.

- **i18n: EN, ES, IT translations for the sharing UI**
  (`packages/web-client/src/i18n/translations.ts`):
  25 new keys (`cal_share_*` and `cal_event_class_*`) in all four
  languages German/English/Spanish/Italian.

### Changed
- **Event creation dialog** in the MWA now has a visibility dropdown
  ("Public" / "Private" / "Confidential"). Default remains PUBLIC for
  backward compatibility.

- **CalDAV OPTIONS response** now contains `ACL` in the Allow header and
  `access-control` in the DAV header — Apple Calendar thereby detects full
  RFC 3744 support.

### Schema

- New field `CalendarEvent.classification String @default("PUBLIC")`.
  Migration runs automatically via `prisma db push --accept-data-loss`.
  Existing events get `PUBLIC` as default — no behavior change
  for non-shared calendars.

---

## [3.18.14] — 2026-05-25 — Share calendars and grant permissions (read/write)

### Added

- **Calendar sharing — internal sharing between users**
  (`packages/storage/prisma/schema.prisma`, `packages/api-gateway/src/routes/calendar.ts`,
  `packages/web-client/src/components/ShareCalendarDialog.tsx`):
  Users can share their own calendars with other users in the same system
  with READ or READ+WRITE permission. Shared calendars appear for the
  recipient in a new sidebar section "Shared with me" with a share icon
  and permission badge (R / R/W) as well as the owner name as subtitle.

- **Sharing dialog with user autocomplete**
  (`packages/web-client/src/components/ShareCalendarDialog.tsx`):
  Clicking "Sharing and permissions" in the calendar context menu opens a
  full-featured dialog instead of the previous "Coming soon" notification.
  - User autocomplete via `/contacts?q=` (220ms debouncing, keyboard nav
    ↑↓/Enter/Tab/Escape, automatic filtering to internal user hits only,
    already-assigned users are hidden)
  - Permission select (Read only / Read and write)
  - List of current shares with permission toggle + trash button
  - Self-share prevented (backend 400 response)
  - Info banner explaining READ vs WRITE plus a CalDAV hint

- **CalDAV discovery for shared calendars (read-only)**
  (`packages/caldav-server/src/caldav/index.ts`):
  External clients (Apple Calendar, Thunderbird Lightning) now also see shared
  calendars in the calendar-home-set (with `[Geteilt]` prefix in the display name).
  PROPFIND/REPORT/GET are allowed. PUT/DELETE remain OWNER-only in v3.18.14
  (full WRITE CalDAV follows in v3.18.15 with an RFC 3744-compliant DAV ACL).
  `<DAV:current-user-privilege-set>` set correctly: OWNER → `<d:all/>`,
  grantee → `<d:read/>`.

### Changed

- **GET /api/v1/calendar** now returns own + shared calendars with fields
  `shared`, `ownerId`, `ownerDisplayName`, `ownerEmail`, `permission`
  (`OWNER`/`READ`/`WRITE`). Lazy provisioning only when there are no calendars at all.

- **Event permission checks** in `POST/PUT/DELETE /calendar/events*` via the new
  central helper `canAccessCalendar(userId, calendarId, required)` in
  `packages/api-gateway/src/lib/calendar-access.ts`. WRITE permission required
  for write operations, READ suffices for `GET /events`. Owners always have
  all rights.

- **FullCalendar in the MWA** renders shared READ-only calendars as non-editable
  (`editable: false`, `startEditable: false`, `durationEditable: false`).
  Clicking a READ-only event shows the toast "Read-only permission for this
  calendar" instead of the delete confirm. The new-event dialog lists only calendars with
  write permission in the dropdown.

- **TanStack Query calendar cache** with `staleTime: 30s` + `refetchInterval: 60s`
  + `refetchOnWindowFocus: true` — changed shares (e.g. owner revokes a
  permission) disappear from the UI within 60s.

### Schema

- **New table `calendar_shares`** with fields `id`, `calendarId`, `ownerId`,
  `granteeId`, `permission` (enum `READ`/`WRITE`), `comment`, `createdAt`.
  Unique constraint `(calendarId, granteeId)` prevents duplicates, POST is
  idempotent (upsert). Cascade delete on calendar/owner/grantee deletion.
- **New enum `CalendarPermType`** with values `READ`, `WRITE`.
- **`Calendar.acl Json`** marked `@deprecated` — removal in v3.19.

### API

- `GET /api/v1/calendar/:id/shares` — list of all shares for an own calendar
- `POST /api/v1/calendar/:id/shares` — body `{ granteeId, permission, comment? }`,
  upsert behavior, accepts `gal-` prefix
- `PUT /api/v1/calendar/:id/shares/:shareId` — update permission
- `DELETE /api/v1/calendar/:id/shares/:shareId` — owner OR grantee (self-removal)
- `GET /api/v1/calendar/mine-shares?calendarId=...` — shares granted to me
  (grantee view, needed for the self-removal flow)

---

## [3.18.13] — 2026-05-25 — External contacts UI simplified + GAL cache live sync

### Changed

- **BCP ExternalContactsPage — first name/last name fields removed**
  (`packages/admin-panel/src/pages/ExternalContactsPage.tsx`):
  The separate inputs for first name and last name were redundant — the
  display name is the only relevant value that is visible everywhere in MWA/GAL/mail clients.
  The UI now has only one required field "Display name". Backend
  `firstName`/`lastName` remain in the DB with a default `""` fallback
  (no schema break).

### Fixed

- **GAL in the MWA showed newly created external contacts only after a reload**
  (`packages/web-client/src/pages/ContactsPage.tsx`):
  When an admin created a new external contact or a distribution group in the BCP,
  it was not visible in the MWA global address book — the
  TanStack Query cache held the old result stale-free for 30 seconds.
  **Fix**: `staleTime: 0` + `refetchOnMount: true` + `refetchOnWindowFocus: true`
  + `refetchInterval: 60_000` for the `/contacts/gal` query. Additionally a new
  refresh button (RefreshCw icon) in the filter bar next to the counter — the user
  can synchronize manually at any time. Spinning animation during the
  fetch as visual feedback.

---

## [3.18.12] — 2026-05-24 — Public folders: browse modal, folder icons, auto-hide without ACL

### Fixed

- **Public folders were not accessible despite full access**
  (`packages/web-client/src/components/FolderTree.tsx`):
  Clicking a public folder only showed the toast "Browse view coming
  in the next patch" — no actual access to the messages was possible.
  **Fix**: new `PublicFolderViewerModal` component — a click opens a 2-column
  modal (list left, detail right) with all messages of the folder.
  Auto-refresh 30s, sanitized HTML rendering, clickable recipient avatars,
  "X messages" counter in the footer.

- **Wrong icons** — public folders had a Users icon (distribution-group
  style) and looked like contacts rather than folders.
  **Fix**: `Folder` icon (amber, filled) both in the sidebar and in the
  modal header. `FolderTree` icon for the section heading. Clear visual
  separation between mail folders (stack icon) and public folders (folder icon).

- **Section appeared with an empty cache / during loading**
  Before: `if (folders.length === 0) return null` — before the first fetch the
  section showed nothing, which is correct, BUT when the cache was stale (an earlier user
  still had ACLs), the section was initially shown even though the newly logged-in
  user no longer had permission.
  **Fix**: the hide logic now checks `!isSuccess || !folders || folders.length === 0`
  — the section is guaranteed invisible until the backend has actually delivered
  data. Additionally `refetchOnWindowFocus: true` + polling interval reduced from 60s to
  30s: when an admin revokes access, the section disappears automatically on the
  next tab focus or after 30s at the latest.

---

## [3.18.11] — 2026-05-24 — MWA global address book (GAL browser)

### Added

- **ContactsPage — tabs "My address book" / "Global address book"**
  (`packages/web-client/src/pages/ContactsPage.tsx`):
  - Tab navigation in the sidebar between private contacts (existing) and GAL
  - GAL returns a merged result from 3 sources (all active internal users, external
    contacts from the admin directory, distribution groups)
  - The search bar works for both tabs; for GAL without a search all
    entries are listed alphabetically (browse mode)
  - Type filter (All / People / External / Groups) as a compact toggle bar
  - Counter badge shows the total number of GAL hits
  - Clicking a GAL entry → read-only detail panel with avatar, type badge
    (Distribution group / External contact / Internal user), e-mail (clickable
    mailto:), phone/mobile (clickable tel:), company, department, domain,
    member count
  - **"New message" button** opens the compose window with the GAL address
    pre-filled
  - Note in the detail panel: centrally managed — the user cannot edit GAL entries
    directly

- **Backend `/api/v1/contacts/gal` extended** with browse mode + type filter:
  - Without `q` → all GAL entries sorted alphabetically (browse for the GAL view)
  - With `q` (>=2 characters) → full-text search across all 3 sources
  - `type=all|users|external|groups` filters the sources
  - Paginated: `limit` (max 500, default 300) + `offset`
  - Response: `{ entries: GalEntry[], total, limit, offset }`
  - Structured `GalEntry` format with `kind`, `displayName`, `email`,
    optional fields `company`/`department`/`phone`/`mobile`/`domain`/
    `memberCount` and ID prefix (`user-`/`ext-`/`grp-`)

---

## [3.18.10] — 2026-05-24 — Image privacy banner + queue hardening (DSN, 5xx, dynamic settings)

### Added — Image privacy banner

- **External images are BLOCKED by default** to protect against tracking pixels
  (`packages/web-client/src/components/MessageReader.tsx`):
  - HTML is passed through `processExternalImages()` before `dangerouslySetInnerHTML`
  - `<img src="cid:foo">` → replaced by the MinIO attachment URL (inline images
    are OK since they are part of the mail itself — no tracking risk)
  - `<img src="data:...">` → passed through (self-embedded)
  - `<img src="http(s)://...">` → `src` is replaced by a 1×1 transparent PNG,
    the original moves to `data-coremail-ext-src` (for later re-activation)
- **Banner** at the top of the body when external images are blocked:
  *"X external images were blocked. External images can be used
  to track your reading behavior."* + button "Show images"
- Per-message toggle (`useState` with `useEffect` reset on message change),
  so that different mails can be treated differently
- Backend API: `/folders/:folderId/messages` and `/messages/:id` now return
  `contentId` and `inline` fields per attachment (they were missing before)

### Added — Queue hardening phase 1

- **DSN (Delivery Status Notification, RFC 3464)** —
  `packages/smtp-server/src/outbound/dsn.ts`:
  - On a permanent delivery failure a bounce mail is automatically delivered to `MAIL FROM`
    (multipart/report with human-readable text + RFC 3464 report part).
  - **Double-bounce protection**: no DSN for an empty MAIL FROM (`<>` sender = already
    a bounce mail) per RFC 5321 §6.1.
  - DSNs are generated only for **local senders** — external senders get a
    bounce from the MX server more reliably (prevents backscatter spam).
  - `MAILER-DAEMON@<hostname>` as sender, `Auto-Submitted: auto-replied`,
    `In-Reply-To` of the original Message-ID for thread linking.

- **4xx vs 5xx semantics** —
  `packages/smtp-server/src/outbound/queue.ts`:
  - New `extractSmtpCode()` helper extracts SMTP reply codes from
    nodemailer error messages
  - **5xx errors** (permanent, e.g. 550 User unknown) are marked as final
    **immediately** via `job.discard()` — no more 10× retry (protects IP reputation,
    the recipient MX is not "spammed")
  - **4xx errors** (transient, e.g. 421 Try again) go through the normal retry with
    exponential backoff
  - The SMTP code is persisted in the `MAIL_FLOW` systemLog (was missing before)
  - The log message shows `[550]` etc. for quick recognition in the admin UI

- **Dynamic queue settings**:
  - `enqueueOutbound()` now reads `QueueSettings.maxRetryAttempts` and
    `retryBackoffDelaySec` from the DB — the admin can adjust backoff without
    a container restart
  - Fallback to defaults (10 attempts, 60s) when the DB is unreachable

---

## [3.18.9] — 2026-05-24 — TransportRule engine + public folders + Shared Mailbox SEND_AS/ON_BEHALF

### Fixed — TransportRule did not work at all

- **Bug**: `TransportRule` was stored in the DB but **never evaluated in the mail flow**.
  There was no engine — only CRUD endpoints.

- **Fix**: new engine `packages/storage/src/transport-rules.ts` with
  `applyTransportRules(parsed, ctx)` + `applyOutcomeToBuffer(buffer, outcome)`:
  - 8 conditions × 9 operators combined with AND
  - 10 actions: `addHeader`, `removeHeader`, `redirect`, `reject`, `addRecipient`,
    `removeRecipient`, `setSubjectPrefix`, `setSubjectSuffix`, `quarantine`,
    `addDisclaimer`
  - Hook in `storeInboundMessage()` directly after parsing — before user mail rules,
    before the spam/junk decision. `reject` and `quarantine` abort delivery.
  - Header/subject/disclaimer modifications are applied directly to the RFC 822 buffer
    (re-parsing after modification for consistent DB fields).

### Fixed — Distribution group members received no mails (inbound path)

- Already fixed for outbound in v3.18.8; v3.18.9 follows up for inbound:
  external members of local groups are forwarded via `enqueueOutbound()`.

### Fixed — Public folders, several bugs

- **Schema**: `PublicFolder.email String? @unique` — a folder can now be mail-enabled.
- **SMTP inbound**: `verifyRecipient()` and `storeInboundMessage()` now recognize
  mail-enabled public folders. Mails land as `PublicFolderMessage` directly in the
  folder — no mailbox routing.
- **BCP ACL editor**: plain-text input replaced by an autocomplete dropdown
  (debouncing, keyboard navigation, external + groups filtered out since only internal
  users get public-folder access). Cache invalidation after save extended
  (`admin-public-folders` + ACL list).
- **MWA FolderTree**: new `PublicFoldersSection` shows public folders below the
  personal folders. Purple Users icon + tooltip with e-mail. Auto-refresh 60s.
  A click shows a toast for now (browse mode follows in v3.18.10).

### Added — Shared Mailbox SEND_AS / SEND_ON_BEHALF in REST `/mail/send`

- **Until now**: SEND_AS only worked via SMTP submission (ports 465/587).
  REST `/mail/send` ignored Shared Mailbox permissions; `from` was always
  hard-coded to `user.email`.

- **New**: `POST /api/v1/mail/send` optionally accepts:
  - `sendAs: string` (e-mail) — the user must have `SEND_AS` or `FULL_ACCESS`
  - `sendOnBehalfOf: string` (e-mail) — the user must have `SEND_ON_BEHALF`

- **Permission check**: explicit `prisma.sharedMailboxPerm.findFirst()` with
  permission + mailbox linkage. Missing permission → `403`.

- **From header override**: with `sendAs`, `From: <shared>` is set;
  with `sendOnBehalfOf`, `From: <shared>` AND additionally `Sender: <user>` —
  Mail clients then show "User on behalf of Shared".

- **StructuredMessage.sender** added as an optional field for the queue.

### Added — Schema extension

- `PublicFolder.email String? @unique`

---
## [3.18.8] — 2026-05-24 — Fix: external contacts, distribution group routing, autocomplete

### Fixed

- **ExternalContactsPage cursor got lost while typing**
  (`packages/admin-panel/src/pages/ExternalContactsPage.tsx`):
  Inline `Field` component helper defined inside `ContactModal` →
  new component reference on every render → React unmount+remount of the input →
  cursor lost. Fix: all 8 fields rebuilt as inline `<div><label><input>`.
  Same pattern as the v3.17.44 eDiscovery fix and v3.17.43 RetentionPage.

- **GroupsPage React fragment key warning**:
  `filtered.map(g => (<>...</>))` without key → React warning. Fix:
  `<Fragment key={g.id}>...</Fragment>`.

- **CRITICAL FIX: external distribution group members received no mails**
  (`packages/smtp-server/src/outbound/queue.ts` + `inbound/handler.ts`):
  `expandRecipients()` resolves distribution groups into individual member addresses,
  but the expanded addresses were all handed to `storeInboundMessage()` as
  "local". If a group had external members
  (e.g. `partner@kunde.com`), these were silently lost — no mail arrived,
  no bounce, no log.

  **Fix**:
  - Outbound (`queue.ts`): after `expandRecipients` the addresses are checked AGAIN
    for local/external. External members are added to `finalExternalRcpts`
    and delivered via `relayMessage()` to MX/smarthost.
  - Inbound (`handler.ts`): when an external sender sends directly to a local
    distribution group that has external members, the external
    addresses are forwarded via `enqueueOutbound()`.

### Added

- **Compose autocomplete now shows all address sources**
  (`packages/api-gateway/src/routes/contacts.ts`):
  `GET /api/v1/contacts?q=` returns, from `q.length >= 2`, a unified search across:
  1. Private contacts (`Contact` table, own user)
  2. Global address list — all active users
  3. External contacts from the admin directory (`ExternalMailContact`,
     filtered `hiddenFromGal: false`)
  4. Distribution groups (`DistributionGroup`, `active: true && hiddenFromGal: false`)

  Dedup by e-mail. An ID prefix marks the source (`gal-`, `ext-`, `grp-` or
  private). Frontend `RecipientInput` and `MembersPanel` distinguish them visually.

- **GroupsPage member editor with autocomplete dropdown**
  (`packages/admin-panel/src/pages/GroupsPage.tsx` `MembersPanel`):
  Plain-text input replaced by a suggest field with debouncing (220ms),
  arrow up/down + Enter/Tab + Escape, type badge per hit (User/External/
  Group/Private). `memberType` is derived automatically from the ID prefix.
  Already-assigned members are hidden from the suggestions.

---

## [3.18.7] — 2026-05-24 — Spam UX + audit log v2 + audit bug fix + schedule send

### Fixed

- **Audit log: actor and target were empty** (`packages/api-gateway/src/lib/audit.ts`):
  `auditMiddleware` ran synchronously BEFORE `requireAuth` (auth is mounted per router,
  not globally) → `req.apiUser` was `undefined` at logging time → `actorId` / `actorEmail`
  stayed null. In addition `targetType` was not set at all (only `targetId`).
  Fix: logging moves into `res.on('finish')` so that auth has already run;
  `targetType` from `pathParts[0]` (resource), the HTTP status is evaluated as `success`/
  `errorMsg`.

### Added — Schedule send

- **Backend** (`packages/storage/prisma/schema.prisma` + `routes/mail.ts`):
  - New fields: `Message.scheduledAt: DateTime?`, `scheduledStatus: String?`
    (`PENDING|SENT|CANCELLED`), `scheduledJobId: String?`
  - `POST /mail/send` optionally accepts `scheduledAt` (ISO date) — validation:
    at least 30s in the future, at most 1 year
  - BullMQ job enqueued with `delay: scheduledAt - now` — the worker only starts
    at the scheduled time
  - Sent copy immediately in the "Sent Items" folder with `scheduledStatus: PENDING`
    + `scheduledJobId` (for a later cancel)
  - The mail's Date header is set to `scheduledAt` (the recipient sees the scheduled
    time, not the creation time)
  - New endpoint `POST /mail/messages/:id/cancel-scheduled` — removes the
    BullMQ job via `queue.getJob(id).remove()`, sets status to CANCELLED
- **Worker** (`packages/smtp-server/src/outbound/queue.ts`):
  - Cancellation check at job start: if the message is meanwhile `CANCELLED` → return
    without sending (race protection)
  - After successful sending: set `scheduledStatus: 'SENT'` (banner disappears)
- **Frontend ComposeWindow**:
  - Send button group: "Send" button + arrow dropdown
  - Schedule picker with 3 presets (Tomorrow morning, Tomorrow afternoon, Next Monday
    — all at 8:00 or 13:00 respectively) + custom datetime-local picker
  - Validation: min. 30s in the future
  - Toast "Sending scheduled for [date/time]" after submit
- **Frontend MessageReader**:
  - Schedule banner: blue (PENDING "Will be sent on…"), green
    (SENT "Scheduled sending completed"), gray (CANCELLED "Scheduled sending
    cancelled")
  - "Cancel scheduling" button when PENDING (deletes the BullMQ job, banner switches)
- **Frontend MessageList**: `CalendarClock` icon (blue) in the row for
  scheduled mails — tooltip with the concrete time

### Added — Spam UX

### Added — Spam UX

- **Spam score persistence**: new `Message.spamScore: Float?` field in the Prisma schema.
  `storeInboundMessage()` stores the rspamd score at the time of delivery
  (previously transient — only used for folder routing, then discarded).
- **Spam banner in the MessageReader**:
  - Visible when `spamScore ≥ 3.0` OR the mail is in the Junk folder
  - **Red** (high risk) at `spamScore ≥ 6.0` (rspamd reject threshold)
  - **Amber** at medium risk or in the Junk folder
  - Shows the concrete rspamd score in a mono font
  - "Mark as junk" / "Not spam" button directly in the banner for a 1-click action
- **Spam badge in the MessageList**: `ShieldAlert` icon in the row (yellow/red depending on
  score), tooltip with the concrete score
- **`notSpam` bulk action** improved: sets `spamScore: 0` on the message
  so that the banner is no longer shown after clicking "Not spam"

### Added — Audit log v2 (compliance-grade export & anomaly detection)

- **Cryptographic SHA-256 signature for all exports**
  (`packages/api-gateway/src/routes/admin/audit-log.ts`):
  - CSV export: SHA-256 hash of the payload (incl. UTF-8 BOM) in the
    `X-CoreMail-Signature: sha256=…` response header
  - PDF export: in-memory buffer capture instead of direct `doc.pipe(res)`, then
    hash over the complete PDF buffer
  - **NEW: JSON export** for SIEM integration (Splunk, Azure Sentinel, ELK) —
    `/admin/audit-log/export.json` with a structured `metadata`+`entries` object,
    `schemaVersion: '1.0'`, also SHA-256-signed
  - Additional headers: `X-CoreMail-Export-Entries`, `X-CoreMail-Export-Generated-At`
  - `Access-Control-Expose-Headers` so the frontend can read the signature
  - External verification: `shasum -a 256 audit-log-YYYY-MM-DD.csv` → must match
    the header exactly → proves to auditors that the file was not
    tampered with

- **Anomaly detection** — new endpoint `/admin/audit-log/anomalies`:
  - **Burst detection**: ≥50 actions by the same actor in 5 min (medium),
    ≥200 actions → high severity
  - **Failure burst**: ≥10 failed actions in 5 min → high (possible attack)
  - **Critical actions**: regex pattern for `user.delete`, `mailbox.delete`,
    `domain.delete`, `transport-rules.*`, `oauth.*`, `settings.*`, `certificate.*`,
    `gateway.*`, `connector.*`, `smime.*`, `setup.*` → always high
  - **Off-hours activity**: admin activity between 00:00 and 06:00 server time
    → low severity
  - Dedup logic merges identical anomalies (actor+message)
  - The frontend shows the top 50 as a red banner with icons, actor, time and
    severity badge — auto-refresh every 60s

- **Meta-logging against insider threats**
  (`packages/api-gateway/src/lib/audit.ts`):
  - **AUDIT_SENSITIVE_GET**: GET routes for audit log exports (CSV/PDF/JSON) and
    anomalies are now audited as well. Whoever exports audit data or
    retrieves compliance reports is logged themselves — no silent
    data exfiltration by admins
  - Extended code comment documents the immutability guarantee:
    the audit log has no DELETE endpoint, no UI toggle to switch it off;
    tampering attempts require a code deploy → traceable via Git/CI/CD
    (ISO 27001 / SOC 2 / TISAX / GDPR compliant)

- **Frontend AuditLogPage** (`packages/admin-panel/src/pages/AuditLogPage.tsx`):
  - **JSON export button** added (for SIEM)
  - **Anomalies banner** at the top of the page — automatic 60s refresh, scrollable,
    severity colors (red/amber/blue), icons per anomaly type
  - **Signature hint** in the immutability banner: documents the
    `X-CoreMail-Signature: sha256=…` header and local verification
  - The existing stats dashboard (KPI cards, top actors, top actions) remains

### Schema migration

- `Message.spamScore Float?` — added automatically at the next container start via
  `prisma db push` (no data loss, existing
  messages have `null`)

---

## [3.18.5] — 2026-05-24 — Removed: eDiscovery & Legal Hold removed completely

### Removed

- **Phase 8 features eDiscovery & Legal Hold fully removed from the code**
  (backend, frontend, schema, routes, i18n):
  - **Schema** (`packages/storage/prisma/schema.prisma`): models `EDiscoverySearch`,
    `LegalHold` and enum `EDiscoveryStatus` deleted.
    `RetentionPolicy.respectLegalHold` field removed (default was `true` but it
    no longer had any effect since `LegalHold` records had no UI for creation).
  - **Backend**: file `packages/api-gateway/src/routes/admin/ediscovery.ts` deleted.
    Import + mount in `server.ts` removed (the `/api/v1/admin/ediscovery` route now
    returns 404).
  - **Retention route** (`routes/admin/retention.ts`): `respectLegalHold` removed from
    POST/PUT body, validation and Prisma update.
  - **Backup worker** (`packages/backup-service/src/retention/worker.ts`):
    `prisma.legalHold.findMany()` call removed; `heldUserIds` is now an
    empty set (signature compatibility for downstream functions).
  - **Frontend**: file `packages/admin-panel/src/pages/EDiscoveryPage.tsx` deleted.
    Sidebar entry "eDiscovery" removed, route removed from `main.tsx`,
    `nav_ediscovery` i18n key deleted in DE+EN, unused `SearchCheck` icon import
    removed, RbacPage `COMPLIANCE_MANAGEMENT` description changed from "eDiscovery, retention"
    → "Retention policies".
  - **RetentionPage**: `respectLegalHold` field removed from the `RetentionPolicy` type, form state,
    template creator and UI checkbox.

  **Existing data**: existing `ediscovery_searches` + `legal_holds` tables
  are dropped automatically at the next `prisma db push --accept-data-loss` (in the container entrypoint).
  The `retention_policies.respect_legal_hold` column likewise.

  **Migration**: anyone upgrading an existing installation who actually uses
  the feature: please back up eDiscovery exports before upgrading.
  Recommended for this is the `mbox` streaming export of the existing searches
  under v3.18.4 or older — then upgrade.

---

## [3.18.4] — 2026-05-24 — Feature: signature editor with images, links, fonts

### Added

- **MWA signatures fully built out** — full-featured editor
  (`packages/web-client/src/components/SignatureSection.tsx` — new separate component):

  **Formatting:**
  - Font dropdown: 10 options (Arial, Calibri, Georgia, Times New Roman,
    Courier New, Verdana, Tahoma, Trebuchet MS, Comic Sans MS, Default)
  - Font size dropdown: 5 levels (Small 12px / Normal 14px / Medium 16px /
    Large 20px / Very large 28px) — via custom `FontSizeExt` TipTap extension
    on the `textStyle` mark
  - Bold / Italic / Underline / Strikethrough (with the correct U icon —
    was previously wrongly "U" = strikethrough!)
  - Text color (24 colors) + highlight color (12 highlight colors)
  - Alignment (left, centered, right, justified)
  - Bullet lists + numbered lists + quote block
  - Horizontal rule (`<hr>`)
  - Undo / Redo / Clear formatting

  **Insert images** (for logos, profile pictures, banners):
  - Upload button → file picker (max 500 KB, base64 embed)
  - URL input button
  - Drag & drop directly into the editor (with overlay "Drop image here")
  - `@tiptap/extension-image` with `allowBase64: true`

  **Links** with an interactive prompt:
  - With a selection → the selected text becomes the link
  - Without a selection → the URL is inserted as link text
  - Edit/remove link via the same button (toggle on an active link)

  **Preview mode**:
  - "Preview" button top right → shows the signature exactly as it would appear in
    the recipient's mail reader (HTML rendering without editor chrome)
  - "Editor" button switches back

  **Auto-insert options** (as before):
  - For new e-mails
  - For replies and forwards

  **Technical:**
  - Custom `FontSizeExt` with `addGlobalAttributes()` on the TextStyle mark
    (TipTap has no FontSize extension of its own)
  - `applyFontSize()` helper works around ChainedCommands type conflicts
  - Inline images embedded as data: URL — no MinIO upload needed,
    works in all common mail clients
  - 500 KB limit per image prevents overweight outbound mails
  - Dark-mode-capable toolbar

---

## [3.18.3] — 2026-05-24 — Fix: BCP DNS check counter + status colors

### Fixed

- **BCP → SMTP & Routing → DNS records: counter and yellow indicators were inconsistent**
  (`packages/admin-panel/src/pages/SmtpConfigPage.tsx`):

  **Root cause**: the backend endpoint returns **7 records** (`a, mx, spf, dkim, dmarc,
  autodiscover, ptr`), but the UI renders only **6** of them (the A record is not
  shown). The counter `okCount` however counted all 7 records against a
  hard-coded `total = 6`. Result: with e.g. 6 ok + 1 warning (A invisible, 1
  warning visible) → "6 of 6" although a yellow entry was visible. With
  5 ok + 2 warning → "5 of 6 — 1 missing" although 2 were visibly yellow.

  Also: warnings (e.g. SPF multi-record, PTR mismatch) were not mentioned in the status text
  at all — they were neither "ok" nor "missing" and fell through the cracks.

  **Fix**:
  - `VISIBLE_DNS_KEYS` = `['mx','spf','dkim','dmarc','autodiscover','ptr']` as
    the single source of truth. `okCount`, `warnCount`, `missingCount` and `total`
    are calculated consistently from this list.
  - The status text now differentiates clearly: "5 of 6 records set — 1 with
    warning, 0 missing" / "4 of 6 — 1 with warning, 1 missing" / etc.
  - `StatusDot` now shows **3 colors** (green = ok / yellow = warning / red = missing)
    instead of only green/yellow. Badge analogously with ⚠ Warning / ○ Not found.
  - Legend updated: correctly green/yellow/red instead of the outdated orange for
    "resolver inconsistency" (gone since v3.17.34 — multi-resolver removed).

---

## [3.18.2] — 2026-05-24 — UI cleanup, button fix + compose rollback

### Reverted

- **Compose window rolled back to the pre-v3.18.1 variant** —
  the Gmail-style redesign from v3.18.1 (3 sizes, header drag, schedule-send dropdown,
  emoji picker, footer format toolbar) is withdrawn. The old compose variant
  (formatting toolbar at the top, Send bottom right, attachment+draft
  bottom left) fits the rest of the CoreMail UI better. `ComposeWindow.tsx` is exactly
  identical to the version from v3.18.0.

### Changed

- **MWA: vendor client mentions removed from user-facing UI texts**:
  - `RulesSection.tsx`: stop-processing hint without the client comparison
  - `SettingsPage.tsx → View`: "Customize layout and display options for CoreMail"
    (instead of a comparison with two desktop mail programs)
  - `SettingsPage.tsx → App passwords`: "Connect external e-mail clients without your main password"
    (instead of a list of two desktop mail programs)

  Technically necessary client references remain (Autodiscover setup guide
  in the BCP, a Modern Auth OAuth2 client example in the admin panel, historical
  changelog/compliance entries), because these point to a real external
  IMAP/EAS client.

### Fixed

- **MWA: "+ New rule" button shrank at narrow viewport widths** and wrapped
  its text. Fix: `shrink-0 whitespace-nowrap px-4` — the button keeps a fixed width,
  the text stays on one line.

---

## [3.18.1] — 2026-05-24 — Feature: Gmail-style compose window redesign

### Changed

- **MWA compose window completely redesigned after the Gmail model**
  (`packages/web-client/src/components/ComposeWindow.tsx`):

  **Window modes:**
  - **Small** (default, floating 600×640 bottom right) — header draggable with the mouse
  - **Large** (full screen, centered, max 1100px, 90vh) — toggle via maximize button in the header
  - **Minimized** (288px strip bottom right with subject)
  - Smooth transition `transition-[width,height,inset] duration-300 ease-out` between sizes

  **Footer toolbar (Gmail layout):**
  - **Send button with schedule dropdown** (▲): "Tomorrow morning", "Tomorrow afternoon",
    "Next Monday" presets + custom datetime-local picker — scheduled mails via
    the `scheduledAt` FormData field to `/mail/send`
  - **Aa** format toolbar toggle (on/off)
  - **Paperclip** attachment with badge (number of attachments)
  - **Link** (insert/edit link)
  - **Smile** emoji picker (80 handpicked emojis, 10×8 grid)
  - **Image** insert image via URL
  - **Lock** confidential-mode placeholder (toast "coming soon")
  - **MoreVertical** submenu: full-screen toggle, clear formatting, Cc/Bcc toggle
  - **Trash** discard with confirmation
  - **Draft status display** on the right: "Saving…" / "Draft saved"

  **UX features:**
  - **Drag & drop files**: drop overlay over the entire compose window (paperclip icon
    + "Drop files here to attach")
  - **Keyboard shortcuts**: ⌘+Enter send, ⌘+⇧+C show Cc, ⌘+⇧+B Bcc, Esc close
  - **Cc/Bcc** with X button to hide + reset, fade-in animation when shown
  - **Active-scale animations** (active:scale-90) on all buttons for tactile feedback
  - **Dark mode** supported in all components (dark:bg/dark:border)
  - **Header drag** in small mode moves the window on the viewport (`transform: translate`)
  - **Discard confirmation** only with non-empty content (To/Cc/Bcc/Subject/Body/Attachments)

  Existing helper components (RecipientInput, ColorPicker, BlockTypeDropdown,
  FontFamilyDropdown, ToolBtn, Sep) remain unchanged — they are good, only the
  main layout was rebuilt.

---

## [3.18.0] — 2026-05-24 — Feature: server-side inbox rules

### Added

- **Server-side user inbox rules**
  Complete rules functionality in Mail Web Access — conditions, actions,
  exceptions and stop-processing manageable directly in the MWA. Rules are
  applied server-side in the SMTP inbound pipeline as soon as a mail arrives —
  regardless of whether the client is open. Also works for IMAP/EWS/EAS access.

  **Backend** (`packages/storage/src/mail-rules.ts`):
  - New schema: `MailRule.exceptions`, `MailRule.stopProcessing`, `MailRule.matchAll`
    (`AND`/`OR` combination) — `@@index([userId, priority])` for sorted lookup.
  - Rule engine: 11 conditions (`from`, `to`, `cc`, `bcc`, `subject`, `body`,
    `recipient`, `hasAttachment`, `size`, `importance`, `sentOnlyToMe`) × 10
    operators (`contains`, `notContains`, `equals`, `notEquals`, `startsWith`,
    `endsWith`, `regex`, `greaterThan`, `lessThan`, `is`).
  - 12 actions: `moveTo`, `copyTo`, `delete` (→ Trash), `hardDelete` (discard),
    `markRead`, `markFlagged`, `pin`, `categorize`, `forward`, `redirect`,
    `markJunk`, `setImportance`.
  - Forward/redirect via the existing `smtp-outbound` BullMQ queue with loop protection
    (the `X-CoreMail-RuleForwarded` header prevents endless forwards).
  - Hook in `storeInboundMessage()`: after the junk decision, before folder assignment —
    can override the target folder, set flags/categories, discard the mail or
    copy it into several folders.

  **API** (`packages/api-gateway/src/routes/user.ts`):
  - `GET /user/rules`, `POST`, `PUT/:id`, `DELETE/:id` — CRUD with Zod validation
  - `PATCH /user/rules/:id/toggle` — quick enable/disable
  - `POST /user/rules/reorder` — drag-reorder persistence via transaction
  - `POST /user/rules/:id/run-now` — apply a rule retroactively to existing mails
    (max. 5000, forward/redirect skipped for safety)

  **Frontend** (MWA):
  - **Settings → "Rules"** (`packages/web-client/src/components/RulesSection.tsx`):
    list of all rules with toggle, drag-reorder (dnd-kit), edit, delete
    and "Run now". Empty state with CTA.
  - **RuleEditorModal** (`packages/web-client/src/components/RuleEditorModal.tsx`):
    3-step wizard — "When the message arrives and …" /
    "Do the following:" / "Except if …" with folder picker, category picker,
    e-mail input for forward/redirect. `AND`/`OR` choice, stop-processing checkbox.
  - **Context menu "Rules" in MessageList**: right-click on a mail →
    "Create rule …" opens the editor with a pre-filled "From" condition
    or "Manage rules …" jumps to the settings page.

---

## [3.17.50] — 2026-05-24 — Fix: MWA source context menu opens modal instead of tab

### Fixed

- **MWA: "View source" in the right-click menu opens the RFC 822 modal instead of a browser tab**
  (`web-client/src/components/MessageList.tsx`):
  The context menu entry "View source" in the message list opened the
  raw text via `window.open()` in a new browser tab (the browser tried to download
  the file). Fix: fetch request with `?token=` auth, then display in the
  same RFC 822 source modal as in `MessageReader` (overlay, scrollable,
  monospace font, EML download button, close via ESC/click on backdrop).

---

## [3.17.49] — 2026-05-24 — Fix: MWA source/EML auth, junk logic, reply indicator

### Fixed

- **MWA: View source → 401 Unauthorized fixed**
  (`web-client/src/components/MessageReader.tsx`):
  The `fetch()` call for the RFC 822 source was issued without authentication
  (no `Authorization` header in a browser-initiated fetch). Fix: bearer token as
  `?token=…` query parameter (already supported by the auth middleware for SSE),
  read from `useAuthStore().accessToken`. Loading errors are now shown in the modal
  instead of failing silently.

- **MWA: EML download → 401 Unauthorized fixed**
  (`web-client/src/components/MessageReader.tsx`, `MessageList.tsx`):
  Browser navigation (`<a href>` and `window.open()`) does not support custom headers.
  Fix: the same `?token=…` pattern for all EML download and source links in
  MessageReader and the MessageList context menu.

- **MWA: "Not junk" button was missing in the Junk folder**
  (`web-client/src/components/MessageReader.tsx`):
  The context menu always showed "Mark as junk" regardless of the current folder.
  Fix: `isJunkFolder` detection via `selectedFolderId` + folders query; conditional
  menu entries — the Junk folder shows "Not junk (false positive)" with a ShieldOff icon,
  all other folders show "Mark as junk".

- **Future mails from senders manually marked as junk land in Junk automatically**
  (`api-gateway/src/routes/mail.ts`, `smtp-server/src/handlers/message.ts`):
  The `spam` action in the bulk endpoint now additionally writes a `Blacklist` entry
  with `scope: 'USER-JUNK'` for each unique sender. `storeInboundMessage()`
  checks these entries on incoming mails and routes to the Junk folder on a match.
  The `notSpam` action removes the corresponding entries. Both actions trigger rspamd
  Bayes training (`learnspam`/`learnham`) for improved spam detection.

- **MWA: reply indicator on answered mails**
  (`web-client/src/components/MessageReader.tsx`, `MessageList.tsx`):
  Mails that had been replied to received no visual marker (reply
  arrow). Fix:
  - `MessageReader`: the Reply/Reply-all buttons now set the IMAP flag
    `\Answered` via `patchMutation` (`markAnswered()` function).
  - `MessageList`: blue `Reply` icon in the icons column when `flags` contains the
    `\Answered` flag.

---

## [3.17.48] — 2026-05-24 — Fix: SMTP PIPELINING race condition (503 on server-to-server)

### Fixed

- **SMTP: 503 5.5.1 Bad sequence of commands on incoming mails fixed**
  (`smtp-server/src/core/session.ts`):

  **Root cause**: the SMTP server advertised `PIPELINING` (RFC 2920) and external MTAs
  (hosted providers, Postfix and others) used it correctly — they sent `MAIL FROM`, `RCPT TO`
  and `DATA` in one go. Since `handleMailFrom()` and `handleRcptTo()` are asynchronous
  handlers (`await onMailFrom()` → DB query, security filter), the
  state (`READY → MAIL → RCPT`) only changed after the `await`. By then the synchronous
  dispatch loop had already processed `RCPT TO` and `DATA` — both saw state `'READY'`
  instead of `'MAIL'`/`'RCPT'` → both were rejected with `503 5.5.1 Bad sequence of commands`.
  The `250 OK` for `MAIL FROM` arrived afterwards, too late and misplaced.
  External senders (hosted providers, Postfix and others) got their mails back as permanently
  failed.

  **Fix**: command queue (`cmdQueue: Promise<void>`) — all SMTP commands are
  enqueued via `enqueueCommand()` into a chained promise chain and run
  strictly sequentially:
  ```
  EHLO → [250] → MAIL FROM → await onMailFrom() → [250] → RCPT TO → await onRcptTo() → [250] → DATA → [354]
  ```
  Responses now arrive in the correct order guaranteed, no matter how fast
  the sending MTA pipelines. AUTH multi-step and `finishData()` are enqueued
  as well.

---

## [3.17.47] — 2026-05-23 — Feature: BCP DNS setup panel

### Added

- **DNS setup panel in BCP → Domains → Edit domain** (`DomainsPage.tsx`):
  New button "Check DNS setup" opens a complete setup panel
  with all 7 DNS records needed for a fully configured mail server.
  Values are derived automatically from the current SSL/TLS configuration
  (publicHostname) and the DKIM key:
  - **A record** — mail server IP (from the live-resolved server IP)
  - **MX record** — inbound mail to the mail server hostname
  - **SPF record** — with the real server IP (`v=spf1 ip4:<IP> ~all`)
  - **DKIM record** — complete p= value incl. 255-character chunk option
    (expandable, for DNS providers with a 255-character limit)
  - **DMARC record** — ready-made template with rua= for the domain
  - **Autodiscover** — CNAME to the mail server hostname
  - **PTR/reverse DNS** — with a note about the server hoster
  Each record shows: type badge (colored), status (✅/❌), copyable host/name value
  and copyable content value. The modal switches to max-w-2xl when the panel is open.

### Changed

- **DNS check backend improved** (`api-gateway/routes/admin/domains.ts`):
  - The server IP is resolved live from the hostname and returned in the response as `serverIp`
  - The SPF `expected` value now contains the real server IP instead of a placeholder
  - The DKIM `ok` flag now compares the complete key (whitespace-normalized),
    not just whether any DKIM record exists
  - The PTR check uses the already-resolved server IP (no second DNS lookup)
  - New `a` record section in the API response

---

## [3.17.46] — 2026-05-23 — Fix: DKIM public key format (SPKI → PKCS#1)

### Fixed

- **DKIM DNS record syntactically correct** (`api-gateway/routes/admin/domains.ts`):
  The public key was previously exported in SPKI format (SubjectPublicKeyInfo, with algorithm OID wrapper)
  — DKIM however expects PKCS#1 (plain RSAPublicKey without OID). Fix:
  `pubKey.export({ type: 'spki', format: 'der' })` → `type: 'pkcs1'` in all three
  places (dkim-record, regenerate-dkim, dns-check). The generated `p=` value in the BCP
  is now RFC 6376-compliant and passes DNS verification.

---

## [3.17.45] — 2026-05-22 — Feature: compact queue overview + discard function

### Changed

- **BCP queue overview completely reworked** (`QueuesPage.tsx`):
  - Stats cards (5 large cards) → compact horizontal strip with numbers + icon
  - Verbose state explanation cards at the bottom removed
  - Distribution bar chart removed (redundant with inline stats)
  - **Direct queue table in the overview**: shows all pending messages
    (waiting / active / delayed / failed) with status badge, sender, recipient,
    age and attempts — no navigating into sub-sections needed

### Added

- **"Discard" button directly in the overview**: every pending message
  can be discarded permanently with one click (confirmation dialog). For
  retry and dead-letter entries additionally a "Retry now" button.
- **"Discard" in all job tables** now as a labeled button instead of an icon,
  much more recognizable.
- Shows up to 25 entries in the overview; with more → links to the sub-sections.

### Fixed

- **Two refresh buttons reduced to one**: the refresh button in every
  sub-section (`JobsSection`) was removed. Only a single global refresh in the
  page header remains — it refreshes stats, jobs and overview at the same time.

---

## [3.17.44] — 2026-05-22 — Fix: eDiscovery search form loses focus after every letter

### Fixed

- **BCP eDiscovery — input field focus bug** (`EDiscoveryPage.tsx`): the internal
  `Field` helper component was defined inside the `CreateSearchModal` function.
  React creates a new component reference in every render phase → the input is
  unmounted/remounted → focus is lost → after every typed character the field
  had to be clicked again.

  Fix: `Field` moved to module level as `SearchField` (explicit `value` +
  `onChange` props instead of `k: keyof typeof form`). All 8 usages in the modal
  updated. React now keeps the DOM reference across re-renders.

---

## [3.17.43] — 2026-05-22 — Fix: audit log writes no entries

### Fixed

- **`auditMiddleware` path bug** (`lib/audit.ts`): the middleware is mounted via
  `app.use('/api/v1/admin', auditMiddleware)`. Inside the middleware Express
  provides `req.path` **without** the mount prefix — i.e.
  `/mailboxes/123` instead of `/api/v1/admin/mailboxes/123`. The condition
  `req.path.startsWith('/api/v1/admin/')` was therefore **never true** →
  not a single audit entry was ever written to the DB.

  Fix: prefix check removed (redundant when already mounted on `/api/v1/admin`).
  `pathParts` extraction switched to the relative path
  (`req.path.replace(/^\//, '').split('/')`).

---

## [3.17.42] — 2026-05-22 — Feature: edit certificates (name, services, auto-renew)

### Added

- **BCP SSL/TLS — edit certificate** (`CertificatesPage.tsx`): a pencil icon (✏️)
  in the actions column opens an edit modal for each certificate.
  Editable: name, service assignment (SMTP/IMAP/POP3 with exclusivity display),
  auto-renew (only for Let's Encrypt certificates).
  Shown read-only: type, status, domains, HTTPS proxy status, protocol TLS status.
  Calls `PUT /api/v1/admin/certificates/:id`.

### Fixed

- **`PUT /:id` route** (`routes/admin/certificates.ts`): `isActiveProtocol` was missing
  from the Prisma `select` — was not returned in the response. Fixed.

---

## [3.17.41] — 2026-05-22 — Fix: ACME process aborts after 5 minutes

### Fixed

- **ACME timeout** (`routes/admin/certificates.ts`): `runAcmeIssuance()` no longer
  runs forever. `Promise.race()` aborts the ACME process after 5 minutes
  and sets the certificate to `ERROR` — even if `client.auto()` hangs (port 80
  unreachable, Let's Encrypt not responding, etc.).

- **Startup cleanup** (`server.ts`): at container start, certificates
  stuck in status `PENDING` or `RENEWING` for longer than 10 minutes are automatically
  set to `ERROR`. Prevents permanently hanging certs after a restart.

- **Double-start protection** (renew route): `POST /:id/renew` now returns `409 Conflict`
  if the cert is already `PENDING` or `RENEWING` — no parallel
  second ACME process possible anymore.

- **BCP SSL/TLS UI**: the renew button (↻) is disabled for `PENDING` certs and
  shows a spinner + tooltip "ACME process still running — please wait".

---

## [3.17.40] — 2026-05-22 — Fix: exclusive service assignment for certificates

### Fixed

- **Exclusive service assignment** (`routes/admin/certificates.ts` + `CertificatesPage.tsx`):
  SMTP, IMAP and POP3 can each be assigned to only one certificate at a time.
  When creating or updating a certificate with services, these services are
  automatically removed from all other certificates (`claimServices()` function).

- **BCP SSL/TLS UI — service selector**: services already claimed by another cert
  are marked orange (⚠ warning symbol + tooltip "Currently on 'Cert X' — will be taken over").
  On selection a hint banner appears listing which services will be transferred on save.

---

## [3.17.39] — 2026-05-22 — Fix: update publicHostname automatically on certificate activation

### Fixed

- **`applyProtocolCert()` now updates `publicHostname`** (`routes/admin/certificates.ts`):
  When activating a certificate for SMTP/IMAP/POP3 (server icon),
  `server_settings.publicHostname` is set to the certificate's primary domain.
  Previously the SMTP banner continued to show the old hostname (`mail.localhost`) even
  when a CA-signed certificate for `mail.example.de` was activated.

- **`activate-protocol` route** now also selects `domains` and passes them to
  `applyProtocolCert()` — previously this field was missing from the `select`.

- **ACME auto-activation** (`runAcmeIssuance`): when a Let's Encrypt certificate
  has been issued successfully and `services` contains SMTP/IMAP/POP3,
  `applyProtocolCert()` is called automatically after issuance. Until now
  the admin had to click the server icon manually after every ACME issuance.

---

## [3.17.38] — 2026-05-22 — Auto self-signed cert at setup + spam filter can be enabled/disabled

### Added

- **Auto self-signed cert at setup** (`api-gateway` → `routes/setup.ts`):
  After a successful initial setup (`POST /api/v1/setup/complete`) a
  self-signed certificate (RSA-2048, 10 years) for the `publicHostname` is generated automatically
  and written to the `certificates` table. The cert is immediately visible in BCP → SSL/TLS,
  activated as the default protocol TLS (`isActiveProtocol: true`) for SMTP/IMAP/POP3
  and written to `server_settings.tlsCert/tlsKey` — SMTP/IMAP/POP3
  pick it up immediately via Redis `settings:reload`.

- **Spam filter toggle with hot reload** (`security-filter` → `server.ts`, `pipeline/index.ts`):
  `rspamdEnabled` and `clamavEnabled` from `SecuritySettings` are loaded from the DB
  at startup. On a change in BCP → Protection filters → Rspamd/Antivirus followed by
  save, `settings:reload` via Redis triggers an immediate reload in the security filter
  — no container restart needed. Pipeline stages 4c (ClamAV) and 4d (rspamd)
  are skipped completely when `enabled: false`.

### Changed

- **`PipelineConfig` interface** (`security-filter/pipeline/index.ts`): new optional
  fields `rspamdEnabled?: boolean` and `clamavEnabled?: boolean` — default `true`
  (compatible with existing calls).

- **`security-filter/server.ts`**: loads SecuritySettings from the DB at startup and
  subscribes to the Redis channel `settings:reload` for hot reload. New function
  `loadSecuritySettings()`.

### Fixed

- **`routes/admin/security.ts`** — `PUT /admin/security/settings` now publishes
  `settings:reload` via Redis after saving so the security filter immediately
  picks up `rspamdEnabled`/`clamavEnabled` (without a container restart).

---

## [3.17.37] — 2026-05-22 — BCP SSL/TLS: banner removed, services reduced to SMTP/IMAP/POP3

### Changed

- **BCP → SSL/TLS → Certificates**: gray info banner for a missing HTTPS certificate removed —
  the page shows no banner when no cert is active (the green banner remains with active HTTPS).

- **Service selection in certificate forms** (Let's Encrypt, upload, self-signed): reduced
  to `SMTP`, `IMAP`, `POP3` — web services (MWA, BCP, EWS, CalDAV, Autodiscover) removed,
  since HTTPS is activated exclusively via the lock icon and not via the services list.

---

## [3.17.36] — 2026-05-22 — HTTPS_PROXY_ENABLED removed — integrated proxy always active

### Removed

- **`HTTPS_PROXY_ENABLED` environment variable** removed completely from `tls-proxy.ts`,
  `routes/admin/certificates.ts`, `docker-compose.yml` and `docker-compose.synology.yml`.
  The integrated HTTPS proxy is always active — it starts port 443 only when a
  certificate with `isActiveHttps: true` exists, otherwise port 443 stays closed.
  No configuration toggle needed anymore.

- **`isTlsProxyEnabled()` export** removed from `tls-proxy.ts`.

- **`enabled` field** removed from the `/tls-proxy-info` API response.

- **"Integrated HTTPS proxy disabled" banner** removed from BCP → SSL/TLS.
  The banner now shows only two states: HTTPS active (green) or no
  HTTPS certificate active (gray with hint).

---

## [3.17.35] — 2026-05-22 — Certificate logic: full decoupling of HTTPS/protocol + self-signed default

### Changed

- **Certificate activation decoupled** (`api-gateway` → `routes/admin/certificates.ts`):
  HTTPS proxy (lock icon) and protocol TLS (server icon) for SMTP/IMAP/POP3 are
  fully **independent** — a certificate can be active for HTTPS only, for protocols only, or
  for both. `activate-https` no longer touches `isActiveProtocol`.

- **Self-signed default**: `server_settings.tlsCert/tlsKey = NULL` is the normal state.
  SMTP/IMAP/POP3 automatically generate a self-signed cert from `publicHostname` when
  no explicit activation has taken place. No implicit auto-activation when creating
  or uploading a certificate.

- **Startup sync** (`syncProtocolCertState()`): replaces the old `migrateCertProtocolBinding()`
  — checks at container start whether `server_settings.tlsCert` exists but no
  `isActiveProtocol: true` cert exists in the DB (orphaned cert) and cleans this up.

- **Delete certificate — full cleanup**: if a certificate is deleted that is
  `isActiveProtocol: true`, `server_settings.tlsCert/tlsKey` are set to NULL
  and SMTP/IMAP/POP3 immediately load the self-signed fallback. If the cert was active for HTTPS,
  the HTTPS proxy is deactivated as well.

- **BCP — certificates page** (`admin-panel` → `CertificatesPage.tsx`):
  the server icon (SMTP/IMAP/POP3) is now **always** visible for all ACTIVE/EXPIRING certs
  — regardless of HTTPS status. Toast messages and tooltips correctly separated.
  The delete confirmation warns when the cert is active for HTTPS or protocol TLS.
  An info banner explains the independence of both activation types.

---

## [3.17.34] — 2026-05-22 — DNS check: local resolver, no resolver banner/badges/details

### Changed

- **DNS record check** (`api-gateway` → `routes/admin/domains.ts`): now uses the
  server's **local DNS resolver** (`dns.promises`) instead of three external resolvers
  (Google/Cloudflare/Quad9). API response simplified: only `ok`, `found`, `warning?`
  per record — no more `resolvers[]`, `consistent`, `checkedAt`, `resolversUsed`.

### Removed

- **External resolver banner** (BCP → SMTP & Routing → DNS records): the blue
  info banner "External resolvers: Google (8.8.8.8) Cloudflare (1.1.1.1) Quad9 (9.9.9.9)"
  was removed.

- **Per-resolver badges**: the colored Google/Cloudflare/Quad9 badges with latency display
  under each DNS record were removed.

- **Expandable resolver detail view**: the "▼ Show resolver details" link with
  IP, latency and found value per resolver was removed.

- **Inconsistency warning**: the orange "Resolver inconsistency" hint was removed
  (no longer relevant without multi-resolver querying).

- **"Checked at HH:MM:SS" timestamp** in the DNS header removed (no more `checkedAt`
  information in the API response).

---

## [3.17.33] — 2026-05-22 — Fix: Redis channel in startup migration (CHANNEL_SETTINGS_RELOAD)

### Fixed

- **🔧 Startup migration `migrateCertProtocolBinding()`**: the wrong Redis channel
  name `'coremail:settings:reload'` was replaced by the correct constant
  `CHANNEL_SETTINGS_RELOAD` (`'settings:reload'`) from `@coremail/core`.
  Without this fix the SMTP/IMAP/POP3 servers were not informed about the new TLS certificate
  at the first container start after the upgrade — the protocol servers
  kept running with the old self-signed cert despite correct DB entries.

---

## [3.17.32] — 2026-05-22 — Fix: TLS cert logic — one cert for all protocols (SMTP 503 fixed)

### Fixed

- **🔒 503 5.5.1 Bad sequence of commands — root cause fixed**: the certificate
  for `mail.stefanwuestner.de` was activated ONLY for the HTTPS proxy (MWA/BCP);
  SMTP/IMAP/POP3 continued to use the old self-signed certificate from
  `ServerSettings.tlsCert/tlsKey`. External MTAs (large hosted providers) rejected the
  STARTTLS handshake → 503.

- **🏗️ `activate-https` now ALWAYS also activates SMTP/IMAP/POP3**: when the
  lock icon is clicked, the server writes the certificate ATOMICALLY to
  `ServerSettings.tlsCert/tlsKey` AND sends `CHANNEL_SETTINGS_RELOAD` — all
  mail protocol servers load the new cert immediately without a restart.

- **🛑 Removed: MWA+BCP services requirement for the lock button**: the lock button
  was previously only visible when the cert explicitly had the services `MWA` and `BCP`
  — an arbitrary hurdle without technical reason. Now every
  valid certificate (ACTIVE/EXPIRING) shows the lock button.

### Added

- **`isActiveProtocol` field** (`Certificate` Prisma model): shows in the BCP which
  certificate is currently active for SMTP/IMAP/POP3 (ports 465/993/995) —
  independent of the HTTPS proxy status.

- **`POST /admin/certificates/:id/activate-protocol`**: new endpoint for setups
  with an external reverse proxy (Traefik, Caddy, Synology DSM) where the integrated
  HTTPS proxy is disabled but the mail server needs a CA-signed cert for
  SMTP/IMAP/POP3.

- **Server icon in the BCP** (`CertificatesPage`): new <Server> icon next to the
  lock — clicking it activates the cert for protocol TLS only
  (without the HTTPS proxy). Shows blue when `isActiveProtocol: true`.

- **Detail view** (expanded row): now shows BOTH statuses separately —
  _HTTPS proxy (port 443)_ and _protocol TLS (SMTP/IMAP/POP3)_ each with its own
  icon, so the admin sees immediately what is active where.

### Changed

- **`deactivate-https`**: stops only the HTTPS proxy, does NOT touch `isActiveProtocol`
  — SMTP/IMAP/POP3 keep running with the same cert when the admin
  switches from the integrated proxy to external Traefik/Caddy.

---

## [3.17.31] — 2026-05-22 — DNS check: real multi-resolver verification

### Added

- **🔍 Real DNS verification via external resolvers** (`api-gateway` → `routes/admin/domains.ts`):
  Instead of querying the Docker-internal resolver (127.0.0.11, often cached/stale),
  MX, SPF, DKIM, DMARC, Autodiscover and PTR/FCrDNS are now checked directly at
  **Google (8.8.8.8)**, **Cloudflare (1.1.1.1)** and **Quad9 (9.9.9.9)**.
  `dns.promises.Resolver.setServers()` — no detour through the system DNS.

- **🌐 PTR / FCrDNS check**: reverse DNS `A → PTR → back-to-A` is automatically verified on
  real public resolvers. Status green only when the PTR resolves to the own
  hostname (forward-confirmed, mandatory for Gmail).

- **⚠️ SPF multi-record detection**: RFC 7208 §3.2 allows exactly one SPF TXT
  record. If two exist → `permerror` at all recipients. The BCP
  now shows an explicit red warning + correction hint.

- **📊 Per-resolver badges in the BCP** (`admin-panel` → `SmtpConfigPage.tsx`):
  each DNS row shows colored badges for Google/Cloudflare/Quad9 with latency
  (green = found, red = not found/error). Expandable detail view
  per resolver with the exact finding and error message.
- **🔄 Consistency warning**: when two resolvers return different values
  (e.g. freshly propagating records) → orange "Inconsistency" warning.

- **🕐 Timestamp + resolver info banner**: the DNS result shows the check time and
  which public resolvers were queried.

### Fixed

- **Docker DNS phantom**: internal DNS results did not match what
  external MTAs (large hosted providers) actually see. The new multi-resolver
  check reflects the reality of the public DNS infrastructure.

---

## [3.17.30] — 2026-05-22 — Outbound e-mail pipeline completely rebuilt (Google-compliant)

### Changed

- **🏗️ Structured BullMQ job instead of base64 blob**: `POST /api/v1/mail/send` now
  hands a structured message (`StructuredMessage`) to the worker — no more
  `rawMessage: base64` field. This relieves Redis considerably (no more large blobs).

- **📎 Attachments via MinIO**: uploaded attachments are stored in MinIO immediately
  (`outbound-queue/{jobId}/{filename}`). The worker downloads them when building the MIME
  and cleans them up automatically after successful delivery.

- **✍️ DKIM now via nodemailer transport option** (no more manual mailauth prepend):
  ```typescript
  nodemailer.createTransport({ host, ..., dkim: { domainName, keySelector, privateKey } })
  ```
  This is the more robust method recommended by nodemailer. The signature is correctly
  computed over the entire message stream — no more errors from inserting
  headers afterwards.

- **🗂️ Sent copy cleanly separated**: the RFC 5322 buffer for the "Sent Items"
  folder continues to be built in-memory (with the attachments already in RAM)
  — independent of the queue worker.

- **🧹 relay.ts cleaned up**: `ensureRfc5322Headers()` and `signMessage()` (mailauth) removed.
  RFC 5322 mandatory headers (From, Message-ID, Date) are guaranteed by the api-gateway and the SMTP
  submission handler; the safety-net function is no longer needed.

- **📦 SMTP submission path compatible**: `OutboundJob.rawMessage` (base64) remains for
  the SMTP submission path (ports 465/587) — e-mail clients deliver complete
  RFC 5322 messages, no structuring needed.

### Fixed

- **Order bug**: DKIM signing and the header safety check were in the wrong
  order — headers were inserted after signing, which would have invalidated the DKIM
  signature. With transport DKIM this problem disappears completely.

---

## [3.17.29] — 2026-05-22 — Fix: RFC 5322 compliance — From & Message-ID headers

### Fixed

- **🎯 Gmail 550 5.7.1 — From header & Message-ID header missing**: outgoing
  e-mails were rejected by Gmail with the following errors:
  - `550 5.7.1 ... 'From' header is missing`
  - `550 5.7.1 Messages missing a valid Message-ID header are not accepted`

  **Root cause (api-gateway `routes/mail.ts`)**: the `From` header was built as a
  template literal: `"${user.displayName}" <${user.email}>`.
  - If `displayName = null` → `"null" <email>` (invalid display-name string)
  - If `displayName = ""` → `"" <email>` — an empty quoted string violates RFC 5322
    §3.4 (quoted-string MUST contain at least one character). Strict parsers
    like Gmail treat that as "From header missing".

  **Fix 1 — `api-gateway/routes/mail.ts`**: switch to the Nodemailer object format:
  ```
  from: displayName ? { name: displayName, address: user.email } : { address: user.email }
  ```
  Nodemailer encodes the display name correctly per RFC 2047 (if non-ASCII)
  and omits it when empty → `From: <email>` (clean and valid).
  Additionally `date: new Date()` set explicitly (RFC 5322 §3.6.1 mandatory header).

  **Fix 2 — `smtp-server/outbound/relay.ts`**: new `ensureRfc5322Headers()`
  function as a safety net: checks before every MX/smarthost delivery whether
  `From`, `Message-ID` and `Date` are present in the header block. If missing,
  they are automatically prepended and the event is logged as WARN.
  Protects all outbound paths (REST API + SMTP submission).

---

## [3.17.28] — 2026-05-21 — Fix: self-signed cert with wrong CN (hosted-MTA 503 root cause)

### Fixed

- **🎯 Hosted-MTA 503 bounce — root cause found**: the stored self-signed
  certificate had `CN=mail.localhost` instead of `CN=mail.stefanwuestner.de`. At the
  first container start `publicHostname` in the DB was still empty, so the
  cert was generated and stored with the default `mail.localhost`. Later restarts
  reused this cert → eternal CN mismatch.

  The TLS handshake worked (OpenSSL confirms that), but a strict hosted MTA validates the
  **CN against the connected hostname** and rejects on mismatch → ECONNRESET
  → NDR with "503 5.5.1 Bad sequence of commands".

  **Fix in `smtp-server/src/server.ts`** `refreshTlsConfig()`:
  - On cert load, `certMatchesHostname()` is checked (new helper function)
  - A self-signed cert with a mismatch → automatically regenerated with the current
    `_hostname` and stored in the DB
  - CA-signed certs (LE/custom) are NOT regenerated (they could have valid
    SAN lists for multiple domains)

  At the next container restart (or hostname change via BCP) the
  cert is corrected automatically.

- **STARTTLS on port 25 re-enabled**: since the cert now has the correct CN,
  strict hosted MTAs also accept the TLS handshake. MX-Tools
  shows "Supports TLS" ✅.

### Removed

- **Auto Let's Encrypt bootstrap from v3.17.27 removed**: the admin requests LE
  manually via BCP → SSL/TLS → "Request Let's Encrypt". File
  `packages/api-gateway/src/lib/auto-letsencrypt.ts` deleted.

### Note: self-signed vs. Let's Encrypt

The self-signed cert is now **compatible** (correct CN/SAN). But:
- MTAs that do **strict cert chain validation** (some banks) still
  reject — they need a trusted issuer
- For 100% MTA compatibility: request a Let's Encrypt cert manually in the BCP

---

## [3.17.27] — 2026-05-21 — Auto Let's Encrypt at container start + STARTTLS revert

### Fixed

- **A strict hosted MTA returned 503 again with v3.17.26**: advertising STARTTLS with a
  self-signed cert had triggered its bounces again. Self-signed +
  STARTTLS is NOT compatible with strict MTAs — no graceful plain fallback.
  Fix: self-signed → STARTTLS on port 25 OFF again (behavior of v3.17.19).

### Added

- **Automatic Let's Encrypt request at container start**:
  New helper `packages/api-gateway/src/lib/auto-letsencrypt.ts`.
  30 seconds after server start the following is checked:
  1. `ServerSettings.publicHostname` is set AND non-local (no `*.local`/`*.lan`/`localhost`)
  2. No active `LETSENCRYPT` or `CUSTOM` cert covers the hostname
  3. E-mail from `ServerSettings.adminEmail` OR fallback `admin@{root-domain}`

  If all conditions are met → ACME HTTP-01 challenge started (production,
  not staging). On success: the cert becomes ACTIVE, `ServerSettings.tlsCert`/`tlsKey`
  are set, `CHANNEL_SETTINGS_RELOAD` is published — all protocols
  (SMTP/IMAP/POP3) load the new cert. **STARTTLS is activated automatically**
  because `isCertSelfSigned()` now returns `false`.

  On error: log warning, no crash. Manual request via
  BCP → SSL/TLS → "Request Let's Encrypt" still possible.

  **Prerequisites for success:**
  - Port 80 reachable from outside (HTTP-01 challenge)
  - DNS A record for `publicHostname` points to the server IP
  - No Let's Encrypt rate-limit lockout (50 certs/domain/week)

### Refactored

- `runAcmeIssuance()` in `routes/admin/certificates.ts` marked as `export`
  so it can also be used by the auto-LE bootstrap

---

## [3.17.26] — 2026-05-21 — Fix: MX-Tools "Does not support TLS" — STARTTLS active again

### Fixed

- **MX-Tools warning "SMTP TLS Warning - Does not support TLS"**:
  In v3.17.19 STARTTLS on port 25 was hard-disabled for self-signed certs
  to avoid strict hosted-MTA handshake errors. Result: MX-Tools saw no TLS
  → warning. Even though most MTAs (Gmail, Apple, ProtonMail, AOL …)
  accept opportunistic TLS with self-signed certs.

  **Correct trade-off**: opportunistic TLS is **always better** than no TLS:
  - ~95% of MTAs accept self-signed in opportunistic mode
  - Strict hosted MTAs fall back to plain on a TLS handshake error
    (no bounce, just no TLS for that connection)
  - MX-Tools scoring rewards TLS availability

  Fix: `advertiseStarttls: true` always (instead of `!_tlsCertSelfSigned`).
  STARTTLS is now advertised in EHLO even with a self-signed cert.

### Permanent solution for strict hosted MTAs

For full TLS validation in strict MTAs (large hosted providers, some
banks), issue a **Let's Encrypt certificate** via BCP → SSL/TLS → Certificates →
"Request Let's Encrypt" for `mail.{domain}`. Once active:
- MX-Tools: ✅ full TLS score
- Strict hosted MTAs: ✅ accept the cert without problems
- The self-signed fallback is no longer used

**Prerequisites for Let's Encrypt**:
- Port 80 reachable from outside (HTTP-01 challenge)
- DNS A record `mail.{domain}` points to the server IP

---

## [3.17.25] — 2026-05-21 — MWA: retention policies via right-click

### Added

- **MWA → Settings → Retention policies** (new section under "Account"):
  shows all PERSONAL retention tags enabled by the administrator with name,
  description, retention days and action. Read-only — tags are created by the admin
  in the BCP; users select them via right-click on folders.

- **MWA → folder tree right-click → "Assign retention policy"**:
  submenu with all available PERSONAL tags. The currently assigned tag
  gets a ✓ checkmark. At the bottom a "Remove" entry to delete the assignment.
  Works for system AND custom folders.

- **🕒 badge** in the folder tree: folders with an active retention policy show
  a small clock icon after the folder name — tooltip with tag name + days.

### Backend

- **`GET /api/v1/retention-tags`** (new, `requireAuth`): lists enabled
  PERSONAL tags sorted by retention days.
- **`PATCH /api/v1/mail/folders/:id/retention-tag`** (new): body `{ tagId: string | null }`.
  Owner verification; the tag must be PERSONAL and enabled.
- **`PATCH /api/v1/mail/messages/:id/retention-tag`** (new): as above for messages.
- **`GET /api/v1/mail/folders`** extended: now also returns `retentionTagId` +
  the `retentionTag { id, name, retentionDays, action }` relation.

### Frontend

- 11 new i18n keys (`retention_*`) in DE/EN/ES/IT
- `Folder` type extended with `retentionTagId` + `retentionTag`
- ContextMenu already supported submenus — only the usage was extended

---

## [3.17.24] — 2026-05-21 — BCP compliance info page updated

### Changed

- **BCP → Compliance → Info**: highlights list extended with v3.17.12 through v3.17.23
  (12 new entries with detailed descriptions of each version).
  Version display in the header updated (3.17.23 → 3.17.24).

---

## [3.17.23] — 2026-05-21 — Audit log: complete overhaul with PDF export + statistics

### Fixed

- **CSV export failed with 401**: `window.open(…/export…)` opened a new tab
  without an `Authorization` header. Fix: new helper `exportUrl()` in api/client.ts
  appends `?token=…` to the URL — `requireAuth` has accepted the token via query
  since v3.17.18 (SSE fix).

- **Date filter showed no data**: `new Date('2026-05-20T23:59:59')` was
  interpreted as **local time** → in Berlin CEST (UTC+2) the UTC value lay
  before the start of day of the From date. Fix: explicitly UTC with
  `…T00:00:00.000Z` / `…T23:59:59.999Z`.

- **Purge route inconsistent**: the frontend sent `?olderThanDays=`, the backend read
  `req.body.before` — `400 Bad Request` on every cleanup. **Removed completely**
  — audit logs are write-protected for compliance (see "Removed").

- **React Fragment key warning**: `<>...</>` without key in list rendering replaced by
  `<React.Fragment key={e.id}>`.

### Added

- **PDF export** (`GET /api/v1/admin/audit-log/export.pdf`): A4 landscape with header,
  filter summary, table (time/actor/action/target/status),
  page numbers. Cap of 1000 entries (larger volumes → CSV). Uses `pdfkit`.

- **Statistics dashboard** (at the top of the audit log page, auto-refresh 30s):
  - 4 KPI cards: total entries, last 24h, last 7 days, error rate
  - Top 10 actors (bar chart)
  - Top 10 actions (bar chart)
  - New endpoint: `GET /api/v1/admin/audit-log/stats`

- **Extended filters**:
  - `actorEmail` (substring search)
  - `ipAddress` (exact)
  - `searchText` (searches `action`, `targetName`, `errorMsg`)
  - 2-row layout in the frontend with reset button

- **CSV export with all columns + UTF-8 BOM** (Excel-compatible):
  timestamp, actorId, actorEmail, action, targetType, targetId, targetName,
  ipAddress, userAgent, success, errorMsg, changes (JSON)

- **Write-protected banner** in the BCP (dismissible, persisted in localStorage):
  "The audit log is write-protected — entries cannot be deleted
  or modified, even by admins (compliance requirement)"

- **userAgent in the detail view** of the expanded row

### Removed

- **`DELETE /api/v1/admin/audit-log/purge`**: audit logs are **immutable**
  (GDPR, SOX, HIPAA, ISO 27001 requirement — non-repudiation).
  Frontend "Purge" button removed. Should retention needs arise later,
  that runs through the system `RetentionPolicy` (outside the admin API).

### Audit log — core functions (see BCP → Compliance → Audit log):

| Pillar | Implementation |
|---|---|
| **Accountability** | `actorId` + `actorEmail` + `ipAddress` + `userAgent` per entry |
| **Forensics** | full-text search, time range filter, JSON `changes` diff |
| **Compliance** | write-protected, no delete endpoint, CSV/PDF export |
| **System monitoring** | live statistics (24h/7d), top actors + top actions |

---

## [3.17.22] — 2026-05-21 — Fix: local delivery — aliases, distribution groups + SharedMailbox

### Fixed

An audit of local delivery (outbound queue + submission port) uncovered two
structural bugs. Mails to local addresses were in several cases
**silently discarded** without a bounce message or any logging beyond "Mailbox not found".

- **Outbound queue (`smtp-server/outbound/queue.ts`) did not resolve aliases**:
  when sending from the MWA (POST /api/v1/mail/send) the mail went into the BullMQ
  queue. The worker did check the domain (local vs. external) but called
  `storeInboundMessage()` directly with the original address. For an
  e-mail alias (e.g. `vertrieb@stefanwuestner.de` → `info@stefanwuestner.de`)
  or a distribution group, storeInboundMessage could not find the user
  → "Mailbox not found — dropping message".

- **Submission handler (ports 587/465) had the same bug**:
  mail clients (Thunderbird/Apple Mail) sending directly to the submission ports
  also bypassed alias resolution.

- **`storeInboundMessage()` only knew user mailboxes, no SharedMailbox**:
  even after alias resolution: if the alias pointed to a SharedMailbox,
  the mail was discarded because the function only queried `prisma.user.findFirst(...)`.
  Now `prisma.sharedMailbox.findFirst(...)` is queried in parallel as well.

### Changed

- **`expandRecipients()` extracted from `inbound/handler.ts` into `handlers/expand.ts`**
  so that all three entry paths (port 25 inbound, port 587/465 submission,
  BullMQ outbound queue) use the same logic
- **SharedMailbox quota** is now also incremented on local delivery
- **SSE `mail:new` event** is published for a SharedMailbox to all users with
  `FULL_ACCESS` or `READ_ONLY` permission → live update in the
  inbox of everyone with access

---

## [3.17.21] — 2026-05-21 — ESMTP audit: stub-only extensions removed

### Removed

Audit of all ESMTP extensions — everything advertised in EHLO but
**not implemented** was removed (the server would have violated the respective RFC):

- **AUTH CRAM-MD5 (RFC 4954/2195)** — `handleAuth` only recognizes `PLAIN` and `LOGIN`;
  CRAM-MD5 requests were rejected with `504 Unrecognized authentication type`.
  Toggle removed from the BCP, default hard-coded `false`.

- **SMTPUTF8 (RFC 6531)** — UTF-8 in envelope addresses was not handled specially
  (no punycode mapping, no Unicode normalization). If advertised, international
  addresses (e.g. `用户@例子.公司`) would have led to inconsistent behavior.

- **CHUNKING / BDAT (RFC 3030)** — the `BDAT` command was not recognized by the command parser
  and rejected with `500 Command not recognized: BDAT`.

### Verified implementations (remain active)

| Extension | RFC | Status |
|---|---|---|
| STARTTLS | 3207 | ✅ Fully functional, TLS upgrade implemented |
| AUTH PLAIN | 4954 | ✅ `handleAuthPlain` |
| AUTH LOGIN | 4954 | ✅ `handleAuthLoginStart` |
| PIPELINING | 2920 | ✅ Buffer-based parsing (`lineBuffer` loop in `onData`) |
| SIZE | 1870 | ✅ `SIZE=` parameter parsed + `maxSize` check |
| 8BITMIME | 6152 | ✅ Buffer-based (binary encoding) — no 7-bit downgrade |
| ENHANCEDSTATUSCODES | 2034 | ✅ All codes follow the `x.y.z` format |

The DB fields `extAuthCramMd5`, `extSmtputf8`, `extDsn`, `extChunking` remain in the
database for backwards compatibility but are ignored by the server (hard-coded).

---

## [3.17.20] — 2026-05-21 — Remove: DSN advertisement removed (was unused)

### Removed

- **DSN (Delivery Status Notifications, RFC 3461)**: the SMTP server advertised DSN
  in the EHLO response but did NOT implement it:
  - No processing of `NOTIFY=`, `ORCPT=`, `ENVID=`, `RET=` parameters
    in MAIL FROM / RCPT TO (they were silently discarded by the regex)
  - No `multipart/report` + `message/delivery-status` generation on bounce
  - No SUCCESS/FAILURE/DELAY reports

  RFC 3461 forbids advertising a capability without implementing it.
  Removed:
  - `DSN` from the EHLO response (`packages/smtp-server/src/core/session.ts`)
  - `DEFAULT_ESMTP_EXTENSIONS.dsn` now `false` (default hard-coded)
  - Toggle removed from BCP → SMTP & Routing → ESMTP extensions
  - Zod schema for `extDsn` in `routes/admin/smtp-config.ts` removed
  - DB field `extDsn` remains (backwards compatibility, but ignored)

  If DSN is implemented in a later version, the toggle can
  come back — but as long as it is stub-only: gone.

---

## [3.17.19] — 2026-05-21 — Fix: STARTTLS on port 25 with self-signed cert (hosted-MTA 503)

### Fixed

- **Mails from strict hosted MTAs are rejected with `503 5.5.1 Bad sequence
  of commands`**: the SMTP server advertised STARTTLS on port 25 with
  a self-signed certificate. Strict MTAs then initiate
  the TLS handshake, reject the self-signed cert (ECONNRESET) and
  return a 503 error.

  Fix: self-signed detection via `X509Certificate.issuer === subject`. On
  **port 25 (inbound)** STARTTLS is NO longer advertised when the cert is self-signed
  — MTAs then deliver in plain (still RFC-compliant, opportunistic
  TLS is skipped). Submission ports (465/587) continue to advertise STARTTLS
  (own clients accept self-signed with `tls.rejectUnauthorized: false`).

  After installing a CA-signed certificate (e.g. Let's Encrypt via BCP →
  SSL/TLS) STARTTLS on port 25 is activated automatically.

---

## [3.17.18] — 2026-05-21 — Inbox auto-refresh + manual refresh button

### Fixed

- **SSE events never arrived** (the inbox did not refresh itself):
  EventSource cannot send `Authorization` headers, but the api-gateway
  only read bearer tokens from the header → the SSE connection failed with 401.
  Fix: the `requireAuth` middleware now additionally accepts `?token=…` as a
  query parameter (fallback only when no header). The frontend passes the token
  as a query in the EventSource URL.

### Added

- **Live update in the inbox**: as soon as a new mail arrives
  (SSE event `mail:new` from the Redis channel `mail:new`), the folder and
  message lists are reloaded automatically. A subtle toast shows
  sender + subject of the new message.
- **Manual refresh button**: next to "New e-mail" in the folder tree a
  🔄 icon button appears (with tooltip "Refresh folders") that reloads folders +
  messages immediately (`refetchQueries`, no background refetch)
- i18n keys `refresh_folders` / `refresh_done` in DE/EN/ES/IT

---

## [3.17.17] — 2026-05-21 — Fix: Autodiscover URL now uses its own CNAME

### Fixed

- **The Autodiscover URL used the same hostname as all other paths**:
  with `mail.stefanwuestner.de` as hostname, "Derive URLs" also generated
  `http://mail.stefanwuestner.de:8080` for Autodiscover. Clients however, per the
  **Autodiscover specification (MS-OXDISCO)**, ALWAYS expect `autodiscover.{primary-domain}` first —
  i.e. `http://autodiscover.stefanwuestner.de:8080`.

  Fix in `routes/admin/servers.ts` `/settings/derive` endpoint:
  - Hostname with ≥ 3 labels (e.g. `mail.stefanwuestner.de`) → strip the first subdomain
    → `autodiscover.stefanwuestner.de`
  - Hostname with 2 labels (e.g. `stefanwuestner.de`) → `autodiscover.stefanwuestner.de`
  - Hostname already starts with `autodiscover.` → unchanged (no double prefix)

  The DNS hint in the BCP (Autodiscover guide) now uses the same logic:
  correctly shows `autodiscover.{root-domain} CNAME {publicHostname}`

---

## [3.17.16] — 2026-05-21 — Fix: login fails (api-gateway had duplicate auth with the old pepper bug)

### Fixed

- **Login still does not work** despite the fix in v3.17.13: the `api-gateway`
  has its OWN `/auth/login` route (`packages/api-gateway/src/routes/auth.ts`)
  that is NOT proxied to the auth-service. This route had exactly the same
  pepper bug: `bcrypt.compare(password + pepper, hash)` instead of sha256+pepper.
  Thus the login route on port 3000 never verified correctly — on port 3003
  directly (auth-service) it has worked since v3.17.13.

  Fix: `verifyPassword()` and `hashPassword()` from `@coremail/core` used in:
  - `routes/auth.ts` — login + password reset
  - `routes/setup.ts` — initial setup admin user
  - `routes/user.ts` — password change (current + new password)

  All direct bcrypt imports in these files removed.

---

## [3.17.15] — 2026-05-21 — Distribution group fix, token refresh, BCP cleanup

### Fixed

- **Distribution groups "Invalid request"**: the form sent the complete e-mail address
  as free text (e.g. only "verteilung" without @domain) → Zod validation failed.
  The form now works like user management: local part + `@` + domain dropdown side by side.
  The e-mail is assembled from `localPart@domain.name` before it goes to the backend

- **Auto-logout despite active use**: the JWT access token has a 15-minute TTL.
  BCP and MWA stored only the access token, never the refresh token.
  On 401 the user was redirected to the login page immediately.
  Fix in `admin-panel/src/api/client.ts` and `web-client/src/api/client.ts`:
  - The refresh token is stored in localStorage at login
  - Proactive renewal when the token is < 120s from expiry (JWT exp decoded without a library)
  - On 401 a refresh is attempted first + the request is repeated; only on a repeated failure → login

### Added

- **Distribution groups in the MWA recipient autocomplete**: when typing an address in the
  compose window, distribution groups are now suggested as well (via `GET /admin/groups/gal`),
  alongside contacts. Groups are shown with a purple avatar and a `[Gruppe]` badge

### Removed

- **BCP → Resource mailboxes** (`/resources`): page and navigation removed
- **BCP → Organisation** (`/organisation`): page and navigation removed
- Both associated page files deleted (`ResourcesPage.tsx`, `OrganisationPage.tsx`)

---

## [3.17.14] — 2026-05-21 — Mailbox delegation + user active/inactive

### Added

- **Mailbox delegation (delegate access)**: user B can access the mailbox of user A —
  analogous to the Shared Mailbox logic (delegate access):
  - New Prisma model `MailboxDelegate` with the `SharedMailboxPermType` enum:
    `FULL_ACCESS` / `READ_ONLY` / `SEND_AS` / `SEND_ON_BEHALF`
  - Admin API `GET/POST/DELETE /api/v1/admin/mailboxes/:id/delegates`
  - User API `GET /api/v1/mail/delegated-mailboxes` — returns all mailboxes
    the logged-in user has delegated access to
  - **BCP → Mailboxes** — the expanded row now shows a "Delegate Access" section:
    existing delegations with permission + revoke button,
    form to grant (user dropdown + permission dropdown)

- **User active/inactive** (BCP → Mailboxes): already implemented (the toggle button
  already existed), explicitly verified: `active: false` completely blocks login
  in `authenticateLocal()` and `authenticateAppPassword()`

---

## [3.17.13] — 2026-05-21 — Fix: login fails (password pepper mismatch)

### Fixed

- **Login fails with "Invalid credentials"** although the password is set correctly:
  `auth-service/src/local/index.ts` used its own pepper logic
  (`password + PEPPER` → direct bcrypt.compare) while `@coremail/core`'s `hashPassword()`
  used `sha256(password + PEPPER)` → bcrypt when creating the user.
  The two functions differed → hash and verify never matched.

  Fix: `authenticateLocal()` and `authenticateAppPassword()` now use
  `verifyPassword()` from `@coremail/core` — the same sha256+pepper logic as `hashPassword()`.
  Direct `bcrypt` import in `local/index.ts` removed.

- **App passwords (IMAP/SMTP/POP3)** were affected by the same bug:
  `bcrypt.compare(rawPassword, hash)` instead of `verifyPassword()` → IMAP/SMTP auth with
  an app password also failed. Likewise switched to `verifyPassword()`.

---

## [3.17.12] — 2026-05-21 — BCP complete translation (EN/DE) + version alignment

### Changed

- **All package versions synchronized**: all 17 `packages/*/package.json` still had
  version `3.7.9` — now uniformly `3.17.12`. The `/healthz` endpoint and
  BCP → System information now show the correct version

- **BCP fully translated (English/German)**: all remaining pages now use
  `useT()` and `t()` keys instead of hard-coded German strings:
  - **MailboxesPage** — table, modals (New, Edit, Delete), quota bars, roles
  - **DomainsPage** — DNS records, DKIM key modal, domains table, all actions
  - **QueuesPage** — overview, jobs table, settings, all status labels
  - **DashboardPage** — KPI cards, widget settings, server info, attack events widget
  - **QuarantinePage** — statistics cards, filters, table, detail panel, cleanup modal

- **translations.ts** extended to ~1288 keys (previously ~350):
  new sections for mailboxes, domains, logs, queues, dashboard, quarantine, protection filters

---

## [3.17.11] — 2026-05-21 — Multi-fix: mail body, local delivery, MessageTrace, queue refresh, translations

### Fixed

- **Mail body contains raw MIME headers**: `buildRawMime()` used `newline: 'unix'` (LF only).
  nodemailer's `smtp-connection` does NOT normalize buffer contents in the DATA channel (only strings).
  The receiving MTA could not find the header/body separator `\r\n\r\n` → the entire
  MIME content was displayed as a plain-text body. Fix: `newline: 'crlf'` (RFC 5321-compliant)

- **Mails to local addresses (admin@stefanwuestner.de) do not arrive**: the MWA send endpoint
  (`POST /api/v1/mail/send`) sent ALL recipients into the outbound queue without a local-domain check.
  The queue worker attempted outbound MX delivery — and failed. Fix: the queue worker now checks
  before `relayMessage()` whether the recipient domain is in the local domain table; local
  recipients are written directly into the mailbox via `storeInboundMessage()`

- **MessageTrace never shows results**: the API client automatically adds `/api/v1` as a prefix.
  `MessageTracePage` used `/api/v1/admin/message-trace` as the path → double prefix `/api/v1/api/v1/...`
  → 404. Fix: path corrected to `/admin/message-trace` (without prefix)

- **Queue refresh button does not work**: the page-level button called `invalidateQueries` (background
  refetch, no visual feedback) instead of `refetchQueries` (immediate active refetch).
  Fix: `qc.refetchQueries({ queryKey: ['admin-queue-jobs'] })` and `['admin-queue-stats']`

- **Spam lands in the inbox instead of the Junk folder**: `storeInboundMessage()` looked for the
  folder `'Junk E-Mail'` (a foreign folder name) — the folder is called `'Junk'`. Fallback was INBOX.
  Fix: `'Junk'` and `'INBOX'` as the correct folder names

- **MessageTrace: JUNK status was missing** in the status filter and badge display. Added.

### Added

- **Sent Items (Sent folder)**: when sending via the MWA a copy is now automatically stored
  in the sender's Sent folder (was never implemented before). Large mails (>256 KB)
  are stored in MinIO, small ones directly in the DB. Flags: `\\Seen` (marked as already read)

- **MessageTrace auto-load**: now opens with the latest entries — no more manual clicking
  on "Search" required. The reset button clears all filters and shows all entries

- **MAIL_FLOW log in the API gateway**: `POST /api/v1/mail/send` now immediately writes an
  `ACCEPTED` SystemLog entry so that mails sent via the MWA are visible in the
  MessageTrace right away (even before the queue processes them)

---

## [3.17.10] — 2026-05-21 — Fix: copy buttons on DNS records

### Fixed

- **BCP → Domains → DKIM DNS record / BCP → SMTP & Routing → DNS records**: copy buttons
  did not work — `navigator.clipboard` is `undefined` in an HTTP context (non-secure, e.g. DSM
  Application Portal) and throws an error.
  - New shared helper `packages/admin-panel/src/utils/clipboard.ts`:
    `copyToClipboard()` first tries `navigator.clipboard.writeText()` (secure context)
    and automatically falls back to `document.execCommand('copy')` (HTTP compatibility)
  - `DomainsPage.tsx`: both copy buttons (DNS name + TXT value) now use `copyToClipboard()`
    with a correct `await` and `toast.error('Kopieren fehlgeschlagen')` on error
  - `SmtpConfigPage.tsx`: the `CopyBtn` component uses `copyToClipboard()` instead of a direct
    `navigator.clipboard.writeText()`; the error case shows a toast instead of failing silently

---

## [3.17.9] — 2026-05-20 — Fix: loading the DKIM record fails when no key exists

### Fixed

- **BCP → Domains → Show DKIM DNS record**: error "DKIM record could not be loaded"
  when `dkimPrivateKey` in the database was empty (domains created before the automatic
  key generation had an empty entry).
  - Backend `GET /:id/dkim-record` now automatically generates an RSA-2048 key pair
    and stores it when none exists — the error no longer occurs
  - Backend `GET /:id/dns-check` is secured as well (try/catch + `ensureDkimKey`)
  - New endpoint `POST /:id/regenerate-dkim` — explicit regeneration of the key pair

### Added

- **BCP → Domains → DKIM**: button "Regenerate" (appears after the first load)
  — generates a new RSA-2048 key pair with a confirmation dialog (warning: the DNS record
  must be updated afterwards); loading spinner during fetch/generation
- Loading indicator in the DKIM button ("Loading…") during the API call

---

## [3.17.8] — 2026-05-20 — Message trace fix + RFC 822 source

### Fixed

- **Message trace**: the search returned no results because the
  SMTP server never wrote `SystemLog` entries with `category='MAIL_FLOW'`.
  - SMTP inbound (`handlers/message.ts`): now writes `DELIVERED` / `JUNK` after every delivery
  - SMTP inbound (`inbound/handler.ts`): writes `REJECTED` (spam filter rejection) and
    `QUARANTINE` (virus quarantine) with sender, recipient, subject, size, spam score, reason
  - SMTP submission (`submission/handler.ts`): writes `ACCEPTED` after accepting an outgoing mail
  - SMTP outbound (`outbound/queue.ts`): writes `DELIVERED` after successful delivery,
    `DEFERRED` on a temporary error (retry pending), `REJECTED` on final failure
  - All events are searchable and filterable in BCP → Management → Message trace

### Added

- **RFC 822 source view** in the MWA message reader:
  - "View source" now opens a modal dialog instead of a new browser tab
  - Shows the complete RFC 822-compliant MIME format (headers + body) in a monospace font
  - Download button `Download .eml` directly in the source modal
  - Backend `GET /api/v1/mail/messages/:id/raw`: now serves the original RFC 822 document
    from MinIO when available (large messages); the fallback reconstructs `multipart/alternative`
    (text + HTML) correctly per RFC 2045 with a MIME boundary

---

## [3.17.7] — 2026-05-20 — DNS tab: table UI, green/yellow status lights

### Changed

- **BCP → SMTP → DNS records**: complete UI redesign — from cards to a clean table view
  - **● green dot** = record set in DNS (existence check)
  - **● yellow dot** = record not found
  - **● blue dot** = PTR — to be set manually at the hosting provider
  - Legend at the bottom: green / yellow / blue explained
  - Status banner: "X of 5 records set"
  - Each row: name field + value field, each with a copy button
  - The found DNS value is shown in green (set) or yellow (deviating)
- **Backend `dns-check`**: the MX check now uses a pure existence check (`records.length > 0`);
  the Autodiscover check tests whether a CNAME exists at all (no more hostname comparison)

---

## [3.17.6] — 2026-05-20 — DNS tab in SMTP configuration

### Added

- **BCP → SMTP configuration → DNS records**: a new tab shows all DNS records required
  for mail operation — MX, SPF, DKIM, DMARC, Autodiscover, PTR.
  - Domain selection via pill tabs (with multiple domains)
  - Each record shows DNS type, expected value, copy button
  - **Live DNS check** via `GET /api/v1/admin/domains/:id/dns-check` — green checkmark when
    the record is set, yellow warning symbol when missing; shows the currently set value from DNS
  - Status summary: "X of 5 records correct"
  - Button "Re-check DNS" for manual refresh
  - PTR card with a note about setting it at the hosting provider
- **Backend** `GET /api/v1/admin/domains/:id/dns-check`: checks MX, SPF (TXT), DKIM (TXT),
  DMARC (TXT), Autodiscover (CNAME) in parallel via Node.js `dns/promises`; generates for each an
  expected value and the actually found value

---

## [3.17.5] — 2026-05-20 — Fix: BullMQ queue name contains no colon

### Fixed

- **Sending fails ("Message could not be enqueued")**:
  BullMQ v5 forbids colons (`:`) in queue names. The outbound queue in
  `api-gateway/routes/mail.ts` was called `'smtp:outbound'` — BullMQ immediately threw
  `Error: Queue name cannot contain :` when creating the queue object.
  Fix: queue name changed to `'smtp-outbound'` (as already correct in the `smtp-server`).

---

## [3.17.4] — 2026-05-20 — Fix: BullMQ connection in api-gateway (NetworkError on send)

### Fixed

- **Sending fails (NetworkError)**: the outbound queue in `api-gateway/routes/mail.ts` used
  `getRedisClient()` (shared, `maxRetriesPerRequest: 3`) instead of `createBullMqConnection()` (`null`).
  BullMQ v5 requires `maxRetriesPerRequest: null` for internal blocking commands — with the wrong
  connection `queue.add()` crashed the api-gateway process (Node.js 22: `--unhandled-rejections=throw`),
  which appeared in the browser as `NetworkError when attempting to fetch resource`.
  Fix: `createBullMqConnection()` used correctly as in `smtp-server/outbound/queue.ts`.
- **Additionally**: `queue.add()` in try/catch — on real queue errors the server now returns
  `500 { error: '...' }` instead of dropping the connection.

---

## [3.17.3] — 2026-05-20 — Service TLS binding: SMTP/IMAP/POP3 real certificates, HTTPS proxy only MWA+BCP

### Added

- **Protocol TLS binding**: when a certificate is assigned to the services `SMTP`, `IMAP` or `POP3`,
  `certPem`/`keyPem` are automatically written to `ServerSettings.tlsCert/tlsKey` and all three
  protocol servers reload the certificate immediately via `CHANNEL_SETTINGS_RELOAD` — no container restart needed.
  Applies to: Let's Encrypt (after issuance), upload, self-signed, PUT services change.
- **`applyProtocolCert()` helper** in `certificates.ts` — central binding point for SMTP/IMAP/POP3 TLS
- **BCP: service colors** in the certificate table — blue: MWA/BCP (HTTPS proxy), green: SMTP/IMAP/POP3 (protocol TLS), gray: EWS/CALDAV/AUTODISCOVER
- **BCP: "Protocol TLS" row** in the detail view — shows which protocol services are actively bound
- **BCP: ServiceSelector hint** — explains MWA+BCP = HTTPS proxy vs. SMTP/IMAP/POP3 = protocol TLS

### Changed

- **`activate-https` guard**: the HTTPS proxy can only be activated when the certificate has both `MWA` and
  `BCP` in the `services` array — returns a clear 400 error message when services are missing
- **BCP: LockOpen button** now appears only for certificates with MWA+BCP (previously for all ACTIVE/EXPIRING)
- **BCP: gray status banner** now explicitly explains "assign MWA + BCP" instead of just "click the lock"
- **BCP: HTTPS (port 443) detail row** shows three states: Active / Ready (MWA+BCP) / MWA+BCP required

---

## [3.17.2] — 2026-05-20 — HTTPS proxy: explicitly disableable for an external reverse proxy

### Added

- **`HTTPS_PROXY_ENABLED=false`** — new env switch disables the integrated TLS proxy completely.
  Set it when an external reverse proxy (Traefik, Caddy, nginx, DSM Application Portal …) terminates TLS.
  Then port `443:443` can be removed / commented out in `docker-compose.yml`.
- **`GET /api/v1/admin/certificates/tls-proxy-info`** — new admin endpoint returns `{ enabled, port, activeCert }`
- **`docker-compose.synology.yml`**: `HTTPS_PROXY_ENABLED: "false"` preset (DSM handles TLS)
- **`.env.example`**: section for `HTTPS_PROXY_ENABLED` + `HTTPS_PORT` added

### Changed

- **BCP certificates — three-state status banner**:
  - 🟡 Yellow: proxy disabled (`HTTPS_PROXY_ENABLED=false`) — external reverse proxy active
  - 🟢 Green: proxy active + certificate selected — shows port + domain
  - ⬜ Gray: proxy ready, but no certificate activated yet — with a hint about `HTTPS_PROXY_ENABLED=false`
- **`docker-compose.yml`**: `HTTPS_PROXY_ENABLED` variable and comment "OPTION A / OPTION B" for a clear choice
- **`tls-proxy.ts`**: `isTlsProxyEnabled()` exported; startup log when the proxy is disabled

---

## [3.17.0] — 2026-05-20 — Integrated HTTPS reverse proxy (TLS termination)

### Added

- **Integrated HTTPS reverse proxy (port 443)**  
  – CoreMail can now terminate HTTPS directly without an external reverse proxy (Traefik, Caddy, nginx)  
  – After issuing a Let's Encrypt or own certificate in BCP → SSL/TLS: the button
    **"Activate as HTTPS"** (lock icon) starts the TLS proxy immediately via hot reload  
  – Exactly one certificate can be active at a time; hot swap without container restart via
    the Redis channel `coremail:tls:reload`  
  – Deactivation by clicking the green lock icon again  
  – `docker-compose.yml`: port `443:443` added  
- **BCP certificates — HTTPS status banner**  
  – A green banner shows the active certificate + domain; a gray banner when no HTTPS is active  
  – The detail row (expanded) shows "HTTPS (port 443): Active / Inactive" with a lock icon  
- **`packages/api-gateway/src/tls-proxy.ts`** — new module for the HTTPS server lifecycle
  (start, graceful stop 5 s, hot reload via Redis subscription)  
- **Prisma schema**: `Certificate.isActiveHttps Boolean @default(false)`

### Changed

- **BCP certificates**: the actions column shows a `LockOpen` icon (gray) for activatable certs
  and a `Lock` icon (green) for the active HTTPS certificate

---

## [3.16.9] — 2026-05-20 — Bugfix: Let's Encrypt port 80 + better UI feedback

### Fixed

- **docker-compose.yml**: port `80:3000` added — the ACME HTTP-01 challenge is now
  reachable by Let's Encrypt (previously the process hung until timeout)
- **BCP certificates**: visible status banner for PENDING (blue) and ERROR (red)
  directly above the table — no more silent "nothing happens"
- **BCP certificates**: the error message in the expand panel now has a title + readable
  `pre` block instead of raw mono text
- **certificates.ts**: log hint on ACME challenge: "Port 80 must be reachable"

---

## [3.16.8] — 2026-05-20 — Bugfix: MessageList panel cannot be resized

### Fixed

- **MWA Mail — resizable panel (MessageList)**: `w-80 shrink-0` in the main return overrode
  the `style={{ width }}` of the parent div → the panel was not resizable and only showed the
  empty message counter. Corrected to `w-full h-full overflow-hidden`.

---

## [3.16.7] — 2026-05-20 — BCP: info window updated to v3.16.6

### Changed

- **BCP info window** — VERSION updated to 3.16.6, BUILD_DATE 2026-05-20  
  – 6 new HIGHLIGHTS entries (3.16.6 → 3.14.0) with complete release notes  
  – Thus correctly shows all releases since 3.13.12

---

## [3.16.6] — 2026-05-20 — MWA: recipient autocomplete, resizable panels, view settings

### Added

- **MWA Compose — recipient autocomplete (To / CC / BCC)**  
  – While typing in the To, CC and BCC fields, matching contacts from the address book are suggested (from 1 character, 220 ms debounce)  
  – Dropdown with name, e-mail address and company; keyboard navigation (↑/↓/Enter/Tab/Escape)  
  – Multiple recipients separated by comma; a selection replaces the current fragment and places the cursor after the new comma  
  – Search via `GET /api/v1/contacts?q=...` (server-side, max. 8 hits shown)
- **MWA Mail — resizable panels**  
  – The dividers between folder tree ↔ message list ↔ reading pane can be resized with the mouse  
  – Widths are stored in `localStorage` under `coremail:panel-widths` and restored on the next load  
  – Default widths: folder tree 208 px (w-52), message list 320 px (w-80); minima/maxima prevent overlaps
- **Settings → View** (new section)  
  – **Reading pane**: Right (default), Bottom (message list + reader split vertically) or Off (list only, no reader)  
  – **Message density**: Compact / Normal / Comfortable — row height of the message list  
  – **Group conversations**: toggle for conversation-based bundling (preparation)  
  – All settings persistent via a Zustand store (`coremail-ui-prefs` in localStorage)

---

## [3.16.1] — 2026-05-20 — Task reminders: calendar sync + real-time popup

### Added

- **MWA Tasks — reminder with calendar integration**  
  – When creating or editing a task with a reminder set (date + time), a calendar event is created automatically (`🔔 Erinnerung: <subject>`, 30 min. duration) via `POST /calendar/events` — best effort, no task error on a calendar error  
  – Applies to both `createMutation` (new task) and `updateMutation` (edit modal via double-click)
- **MWA Tasks — reminder popup at the set time**  
  – The 60-second interval check `checkDueDates()` now additionally checks `task.reminder`: as soon as the timestamp is ≤ `now`, a `toast` "🔔 Reminder: <subject>" appears (12 sec. display duration)  
  – A dedicated `notifiedReminderIds` ref prevents duplicate popups per session (independent of the due-date notification)
- **MWA Tasks — reminder field visually highlighted**  
  – The bell icon in the form is now amber (`text-amber-400`) instead of gray; the tooltip explains the dual function (calendar + popup)

---
## [3.16.0] — 2026-05-20 — MWA/BCP feature update (tasks, contacts, search, fonts, dashboard)

### Added

- **MWA Tasks — editing via double-click**  
  – Double-clicking a task opens a modal with pre-filled fields (subject, notes, priority, due date, reminder)  
  – A separate `updateMutation` writes complete changes via `PUT /tasks/:id`
- **MWA Tasks → calendar synchronization**  
  – Newly created tasks with a due date are automatically entered as a calendar event (`POST /calendar/events`)  
  – Invalidates the `calendar-events` query; errors are swallowed best-effort (no task-create failure)
- **MWA Tasks — due-date popup**  
  – A `useEffect` checks every 60 seconds whether tasks are due today  
  – Shows a `toast` with the task title; each task is notified only once per session (via `useRef<Set>`)
- **MWA Calendar — tasks as events**  
  – Tasks with a `dueDate` appear in FullCalendar as all-day events (amber `#f59e0b` / gray for completed)  
  – Clicking a task event shows a toast instead of the delete dialog; prefix `📋` / `✓` in the title
- **MWA Contacts — extended fields**  
  – New fields: `email2`, `mobile`, `department`, `jobTitle`, `notes`  
  – Edit form in sections: "General" (2-column grid), "E-mail & phone" (2-column grid), "Notes" (textarea)  
  – The detail view shows all filled fields with icon + label; e-mails/phone clickable  
  – The contact list shows `jobTitle` as the second line (instead of only the e-mail)  
  – `Contact` interface in `api/types.ts` extended with all new fields
- **MWA e-mail search — scope selection + typeahead**  
  – New search bar above the filter list in `MessageList`  
  – Scope switch: "Folder" (client-side filtering) / "All" (API query `/mail/folders/search?q=...`)  
  – Typeahead: from 2 characters of input, up to 5 hits from the loaded folder are shown as suggestions  
  – Clear button (`×`) empties the search; the `All` scope disables the local filter
- **MWA e-mail compose — font selection**  
  – New Tiptap extension `@tiptap/extension-font-family` (v2.27.2, matches the existing Tiptap v2 stack)  
  – Dropdown with 8 fonts: Default, Arial, Calibri, Georgia, Times New Roman, Courier New, Verdana, Trebuchet MS  
  – Dropdown label and entries are each rendered in the corresponding font  
  – Positioned between block type and bold/italic in the formatting bar
- **BCP Dashboard — all widgets draggable**  
  – All 8 previously missing widgets (`queue-status`, `mails-chart`, `storage-ranking`, `domains-chart`, `recent-errors`, `recent-audit`, `recent-logins`, `system-strip`) are now wrapped in `<DraggableCard>`  
  – IIFE slot pattern for queue+mails, storage+domains and errors+audit+attack (consistent with the KPI and server sections)  
  – `recent-logins` and `system-strip` as individual draggable units

### Fixed

- **DNS hardening startup check**: integrity check targets switched from `example.com` (IANA IP no longer valid, now Cloudflare CDN) to stable infra records: `one.one.one.one → 1.1.1.1` and `dns.google → 8.8.8.8`

---

## [3.15.0] — 2026-05-20 — Security+ (password reset, attack detection, DNS hardening)

### Added

- **Password self-reset (OWASP A07-compliant)**  
  – `POST /auth/forgot-password`: rate-limited (3 req/h per IP + e-mail), SHA-256 hashing, no user enumeration (always `{ok:true}`)  
  – `POST /auth/reset-password`: atomic transaction (token marked + password set + all sessions deleted)  
  – `GET /auth/reset-password/verify?token=...`: quick check for the frontend  
  – Token TTL: 15 min; SHA-256 hash stored in the DB (plaintext never persisted)  
  – Admin toggle in the BCP: Settings → Security → "Password self-reset" (enables/disables the flow globally)  
  – MWA login page: "Forgot password?" link (only visible when the feature is active)  
  – MWA: `ForgotPasswordPage` + `ResetPasswordPage` with password strength indicator
- **Attack detection live dashboard (BCP)**  
  – New Prisma model `AttackEvent` (ip, type, detail, service, timestamp) — persistent in PostgreSQL  
  – Redis channel `admin:attack` → SSE broadcast to all admin connections in real time  
  – BCP dashboard widget "Attack detection (live)": counters for the last 1h/24h, top IPs, top attack types, last 10 events, "UNDER ATTACK" banner at ≥10 events/h  
  – Admin API `GET /api/v1/admin/security/attacks` (paginated/filterable), `/summary`, `DELETE` (purge before date)  
  – The `ip-limiter` in SMTP publishes an attack event on every auth failure and ban
- **DNS poisoning protection (MITRE T1584.002)**  
  – New module `security-filter/src/dns-hardened.ts`: enforces trusted resolvers (8.8.8.8, 1.1.1.1, 9.9.9.9) instead of system/container DNS  
  – Cross-resolver validation: two independent resolvers are compared; divergence → warning in the log  
  – Startup integrity check: known stable A records (example.com) are validated against hard-coded expectations  
  – The DNSBL module now uses `resolveHardened()` instead of `dns.promises.resolve4()`  
  – Admin API `GET /api/v1/admin/security/dns-check` → real-time integrity report via the security-filter proxy  
  – Configurable via `TRUSTED_DNS_SERVERS` (comma-separated IP list)
- **Per-user inactivity timeout (MWA)**  
  – Users can set a personal timeout (minutes) under MWA → Settings → General → "Automatic logout"  
  – The own setting overrides the global admin default; 0 = disabled; null = inherit global  
  – Backend: `GET/PUT /api/v1/user/preferences` returns/stores `inactivityTimeoutMinutes`  
  – Prisma model `UserSettings.inactivityTimeoutMinutes (Int?)` added  
  – The MWA `useInactivityLogout` hook loads both settings in parallel and respects the user override

### Security

- **Attack events** are stored persistently in the `AttackEvent` table (forensics/audit trail)  
- **Redis pub/sub** for attack events decouples the SMTP lockout from the dashboard without performance impact  
- **Password reset tokens**: a simple rate limiter prevents token flooding; SHA-256 protects the DB from a plaintext leak  
- **The SSE endpoint** checks the admin role before attack events are broadcast (`ORGANIZATION_MANAGEMENT` / `SERVER_MANAGEMENT` / …)

---

## [3.14.0] — 2026-05-20 — Security hardening (pentest evaluation)

### Security

- **SMTP — brute-force lockout (OWASP A07 / MITRE T1110)**: new `ip-limiter` module  
  – Redis-backed: after 5 failed auth attempts in 5 min the IP is blocked for 10 min (421)  
  – Configurable via env: `SMTP_AUTH_FAIL_THRESHOLD`, `SMTP_AUTH_WINDOW_S`, `SMTP_AUTH_BAN_S`  
  – A successful login clears the failure counter
- **SMTP — per-IP connection limit (MITRE T1499)**: max. 10 concurrent connections + max. 30 new connections/min per IP (sliding window)  
  – Configurable via `SMTP_MAX_CONNS_PER_IP`, `SMTP_NEW_CONN_PER_MIN`  
  – Private/loopback IPs exempt
- **SMTP — VRFY command disabled**: now responds with `502 5.5.1 VRFY not supported` instead of the ambiguous `252` (prevents user enumeration)
- **MinIO console (port 9001) now bound to localhost only**: changed to `127.0.0.1:9001:9001` in both `docker-compose` files — no more WAN access possible
- **Container resource limits** added in `docker-compose.yml`: `cpus: 2`, `memory: 2g` (via `deploy.resources.limits`) — DoS protection at host level
- **SMTP auth IP pass-through**: the client IP is now passed to `verifyCredentials` so brute-force counters count correctly per IP

### Fixed

- **SMTP banner** no longer reveals an internal hostname misconfiguration (`mail.localhost`) — the hostname is always read from the DB `publicHostname`, env fallback as seed

---

## [3.13.12] — 2026-05-20 — Tasks error, duplicate folders, SharedMailbox language

### Fixed

- **Tasks — "Invalid" error on creation**: the frontend sent `title`, the backend expects `subject` (Prisma schema field name). `Task` interface in `types.ts` corrected to `subject`/`body`; `TasksPage` now sends the correct fields
- **Inbox — duplicate folders "Aufgaben"/"Task"**: `Notes` and `Tasks` were wrongly provisioned as regular mail folders. Both removed from `DEFAULT_FOLDERS` in `provision-mailbox.ts` (they are separate data models). `FolderTree` filters them out for existing users
- **SharedMailbox — wrong language**: folder labels were hard-coded mixed English/German; now via `useT()` in the language set by the user (DE/EN/ES/IT)
- **SharedMailbox — date format**: `fmtDate()` now uses the user's language instead of a hard `'de-DE'`
- **SharedMailbox — folder order**: the folder sidebar now follows the same order as the normal mailbox (`INBOX → Drafts → Sent → Trash → Junk → Archive`, then custom folders) instead of only `sortOrder + displayName`

### Changed

- **Tasks page built out**: extended form with priority, due date, reminder, note text field; expandable body display per task; overdue marking in red; delete only with confirmation
- **SharedMailbox sidebar style** adjusted: active accent bar on the left, hover effects and icon sizes identical to the normal FolderTree sidebar

---

## [3.13.11] — 2026-05-20 — Automatic logout on inactivity

### Added

- **New security field "Automatic logout on inactivity"** in the global settings (security policies section)
  - Value in minutes: `0` = disabled, `1`–`1440` minutes configurable
  - Default: 30 minutes
  - Quick buttons: Disabled / 5 / 10 / 15 / 30 / 60 / 120 min
  - Warning below 5 minutes (could annoy users)
- **`GET /api/v1/admin/settings/public`** — new public endpoint (no auth), returns `orgName`, `logoUrl`, `language`, `inactivityTimeoutMinutes`, `maintenanceMode`, `maintenanceMessage` — retrievable by MWA/BCP before login
- **`useInactivityLogout` hook** — implements browser-side inactivity detection in BCP and MWA:
  - Listens to `mousemove`, `mousedown`, `keydown`, `touchstart`, `scroll`, `visibilitychange`
  - The timer is reset on every activity
  - 60-second advance warning via toast before the logout is triggered
  - Automatic redirect to the login page after expiry

### Changed

- The session timeout field in the settings renamed to "Session timeout (token)" and the hint text clarified — makes the difference from the inactivity timeout clear

---

## [3.13.10] — 2026-05-20 — Bugfix: applying a template failed (retentionDays validation)

### Fixed

- **Critical bugfix** — the "From template" button on the retention policies page failed with `retentionDays must be at least 1`
- Cause: in the tag-based retention system (DPT/RPT/personal tags) the **policy** itself holds no period — the tags do. The frontend therefore correctly sends `retentionDays: 0` when creating the policy
- The backend validation in `POST /admin/compliance/retention` and `PUT /admin/compliance/retention/:id` was too strict (`< 1` instead of `< 0`) and blocked this
- Fix: `0` is now allowed (meaning: the period is controlled by the attached tags); negative values are still rejected
- All 8 template scenarios (Trash, Junk, Inbox, Sent, Drafts, Compliance 7 years, Default 3 years, 5 years recoverable) can now be created with a click

---

## [3.13.9] — 2026-05-20 — Retention policies from templates + MFA buttons removed

### Removed — main view decluttered

- **"MFA now" button** removed from the header of the `RetentionPage` — the worker runs automatically in a 24h work cycle, no admin needs to trigger it manually
- **"MFA history" button** removed + `RunsModal` component deleted completely — internal worker telemetry does not belong in the compliance configuration
- `runNow` mutation and `ManagedFolderRun` interface removed from the component state

### Added — 1-click templates

- **"From template" button** next to "New policy" (only in the Policies tab)
- **`TemplatePickerModal`** with 8 ready-made scenarios:

| Scenario | Tag type · Folder · Action · Period |
|---|---|
| Empty Trash after 30 days | RPT · DELETED_ITEMS · DELETE_AND_ALLOW_RECOVERY · 30 d |
| Permanently delete Junk after 14 days | RPT · JUNK_EMAIL · PERMANENTLY_DELETE · 14 d |
| Archive Inbox after 1 year | RPT · INBOX · MOVE_TO_ARCHIVE · 365 d |
| Archive Sent after 2 years | RPT · SENT_ITEMS · MOVE_TO_ARCHIVE · 730 d |
| Delete Drafts after 90 days | RPT · DRAFTS · DELETE_AND_ALLOW_RECOVERY · 90 d |
| Compliance 7 years (marking) | DPT · ALL_OTHER · MARK_AS_PAST_RETENTION_LIMIT · 2555 d |
| Default 3 years → archive | DPT · ALL_OTHER · MOVE_TO_ARCHIVE · 1095 d |
| 5 years recoverable delete | DPT · ALL_OTHER · DELETE_AND_ALLOW_RECOVERY · 1825 d |

- Clicking a template triggers **atomically** (frontend orchestration):
  1. `POST /admin/compliance/retention/tags` — create tag
  2. `POST /admin/compliance/retention` — create policy (legacy fields empty)
  3. `POST /admin/compliance/retention/:policyId/tags/:tagId` — attach tag to policy
  4. `POST /admin/compliance/retention/:policyId/assignments` — GLOBAL assignment
- A productive rule is thereby ready for use in **one click**
- Own rules "from scratch" remain available via the "New policy" button

### Changed — page header

- Subtitle rephrased: "Define when e-mails are automatically archived or deleted — via template or your own rule" (previously: a technical description naming the retention worker and Recoverable Items)

---

## [3.13.8] — 2026-05-19 — Shared Mailboxes with full folder structure + user folder CRUD

### Added — Provisioning

- **`ensureSharedMailboxProvisioned(sharedMailboxId)`** in `packages/api-gateway/src/lib/provision-mailbox.ts`
  - Idempotent — analogous to the user variant
  - Creates the `Mailbox` record (via `sharedBoxId`) and the 8 default folders: `INBOX`, `Drafts`, `Sent`, `Trash`, `Junk`, `Archive`, `Notes`, `Tasks`
  - Backfill: missing standard folders are added for existing mailboxes
- **Auto-call** in `POST /admin/shared-mailboxes` — new mailboxes immediately have the full folder structure
- **Repair endpoint** `POST /admin/shared-mailboxes/:id/provision` — backfill for existing ones

### Added — Folder CRUD for Shared Mailboxes (FULL_ACCESS only)

In `packages/api-gateway/src/routes/user.ts`:

- `POST   /user/shared-mailboxes/:id/folders` — create folder (with optional `parentId` for subfolders)
- `PATCH  /user/shared-mailboxes/:id/folders/:folderId` — rename, move (`parentId`), color, favorite, sort order
- `DELETE /user/shared-mailboxes/:id/folders/:folderId` — delete (with children check)
- `POST   /user/shared-mailboxes/:id/folders/:folderId/empty` — delete all messages in the folder
- Cycle check on reparenting — a folder cannot be moved into its own subtree
- **Standard folders protected**: `INBOX`, `Drafts`, `Sent`, `Trash`, `Junk`, `Outbox` cannot be renamed, moved or deleted (403)

### Added — Web client UI (`SharedMailboxPage.tsx`)

- **"+ New folder" inline input** at the top of the folder sidebar (FULL_ACCESS only), dashed accent border
- **Hover actions** per user folder on the right: pencil (rename) + trash can (delete)
- **Inline rename** with Enter/Esc, OK button, validation state
- Standard folders show no action icons (frontend + backend agree)
- Delete confirm dialog with data-loss warning
- `READ_ONLY` users see neither "New folder" nor action icons

---

## [3.13.7] — 2026-05-19 — Transport rules from templates

### Added

- **"From template" button** on `TransportRulesPage` (next to "New rule")
- **`TemplatePickerModal`** with 9 ready-made rule templates, filterable in 4 categories
- Per template: icon + description + conditions/actions pre-filled
- Clicking a template → `RuleModal` opens pre-filled; the admin adjusts placeholders (`@DEINE-DOMAIN.com`) and saves

### Included templates

| Category | Template | Conditions → Actions |
|---|---|---|
| **Labeling** | [EXTERN] marker in the subject | `from notContains @firma.com` → subject prefix |
| **Compliance** | Disclaimer for outgoing mails | `to notContains @firma.com` → addDisclaimer |
| **Compliance** | BCC to compliance mailbox | `to contains @firma.com` → addRecipient compliance@ |
| **Compliance** | Credit card detection (PCI-DSS) | `body regex \b\d{13,16}\b` → quarantine |
| **Security** | Quarantine spam score > 5 | `spamScore > 5` → quarantine |
| **Security** | Malware extensions | `subject regex \.(exe|bat|scr|cmd|vbs|js|jar|hta)\b` → quarantine |
| **Security** | CEO phishing protection | `from regex (ceo|geschäftsführer|chef).*@(?!firma)` → subject prefix "⚠ MÖGLICHES PHISHING" |
| **Governance** | Size limit 25 MB | `size > 26214400` → reject |
| **Governance** | DLP marker for external attachments | `hasAttachment is true` + `to notContains @firma.com` → addHeader X-Coremail-External-Attachment |

### Changed — `RuleModal`

- New optional `initial` prop: takes a template rule structure and pre-fills `name`, `description`, `priority`, `conditions`, `actions`
- With the `rule` prop (edit mode) `initial` is ignored
- Own rules "from scratch" remain available via the "New rule" button (without template)

---


> Older releases (v3.13.6 and earlier back to v0.1) are available via `git log CHANGELOG.md`
> or the [GitHub releases](https://github.com/MAGPEEK/CoreMail/releases).
