/**
 * RTF Compression (v5.2.0)
 *
 * MS-OXRTFCP — RTF Compression Algorithm. PR_RTF_COMPRESSED (0x10090102)
 * Properties enthalten ein LZ77-komprimiertes RTF-Dokument mit Header:
 *
 *   uint32 CompressedSize
 *   uint32 UncompressedSize
 *   uint32 Magic       — 'LZFu' (0x75465A4C) = compressed, 'MELA' (0x414C454D) = uncompressed
 *   uint32 CRC
 *   <data>
 *
 * Wir liefern eine pragmatische Implementation: Outlook akzeptiert das
 * uncompressed-Magic ('MELA') auch wenn der CRC null ist. Damit können
 * wir HTML/Plain-Text-Bodies trivial in PR_RTF_COMPRESSED-Form ausliefern
 * ohne echten LZ77-Encoder schreiben zu müssen.
 *
 * Decoder ist auch implementiert für künftige Outlook→Server-RTF-Pfade
 * (Outlook sendet PR_RTF_COMPRESSED beim Compose mit RTF-Body).
 */

const MAGIC_COMPRESSED   = 0x75465A4C;  // 'LZFu' little-endian
const MAGIC_UNCOMPRESSED = 0x414C454D;  // 'MELA' little-endian

const PREFIX = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\n\r\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

/**
 * Wickelt einen Plain-RTF-String oder HTML-String in das PR_RTF_COMPRESSED-
 * Format mit MELA-Magic (uncompressed).
 */
export function encodeRtfUncompressed(rtfOrText: string): Buffer {
  const body = Buffer.from(rtfOrText, 'utf-8');
  const compressedSize = body.length + 12;  // 12 = sizeof(remaining header fields after CompressedSize)
  const uncompressedSize = body.length;
  const header = Buffer.alloc(16);
  header.writeUint32LE(compressedSize, 0);
  header.writeUint32LE(uncompressedSize, 4);
  header.writeUint32LE(MAGIC_UNCOMPRESSED, 8);
  header.writeUint32LE(0, 12);              // CRC unused for MELA
  return Buffer.concat([header, body]);
}

/**
 * Konvertiert einen Plain-Text oder HTML-String in echtes RTF, dann wrapt
 * mit PR_RTF_COMPRESSED-Header. Für simple Outlook-Read-Compatibility.
 */
export function htmlOrTextToRtfCompressed(html: string, plainText: string): Buffer {
  // Outlook akzeptiert „escaped HTML in RTF" via \htmlrtf-Tag (MS-OXRTFEX §3.1).
  const safeText = (plainText || stripHtml(html))
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n/g, '\\par ')
    .replace(/\n/g, '\\par ');
  const rtf = `{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat{\\fonttbl{\\f0\\fnil Calibri;}}\\fs22 ${safeText}}`;
  return encodeRtfUncompressed(rtf);
}

/**
 * Strip HTML tags zu Plain-Text Fallback.
 */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

/**
 * Decoder: PR_RTF_COMPRESSED Buffer → RTF-String (best-effort).
 * Unterstützt nur das MELA-uncompressed-Format direkt. Für LZFu kommt
 * ein vollständiger LZ77-Decoder in v5.3+ (Outlook sendet typischerweise
 * MELA für kurze Bodies).
 */
export function decodeRtfCompressed(buf: Buffer): string | null {
  if (buf.length < 16) return null;
  const magic = buf.readUint32LE(8);
  const body = buf.subarray(16);
  if (magic === MAGIC_UNCOMPRESSED) {
    return body.toString('utf-8');
  }
  if (magic === MAGIC_COMPRESSED) {
    return decodeLZ77(buf);
  }
  return null;
}

/**
 * MS-OXRTFCP §3.1.4 LZ77 Decoder.
 * - Init Dictionary mit RTF_PREFIX (207 bytes)
 * - Read Flag-Byte: 8 Bits, jedes Bit gibt an ob das nächste Byte literal (1)
 *   oder Reference (0) ist.
 * - Reference: 2 Bytes BE. high 12 bits = offset in dictionary (0..4095),
 *   low 4 bits = length - 2 (so length range 2..17).
 * - Special: offset == current cursor → end-of-stream marker.
 */
function decodeLZ77(buf: Buffer): string | null {
  if (buf.length < 16) return null;
  const uncompressedSize = buf.readUint32LE(4);
  const data = buf.subarray(16);

  // Dictionary mit dem festen RTF-Prefix initialisieren (4096-Byte-Ring).
  const dict = Buffer.alloc(4096);
  Buffer.from(PREFIX, 'binary').copy(dict, 0);
  let cursor = PREFIX.length;

  const out: number[] = [];
  let pos = 0;

  try {
    while (pos < data.length && out.length < uncompressedSize) {
      const flagByte = data[pos++];
      if (flagByte === undefined) break;
      for (let bit = 0; bit < 8 && pos < data.length && out.length < uncompressedSize; bit++) {
        if ((flagByte >> bit) & 1) {
          // Literal byte
          const b = data[pos++];
          if (b === undefined) break;
          out.push(b);
          dict[cursor] = b;
          cursor = (cursor + 1) % 4096;
        } else {
          // Reference (2 bytes big-endian)
          if (pos + 1 >= data.length) break;
          const hi = data[pos++]!;
          const lo = data[pos++]!;
          const offset = (hi << 4) | (lo >> 4);
          const length = (lo & 0x0F) + 2;
          if (offset === cursor) {
            // End-of-stream marker
            return Buffer.from(out).toString('utf-8');
          }
          for (let i = 0; i < length && out.length < uncompressedSize; i++) {
            const b = dict[(offset + i) % 4096];
            if (b === undefined) break;
            out.push(b);
            dict[cursor] = b;
            cursor = (cursor + 1) % 4096;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return Buffer.from(out).toString('utf-8');
}
