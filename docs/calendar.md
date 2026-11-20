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
anything else is `found: false` (no directory enumeration). Meeting-time suggestions use the
same lookup.

### Meeting-time suggestions

The webmail no longer has a scheduling assistant (removed after 10.1: the event form shows only
the details form). The REST endpoints below stay for other clients.

`POST /api/v1/calendar/schedule-suggestions`
`{ attendees, start, end, durationMinutes, workingHoursOnly? }` (window ≤ 31 days)
merges the busy time of the organizer and the attendees
(`@coremail/core/free-busy`) and returns up to eight slots inside the organizer's working days
and hours (time zone of Settings → Region): slots where everybody is free first, then slots with
the fewest conflicts (tentative counts less than busy); `unknown` lists attendees without
free/busy access.

### Organizer's copy and attendee copies

Only the organizer's copy of a meeting sends invitation updates / cancellations — saved by the
organizer or by a delegate with write access to the organizer's calendar (`isOrganizerCopy`,
`api-gateway/src/lib/organizer-copy.ts`; own addresses and active aliases count). An attendee who
moves or deletes their copy of someone else's meeting changes only that copy and notifies nobody.

### Rooms and resources (removed in 10.0.0)

CoreMail 10.0.0 removed room and equipment mailboxes completely: no resource mailboxes, no
bookings, no room picker in the event form, no `GET /calendar/rooms`, no `/admin/resources`.
A former room address is an unknown recipient (550 5.1.1). An attendee with
`CUTYPE=ROOM` / `RESOURCE` written by another client (e.g. a room of another organisation) is an
ordinary attendee: it is stored and invited like any other. The room tables — and the rooms'
own mailbox rows with their folders and messages — are removed by schema-sync after its
pre-migration dump — see [releases/v10.0.0.md](releases/v10.0.0.md)
for the upgrade notes.

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

Events are drawn by their *Anzeigen als* value (`lib/calendarShowAs.ts` + the
`.cm-show-*` rules in `index.css`): **Beschäftigt** (and no value) is a solid block in the calendar
colour; **Mit Vorbehalt** has diagonal stripes of the calendar colour over a light tint of it and a
solid left edge; **Frei** is the page surface with a border and left edge in the calendar colour;
**Abwesend** is always purple (independent of the calendar colour) with a dashed border. The colour
bar of the Tagesagenda follows the same rule; tasks shown in the calendar are not affected. Printed,
these events come out black on white (Abwesend keeps the dashed border).

## API summary

| Route | Purpose |
|-------|---------|
| `GET /calendar/events?start&end` | occurrences in the window (`recurrenceId`, `instanceId`, `showAs`; `reminder` for owners) |
| `GET /calendar/events/:id[?occurrence=]` | one event / occurrence for the form (`reminderMinutes`, `reminderByMail`) |
| `POST /calendar/events` | create (`showAs`, `reminderMinutes`, `reminderByMail`, `rrule`, `attendees`) |
| `PUT /calendar/events/:id[?occurrence=]` | change the series / one occurrence |
| `DELETE /calendar/events/:id[?occurrence=]` | delete the series / one occurrence |
| `POST /calendar/freebusy` | free/busy per address |
| `POST /calendar/schedule-suggestions` | meeting-time suggestions |

Tests: `core/src/calendar/exceptions.test.ts`, `free-busy.test.ts`,
`api-gateway/src/routes/calendar.test.ts`, `lib/organizer-copy.test.ts`,
`web-client/src/lib/recurrence.test.ts`; e2e `scripts/e2e/steps/dav.mjs`
(series exception via CalDAV ⇄ REST), `rest.mjs` (meeting-time suggestions; `/calendar/rooms` is gone)
and `smtp.mjs` (a room address is an unknown recipient).
