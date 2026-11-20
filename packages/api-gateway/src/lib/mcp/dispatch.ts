/**
 * Admin MCP interface (10.3) — runs an admin REST route in-process as the
 * token's admin.
 *
 * Every MCP tool is a call of the existing admin API (`/api/v1/admin/*`
 * routers, routes/admin/index.ts) — there is no second implementation and no
 * privileged path: the request goes through the very same guards (requireArea
 * / requireRole with the CURRENT role from the database, the management scope,
 * forced admin 2FA), validation, scope filters, redaction ("(andere Domain)")
 * and storage helpers (message store, auth helpers, audit calls) as a BCP
 * request. The only difference: the admin identity comes from the verified MCP
 * token (set as `req.apiUser`, exactly what requireAuth sets for a JWT) instead
 * of an Authorization header. The internal app is never bound to a socket, so
 * nothing outside this process can reach it.
 */
import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { createLogger, errorMiddleware } from '@coremail/core';
import { ADMIN_PREFIX, mountAdminRoutes } from '../../routes/admin/index.js';
import type { ApiUser } from '../../middleware/auth.js';

const log = createLogger('mcp:dispatch');

export interface DispatchIdentity {
  userId: string;
  email: string;
  role: string;
  domainId: string;
  /** The token came from an MFA-verified session (forced admin 2FA). */
  mfaVerified: boolean;
}

export interface DispatchRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path below /api/v1/admin, e.g. `/mailboxes/abc`. Segments must be encoded by the caller. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface DispatchContext {
  /** Client IP of the MCP request (audit entries of the routes). */
  ip: string;
  userAgent: string;
}

export interface DispatchResponse {
  status: number;
  body: unknown;
}

/** Upper bound of one internal call (a route that never answers must not hang the tool). */
const DISPATCH_TIMEOUT_MS = 30_000;

let internalApp: express.Express | null = null;

function app(): express.Express {
  if (internalApp) return internalApp;
  const a = express();
  a.disable('x-powered-by');
  a.set('etag', false);
  a.set('trust proxy', false); // req.ip = the MCP client's IP set on the fake socket
  mountAdminRoutes(a);
  a.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
  a.use(errorMiddleware(log));
  internalApp = a;
  return a;
}

/** Pure: path + query → request URL under ADMIN_PREFIX. Refuses anything but a plain admin path. */
export function dispatchUrl(path: string, query: DispatchRequest['query'] = {}): string {
  if (!/^\/[A-Za-z0-9._~%/-]*$/.test(path) || path.includes('..') || path.includes('//')) {
    throw new Error(`invalid admin path: ${path}`);
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const q = qs.toString();
  return `${ADMIN_PREFIX}${path}${q ? `?${q}` : ''}`;
}

/** Runs one admin route as `who`. Never throws for HTTP errors (status ≥ 400 is returned). */
export function dispatchAdmin(who: DispatchIdentity, req: DispatchRequest, ctx: DispatchContext): Promise<DispatchResponse> {
  const url = dispatchUrl(req.path, req.query);
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: ctx.ip, configurable: true });
  const msg = new IncomingMessage(socket);
  msg.method = req.method;
  msg.url = url;
  msg.headers = {
    host: 'mcp.internal',
    'user-agent': ctx.userAgent.slice(0, 256),
    ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  msg.push(null); // no body stream — the parsed body is set below
  const apiUser: ApiUser = {
    userId: who.userId,
    email: who.email,
    role: who.role,
    mfaVerified: who.mfaVerified,
    domainId: who.domainId,
    authStartedAt: Date.now(),
  };
  Object.assign(msg, { apiUser, body: req.body ?? {} });

  return new Promise<DispatchResponse>((resolve, reject) => {
    const res = new ServerResponse(msg);
    const chunks: Buffer[] = [];
    let done = false;
    const timer = setTimeout(() => finish(new Error(`admin route timed out: ${req.method} ${req.path}`)), DISPATCH_TIMEOUT_MS);
    timer.unref();
    const collect = (chunk: unknown, encoding?: unknown): void => {
      if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8'));
    };
    function finish(err?: Error): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy(); // never connected — releases the placeholder
      if (err) { reject(err); return; }
      const text = Buffer.concat(chunks).toString('utf8');
      const type = String(res.getHeader('content-type') ?? '');
      let body: unknown = text;
      if (text && type.includes('json')) {
        try { body = JSON.parse(text); } catch { body = text; }
      } else if (!text) {
        body = null;
      }
      resolve({ status: res.statusCode, body });
    }
    res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      collect(chunk, encoding);
      const fn = [encoding, cb].find((x) => typeof x === 'function') as (() => void) | undefined;
      fn?.();
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      collect(chunk, encoding);
      const fn = [chunk, encoding, cb].find((x) => typeof x === 'function') as (() => void) | undefined;
      finish();
      res.emit('finish');
      fn?.();
      return res;
    }) as typeof res.end;
    try {
      (app() as unknown as (rq: IncomingMessage, rs: ServerResponse) => void)(msg, res);
    } catch (err) {
      finish(err as Error);
    }
  });
}
