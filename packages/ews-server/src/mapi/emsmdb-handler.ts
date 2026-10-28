/**
 * MAPI/HTTP emsmdb Handler (v4.0.0)
 *
 * Implements the HTTP layer for /mapi/emsmdb/.
 * Outlook calls:
 *   - X-RequestType: Connect  → open session, issue cookie
 *   - X-RequestType: Execute  → ROP batch (NOT implemented → ecNotSupported)
 *   - X-RequestType: Disconnect → close session
 *   - X-RequestType: NotificationWait → long-poll for push events
 *
 * v4.0.0 status: Connect / Disconnect / NotificationWait functional.
 * Execute always returns ecNotSupported — ROPs arrive iteratively in v4.1.0+.
 *
 * See ARCHITECTURE.md for the implementation roadmap.
 */

import type { Request, Response } from 'express';
import { createLogger, getRedisClient } from '@coremail/core';
import { prisma } from '@coremail/storage';
import {
  MapiReader, MapiWriter,
  MapiStatusCode, ResponseCode,
} from './codec.js';
import {
  parseMapiHeaders, setMapiResponseHeaders, sendMapiError,
} from './http-headers.js';
import {
  createMapiSession, getMapiSession, deleteMapiSession,
} from './session-store.js';
import { notifyChannelFor } from './rop/notification.js';

const log = createLogger('mapi:emsmdb');

/**
 * Server DN prefix. Outlook checks that DnPrefix is consistent with the
 * LegacyDN from the Autodiscover response. Format per MS-OXOABK.
 */
const SERVER_DN_PREFIX =
  '/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)';

/** Long-poll duration for NotificationWait (ms). Outlook accepts up to 59 min. */
const NOTIFICATION_POLL_TIMEOUT_MS = 30_000;

// ─── Connect ─────────────────────────────────────────────────────────────────

/**
 * Outlook → Server: EcDoConnectEx (MS-OXCRPC §3.1.4.1).
 *
 * Request body (binary):
 *   UserDn (ASCII null-terminated) — LegacyDN from Autodiscover
 *   Flags (uint32)
 *   DefaultCodePage (uint32)
 *   LcidString (uint32)
 *   LcidSort (uint32)
 *   AuxBuffer (variable AUX_HEADERs)
 *
 * Response body (binary):
 *   StatusCode (uint32)
 *   ErrorCode (uint32)
 *   PollsMax (uint32)
 *   RetryCount (uint32)
 *   RetryDelay (uint32)
 *   DnPrefix (ASCII null-terminated)
 *   DisplayName (ASCII null-terminated)
 *   AuxBuffer (variable)
 */
