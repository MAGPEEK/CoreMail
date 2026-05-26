/**
 * Message-ROP-Handler — Phase v4.2.0 (Mail-Lesen) + v4.3.0 (Mail-Schreiben)
 *
 * STUB — Implementation kommt in v4.2.0+.
 *
 * Geplante Handlers:
 *   v4.2.0:
 *     - RopOpenMessage           (MS-OXCMSG §2.2.3.1)
 *     - RopGetPropertiesAll      (MS-OXCPRPT §2.2.3.1)
 *     - RopGetPropertiesSpecific (MS-OXCPRPT §2.2.4.1)
 *     - RopGetPropertiesList     (MS-OXCPRPT §2.2.5.1)
 *
 *   v4.3.0:
 *     - RopCreateMessage         (MS-OXCMSG §2.2.6.1)
 *     - RopSaveChangesMessage    (MS-OXCMSG §2.2.3.3)
 *     - RopSetProperties         (MS-OXCPRPT §2.2.6.1)
 *     - RopDeleteProperties      (MS-OXCPRPT §2.2.7.1)
 *     - RopRemoveAllRecipients   (MS-OXCMSG §2.2.5.1)
 *     - RopModifyRecipients      (MS-OXCMSG §2.2.5.2)
 *     - RopReadRecipients        (MS-OXCMSG §2.2.5.4)
 *     - RopSetMessageReadFlag    (MS-OXCMSG §2.2.4.1)
 *
 * Property-Mapping (Prisma Message → MAPI Properties):
 *   subject       → PR_SUBJECT_W
 *   fromAddr      → PR_SENDER_EMAIL_ADDRESS_W
 *   fromName      → PR_SENDER_NAME_W
 *   toAddrs       → PR_DISPLAY_TO_W (joined)
 *   ccAddrs       → PR_DISPLAY_CC_W
 *   bccAddrs      → PR_DISPLAY_BCC_W
 *   date          → PR_MESSAGE_DELIVERY_TIME
 *   bodyText      → PR_BODY_W
 *   bodyHtml      → PR_BODY_HTML_W / PR_HTML
 *   flags         → PR_MESSAGE_FLAGS (mfRead/mfUnsent/etc.)
 *   rawSize       → PR_MESSAGE_SIZE
 *   messageId     → PR_INTERNET_MESSAGE_ID_W
 *   inReplyTo     → PR_IN_REPLY_TO_ID_W
 *   replyTo       → PR_REPLY_RECIPIENT_ENTRIES (RecipientList)
 *
 * Body-Loading-Strategie:
 *   Wenn Message.storagePath gesetzt: Body kommt aus MinIO über uploadBuffer
 *   Sonst: bodyText/bodyHtml direkt aus DB
 *   → exposed via RopOpenStream(PR_BODY_W/PR_BODY_HTML_W) + RopReadStream
 */
export {};
