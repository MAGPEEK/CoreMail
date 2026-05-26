/**
 * MAPI over HTTP — Router (v4.0.0)
 *
 * v4.0.0 Foundation: Refactor des bestehenden JSON-Stubs auf binäres
 * MS-OXCMAPIHTTP-Protokoll. emsmdb/Connect/Disconnect funktional, Execute
 * gibt ecNotSupported zurück. NSPI Bind/Unbind funktional, QueryRows/
 * ResolveNames behalten JSON-Stub als Fallback bis volle NSPI-Implementation
 * (v4.7.0).
 *
 * Endpoints:
 *   POST /mapi/emsmdb/         → Binary MAPI (Connect/Execute/Disconnect/NotificationWait)
 *   POST /mapi/nspi/           → NSPI (Bind/Unbind binär, QueryRows JSON-Stub)
 *   GET  /mapi/healthcheck.htm → 200 OK + Body "MAPI" (anonym)
 *
 * Siehe ARCHITECTURE.md für Implementations-Roadmap.
 */

import express, { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { handleEmsmdb } from './emsmdb-handler.js';
import { MapiWriter, MapiStatusCode, ResponseCode } from './codec.js';
import {
  parseMapiHeaders, setMapiResponseHeaders, sendMapiError,
} from './http-headers.js';
import {
  createNspiSession, getNspiSession, deleteNspiSession,
} from './session-store.js';

const log = createLogger('mapi');
export const mapiRouter: RouterType = Router();

// ─── Body-Parser: raw Buffer für /emsmdb/ und /nspi/ ─────────────────────────
// MAPI-Bodies sind BINÄR — kein JSON, kein text. Express muss als Buffer parsen.
mapiRouter.use((req, res, next) => {
  if (req.path === '/emsmdb/' || req.path === '/nspi/') {
    return express.raw({
      type: '*/*',
      limit: '50mb',
    })(req, res, next);
  }
  return next();
});

// ─── Healthcheck (anonym) ────────────────────────────────────────────────────

mapiRouter.get('/healthcheck.htm', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send('MAPI');
});

// ─── EMSMDB (Mailbox-Server) ─────────────────────────────────────────────────

mapiRouter.post('/emsmdb/', async (req: Request, res: Response) => {
  try {
    await handleEmsmdb(req, res);
  } catch (err) {
    log.error({ err }, 'EMSMDB Handler-Fehler');
    if (!res.headersSent) {
      sendMapiError(res, {
        requestId: req.get('x-requestid') ?? '',
        responseCode: ResponseCode.INVALID_HEADER,
        httpStatus: 500,
      });
    }
  }
});

// ─── NSPI (Name Service Provider Interface) ─────────────────────────────────

mapiRouter.post('/nspi/', async (req: Request, res: Response) => {
  const headers = parseMapiHeaders(req);
  const requestId = headers.requestId || `cm-${Date.now()}`;
  const ewsUser = (req as Request & { ewsUser?: { email: string; userId: string } }).ewsUser;
  const email = headers.userIdentity || ewsUser?.email || '';

  log.debug({ requestType: headers.requestType, email }, 'NSPI request');

  switch (headers.requestType) {
    case 'Bind': {
      if (!email) {
        sendMapiError(res, { requestId, responseCode: ResponseCode.ANONYMOUS_NOT_ALLOWED });
        return;
      }
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { id: true, email: true },
      }).catch(() => null);
      if (!user) {
        sendMapiError(res, { requestId, responseCode: ResponseCode.ANONYMOUS_NOT_ALLOWED });
        return;
      }
      const { token } = await createNspiSession({ userId: user.id, email: user.email });

      // Binary Response: nur StatusCode + ErrorCode (NSPI ist einfacher als emsmdb)
      const w = new MapiWriter();
      w.writeUint32(MapiStatusCode.SUCCESS);  // StatusCode
      w.writeUint32(MapiStatusCode.SUCCESS);  // ErrorCode
      w.writeUint32(0);                       // Reserved

      setMapiResponseHeaders(res, {
        requestId,
        setCookie: `NspiSession=${token}; HttpOnly; SameSite=Strict; Path=/mapi/nspi/`,
      });
      res.status(200).send(w.toBuffer());
      return;
    }

    case 'Unbind': {
      const token = headers.cookies['NspiSession'] ?? '';
      if (token) await deleteNspiSession(token);
      const w = new MapiWriter();
      w.writeUint32(MapiStatusCode.SUCCESS);
      w.writeUint32(MapiStatusCode.SUCCESS);
      setMapiResponseHeaders(res, {
        requestId,
        setCookie: 'NspiSession=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/mapi/nspi/',
      });
      res.status(200).send(w.toBuffer());
      return;
    }

    case 'QueryRows':
    case 'ResolveNames':
    case 'GetMatches':
    case 'GetSpecialTable':
    case 'GetProps':
    case 'DnToMinId':
    case 'GetPropList': {
      // v4.7.0: NSPI gibt SUCCESS-empty zurück statt ecNotSupported.
      // Volle MS-OXNSPI Binary-Implementation ist umfangreich (mehrere Wochen
      // Arbeit) und wird auf v5.x verschoben. Outlook fällt mit SUCCESS-empty
      // automatisch auf den EWS-basierten ResolveNames/FindPeople-Pfad zurück
      // (welcher in CoreMail seit v3.x funktional ist über ews-server).
      // Damit funktioniert „Empfänger-Autocomplete" + „Namen überprüfen" in
      // Outlook über die existierende EWS-GAL.
      const session = await getNspiSession(headers.cookies['NspiSession'] ?? '');
      if (!session) {
        sendMapiError(res, { requestId, responseCode: ResponseCode.EXPIRED_COOKIE });
        return;
      }
      const w = new MapiWriter();
      w.writeUint32(MapiStatusCode.SUCCESS);  // StatusCode = OK
      w.writeUint32(MapiStatusCode.SUCCESS);  // ErrorCode = OK
      w.writeUint32(0);                        // RowCount = 0 → Outlook tries EWS fallback
      w.writeUint32(0);                        // HasValue = false
      setMapiResponseHeaders(res, { requestId });
      res.status(200).send(w.toBuffer());
      return;
    }

    default: {
      log.warn({ requestType: headers.requestType }, 'Unbekannter NSPI-RequestType');
      sendMapiError(res, { requestId, responseCode: ResponseCode.INVALID_X_REQUEST_TYPE });
    }
  }
});
