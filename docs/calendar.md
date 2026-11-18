# Calendar

CoreMail stores every event as one calendar object (`CalendarEvent.icalData`, iCalendar) plus a
few indexed columns (`dtStart`, `dtEnd`, `allDay`, `rrule`, `classification`, `showAs`, …). REST
(webmail), CalDAV and the iMIP mail path all read and write the same object, so a change made by
one client is seen by every other one.

## Event form (webmail)

| Field | Stored as |
|-------|-----------|
| Title, location, notes | `SUMMARY`, `LOCATION`, `DESCRIPTION` |
| Start / end, all-day | `DTSTART` / `DTEND` (all-day: dates, end exclusive) |
| Attendees | `ATTENDEE` + `attendees` column; adding one turns the appointment into a meeting (invitations are sent by the server) |
| Rooms and resources | `ATTENDEE;CUTYPE=ROOM` / `RESOURCE` + a booking of the resource (see below) |
| Wiederholen | `RRULE` (presets or the full editor) |
| Anzeigen als | `TRANSP` + `X-MICROSOFT-CDO-BUSYSTATUS` (`FREE`, `TENTATIVE`, `BUSY`, `OOF`) and the `showAs` column |
| Erinnerung (+ per E-Mail) | `VALARM` `ACTION:DISPLAY` (+ `ACTION:EMAIL` to the owner) |
| Sichtbarkeit (privat) | `CLASS` + `classification` (`PRIVATE`: others see only "Beschäftigt") |

### Recurrence

The "Wiederholen" field offers presets derived from the chosen start date — *Jeden Tag*,
*Jeden &lt;Wochentag&gt;*, *Jeden Arbeitstag* (Monday–Friday), *Am &lt;n&gt;. Tag jedes Monats*,
*Jeden &lt;n&gt;. &lt;Wochentag&gt; des Monats* (the 5th week day of a month counts as the last one) and
*Jährlich am &lt;Datum&gt;* — and *Benutzerdefiniert …*: interval, week days, monthly/yearly on a
day or on the n-th week day, end never / after N occurrences / on a date. A rule written by
another client that the editor cannot show (e.g. `BYHOUR`) is kept unchanged unless the user
picks another one (`web-client/src/lib/recurrence.ts`).

Occurrences are expanded on the server in the event's time zone (`@coremail/core/recurrence`):
a weekly 10:00 Europe/Berlin meeting stays at 10:00 local time across daylight-saving changes.

### One occurrence or the whole series

Clicking an occurrence asks *Nur dieses Ereignis* / *Die gesamte Serie*.

* **Only this occurrence** — `PUT /api/v1/calendar/events/:id?occurrence=<original start>` writes
  an override (a `VEVENT` with `RECURRENCE-ID`, cloned from the series without
  `RRULE`/`RDATE`/`EXDATE`); title, time, location, notes, show-as and visibility can change.
  `DELETE …?occurrence=` adds an `EXDATE` to the series (and drops an override of that
  occurrence). `GET …?occurrence=` returns the occurrence as it is now.
* **Whole series** — the plain routes change the master `VEVENT`; overrides and `EXDATE`s are kept.

`RECURRENCE-ID` and `EXDATE` are written in the form of the series' `DTSTART` (date for all-day
series, local time with the series `TZID`, else UTC), so CalDAV clients match them to their
occurrence (`@coremail/core/calendar-exceptions`). Attendees receive a `REQUEST` or `CANCEL` for
just that occurrence (`RECURRENCE-ID`); series invitations carry the `EXDATE`s.

Overrides written by a CalDAV client (Thunderbird, Apple Calendar, DAVx⁵) are shown by the
webmail the same way. ActiveSync has no calendar folder in CoreMail (mail only), so occurrences
are not synchronised over EAS.

### Show as and free/busy

`POST /api/v1/calendar/freebusy` returns, per requested address, the busy time from the calendars
the caller may see — the own calendars and calendars shared with the caller (unchanged since
3.18.17). `FREE` events do not block; `TENTATIVE` (or `STATUS:TENTATIVE`) is reported as
`tentative`, `OOF` as `oof`; `CANCELLED` events are left out. Users without access are returned
with `visible: false` — their availability is unknown, not free. Private events of others show no
subject, confidential ones are left out; an occurrence counts with the stricter classification of
its series and its own override (a private occurrence of a public series is masked — in the event
list too). Addresses are looked up only among the caller, the address-list users of the caller's
domain (not hidden from the address list) and users who shared a calendar with the caller;
anything else is `found: false` (no directory enumeration). The scheduling assistant uses the
same lookup.

