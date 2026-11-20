/**
 * 10.5: connect-time checks of the mail protocols (SMTP, IMAP, POP3) and the
 * HTTP gateway — docs/attack-protection.md.
 *
 *   isBlocked(ip)  synchronous: the permanent block list (ip-access.ts); loopback,
 *                  MAIL_AUTH_EXEMPT_CIDRS and exceptions are never blocked
 *   lockedFor(ip)  the shared lockout's IP lock (Redis TTL, s); 0 when the IP is
 *                  exempt, Redis is down (fail open) or the guard is not started
 *   refused(…)     records the refusal for the attack dashboard (sampled)
 *
 * startAttackProtection(service) switches the guard on in a service process
 * (rule cache + reload subscriber). Without it (unit tests, tools) the guard
 * never touches Redis or the database: nothing is blocked or locked.
 */
import { ipAccessVerdict, startIpAccessSubscriber } from './ip-access.js';
import { mailAuthIpLockedFor } from './mail-auth.js';
import { recordSecurityEvent } from './security-events.js';
import { startAttackProtectionSubscriber } from './attack-protection.js';

export interface ConnectGuard {
  isBlocked(ip: string | null | undefined): boolean;
  lockedFor(ip: string | null | undefined): Promise<number>;
  refused(ip: string | null | undefined, protocol: string, reason: 'blocked' | 'locked', detail?: Record<string, unknown>): void;
}

let active = false;

/** True once startAttackProtection() ran in this process. */
export function attackProtectionActive(): boolean {
  return active;
}

/**
 * Switches the connect guard on: loads the block list / exceptions, refreshes
 * them every 60 s and on every change (CHANNEL_SETTINGS_RELOAD), and keeps the
 * attack-protection settings cache in step. Idempotent.
 */
export function startAttackProtection(): void {
  active = true;
  startIpAccessSubscriber();
  startAttackProtectionSubscriber();
}

export const connectGuard: ConnectGuard = {
  isBlocked(ip) {
    return ipAccessVerdict(ip) === 'block';
  },
  async lockedFor(ip) {
    if (!active || !ip) return 0;
    if (ipAccessVerdict(ip) === 'allow') return 0;
    try {
      return await mailAuthIpLockedFor(ip);
    } catch {
      return 0;
    }
  },
  refused(ip, protocol, reason, detail) {
    recordSecurityEvent({
      type: reason === 'blocked' ? 'IP_BLOCKLIST' : 'AUTH_LOCKED',
      ip, protocol, detail: { stage: 'connect', ...(detail ?? {}) },
    });
  },
};

/** The guard that always admits (tests, tools). */
export const OPEN_CONNECT_GUARD: ConnectGuard = {
  isBlocked: () => false,
  lockedFor: async () => 0,
  refused: () => undefined,
};
