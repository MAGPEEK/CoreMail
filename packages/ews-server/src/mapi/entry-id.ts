/**
 * MAPI EntryID-Helpers (v4.1.0)
 *
 * EntryIDs sind opake Binary-Identifier für MAPI-Objekte (Folder, Message,
 * Mailbox). Format gemäß MS-OXCDATA §2.2:
 *
 *   +-------------------+
 *   | Flags (4B)        | ← 0 für normale, sonst spezielle Flags
 *   +-------------------+
 *   | ProviderUID (16B) | ← GUID des MAPI-Providers
 *   +-------------------+
 *   | Type-spezifische Daten...                |
 *   +-------------------+
 *
 * Wir verwenden für CoreMail einen eigenen ProviderUID und kodieren CUID
 * (25 chars) als ProviderData. Der Server kann jederzeit aus einer EntryID
 * den zugehörigen CUID extrahieren.
 */

/** Custom ProviderUID für CoreMail (16-Byte GUID, fix). */
export const COREMAIL_PROVIDER_UID = Buffer.from(
  '434f52454d41494c4d41504900000001', // "COREMAILMAPI\0\0\0\x01"
  'hex',
);

/** Folder-EntryID-Layout: Flags + ProviderUID + 'F' + CUID. */
export function encodeFolderEntryId(folderId: string): Buffer {
  return encodeEntryId('F', folderId);
}

/** Message-EntryID-Layout: Flags + ProviderUID + 'M' + CUID. */
export function encodeMessageEntryId(messageId: string): Buffer {
  return encodeEntryId('M', messageId);
}

/** Mailbox-Owner-EntryID. */
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
  // letztes Byte bleibt 0 (null-terminator für ID)
  return buf;
}

/**
 * Dekodiert eine EntryID zu { typeMarker, id }. Liefert null wenn ungültig
 * oder fremder Provider.
 */
export function decodeEntryId(buf: Buffer): { typeMarker: string; id: string } | null {
  if (buf.length < 22) return null;
  // Provider-Match
  const providerSlice = buf.subarray(4, 20);
  if (!providerSlice.equals(COREMAIL_PROVIDER_UID)) return null;
  const typeMarker = String.fromCharCode(buf.readUInt8(20));
  // ID lesen bis null-terminator
  let end = 21;
  while (end < buf.length && buf[end] !== 0) end++;
  const id = buf.subarray(21, end).toString('ascii');
  return { typeMarker, id };
}

/**
 * 64-Bit Folder-ID für PR_FOLDER_ID. Outlook erwartet einen uint64. Wir
 * generieren einen deterministischen 8-Byte-Hash aus der CUID (25 chars).
 *
 * Algorithmus: FNV-1a 64-bit Hash.
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
