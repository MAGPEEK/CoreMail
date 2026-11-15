/**
 * COMPRESS=DEFLATE (RFC 4978): raw deflate (RFC 1951) in both directions on
 * top of the existing transport (plain TCP or TLS).
 *
 * Output: everything written to the session socket goes through one deflate
 * stream; a Z_SYNC_FLUSH is issued once per event-loop turn so every response
 * reaches the client without waiting for more data.
 * Input: the transport's octets are inflated and handed to the command reader.
 * Back-pressure and limits: pause() stops both the transport and the inflate
 * stream, so a command that is still running throttles a decompression bomb by
 * TCP (only already-received compressed octets are buffered, never their
 * expansion); line and literal limits of the command reader apply to the
 * inflated data. Idle timeouts stay on the transport.
 */
import type net from 'node:net';
import zlib from 'node:zlib';
import type { ImapSocket } from '../session/state.js';

export class CompressedSocket implements ImapSocket {
  private readonly deflate = zlib.createDeflateRaw();
  private readonly inflate = zlib.createInflateRaw();
  private flushScheduled = false;
  private ended = false;

  constructor(
    private readonly inner: net.Socket,
    onData: (chunk: Buffer) => void,
    onError: (err: Error) => void,
  ) {
    this.deflate.pipe(inner);
    this.deflate.on('error', onError);
    this.inflate.on('data', onData);
    this.inflate.on('error', onError);
    inner.once('close', () => this.dispose());
  }

  get remoteAddress(): string | undefined { return this.inner.remoteAddress; }
  get writable(): boolean { return !this.ended && this.inner.writable; }

  /** Compressed octets received from the client. */
  input(chunk: Buffer): void {
    if (!this.inflate.destroyed) this.inflate.write(chunk);
  }

  write(data: string | Uint8Array, cb?: (err?: Error | null) => void): boolean {
    if (this.ended || this.deflate.destroyed) return false;
    const ok = this.deflate.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, cb);
    this.scheduleFlush();
    return ok;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (!this.ended && !this.deflate.destroyed) this.deflate.flush(zlib.constants.Z_SYNC_FLUSH);
    });
  }

  /** Writes the final data, finishes the deflate stream and then ends the transport. */
  end(data?: string | Uint8Array): this {
    if (this.ended) return this;
    if (data !== undefined) this.write(data);
    this.ended = true;
    this.deflate.end();
    return this;
  }

  destroy(): this {
    this.dispose();
    this.inner.destroy();
    return this;
  }

  pause(): this {
    this.inner.pause();
    this.inflate.pause();
    return this;
  }

  resume(): this {
    this.inflate.resume();
    this.inner.resume();
    return this;
  }

  setTimeout(ms: number): this {
    this.inner.setTimeout(ms);
    return this;
  }

  private dispose(): void {
    this.ended = true;
    this.inflate.destroy();
    this.deflate.unpipe(this.inner);
    this.deflate.destroy();
  }
}
