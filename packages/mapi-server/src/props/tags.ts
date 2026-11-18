/**
 * Property types (MS-OXCDATA 2.11.1) and the property tags the server knows
 * (MS-OXPROPS). A property tag is (PropertyId << 16) | PropertyType.
 */

export const PropType = {
  Unspecified: 0x0000,
  Null: 0x0001,
  Integer16: 0x0002,
  Integer32: 0x0003,
  Floating32: 0x0004,
  Floating64: 0x0005,
  Currency: 0x0006,
  FloatingTime: 0x0007,
  ErrorCode: 0x000a,
  Boolean: 0x000b,
  Object: 0x000d,
  Integer64: 0x0014,
  String8: 0x001e,
  String: 0x001f,
  Time: 0x0040,
  Guid: 0x0048,
  ServerId: 0x00fb,
  Binary: 0x0102,
  MultipleInteger16: 0x1002,
  MultipleInteger32: 0x1003,
  MultipleFloating32: 0x1004,
  MultipleFloating64: 0x1005,
  MultipleCurrency: 0x1006,
  MultipleFloatingTime: 0x1007,
  MultipleInteger64: 0x1014,
  MultipleString8: 0x101e,
  MultipleString: 0x101f,
  MultipleTime: 0x1040,
  MultipleGuid: 0x1048,
  MultipleBinary: 0x1102,
} as const;

export const MULTI_VALUE_FLAG = 0x1000;

export function tag(id: number, type: number): number {
  return (((id & 0xffff) << 16) | (type & 0xffff)) >>> 0;
}
export const propIdOf = (t: number): number => (t >>> 16) & 0xffff;
export const propTypeOf = (t: number): number => t & 0xffff;

const T = PropType;

