/**
 * WBXML codec for ActiveSync (EAS 12.1 – 14.1, MS-ASWBXML)
 * Implements the subset of WBXML used by ActiveSync.
 */

// ─── EAS Code Pages ──────────────────────────────────────────────────────────
// Each code page maps token byte → element name. Page numbers and tokens follow
// [MS-ASWBXML] (EAS 14.1; tokens newer than 12.1 are listed in TOKEN_SINCE below).
// The same element name exists on several pages
// (Status, SyncKey, ServerId, Add, Folder, …) — the encoder therefore resolves a
// name on the PARENT element's page first (see resolveToken / encodeWbxml).
const CODE_PAGES: Record<number, Record<number, string>> = {
  // Code page 0: AirSync
  0: {
    0x05: 'Sync', 0x06: 'Responses', 0x07: 'Add', 0x08: 'Change',
    0x09: 'Delete', 0x0a: 'Fetch', 0x0b: 'SyncKey', 0x0c: 'ClientId',
    0x0d: 'ServerId', 0x0e: 'Status', 0x0f: 'Collection', 0x10: 'Class',
    0x12: 'CollectionId', 0x13: 'GetChanges', 0x14: 'MoreAvailable',
    0x15: 'WindowSize', 0x16: 'Commands', 0x17: 'Options', 0x18: 'FilterType',
    0x19: 'Truncation', 0x1a: 'RtfTruncation', 0x1b: 'Conflict',
    0x1c: 'Collections', 0x1d: 'ApplicationData', 0x1e: 'DeletesAsMoves',
    0x1f: 'NotifyGUID', 0x20: 'Supported', 0x21: 'SoftDelete',
    0x22: 'MIMESupport', 0x23: 'MIMETruncation', 0x24: 'Wait', 0x25: 'Limit',
    0x26: 'Partial', 0x27: 'ConversationMode', 0x28: 'MaxItems',
    0x29: 'HeartbeatInterval',
  },
  // Code page 1: Contacts ([MS-ASWBXML] 2.1.2.1.2; the 2.5-only Body / BodySize / BodyTruncated /
  // CompressedRTF tokens 0x09–0x0B, 0x3B and the 16.0 Alias / WeightedRank are left out)
  1: {
    0x05: 'Anniversary', 0x06: 'AssistantName', 0x07: 'AssistantPhoneNumber', 0x08: 'Birthday',
    0x0c: 'Business2PhoneNumber', 0x0d: 'BusinessAddressCity', 0x0e: 'BusinessAddressCountry',
    0x0f: 'BusinessAddressPostalCode', 0x10: 'BusinessAddressState', 0x11: 'BusinessAddressStreet',
    0x12: 'BusinessFaxNumber', 0x13: 'BusinessPhoneNumber', 0x14: 'CarPhoneNumber', 0x15: 'Categories',
    0x16: 'Category', 0x17: 'Children', 0x18: 'Child', 0x19: 'CompanyName', 0x1a: 'Department',
    0x1b: 'Email1Address', 0x1c: 'Email2Address', 0x1d: 'Email3Address', 0x1e: 'FileAs', 0x1f: 'FirstName',
    0x20: 'Home2PhoneNumber', 0x21: 'HomeAddressCity', 0x22: 'HomeAddressCountry', 0x23: 'HomeAddressPostalCode',
    0x24: 'HomeAddressState', 0x25: 'HomeAddressStreet', 0x26: 'HomeFaxNumber', 0x27: 'HomePhoneNumber',
    0x28: 'JobTitle', 0x29: 'LastName', 0x2a: 'MiddleName', 0x2b: 'MobilePhoneNumber', 0x2c: 'OfficeLocation',
    0x2d: 'OtherAddressCity', 0x2e: 'OtherAddressCountry', 0x2f: 'OtherAddressPostalCode', 0x30: 'OtherAddressState',
    0x31: 'OtherAddressStreet', 0x32: 'PagerNumber', 0x33: 'RadioPhoneNumber', 0x34: 'Spouse', 0x35: 'Suffix',
    0x36: 'Title', 0x37: 'WebPage', 0x38: 'YomiCompanyName', 0x39: 'YomiFirstName', 0x3a: 'YomiLastName',
    0x3c: 'Picture',
  },
  // Code page 12: Contacts2 ([MS-ASWBXML] 2.1.2.1.13)
  12: {
    0x05: 'CustomerId', 0x06: 'GovernmentId', 0x07: 'IMAddress', 0x08: 'IMAddress2', 0x09: 'IMAddress3',
    0x0a: 'ManagerName', 0x0b: 'CompanyMainPhone', 0x0c: 'AccountName', 0x0d: 'NickName', 0x0e: 'MMS',
  },
  // Code page 2: Email
  2: {
    0x05: 'Attachment', 0x06: 'Attachments', 0x07: 'AttName',
    0x08: 'AttSize', 0x09: 'Att0Id', 0x0a: 'AttMethod', 0x0b: 'AttRemoved',
    0x0c: 'Body', 0x0d: 'BodySize', 0x0e: 'BodyTruncated',
    0x0f: 'DateReceived', 0x10: 'DisplayName', 0x11: 'DisplayTo',
    0x12: 'Importance', 0x13: 'MessageClass', 0x14: 'Subject',
    0x15: 'Read', 0x16: 'To', 0x17: 'Cc', 0x18: 'From', 0x19: 'ReplyTo',
    0x1a: 'AllDayEvent', 0x1b: 'Categories', 0x1c: 'Category',
    0x1d: 'DtStamp', 0x1e: 'EndTime', 0x1f: 'InstanceType',
    0x20: 'BusyStatus', 0x21: 'Location', 0x22: 'MeetingRequest',
    0x23: 'Organizer', 0x24: 'RecurrenceId', 0x25: 'Reminder',
    0x26: 'ResponseRequested', 0x27: 'Recurrences', 0x28: 'Recurrence',
    0x29: 'Type', 0x2a: 'Until', 0x2b: 'Occurrences', 0x2c: 'Interval',
    0x2d: 'DayOfWeek', 0x2e: 'DayOfMonth', 0x2f: 'WeekOfMonth',
    0x30: 'MonthOfYear', 0x31: 'StartTime', 0x32: 'Sensitivity',
    0x33: 'TimeZone', 0x34: 'GlobalObjId', 0x35: 'ThreadTopic',
    0x36: 'MIMEData', 0x37: 'MIMETruncated', 0x38: 'MIMESize',
    0x39: 'InternetCPID', 0x3a: 'Flag', 0x3b: 'FlagStatus',
    0x3c: 'ContentClass', 0x3d: 'FlagType', 0x3e: 'CompleteTime',
    0x3f: 'DisallowNewTimeProposal',
  },
  // Code page 4: Calendar ([MS-ASWBXML] 2.1.2.1.5; the 2.5-only Body / BodyTruncated /
  // Compressed RTF tokens 0x0B, 0x0C, 0x10 are left out — 12.1+ uses airsyncbase:Body)
  4: {
    0x05: 'TimeZone', 0x06: 'AllDayEvent', 0x07: 'Attendees', 0x08: 'Attendee', 0x09: 'Email',
    0x0a: 'Name', 0x0d: 'BusyStatus', 0x0e: 'Categories', 0x0f: 'Category', 0x11: 'DtStamp',
    0x12: 'EndTime', 0x13: 'Exception', 0x14: 'Exceptions', 0x15: 'Deleted',
    0x16: 'ExceptionStartTime', 0x17: 'Location', 0x18: 'MeetingStatus', 0x19: 'OrganizerEmail',
    0x1a: 'OrganizerName', 0x1b: 'Recurrence', 0x1c: 'Type', 0x1d: 'Until', 0x1e: 'Occurrences',
    0x1f: 'Interval', 0x20: 'DayOfWeek', 0x21: 'DayOfMonth', 0x22: 'WeekOfMonth',
    0x23: 'MonthOfYear', 0x24: 'Reminder', 0x25: 'Sensitivity', 0x26: 'Subject',
    0x27: 'StartTime', 0x28: 'UID', 0x29: 'AttendeeStatus', 0x2a: 'AttendeeType',
    0x33: 'DisallowNewTimeProposal', 0x34: 'ResponseRequested', 0x35: 'AppointmentReplyTime',
    0x36: 'ResponseType', 0x37: 'CalendarType', 0x38: 'IsLeapMonth', 0x39: 'FirstDayOfWeek',
    0x3a: 'OnlineMeetingConfLink', 0x3b: 'OnlineMeetingExternalLink',
  },
  // Code page 6: GetItemEstimate ([MS-ASWBXML]; Version/Class/DateTime are EAS 12.1 only)
  6: {
    0x05: 'GetItemEstimate', 0x06: 'Version', 0x07: 'Collections', 0x08: 'Collection',
    0x09: 'Class', 0x0a: 'CollectionId', 0x0b: 'DateTime', 0x0c: 'Estimate',
    0x0d: 'Response', 0x0e: 'Status',
  },
  // Code page 7: FolderHierarchy
  7: {
    0x05: 'Folders', 0x06: 'Folder', 0x07: 'DisplayName', 0x08: 'ServerId',
    0x09: 'ParentId', 0x0a: 'Type', 0x0b: 'Response', 0x0c: 'Status',
    0x0d: 'ContentClass', 0x0e: 'Changes', 0x0f: 'Add', 0x10: 'Delete',
    0x11: 'Update', 0x12: 'SyncKey', 0x13: 'FolderCreate', 0x14: 'FolderDelete',
    0x15: 'FolderUpdate', 0x16: 'FolderSync', 0x17: 'Count',
  },
  // Code page 5: Move
  5: {
    0x05: 'MoveItems', 0x06: 'Move', 0x07: 'SrcMsgId', 0x08: 'SrcFldId',
    0x09: 'DstFldId', 0x0a: 'Response', 0x0b: 'Status', 0x0c: 'DstMsgId',
  },
  // Code page 8: MeetingResponse
  8: {
    0x05: 'CalendarId', 0x06: 'CollectionId', 0x07: 'MeetingResponse',
    0x08: 'RequestId', 0x09: 'Request', 0x0a: 'Result', 0x0b: 'Status',
    0x0c: 'UserResponse', 0x0e: 'InstanceId',
    0x10: 'ProposedStartTime', 0x11: 'ProposedEndTime', 0x12: 'SendResponse',
  },
  // Code page 9: Tasks ([MS-ASWBXML] 2.1.2.1.10) — 9.4: the tasks:* children of email:Flag
  9: {
    0x08: 'Categories', 0x09: 'Category', 0x0a: 'Complete', 0x0b: 'DateCompleted',
    0x0c: 'DueDate', 0x0d: 'UtcDueDate', 0x0e: 'Importance', 0x0f: 'Recurrence',
    0x10: 'Type', 0x11: 'Start', 0x12: 'Until', 0x13: 'Occurrences', 0x14: 'Interval',
    0x15: 'DayOfMonth', 0x16: 'DayOfWeek', 0x17: 'WeekOfMonth', 0x18: 'MonthOfYear',
    0x19: 'Regenerate', 0x1a: 'DeadOccur', 0x1b: 'ReminderSet', 0x1c: 'ReminderTime',
    0x1d: 'Sensitivity', 0x1e: 'StartDate', 0x1f: 'UtcStartDate', 0x20: 'Subject',
    0x22: 'OrdinalDate', 0x23: 'SubOrdinalDate', 0x24: 'CalendarType', 0x25: 'IsLeapMonth',
    0x26: 'FirstDayOfWeek',
  },
  // Code page 10: ResolveRecipients
  10: {
    0x05: 'ResolveRecipients', 0x06: 'Response', 0x07: 'Status', 0x08: 'Type',
    0x09: 'Recipient', 0x0a: 'DisplayName', 0x0b: 'EmailAddress',
    0x0c: 'Certificates', 0x0d: 'Certificate', 0x0e: 'MiniCertificate',
    0x0f: 'Options', 0x10: 'To', 0x11: 'CertificateRetrieval',
    0x12: 'RecipientCount', 0x13: 'MaxCertificates', 0x14: 'MaxAmbiguousRecipients',
    0x15: 'CertificateCount', 0x16: 'Availability', 0x17: 'StartTime',
    0x18: 'EndTime', 0x19: 'MergedFreeBusy', 0x1a: 'Picture', 0x1b: 'MaxSize',
    0x1c: 'Data', 0x1d: 'MaxPictures',
  },
  // Code page 13: Ping
  13: {
    0x05: 'Ping', 0x06: 'AutdState', 0x07: 'Status', 0x08: 'HeartbeatInterval',
    0x09: 'Folders', 0x0a: 'Folder', 0x0b: 'Id', 0x0c: 'Class',
    0x0d: 'MaxFolders',
  },
  // Code page 14: Provision
  14: {
    0x05: 'Provision', 0x06: 'Policies', 0x07: 'Policy', 0x08: 'PolicyType',
    0x09: 'PolicyKey', 0x0a: 'Data', 0x0b: 'Status', 0x0c: 'RemoteWipe',
    0x0d: 'EASProvisionDoc', 0x0e: 'DevicePasswordEnabled',
    0x0f: 'AlphanumericDevicePasswordRequired', 0x10: 'RequireStorageCardEncryption',
    0x11: 'PasswordRecoveryEnabled', 0x13: 'AttachmentsEnabled',
    0x14: 'MinDevicePasswordLength', 0x15: 'MaxInactivityTimeDeviceLock',
    0x16: 'MaxDevicePasswordFailedAttempts', 0x17: 'MaxAttachmentSize',
    0x18: 'AllowSimpleDevicePassword', 0x19: 'DevicePasswordExpiration',
    0x1a: 'DevicePasswordHistory', 0x1b: 'AllowStorageCard', 0x1c: 'AllowCamera',
    0x1d: 'RequireDeviceEncryption', 0x1e: 'AllowUnsignedApplications',
    0x1f: 'AllowUnsignedInstallationPackages', 0x20: 'MinDevicePasswordComplexCharacters',
    0x21: 'AllowWiFi', 0x22: 'AllowTextMessaging', 0x23: 'AllowPOPIMAPEmail',
    0x24: 'AllowBluetooth', 0x25: 'AllowIrDA', 0x26: 'RequireManualSyncWhenRoaming',
    0x27: 'AllowDesktopSync', 0x28: 'MaxCalendarAgeFilter', 0x29: 'AllowHTMLEmail',
    0x2a: 'MaxEmailAgeFilter', 0x2b: 'MaxEmailBodyTruncationSize',
    0x2c: 'MaxEmailHTMLBodyTruncationSize', 0x2d: 'RequireSignedSMIMEMessages',
    0x2e: 'RequireEncryptedSMIMEMessages', 0x2f: 'RequireSignedSMIMEAlgorithm',
    0x30: 'RequireEncryptionSMIMEAlgorithm', 0x31: 'AllowSMIMEEncryptionAlgorithmNegotiation',
    0x32: 'AllowSMIMESoftCerts', 0x33: 'AllowBrowser', 0x34: 'AllowConsumerEmail',
    0x35: 'AllowRemoteDesktop', 0x36: 'AllowInternetSharing',
    0x37: 'UnapprovedInROMApplicationList', 0x38: 'ApplicationName',
    0x39: 'ApprovedApplicationList', 0x3a: 'Hash',
  },
  // Code page 15: Search
  15: {
    0x05: 'Search', 0x07: 'Store', 0x08: 'Name', 0x09: 'Query',
    0x0a: 'Options', 0x0b: 'Range', 0x0c: 'Status', 0x0d: 'Response',
    0x0e: 'Result', 0x0f: 'Properties', 0x10: 'Total', 0x11: 'EqualTo',
    0x12: 'Value', 0x13: 'And', 0x14: 'Or', 0x15: 'FreeText',
    0x17: 'DeepTraversal', 0x18: 'LongId', 0x19: 'RebuildResults',
    0x1a: 'LessThan', 0x1b: 'GreaterThan', 0x1e: 'UserName', 0x1f: 'Password',
    0x20: 'ConversationId', 0x21: 'Picture', 0x22: 'MaxSize', 0x23: 'MaxPictures',
  },
  // Code page 16: GAL
  16: {
    0x05: 'DisplayName', 0x06: 'Phone', 0x07: 'Office', 0x08: 'Title',
    0x09: 'Company', 0x0a: 'Alias', 0x0b: 'FirstName', 0x0c: 'LastName',
    0x0d: 'HomePhone', 0x0e: 'MobilePhone', 0x0f: 'EmailAddress',
    0x10: 'Picture', 0x11: 'Status', 0x12: 'Data',
  },
  // Code page 17: AirSyncBase
  17: {
    0x05: 'BodyPreference', 0x06: 'Type', 0x07: 'TruncationSize', 0x08: 'AllOrNone',
    0x0a: 'Body', 0x0b: 'Data', 0x0c: 'EstimatedDataSize', 0x0d: 'Truncated',
    0x0e: 'Attachments', 0x0f: 'Attachment', 0x10: 'DisplayName',
    0x11: 'FileReference', 0x12: 'Method', 0x13: 'ContentId',
    0x14: 'ContentLocation', 0x15: 'IsInline', 0x16: 'NativeBodyType',
    0x17: 'ContentType', 0x18: 'Preview', 0x19: 'BodyPartPreference', 0x1a: 'BodyPart',
    0x1b: 'Status',
  },
  // Code page 18: Settings
  18: {
    0x05: 'Settings', 0x06: 'Status', 0x07: 'Get', 0x08: 'Set', 0x09: 'Oof',
    0x0a: 'OofState', 0x0b: 'StartTime', 0x0c: 'EndTime', 0x0d: 'OofMessage',
    0x0e: 'AppliesToInternal', 0x0f: 'AppliesToExternalKnown',
    0x10: 'AppliesToExternalUnknown', 0x11: 'Enabled', 0x12: 'ReplyMessage',
    0x13: 'BodyType', 0x14: 'DevicePassword', 0x15: 'Password',
    0x16: 'DeviceInformation', 0x17: 'Model', 0x18: 'IMEI', 0x19: 'FriendlyName',
    0x1a: 'OS', 0x1b: 'OSLanguage', 0x1c: 'PhoneNumber', 0x1d: 'UserInformation',
    0x1e: 'EmailAddresses', 0x1f: 'SmtpAddress', 0x20: 'UserAgent',
    0x21: 'EnableOutboundSMS', 0x22: 'MobileOperator', 0x23: 'PrimarySmtpAddress',
    0x24: 'Accounts', 0x25: 'Account', 0x26: 'AccountId', 0x27: 'AccountName',
    0x28: 'UserDisplayName', 0x29: 'SendDisabled', 0x2b: 'RightsManagementInformation',
  },
  // Code page 20: ItemOperations
  20: {
    0x05: 'ItemOperations', 0x06: 'Fetch', 0x07: 'Store', 0x08: 'Options',
    0x09: 'Range', 0x0a: 'Total', 0x0b: 'Properties', 0x0c: 'Data',
    0x0d: 'Status', 0x0e: 'Response', 0x0f: 'Version', 0x10: 'Schema',
    0x11: 'Part', 0x12: 'EmptyFolderContents', 0x13: 'DeleteSubFolders',
    0x14: 'UserName', 0x15: 'Password', 0x16: 'Move', 0x17: 'DstFldId',
    0x18: 'ConversationId', 0x19: 'MoveAlways',
  },
  // Code page 21: ComposeMail
  21: {
    0x05: 'SendMail', 0x06: 'SmartForward', 0x07: 'SmartReply',
    0x08: 'SaveInSentItems', 0x09: 'ReplaceMime',
    0x0b: 'Source', 0x0c: 'FolderId', 0x0d: 'ItemId', 0x0e: 'LongId',
    0x0f: 'InstanceId', 0x10: 'Mime', 0x11: 'ClientId',
    0x12: 'Status', 0x13: 'AccountId',
  },
  // Code page 22: Email2 ([MS-ASWBXML]; EAS 14.0+)
  22: {
    0x05: 'UmCallerID', 0x06: 'UmUserNotes', 0x07: 'UmAttDuration', 0x08: 'UmAttOrder',
    0x09: 'ConversationId', 0x0a: 'ConversationIndex', 0x0b: 'LastVerbExecuted',
    0x0c: 'LastVerbExecutionTime', 0x0d: 'ReceivedAsBcc', 0x0e: 'Sender',
    0x0f: 'CalendarType', 0x10: 'IsLeapMonth', 0x11: 'AccountId',
    0x12: 'FirstDayOfWeek', 0x13: 'MeetingMessageType',
  },
  // Code page 23: Notes ([MS-ASWBXML] 2.1.2.1.24; EAS 14.0+)
  23: {
    0x05: 'Subject', 0x06: 'MessageClass', 0x07: 'LastModifiedDate', 0x08: 'Categories', 0x09: 'Category',
  },
};

