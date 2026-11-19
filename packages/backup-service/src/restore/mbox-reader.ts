/**
 * Streaming mboxrd reader (9.3) — byte-exact counterpart of export/mbox.ts.
 *
 * Works on raw bytes (no text decoding, no line-ending conversion): a message
 * is everything between two separator lines, minus the one empty line the
 * exporter writes after every message, with one ">" removed from every line
 * that matches /^>+From /. A separator is a line starting with "From " that is
 * the first line of the file or follows an empty line (mboxrd quotes every
 * other "From " line; the empty-line rule also keeps unquoted "From " lines of
 * plain mboxo files from Thunderbird & co. inside their message).
 *
 * The old line reader (readline) turned every lone CR into a line break and
 * dropped ALL trailing empty lines, so restored messages could differ from
 * the originals.
 */
import { createReadStream } from 'node:fs';

export interface MboxMessage {
  /** Original message octets (null when the message exceeded `maxMessageBytes`). */
  raw: Buffer | null;
  /** Size of the message in the file (also for oversized messages). */
  size: number;
  /** 1-based position in the file. */
  index: number;
  /** 9.5: date of the "From " separator line (the internal date for CoreMail exports), null when unreadable. */
  separatorDate: Date | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ASCTIME_RE = /^From \S+\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})(?:\s|$)/;

/** asctime() date of an mbox separator line ("From sender Tue Feb  3 10:20:30 2026", UTC), or null. */
export function separatorLineDate(line: Buffer | string): Date | null {
  const text = typeof line === 'string' ? line : line.toString('latin1');
  const m = ASCTIME_RE.exec(text.replace(/\r?\n$/, ''));
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) return null;
  const d = new Date(Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])));
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[2]) ? null : d;
}

const FROM = Buffer.from('From ', 'latin1');
/** Same value as export/mbox.ts MBOX_NO_EOL_MARKER (kept local: the reader has no export dependency). */
const NO_EOL_MARKER = 'cm-noeol';

function isBlank(line: Buffer): boolean {
  return line.length === 1 ? line[0] === 0x0a : line.length === 2 && line[0] === 0x0d && line[1] === 0x0a;
}

function isSeparator(line: Buffer): boolean {
  return line.length >= FROM.length && line.subarray(0, FROM.length).equals(FROM);
}

/** True when `line` at `pos` holds ">…>From " (one or more ">"). */
function quotedFromAt(line: Buffer, pos: number): boolean {
  if (line[pos] !== 0x3e) return false;
  let i = pos;
  while (i < line.length && line[i] === 0x3e) i++;
  return line.length - i >= FROM.length && line.subarray(i, i + FROM.length).equals(FROM);
}

/**
 * ">From " → "From ", ">>From " → ">From " (mboxrd) — at the start of the line
 * and after every lone CR inside it: the exporter quotes at exactly these
 * positions (9.3 review: a "From " after a lone CR came back with its ">").
 */
function unquote(line: Buffer): Buffer {
  const starts: number[] = [];
  if (quotedFromAt(line, 0)) starts.push(0);
  for (let i = line.indexOf(0x0d); i >= 0 && i + 1 < line.length; i = line.indexOf(0x0d, i + 1)) {
    if (quotedFromAt(line, i + 1)) starts.push(i + 1);
  }
  if (!starts.length) return line;
  const parts: Buffer[] = [];
  let from = 0;
  for (const s of starts) { parts.push(line.subarray(from, s)); from = s + 1; }
  parts.push(line.subarray(from));
  return Buffer.concat(parts);
}

/** Separator line carrying the exporter's "no trailing line break" marker. */
function hasNoEolMarker(line: Buffer): boolean {
  const text = line.toString('latin1').replace(/\r?\n$/, '');
  return text.endsWith(` ${NO_EOL_MARKER}`);
}

/** Removes the one line break the exporter added after a message without one. */
function stripAddedEol(raw: Buffer): Buffer {
  if (raw.length >= 2 && raw[raw.length - 2] === 0x0d && raw[raw.length - 1] === 0x0a) return raw.subarray(0, -2);
  if (raw.length >= 1 && raw[raw.length - 1] === 0x0a) return raw.subarray(0, -1);
  return raw;
}

/** True when the first bytes look like an mbox file (a "From " separator line). */
export function looksLikeMbox(head: Buffer): boolean {
  return isSeparator(head);
}

/**
 * Yields the messages of an mbox file. Oversized messages are yielded with
 * `raw: null` (counted by the caller as failed) — their lines are not kept.
 */
export async function* readMbox(path: string, opts: { maxMessageBytes: number }): AsyncGenerator<MboxMessage> {
  let lines: Buffer[] = [];
  let size = 0;
  let oversized = false;
  let started = false;
  let noEol = false;
  let sepDate: Date | null = null;
  let prevBlank = true; // the first line of the file may be a separator
  let index = 0;
  let carry: Buffer = Buffer.alloc(0);

  const finish = (): MboxMessage | null => {
    if (!started) return null;
    index++;
    let msgLines = lines;
    if (!oversized && msgLines.length > 0 && isBlank(msgLines[msgLines.length - 1]!)) msgLines = msgLines.slice(0, -1);
    let raw: Buffer | null = oversized ? null : Buffer.concat(msgLines.map(unquote));
    if (raw && noEol) raw = stripAddedEol(raw);
    const out = { raw, size, index, separatorDate: sepDate };
    lines = [];
    size = 0;
    oversized = false;
    return out;
  };

  const handleLine = (line: Buffer): MboxMessage | null => {
    let done: MboxMessage | null = null;
    if (prevBlank && isSeparator(line)) {
      done = finish();
      started = true;
      noEol = hasNoEolMarker(line);
      sepDate = separatorLineDate(line);
      prevBlank = false;
      return done;
    }
    prevBlank = isBlank(line);
    if (!started) return null; // bytes before the first separator: not part of any message
    size += line.length;
    if (oversized) return null;
    if (size > opts.maxMessageBytes) {
      oversized = true;
      lines = [];
      return null;
    }
    lines.push(line);
    return null;
  };

  for await (const chunk of createReadStream(path)) {
    let buf: Buffer = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      const done = handleLine(Buffer.from(buf.subarray(start, nl + 1)));
      if (done) yield done;
      start = nl + 1;
    }
    carry = Buffer.from(buf.subarray(start));
    buf = Buffer.alloc(0);
    // A single line longer than the message limit: count it, keep nothing.
    if (carry.length > opts.maxMessageBytes && started) {
      size += carry.length;
      oversized = true;
      lines = [];
      carry = Buffer.alloc(0);
      prevBlank = false;
    }
  }
  if (carry.length) {
    const done = handleLine(carry);
    if (done) yield done;
  }
  const last = finish();
  if (last) yield last;
}
