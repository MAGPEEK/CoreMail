# w2-user-settings — changelog text (personal settings, roaming, deep links)

SemVer: MINOR. Additive schema (`user_settings.preferences`, table `user_signatures`,
`messages.dispositionNotificationTo`), additive API; every pre-9.4 contract keeps working
(`GET /mail/messages/:id` still marks read by default, `/user/signature` and `PUT /user/preferences`
unchanged in shape, `/auth/sessions` only gains a field and a route).

### Added
- Webmail settings roam between devices: view, theme and accent, language, regional and calendar
  settings are stored on the server (`GET/PATCH /api/v1/user/preferences`, versioned and validated);
  the browser keeps an offline copy and imports its earlier local values once.
- Settings → Lesen: mark as read immediately, after N seconds or manually; read receipts (request:
  never / selectable / always; answer: never / ask / always); new-mail notification as hint, sound
  or none; empty Deleted Items on logout.
- Settings → Verfassen: HTML or plain-text format, default font and size, reminder for forgotten
  attachments (German and English attachment words).
- Settings → Region: time zone, date format and 12/24-hour clock — used for the message list, the
  reading pane, the sessions list and the times in sent invitations.
- Settings → Kalender: work days and hours, first day of the week, time grid, default reminder
  (also written as an alarm into new events), default meeting duration.
- Settings → Ansicht: sort order of message lists (date, sender, subject, size; ascending or
  descending, `?sort=&dir=` on the list API) and order inside conversations.
- Several named signatures with defaults for new mails and replies per sender identity (own address
  and shared mailboxes) — `/api/v1/user/signatures`.
- Settings → Sicherheit: list of signed-in sessions with device, IP and last use, end one or all
  others (`/auth/sessions` now marks the current session; `POST /auth/sessions/revoke-others`);
  mobile devices; S/MIME options.
- Read receipts: incoming requests are recognised at delivery; `POST /api/v1/mail/messages/:id/receipt`
  sends or declines (`$MDNSent` keyword); `requestReceipt` on send.
- `GET …/messages/:id?markRead=false` reads a message without marking it read.
- Deep links: `/mail/<mailbox>/<folder>/<message>`, `/calendar/event/<id>`, `/contacts/<id>`;
  back/forward follow the selection.

### Changed
- The webmail opens messages with `?markRead=false` and marks them read according to the setting.
- Shared-mailbox links use `/mail/shared:<id>`; `/mail?mailbox=` still works.
- Invitation mails show times in the organizer's time zone (all-day events as dates only).