### Scheduling assistant

The event form has a second tab *Terminplanungs-Assistent*: one free/busy row per attendee and
per selected room for the chosen day (working hours from Settings → Kalender, widened to the
selected time), the selected time as an overlay, and suggested times for the next seven days.

`POST /api/v1/calendar/schedule-suggestions`
`{ attendees, rooms?, start, end, durationMinutes, workingHoursOnly?, uid? }` (window ≤ 31 days)
merges the busy time of the organizer, the attendees and the rooms
(`@coremail/core/free-busy`) and returns up to eight slots inside the organizer's working days
and hours (time zone of Settings → Region): slots where everybody is free first, then slots with
the fewest conflicts (tentative counts less than busy); `unknown` lists attendees without
free/busy access.

### Rooms and resources

`GET /api/v1/calendar/rooms?start=&end=[&uid=]` lists the active resource mailboxes of the user's
domain (BCP → Ressourcen) with capacity, location, `available` for the slot and their busy time.

Rooms selected in the event form (`rooms: [addresses]` on `POST`/`PUT /calendar/events`) are
booked when the event is saved — no invitation mail goes to them. The resource settings decide
(`api-gateway/src/lib/room-booking.ts`):

| Setting | Effect |
|---------|--------|
| inactive | declined |
| recurring not allowed | a series is declined |
| max. duration | longer meetings are declined |
| booking window (days) | meetings starting later are declined |
| decline conflicts | a meeting overlapping an accepted/tentative booking (recurring bookings expanded, every occurrence of a recurring meeting checked within the booking window) is declined |
| approval / no auto-accept | the booking stays pending (`NEEDS-ACTION`) |

The answer is the room's attendee entry (`ACCEPTED`, `DECLINED` with the reason, or
`NEEDS-ACTION`) and is shown next to the room. Moving the meeting, changing its recurrence or
moving a single occurrence re-checks the rooms against the meeting as it is stored afterwards;
deleting a single occurrence frees its slot (the booking gets the `EXDATE`, the answer stays);
removing a room or deleting the meeting releases the booking. Invitations from other mail
clients still reach rooms through the mail path (smtp-server `handlers/resource-booking.ts`,
same rules).

Conflict check and booking run in one transaction under the room's booking lock
(storage `lockResourceCalendar`, row lock on `ResourceCalendar.bookingSeq`) on both paths: of
two concurrent bookings of the same slot exactly one gets the room. Users only see and book the
rooms of their own domain.

### Reminders

The reminder of an event is the owner's `VALARM` (minutes before the start). *Auch per E-Mail*
adds an `ACTION:EMAIL` alarm addressed to the owner; CalDAV clients that support e-mail alarms
see it too. The webmail shows the reminder popup (and sends the reminder mail) from the leading
tab, once per occurrence — the same engine as task reminders (`useTaskReminders`). Reminders are
only returned to the calendar owner.

## Calendar views

Tag, Arbeitswoche (work days of Settings → Kalender), Woche and Monat; *Heute* jumps to today.
*Tagesagenda* opens a side panel with the events of the selected day. Several calendars (own and
shared) are shown on top of each other; the sidebar hides single calendars.

## API summary

| Route | Purpose |
|-------|---------|
| `GET /calendar/events?start&end` | occurrences in the window (`recurrenceId`, `instanceId`, `showAs`; `reminder` for owners) |
| `GET /calendar/events/:id[?occurrence=]` | one event / occurrence for the form (`reminderMinutes`, `reminderByMail`) |
| `POST /calendar/events` | create (`showAs`, `reminderMinutes`, `reminderByMail`, `rrule`, `attendees`, `rooms`) |
| `PUT /calendar/events/:id[?occurrence=]` | change the series / one occurrence |
| `DELETE /calendar/events/:id[?occurrence=]` | delete the series / one occurrence |
| `POST /calendar/freebusy` | free/busy per address |
| `POST /calendar/schedule-suggestions` | meeting-time suggestions |
| `GET /calendar/rooms` | rooms with availability |

Tests: `core/src/calendar/exceptions.test.ts`, `free-busy.test.ts`,
`api-gateway/src/routes/calendar.test.ts`, `lib/room-booking.test.ts`,
`web-client/src/lib/recurrence.test.ts`, `scheduling.test.ts`; e2e `scripts/e2e/steps/dav.mjs`
(series exception via CalDAV ⇄ REST) and `rest.mjs`.