/**
 * Code page numbers by [MS-ASWBXML] namespace. Two equivalent ways to pin an
 * element whose name exists on several pages: an explicit `WbxmlElement.page`
 * (`pel(CP.AirSyncBase, 'Body')`) or a qualified name (`el('AirSyncBase:Body')`).
 */
export const CP = {
  AirSync: 0, Contacts: 1, Email: 2, Calendar: 4, Move: 5, GetItemEstimate: 6, FolderHierarchy: 7, MeetingResponse: 8, Tasks: 9,
  ResolveRecipients: 10, Contacts2: 12, Ping: 13, Provision: 14, Search: 15, GAL: 16, AirSyncBase: 17,
  Settings: 18, ItemOperations: 20, ComposeMail: 21, Email2: 22, Notes: 23,
} as const;

// Default map: element name → [codePage, token] (lowest page wins) …
const ELEM_TO_TOKEN: Record<string, [number, number]> = {};
// … and per page: name → token, used to resolve a name on its parent's page.
const PAGE_NAME_TO_TOKEN: Record<number, Record<string, number>> = {};
for (const [cp, tokens] of Object.entries(CODE_PAGES)) {
  const page = parseInt(cp);
  const byName: Record<string, number> = {};
  for (const [tok, name] of Object.entries(tokens)) {
    byName[name] = parseInt(tok);
    if (!ELEM_TO_TOKEN[name]) ELEM_TO_TOKEN[name] = [page, parseInt(tok)];
  }
  PAGE_NAME_TO_TOKEN[page] = byName;
}

