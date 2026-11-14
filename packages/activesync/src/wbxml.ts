/**
 * WBXML codec for Microsoft Exchange ActiveSync (EAS 14.1)
 * Implements the subset of WBXML used by ActiveSync.
 */

// ─── EAS Code Pages ──────────────────────────────────────────────────────────
// Each code page maps token byte → element name. Page numbers and tokens follow
// [MS-ASWBXML] (EAS 14.1). The same element name exists on several pages
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
  // Code page 7: FolderHierarchy
  7: {
    0x05: 'Folders', 0x06: 'Folder', 0x07: 'DisplayName', 0x08: 'ServerId',
    0x09: 'ParentId', 0x0a: 'Type', 0x0b: 'Response', 0x0c: 'Status',
    0x0d: 'ContentClass', 0x0e: 'Changes', 0x0f: 'Add', 0x10: 'Delete',
    0x11: 'Update', 0x12: 'SyncKey', 0x13: 'FolderCreate', 0x14: 'FolderDelete',
    0x15: 'FolderUpdate', 0x16: 'FolderSync', 0x17: 'Count',
  },
  // Code page 8: MeetingResponse
  8: {
    0x05: 'CalendarId', 0x06: 'CollectionId', 0x07: 'MeetingResponse',
    0x08: 'RequestId', 0x09: 'Request', 0x0a: 'Result', 0x0b: 'Status',
    0x0c: 'UserResponse', 0x0e: 'InstanceId',
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
  // Code page 17: AirSyncBase
  17: {
    0x05: 'BodyPreference', 0x06: 'Type', 0x07: 'TruncationSize', 0x08: 'AllOrNone',
    0x0a: 'Body', 0x0b: 'Data', 0x0c: 'EstimatedDataSize', 0x0d: 'Truncated',
    0x0e: 'Attachments', 0x0f: 'Attachment', 0x10: 'DisplayName',
    0x11: 'FileReference', 0x12: 'Method', 0x13: 'ContentId',
    0x14: 'ContentLocation', 0x15: 'IsInline', 0x16: 'NativeBodyType',
    0x17: 'ContentType', 0x18: 'Preview',
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
};

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

/** [page, token] for `name`: the parent's page when it defines the name, else the default page. */
export function resolveToken(name: string, parentPage: number | null): [number, number] | undefined {
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
}

// ─── Decoder ─────────────────────────────────────────────────────────────────
export function decodeWbxml(buf: Buffer): WbxmlElement {
  let pos = 0;
  let currentPage = 0;

  function readByte(): number {
    if (pos >= buf.length) throw new Error('Unexpected end of WBXML');
    return buf[pos++]!;
  }

  function readMBUInt32(): number {
    let result = 0;
    let byte: number;
    do {
      byte = readByte();
      result = (result << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    return result;
  }

  function readStrI(): string {
    const start = pos;
    while (pos < buf.length && buf[pos] !== 0x00) pos++;
    const s = buf.slice(start, pos).toString('utf8');
    pos++; // skip null terminator
    return s;
  }

  function readOpaque(): Buffer {
    const length = readMBUInt32();
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

  function parseElement(): WbxmlElement | string | null {
    if (pos >= buf.length) return null;
    const byte = readByte();

    if (byte === END) return null;

    if (byte === SWITCH_PAGE) {
      currentPage = readByte();
      return parseElement();
    }

    if (byte === STR_I) {
      return readStrI();
    }

    if (byte === OPAQUE) {
      return readOpaque().toString('utf8');
    }

    const hasContent = !!(byte & 0x40);
    const hasAttributes = !!(byte & 0x80);
    const token = byte & 0x3f;

    const pageName = CODE_PAGES[currentPage]?.[token];
    const name = pageName ?? `unknown_${currentPage}_${token}`;

    // Skip attributes (not used in EAS)
    if (hasAttributes) {
      let attrByte: number;
      do { attrByte = readByte(); } while (attrByte !== END);
    }

    const elem: WbxmlElement = { name, children: [] };

    if (hasContent) {
      let child: WbxmlElement | string | null;
      while ((child = parseElement()) !== null) {
        if (typeof child === 'string') {
          elem.text = child;
        } else {
          elem.children!.push(child);
        }
      }
    }

    return elem;
  }

  const root = parseElement();
  if (!root || typeof root === 'string') throw new Error('Invalid WBXML: no root element');
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

  function writeElement(elem: WbxmlElement, parentPage: number | null) {
    const tokenInfo = resolveToken(elem.name, parentPage);
    if (!tokenInfo) throw new Error(`Unknown EAS element: ${elem.name}`);
    const [page, token] = tokenInfo;

    if (page !== currentPage) {
      writeByte(SWITCH_PAGE);
      writeByte(page);
      currentPage = page;
    }

    const hasChildren = !!(elem.children?.length || elem.text);
    const tokenByte = token | (hasChildren ? 0x40 : 0x00);
    writeByte(tokenByte);

    if (hasChildren) {
      if (elem.text) {
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
