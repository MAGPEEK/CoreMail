/**
 * Submit ROP handler — phase v4.3.0 (sending mail)
 *
 * STUB — implementation arrives in v4.3.0.
 *
 * Planned handlers:
 *   - RopSubmitMessage     (MS-OXOMSG §2.2.6.1) — mail into the send queue
 *   - RopAbortSubmit       (MS-OXOMSG §2.2.6.4) — abort submit
 *   - RopGetTransportFolder (MS-OXOMSG §2.2.6.6)
 *
 * Submit flow:
 *   1. Outlook has constructed a message in a temporary folder (typically
 *      Outbox = Drafts) via RopCreateMessage/SetProperties/ModifyRecipients.
 *   2. Outlook calls RopSubmitMessage(messageHandle, submitFlags).
 *   3. Server:
 *      a) Converts message properties to RFC822/EML
 *      b) Pushes into the BullMQ queue `smtp-outbound` (same path as REST /mail/send)
 *      c) Moves the message from Drafts to Sent
 *      d) Answers with StatusCode SUCCESS
 *   4. The SMTP worker processes asynchronously → DKIM sign → relay
 *
 * Reuse: existing EML builder + BullMQ producer from
 * packages/api-gateway/src/routes/mail.ts (POST /mail/send).
 */
export {};
