/**
 * Authenticated image proxy for external images in mails (8.0.x).
 *
 *   GET /api/v1/mail/image-proxy?url=<http(s) URL>   (Authorization: Bearer …)
 *
 * The CSP (img-src 'self' data: blob:) blocks external images, so "show images"
 * in the web client fetches them through this endpoint and renders a blob: URL.
 * SSRF-safe:
 *  - http/https only, no credentials, no internal host names, ports any
 *  - every resolved address must be public (core isBlockedAddress); the socket
 *    lookup re-checks at connect time (DNS rebinding)
 *  - redirects are followed manually (max. 3), every hop re-validated
 *  - only raster image types (no SVG), max. 10 MB, 10 s overall timeout
 *  - no cookies / Authorization / Referer are sent upstream; upstream
 *    Set-Cookie and other headers are never passed through
 * Response: the image with its upstream Content-Type, `X-Content-Type-Options:
 * nosniff`, `Cache-Control: private, max-age=3600`, `Content-Security-Policy:
 * default-src 'none'; sandbox`.
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import type { Request, Response } from 'express';
import { isBlockedAddress, normalizeIp, type HostResolver } from '@coremail/core';

export const IMAGE_PROXY_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'image/x-icon', 'image/vnd.microsoft.icon',
]);

export interface ImageProxyOptions {
  /** Address policy (default: core isBlockedAddress — private/loopback/metadata/… blocked). */
  isBlocked?: (ip: string) => boolean;
  resolve?: HostResolver;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Per-user rate check: false → 429. */
  allow?: (userId: string) => Promise<{ allowed: boolean; retryAfterSec: number }>;
}

export class ImageProxyError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ImageProxyError'; }
}

const defaultResolve: HostResolver = async (host) =>
  (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Syntax + literal-address check of one URL (initial request and every redirect hop). */
export function checkImageUrl(raw: string, isBlocked: (ip: string) => boolean = isBlockedAddress): URL {
  if (typeof raw !== 'string' || !raw || raw.length > 4096) throw new ImageProxyError(400, 'invalid URL');
  let u: URL;
  try { u = new URL(raw); } catch { throw new ImageProxyError(400, 'invalid URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ImageProxyError(400, 'only http and https URLs are allowed');
  if (u.username || u.password) throw new ImageProxyError(400, 'credentials in URL are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new ImageProxyError(400, 'missing host');
  if (isIP(normalizeIp(host)) !== 0) {
    if (isBlocked(host)) throw new ImageProxyError(403, 'address not allowed');
  } else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || !host.includes('.')) {
    throw new ImageProxyError(403, 'internal host names are not allowed');
  }
  return u;
}

function guardedLookup(isBlocked: (ip: string) => boolean): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) { callback(err, ''); return; }
      const list = addresses as dns.LookupAddress[];
      if (list.length === 0 || list.some((a) => isBlocked(a.address))) {
        const e: NodeJS.ErrnoException = new Error(`refusing to connect to non-public address for ${hostname}`);
        e.code = 'ESSRF';
        callback(e, '');
        return;
      }
      if (options?.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as LookupFunction;
}

interface Fetched { contentType: string; body: Buffer }

/** Fetches an image following at most `maxRedirects` re-validated redirects. */
export async function fetchProxiedImage(rawUrl: string, opts: ImageProxyOptions = {}): Promise<Fetched> {
  const isBlocked = opts.isBlocked ?? isBlockedAddress;
  const resolve = opts.resolve ?? defaultResolve;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const lookup = guardedLookup(isBlocked);

  let url = checkImageUrl(rawUrl, isBlocked);
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(normalizeIp(host)) === 0) {
      let addrs: string[];
      try { addrs = await resolve(host); } catch { throw new ImageProxyError(502, 'host does not resolve'); }
      if (addrs.length === 0) throw new ImageProxyError(502, 'host does not resolve');
      if (addrs.some((a) => isBlocked(a))) throw new ImageProxyError(403, 'host resolves to a non-public address');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ImageProxyError(504, 'upstream timeout');
    const res = await requestOnce(url, lookup, remaining);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new ImageProxyError(502, 'too many redirects');
      let next: URL;
      try { next = new URL(res.headers.location, url); } catch { throw new ImageProxyError(502, 'invalid redirect'); }
      url = checkImageUrl(next.toString(), isBlocked);
      continue;
    }
    if (status < 200 || status >= 300) { res.resume(); throw new ImageProxyError(502, `upstream status ${status}`); }
    const contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!IMAGE_PROXY_TYPES.has(contentType)) { res.resume(); throw new ImageProxyError(415, 'not an image'); }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); throw new ImageProxyError(413, 'image too large'); }
    const body = await readCapped(res, maxBytes, deadline - Date.now());
    return { contentType, body };
  }
}

function requestOnce(url: URL, lookup: LookupFunction, timeoutMs: number): Promise<http.IncomingMessage> {
  return new Promise((resolvePromise, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'GET',
      agent: false,
      lookup,
      headers: {
        'User-Agent': 'CoreMail-ImageProxy/1.0',
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
      },
    }, resolvePromise);
    const timer = setTimeout(() => req.destroy(new ImageProxyError(504, 'upstream timeout')), timeoutMs);
    req.on('response', () => clearTimeout(timer));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof ImageProxyError ? err
        : (err as NodeJS.ErrnoException).code === 'ESSRF' ? new ImageProxyError(403, 'address not allowed')
          : new ImageProxyError(502, 'upstream unreachable'));
    });
    req.end();
  });
}

function readCapped(res: http.IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => { res.destroy(); reject(new ImageProxyError(504, 'upstream timeout')); }, Math.max(1, timeoutMs));
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { clearTimeout(timer); res.destroy(); reject(new ImageProxyError(413, 'image too large')); return; }
      chunks.push(c);
    });
    res.on('end', () => { clearTimeout(timer); resolvePromise(Buffer.concat(chunks)); });
    res.on('error', () => { clearTimeout(timer); reject(new ImageProxyError(502, 'upstream read failed')); });
  });
}

export function createImageProxyHandler(opts: ImageProxyOptions = {}) {
  return async function imageProxyHandler(req: Request, res: Response): Promise<void> {
    const userId = req.apiUser?.userId;
    if (!userId) { res.status(401).json({ error: 'Authorization required' }); return; }
    if (opts.allow) {
      const d = await opts.allow(userId);
      if (!d.allowed) {
        res.setHeader('Retry-After', String(d.retryAfterSec));
        res.status(429).json({ error: 'Too many requests', code: 'RATE_LIMITED' });
        return;
      }
    }
    const raw = typeof req.query['url'] === 'string' ? req.query['url'] : '';
    try {
      const img = await fetchProxiedImage(raw, opts);
      res.setHeader('Content-Type', img.contentType);
      res.setHeader('Content-Length', String(img.body.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.status(200).end(img.body);
    } catch (err) {
      const status = err instanceof ImageProxyError ? err.status : 502;
      const message = err instanceof ImageProxyError ? err.message : 'upstream error';
      res.status(status).json({ error: message });
    }
  };
}
