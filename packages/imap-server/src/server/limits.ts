/**
 * v8.1: resource limits of the IMAP server (pre-auth DoS hardening).
 *
 *   IMAP_MAX_CONNS_PER_IP   (50)    concurrent connections per client IP (NAT offices:
 *                                   see docs/mail-protocol-limits.md)
 *   IMAP_MAX_CONNS          (2000)  concurrent connections per process
 *   IMAP_MAX_CONNS_PER_USER (20)    concurrent authenticated sessions per user (NO [LIMIT])
 *   MAIL_CONN_EXEMPT_CIDRS          IPs/CIDRs without the per-IP cap (loopback always)
 *
 * Fixed: before authentication literals and lines are capped at 8 KiB, an idle
 * unauthenticated connection is closed after 60 s and a STARTTLS handshake
 * must finish within 30 s. After login the RFC 9051 §5.4 autologout timer
 * (30 min) applies. A value <= 0 disables a connection limit.
 */
import { ConnectionLimiter, envLimit } from '@coremail/core';
import { createExemptIpMatcher } from '@coremail/storage';

/** Largest literal (all literals of one command) before authentication. */
export const PRE_AUTH_MAX_LITERAL = 8 * 1024;
/** Longest command line before authentication. */
export const PRE_AUTH_MAX_LINE = 8 * 1024;
/** Idle timeout of a connection that has not authenticated yet. */
export const PRE_AUTH_IDLE_MS = 60_000;
/** RFC 9051 §5.4: inactivity autologout timer of at least 30 minutes. */
export const POST_AUTH_IDLE_MS = 1_800_000;
/** A STARTTLS handshake must complete within this time. */
export const TLS_HANDSHAKE_MS = 30_000;

let maxPerUser = envLimit('IMAP_MAX_CONNS_PER_USER', 20);
/** Concurrent authenticated IMAP sessions per user (<= 0: unlimited). */
export function maxConnsPerUser(): number { return maxPerUser; }
/** Overrides IMAP_MAX_CONNS_PER_USER (tests). */
export function setMaxConnsPerUser(n: number): void { maxPerUser = n; }

const exempt = createExemptIpMatcher(process.env['MAIL_CONN_EXEMPT_CIDRS']);
export const invalidExemptEntries = exempt.invalid;

/** Default of IMAP_MAX_CONNS_PER_IP — room for an office behind one NAT address. */
export const DEFAULT_IMAP_MAX_CONNS_PER_IP = 50;

export const imapConnectionLimiter = new ConnectionLimiter({
  maxPerIp: envLimit('IMAP_MAX_CONNS_PER_IP', DEFAULT_IMAP_MAX_CONNS_PER_IP),
  maxTotal: envLimit('IMAP_MAX_CONNS', 2000),
  isExempt: exempt.isExempt,
});
