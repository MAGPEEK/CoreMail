/**
 * Which certificate do the mail ports really serve? (9.3)
 *
 * Connects to the local SMTP/IMAP/POP3 listeners — implicit TLS (465/993/995)
 * or STARTTLS / STLS on the plain ports (25/587/143/110) — with SNI set to the
 * public host name and reports subject, issuer, expiry, SHA-256 fingerprint,
 * whether it is self-signed, whether it matches the host name and whether Node's
 * CA bundle trusts it. Every probe is bounded (connect + protocol + handshake);
 * nothing is authenticated and no mail is sent. The integrated HTTPS server is
 * probed the same way (implicit TLS, handshake only, no HTTP request).
 */
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

export type MailProtocol = 'smtp' | 'imap' | 'pop3';
/** 'https' = the integrated HTTPS server (implicit TLS only). */
export type ProbeProtocol = MailProtocol | 'https';

export interface ProbeTarget {
  protocol: ProbeProtocol;
  port: number;
  /** true = implicit TLS (465/993/995/443), false = STARTTLS/STLS upgrade (mail only). */
  implicitTls: boolean;
  host?: string;
}

export interface ServedCert {
  subject: string;
  issuer: string;
  commonName: string | null;
  altNames: string[];
  validFrom: string;
  validTo: string;
  fingerprint256: string;
  selfSigned: boolean;
  /** The certificate names the host name used for SNI. */
  hostnameMatch: boolean;
  /** Node's CA bundle accepts the chain (what mail clients check, roughly). */
  trusted: boolean;
  trustError: string | null;
  expired: boolean;
}

export interface ProbeResult extends ProbeTarget {
  mode: 'tls' | 'starttls';
  ok: boolean;
  error?: string;
  cert?: ServedCert;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function deadline<T>(p: Promise<T>, ms: number, onTimeout: () => void, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new Error(`timeout after ${ms} ms (${what})`)); }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Reads CRLF lines from a plain socket until `done(line)` is true; returns all lines. */
function readUntil(sock: net.Socket, done: (line: string) => boolean, maxBytes = 16_384): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const lines: string[] = [];
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      if (buf.length > maxBytes) { cleanup(); reject(new Error('response too long')); return; }
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        lines.push(line);
        if (done(line)) { cleanup(); resolve(lines); return; }
      }
    };
    const onEnd = () => { cleanup(); reject(new Error(`connection closed (${lines.at(-1) ?? 'no data'})`)); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => { sock.off('data', onData); sock.off('end', onEnd); sock.off('close', onEnd); sock.off('error', onErr); };
    sock.on('data', onData);
    sock.on('end', onEnd);
    sock.on('close', onEnd);
    sock.on('error', onErr);
  });
}

/** Protocol-specific STARTTLS dialogue on a plain connection. */
async function negotiateStartTls(sock: net.Socket, protocol: MailProtocol): Promise<void> {
  const smtpFinal = (l: string) => /^\d{3}(?: |$)/.test(l);
  if (protocol === 'smtp') {
    const greet = await readUntil(sock, smtpFinal);
    if (!greet.at(-1)!.startsWith('220')) throw new Error(`SMTP greeting: ${greet.at(-1)}`);
    sock.write('EHLO coremail-selfcheck\r\n');
    const ehlo = await readUntil(sock, smtpFinal);
    if (!ehlo.at(-1)!.startsWith('250')) throw new Error(`EHLO: ${ehlo.at(-1)}`);
    if (!ehlo.some((l) => /^250[ -]STARTTLS\b/i.test(l))) throw new Error('STARTTLS not offered');
    sock.write('STARTTLS\r\n');
    const r = await readUntil(sock, smtpFinal);
    if (!r.at(-1)!.startsWith('220')) throw new Error(`STARTTLS: ${r.at(-1)}`);
    return;
  }
  if (protocol === 'imap') {
    const greet = await readUntil(sock, () => true);
    if (!/^\* (OK|PREAUTH)/i.test(greet[0] ?? '')) throw new Error(`IMAP greeting: ${greet[0]}`);
    sock.write('cm1 STARTTLS\r\n');
    const r = await readUntil(sock, (l) => l.startsWith('cm1 '));
    if (!/^cm1 OK/i.test(r.at(-1)!)) throw new Error(`STARTTLS: ${r.at(-1)}`);
    return;
  }
  const greet = await readUntil(sock, () => true);
  if (!(greet[0] ?? '').startsWith('+OK')) throw new Error(`POP3 greeting: ${greet[0]}`);
  sock.write('STLS\r\n');
  const r = await readUntil(sock, () => true);
  if (!(r[0] ?? '').startsWith('+OK')) throw new Error(`STLS: ${r[0]}`);
}

/** Pure: describes a peer certificate (DER) for `servername`. */
export function describeCert(raw: Buffer, servername: string, authorized: boolean, authError: string | null, now: Date = new Date()): ServedCert {
  const x = new X509Certificate(raw);
  const cn = /(?:^|\n|,\s*)CN=([^,\n]+)/i.exec(x.subject)?.[1]?.trim() ?? null;
  const altNames = (x.subjectAltName ?? '').split(',').map((s) => s.trim())
    .filter((s) => s.toUpperCase().startsWith('DNS:')).map((s) => s.slice(4).toLowerCase());
  const hostnameMatch = x.checkHost(servername) !== undefined;
  const validTo = new Date(x.validTo);
  return {
    subject: x.subject.replace(/\n/g, ', '),
    issuer: x.issuer.replace(/\n/g, ', '),
    commonName: cn,
    altNames,
    validFrom: new Date(x.validFrom).toISOString(),
    validTo: validTo.toISOString(),
    fingerprint256: x.fingerprint256,
    selfSigned: x.subject === x.issuer,
    hostnameMatch,
    trusted: authorized,
    trustError: authorized ? null : authError,
    expired: validTo.getTime() < now.getTime(),
  };
}

