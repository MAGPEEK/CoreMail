/**
 * 9.4: reads the first bytes of a stream without losing them — for content
 * sniffing before an attachment is sent (lib/attachment-download.ts).
 */
import { Readable } from 'node:stream';

/**
 * Up to `bytes` leading bytes of `source` and a stream that yields the whole
 * content (the peeked bytes included). Rejects when the source fails before
 * `bytes` were read.
 */
export async function peekStream(source: NodeJS.ReadableStream, bytes: number): Promise<{ head: Buffer; stream: Readable }> {
  const src = source instanceof Readable ? source : new Readable().wrap(source);
  const chunks: Buffer[] = [];
  let length = 0;
  let ended = false;
  while (length < bytes && !ended) {
    const chunk = src.read() as Buffer | string | null;
    if (chunk !== null) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      chunks.push(buf);
      length += buf.length;
      continue;
    }
    ended = await new Promise<boolean>((resolve, reject) => {
      const done = (value: boolean, err?: unknown) => {
        src.off('readable', onReadable); src.off('end', onEnd); src.off('error', onError);
        if (err) reject(err); else resolve(value);
      };
      const onReadable = () => done(false);
      const onEnd = () => done(true);
      const onError = (err: unknown) => done(true, err);
      if (src.readableEnded) { resolve(true); return; }
      src.once('readable', onReadable); src.once('end', onEnd); src.once('error', onError);
    });
  }
  const all = Buffer.concat(chunks);
  if (ended || src.readableEnded) return { head: all.subarray(0, bytes), stream: Readable.from([all]) };
  src.unshift(all);
  return { head: all.subarray(0, bytes), stream: src };
}
