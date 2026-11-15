/**
 * v8.1: resource limits of the IMAP server (pre-auth DoS hardening).
 *
 *   IMAP_MAX_CONNS_PER_IP   (20)    concurrent connections per client IP
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

let maxSort = envLimit('IMAP_SORT_MAX_MESSAGES', 100_000);
/** Largest mailbox (messages in the view) SORT/THREAD work on; <= 0: unlimited. */
export function maxSortMessages(): number { return maxSort > 0 ? maxSort : Number.MAX_SAFE_INTEGER; }
/** Overrides IMAP_SORT_MAX_MESSAGES (tests). */
export function setMaxSortMessages(n: number): void { maxSort = n; }

const exempt = createExemptIpMatcher(process.env['MAIL_CONN_EXEMPT_CIDRS']);
export const invalidExemptEntries = exempt.invalid;

export const imapConnectionLimiter = new ConnectionLimiter({
  maxPerIp: envLimit('IMAP_MAX_CONNS_PER_IP', 20),
  maxTotal: envLimit('IMAP_MAX_CONNS', 2000),
  isExempt: exempt.isExempt,
});
