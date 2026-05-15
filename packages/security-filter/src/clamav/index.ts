import net from 'net';
import { createLogger } from '@coremail/core';

const log = createLogger('security-filter:clamav');

const CLAMAV_HOST = process.env['CLAMAV_HOST'] ?? 'clamav';
const CLAMAV_PORT = parseInt(process.env['CLAMAV_PORT'] ?? '3310', 10);
const SCAN_TIMEOUT_MS = 30_000;

export interface ClamavResult {
  clean: boolean;
  virusName?: string;
}

export async function scanBuffer(buffer: Buffer): Promise<ClamavResult> {
  return new Promise<ClamavResult>((resolve, reject) => {
    const socket = net.createConnection(CLAMAV_PORT, CLAMAV_HOST);
    const chunks: Buffer[] = [];

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('ClamAV scan timeout'));
    }, SCAN_TIMEOUT_MS);

    socket.on('connect', () => {
      // INSTREAM protocol: zINSTREAM\0 + [4-byte size][data] + [0000] to end
      socket.write('zINSTREAM\0');

      // Write data in 4096-byte chunks with size prefix
      let offset = 0;
      const CHUNK = 4096;
      while (offset < buffer.length) {
        const slice = buffer.subarray(offset, offset + CHUNK);
        const sizeBuf = Buffer.alloc(4);
        sizeBuf.writeUInt32BE(slice.length, 0);
        socket.write(sizeBuf);
        socket.write(slice);
        offset += CHUNK;
      }

      // Terminate stream
      socket.write(Buffer.alloc(4));
    });

    socket.on('data', (chunk: Buffer) => chunks.push(chunk));

    socket.on('end', () => {
      clearTimeout(timeout);
      const response = Buffer.concat(chunks).toString('utf8').trim();
      log.debug({ response }, 'ClamAV response');

      if (response.includes('OK')) {
        resolve({ clean: true });
      } else if (response.includes('FOUND')) {
        const virusName = response.split(':')[1]?.trim().replace(' FOUND', '');
        log.warn({ virusName }, 'Virus detected');
        resolve({ clean: false, ...(virusName ? { virusName } : {}) });
      } else {
        log.error({ response }, 'Unexpected ClamAV response');
        // Fail safe — treat as clean to avoid blocking legitimate mail
        resolve({ clean: true });
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      log.error({ err }, 'ClamAV connection error');
      // Fail open — do not block mail if AV is unavailable
      resolve({ clean: true });
    });
  });
}
