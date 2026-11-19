# w3-room-replies — rooms answer mailed invitations

SemVer: MINOR (compatible feature). Additive schema change (`ResourceMailbox.sendReplies Boolean
@default(true)`); no removed or changed endpoint. Behaviour change worth noting in the release
notes: rooms and equipment that receive invitations by mail now send reply mails by default.

### Added

- Resource mailboxes (rooms / equipment) answer a meeting request that arrives by mail with an
  iMIP REPLY to the organizer: `METHOD:REPLY`, the resource as the only attendee with
  `PARTSTAT` `ACCEPTED`, `DECLINED`, or `TENTATIVE` while the booking waits for approval. A
  request with only single occurrences is answered per occurrence (`RECURRENCE-ID`, at most 10);
  a declined occurrence update is declined for exactly those occurrences while the series keeps
  its answer. German subject ("Angenommen: …", "Abgelehnt: …", "Mit Vorbehalt angenommen: …")
  and text part with the reason of a decline (conflicting dates, booking window, maximum
  duration, series not allowed, series repeats too often, not bookable), the dates that conflict
  with an acceptance, or the pending approval. Sent through the outbound queue from the
  resource's address (DKIM of its domain) with `Auto-Submitted: auto-replied`, threaded to the
  request (`In-Reply-To` / `References`); a local delivery counts as sent by the resource, so the
  organizer's CoreMail calendar applies the answer.
- Resource setting `sendReplies` ("send replies", default on) in the REST admin API
  (`POST`/`PUT /api/v1/admin/resources[/:id]`).

### Changed

- `REPLY`, `COUNTER`, `DECLINECOUNTER` and `REFRESH` messages sent to a resource mailbox are
  ignored; they were processed like a booking request before.
- Bookings from the event form and from ActiveSync phones still send no mail (the answer is shown
  in the form / on the phone); documented in docs/calendar.md.

### Security

- No automatic answer to an unauthenticated organizer (no backscatter to forged addresses), a null
  envelope sender, automatically submitted, bulk or mailing-list mail, automated senders, the
  resource itself or another resource mailbox — no reply loops between resources or with bounces.
