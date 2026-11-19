# w3-eas-pim — ActiveSync Calendar, Tasks and Notes

SemVer: MINOR (compatible feature). No schema change, no removed or changed endpoint; existing
ActiveSync mail behaviour is unchanged (see "Changed" for the two protocol-visible additions).

### Added

- ActiveSync: the Calendar ([MS-ASCAL], code page 4), Tasks ([MS-ASTASK], code page 9) and Notes
  ([MS-ASNOTE], code page 23, EAS 14.0+) classes sync both ways. FolderSync announces the user's own
  calendars (default calendar type 8, others 13), the tasks folder (type 7) and the notes folder
  (type 10); shared calendars are not offered over ActiveSync.
- Sync for these classes with the per-device item state of the mail sync (committed / pending
  rows, acknowledged keys, retries resend the same changes): server Add / Change (complete item) /
  Delete detected from the item versions (`updatedAt`), FilterType windows (calendar 2 weeks …
  6 months back with series always included, tasks "incomplete only"), WindowSize + MoreAvailable;
  client Add with ClientId → ServerId responses (a retried Add is not created twice), Change and
  Delete through the existing writers, no echo of the device's own writes, airsync:Supported
  ghosting, truncated bodies sent back unchanged do not cut the stored text.
- Calendar mapping: TimeZone structure ([MS-ASDTYPE] 2.7.4) ↔ IANA zones (a timed series created
  on a device keeps its local time across DST changes), Recurrence ↔ RRULE (daily, weekly,
  monthly / yearly on a day or the nth weekday, interval, occurrences, until, first day of the
  week), exceptions ↔ EXDATE / RECURRENCE-ID overrides (deleted, changed and restored occurrences),
  attendees with status and type, reminder, busy status, sensitivity, all-day events, meeting
  status and response type.
- Tasks mapping: importance, start / due dates (UTC and local), completion (the task status rules
  apply; completing a recurring task on the phone creates the next one), reminder, privacy,
  recurrence. Notes: subject, body and (with the 9.5 note categories) notes:Categories both ways —
  trimmed, unique and capped like the REST API (storage `@coremail/storage/contact-card` export).
- GetItemEstimate, ItemOperations Fetch and Ping for the new collections; MoveItems moves an event
  between the user's own calendars. MeetingResponse keeps working: the accepted meeting reaches
  the phone's calendar with the returned CalendarId as its ServerId.
- Webmail module policies apply: with the calendar, tasks or notes module switched off the folders
  disappear from FolderSync and their Sync / Ping ask the device to refresh its folder list.
- Storage: ActiveSync tasks go through `task-store.ts` (`createTaskWithRules` / `updateTaskWithRules`),
  now the one task writer of REST, the CalDAV task list and ActiveSync. Meetings written by a phone
  book their rooms through storage `room-booking.ts` (moved from api-gateway `lib/room-booking.ts`):
  the same resource policy, conflict check and booking lock as the REST event form. Core:
  `restoreOccurrence` (calendar exceptions), an optional `tzid` for `buildVCalendar` and
  `patchVEvent` (`VEventPatch`).
- Tests: TimeZone and Recurrence mapping, WBXML byte fixtures for the three classes, the round trip
  of a recurring meeting with exceptions, PIM sync-state tests on the in-memory Prisma fake; e2e
  step `eas-pim`.

### Changed

- ActiveSync Ping answers Status 7 (folder hierarchy changed) when the folder hierarchy differs from
  the device's last FolderSync, so existing devices discover the new calendar / tasks / notes
  folders and later hierarchy changes without being set up again.
- ActiveSync MoveItems answers Status 2 (invalid destination) for a move between a mail folder and a
  calendar / tasks / notes folder, or between different PIM classes.
- Task writer (REST, CalDAV, ActiveSync): a task that is completed and stays completed keeps its
  stored rule — a client sending the completed occurrence again with its old RRULE / Recurrence no
  longer revives the series (reopened later it would have created a second next task). CalDAV had
  this rule since 9.5; REST and ActiveSync get it from the shared writer.
- ActiveSync calendar: a single timed event without zone is sent with the user's Region zone (a
  series in UTC still in UTC); a timed event added on a phone is stored with the phone's zone.

### Fixed

- ActiveSync PIM Sync: the ClientId → ServerId map of the retry detection is bound to the SyncKey of
  its request — a later request reusing a ClientId (devices count them per request) no longer gets
  the earlier item back while its new item is silently dropped.
- ActiveSync PIM Sync: a priming Sync without airsync:Supported drops the stored list (no stale
  ghosting after a device reset).
- ActiveSync FolderSync retried with the previous key after the hierarchy went back answers a new
  key with the snapshot the device holds — Ping no longer answers Status 7 forever.
- ActiveSync Ping on a PIM folder with an unreadable webmail policy answers Status 8 (server error)
  instead of 7.
- ActiveSync calendar Sync, GetItemEstimate and Ping read only the FilterType window and the events
  the device holds, not the whole calendar history.
- A timed event stored in UTC that a phone turns into a series moves to the phone's zone (or the
  Region zone when the phone echoes UTC) and keeps its local time across DST changes; the phone gets
  it back with that zone.

### Security

- Room bookings (REST and ActiveSync): a booking of a UID belongs to its organizer — booking,
  re-checking, refreshing or releasing with another organizer leaves it untouched (a booking
  attempt answers declined). Client-chosen UIDs (ActiveSync) cannot take over or cancel someone
  else's room.

### Known limits

- Device writes do not send meeting invitations to people (the device sends them itself, as before
  for MeetingResponse).
- Recurrence rules without an ActiveSync form (e.g. several month days, hourly) are not sent to the
  device and are kept unchanged on device edits.
- Contacts are a separate package (the class registry takes one more module).
