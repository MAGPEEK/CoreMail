/**
 * Attachment-ROP-Handler — Phase v4.4.0
 *
 * STUB — Implementation kommt in v4.4.0.
 *
 * Geplante Handlers:
 *   - RopGetAttachmentTable    (MS-OXCMSG §2.2.2.1) — Tabelle der Anhänge
 *   - RopOpenAttachment        (MS-OXCMSG §2.2.2.9)
 *   - RopCreateAttachment      (MS-OXCMSG §2.2.2.8)
 *   - RopDeleteAttachment      (MS-OXCMSG §2.2.2.10)
 *   - RopSaveChangesAttachment (MS-OXCMSG §2.2.2.11)
 *   - RopOpenEmbeddedMessage   (MS-OXCMSG §2.2.2.13)
 *
 * Property-Mapping (Prisma Attachment → MAPI):
 *   filename       → PR_ATTACH_FILENAME / PR_ATTACH_LONG_FILENAME
 *   mimeType       → PR_ATTACH_MIME_TAG
 *   size           → PR_ATTACH_SIZE
 *   contentId      → PR_ATTACH_CONTENT_ID
 *   inline         → PR_ATTACHMENT_FLAGS (afHidden für inline)
 *   storagePath    → opaque MinIO-Key
 *
 * Datei-Inhalt wird via RopOpenStream(PR_ATTACH_DATA_BIN) + RopReadStream
 * gelesen (s. stream.ts).
 */
export {};
