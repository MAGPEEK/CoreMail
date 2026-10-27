/**
 * Submit-ROP-Handler — Phase v4.3.0 (Mail-Senden)
 *
 * STUB — Implementation kommt in v4.3.0.
 *
 * Geplante Handlers:
 *   - RopSubmitMessage     (MS-OXOMSG §2.2.6.1) — Mail in Sendewarteschlange
 *   - RopAbortSubmit       (MS-OXOMSG §2.2.6.4) — Submit abbrechen
 *   - RopGetTransportFolder (MS-OXOMSG §2.2.6.6)
 *
 * Submit-Flow:
 *   1. Outlook hat via RopCreateMessage/SetProperties/ModifyRecipients eine
 *      Message in einem temporären Folder (typischerweise Outbox = Drafts)
 *      konstruiert.
 *   2. Outlook ruft RopSubmitMessage(messageHandle, submitFlags).
 *   3. Server:
 *      a) Konvertiert Message-Properties zu RFC822/EML
 *      b) Push in BullMQ-Queue `smtp-outbound` (gleicher Pfad wie REST /mail/send)
 *      c) Verschiebt Message von Drafts nach Sent
 *      d) Antwortet mit StatusCode SUCCESS
 *   4. SMTP-Worker verarbeitet asynchron → DKIM-Sign → Relay
 *
 * Wiederverwendung: bestehende EML-Builder + BullMQ-Producer aus
 * packages/api-gateway/src/routes/mail.ts (POST /mail/send).
 */
export {};
