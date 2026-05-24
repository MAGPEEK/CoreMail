/**
 * WBXML codec for Microsoft Exchange ActiveSync (EAS 14.1)
 * Implements the subset of WBXML used by ActiveSync.
 */

// ─── EAS Code Pages ──────────────────────────────────────────────────────────
// Each code page maps token byte → element name
const CODE_PAGES: Record<number, Record<number, string>> = {
  // Code page 0: AirSync
  0: {
    0x05: 'Sync', 0x06: 'Responses', 0x07: 'Add', 0x08: 'Change',
    0x09: 'Delete', 0x0a: 'Fetch', 0x0b: 'SyncKey', 0x0c: 'ClientId',
    0x0d: 'Collection', 0x0e: 'Class', 0x0f: 'Status', 0x10: 'CollectionId',
    0x11: 'GetChanges', 0x12: 'MoreAvailable', 0x13: 'WindowSize',
    0x14: 'Commands', 0x15: 'Options', 0x16: 'FilterType',
    0x17: 'Truncation', 0x18: 'RtfTruncation', 0x19: 'Conflict',
    0x1a: 'Collections', 0x1b: 'ApplicationData', 0x1c: 'DeletesAsMoves',
    0x1d: 'NotifyGUID', 0x1e: 'Supported', 0x1f: 'SoftDelete',
    0x20: 'MIMESupport', 0x21: 'MIMETruncation', 0x22: 'Wait',
    0x23: 'Limit', 0x24: 'Partial',
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
    0x39: 'InternetCPID', 0x3a: 'Flag', 0x3b: 'Status',
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
    0x0c: 'UserResponse', 0x0d: 'Version',
  },
  // Code page 14: Provision
  14: {
    0x05: 'Provision', 0x06: 'Policies', 0x07: 'Policy', 0x08: 'PolicyType',
    0x09: 'PolicyKey', 0x0a: 'Data', 0x0b: 'Status', 0x0c: 'RemoteWipe',
    0x0d: 'EASProvisionDoc', 0x0e: 'DevicePasswordEnabled',
    0x0f: 'AlphanumericDevicePasswordRequired', 0x10: 'RequireStorageCardEncryption',
    0x11: 'PasswordRecoveryEnabled', 0x12: 'DocumentBrowseEnabled',
    0x13: 'AttachmentsEnabled', 0x14: 'MaxAttachmentSize',
    0x15: 'AllowSimpleDevicePassword', 0x16: 'DevicePasswordExpiration',
    0x17: 'DevicePasswordHistory', 0x18: 'AllowStorageCard',
    0x19: 'AllowCamera', 0x1a: 'RequireDeviceEncryption',
    0x1b: 'AllowUnsignedApplications', 0x1c: 'AllowUnsignedInstallationPackages',
    0x1d: 'MinDevicePasswordComplexCharacters', 0x1e: 'AllowWiFi',
    0x1f: 'AllowTextMessaging', 0x20: 'AllowPOPIMAPEmail',
    0x21: 'AllowBluetooth', 0x22: 'AllowIrDA',
    0x23: 'RequireManualSyncWhenRoaming', 0x24: 'AllowDesktopSync',
    0x25: 'MaxCalendarAgeFilter', 0x26: 'AllowHTMLEmail',
    0x27: 'MaxEmailAgeFilter', 0x28: 'MaxEmailBodyTruncationSize',
    0x29: 'MaxEmailHTMLBodyTruncationSize', 0x2a: 'RequireSignedSMIMEMessages',
    0x2b: 'RequireEncryptedSMIMEMessages', 0x2c: 'RequireSignedSMIMEAlgorithm',
    0x2d: 'RequireEncryptionSMIMEAlgorithm', 0x2e: 'AllowSMIMEEncryptionAlgorithmNegotiation',
    0x2f: 'AllowSMIMESoftCerts', 0x30: 'AllowBrowser', 0x31: 'AllowConsumerEmail',
    0x32: 'AllowRemoteDesktop', 0x33: 'AllowInternetSharing',
    0x34: 'UnapprovedInROMApplicationList', 0x35: 'ApplicationName',
    0x36: 'ApprovedApplicationList', 0x37: 'Hash',
  },
  // Code page 17: Ping
  17: {
    0x05: 'Ping', 0x06: 'AutdState', 0x07: 'Status', 0x08: 'HeartbeatInterval',
    0x09: 'Folders', 0x0a: 'Folder', 0x0b: 'Id', 0x0c: 'Class',
    0x0d: 'MaxFolders',
  },
  // Code page 18: ItemOperations
  18: {
    0x05: 'ItemOperations', 0x06: 'Fetch', 0x07: 'Store', 0x08: 'Options',
    0x09: 'Range', 0x0a: 'Total', 0x0b: 'Properties', 0x0c: 'Data',
    0x0d: 'Status', 0x0e: 'Response', 0x0f: 'Version', 0x10: 'Schema',
    0x11: 'Part', 0x12: 'EmptyFolderContents', 0x13: 'DeleteSubFolders',
  },
  // Code page 25: ComposeMail
  25: {
    0x05: 'SendMail', 0x06: 'SmartForward', 0x07: 'SmartReply',
    0x08: 'SaveInSentItems', 0x09: 'ReplaceMime', 0x0a: 'Type',
    0x0b: 'Source', 0x0c: 'FolderId', 0x0d: 'ItemId', 0x0e: 'LongId',
    0x0f: 'InstanceId', 0x10: 'Mime', 0x11: 'ClientId',
    0x12: 'Status', 0x13: 'AccountId',
  },
};

// Reverse map: element name → [codePage, token]
const ELEM_TO_TOKEN: Record<string, [number, number]> = {};
for (const [cp, tokens] of Object.entries(CODE_PAGES)) {
  for (const [tok, name] of Object.entries(tokens)) {
    if (!ELEM_TO_TOKEN[name]) {
      ELEM_TO_TOKEN[name] = [parseInt(cp), parseInt(tok)];
    }
  }
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

  function writeElement(elem: WbxmlElement) {
    const tokenInfo = ELEM_TO_TOKEN[elem.name];
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
          writeElement(child);
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

  writeElement(root);
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