/** Namespace prefixes for explicitly qualified element names ("GAL:DisplayName"). */
const NAMESPACE_PAGES: Record<string, number> = CP;

// ─── Tokens per protocol version ([MS-ASWBXML]) ──────────────────────────────
// First version of each token, from the "Protocol versions" column of the [MS-ASWBXML]
// 2.1.2.1.x code page tables. Everything not listed exists in 12.1, the oldest version this
// server speaks (pages 5, 6, 7, 13, 14 have no token newer than 12.1).
/** Code pages introduced after 12.1: ComposeMail (2.1.2.1.22), Email2 (2.1.2.1.23), Notes (2.1.2.1.24). */
const PAGE_SINCE: Record<number, string> = { 21: '14.0', 22: '14.0', 23: '14.0' };
/** Single tokens introduced after 12.1 (overrides PAGE_SINCE). */
const TOKEN_SINCE: Record<number, Record<number, string>> = {
  0: { 0x27: '14.0', 0x28: '14.0', 0x29: '14.0' }, // 2.1.2.1.1: ConversationMode, MaxItems, HeartbeatInterval
  2: { 0x1b: '14.0', 0x1c: '14.0', 0x3f: '14.0' }, // 2.1.2.1.3: Categories, Category, DisallowNewTimeProposal
  // 2.1.2.1.5: DisallowNewTimeProposal … IsLeapMonth (14.0); FirstDayOfWeek, OnlineMeeting* (14.1)
  4: { 0x33: '14.0', 0x34: '14.0', 0x35: '14.0', 0x36: '14.0', 0x37: '14.0', 0x38: '14.0', 0x39: '14.1', 0x3a: '14.1', 0x3b: '14.1' },
  // 2.1.2.1.9: InstanceId (14.1), SendResponse (16.0), ProposedStartTime / ProposedEndTime (16.1)
  8: { 0x0e: '14.1', 0x10: '16.1', 0x11: '16.1', 0x12: '16.0' },
  9: { 0x24: '14.0', 0x25: '14.0', 0x26: '14.1' }, // 2.1.2.1.10: CalendarType, IsLeapMonth, FirstDayOfWeek
  10: { // 2.1.2.1.11: Availability … MergedFreeBusy (14.0), Picture, MaxSize, Data, MaxPictures (14.1)
    0x16: '14.0', 0x17: '14.0', 0x18: '14.0', 0x19: '14.0', 0x1a: '14.1', 0x1b: '14.1', 0x1c: '14.1', 0x1d: '14.1',
  },
  15: { 0x20: '14.0', 0x21: '14.1', 0x22: '14.1', 0x23: '14.1' }, // 2.1.2.1.16: ConversationId, Picture, MaxSize, MaxPictures
  16: { 0x10: '14.1', 0x11: '14.1', 0x12: '14.1' }, // 2.1.2.1.17: Picture, Status, Data
  17: { 0x18: '14.0', 0x19: '14.1', 0x1a: '14.1', 0x1b: '14.1' }, // 2.1.2.1.18: Preview, BodyPartPreference, BodyPart, Status
  18: { // 2.1.2.1.19: EnableOutboundSMS, MobileOperator (14.0; UserAgent 0x20 is 12.1); Accounts form, RightsManagementInformation (14.1)
    0x21: '14.0', 0x22: '14.0',
    0x23: '14.1', 0x24: '14.1', 0x25: '14.1', 0x26: '14.1', 0x27: '14.1', 0x28: '14.1', 0x29: '14.1', 0x2b: '14.1',
  },
  20: { 0x16: '14.0', 0x17: '14.0', 0x18: '14.0', 0x19: '14.0' }, // 2.1.2.1.21: Move, DstFldId, ConversationId, MoveAlways
  21: { 0x13: '14.1' }, // 2.1.2.1.22: AccountId
  22: { 0x11: '14.1', 0x12: '14.1', 0x13: '14.1' }, // 2.1.2.1.23: AccountId, FirstDayOfWeek, MeetingMessageType
};

