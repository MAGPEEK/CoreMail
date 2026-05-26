/**
 * MAPI ROP-Types (v4.1.0)
 *
 * Konstanten und Typ-Definitionen für die Remote Operations (ROPs) gemäß
 * MS-OXCROPS §2.2. Wir implementieren initial die ROPs, die Outlook beim
 * Profile-Build nach Connect zwingend braucht.
 */

/**
 * ROP-IDs (MS-OXCROPS §2.2.2). Das erste Byte jedes ROP-Buffers.
 */
export const RopId = {
  // Logon
  Logon:                            0xFE,
  Logoff:                           0x02,

  // Folder Object Protocol (MS-OXCFOLD)
  OpenFolder:                       0x02,
  CreateFolder:                     0x1C,
  DeleteFolder:                     0x1D,
  DeleteMessages:                   0x1E,
  GetHierarchyTable:                0x04,
  GetContentsTable:                 0x05,
  GetSearchCriteria:                0x2B,
  SetSearchCriteria:                0x30,
  MoveCopyMessages:                 0x33,
  MoveFolder:                       0x35,
  CopyFolder:                       0x36,

  // Table Object Protocol (MS-OXCTABL)
  SetColumns:                       0x12,
  SortTable:                        0x13,
  Restrict:                         0x14,
  QueryRows:                        0x15,
  GetStatus:                        0x16,
  QueryPosition:                    0x17,
  SeekRow:                          0x18,
  SeekRowBookmark:                  0x19,
  SeekRowFractional:                0x1A,
  CreateBookmark:                   0x1B,
  QueryColumnsAll:                  0x37,
  ExpandRow:                        0x59,
  CollapseRow:                      0x5A,
  GetCollapseState:                 0x6B,
  SetCollapseState:                 0x6C,
  FreeBookmark:                     0x89,
  ResetTable:                       0x81,
  FindRow:                          0x4F,
  GetRowCount:                      0x8A,

  // Message Object Protocol (MS-OXCMSG)
  OpenMessage:                      0x03,
  CreateMessage:                    0x06,
  SaveChangesMessage:               0x0C,
  RemoveAllRecipients:              0x0D,
  ModifyRecipients:                 0x0E,
  ReadRecipients:                   0x0F,
  ReloadCachedInformation:          0x10,
  SetMessageReadFlag:               0x11,
  SetMessageStatus:                 0x20,
  GetMessageStatus:                 0x1F,
  SetReadFlags:                     0x66,
  OpenAttachment:                   0x22,
  CreateAttachment:                 0x23,
  DeleteAttachment:                 0x24,
  SaveChangesAttachment:            0x25,
  OpenEmbeddedMessage:              0x46,
  GetAttachmentTable:               0x21,
  GetValidAttachments:              0x52,

  // Stream Object Protocol (MS-OXCPRPT §2.2.x)
  OpenStream:                       0x2B,
  ReadStream:                       0x2C,
  WriteStream:                      0x2D,
  CommitStream:                     0x5D,
  GetStreamSize:                    0x5E,
  SetStreamSize:                    0x2F,
  SeekStream:                       0x2E,
  LockRegionStream:                 0x5B,
  UnlockRegionStream:               0x5C,
  WriteAndCommitStream:             0x90,
  CloneStream:                      0x3B,

  // Property Object Protocol (MS-OXCPRPT)
  GetPropertiesSpecific:            0x07,
  GetPropertiesAll:                 0x08,
  GetPropertiesList:                0x09,
  SetProperties:                    0x0A,
  SetPropertiesNoReplicate:         0x79,
  DeleteProperties:                 0x0B,
  DeletePropertiesNoReplicate:      0x7A,
  QueryNamedProperties:             0x2F,
  CopyProperties:                   0x67,
  CopyTo:                           0x39,
  GetPropertyIdsFromNames:          0x56,
  GetNamesFromPropertyIds:          0x55,

  // Submit / Send (MS-OXOMSG)
  SubmitMessage:                    0x32,
  AbortSubmit:                      0x34,
  GetTransportFolder:               0x6D,
  OptionsData:                      0x6F,

  // Notification (MS-OXCNOTIF)
  RegisterNotification:             0x29,
  Notify:                           0x2A,

  // Sync (MS-OXCFXICS)
  FastTransferSourceGetBuffer:      0x4E,
  FastTransferSourceCopyFolder:     0x4C,
  FastTransferSourceCopyMessages:   0x4B,
  FastTransferSourceCopyProperties: 0x69,
  FastTransferDestinationConfigure: 0x53,
  FastTransferDestinationPutBuffer: 0x54,
  SyncConfigure:                    0x70,
  SyncImportMessageChange:          0x72,
  SyncImportHierarchyChange:        0x73,
  SyncImportDeletes:                0x74,
  SyncUploadStateStreamBegin:       0x75,
  SyncUploadStateStreamContinue:    0x76,
  SyncUploadStateStreamEnd:         0x77,
  SyncImportMessageMove:            0x78,
  SyncOpenCollector:                0x7E,
  GetLocalReplicaIds:               0x7F,
  SyncGetTransferState:             0x82,

  // Common
  Release:                          0x01,
  Buffer:                           0xFF,           // Pseudo-RopId: end-of-stream marker
} as const;

