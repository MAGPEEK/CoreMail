/**
 * EAS request line ([MS-ASHTTP] 2.2.1.1.1). Two encodings of the same facts:
 *
 *  - plain query: `?Cmd=Sync&User=…&DeviceId=…&DeviceType=…` (+ command parameters such as
 *    `AttachmentName`, `CollectionId`, `ItemId`, `LongId`, `Occurrence`, `SaveInSent`), the
 *    protocol version and policy key in the `MS-ASProtocolVersion` / `X-MS-PolicyKey` headers;
 *  - base64-encoded query value (one binary blob, sent by some 12.1+ devices): protocol version
 *    byte, command code, locale, DeviceId, policy key, DeviceType and tag/length/value command
 *    parameters — no version / policy key headers.
 *
 * No runtime imports (pure).
 */

/** Command parameters that travel in the request line instead of the body. */
export interface EasCommandParams {
  attachmentName?: string;
  collectionId?: string;
  itemId?: string;
  longId?: string;
  occurrence?: string;
  /** SaveInSent=T (plain) / Options bit 0x01 (base64). */
  saveInSent: boolean;
}

export interface EasRequestLine {
  /** Command name ('' = none given; `#<code>` = unknown base64 command code). */
  command: string;
  deviceId: string;
  deviceType: string;
  /** Requested protocol version ('' = none given). */
  protocolVersion: string;
  policyKey: string | undefined;
  params: EasCommandParams;
}

export type ParsedRequestLine = { ok: true; line: EasRequestLine } | { ok: false; reason: string };

/** [MS-ASHTTP] 2.2.1.1.1.1.2 command codes of the base64 form. */
const COMMAND_CODES: Record<number, string> = {
  0: 'Sync', 1: 'SendMail', 2: 'SmartForward', 3: 'SmartReply', 4: 'GetAttachment',
  9: 'FolderSync', 10: 'FolderCreate', 11: 'FolderDelete', 12: 'FolderUpdate', 13: 'MoveItems',
  14: 'GetItemEstimate', 15: 'MeetingResponse', 16: 'Search', 17: 'Settings', 18: 'Ping',
  19: 'ItemOperations', 20: 'Provision', 21: 'ResolveRecipients', 22: 'ValidateCert',
};

/** [MS-ASHTTP] 2.2.1.1.1.1.3 parameter tags of the base64 form (others are skipped). */
const PARAM_TAG = { AttachmentName: 0, CollectionId: 1, ItemId: 3, LongId: 4, Occurrence: 6, Options: 7 } as const;
const OPTION_SAVE_IN_SENT = 0x01;

const DEFAULT_DEVICE_ID = 'unknown';
const DEFAULT_DEVICE_TYPE = 'Unknown';

/** `rawQuery`: the URL query without `?`; `header`: case-insensitive request header lookup. */
export function parseRequestLine(rawQuery: string, header: (name: string) => string | undefined): ParsedRequestLine {
  const plain = new URLSearchParams(rawQuery);
  if (plain.has('Cmd') || rawQuery === '') return { ok: true, line: plainLine(plain, header) };
  return parseBase64Line(rawQuery);
}

function plainLine(q: URLSearchParams, header: (name: string) => string | undefined): EasRequestLine {
  const opt = (name: string) => q.get(name) || undefined;
  const params: EasCommandParams = { saveInSent: q.get('SaveInSent')?.toUpperCase() === 'T' };
  const attachmentName = opt('AttachmentName');
  const collectionId = opt('CollectionId');
  const itemId = opt('ItemId');
  const longId = opt('LongId');
  const occurrence = opt('Occurrence');
  if (attachmentName) params.attachmentName = attachmentName;
  if (collectionId) params.collectionId = collectionId;
  if (itemId) params.itemId = itemId;
  if (longId) params.longId = longId;
  if (occurrence) params.occurrence = occurrence;
  return {
    command: q.get('Cmd') ?? '',
    deviceId: opt('DeviceId') ?? DEFAULT_DEVICE_ID,
    deviceType: opt('DeviceType') ?? DEFAULT_DEVICE_TYPE,
    protocolVersion: (header('MS-ASProtocolVersion') ?? '').trim(),
    policyKey: header('X-MS-PolicyKey'),
    params,
  };
}

/** DeviceId bytes as text: printable alphanumerics as they are, anything else (a GUID) as hex. */
export function deviceIdText(bytes: Buffer): string {
  return /^[A-Za-z0-9]+$/.test(bytes.toString('latin1')) ? bytes.toString('latin1') : bytes.toString('hex').toUpperCase();
}

/** Reader over the decoded blob; every read is bounds-checked. */
function reader(buf: Buffer) {
  let pos = 0;
  const need = (n: number) => { if (pos + n > buf.length) throw new RangeError('truncated base64 request line'); };
  return {
    done: () => pos >= buf.length,
    byte: () => { need(1); return buf[pos++]!; },
    bytes: (n: number) => { need(n); const out = buf.subarray(pos, pos + n); pos += n; return out; },
  };
}

function parseBase64Line(rawQuery: string): ParsedRequestLine {
  let text: string;
  try { text = decodeURIComponent(rawQuery); } catch { return { ok: false, reason: 'malformed query encoding' }; }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return { ok: false, reason: 'query is neither plain nor base64' };
  const r = reader(Buffer.from(text, 'base64'));
  try {
    const versionByte = r.byte();
    const commandCode = r.byte();
    // [MS-ASHTTP] 2.2.1.1.1.1 does not state the byte order of Locale / Policy key; both are
    // read little-endian. The locale is skipped — responses are not localised.
    r.bytes(2);
    const deviceId = r.bytes(r.byte());
    const policyKeyLength = r.byte();
    if (policyKeyLength !== 0 && policyKeyLength !== 4) return { ok: false, reason: 'policy key length must be 0 or 4' };
    const policyKey = policyKeyLength === 4 ? String(r.bytes(4).readUInt32LE(0)) : undefined;
    const deviceType = r.bytes(r.byte()).toString('latin1');
    const params: EasCommandParams = { saveInSent: false };
    while (!r.done()) {
      const tag = r.byte();
      const value = r.bytes(r.byte());
      applyParam(params, tag, value);
    }
    return {
      ok: true,
      line: {
        command: COMMAND_CODES[commandCode] ?? `#${commandCode}`,
        deviceId: deviceId.length > 0 ? deviceIdText(deviceId) : DEFAULT_DEVICE_ID,
        deviceType: deviceType || DEFAULT_DEVICE_TYPE,
        protocolVersion: `${Math.floor(versionByte / 10)}.${versionByte % 10}`,
        policyKey,
        params,
      },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function applyParam(params: EasCommandParams, tag: number, value: Buffer): void {
  const text = value.toString('utf8');
  switch (tag) {
    case PARAM_TAG.AttachmentName: params.attachmentName = text; break;
    case PARAM_TAG.CollectionId: params.collectionId = text; break;
    case PARAM_TAG.ItemId: params.itemId = text; break;
    case PARAM_TAG.LongId: params.longId = text; break;
    case PARAM_TAG.Occurrence: params.occurrence = text; break;
    case PARAM_TAG.Options: params.saveInSent = ((value[0] ?? 0) & OPTION_SAVE_IN_SENT) !== 0; break;
    default: break; // User, unused tags
  }
}
