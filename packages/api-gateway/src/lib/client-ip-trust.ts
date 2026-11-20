/**
 * 10.5 review: which client IPs may feed the escalating attack protection
 * (automatic block list entries, "known network" learning of the lockout) —
 * docs/api-gateway-security.md "TRUST_PROXY and the attack protection".
 *
 * `req.ip` honours TRUST_PROXY. It is trustworthy for escalation when it is the
 * socket peer itself, or when it came from a proxy of an EXPLICIT allow-list
 * (TRUST_PROXY="172.18.0.5", "10.0.0.0/8", "loopback" …). With a hop count
 * ("1") or `true` any client that reaches port 3000 directly — e.g. through
 * the Docker userland proxy — can choose the address in X-Forwarded-For: such
 * an address is still counted and locked, but never escalated.
 *
 * The verdict travels as IP_VERIFIED_HEADER ("1"): set on the gateway's own
 * requests (ipVerifiedMark — read by clientInfoOf for the web/API login) and
 * on every proxied request (applyUpstreamHeaders — ActiveSync, DAV, JMAP, MAPI,
 * Autodiscover, auth-service). A client-sent value is always removed first.
 */
import os from 'node:os';
import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import { IP_VERIFIED_HEADER, parseTrustProxy } from '@coremail/core';

/** IPv4-mapped IPv6 → IPv4, zone stripped (like storage normalizeIp; this module stays free of @coremail/storage). */
function normalizeIp(raw: string | null | undefined): string {
  if (!raw) return '';
  let v = raw.trim();
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  return /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(v) ? v.slice(7) : v;
}

export type TrustFn = (addr: string, i: number) => boolean;

/** How TRUST_PROXY names the proxies: not at all, by address list, by hop count, or everything. */
export type TrustProxyKind = 'none' | 'list' | 'hops' | 'all';

/** Pure: the kind of a TRUST_PROXY value (invalid values → 'none', like a failed parse would never start). */
export function trustProxyKind(raw: string | undefined): TrustProxyKind {
  let v: ReturnType<typeof parseTrustProxy>;
  try { v = parseTrustProxy(raw); } catch { return 'none'; }
  if (v === false) return 'none';
  if (v === true) return 'all';
  if (typeof v === 'number') return v > 0 ? 'hops' : 'none';
  return 'list';
}

/**
 * Pure: is the client IP of this request trustworthy for escalation?
 * `clientIp` = the address the gateway derived (req.ip / upstreamClientIp).
 */
export function clientIpVerified(clientIp: string | undefined, socketPeer: string | undefined, kind: TrustProxyKind): boolean {
  const ip = normalizeIp(clientIp);
  const peer = normalizeIp(socketPeer);
  if (!ip || !peer || ip === peer) return true;
  return kind === 'list';
}

/**
 * Express middleware (first in the stack): drops a client-sent
 * IP_VERIFIED_HEADER and sets it ("1") when req.ip is verified.
 */
export function ipVerifiedMark(kind: TrustProxyKind): RequestHandler {
  return (req, _res, next) => {
    delete req.headers[IP_VERIFIED_HEADER];
    if (clientIpVerified(req.ip, req.socket?.remoteAddress, kind)) req.headers[IP_VERIFIED_HEADER] = '1';
    next();
  };
}

/** Raw request (WebSocket upgrade) variant of clientIpVerified. */
export function upgradeIpVerified(req: IncomingMessage, clientIp: string, kind: TrustProxyKind): boolean {
  return clientIpVerified(clientIp, req.socket?.remoteAddress, kind);
}

/**
 * The addresses a Docker bridge gateway typically has inside this container:
 * the first host address of every non-internal IPv4 interface network (the
 * userland proxy of a published port connects from there) plus the default
 * bridge gateway 172.17.0.1.
 */
export function dockerGatewayCandidates(interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const out = new Set<string>(['172.17.0.1']);
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4' || !i.cidr) continue;
      const prefix = Number(i.cidr.split('/')[1]);
      if (!Number.isInteger(prefix) || prefix < 8 || prefix > 30) continue;
      const n = i.address.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      const first = ((n & mask) >>> 0) + 1;
      out.add([24, 16, 8, 0].map((s) => (first >>> s) & 0xff).join('.'));
    }
  }
  return [...out];
}

/**
 * Pure: startup warnings about a TRUST_PROXY value that lets clients choose
 * their address. `trusts` = Express's compiled trust function.
 */
export function trustProxyWarnings(raw: string | undefined, trusts: TrustFn, gatewayCandidates: readonly string[]): string[] {
  const kind = trustProxyKind(raw);
  const out: string[] = [];
  if (kind === 'all' || kind === 'hops') {
    out.push(
      `TRUST_PROXY=${String(raw).trim()} trusts ${kind === 'all' ? 'every hop' : 'a hop count'}: if port 3000 (HTTP_PORT) is published directly `
      + '(not only reachable by the reverse proxy), every client can choose its address in X-Forwarded-For — rate limits and lockouts '
      + 'then see forged addresses. Addresses from such headers are never escalated (no automatic block list entry, no known network). '
      + 'Set TRUST_PROXY to the reverse proxy\'s own address or CIDR instead (docs/api-gateway-security.md).',
    );
  }
  if (kind === 'list') {
    const hit = gatewayCandidates.filter((ip) => { try { return trusts(ip, 0); } catch { return false; } });
    if (hit.length > 0) {
      out.push(
        `TRUST_PROXY covers ${hit.join(', ')} — the Docker bridge gateway. With a published port and the Docker userland proxy every `
        + 'client connects from this address, so anyone can then set X-Forwarded-For. Trust only the reverse proxy container\'s own '
        + 'address (or publish port 3000 on the reverse proxy network only) — docs/api-gateway-security.md.',
      );
    }
  }
  return out;
}
