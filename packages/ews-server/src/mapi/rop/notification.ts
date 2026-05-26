/**
 * Notification-ROP-Handler — Phase v4.5.0
 *
 * STUB — Implementation kommt in v4.5.0.
 *
 * Geplante Handlers:
 *   - RopRegisterNotification (MS-OXCNOTIF §2.2.1.2.1)
 *   - RopNotify               (MS-OXCNOTIF §2.2.1.4.1) — Server → Client Push
 *   - RopPending              (MS-OXCNOTIF §2.2.1.4.2)
 *
 * Plus NotificationWait-Endpoint in emsmdb-handler.ts auf echten Long-Poll
 * upgrade:
 *
 *   1. Outlook ruft NotificationWait → Server hält Connection offen
 *   2. Server subscriben Redis-Channel `coremail:mail:new:<userId>` UND
 *      `coremail:folder:change:<userId>`
 *   3. Bei Event: Response mit EventPending=true + Events-Liste
 *   4. Bei Timeout (X-PendingPeriod ms): Response mit EventPending=false
 *
 * Event-Types (NotificationFlags, MS-OXCNOTIF §2.2.1.2.3):
 *   fnevNewMail    (0x0002) — neue Mail
 *   fnevObjectCreated (0x0004) — neuer Folder
 *   fnevObjectDeleted (0x0008)
 *   fnevObjectModified (0x0010)
 *   fnevObjectMoved (0x0020)
 *   fnevObjectCopied (0x0040)
 *   fnevSearchComplete (0x0080)
 *   fnevTableModified (0x0100)
 *   fnevStatusObjectModified (0x0200)
 *
 * Subscription-State:
 *   In Session-HandleTable: { kind: 'notification', eventMask, folderId }
 *
 * Wiederverwendung: bestehender CHANNEL_MAIL_NEW Redis-Channel aus
 * smtp-server/handlers/message.ts. Bridge ist 1-line: bei publish() den
 * neuen Mail-Event in MAPI-Notify-Format konvertieren.
 */
export {};