/** Addresses of this host's network interfaces (lowercase, without zone id). */
export function localInterfaceAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) out.add(a.address.toLowerCase().replace(/%.*$/, ''));
  }
  return out;
}

function isLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) return ip.startsWith('127.');
  const v = ip.toLowerCase();
  return v === '::1' || /^::ffff:127\./.test(v);
}

/**
 * The address to connect to for a listener bound to `address`, or null when it
 * is not this host: wildcard → 127.0.0.1, loopback and the host's own interface
 * addresses as-is. Host names and foreign addresses are never connected to
 * (the probe must not become an SSRF primitive through a stored listener row).
 */
export function localProbeHost(address: string | null | undefined, localAddresses: Set<string> = localInterfaceAddresses()): string | null {
  const a = (address ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!a || a === '0.0.0.0' || a === '::' || a === '*') return '127.0.0.1';
  if (a === 'localhost') return '127.0.0.1';
  if (net.isIP(a) === 0) return null;
  if (isLoopbackIp(a)) return a;
  return localAddresses.has(a) ? a : null;
}

/** Probes one listener. Never throws; `ok:false` + `error` on failure. */
export async function probeServedCert(
  target: ProbeTarget,
  servername: string,
  opts: { timeoutMs?: number; ca?: string | Buffer | Array<string | Buffer> } = {},
): Promise<ProbeResult> {
  const mode = target.implicitTls ? 'tls' : 'starttls';
  const local = localProbeHost(target.host ?? '127.0.0.1');
  if (!local) {
    return { ...target, mode, ok: false, error: 'listener address is not a local address of this server — not probed' };
  }
  const host = local;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base: ProbeResult = { ...target, host, mode, ok: false };
  let plain: net.Socket | null = null;
  let secure: tls.TLSSocket | null = null;
  const destroy = () => { secure?.destroy(); plain?.destroy(); };
  try {
    const run = async (): Promise<ServedCert> => {
      const sni = net.isIP(servername) ? undefined : servername;
      const tlsOpts: tls.ConnectionOptions = {
        rejectUnauthorized: false,
        ...(sni ? { servername: sni } : {}),
        ...(opts.ca ? { ca: opts.ca } : {}),
      };
      if (target.implicitTls) {
        secure = tls.connect({ host, port: target.port, ...tlsOpts });
      } else {
        if (target.protocol === 'https') throw new Error('HTTPS has no STARTTLS upgrade');
        const protocol = target.protocol;
        plain = net.connect({ host, port: target.port });
        await new Promise<void>((resolve, reject) => {
          plain!.once('connect', () => resolve());
          plain!.once('error', reject);
        });
        await negotiateStartTls(plain, protocol);
        secure = tls.connect({ socket: plain, ...tlsOpts });
      }
      await new Promise<void>((resolve, reject) => {
        secure!.once('secureConnect', () => resolve());
        secure!.once('error', reject);
      });
      const peer = secure.getPeerCertificate(false);
      if (!peer || !peer.raw) throw new Error('no certificate presented');
      return describeCert(peer.raw, servername, secure.authorized,
        secure.authorizationError ? String(secure.authorizationError) : null);
    };
    const cert = await deadline(run(), timeoutMs, destroy, `${target.protocol} ${target.port}`);
    return { ...base, ok: true, cert };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  } finally {
    destroy();
  }
}

/** Default listeners when none are configured in the database. */
export const DEFAULT_PROBE_TARGETS: ProbeTarget[] = [
  { protocol: 'imap', port: 993, implicitTls: true },
  { protocol: 'smtp', port: 465, implicitTls: true },
  { protocol: 'imap', port: 143, implicitTls: false },
  { protocol: 'smtp', port: 587, implicitTls: false },
  { protocol: 'pop3', port: 995, implicitTls: true },
  { protocol: 'pop3', port: 110, implicitTls: false },
];

/**
 * The integrated HTTPS server as a probe target, or null while it does not
 * listen (no certificate marked for HTTPS, or TLS terminated outside CoreMail).
 */
export function httpsProbeTarget(state: { active: boolean; port: number }): ProbeTarget | null {
  if (!state.active || !Number.isInteger(state.port) || state.port <= 0 || state.port >= 65536) return null;
  return { protocol: 'https', port: state.port, implicitTls: true };
}

/** A probe result that should be shown as a warning (self-signed, name mismatch, expired). */
export function servedCertProblem(r: ProbeResult): 'self-signed' | 'hostname-mismatch' | 'expired' | null {
  if (!r.ok || !r.cert) return null;
  if (r.cert.expired) return 'expired';
  if (r.cert.selfSigned) return 'self-signed';
  if (!r.cert.hostnameMatch) return 'hostname-mismatch';
  return null;
}