async function handleConnect(req: Request, res: Response, requestId: string): Promise<void> {
  // Parse body
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let userDn = '';
  if (body.length > 0) {
    try {
      const reader = new MapiReader(body);
      userDn = reader.readAsciiString();
      // We currently ignore the remaining fields (Flags, Codepage, Lcid, AuxBuffer)
    } catch (err) {
      log.warn({ err }, 'Connect: body parsing failed');
      sendMapiError(res, { requestId, responseCode: ResponseCode.INVALID_HEADER });
      return;
    }
  }

  // User identity comes either from the MAPI header X-User-Identity, or
  // from the EWS auth middleware (req.ewsUser, filled by Basic auth).
  const headers = parseMapiHeaders(req);
  const ewsUser = (req as Request & { ewsUser?: { userId: string; email: string; role: string } }).ewsUser;
  const email = headers.userIdentity || ewsUser?.email || '';

  if (!email) {
    log.warn({ userDn }, 'Connect without user identity');
    sendMapiError(res, { requestId, responseCode: ResponseCode.ANONYMOUS_NOT_ALLOWED });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, displayName: true, email: true, active: true },
  }).catch(() => null);

  if (!user || !user.active) {
    log.warn({ email }, 'Connect: user not found / inactive');
    // Outlook expects StatusCode=ecLoginFailure in the body
    const w = new MapiWriter();
    w.writeUint32(MapiStatusCode.EC_LOGIN_FAILURE);   // StatusCode
    w.writeUint32(MapiStatusCode.EC_LOGIN_FAILURE);   // ErrorCode
    w.writeUint32(0); w.writeUint32(0); w.writeUint32(0); // PollsMax, RetryCount, RetryDelay
    w.writeAsciiString(''); // DnPrefix
    w.writeAsciiString(''); // DisplayName
    setMapiResponseHeaders(res, { requestId });
    res.status(200).send(w.toBuffer());
    return;
  }

  // Create session + issue cookie
  const { token } = await createMapiSession({
    userId:      user.id,
    email:       user.email,
    displayName: user.displayName ?? user.email,
  });

  log.info({ userId: user.id, email: user.email, userDn }, 'MAPI Connect successful');

  // Build binary response
  const w = new MapiWriter();
  w.writeUint32(MapiStatusCode.SUCCESS);  // StatusCode
  w.writeUint32(MapiStatusCode.SUCCESS);  // ErrorCode
  w.writeUint32(60_000);                  // PollsMax (60s long-poll max)
  w.writeUint32(3);                       // RetryCount
  w.writeUint32(2_000);                   // RetryDelay (2s)
  w.writeAsciiString(SERVER_DN_PREFIX);   // DnPrefix
  w.writeAsciiString(user.displayName ?? user.email); // DisplayName
  // AuxBuffer: minimal, empty

  setMapiResponseHeaders(res, {
    requestId,
    expirationMs: 600_000,
    setCookie:    `MapiSession=${token}; HttpOnly; SameSite=Strict; Path=/mapi/`,
  });
  res.status(200).send(w.toBuffer());
}

// ─── Execute (ROP batch) — Stub ──────────────────────────────────────────────

/**
 * Outlook → Server: EcDoRpcExt2 (MS-OXCRPC §3.1.4.2).
 *
 * v4.0.0: no ROPs implemented yet. We answer with ecNotSupported,
 * which does not crash Outlook but makes profile building fail.
 * ROPs arrive in v4.1.0+ (RopLogon, RopOpenFolder, ...).
 *
 * As long as this returns ecNotSupported, Outlook will not be able to
 * establish a meaningful connection after Connect.
 */
async function handleExecute(req: Request, res: Response, requestId: string): Promise<void> {
  const headers = parseMapiHeaders(req);
  const sessionToken = headers.cookies['MapiSession'] ?? '';
  const session = await getMapiSession(sessionToken);
  if (!session) {
    log.warn({ token: sessionToken.slice(0, 8) }, 'Execute: invalid/expired session');
    sendMapiError(res, { requestId, responseCode: ResponseCode.EXPIRED_COOKIE });
    return;
  }

  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  log.debug({ userId: session.userId, bodyLen: body.length }, 'Execute → ROP-Dispatcher');

  // v4.1.0: the ROP dispatcher takes over
  const { dispatchRopBuffer } = await import('./rop-dispatcher.js');
  const result = await dispatchRopBuffer(body, sessionToken, session);

  // Execute response envelope (MS-OXCRPC §2.2.4.2):
  //   StatusCode (uint32)
  //   ErrorCode (uint32)
  //   Flags (uint32)
  //   RopBufferSize (uint32)
  //   RopBuffer (variable — = ROP stream + handle table)
  //   AuxBufferSize (uint32) = 0
  const w = new MapiWriter();
  w.writeUint32(MapiStatusCode.SUCCESS); // StatusCode
  w.writeUint32(MapiStatusCode.SUCCESS); // ErrorCode
  w.writeUint32(0);                       // Flags
  w.writeUint32(result.responseBuffer.length); // RopBufferSize
  w.writeBuffer(result.responseBuffer);   // RopBuffer
  w.writeUint32(0);                       // AuxBufferSize (no aux)

  setMapiResponseHeaders(res, { requestId });
  res.status(200).send(w.toBuffer());
}

// ─── Disconnect ──────────────────────────────────────────────────────────────