export type RopIdValue = typeof RopId[keyof typeof RopId];

/**
 * Property-Type (MS-OXCDATA §2.11.1) — oberes Byte einer PropertyTag.
 */
export const PropType = {
  Unspecified:    0x0000,   // PT_UNSPECIFIED
  Null:           0x0001,   // PT_NULL
  Int16:          0x0002,   // PT_SHORT / PT_I2
  Int32:          0x0003,   // PT_LONG / PT_I4
  Float32:        0x0004,   // PT_FLOAT / PT_R4
  Float64:        0x0005,   // PT_DOUBLE / PT_R8
  Currency:       0x0006,
  AppTime:        0x0007,
  ErrorCode:      0x000A,   // PT_ERROR
  Boolean:        0x000B,   // PT_BOOLEAN
  Object:         0x000D,
  Int64:          0x0014,   // PT_I8
  String8:        0x001E,   // PT_STRING8 (codepage)
  Unicode:        0x001F,   // PT_UNICODE (UTF-16-LE)
  SysTime:        0x0040,   // PT_SYSTIME (FILETIME, 8 bytes)
  ClassId:        0x0048,   // PT_CLSID (16 bytes GUID)
  Binary:         0x0102,   // PT_BINARY (length-prefixed bytes)
  MultipleInt16:  0x1002,
  MultipleInt32:  0x1003,
  MultipleString: 0x101E,
  MultipleUnicode:0x101F,
  MultipleSysTime:0x1040,
  MultipleBinary: 0x1102,
} as const;

export type PropTypeValue = typeof PropType[keyof typeof PropType];

/**
 * Property-Tag = PropertyId (uint16) | (PropertyType << 16).
 * Outlook addressiert Properties über die Kombination ID+Type.
 *
 * Beispiel: PR_DISPLAY_NAME_W = 0x3001001F
 *   PropertyId = 0x3001
 *   PropertyType = 0x001F (Unicode)
 */
export function makePropTag(id: number, type: number): number {
  return ((id & 0xFFFF) << 16) | (type & 0xFFFF);
}

export function getPropId(tag: number): number {
  return (tag >>> 16) & 0xFFFF;
}

export function getPropType(tag: number): number {
  return tag & 0xFFFF;
}

/**
 * Standard-Property-Tags (MS-OXPROPS), die wir initial unterstützen.
 * Die Liste wird mit jeder ROP-Phase erweitert.
 */
