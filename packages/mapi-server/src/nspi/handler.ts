/**
 * The address book endpoint /mapi/nspi (MS-OXCMAPIHTTP 2.2.5, 3.2.5):
 *  Bind    → new session context (cookies NspiContext + NspiSequence, path /mapi/nspi)
 *  Unbind  → the session ends, cookies cleared
 *  PING    → refreshes the session's idle timer
 *  others  → the address book operations (operations.ts) over the session's
 *            address book snapshot (reloaded after BOOK_TTL_MS)
 *
 * Same rules as the mailbox endpoint: every request is authenticated (Basic,
 * protocol switch `mapi`), the session is bound to its credentials (else 10
 * "Context Not Found") and handles one request at a time (sequence cookie
 * rotated per request, else 15 "Invalid Sequence"). A body that does not
 * follow the request type's format ends with X-ResponseCode 12.
 */
import type { Request, RequestHandler, Response } from 'express';
import { createLogger } from '@coremail/core';
import type { MapiEndpoints } from '@coremail/storage';
import {
  clearCookie, isCookieValue, NSPI_CONTEXT_COOKIE, NSPI_COOKIE_PATH, NSPI_SEQUENCE_COOKIE, ResponseCode, setCookie,
  type MapiRequestHeaders,
} from '../http/envelope.js';
import { respondFailure, respondStreaming, type WorkResult } from '../http/responder.js';
import { admit, dropNamedSession, sameContext, type EmsmdbDeps } from '../emsmdb/handler.js';
import { WireFormatError } from '../wire/reader.js';
import { AddressBook } from './address-book.js';
import { buildFailureBody } from './bodies.js';
import { NSPI_OPERATIONS, type NspiContext } from './operations.js';
import type { MapiSession } from '../session/session.js';
import type { DirectoryStore } from '../store/types.js';

const log = createLogger('mapi:nspi');

/** How long a session works with one address book snapshot. */
export const BOOK_TTL_MS = 60_000;

export interface NspiDeps extends Pick<EmsmdbDeps, 'authenticate' | 'limiter' | 'config' | 'sessions'> {
  directory: DirectoryStore;
  /** Public MAPI endpoint URLs (GetMailboxUrl / GetAddressBookUrl). */
  endpoints: () => Promise<MapiEndpoints | null>;
  now?: () => number;
}

interface Snapshot { book: AddressBook; loadedAt: number }

function secure(req: Request): boolean {
  return (req.get('x-forwarded-proto') ?? 'https').toLowerCase() !== 'http';
}

