# w2-realtime — changelog text (Keep a Changelog)

### Added
- Realtime events for every change a user can see: `mailbox:changes` (messages, flags,
  folder lists) and typed per-user events on `user:<id>:events` (calendar incl. shares,
  tasks, contacts, notes, settings by area, quota). The message store publishes every
  message write after the commit (SMTP, IMAP, POP3, JMAP, ActiveSync, webmail, restore,
  retention); folder, calendar, contact, task, note, settings and quota writers announce
  theirs (REST, CalDAV/CardDAV, JMAP, IMAP, ActiveSync MeetingResponse, iTIP replies,
  restore, admin quota changes). Docs `docs/realtime.md`.
- Webmail: live refresh of exactly the affected views (folder list, message lists of the
  changed folders, calendar, tasks, contacts, notes, settings, quota, branding) from
  other tabs, devices and mail clients.
- Webmail: one live connection per browser — the open tabs elect a leader and share its
  events; a logout (or the end of the session) in one tab logs out every tab.
- Webmail: push notifications for new mail (Settings → Benachrichtigungen, per device,
  opt-in; sender and subject only with the extra opt-in). A click opens the message.
- Webmail is installable: `GET /manifest.webmanifest` (name, colour and icon from the
  branding) and a service worker (`/sw.js`, no offline caching).
- `POST /api/v1/push/unsubscribe` (by endpoint); `showPreview` on push subscriptions
  (new column `PushSubscription.showPreview`, default false — additive schema change).
- e2e: the `webmail` step checks live contacts/calendar/folder events, the manifest and
  the service worker; the `live` step checks that IMAP IDLE reports a delivery within 2 s.

### Changed
- IMAP IDLE is pushed by `mailbox:changes` for every writer (before: only new SMTP mail);
  the per-session check is a 120 s fallback instead of a 30 s poll.
- JMAP push (EventSource, WebSocket, Web Push) reacts to changes of every writer, not
  only to JMAP's own writes and SMTP delivery.
- Webmail polling replaced by live events; the remaining refetch intervals are a
  15-minute safety net (folder pane, shared mailboxes, quota, calendar, task reminders,
  branding). The event dialog no longer polls attendee status every 30 s.
- New-mail Web Push: generic text unless the device opted into previews; links to the
  message; no notification for junk.

### Removed
- Redis channels `mail:update` and `calendar:shares` (replaced by `mailbox:changes` and
  calendar user events). Internal only — no client-facing API change.
