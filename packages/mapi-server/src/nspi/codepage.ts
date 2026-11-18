/**
 * Code pages of the address book (MS-OXNSPI 3.1.4.3): NspiBind names the
 * 8-bit code page of the session (CP_WINUNICODE is not a valid choice there,
 * 3.1.4.1.1); a request's STAT may name another one, or CP_WINUNICODE when the
 * client wants Unicode strings. Strings requested as PtypString8 are converted
 * from Unicode into that code page (3.1.4.3.3); characters it cannot represent
 * become '?'. The conversion is fixed per code page (3.1.4.3.2).
 *
 * Supported: every single- and double-byte Windows / ISO code page the
 * runtime can decode (the encoding table is built once from the decoder),
 * UTF-8 (65001) and the 7-bit ones (US-ASCII 20127, CP_TELETEX 20261,
 * which keep ASCII only). Pure module.
 */
import { TextDecoder } from 'node:util';

export const CP_WINUNICODE = 1200;
const CP_UTF8 = 65001;
const SEVEN_BIT = new Set([20127, 20261]);

const LABELS: Readonly<Record<number, string>> = {
  874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254',
  1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  20866: 'koi8-r', 21866: 'koi8-u', 28591: 'iso-8859-1', 28592: 'iso-8859-2', 28593: 'iso-8859-3', 28594: 'iso-8859-4',
  28595: 'iso-8859-5', 28596: 'iso-8859-6', 28597: 'iso-8859-7', 28598: 'iso-8859-8', 28599: 'iso-8859-9',
  28603: 'iso-8859-13', 28605: 'iso-8859-15',
};
const DOUBLE_BYTE = new Set([932, 936, 949, 950]);

export type Encoder = (s: string) => Buffer;

const QUESTION = 0x3f;
const tables = new Map<number, Map<string, Buffer>>();

function decoderFor(label: string): TextDecoder | null {
  try { return new TextDecoder(label); } catch { return null; }
}

/** Character → bytes, from decoding every one- and (double-byte code pages) two-byte sequence. */
function buildTable(decoder: TextDecoder, doubleByte: boolean): Map<string, Buffer> {
  const table = new Map<string, Buffer>();
  const learn = (bytes: number[]): void => {
    const ch = decoder.decode(Uint8Array.from(bytes));
    if (ch.length > 0 && !ch.includes('�') && [...ch].length === 1 && !table.has(ch)) table.set(ch, Buffer.from(bytes));
  };
  for (let b = 0; b < 0x100; b++) learn([b]);
  if (doubleByte) for (let lead = 0x81; lead < 0xff; lead++) for (let trail = 0x40; trail < 0x100; trail++) learn([lead, trail]);
  return table;
}

function tableEncoder(table: Map<string, Buffer>): Encoder {
  return (s) => Buffer.concat([...s].map((ch) => table.get(ch) ?? Buffer.from([QUESTION])));
}

const sevenBit: Encoder = (s) => Buffer.from(s.replace(/[^\u0000-\u007f]/g, '?'), 'latin1');

/** The encoder of an 8-bit code page; null when the server does not serve it (or for CP_WINUNICODE). */
export function encoderFor(codePage: number): Encoder | null {
  if (codePage === CP_UTF8) return (s) => Buffer.from(s, 'utf8');
  if (SEVEN_BIT.has(codePage)) return sevenBit;
  const label = LABELS[codePage];
  if (!label) return null;
  let table = tables.get(codePage);
  if (!table) {
    const decoder = decoderFor(label);
    if (!decoder) return null;
    table = buildTable(decoder, DOUBLE_BYTE.has(codePage));
    tables.set(codePage, table);
  }
  return tableEncoder(table);
}

/** The session code page NspiBind may accept (MS-OXNSPI 3.1.4.1.1: never CP_WINUNICODE). */
export function isBindCodePage(codePage: number): boolean {
  return codePage !== CP_WINUNICODE && encoderFor(codePage) !== null;
}
