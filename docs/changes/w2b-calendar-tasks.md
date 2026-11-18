# w2b-calendar-tasks — changelog text (calendar, tasks, follow-up flags)

SemVer: MINOR. Additive schema (`Message.flagStatus` + four flag dates and an index,
`CalendarEvent.showAs`, ten new `Task` columns, all with defaults or nullable — schema-sync applies
them without data loss), new REST routes and optional request fields; existing requests behave as
before. Behaviour changes worth noting (not breaking): REST `POST /calendar/freebusy` users get a
`visible` field and the busy type `oof`, and `FREE` events no longer count as busy; EAS Sync now
sends `email:Flag` in every Add/Change and applies client flag changes (before: ignored); a
completed recurring task (`PUT /tasks/:id`) now creates the next task (returned as `next`).

### Added
- Calendar: recurrence in the event form — presets from the chosen date (Jeden Tag, Jeden
  &lt;Wochentag&gt;, Jeden Arbeitstag, Am &lt;n&gt;. Tag jedes Monats, Jeden &lt;n&gt;. &lt;Wochentag&gt; des
  Monats, Jährlich am &lt;Datum&gt;) and a full editor (interval, week days, monthly/yearly by day or
  position, end never / after N / on a date); rules of other clients the editor cannot show stay
  unchanged.
- Calendar: edit or delete a single occurrence of a series ("Nur dieses Ereignis" / "Die gesamte
  Serie") — REST `?occurrence=` on `GET`/`PUT`/`DELETE /calendar/events/:id` writes a
  `RECURRENCE-ID` override or an `EXDATE` in the series' time-zone form, so CalDAV clients see the
  change; attendees get an update or cancellation for that occurrence only.
- Calendar: scheduling assistant in the event form — free/busy row per attendee and room for the
  day, suggested meeting times for the next seven days (`POST /calendar/schedule-suggestions`,
  working days and hours of Settings → Kalender in the user's time zone).
- Calendar: rooms and resources in the event form (`GET /calendar/rooms` with availability; `rooms`
  on `POST`/`PUT /calendar/events`) — booked on save with conflict check (recurring meetings and
  bookings expanded) following the resource settings (decline on conflict, recurring allowed, max.
  duration, booking window, approval); the room's answer is shown in the form, no invitation mail
  goes to the room; deleting the meeting or removing the room releases the booking.
- Calendar: "Anzeigen als" (Frei / Mit Vorbehalt / Gebucht / Abwesend) stored as `TRANSP` +
  `X-MICROSOFT-CDO-BUSYSTATUS` (also read from CalDAV clients) and used by free/busy; invitations
  carry it.
- Calendar: reminder per event in the form, optionally also by e-mail (`VALARM` `ACTION:EMAIL`);
  the webmail shows event reminders (and sends the reminder mail) like task reminders.
- Calendar: toolbar "Heute" and a "Tagesagenda" side panel with the events of the selected day.
- Mail: follow-up flags with dates — "Kennzeichnen" menu in the command bar and the message context
  menu (Heute, Morgen, Diese Woche, Nächste Woche, Kein Datum, Benutzerdefiniert …, Erinnerung
  hinzufügen …, Als erledigt markieren, Kennzeichnung löschen); the list shows flagged and
  completed mails (due date in the tooltip); flag reminders pop up. REST
  `PUT`/`GET /api/v1/mail/follow-up`.
- Mail protocols: the follow-up flag is kept in step with `\Flagged` / `$flagged` (flagged ⇔
  `\Flagged`, complete clears it) for IMAP, JMAP, REST and mail rules; ActiveSync Sync sends
  `email:Flag` (status, start/due, reminder, completion) and applies flag changes from devices
  (invalid flags: Status 6).
- Tasks: "Gekennzeichnete Elemente und Aufgaben" — tasks and flagged mails in one list with the
  filters Aktiv / Überfällig / Abgeschlossen, sorted by due date; completing a flagged mail there
  completes the flag of the mail, opening it opens the mail.
- Tasks: full task form — Startdatum, Abschlussdatum, Status (incl. "Wartet auf jemanden"),
  % erledigt, Privat, Serie, Gesamt-/Ist-Aufwand, Reisekilometer, Abrechnungsinformationen,
  Firmen, Notiz as rich text; status, % and completion date stay consistent; completing a
  recurring task creates the next one.
- Docs: `docs/calendar.md`, `docs/tasks.md`.

### Changed
- REST `POST /calendar/freebusy`: `FREE` events no longer count as busy; `type` can be `oof`; users
  whose calendars the caller may not see are marked `visible: false` (was: an empty busy list).
- iMIP invitations of a series include its `EXDATE`s and the organizer's show-as.

### Fixed
- ActiveSync: a `Change` that only carried `email:Flag` was ignored — the flag of the mail is now
  set, completed or cleared.
