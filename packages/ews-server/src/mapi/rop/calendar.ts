/**
 * Calendar-ROP-Mapping — Phase v4.6.0
 *
 * STUB — Implementation kommt in v4.6.0.
 *
 * Outlook behandelt Kalender-Termine als **Messages** mit MessageClass
 * `IPM.Appointment` in einem speziellen Folder (`PR_CONTAINER_CLASS_W =
 * "IPF.Appointment"`). Es gibt keine separaten Calendar-ROPs — wir nutzen
 * dieselben Message- + Stream-ROPs wie für Mail.
 *
 * Was wir in v4.6.0 ergänzen:
 *   - Folder-Discovery: Calendar-Folder = `CalendarSection` aus Prisma →
 *     Hierarchy-Tabelle muss diesen mit PR_CONTAINER_CLASS_W="IPF.Appointment"
 *     ausweisen.
 *   - Property-Mapping `CalendarEvent` ↔ MAPI Appointment Properties:
 *     - Summary/Subject     → PR_SUBJECT_W
 *     - Description         → PR_BODY_W
 *     - Location            → PidLidLocation (named property)
 *     - StartDate           → PidLidAppointmentStartWhole
 *     - EndDate             → PidLidAppointmentEndWhole
 *     - AllDay              → PidLidAppointmentSubType
 *     - Attendees           → RecipientList + PidLidAppointmentRecur
 *     - Recurrence          → PidLidAppointmentRecur (Pattern-Binary)
 *     - BusyStatus          → PidLidBusyStatus
 *     - Reminder            → PidLidReminderSet + PidLidReminderMinutes
 *
 * Named Properties:
 *   Outlook nutzt für Appointment-Felder GUID-prefixed named properties
 *   (PSETID_Appointment = "00062002-0000-0000-C000-000000000046").
 *   Diese werden via RopGetPropertyIdsFromNames in lokale PropertyIds aufgelöst.
 *   In v4.6.0 brauchen wir einen Named-Property-Cache.
 *
 * Free/Busy:
 *   Via existing /api/v1/calendar/freebusy Endpoint, im MAPI als
 *   PR_FREEBUSY_DATA Property.
 *
 * iMIP/iTIP-Integration:
 *   Bei RopSubmitMessage(IPM.Appointment) → bestehender iMIP-Sender aus
 *   packages/api-gateway/src/lib/imip.ts wiederverwenden.
 */
export {};
