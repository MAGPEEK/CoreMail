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
booked when the event is saved — no invitation mail goes to them, and the room sends no reply
mail: its answer is written straight into the room's attendee entry, which the form shows (see
[Invitations by mail](#invitations-by-mail) for the mailed answer). Meetings written by an
ActiveSync phone book their rooms the same way (storage `room-booking.ts`, 9.5 — see
[activesync.md](activesync.md#calendar-tasks-and-notes-w3)); a booking of a UID belongs to its
organizer and is never changed or released by another one. Only the organizer's copy of a
meeting books, rebooks or releases rooms and sends invitation updates / cancellations — saved by
the organizer or by a delegate with write access to the organizer's calendar
(`isOrganizerCopy`, `api-gateway/src/lib/room-booking.ts`); an attendee who moves or deletes
their copy changes only that copy. The resource settings decide
(storage `resource-booking-rules.ts`, used by `room-booking.ts` and the mail path):

| Setting | Effect |
|---------|--------|
| inactive | declined |
| recurring not allowed | a series is declined |
| max. duration | longer meetings are declined |
| booking window (days) | meetings starting later are declined |
| decline conflicts | a meeting overlapping an accepted/tentative booking (recurring bookings expanded, every occurrence of a recurring meeting checked) is declined; without this setting it is accepted and the conflicting dates are listed with the booking |
| approval / no auto-accept | the booking stays pending (`NEEDS-ACTION`) |

Conflicts are checked from the meeting start to the end of the booking window, at most one year
ahead, for at most 400 occurrences of a series (`EXDATE`s and moved or cancelled occurrences
applied). The conflicting occurrences (up to 50) are stored with the booking
(`ResourceBooking.conflicts`, 9.5) — the reason of a decline, or the list that comes with an
acceptance when the room does not decline conflicts.

A series that repeats more than once a day (`FREQ=HOURLY`/`MINUTELY`/`SECONDLY`, or several
`BYHOUR`/`BYMINUTE`/`BYSECOND` values) is declined with reason `too-frequent` (picker: "Serie
wiederholt sich zu häufig"; a room that allows no series at all keeps `recurring`); a stored
booking with such a rule blocks its first slot only. Its expansion would run from the series start
on every later check of the room and grow with time. A simple `DAILY`/`WEEKLY` rule (only
`INTERVAL`, `COUNT`, `UNTIL`) is not iterated from its start: the expansion jumps to the window
(core `recurrence.ts`), so an old series costs no more than a new one.

The answer is the room's attendee entry (`ACCEPTED`, `DECLINED` with the reason, or
`NEEDS-ACTION`) and is shown next to the room. Moving the meeting, changing its recurrence or
moving a single occurrence re-checks the rooms against the meeting as it is stored afterwards;
deleting a single occurrence frees its slot (the booking gets the `EXDATE`, the answer stays);
removing a room or deleting the meeting releases the booking.

#### Invitations by mail

Invitations from other mail clients reach rooms through the mail path (smtp-server
`handlers/resource-booking.ts`), for every delivery path. Since 9.5 it applies the same rules as
the event form — before, a mailed series was checked with its first occurrence only, the
settings for series, duration and booking window were not applied, and `TZID` start times were
read as UTC:

| Invitation | Effect on the room's booking |
|------------|------------------------------|
| `REQUEST` with the series (or a single meeting) | decided by the rules above, every occurrence checked |
| `REQUEST` with only `RECURRENCE-ID` occurrences (a moved occurrence) | merged into the stored series, which is checked again; if declined, only those occurrences are: they are stored as cancelled exceptions (`STATUS:CANCELLED`, `X-RESOURCE-DECLINED:TRUE`) — neither their original nor their new slot blocks the room — the series keeps its answer and `conflicts` lists the dates. Moving the occurrence again replaces the exception and is checked again |
| `CANCEL` of the series | the booking is removed |
| `CANCEL` with only `RECURRENCE-ID` occurrences | those occurrences get an `EXDATE`, their slots are free; the answer stays |

Only the authenticated organizer of a booking changes or cancels it; a request from an
unauthenticated organizer stays pending. The answer is stored as the booking status
(`GET /api/v1/admin/resources/:id/bookings`, with `conflicts`) and, since 9.5, mailed to the
organizer. `REPLY`, `COUNTER`, `DECLINECOUNTER` and `REFRESH` messages sent to a room are ignored
(no booking change, no answer) — before 9.5 they were treated like a `REQUEST`.

##### The room's answer (9.5)

A decided `REQUEST` is answered with an iMIP `REPLY` to the organizer, like the rooms of other
calendar servers (smtp-server `handlers/resource-reply.ts`, REPLY format from storage
`itip-reply.ts`, the builder of ActiveSync meeting responses):

| Booking | `PARTSTAT` of the room | Subject |
|---------|------------------------|---------|
| accepted (conflicting dates listed when the room does not decline conflicts) | `ACCEPTED` | `Angenommen: …` |
| declined | `DECLINED` | `Abgelehnt: …` |
| waiting for approval (approval / no auto-accept) | `TENTATIVE` | `Mit Vorbehalt angenommen: …` |

- The `VCALENDAR` carries `METHOD:REPLY` and the room as the only `ATTENDEE` (with its display
  name), plus `UID`, `SEQUENCE` and `ORGANIZER` of the request.
- The answer mirrors the request: a request with the series (or a single meeting) gets one
  `REPLY` for the series. A request with only single occurrences (`RECURRENCE-ID`) gets one
  `REPLY` per occurrence (at most 10), each with its `RECURRENCE-ID`; a declined occurrence update
  is a `DECLINED` reply for exactly those occurrences while the series keeps the answer it had
  (iTIP allows several `VEVENT`s in one `REPLY`; one occurrence per mail is understood by every
  client, including CoreMail's own reply processing, which reads one component).
- The subject shows at most 120 characters of the meeting title.
- German text part: accepted / declined with the reason — the conflicting dates (up to 20 listed),
  outside the booking window, longer than allowed, series not allowed, series repeats too often,
  not bookable — or "muss noch genehmigt werden". Times are shown in the meeting's time zone.
- Sent through the outbound queue (`smtp-outbound`) with the room as envelope sender and `From`;
  the worker signs with the DKIM key of the room's domain. Headers `Auto-Submitted: auto-replied`,
  `X-Auto-Response-Suppress: All`, `In-Reply-To` / `References` = the request's `Message-ID`.
  The job carries `resourceReply`, so a local delivery counts as sent by the room and the
  organizer's CoreMail calendar applies the answer (attendee status of the room).

No answer is sent (loop and backscatter safety) for `CANCEL`, `PUBLISH` and other non-`REQUEST`
methods, an unauthenticated organizer (pending, no mail to a possibly forged address), a null
envelope sender, mail with `Auto-Submitted` other than `no`, `Precedence: bulk|list|junk`,
mailing-list headers or `X-Auto-Response-Suppress: All|AutoReply`, automated senders
(MAILER-DAEMON, noreply …), an organizer that is not one plain address (e.g. a list
`a@x,b@y` in `ORGANIZER`), an organizer that is the room itself or another resource mailbox,
more than 30 answers of one room to one organizer within an hour (Redis counter; the booking is
still decided, only the mail is skipped; no Redis = no mail), and rooms whose **send replies**
setting is off (`ResourceMailbox.sendReplies`, default on;
`POST`/`PUT /api/v1/admin/resources[/:id]` field `sendReplies`). A failed answer is logged and
never fails the delivery.

Bookings from the event form and from ActiveSync phones (organizer in the same organisation) send
no reply mail — the room's answer is shown in the form and on the phone right away.

Conflict check and booking run in one transaction under the room's booking lock
(storage `lockResourceCalendar`, row lock on `ResourceCalendar.bookingSeq`) on both paths: of
two concurrent bookings of the same slot exactly one gets the room. The mail path reads the
existing booking, checks the organizer, merges or cancels occurrences and writes the answer inside
that same transaction, so concurrent updates of one series never overwrite each other. Users only see and book the
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
`web-client/src/lib/recurrence.test.ts`, `scheduling.test.ts`,
`smtp-server/src/handlers/resource-booking-recurring.test.ts`, `resource-reply.test.ts` (the
room's mailed answer); e2e `scripts/e2e/steps/dav.mjs` (series exception via CalDAV ⇄ REST),
`rest.mjs` and `smtp.mjs` (mailed invitation to a room → the organizer receives its REPLY).
