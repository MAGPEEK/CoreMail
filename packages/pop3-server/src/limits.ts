/**
 * v8.1: connection limits of the POP3 server (pre-auth DoS hardening).
 *
 *   POP3_MAX_CONNS_PER_IP (50)    concurrent connections per client IP (NAT offices:
 *                                 see docs/mail-protocol-limits.md)
 *   POP3_MAX_CONNS        (1000)  concurrent connections per process
 *   MAIL_CONN_EXEMPT_CIDRS        IPs/CIDRs without the per-IP cap (loopback always)
 *
 * A value <= 0 disables a limit. One session per user is already enforced by
 * the maildrop lock (RFC 1939 §4, -ERR [IN-USE]).
 */
import type net from 'node:net';
import { ConnectionLimiter, envLimit, createLogger } from '@coremail/core';
import { createExemptIpMatcher } from '@coremail/storage';

const log = createLogger('pop3-limits');

const exempt = createExemptIpMatcher(process.env['MAIL_CONN_EXEMPT_CIDRS']);
export const invalidExemptEntries = exempt.invalid;

/** Default of POP3_MAX_CONNS_PER_IP — room for an office behind one NAT address. */
export const DEFAULT_POP3_MAX_CONNS_PER_IP = 50;

export const pop3ConnectionLimiter = new ConnectionLimiter({
  maxPerIp: envLimit('POP3_MAX_CONNS_PER_IP', DEFAULT_POP3_MAX_CONNS_PER_IP),
  maxTotal: envLimit('POP3_MAX_CONNS', 1000),
  isExempt: exempt.isExempt,
});

/**
 * Checks a raw TCP connection against the limiter. Over the limit the
 * connection is answered with -ERR [SYS/TEMP] (plaintext listener) or simply
 * dropped (implicit TLS, before the handshake). The slot is released when the
 * TCP connection closes.
 */
export function admitConnection(raw: net.Socket, implicitTls: boolean, limiter: ConnectionLimiter = pop3ConnectionLimiter): boolean {
  const result = limiter.acquire(raw.remoteAddress);
  if (!result.ok) {
    log.warn({ ip: raw.remoteAddress, reason: result.reason, limit: result.limit }, 'POP3 connection rejected — connection limit reached');
    if (implicitTls) raw.destroy();
    else raw.end('-ERR [SYS/TEMP] too many connections, try again later\r\n');
    setTimeout(() => raw.destroy(), 2000).unref();
    return false;
  }
  raw.once('close', result.release);
  return true;
}
