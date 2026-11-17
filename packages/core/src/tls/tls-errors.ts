/**
 * TLS socket error classification for the mail servers (9.3).
 *
 * A client that does not trust the served certificate aborts the handshake
 * with a TLS alert ("certificate unknown", "bad certificate", "unknown CA").
 * That is a configuration problem of the served certificate, not a server
 * fault — logged as warn with a hint instead of error, together with the
 * client IP.
 */

const UNTRUSTED_ALERT_CODES = new Set([
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN',
  'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_SSL_SSLV3_ALERT_UNSUPPORTED_CERTIFICATE',
  'ERR_SSL_TLSV1_ALERT_DECRYPT_ERROR',
]);
const UNTRUSTED_ALERT_RE = /alert (certificate unknown|bad certificate|unknown ca|unsupported certificate)/i;

export const UNTRUSTED_CERT_HINT =
  'client does not trust the served certificate (self-signed, wrong host name or missing intermediate) — check BCP → SSL/TLS';

export interface TlsErrorClass {
  level: 'warn' | 'error' | 'debug';
  /** Short text for the log line. */
  msg: string;
  hint?: string;
}

const PEER_GONE = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT']);

/** Classifies a TLS / socket error of a client connection. */
export function classifyTlsSocketError(err: unknown): TlsErrorClass {
  const code = String((err as { code?: unknown })?.code ?? '');
  const message = String((err as { message?: unknown })?.message ?? err ?? '');
  if (UNTRUSTED_ALERT_CODES.has(code) || UNTRUSTED_ALERT_RE.test(message)) {
    return { level: 'warn', msg: 'TLS handshake aborted by the client — certificate not trusted', hint: UNTRUSTED_CERT_HINT };
  }
  if (PEER_GONE.has(code)) return { level: 'debug', msg: 'TLS client disconnected' };
  if (/ERR_SSL_|SSL routines|handshake/i.test(code + ' ' + message)) {
    return { level: 'warn', msg: 'TLS handshake failed' };
  }
  return { level: 'error', msg: 'TLS socket error' };
}

/** Minimal logger shape (pino-compatible). */
interface LogLike {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

/**
 * Logs a TLS socket error of a client connection with the client IP; alerts
 * that mean "client does not trust the certificate" become warn + hint.
 */
export function logTlsSocketError(
  log: LogLike, err: unknown, ctx: { ip?: string | undefined; port?: number | undefined; service: string; [k: string]: unknown },
): void {
  const c = classifyTlsSocketError(err);
  const { service, ...rest } = ctx;
  const fields = { ...rest, err, ...(c.hint ? { hint: c.hint } : {}) };
  log[c.level](fields, `${service} ${c.msg}`);
}
