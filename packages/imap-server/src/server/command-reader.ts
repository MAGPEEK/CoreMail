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
 */
import { literalMarker, type CommandSegment } from './tokenizer.js';

const CRLF = Buffer.from('\r\n');

export type LiteralDecision = 'continue' | 'drop' | 'close';

export interface CommandReaderHooks {
  /** Maximum length of one text line (without CRLF). */
  maxLineLength: number;
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
  private buffer: Buffer = Buffer.alloc(0);
  private segments: CommandSegment[] = [];
  private literalBytes = 0;
  private expectedLiteral: number | null = null;
  private busy = false;
  private closed = false;

  constructor(private readonly hooks: CommandReaderHooks) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** Stops processing; further input is ignored. */
  close(): void {
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.segments = [];
  }

  push(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    void this.pump();
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
          if (this.buffer.length < this.expectedLiteral) break;
          const n = this.expectedLiteral;
          this.segments.push(Buffer.from(this.buffer.subarray(0, n)));
          this.buffer = this.buffer.subarray(n);
          this.expectedLiteral = null;
          continue;
        }

        const idx = this.buffer.indexOf(CRLF);
        if (idx === -1) {
          if (this.buffer.length > this.hooks.maxLineLength) this.lineTooLong();
          break;
        }
        if (idx > this.hooks.maxLineLength) { this.lineTooLong(); break; }

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
        await this.runHook(() => this.hooks.onCommand(command));
      }
    } finally {
      this.busy = false;
    }
    // Input that arrived while the last hook was finishing.
    if (!this.closed && this.buffer.length > 0 && this.hasWork()) void this.pump();
  }

  private hasWork(): boolean {
    if (this.expectedLiteral !== null) return this.buffer.length >= this.expectedLiteral;
    return this.buffer.indexOf(CRLF) !== -1 || this.buffer.length > this.hooks.maxLineLength;
  }

  private lineTooLong(): void {
    this.close();
    this.hooks.onLineTooLong();
  }
}