/** A tag of a WBXML document that the protocol version in question does not define. */
export interface VersionedTag { page: number; token: number; name: string; since: string }

/** Tags in the encoded document `buf` that protocol `version` does not know (empty = all valid). */
export function tagsNewerThan(buf: Buffer, version: string): VersionedTag[] {
  const max = Number(version);
  const out: VersionedTag[] = [];
  const walk = (e: WbxmlElement) => {
    const page = e.page ?? 0;
    const token = PAGE_NAME_TO_TOKEN[page]?.[e.name];
    const since = token === undefined ? undefined : TOKEN_SINCE[page]?.[token] ?? PAGE_SINCE[page];
    if (token !== undefined && since !== undefined && Number(since) > max) out.push({ page, token, name: e.name, since });
    for (const c of e.children ?? []) if (typeof c !== 'string') walk(c);
  };
  walk(decodeWbxml(buf));
  return out;
}

/** Splits `Namespace:Name` → [page, Name]; [undefined, name] for an unqualified name. */
function splitQualified(name: string): [number | undefined, string, boolean] {
  const colon = name.indexOf(':');
  if (colon <= 0) return [undefined, name, false];
  return [NAMESPACE_PAGES[name.slice(0, colon)], name.slice(colon + 1), true];
}

/**
 * [page, token] for `name`: the parent's page when it defines the name, else the
 * default page. A qualified name `Namespace:Name` forces the page — needed where a
 * child lives on another page than its parent and the name is ambiguous (e.g.
 * GAL:DisplayName inside Search:Properties).
 */