function bodyOf(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

function cookie(name: string, value: string, req: Request): string {
  return setCookie(name, value, secure(req), NSPI_COOKIE_PATH);
}

function clearCookies(req: Request): string[] {
  return [clearCookie(NSPI_CONTEXT_COOKIE, secure(req), NSPI_COOKIE_PATH), clearCookie(NSPI_SEQUENCE_COOKIE, secure(req), NSPI_COOKIE_PATH)];
}

export function nspiHandler(deps: NspiDeps): RequestHandler {
  const now = deps.now ?? (() => Date.now());
  const books = new WeakMap<MapiSession, Snapshot>();

  const stream = (res: Response, h: MapiRequestHeaders, setCookies: string[], work: () => Promise<WorkResult>): Promise<void> =>
    respondStreaming(res, h, { pendingMs: deps.config.pendingMs, expirationMs: deps.config.idleMs, setCookies }, work);

  function contextFor(session: MapiSession | null): NspiContext {
    return {
      book: async () => {
        if (!session) throw new Error('address book without a session');
        const hit = books.get(session);
        if (hit && now() - hit.loadedAt < BOOK_TTL_MS) return hit.book;
        const book = new AddressBook(await deps.directory.listDirectory(session.user));
        books.set(session, { book, loadedAt: now() });
        return book;
      },
      endpoints: deps.endpoints,
    };
  }

  /** Runs one operation; a malformed body ends with X-ResponseCode 12 (Invalid Request Body). */
  async function run(h: MapiRequestHeaders, body: Buffer, session: MapiSession | null): Promise<WorkResult> {
    try {
      return { responseCode: ResponseCode.Success, body: await NSPI_OPERATIONS[h.requestType]!(body, contextFor(session)) };
    } catch (err) {
      if (!(err instanceof WireFormatError)) throw err;
      log.debug({ requestType: h.requestType, err: err.message }, 'NSPI request body malformed');
      return { responseCode: ResponseCode.InvalidRequestBody, body: buildFailureBody(ResponseCode.InvalidRequestBody) };
    }
  }

  async function bind(req: Request, res: Response, h: MapiRequestHeaders, auth: { auth: MapiSession['auth']; startedAt: number }): Promise<void> {
    // Reconnecting with the cookies of a live context: that context ends first (MS-OXCMAPIHTTP 3.2.5.6).
    const previous = h.cookies[NSPI_CONTEXT_COOKIE];
    if (isCookieValue(previous)) {
      const old = await deps.sessions.lookup(previous, (s) => s.endpoint === 'nspi' && s.user.userId === auth.auth.user.userId);
      if (old) await deps.sessions.end(old);
    }
    const created = await deps.sessions.create(auth.auth, auth.startedAt, 'nspi');
    log.info({ userId: auth.auth.user.userId, client: h.clientApplication.slice(0, 80) }, 'NSPI session created');
    await stream(res, h, [cookie(NSPI_CONTEXT_COOKIE, created.context, req), cookie(NSPI_SEQUENCE_COOKIE, created.sequence, req)],
      () => run(h, bodyOf(req), created.session));
  }

  async function sessionFor(req: Request, res: Response, h: MapiRequestHeaders, auth: MapiSession['auth']): Promise<MapiSession | null> {
    const value = h.cookies[NSPI_CONTEXT_COOKIE];
    if (value === undefined) { respondFailure(res, h, ResponseCode.MissingCookie, 'session cookie missing'); return null; }
    if (!isCookieValue(value)) { respondFailure(res, h, ResponseCode.InvalidContextCookie, 'invalid session cookie'); return null; }
    const session = await deps.sessions.lookup(value, (s) => sameContext(s, auth, 'nspi'));
    if (!session) {
      res.setHeader('Set-Cookie', clearCookies(req));
      respondFailure(res, h, ResponseCode.ContextNotFound, 'session not found');
      return null;
    }
    return session;
  }

  /** Sequence check + rotation; null when the request was answered. */
  function nextSequence(req: Request, res: Response, h: MapiRequestHeaders, session: MapiSession): string | null {
    if (session.busy) { respondFailure(res, h, ResponseCode.InvalidSequence, 'another request is in progress'); return null; }
    const presented = h.cookies[NSPI_SEQUENCE_COOKIE];
    if (presented === undefined) { respondFailure(res, h, ResponseCode.MissingCookie, 'sequence cookie missing'); return null; }
    const next = session.advanceSequence(presented);
    if (!next) { respondFailure(res, h, ResponseCode.InvalidSequence, 'request out of sequence'); return null; }
    return cookie(NSPI_SEQUENCE_COOKIE, next, req);
  }

  async function operate(req: Request, res: Response, h: MapiRequestHeaders, session: MapiSession): Promise<void> {
    const sequenceCookie = nextSequence(req, res, h, session);
    if (!sequenceCookie) return;
    if (h.requestType === 'Unbind') {
      await deps.sessions.end(session);
      await stream(res, h, clearCookies(req), () => run(h, bodyOf(req), null));
      return;
    }
    session.busy = true;
    try {
      await stream(res, h, [sequenceCookie], () => run(h, bodyOf(req), session));
    } finally {
      session.busy = false;
    }
  }

  const dropSession = (h: MapiRequestHeaders, userId: string): Promise<void> =>
    dropNamedSession(deps.sessions, h.cookies[NSPI_CONTEXT_COOKIE], userId);

  return async (req, res) => {
    const admitted = await admit('nspi', req, res, deps, dropSession);
    if (!admitted) return;
    const { h, auth } = admitted;
    if (h.requestType === 'Bind') { await bind(req, res, h, auth); return; }
    if (h.requestType === 'PING') {
      const value = h.cookies[NSPI_CONTEXT_COOKIE];
      if (isCookieValue(value)) await deps.sessions.lookup(value, (s) => sameContext(s, auth.auth, 'nspi'));
      await stream(res, h, [], async () => ({ responseCode: ResponseCode.Success, body: Buffer.alloc(0) }));
      return;
    }
    const session = await sessionFor(req, res, h, auth.auth);
    if (!session) return;
    await operate(req, res, h, session);
  };
}
