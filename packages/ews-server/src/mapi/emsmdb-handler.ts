/**
 * MAPI/HTTP emsmdb Handler (v4.0.0)
 *
 * Implementiert den HTTP-Layer für /mapi/emsmdb/.
 * Outlook-Aufrufe:
 *   - X-RequestType: Connect  → Session öffnen, Cookie ausstellen
 *   - X-RequestType: Execute  → ROP-Batch (NICHT implementiert → ecNotSupported)
 *   - X-RequestType: Disconnect → Session schließen
 *   - X-RequestType: NotificationWait → Long-Poll für Push-Events
 *
 * v4.0.0 Status: Connect / Disconnect / NotificationWait funktional.
 * Execute liefert immer ecNotSupported — ROPs kommen in v4.1.0+ iterativ.
 *
 * Siehe ARCHITECTURE.md für Implementations-Roadmap.
 */

import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
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

const log = createLogger('mapi:emsmdb');

/**
 * Server-DN-Prefix. Outlook prüft, dass DnPrefix konsistent mit dem
 * LegacyDN aus der Autodiscover-Response ist. Format nach MS-OXOABK.
 */
const SERVER_DN_PREFIX =
  '/o=CoreMail/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)';

/** Long-Poll-Dauer für NotificationWait (ms). */
const NOTIFICATION_POLL_TIMEOUT_MS = 30_000;

// ─── Connect ─────────────────────────────────────────────────────────────────

/**
 * Outlook → Server: EcDoConnectEx (MS-OXCRPC §3.1.4.1).
 *
 * Request-Body (binär):
 *   UserDn (ASCII null-terminated) — LegacyDN aus Autodiscover
 *   Flags (uint32)
 *   DefaultCodePage (uint32)
 *   LcidString (uint32)
 *   LcidSort (uint32)
 *   AuxBuffer (variable AUX_HEADERs)
 *
 * Response-Body (binär):
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
  // Body parsen
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let userDn = '';
  if (body.length > 0) {
    try {
      const reader = new MapiReader(body);
      userDn = reader.readAsciiString();
      // Restliche Felder ignorieren wir aktuell (Flags, Codepage, Lcid, AuxBuffer)
    } catch (err) {
      log.warn({ err }, 'Connect: Body-Parsing fehlgeschlagen');
      sendMapiError(res, { requestId, responseCode: ResponseCode.INVALID_HEADER });
      return;
    }
  }

  // User-Identity kommt entweder aus dem MAPI-Header X-User-Identity, oder
  // aus der EWS-Auth-Middleware (req.ewsUser, gefüllt durch Basic-Auth).
  const headers = parseMapiHeaders(req);
  const ewsUser = (req as Request & { ewsUser?: { userId: string; email: string; role: string } }).ewsUser;
  const email = headers.userIdentity || ewsUser?.email || '';

  if (!email) {
    log.warn({ userDn }, 'Connect ohne User-Identity');
    sendMapiError(res, { requestId, responseCode: ResponseCode.ANONYMOUS_NOT_ALLOWED });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, displayName: true, email: true, active: true },
  }).catch(() => null);

  if (!user || !user.active) {
    log.warn({ email }, 'Connect: User nicht gefunden / inaktiv');
    // Outlook erwartet StatusCode=ecLoginFailure im Body
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

  // Session erstellen + Cookie ausstellen
  const { token } = await createMapiSession({
    userId:      user.id,
    email:       user.email,
    displayName: user.displayName ?? user.email,
  });

  log.info({ userId: user.id, email: user.email, userDn }, 'MAPI Connect erfolgreich');

  // Binär-Response bauen
  const w = new MapiWriter();
  w.writeUint32(MapiStatusCode.SUCCESS);  // StatusCode
  w.writeUint32(MapiStatusCode.SUCCESS);  // ErrorCode
  w.writeUint32(60_000);                  // PollsMax (60s Long-Poll-Max)
  w.writeUint32(3);                       // RetryCount
  w.writeUint32(2_000);                   // RetryDelay (2s)
  w.writeAsciiString(SERVER_DN_PREFIX);   // DnPrefix
  w.writeAsciiString(user.displayName ?? user.email); // DisplayName
  // AuxBuffer: minimal leer

  setMapiResponseHeaders(res, {
    requestId,
    expirationMs: 600_000,
    setCookie:    `MapiSession=${token}; HttpOnly; SameSite=Strict; Path=/mapi/`,
  });
  res.status(200).send(w.toBuffer());
}

// ─── Execute (ROP-Batch) — Stub ──────────────────────────────────────────────

/**
 * Outlook → Server: EcDoRpcExt2 (MS-OXCRPC §3.1.4.2).
 *
 * v4.0.0: noch keine ROPs implementiert. Wir antworten mit ecNotSupported,
 * was Outlook nicht crashen lässt aber das Profile-Building fehlschlagen
 * lässt. ROPs kommen in v4.1.0+ (RopLogon, RopOpenFolder, ...).
 *
 * Solange das hier ecNotSupported zurückgibt, wird Outlook nach Connect
 * keine sinnvolle Verbindung aufbauen können.
 */