export function resolveToken(name: string, parentPage: number | null): [number, number] | undefined {
  const [qPage, local, qualified] = splitQualified(name);
  if (qualified) {
    const t = qPage === undefined ? undefined : PAGE_NAME_TO_TOKEN[qPage]?.[local];
    return qPage === undefined || t === undefined ? undefined : [qPage, t];
  }
  if (parentPage !== null) {
    const t = PAGE_NAME_TO_TOKEN[parentPage]?.[name];
    if (t !== undefined) return [parentPage, t];
  }
  return ELEM_TO_TOKEN[name];
}

// ─── WBXML Constants ──────────────────────────────────────────────────────────
const SWITCH_PAGE = 0x00;
const END = 0x01;
const OPAQUE = 0xC3;
const STR_I = 0x03; // Inline string

// ─── AST Types ───────────────────────────────────────────────────────────────
export interface WbxmlElement {
  name: string;
  attributes?: Record<string, string>;
  children?: (WbxmlElement | string)[];
  text?: string;
  /**
   * Encoder: code page to emit this element on (overrides the parent-page /
   * lowest-page resolution — needed where a name exists on several pages, e.g.
   * AirSyncBase:Body vs. Email:Body). Decoder: set NON-enumerable (tree
   * comparisons stay unchanged).
   */
  page?: number;
  /**
   * Encoder: content as raw octets (written as an inline string byte-exact, or as
   * OPAQUE when `opaque` is set or the bytes contain NUL). Decoder: the raw content
   * octets of a string/opaque element, set NON-enumerable.
   */
  bytes?: Buffer;
  /** Encoder: write `bytes` as WBXML OPAQUE (binary types such as Email2:ConversationId). */
  opaque?: boolean;
}

