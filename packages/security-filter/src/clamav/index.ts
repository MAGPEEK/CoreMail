import net from 'net';
import { createLogger } from '@coremail/core';

const log = createLogger('security-filter:clamav');

const CLAMAV_HOST = process.env['CLAMAV_HOST'] ?? 'clamav';
const CLAMAV_PORT = parseInt(process.env['CLAMAV_PORT'] ?? '3310', 10);
const SCAN_TIMEOUT_MS = 30_000;

export type ClamavStatus = 'clean' | 'infected' | 'error';

export interface ClamavResult {
  status: ClamavStatus;
  /** @deprecated use `status === 'clean'` — kept for existing callers. */
  clean: boolean;
  virusName?: string;
  error?: string;
}

/**
 * Pure: interpret a clamd INSTREAM reply (null-terminated with the `z` prefix).
 *   "stream: OK"                          → clean
 *   "stream: Eicar-Test-Signature FOUND"  → infected (FOUND is checked first —
 *                                           a signature name may contain "OK")
 *   "INSTREAM size limit exceeded. ERROR" / anything else → error
 */
export function parseClamdResponse(raw: string): ClamavResult {
  const response = raw.replace(/\0/g, '').trim();
  const body = response.replace(/^stream:\s*/i, '').replace(/^\d+:\s*stream:\s*/i, '');
  if (/\sFOUND$/.test(body)) {
    const virusName = body.replace(/\s+FOUND$/, '').trim();
    return { status: 'infected', clean: false, ...(virusName ? { virusName } : {}) };
  }
  if (body === 'OK') return { status: 'clean', clean: true };
  return { status: 'error', clean: false, error: response || 'empty reply' };
}

export async function scanBuffer(buffer: Buffer): Promise<ClamavResult> {
  return new Promise<ClamavResult>((resolve) => {
    let settled = false;
    const finish = (r: ClamavResult) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(r); } };
    const socket = net.createConnection(CLAMAV_PORT, CLAMAV_HOST);
    const chunks: Buffer[] = [];

    const timeout = setTimeout(() => {
      socket.destroy();
      log.error('ClamAV scan timeout');
      finish({ status: 'error', clean: false, error: 'scan timeout' });
    }, SCAN_TIMEOUT_MS);

    socket.on('connect', () => {
      // INSTREAM protocol: zINSTREAM\0 + [4-byte size][data] + [0000] to end
      socket.write('zINSTREAM\0');
      let offset = 0;
      const CHUNK = 64 * 1024;
      while (offset < buffer.length) {
        const slice = buffer.subarray(offset, offset + CHUNK);
        const sizeBuf = Buffer.alloc(4);
        sizeBuf.writeUInt32BE(slice.length, 0);
        socket.write(sizeBuf);
        socket.write(slice);
        offset += CHUNK;
      }
      socket.write(Buffer.alloc(4)); // terminate stream
    });

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));

    socket.on('end', () => {
      const result = parseClamdResponse(Buffer.concat(chunks).toString('utf8'));
      if (result.status === 'infected') log.warn({ virusName: result.virusName }, 'Virus detected');
      else if (result.status === 'error') log.error({ response: result.error }, 'Unexpected ClamAV response');
      finish(result);
    });

    socket.on('error', (err) => {
      log.error({ err }, 'ClamAV connection error');
      finish({ status: 'error', clean: false, error: err.message });
    });
  });
}
