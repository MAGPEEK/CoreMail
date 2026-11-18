/**
 * The mailbox endpoint /mapi/emsmdb (MS-OXCMAPIHTTP 2.2.4, 3.2.5):
 *  Connect          → new session context (cookies MapiContext + MapiSequence)
 *  Execute          → ROP buffer through the ROP engine
 *  Disconnect       → session ends, cookies cleared
 *  NotificationWait → long poll (see notification-wait.ts)
 *  PING             → refreshes the session's idle timer
 *
 * Every request is authenticated (Basic, see http/auth.ts) and must match the
 * session's authentication context (else 10 "Context Not Found"). Execute and
 * Disconnect follow the one-request-at-a-time rule: the sequence cookie is
 * checked and rotated per request, a concurrent or replayed request gets
 * 15 "Invalid Sequence". NotificationWait and PING run beside them.
 */
import type { Request, RequestHandler, Response } from 'express';
import { createLogger, PROTO_VERIFIED_HEADER, type FixedWindowLimiter } from '@coremail/core';
import { clientIpFromRequest, directoryIdFromLegacyDn, LEGACY_DN_PREFIX } from '@coremail/storage';
import {
  clearCookie, CONTEXT_COOKIE, isCookieValue, readMapiHeaders, ResponseCode, SEQUENCE_COOKIE, setCookie,
  validateRequest, type Endpoint, type MapiRequestHeaders,
} from '../http/envelope.js';
import { respondFailure, respondStreaming, type WorkResult } from '../http/responder.js';
import { BASIC_CHALLENGE, type AuthOutcome, type TransportInfo } from '../http/auth.js';
import { WireFormatError } from '../wire/reader.js';
import { MAX_EXTENDED_PAYLOAD, readExtendedBuffer, RPC_HEADER_EXT_SIZE, writeExtendedBuffer } from '../wire/extended-buffer.js';
import { Ec, RopError } from '../rop/codes.js';
import { executeRopBuffer, type RopRegistry } from '../rop/engine.js';
import {
  buildConnectResponse, buildDisconnectResponse, buildExecuteResponse, buildNotificationWaitResponse,
  parseConnectRequest, parseDisconnectRequest, parseExecuteRequest, parseNotificationWaitRequest,
} from './bodies.js';
import type { NotificationSource } from './notification-wait.js';
import type { SessionRegistry } from '../session/registry.js';
import type { MapiSession, SessionAuth } from '../session/session.js';
import type { MailStore } from '../store/types.js';

const log = createLogger('mapi:emsmdb');

export interface EndpointConfig {
  pendingMs: number;
  idleMs: number;
}

export interface EmsmdbDeps {
  sessions: SessionRegistry;
  store: MailStore;
  rops: RopRegistry;
  notifications: NotificationSource;
  authenticate: (header: string | undefined, transport: TransportInfo) => Promise<AuthOutcome>;
  /** Requests per authenticated account (the gateway's per-IP limit skips /mapi). */
  limiter: FixedWindowLimiter;
  config: EndpointConfig;
}

/** Connect answer values (MS-OXCRPC 3.1.4.1 pcmsPollsMax / pcRetry / pcmsRetryDelay). */
const POLLS_MAX_MS = 60_000;
const RETRY_COUNT = 6;
const RETRY_DELAY_MS = 10_000;
/** szDNPrefix: the organisation part of the legacy DNs. */
const DN_PREFIX = LEGACY_DN_PREFIX.replace(/\/cn=$/i, '');

export function transportOf(req: Request): TransportInfo {
  return {
    ip: clientIpFromRequest(req.socket?.remoteAddress, req.headers['x-forwarded-for']),
    plainHttp: req.get(PROTO_VERIFIED_HEADER) === '1' && (req.get('x-forwarded-proto') ?? '').toLowerCase() === 'http',
  };
}

function secureCookies(req: Request): boolean {
  return (req.get('x-forwarded-proto') ?? 'https').toLowerCase() !== 'http';
}

