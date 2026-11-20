/**
 * 10.5 attack protection: the permanent IP block list (BCP → Schutz →
 * Angriffsschutz) for every HTTP surface of the gateway — webmail, BCP, REST,
 * /auth, ActiveSync, DAV, JMAP, MAPI, Autodiscover, MCP. Mounted right after
 * the request id, before any other work (docs/attack-protection.md).
 *
 * The client IP is `req.ip` (TRUST_PROXY aware, like the rate limits and the
 * audit). Loopback, MAIL_AUTH_EXEMPT_CIDRS and the exceptions are never blocked
 * (ip-access.ts). WebSocket upgrades (/jmap/ws) use `upgradeBlocked()`.
 */
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import { connectGuard, type ConnectGuard } from '@coremail/storage';

/** The protocol a request path belongs to (security events per protocol). */
export function httpProtocolOf(path: string): string {
  const p = path.toLowerCase();
  if (p.startsWith('/microsoft-server-activesync')) return 'activesync';
  if (p.startsWith('/dav') || p.startsWith('/.well-known/caldav') || p.startsWith('/.well-known/carddav')) return 'caldav';
  if (p.startsWith('/jmap') || p.startsWith('/.well-known/jmap')) return 'jmap';
  if (p.startsWith('/mapi')) return 'mapi';
  if (p.startsWith('/autodiscover') || p.startsWith('/.well-known/autoconfig') || p.startsWith('/mail/config-v1.1.xml')) return 'autodiscover';
  if (p.startsWith('/mcp')) return 'mcp';
  if (p.startsWith('/auth') || p.startsWith('/api/')) return 'web';
  return 'http';
}

export function createIpBlocklistGuard(guard: Pick<ConnectGuard, 'isBlocked' | 'refused'> = connectGuard): RequestHandler {
  return (req, res, next) => {
    const ip = req.ip ?? req.socket?.remoteAddress;
    if (!guard.isBlocked(ip)) { next(); return; }
    guard.refused(ip, httpProtocolOf(req.path), 'blocked', { path: req.path.slice(0, 120) });
    res.setHeader('Connection', 'close');
    res.status(403).json({ error: 'Access denied', code: 'IP_BLOCKED' });
  };
}

/** WebSocket upgrades bypass Express: true when the peer is on the block list. */
export function upgradeBlocked(req: IncomingMessage, guard: Pick<ConnectGuard, 'isBlocked' | 'refused'> = connectGuard): boolean {
  const ip = req.socket?.remoteAddress;
  if (!guard.isBlocked(ip)) return false;
  guard.refused(ip, httpProtocolOf(req.url ?? ''), 'blocked', { upgrade: true });
  return true;
}
