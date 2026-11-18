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
- Calendar (review): rooms of a recurring meeting were checked against the old times when the
  series was moved or its recurrence changed (the conflict check read the stored calendar data);
  they are now checked against the meeting as it is saved.
- Calendar (review): moving a single occurrence re-checks the rooms; deleting a single
  occurrence frees its slot in the room's bookings.
- Calendar (review): two concurrent bookings of the same room slot could both be accepted (event
  form and mail path); conflict check and booking now run under a per-room lock.
- Calendar (review): iMIP updates/cancellations of one occurrence of an all-day series carried a
  date-time `RECURRENCE-ID`; it is now a date (`VALUE=DATE`) like `DTSTART`.
- Calendar (review): a private or confidential occurrence of a public series showed its subject
  to grantees in the event list and in free/busy; it is now masked / left out.
- Calendar (review): single-occurrence edits of a floating-time series write floating
  `EXDATE`/`RECURRENCE-ID` values (were UTC).
- Mail (review): keywords written together with a move (JMAP, REST, mail rules, shared mailboxes)
  or through a bulk metadata write (mail rules, superseded drafts) now keep the follow-up flag in
  step with `\Flagged`.
- Tasks (review): completing a recurring task twice at once created two next tasks; the next
  task is now created exactly once.

### Security
- REST `POST /calendar/freebusy` and `/calendar/schedule-suggestions` (review): addresses are only
  resolved among the caller, the address-list users of the caller's domain and users who shared a
  calendar with the caller — other users (other domains, hidden from the address list) are
  `found: false` instead of revealing their existence and display name.
- Rooms (review): a user without a domain no longer sees or books the rooms of every domain.
- Tasks (review): the recurrence rule of a task is validated strictly
  (`FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` and `NAME=value` parts).

## Review notes (independent review, branch `review-calendar-tasks`)

Schema: one more additive column, `ResourceCalendar.bookingSeq Int @default(0)` (booking lock).
SemVer impact of the review fixes: none beyond MINOR. Behaviour change to mention in the release
notes: free/busy answers `found: false` for addresses outside the caller's address list (privacy).

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | High | `PUT /calendar/events/:id` booked rooms with the OLD `icalData`; `expandStoredEvent` prefers the iCal DTSTART/RRULE, so a moved/re-ruled series was conflict-checked at its old times and the booking stored stale data | `routes/calendar.ts` builds the new calendar data first (`icalWith`) and books against it |
| 2 | High | Room booking not race-free (read bookings → decide → upsert, no lock, no transaction) in the event form and the mail path | storage `resource-lock.ts` `lockResourceCalendar` (row lock via `bookingSeq` increment) in `lib/room-booking.ts` `bookRooms` and smtp-server `handlers/resource-booking.ts` |
| 3 | Medium | Moving one occurrence did not re-check rooms; deleting one occurrence left its slot busy | `recheckRooms()` in `updateOccurrence`; `refreshRoomBookings()` on `DELETE ?occurrence=` |
| 4 | Medium | iMIP `RECURRENCE-ID` of an all-day occurrence written as date-time (ical-generator) | `lib/imip.ts` `withDateRecurrenceId()` writes `RECURRENCE-ID;VALUE=DATE` |
| 5 | Medium | Follow-up flag diverged from `\Flagged` for `moveMessages(…, { data: { flags } })` (JMAP move with keywords, REST move, mail rules, foreign mailbox) and `touchMessages(…, { flags })` | message-store: `followUpAfterKeywords` per moved row; one extra `UPDATE … WHERE flagStatus` (`followUpBulkAfterKeywords`) in touchMessages — no extra reads |
| 6 | Medium | PRIVATE/CONFIDENTIAL override of a PUBLIC series leaked its subject (event list, free/busy) | core `stricterClassification()`, `ExpandedInstance.override.classification`; used in `GET /events`, `GET /events/:id?occurrence=`, `lib/calendar-busy.ts` |
| 7 | Medium | Free/busy resolved any active user of any domain (incl. hidden from the address list) → `found: true` + display name | `freeBusyDirectory()` (self, own domain + `GAL_VISIBLE_WHERE`, sharers) for `/freebusy` and `/schedule-suggestions` |
| 8 | Low | Recurring task completion not idempotent (double next task) | conditional `updateMany(status ≠ COMPLETED)` + create in one transaction |
| 9 | Low | `listRooms`/`bookRooms` without `domainId` listed/booked the rooms of all domains | fail closed |
| 10 | Low | Task RRULE validation accepted `FREQ=SECONDLY` etc. | strict pattern |
| 11 | Low | Floating series got UTC `EXDATE`/`RECURRENCE-ID` | `seriesDateProp` writes floating values |
| 12 | Low | `PUT /events` sent invitations whenever any attendee (rooms included) existed and awaited the organizer lookup unguarded (fire-and-forget rejection) | uses `notifyAttendees()` (people only, lookup failure caught) |

Checked without findings: setFlags/modifyFlags keep one modSeq per mailbox and publish after
commit (one extra `findMany` per mailbox group in setFlags, none in modifyFlags; per-row updates
as before), IMAP STORE / JMAP keywords / EAS / MAPI all go through them; EAS `email:Flag` uses only
12.x tags (no version gate needed for 12.1/14.0/14.1), Tasks code page tokens with `TOKEN_SINCE`,
invalid flags answered with Status 6; one-field task PUT keeps the other fields (full api-gateway
suite green); new webmail components use theme tokens, German texts, no "Exchange"/RFC numbers.

Open points:
- The mail path (`smtp-server handlers/resource-booking.ts`) checks conflicts only against the
  first instance of stored bookings (recurring event-form bookings are not expanded there) — now
  serialised, but not yet the same occurrence check as the event form.
- A room's answer is per series: one moved occurrence that collides declines the room for the
  whole series (no per-occurrence room answer); the override's copied room `ATTENDEE` keeps the
  old PARTSTAT.
- Zoned series whose TZID has no IANA mapping (custom VTIMEZONE only) still get UTC
  `EXDATE`/`RECURRENCE-ID`.
- Re-booking on a time change resets an approved room (approval policy) to pending.
