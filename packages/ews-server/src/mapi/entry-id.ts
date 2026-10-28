/**
 * MAPI EntryID helpers (v4.1.0)
 *
 * EntryIDs are opaque binary identifiers for MAPI objects (folder, message,
 * mailbox). Format per MS-OXCDATA §2.2:
 *
 *   +-------------------+
 *   | Flags (4B)        | ← 0 for normal, otherwise special flags
 *   +-------------------+
 *   | ProviderUID (16B) | ← GUID of the MAPI provider
 *   +-------------------+
 *   | Type-specific data...                    |
 *   +-------------------+
 *
 * For CoreMail we use our own ProviderUID and encode the CUID
 * (25 chars) as ProviderData. The server can extract the associated CUID
 * from an EntryID at any time.
 */

/** Custom ProviderUID for CoreMail (16-byte GUID, fixed). */
export const COREMAIL_PROVIDER_UID = Buffer.from(
  '434f52454d41494c4d41504900000001', // "COREMAILMAPI\0\0\0\x01"
  'hex',
);

/** Folder EntryID layout: Flags + ProviderUID + 'F' + CUID. */
export function encodeFolderEntryId(folderId: string): Buffer {
  return encodeEntryId('F', folderId);
}

/** Message EntryID layout: Flags + ProviderUID + 'M' + CUID. */
export function encodeMessageEntryId(messageId: string): Buffer {
  return encodeEntryId('M', messageId);
}

/** Mailbox owner EntryID. */
export function encodeUserEntryId(userId: string): Buffer {
  return encodeEntryId('U', userId);
}

function encodeEntryId(typeMarker: string, id: string): Buffer {
  // 4B Flags (0x00000000) + 16B ProviderUID + 1B Type + N Bytes ID (ASCII) + null-terminator
  const idBytes = Buffer.from(id, 'ascii');
  const buf = Buffer.alloc(4 + 16 + 1 + idBytes.length + 1);
  buf.writeUInt32LE(0, 0);
  COREMAIL_PROVIDER_UID.copy(buf, 4);
  buf.writeUInt8(typeMarker.charCodeAt(0), 20);
  idBytes.copy(buf, 21);
  // last byte stays 0 (null terminator for ID)
  return buf;
}

/**
 * Decodes an EntryID to { typeMarker, id }. Returns null if invalid
 * or from a foreign provider.
 */
export function decodeEntryId(buf: Buffer): { typeMarker: string; id: string } | null {
  if (buf.length < 22) return null;
  // Provider match
  const providerSlice = buf.subarray(4, 20);
  if (!providerSlice.equals(COREMAIL_PROVIDER_UID)) return null;
  const typeMarker = String.fromCharCode(buf.readUInt8(20));
  // Read ID up to the null terminator
  let end = 21;
  while (end < buf.length && buf[end] !== 0) end++;
  const id = buf.subarray(21, end).toString('ascii');
  return { typeMarker, id };
}

/**
 * 64-bit folder ID for PR_FOLDER_ID. Outlook expects a uint64. We
 * generate a deterministic 8-byte hash from the CUID (25 chars).
 *
 * Algorithm: FNV-1a 64-bit hash.
 */
export function cuidToFolderId64(cuid: string): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xFFFFFFFFFFFFFFFFn;
  for (let i = 0; i < cuid.length; i++) {
    h = (h ^ BigInt(cuid.charCodeAt(i))) & mask;
    h = (h * prime) & mask;
  }
  return h;
}