function hide(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, enumerable: false, writable: true, configurable: true });
}

// ─── Decoder ─────────────────────────────────────────────────────────────────

/**
 * 9.4 review: limits of one decoded body. EAS documents nest about ten levels;
 * a hostile body must not drive the recursive decoder into deep recursion or
 * build millions of nodes — the request is answered 400 (server.ts).
 */
export const MAX_WBXML_DEPTH = 64;
export const MAX_WBXML_NODES = 100_000;

/** A WBXML body exceeds MAX_WBXML_DEPTH or MAX_WBXML_NODES. */
export class WbxmlLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'WbxmlLimitError'; }
}

export function decodeWbxml(buf: Buffer): WbxmlElement {
  let pos = 0;
  let currentPage = 0;
  let nodes = 0;

  function countNode(): void {
    if (++nodes > MAX_WBXML_NODES) throw new WbxmlLimitError(`WBXML body exceeds ${MAX_WBXML_NODES} nodes`);
  }

  function readByte(): number {
    if (pos >= buf.length) throw new Error('Unexpected end of WBXML');
    return buf[pos++]!;
  }

  function readMBUInt32(): number {
    let result = 0;
    let byte: number;
    let count = 0;
    do {
      byte = readByte();
      if (++count > 5) throw new Error('Invalid WBXML multi-byte integer');
      result = result * 128 + (byte & 0x7f);
    } while (byte & 0x80);
    return result;
  }

  function readStrI(): Buffer {
    const start = pos;
    while (pos < buf.length && buf[pos] !== 0x00) pos++;
    if (pos >= buf.length) throw new Error('Unterminated WBXML inline string');
    const s = buf.subarray(start, pos);
    pos++; // skip null terminator
    return s;
  }
  /** String / opaque content: utf8 text + raw octets. */
  // No TS parameter property: the e2e runner imports this file with Node's
  // strip-only TypeScript support (erasable syntax only).
  class Content { readonly raw: Buffer; constructor(raw: Buffer) { this.raw = raw; } }

  function readOpaque(): Buffer {
    const length = readMBUInt32();
    if (length > buf.length - pos) throw new Error('WBXML OPAQUE data exceeds the buffer');
    const data = buf.slice(pos, pos + length);
    pos += length;
    return data;
  }

  // Skip WBXML header
  readByte(); // version
  readMBUInt32(); // publicId
  readMBUInt32(); // charset (UTF-8 = 0x6A)
  const strTableLen = readMBUInt32();
  pos += strTableLen; // skip string table

  /** `depth`: nesting level of the element read next (root = 1). */
  function parseElement(depth: number): WbxmlElement | Content | null {
    if (pos >= buf.length) return null;
    let byte = readByte();
    // a run of SWITCH_PAGE tokens is read in a loop (no recursion per token)
    while (byte === SWITCH_PAGE) {
      currentPage = readByte();
      if (pos >= buf.length) return null;
      byte = readByte();
    }

    if (byte === END) return null;

    countNode();
    if (byte === STR_I) {
      return new Content(readStrI());
    }

    if (byte === OPAQUE) {
      return new Content(readOpaque());
    }
    if (depth > MAX_WBXML_DEPTH) throw new WbxmlLimitError(`WBXML body nests deeper than ${MAX_WBXML_DEPTH} levels`);

    const hasContent = !!(byte & 0x40);
    const hasAttributes = !!(byte & 0x80);
    const token = byte & 0x3f;
    // Tokens 0x00–0x04 of each 0x40 block are WBXML global tokens (ENTITY, LITERAL, EXT_*,
    // PI, STR_T, …) that EAS does not use — never parse them as elements.
    if (token < 0x05) throw new Error(`Unsupported WBXML global token 0x${byte.toString(16)}`);

    const pageName = CODE_PAGES[currentPage]?.[token];
    const name = pageName ?? `unknown_${currentPage}_${token}`;

    // Skip attributes (not used in EAS)
    if (hasAttributes) {
      let attrByte: number;
      do { attrByte = readByte(); } while (attrByte !== END);
    }

    const elem: WbxmlElement = { name, children: [] };
    hide(elem, 'page', currentPage);

    if (hasContent) {
      let child: WbxmlElement | Content | null;
      const parts: Buffer[] = [];
      while ((child = parseElement(depth + 1)) !== null) {
        if (child instanceof Content) {
          parts.push(child.raw);
        } else {
          elem.children!.push(child);
        }
      }
      if (parts.length > 0) {
        const raw = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
        elem.text = raw.toString('utf8');
        hide(elem, 'bytes', raw);
      }
    }

    return elem;
  }

  const root = parseElement(1);
  if (!root || root instanceof Content) throw new Error('Invalid WBXML: no root element');
  return root;
}

