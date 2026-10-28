/**
 * Calendar ROP mapping — phase v4.6.0
 *
 * STUB — implementation arrives in v4.6.0.
 *
 * Outlook treats calendar appointments as **messages** with MessageClass
 * `IPM.Appointment` in a special folder (`PR_CONTAINER_CLASS_W =
 * "IPF.Appointment"`). There are no separate calendar ROPs — we use
 * the same message + stream ROPs as for mail.
 *
 * What we add in v4.6.0:
 *   - Folder discovery: calendar folder = `CalendarSection` from Prisma →
 *     the hierarchy table must flag it with PR_CONTAINER_CLASS_W="IPF.Appointment".
 *   - Property mapping `CalendarEvent` ↔ MAPI appointment properties:
 *     - Summary/Subject     → PR_SUBJECT_W
 *     - Description         → PR_BODY_W
 *     - Location            → PidLidLocation (named property)
 *     - StartDate           → PidLidAppointmentStartWhole
 *     - EndDate             → PidLidAppointmentEndWhole
 *     - AllDay              → PidLidAppointmentSubType
 *     - Attendees           → RecipientList + PidLidAppointmentRecur
 *     - Recurrence          → PidLidAppointmentRecur (pattern binary)
 *     - BusyStatus          → PidLidBusyStatus
 *     - Reminder            → PidLidReminderSet + PidLidReminderMinutes
 *
 * Named properties:
 *   Outlook uses GUID-prefixed named properties for appointment fields
 *   (PSETID_Appointment = "00062002-0000-0000-C000-000000000046").
 *   These are resolved to local PropertyIds via RopGetPropertyIdsFromNames.
 *   In v4.6.0 we need a named-property cache.
 *
 * Free/Busy:
 *   Via the existing /api/v1/calendar/freebusy endpoint, in MAPI as the
 *   PR_FREEBUSY_DATA property.
 *
 * iMIP/iTIP integration:
 *   On RopSubmitMessage(IPM.Appointment) → reuse the existing iMIP sender from
 *   packages/api-gateway/src/lib/imip.ts.
 */
export {};
