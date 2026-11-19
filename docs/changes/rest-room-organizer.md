# rest-room-organizer — attendee copies leave the organizer's rooms alone

SemVer: PATCH (fix). No schema, endpoint or configuration change.

### Fixed

- REST calendar: moving, changing or deleting an attendee's copy of someone else's meeting
  (`PUT` / `DELETE /api/v1/calendar/events/:id`, also `?occurrence=`) no longer rebooks,
  refreshes or releases the organizer's room bookings — the copy changes only itself. Rooms change
  only on the organizer's copy: saved by the organizer (own address or alias) or by a delegate
  with write access to the organizer's calendar.

### Security

- REST calendar: an attendee's copy no longer sends invitation updates or cancellations (iMIP
  REQUEST / CANCEL) to the other attendees in the organizer's name.