// ─── Encoder ─────────────────────────────────────────────────────────────────
export function encodeWbxml(root: WbxmlElement): Buffer {
  const chunks: Buffer[] = [];
  let currentPage = -1;

  function writeByte(b: number) {
    chunks.push(Buffer.from([b]));
  }

  function writeMBUInt32(n: number) {
    const bytes: number[] = [];
    bytes.unshift(n & 0x7f);
    n >>= 7;
    while (n > 0) {
      bytes.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    chunks.push(Buffer.from(bytes));
  }

  function writeStrI(s: string) {
    writeByte(STR_I);
    chunks.push(Buffer.from(s, 'utf8'));
    writeByte(0x00);
  }

  function writeBytes(data: Buffer, opaque: boolean) {
    if (opaque || data.includes(0x00)) {
      writeByte(OPAQUE);
      writeMBUInt32(data.length);
      chunks.push(data);
    } else {
      writeByte(STR_I);
      chunks.push(data);
      writeByte(0x00);
    }
  }

  function writeElement(elem: WbxmlElement, parentPage: number | null) {
    let tokenInfo: [number, number] | undefined;
    if (elem.page !== undefined) {
      // Explicit page wins; a qualified name must agree with it.
      const [qPage, local, qualified] = splitQualified(elem.name);
      const t = qualified && qPage !== elem.page ? undefined : PAGE_NAME_TO_TOKEN[elem.page]?.[local];
      tokenInfo = t === undefined ? undefined : [elem.page, t];
    } else {
      tokenInfo = resolveToken(elem.name, parentPage);
    }
    if (!tokenInfo) throw new Error(`Unknown EAS element: ${elem.name}${elem.page !== undefined ? ` on page ${elem.page}` : ''}`);
    const [page, token] = tokenInfo;

    if (page !== currentPage) {
      writeByte(SWITCH_PAGE);
      writeByte(page);
      currentPage = page;
    }

    const hasBytes = !!elem.bytes && elem.bytes.length > 0;
    const hasChildren = !!(elem.children?.length || elem.text || hasBytes);
    const tokenByte = token | (hasChildren ? 0x40 : 0x00);
    writeByte(tokenByte);

    if (hasChildren) {
      if (hasBytes) {
        writeBytes(elem.bytes!, !!elem.opaque);
      } else if (elem.text) {
        writeStrI(elem.text);
      }
      for (const child of elem.children ?? []) {
        if (typeof child === 'string') {
          writeStrI(child);
        } else {
          writeElement(child, page);
        }
      }
      writeByte(END);
    }
  }

  // WBXML header
  writeByte(0x03); // WBXML version 1.3
  writeMBUInt32(0x01); // publicId: unknown (use string table)
  writeMBUInt32(0x6A); // charset UTF-8
  writeMBUInt32(0x00); // empty string table

  writeElement(root, null);
  return Buffer.concat(chunks);
}

// ─── Helper ───────────────────────────────────────────────────────────────────
export function getChild(elem: WbxmlElement, name: string): WbxmlElement | undefined {
  return elem.children?.find((c): c is WbxmlElement => typeof c !== 'string' && c.name === name);
}

export function getText(elem: WbxmlElement, name: string): string {
  return getChild(elem, name)?.text ?? '';
}

export function el(name: string, text?: string, children?: (WbxmlElement | string)[]): WbxmlElement {
  const result: WbxmlElement = { name };
  if (text !== undefined) result.text = text;
  if (children !== undefined) result.children = children;
  return result;
}

/** Element pinned to a code page; `content` as text, raw octets or child elements. */
export function pel(page: number, name: string, content?: string | Buffer | WbxmlElement[], opts: { opaque?: boolean } = {}): WbxmlElement {
  const result: WbxmlElement = { name, page };
  if (typeof content === 'string') result.text = content;
  else if (Buffer.isBuffer(content)) { result.bytes = content; if (opts.opaque) result.opaque = true; }
  else if (content !== undefined) result.children = content;
  return result;
}
