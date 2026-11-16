import net from 'net';
import { createLogger } from '@coremail/core';

const log = createLogger('security-filter:clamav');

// clamd endpoint: deployment configuration (env only, never from the BCP — an
// admin-settable host/port would let the filter connect anywhere).
export const CLAMAV_HOST = process.env['CLAMAV_HOST'] ?? 'clamav';
export const CLAMAV_PORT = parseInt(process.env['CLAMAV_PORT'] ?? '3310', 10);
/** Default scan timeout (SecuritySettings.clamavTimeoutSec default 20 s). */
export const DEFAULT_SCAN_TIMEOUT_MS = 20_000;

/**
 * `oversize`: the message was not scanned because of its size — either above
 * the CoreMail scan limit (never sent to clamd) or clamd answered
 * "INSTREAM size limit exceeded" (clamd.conf StreamMaxLength).
 */
export type ClamavStatus = 'clean' | 'infected' | 'error' | 'oversize';

export interface ScanOptions {
  /** Abort the scan after this many ms (default DEFAULT_SCAN_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Test seam only (never from settings): clamd endpoint override. */
  endpoint?: { host: string; port: number };
}

/**
 * Kind of a clamd signature name:
 *  - `encrypted`: Heuristics.Encrypted.* (clamd.conf AlertEncrypted*)
 *  - `pua`:       PUA.*                  (clamd.conf DetectPUA)
 *  - `heuristic`: other Heuristics.* and Broken.Executable (HeuristicAlerts,
 *                 AlertOLE2Macros, AlertExceedsMax, phishing heuristics, …)
 *  - `malware`:   everything else (real signatures, incl. the EICAR test file)
 */
export type SignatureCategory = 'malware' | 'heuristic' | 'pua' | 'encrypted';

export function classifySignature(name: string | undefined): SignatureCategory {
  const n = (name ?? '').trim();
  if (/^Heuristics\.Encrypted(\.|$)/i.test(n)) return 'encrypted';
  if (/^PUA\./i.test(n)) return 'pua';
  if (/^(Heuristics\.|Broken\.Executable)/i.test(n)) return 'heuristic';
  return 'malware';
}

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
  if (/size limit exceeded/i.test(body)) return { status: 'oversize', clean: false, error: response };
  return { status: 'error', clean: false, error: response || 'empty reply' };
}

/** Parsed clamd `VERSION` reply, e.g. "ClamAV 1.4.1/27450/Mon Nov 16 09:23:00 2026". */
export interface ClamdVersion {
  /** Full reply text. */
  raw: string;
  /** Engine version, e.g. "1.4.1". */
  engine?: string;
  /** Daily signature database version, e.g. 27450 (missing before the first database load). */
  signatureVersion?: number;
  /** Build time of the signature database (ISO string), when parseable. */
  signatureDate?: string;
}

export function parseClamdVersion(raw: string): ClamdVersion {
  const text = raw.replace(/\0/g, '').trim();
  const m = /^ClamAV\s+([^/\s]+)(?:\/(\d+)(?:\/(.+))?)?$/i.exec(text);
  if (!m) return { raw: text };
  const out: ClamdVersion = { raw: text, engine: m[1]! };
  if (m[2]) out.signatureVersion = Number(m[2]);
  if (m[3]) {
    const t = Date.parse(m[3].trim());
    if (Number.isFinite(t)) out.signatureDate = new Date(t).toISOString();
  }
  return out;
}

/** Best-effort fields from the clamd `STATS` reply (the format is diagnostic, not stable). */
export interface ClamdStats { queueItems?: number; threadsLive?: number; threadsIdle?: number; threadsMax?: number }

export function parseClamdStats(raw: string): ClamdStats {
  const out: ClamdStats = {};
  const q = /QUEUE:\s*(\d+)\s+items?/i.exec(raw);
  if (q) out.queueItems = Number(q[1]);
  const t = /THREADS:\s*live\s+(\d+)\s+idle\s+(\d+)\s+max\s+(\d+)/i.exec(raw);
  if (t) { out.threadsLive = Number(t[1]); out.threadsIdle = Number(t[2]); out.threadsMax = Number(t[3]); }
  return out;
}

/** Send one z-framed clamd command (PING, VERSION, STATS) and return the reply text. */
export function clamdCommand(command: 'PING' | 'VERSION' | 'STATS', timeoutMs = 4_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(CLAMAV_PORT, CLAMAV_HOST);
    const chunks: Buffer[] = [];
    let done = false;
    const end = (fn: () => void) => { if (!done) { done = true; clearTimeout(t); socket.destroy(); fn(); } };
    const t = setTimeout(() => end(() => reject(new Error('timeout'))), timeoutMs);
    socket.on('connect', () => socket.write(`z${command}\0`));
    socket.on('data', (c: Buffer) => {
      chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      // z-framed replies end with NUL; STATS ends with "END"
      if (text.includes('\0')) end(() => resolve(text.replace(/\0/g, '').trim()));
    });
    socket.on('end', () => end(() => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim())));
    socket.on('error', (e) => end(() => reject(e)));
  });
}

/**
 * The EICAR anti-virus test file inside a small RFC 5322 message (base64
 * attachment) — scanned the same way as real inbound mail. Assembled from
 * two parts so that this source file itself is not flagged by scanners.
 */
export function eicarTestMessage(): Buffer {
  const eicar = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
  const b64 = Buffer.from(eicar, 'ascii').toString('base64');
  return Buffer.from([
    'From: eicar-test@coremail.invalid',
    'To: postmaster@coremail.invalid',
    'Subject: CoreMail antivirus test (EICAR)',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="cm-eicar"',
    '',
    '--cm-eicar',
    'Content-Type: text/plain; charset=us-ascii',
    '',
    'EICAR test file attached.',
    '--cm-eicar',
    'Content-Type: application/octet-stream; name="eicar.com"',
    'Content-Disposition: attachment; filename="eicar.com"',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--cm-eicar--',
    '',
  ].join('\r\n'), 'ascii');
}

export async function scanBuffer(buffer: Buffer, opts: ScanOptions = {}): Promise<ClamavResult> {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SCAN_TIMEOUT_MS;
  return new Promise<ClamavResult>((resolve) => {
    let settled = false;
    const finish = (r: ClamavResult) => { if (!settled) { settled = true; clearTimeout(timeout); resolve(r); } };
    const socket = net.createConnection(opts.endpoint?.port ?? CLAMAV_PORT, opts.endpoint?.host ?? CLAMAV_HOST);
    const chunks: Buffer[] = [];

    const timeout = setTimeout(() => {
      socket.destroy();
      log.error({ timeoutMs }, 'ClamAV scan timeout');
      finish({ status: 'error', clean: false, error: 'scan timeout' });
    }, timeoutMs);

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
      // clamd answers "INSTREAM size limit exceeded. ERROR" and closes while we
      // are still writing → EPIPE/ECONNRESET. A reply already received wins.
      if (chunks.length > 0) {
        const reply = parseClamdResponse(Buffer.concat(chunks).toString('utf8'));
        if (reply.status !== 'error') { finish(reply); return; }
      }
      log.error({ err }, 'ClamAV connection error');
      finish({ status: 'error', clean: false, error: err.message });
    });
  });
}