async function handleExecute(req: Request, res: Response, requestId: string): Promise<void> {
  const headers = parseMapiHeaders(req);
  const sessionToken = headers.cookies['MapiSession'] ?? '';
  const session = await getMapiSession(sessionToken);
  if (!session) {
    log.warn({ token: sessionToken.slice(0, 8) }, 'Execute: ungültige/abgelaufene Session');
    sendMapiError(res, { requestId, responseCode: ResponseCode.EXPIRED_COOKIE });
    return;
  }

  log.debug({ userId: session.userId, bodyLen: (req.body as Buffer)?.length }, 'Execute (Stub → ecNotSupported)');

  // Binäres Error-Response: StatusCode + ErrorCode + leere Body-Felder
  const w = new MapiWriter();
  w.writeUint32(MapiStatusCode.EC_NOT_SUPPORTED); // StatusCode
  w.writeUint32(MapiStatusCode.EC_NOT_SUPPORTED); // ErrorCode
  w.writeUint32(0);                                // Flags
  w.writeUint32(0);                                // RopBufferSize (0 = leerer ROP-Stream)
  // Kein RopBuffer Body — Outlook wird verstehen "ecNotSupported, retry via EWS"

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

// ─── NotificationWait (Long-Poll) ────────────────────────────────────────────

/**
 * Outlook hält diese Verbindung offen und wartet auf Server-Push-Events
 * (z.B. neue Mail). Wir respondieren nach `NOTIFICATION_POLL_TIMEOUT_MS` mit
 * `EventPending=false`. In v4.5.0 wird hier Redis-pub/sub für echtes Push
 * angebunden.
 */
async function handleNotificationWait(req: Request, res: Response, requestId: string): Promise<void> {
  const headers = parseMapiHeaders(req);
  const sessionToken = headers.cookies['MapiSession'] ?? '';
  const session = await getMapiSession(sessionToken);
  if (!session) {
    sendMapiError(res, { requestId, responseCode: ResponseCode.EXPIRED_COOKIE });
    return;
  }

  // v4.0.0: Sofort-Response (kein echter Long-Poll), damit Outlook nicht
  // hängt und wir keine Connection-Pool-Probleme bekommen.
  // v4.5.0 wird hier Redis-pub/sub-Subscribe einbauen.
  const w = new MapiWriter();
  w.writeUint32(MapiStatusCode.SUCCESS);  // StatusCode
  w.writeUint32(0);                       // EventPending = false (uint32 flag)
  // Keine Events

  setMapiResponseHeaders(res, {
    requestId,
    pendingMs: NOTIFICATION_POLL_TIMEOUT_MS,
  });
  res.status(200).send(w.toBuffer());
}

// ─── Router-Hook ─────────────────────────────────────────────────────────────

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
      log.warn({ requestType: headers.requestType }, 'Unbekannter X-RequestType');
      sendMapiError(res, { requestId, responseCode: ResponseCode.INVALID_X_REQUEST_TYPE });
  }
}