export const PR = {
  // ── Folder Properties ──────────────────────────────────────────────────
  PR_DISPLAY_NAME_W:        makePropTag(0x3001, PropType.Unicode),
  PR_PARENT_ENTRYID:        makePropTag(0x0E09, PropType.Binary),
  PR_ENTRYID:               makePropTag(0x0FFF, PropType.Binary),
  PR_RECORD_KEY:            makePropTag(0x0FF9, PropType.Binary),
  PR_CONTAINER_CLASS_W:     makePropTag(0x3613, PropType.Unicode),
  PR_CONTENT_COUNT:         makePropTag(0x3602, PropType.Int32),
  PR_CONTENT_UNREAD:        makePropTag(0x3603, PropType.Int32),
  PR_SUBFOLDERS:            makePropTag(0x360A, PropType.Boolean),
  PR_FOLDER_TYPE:           makePropTag(0x3601, PropType.Int32),
  PR_FOLDER_ID:             makePropTag(0x6748, PropType.Int64),
  PR_PARENT_FOLDER_ID:      makePropTag(0x6749, PropType.Int64),
  PR_CHANGE_KEY:            makePropTag(0x65E2, PropType.Binary),
  PR_CHANGE_NUM:            makePropTag(0x67A4, PropType.Int64),
  PR_LOCAL_COMMIT_TIME:     makePropTag(0x6709, PropType.SysTime),
  PR_LAST_MODIFICATION_TIME: makePropTag(0x3008, PropType.SysTime),
  PR_CREATION_TIME:         makePropTag(0x3007, PropType.SysTime),
  PR_HIERARCHY_CHANGE_NUM:  makePropTag(0x663E, PropType.Int32),

  // ── Mailbox Logon Response ─────────────────────────────────────────────
  PR_USER_ENTRYID:          makePropTag(0x6619, PropType.Binary),
  PR_MAILBOX_OWNER_ENTRYID: makePropTag(0x661B, PropType.Binary),
  PR_MAILBOX_OWNER_NAME_W:  makePropTag(0x661C, PropType.Unicode),
  PR_IPM_SUBTREE_ENTRYID:   makePropTag(0x35E0, PropType.Binary),
  PR_IPM_INBOX_ENTRYID:     makePropTag(0x35E1, PropType.Binary),
  PR_IPM_OUTBOX_ENTRYID:    makePropTag(0x35E2, PropType.Binary),
  PR_IPM_SENTMAIL_ENTRYID:  makePropTag(0x35E4, PropType.Binary),
  PR_IPM_WASTEBASKET_ENTRYID: makePropTag(0x35E3, PropType.Binary),
  PR_VIEWS_ENTRYID:         makePropTag(0x35E5, PropType.Binary),
  PR_FINDER_ENTRYID:        makePropTag(0x35E7, PropType.Binary),
  PR_COMMON_VIEWS_ENTRYID:  makePropTag(0x35E6, PropType.Binary),

  // ── Message Properties ─────────────────────────────────────────────────
  PR_SUBJECT_W:             makePropTag(0x0037, PropType.Unicode),
  PR_NORMALIZED_SUBJECT_W:  makePropTag(0x0E1D, PropType.Unicode),
  PR_SUBJECT_PREFIX_W:      makePropTag(0x003D, PropType.Unicode),
  PR_BODY_W:                makePropTag(0x1000, PropType.Unicode),
  PR_HTML:                  makePropTag(0x1013, PropType.Binary),
  PR_BODY_HTML_W:           makePropTag(0x1013, PropType.Unicode),
  PR_RTF_COMPRESSED:        makePropTag(0x1009, PropType.Binary),
  PR_MESSAGE_FLAGS:         makePropTag(0x0E07, PropType.Int32),
  PR_MESSAGE_SIZE:          makePropTag(0x0E08, PropType.Int32),
  PR_MESSAGE_CLASS_W:       makePropTag(0x001A, PropType.Unicode),
  PR_MESSAGE_DELIVERY_TIME: makePropTag(0x0E06, PropType.SysTime),
  PR_CLIENT_SUBMIT_TIME:    makePropTag(0x0039, PropType.SysTime),
  PR_SENDER_NAME_W:         makePropTag(0x0C1A, PropType.Unicode),
  PR_SENDER_EMAIL_ADDRESS_W:makePropTag(0x0C1F, PropType.Unicode),
  PR_SENT_REPRESENTING_NAME_W: makePropTag(0x0042, PropType.Unicode),
  PR_SENT_REPRESENTING_EMAIL_ADDRESS_W: makePropTag(0x0065, PropType.Unicode),
  PR_DISPLAY_TO_W:          makePropTag(0x0E04, PropType.Unicode),
  PR_DISPLAY_CC_W:          makePropTag(0x0E03, PropType.Unicode),
  PR_DISPLAY_BCC_W:         makePropTag(0x0E02, PropType.Unicode),
  PR_HAS_ATTACH:            makePropTag(0x0E1B, PropType.Boolean),
  PR_PRIORITY:              makePropTag(0x0026, PropType.Int32),
  PR_IMPORTANCE:            makePropTag(0x0017, PropType.Int32),
  PR_INTERNET_MESSAGE_ID_W: makePropTag(0x1035, PropType.Unicode),
  PR_IN_REPLY_TO_ID_W:      makePropTag(0x1042, PropType.Unicode),
  PR_CONVERSATION_TOPIC_W:  makePropTag(0x0070, PropType.Unicode),
  PR_CONVERSATION_INDEX:    makePropTag(0x0071, PropType.Binary),
  PR_READ_RECEIPT_REQUESTED: makePropTag(0x0029, PropType.Boolean),

  // ── Recipient Properties (MS-OXOABK / MS-OXOMSG) ───────────────────────
  PR_EMAIL_ADDRESS_W:           makePropTag(0x3003, PropType.Unicode),
  PR_ADDRTYPE_W:                makePropTag(0x3002, PropType.Unicode),
  PR_SMTP_ADDRESS_W:            makePropTag(0x39FE, PropType.Unicode),
  PR_7BIT_DISPLAY_NAME_W:       makePropTag(0x39FF, PropType.Unicode),
  PR_RECIPIENT_TYPE:            makePropTag(0x0C15, PropType.Int32),
  PR_RECIPIENT_FLAGS:           makePropTag(0x5FFD, PropType.Int32),
  PR_RECIPIENT_DISPLAY_NAME_W:  makePropTag(0x5FF6, PropType.Unicode),
  PR_RECIPIENT_TRACKSTATUS:     makePropTag(0x5FFF, PropType.Int32),
  PR_SEND_INTERNET_ENCODING:    makePropTag(0x3A71, PropType.Int32),
  PR_OBJECT_TYPE:               makePropTag(0x0FFE, PropType.Int32),
  PR_DISPLAY_TYPE:              makePropTag(0x3900, PropType.Int32),
} as const;

/**
 * Message-Flags (PR_MESSAGE_FLAGS, MS-OXPROPS §2.788).
 */
export const MsgFlags = {
  Read:           0x00000001,
  Unsent:         0x00000008,
  Resend:         0x00000080,
  RecipientLocked:0x00000200,
  Submitted:      0x00000004,
  HasAttach:      0x00000010,
  FromMe:         0x00000020,
  Associated:     0x00000040,
  NotifyRead:     0x00000100,
  NotifyUnread:   0x00000200,
} as const;

/**
 * Logon-Flags (MS-OXCSTOR §2.2.1.1.1.1).
 */
export const LogonFlags = {
  Private:        0x01,   // mailbox of a specific user
  Undercover:     0x02,   // do not propagate session
  Ghosted:        0x04,
  SpoolerProcess: 0x08,
} as const;

/**
 * OpenModeFlags (MS-OXCFOLD §2.2.1.1.2.1).
 */
export const FolderOpenMode = {
  OpenSoftDeleted: 0x04,
} as const;