function bodyOf(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

/** Answers a refused authentication (401 asks for credentials, the others never do). */
export function refuseAuth(res: Response, h: MapiRequestHeaders, outcome: Extract<AuthOutcome, { ok: false }>): void {
  const extra: Record<string, string> = {};
  if (outcome.status === 401) extra['WWW-Authenticate'] = BASIC_CHALLENGE;
  if (outcome.retryAfterSec !== undefined) extra['Retry-After'] = String(outcome.retryAfterSec);
  const code = outcome.status === 401 ? ResponseCode.AnonymousNotAllowed : ResponseCode.NoPrivilege;
  respondFailure(res, h, code, outcome.reason, outcome.status, extra);
}

/**
 * Validation, authentication and the per-account request limit, shared by both
 * endpoints; null when the request was answered. Over the limit: HTTP 429 with
 * Retry-After (X-ResponseCode 1) — the client retries later, the session stays.
 */
export async function admit(
  endpoint: Endpoint, req: Request, res: Response,
  deps: Pick<EmsmdbDeps, 'authenticate' | 'limiter'>,
  onForbidden: (h: MapiRequestHeaders, userId: string) => Promise<void> = async () => undefined,
): Promise<{ h: MapiRequestHeaders; auth: Extract<AuthOutcome, { ok: true }> } | null> {
  const h = readMapiHeaders((n) => req.get(n));
  const bad = validateRequest(endpoint, req.method, req.get('content-type'), h);
  if (bad !== null) { respondFailure(res, h, bad, 'invalid request'); return null; }
  const auth = await deps.authenticate(req.get('authorization'), transportOf(req));
  if (!auth.ok) {
    if (auth.status === 403 && auth.userId) await onForbidden(h, auth.userId);
    refuseAuth(res, h, auth);
    return null;
  }
  const rate = await deps.limiter.hit(auth.auth.user.userId);
  if (!rate.allowed) {
    if (rate.count === rate.limit + 1) log.warn({ userId: auth.auth.user.userId, limit: rate.limit }, 'MAPI request limit reached');
    respondFailure(res, h, ResponseCode.UnknownFailure, 'too many requests', 429, { 'Retry-After': String(rate.retryAfterSec) });
    return null;
  }
  return { h, auth };
}

function sameContext(session: MapiSession, auth: SessionAuth): boolean {
  return session.user.userId === auth.user.userId && session.auth.authKey === auth.authKey;
}

export function emsmdbHandler(deps: EmsmdbDeps): RequestHandler {
  const stream = (res: Response, h: MapiRequestHeaders, setCookies: string[], work: () => Promise<WorkResult>): Promise<void> =>
    respondStreaming(res, h, { pendingMs: deps.config.pendingMs, expirationMs: deps.config.idleMs, setCookies }, work);

  async function sessionFor(req: Request, res: Response, h: MapiRequestHeaders, auth: SessionAuth): Promise<MapiSession | null> {
    const cookie = h.cookies[CONTEXT_COOKIE];
    if (cookie === undefined) { respondFailure(res, h, ResponseCode.MissingCookie, 'session cookie missing'); return null; }
    if (!isCookieValue(cookie)) { respondFailure(res, h, ResponseCode.InvalidContextCookie, 'invalid session cookie'); return null; }
    const session = await deps.sessions.lookup(cookie);
    if (!session || !sameContext(session, auth)) {
      const secure = secureCookies(req);
      res.setHeader('Set-Cookie', [clearCookie(CONTEXT_COOKIE, secure), clearCookie(SEQUENCE_COOKIE, secure)]);
      respondFailure(res, h, ResponseCode.ContextNotFound, 'session not found');
      return null;
    }
    return session;
  }

  async function connect(req: Request, res: Response, h: MapiRequestHeaders, auth: Extract<AuthOutcome, { ok: true }>): Promise<void> {
    let connectReq;
    try { connectReq = parseConnectRequest(bodyOf(req)); } catch {
      respondFailure(res, h, ResponseCode.InvalidRequestBody, 'invalid Connect body'); return;
    }
    const user = auth.auth.user;
    const dnUser = connectReq.userDn ? directoryIdFromLegacyDn(connectReq.userDn) : user.userId;
    if (dnUser !== user.userId) {
      log.warn({ userId: user.userId }, 'Connect for a DN that is not the authenticated account');
      await stream(res, h, [], async () => ({
        responseCode: ResponseCode.Success,
        body: buildConnectResponse({ errorCode: Ec.LoginPerm, pollsMax: 0, retryCount: 0, retryDelay: 0, dnPrefix: '', displayName: '' }),
      }));
      return;
    }
    const previous = h.cookies[CONTEXT_COOKIE];
    if (isCookieValue(previous)) {
      const old = await deps.sessions.lookup(previous);
      if (old && old.user.userId === user.userId) await deps.sessions.end(old);
    }
    const created = await deps.sessions.create(auth.auth, auth.startedAt);
    const secure = secureCookies(req);
    log.info({ userId: user.userId, client: h.clientApplication.slice(0, 80) }, 'MAPI session created');
    await stream(res, h, [setCookie(CONTEXT_COOKIE, created.context, secure), setCookie(SEQUENCE_COOKIE, created.sequence, secure)], async () => ({
      responseCode: ResponseCode.Success,
      body: buildConnectResponse({
        errorCode: Ec.Success, pollsMax: POLLS_MAX_MS, retryCount: RETRY_COUNT, retryDelay: RETRY_DELAY_MS,
        dnPrefix: DN_PREFIX, displayName: user.displayName || user.email,
      }),
    }));
  }

  /** Sequence check + rotation; null when the request was answered. */
  function nextSequence(req: Request, res: Response, h: MapiRequestHeaders, session: MapiSession): string | null {
    if (session.busy) { respondFailure(res, h, ResponseCode.InvalidSequence, 'another request is in progress'); return null; }
    const presented = h.cookies[SEQUENCE_COOKIE];
    if (presented === undefined) { respondFailure(res, h, ResponseCode.MissingCookie, 'sequence cookie missing'); return null; }
    const next = session.advanceSequence(presented);
    if (!next) { respondFailure(res, h, ResponseCode.InvalidSequence, 'request out of sequence'); return null; }
    return setCookie(SEQUENCE_COOKIE, next, secureCookies(req));
  }

  async function execute(req: Request, res: Response, h: MapiRequestHeaders, session: MapiSession): Promise<void> {
    let exec;
    try { exec = parseExecuteRequest(bodyOf(req)); } catch {
      respondFailure(res, h, ResponseCode.InvalidRequestBody, 'invalid Execute body'); return;
    }
    const sequenceCookie = nextSequence(req, res, h, session);
    if (!sequenceCookie) return;
    session.busy = true;
    try {
      await stream(res, h, [sequenceCookie], async () => ({ responseCode: ResponseCode.Success, body: await runRops(session, exec.ropBuffer, exec.maxRopOut) }));
    } finally {
      session.busy = false;
    }
  }

  async function runRops(session: MapiSession, ropBuffer: Buffer, maxRopOut: number): Promise<Buffer> {
    if (maxRopOut < RPC_HEADER_EXT_SIZE + 2) return buildExecuteResponse(Ec.InvalidParameter, Buffer.alloc(0));
    const maxOut = Math.min(maxRopOut - RPC_HEADER_EXT_SIZE, MAX_EXTENDED_PAYLOAD);
    try {
      const input = readExtendedBuffer(ropBuffer);
      const output = await executeRopBuffer(input, { session, store: deps.store, registry: deps.rops }, maxOut);
      return buildExecuteResponse(Ec.Success, writeExtendedBuffer(output));
    } catch (err) {
      if (err instanceof WireFormatError) {
        log.warn({ userId: session.user.userId, err: err.message }, 'Execute: malformed ROP buffer');
        return buildExecuteResponse(Ec.RpcFormat, Buffer.alloc(0));
      }
      if (err instanceof RopError) return buildExecuteResponse(err.code, Buffer.alloc(0));
      log.error({ err, userId: session.user.userId }, 'Execute failed');
      return buildExecuteResponse(Ec.GeneralFailure, Buffer.alloc(0));
    }
  }

  async function disconnect(req: Request, res: Response, h: MapiRequestHeaders, session: MapiSession): Promise<void> {
    try { parseDisconnectRequest(bodyOf(req)); } catch {
      respondFailure(res, h, ResponseCode.InvalidRequestBody, 'invalid Disconnect body'); return;
    }
    if (!nextSequence(req, res, h, session)) return;
    await deps.sessions.end(session);
    const secure = secureCookies(req);
    await stream(res, h, [clearCookie(CONTEXT_COOKIE, secure), clearCookie(SEQUENCE_COOKIE, secure)], async () => ({
      responseCode: ResponseCode.Success, body: buildDisconnectResponse(),
    }));
  }

  async function notificationWait(req: Request, res: Response, h: MapiRequestHeaders, session: MapiSession): Promise<void> {
    try { parseNotificationWaitRequest(bodyOf(req)); } catch {
      respondFailure(res, h, ResponseCode.InvalidRequestBody, 'invalid NotificationWait body'); return;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    await stream(res, h, [], async () => {
      const pending = await deps.notifications.wait(session, abort.signal);
      session.lastUsed = Date.now();
      return { responseCode: ResponseCode.Success, body: buildNotificationWaitResponse(pending) };
    });
  }

  /** A refused account (MAPI switched off) loses the session its cookie names. */
  async function dropSession(h: MapiRequestHeaders, userId: string): Promise<void> {
    const cookie = h.cookies[CONTEXT_COOKIE];
    if (!isCookieValue(cookie)) return;
    const session = await deps.sessions.lookup(cookie);
    if (session && session.user.userId === userId) await deps.sessions.end(session);
  }

  return async (req, res) => {
    const admitted = await admit('emsmdb', req, res, deps, dropSession);
    if (!admitted) return;
    const { h, auth } = admitted;
    if (h.requestType === 'Connect') { await connect(req, res, h, auth); return; }
    if (h.requestType === 'PING') {
      const cookie = h.cookies[CONTEXT_COOKIE];
      if (isCookieValue(cookie)) await deps.sessions.lookup(cookie);
      await stream(res, h, [], async () => ({ responseCode: ResponseCode.Success, body: Buffer.alloc(0) }));
      return;
    }
    const session = await sessionFor(req, res, h, auth.auth);
    if (!session) return;
    if (h.requestType === 'Execute') await execute(req, res, h, session);
    else if (h.requestType === 'Disconnect') await disconnect(req, res, h, session);
    else await notificationWait(req, res, h, session);
  };
}