/** Property tags (MS-OXPROPS canonical names without the "PidTag" prefix). */
export const Tag = {
  // Common object properties
  DisplayName: tag(0x3001, T.String),
  EntryId: tag(0x0fff, T.Binary),
  ParentEntryId: tag(0x0e09, T.Binary),
  RecordKey: tag(0x0ff9, T.Binary),
  InstanceKey: tag(0x0ff6, T.Binary),
  SearchKey: tag(0x300b, T.Binary),
  ChangeKey: tag(0x65e2, T.Binary),
  PredecessorChangeList: tag(0x65e3, T.Binary),
  ObjectType: tag(0x0ffe, T.Integer32),
  Access: tag(0x0ff4, T.Integer32),
  AccessLevel: tag(0x0ff7, T.Integer32),
  CreationTime: tag(0x3007, T.Time),
  LastModificationTime: tag(0x3008, T.Time),
  Comment: tag(0x3004, T.String),

  // Table helpers
  RowType: tag(0x0ff5, T.Integer32),
  Depth: tag(0x3005, T.Integer32),
  InstID: tag(0x674d, T.Integer64),
  InstanceNum: tag(0x674e, T.Integer32),

  // Folders
  FolderId: tag(0x6748, T.Integer64),
  ParentFolderId: tag(0x6749, T.Integer64),
  Mid: tag(0x674a, T.Integer64),
  ContentCount: tag(0x3602, T.Integer32),
  ContentUnreadCount: tag(0x3603, T.Integer32),
  Subfolders: tag(0x360a, T.Boolean),
  FolderType: tag(0x3601, T.Integer32),
  ContainerClass: tag(0x3613, T.String),
  Rights: tag(0x6639, T.Integer32),
  FolderChildCount: tag(0x6638, T.Integer32),
  HierarchyChangeNumber: tag(0x663e, T.Integer32),
  AttributeHidden: tag(0x10f4, T.Boolean),
  MessageSizeExtended: tag(0x0e08, T.Integer64),

  // Store (logon object)
  IpmSubtreeEntryId: tag(0x35e0, T.Binary),
  IpmOutboxEntryId: tag(0x35e2, T.Binary),
  IpmWastebasketEntryId: tag(0x35e3, T.Binary),
  IpmSentMailEntryId: tag(0x35e4, T.Binary),
  ViewsEntryId: tag(0x35e5, T.Binary),
  CommonViewsEntryId: tag(0x35e6, T.Binary),
  FinderEntryId: tag(0x35e7, T.Binary),
  IpmDraftsEntryId: tag(0x36d7, T.Binary),
  UserEntryId: tag(0x6619, T.Binary),
  MailboxOwnerEntryId: tag(0x661b, T.Binary),
  MailboxOwnerName: tag(0x661c, T.String),
  OutOfOfficeState: tag(0x661d, T.Boolean),
  StoreSupportMask: tag(0x340d, T.Integer32),
  StoreState: tag(0x340e, T.Integer32),
  StoreRecordKey: tag(0x0ffa, T.Binary),
  StoreEntryId: tag(0x0ffb, T.Binary),
  MappingSignature: tag(0x0ff8, T.Binary),
  MaximumSubmitMessageSize: tag(0x666d, T.Integer32),

  // Messages
  MessageClass: tag(0x001a, T.String),
  Subject: tag(0x0037, T.String),
  SubjectPrefix: tag(0x003d, T.String),
  NormalizedSubject: tag(0x0e1d, T.String),
  ConversationTopic: tag(0x0070, T.String),
  MessageFlags: tag(0x0e07, T.Integer32),
  MessageSize: tag(0x0e08, T.Integer32),
  MessageStatus: tag(0x0e17, T.Integer32),
  MessageDeliveryTime: tag(0x0e06, T.Time),
  ClientSubmitTime: tag(0x0039, T.Time),
  SenderName: tag(0x0c1a, T.String),
  SenderEmailAddress: tag(0x0c1f, T.String),
  SenderAddressType: tag(0x0c1e, T.String),
  SenderSmtpAddress: tag(0x5d01, T.String),
  SentRepresentingName: tag(0x0042, T.String),
  SentRepresentingEmailAddress: tag(0x0065, T.String),
  SentRepresentingAddressType: tag(0x0064, T.String),
  SentRepresentingSmtpAddress: tag(0x5d02, T.String),
  DisplayTo: tag(0x0e04, T.String),
  DisplayCc: tag(0x0e03, T.String),
  DisplayBcc: tag(0x0e02, T.String),
  HasAttachments: tag(0x0e1b, T.Boolean),
  Importance: tag(0x0017, T.Integer32),
  Priority: tag(0x0026, T.Integer32),
  Sensitivity: tag(0x0036, T.Integer32),
  InternetMessageId: tag(0x1035, T.String),
  InReplyToId: tag(0x1042, T.String),
  InternetReferences: tag(0x1039, T.String),
  Body: tag(0x1000, T.String),
  Html: tag(0x1013, T.Binary),
  RtfCompressed: tag(0x1009, T.Binary),
  NativeBody: tag(0x1016, T.Integer32),
  InternetCodepage: tag(0x3fde, T.Integer32),
  IconIndex: tag(0x1080, T.Integer32),
  Read: tag(0x0e69, T.Boolean),
  ReadReceiptRequested: tag(0x0029, T.Boolean),
  DeleteAfterSubmit: tag(0x0e01, T.Boolean),
  SentMailEntryId: tag(0x0e0a, T.Binary),
  TransportMessageHeaders: tag(0x007d, T.String),
  MessageRecipients: tag(0x0e12, T.Object),
  MessageAttachments: tag(0x0e13, T.Object),

  // Recipients
  RecipientType: tag(0x0c15, T.Integer32),
  EmailAddress: tag(0x3003, T.String),
  AddressType: tag(0x3002, T.String),
  SmtpAddress: tag(0x39fe, T.String),
  DisplayType: tag(0x3900, T.Integer32),
  RecipientDisplayName: tag(0x5ff6, T.String),
  TransmittableDisplayName: tag(0x3a20, T.String),
  Rowid: tag(0x3000, T.Integer32),

  // Attachments
  AttachNumber: tag(0x0e21, T.Integer32),
  AttachMethod: tag(0x3705, T.Integer32),
  AttachLongFilename: tag(0x3707, T.String),
  AttachFilename: tag(0x3704, T.String),
  AttachExtension: tag(0x3703, T.String),
  AttachMimeTag: tag(0x370e, T.String),
  AttachSize: tag(0x0e20, T.Integer32),
  AttachContentId: tag(0x3712, T.String),
  AttachDataBinary: tag(0x3701, T.Binary),
  AttachFlags: tag(0x3714, T.Integer32),
  AttachmentHidden: tag(0x7ffe, T.Boolean),
  RenderingPosition: tag(0x370b, T.Integer32),
} as const;

/** MAPI object types (PidTagObjectType). */
export const ObjectType = { Store: 1, Folder: 3, Message: 5, MailUser: 6, Attachment: 7 } as const;

/** PidTagMessageFlags bits (MS-OXCMSG 2.2.1.6). */
export const MessageFlag = {
  Read: 0x00000001,
  Unmodified: 0x00000002,
  Submitted: 0x00000004,
  Unsent: 0x00000008,
  HasAttach: 0x00000010,
  FromMe: 0x00000020,
  Associated: 0x00000040,
} as const;

/** PidTagRecipientType values (MS-OXCMSG 2.2.3.1.2). */
export const RecipientKind = { To: 1, Cc: 2, Bcc: 3 } as const;
