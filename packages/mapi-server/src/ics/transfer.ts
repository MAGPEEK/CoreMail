/**
 * A FastTransfer download in progress (MS-OXCFXICS 3.2.5.8.1.5): the stream
 * is produced element by element (a message change, the deletions, the
 * state …) and handed out in buffers of the size RopFastTransferSourceGetBuffer
 * asks for. A buffer ends between two atoms or inside a variable-size value,
 * never inside an atom (2.2.4.1); TransferStatus is Partial until the last
 * piece left the server, then Done.
 *
 * Only the element being sent is held in memory (a message with its bodies
 * and attachment data), not the whole stream. `completed` counts the
 * elements whose last byte was handed out (checkpoint states).
 */
import type { FxPiece } from './fx-stream.js';

/** The largest atom (a PtypGuid value); a buffer must hold at least that. */
export const MIN_TRANSFER_BUFFER = 16;

export interface TransferChunk {
  data: Buffer;
  done: boolean;
}

/** Produces the stream one element (a list of pieces) at a time. */
export type ElementSource = Iterator<FxPiece[]> | AsyncIterator<FxPiece[]>;

interface Queued { piece: FxPiece; last: boolean }

export class FastTransferSource {
  private readonly queue: Queued[] = [];
  private exhausted = false;
  private done = 0;

  constructor(private readonly source: ElementSource, readonly totalSteps: number) {}

  get finished(): boolean { return this.exhausted && this.queue.length === 0; }
  /** Elements handed out completely. */
  get completed(): number { return this.done; }

  /** The next buffer of at most `max` bytes (max ≥ MIN_TRANSFER_BUFFER). */
  async next(max: number): Promise<TransferChunk> {
    const out: Buffer[] = [];
    let size = 0;
    for (;;) {
      if (this.queue.length === 0 && !(await this.pull())) break;
      const head = this.queue[0]!;
      const room = max - size;
      if (head.piece.bytes.length <= room) {
        out.push(head.piece.bytes);
        size += head.piece.bytes.length;
        this.queue.shift();
        if (head.last) this.done++;
        continue;
      }
      if (head.piece.splittable && room > 0) {
        out.push(head.piece.bytes.subarray(0, room));
        head.piece = { bytes: head.piece.bytes.subarray(room), splittable: true };
        size = max;
      }
      // An atom larger than a whole buffer would leave the client asking forever.
      if (size === 0) throw new Error(`FastTransfer atom of ${head.piece.bytes.length} bytes exceeds the ${max}-byte buffer`);
      break;
    }
    // Look ahead so the buffer with the last bytes already says Done.
    if (this.queue.length === 0) await this.pull();
    return { data: Buffer.concat(out), done: this.finished };
  }

  /** Every remaining byte (tests and small state streams). */
  async drain(): Promise<Buffer> {
    const parts: Buffer[] = [];
    while (!this.finished) parts.push((await this.next(0x7fffffff)).data);
    return Buffer.concat(parts);
  }

  private async pull(): Promise<boolean> {
    while (!this.exhausted) {
      const r = await this.source.next();
      if (r.done) { this.exhausted = true; return false; }
      if (r.value.length === 0) { this.done++; continue; }
      r.value.forEach((piece, i) => this.queue.push({ piece, last: i === r.value.length - 1 }));
      return true;
    }
    return false;
  }
}

/** A source over pieces that already exist (state streams). */
export function fixedSource(pieces: FxPiece[]): FastTransferSource {
  function* one(): Generator<FxPiece[]> { yield pieces; }
  return new FastTransferSource(one(), 1);
}