async function handleDisconnect(req: Request, res: Response, requestId: string): Promise<void> {
  const headers = parseMapiHeaders(req);
  const sessionToken = headers.cookies['MapiSession'] ?? '';
  if (sessionToken) {
    await deleteMapiSession(sessionToken);
    log.info({ token: sessionToken.slice(0, 8) }, 'MAPI Disconnect');
  }

  const w = new MapiWriter();
  w.writeUint32(MapiStatusCode.SUCCESS);  // StatusCode
  w.writeUint32(MapiStatusCode.SUCCESS);  // ErrorCode

  setMapiResponseHeaders(res, {
    requestId,
    setCookie: 'MapiSession=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/mapi/',
  });
  res.status(200).send(w.toBuffer());
}

// ─── NotificationWait (long-poll, v4.5.0 Redis push) ─────────────────────────

/**
 * Outlook keeps this connection open and waits for server push events
 * (e.g. new mail). v4.5.0: real long-poll with Redis pub/sub.
 *
 * Workflow:
 *   1) If no session: 401 equivalent.
 *   2) Subscribe to Redis channel `coremail:mapi:notify:<userId>`.
 *   3) Race: (a) event on channel → response EventPending=true,
 *           (b) timeout NOTIFICATION_POLL_TIMEOUT_MS → EventPending=false.
 *   4) Cleanup: unsubscribe + dispose dedicated Redis connection.
 *
 * We use a `duplicate()` of the ioredis client because subscribe needs a
 * dedicated connection (ioredis requirement).
 */
async function handleNotificationWait(req: Request, res: Response, requestId: string): Promise<void> {
  const headers = parseMapiHeaders(req);
  const sessionToken = headers.cookies['MapiSession'] ?? '';
  const session = await getMapiSession(sessionToken);
  if (!session) {
    sendMapiError(res, { requestId, responseCode: ResponseCode.EXPIRED_COOKIE });
    return;
  }

  const userId = session.userId;
  const channel = notifyChannelFor(userId);
  const sub = getRedisClient().duplicate();

  // Race between event and timeout
  const eventPending: boolean = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      void cleanup();
      resolve(false);
    }, NOTIFICATION_POLL_TIMEOUT_MS);

    let settled = false;
    const cleanup = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await sub.unsubscribe(channel);
      } catch { /* ignore */ }
      try {
        sub.disconnect();
      } catch { /* ignore */ }
    };

    sub.on('message', (_ch, _msg) => {
      void cleanup();
      resolve(true);
    });

    sub.subscribe(channel).catch((err: unknown) => {
      log.warn({ err, userId }, 'NotificationWait: Redis subscribe failed — responding immediately');
      void cleanup();
      resolve(false);
    });

    // Clean abort when Outlook closes the connection
    req.on('close', () => { void cleanup(); resolve(false); });
  });

  const w = new MapiWriter();
  w.writeUint32(MapiStatusCode.SUCCESS);  // StatusCode
  w.writeUint32(eventPending ? 1 : 0);     // EventPending

  setMapiResponseHeaders(res, {
    requestId,
    pendingMs: NOTIFICATION_POLL_TIMEOUT_MS,
  });
  res.status(200).send(w.toBuffer());
  log.debug({ userId, eventPending }, 'NotificationWait completed');
}

// ─── Router hook ─────────────────────────────────────────────────────────────

export async function handleEmsmdb(req: Request, res: Response): Promise<void> {
  const headers = parseMapiHeaders(req);
  const requestId = headers.requestId || `cm-${Date.now()}`;

  log.debug({
    requestType:  headers.requestType,
    userIdentity: headers.userIdentity,
    bodyLen:      Buffer.isBuffer(req.body) ? req.body.length : 0,
  }, 'MAPI /emsmdb/ request');

  switch (headers.requestType) {
    case 'Connect':           await handleConnect(req, res, requestId); return;
    case 'Execute':           await handleExecute(req, res, requestId); return;
    case 'Disconnect':        await handleDisconnect(req, res, requestId); return;
    case 'NotificationWait':  await handleNotificationWait(req, res, requestId); return;
    default:
      log.warn({ requestType: headers.requestType }, 'Unknown X-RequestType');
      sendMapiError(res, { requestId, responseCode: ResponseCode.INVALID_X_REQUEST_TYPE });
  }
}
