/**
 * Byte-oriented IMAP command reader (RFC 9051 §2.2, §4.3, RFC 7888 LITERAL+).
 *
 * Collects octets from the socket and emits complete commands as segments
 * (text lines without CRLF, interleaved with literal octets — see tokenizer.ts).
 *
 * - "{n}"  (synchronizing literal): the `onLiteral` hook decides; on "continue"
 *   the reader sends the continuation request and reads exactly n octets.
 * - "{n+}" (non-synchronizing literal, LITERAL+): no continuation is sent.
 *
 * Commands are processed strictly one after the other: the next command is
 * not parsed before the `onCommand` promise of the previous one resolved
 * (RFC 9051 §5.5 — pipelined commands are answered in order). While a hook
 * runs the input is paused so a flooding client is throttled by TCP.
 *
 * v8.1: input chunks are kept in a list and merged only once a complete line
 * or the whole announced literal is available (no re-concatenation per chunk —
 * that was quadratic for large literals). Limits are read per decision, so the
 * server can apply tighter caps before authentication. The text of one command
 * (all lines between literals) is capped at MAX_COMMAND_LINES × maxLineLength.
 */
import { literalMarker, type CommandSegment } from './tokenizer.js';

const CRLF = Buffer.from('\r\n');
const EMPTY = Buffer.alloc(0);
/** Text of one command (lines between its literals) ≤ this many maximum-length lines. */
const MAX_COMMAND_LINES = 4;

export type LiteralDecision = 'continue' | 'drop' | 'close';

export interface CommandReaderHooks {
  /** Maximum length of one text line (without CRLF); a function is read per line. */
  maxLineLength: number | (() => number);
  /** Maximum size of a single literal and of all literals of one command. */
  maxLiteralSize(): number;
  /** False while the session expects non-command input (IDLE, SASL). */
  literalsAllowed(): boolean;
  /** A complete command (or a raw continuation line when literals are not allowed). */
  onCommand(segments: CommandSegment[]): Promise<void>;
  /**
   * Called for every announced literal before it is read. `tooLarge` is set
   * when the literal exceeds maxLiteralSize(). "drop" discards the command
   * (only valid for synchronizing literals — the client has not sent data yet);
   * "close" stops reading for good.
   */
  onLiteral(segments: CommandSegment[], size: number, sync: boolean, tooLarge: boolean): Promise<LiteralDecision>;
  /** Sends the command continuation request for a synchronizing literal. */
  sendContinuation(): void;
  /** A line exceeded maxLineLength — the connection must be closed. */
  onLineTooLong(): void;
  pause?(): void;
  resume?(): void;
}

export class CommandReader {
  /** Merged head of the input (already scanned for line ends). */
  private buffer: Buffer = EMPTY;
  /** Chunks received since the last merge. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** A CRLF is somewhere in `pending` (or spans buffer/pending). */
  private pendingHasLineEnd = false;
  private segments: CommandSegment[] = [];
  private literalBytes = 0;
  private textBytes = 0;
  private expectedLiteral: number | null = null;
  private busy = false;
  private closed = false;

  constructor(private readonly hooks: CommandReaderHooks) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** Bytes received but not processed yet (tests/metrics). */
  get bufferedBytes(): number {
    return this.buffer.length + this.pendingBytes;
  }

  /** Stops processing; further input is ignored. */
  close(): void {
    this.closed = true;
    this.buffer = EMPTY;
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingHasLineEnd = false;
    this.segments = [];
  }

  push(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    const prev = this.pending.length ? this.pending[this.pending.length - 1]! : this.buffer;
    if ((prev.length > 0 && prev[prev.length - 1] === 0x0d && chunk[0] === 0x0a) || chunk.indexOf(CRLF) !== -1) {
      this.pendingHasLineEnd = true;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    void this.pump();
  }

  private maxLine(): number {
    const m = this.hooks.maxLineLength;
    return typeof m === 'function' ? m() : m;
  }

  /** Moves all pending chunks into `buffer` (one copy per merge). */
  private merge(): void {
    if (this.pending.length === 0) return;
    const parts = this.buffer.length ? [this.buffer, ...this.pending] : this.pending;
    this.buffer = parts.length === 1 ? parts[0]! : Buffer.concat(parts, this.buffer.length + this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingHasLineEnd = false;
  }

  /** Resolves when all buffered input has been processed (for tests). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private async runHook<T>(fn: () => Promise<T>): Promise<T> {
    this.hooks.pause?.();
    try {
      return await fn();
    } finally {
      if (!this.closed) this.hooks.resume?.();
    }
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (!this.closed) {
        if (this.expectedLiteral !== null) {
          if (this.bufferedBytes < this.expectedLiteral) break;
          const n = this.expectedLiteral;
          if (this.buffer.length < n) this.merge();
          this.segments.push(Buffer.from(this.buffer.subarray(0, n)));
          this.buffer = this.buffer.subarray(n);
          this.expectedLiteral = null;
          continue;
        }

        const maxLine = this.maxLine();
        let idx = this.buffer.indexOf(CRLF);
        if (idx === -1 && (this.pendingHasLineEnd || this.bufferedBytes > maxLine)) {
          this.merge();
          idx = this.buffer.indexOf(CRLF);
        }
        if (idx === -1) {
          if (this.bufferedBytes > maxLine) this.lineTooLong();
          break;
        }
        if (idx > maxLine) { this.lineTooLong(); break; }
        // The text of one command must not grow without bound through
        // endless "{0+}" continuations.
        this.textBytes += idx + 2;
        if (this.textBytes > maxLine * MAX_COMMAND_LINES) { this.lineTooLong(); break; }

        const line = this.buffer.subarray(0, idx).toString('utf8');
        this.buffer = this.buffer.subarray(idx + 2);

        const marker = this.hooks.literalsAllowed() ? literalMarker(line) : null;
        if (marker) {
          this.segments.push(line);
          const tooLarge =
            marker.size > this.hooks.maxLiteralSize() ||
            this.literalBytes + marker.size > this.hooks.maxLiteralSize();
          const segs = [...this.segments];
          const decision = await this.runHook(() => this.hooks.onLiteral(segs, marker.size, marker.sync, tooLarge));
          if (this.closed) break;
          if (decision === 'close' || (decision === 'drop' && !marker.sync) || (tooLarge && decision === 'continue')) {
            this.close();
            break;
          }
          if (decision === 'drop') {
            this.segments = [];
            this.literalBytes = 0;
            this.textBytes = 0;
            continue;
          }
          if (marker.sync) this.hooks.sendContinuation();
          this.literalBytes += marker.size;
          this.expectedLiteral = marker.size;
          continue;
        }

        this.segments.push(line);
        const command = this.segments;
        this.segments = [];
        this.literalBytes = 0;
        this.textBytes = 0;
        await this.runHook(() => this.hooks.onCommand(command));
      }
    } finally {
      this.busy = false;
    }
    // Input that arrived while the last hook was finishing.
    if (!this.closed && this.bufferedBytes > 0 && this.hasWork()) void this.pump();
  }

  private hasWork(): boolean {
    if (this.expectedLiteral !== null) return this.bufferedBytes >= this.expectedLiteral;
    return this.pendingHasLineEnd || this.buffer.indexOf(CRLF) !== -1 || this.bufferedBytes > this.maxLine();
  }

  private lineTooLong(): void {
    this.close();
    this.hooks.onLineTooLong();
  }
}
