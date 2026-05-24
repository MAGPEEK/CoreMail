/**
 * MAPI over HTTP (MapiHttp) — Phase 8
 *
 * Outlook 2013 SP1+ and Outlook 365 use MAPI over HTTP as the primary
 * transport instead of RPC over HTTP (RPC/HTTP, a.k.a. Outlook Anywhere).
 * This implementation provides the required endpoint stubs so that modern
 * Outlook clients can negotiate a session and fall back gracefully to EWS
 * when the MAPI operation is not fully supported.
 *
 * Protocol reference:
 *   [MS-OXCMAPIHTTP] — MAPI Extensions for HTTP
 *   https://docs.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmapihttp
 *
 * Endpoints (all behind /mapi/):
 *   POST /mapi/emsmdb/          → MailboxServer (email + folder ops)
 *   POST /mapi/nspi/            → Name Service Provider Interface (address book)
 *   GET  /mapi/healthcheck.htm  → Always 200 OK (Outlook connectivity probe)
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('ews:mapi');
export const mapiRouter: RouterType = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

function mapiResponse(
  requestId: string,
  status: number,
  body: Record<string, unknown>,
  res: Response,
): void {
  // X-RequestId echoed back as per MS-OXCMAPIHTTP §2.2.3.3
  res.setHeader('X-RequestId', requestId);
  res.setHeader('X-ClientInfo', '{CoreMail}');
  res.setHeader('X-BackEndOverrideCookie', '');
  res.setHeader('X-DiagInfo', '');
  res.setHeader('ms-server-diagnostics', '0;reason="None"');
  res.status(status).json(body);
}

function parseRequestId(req: Request): string {
  return (req.headers['x-requestid'] as string | undefined) ?? `cm-${Date.now()}`;
}

/** Extract user identity from the Authorization header (Basic auth). */
function extractEmail(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
    const [user] = decoded.split(':');
    return user ?? null;
  } catch {
    return null;
  }
}

// ─── Healthcheck ────────────────────────────────────────────────────────────

/**
 * GET /mapi/healthcheck.htm
 * Outlook probes this URL before opening a MAPI/HTTP session.
 * Must return 200 with body "MAPI" to signal capability.
 */
mapiRouter.get('/healthcheck.htm', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.status(200).send('MAPI');
});

// ─── EMSMDB (Mailbox Server) ─────────────────────────────────────────────────

/**
 * POST /mapi/emsmdb/
 *
 * Outlook uses chunked binary requests (ROP commands) in production.
 * We implement the Connect / Execute / Disconnect lifecycle at the HTTP
 * layer so that modern Outlook can establish a session and then fall
 * back to EWS for the actual mailbox operations.
 *
 * X-RequestType header selects the operation:
 *   Connect     → open a MAPI session (returns session cookie)
 *   Execute     → run ROP batch (we return NotImplemented → Outlook retries via EWS)
 *   Disconnect  → close the session
 *   NotificationWait → long-poll for push notifications (returns immediately)
 */
mapiRouter.post('/emsmdb/', async (req: Request, res: Response) => {
  const requestId = parseRequestId(req);
  const requestType = (req.headers['x-requesttype'] as string | undefined) ?? 'Execute';
  const email = extractEmail(req);

  log.debug({ requestType, email, requestId }, 'MAPI/EMSMDB request');

  switch (requestType) {
    case 'Connect': {
      // Outlook sends its version + capabilities; we return a session cookie
      if (!email) {
        mapiResponse(requestId, 401, { ErrorCode: 'AccessDenied', Message: 'Authentication required' }, res);
        return;
      }

      // Look up the user mailbox
      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        select: { id: true, displayName: true, email: true },
      }).catch(() => null);

      if (!user) {
        mapiResponse(requestId, 404, { ErrorCode: 'UserNotFound', Message: `User '${email}' not found` }, res);
        return;
      }

      // Issue a session token (reuse the user-id as a stable cookie)
      const sessionId = Buffer.from(`${user.id}:${Date.now()}`).toString('base64url');

      res.setHeader('X-RequestId', requestId);
      res.setHeader('Set-Cookie', `MapiSession=${sessionId}; HttpOnly; SameSite=Strict; Path=/mapi/`);
      res.setHeader('X-ElapsedTime', '0');
      res.setHeader('ms-server-diagnostics', '0;reason="None"');
      res.status(200).json({
        StatusCode: 0,           // ecDoConnectEx success
        SessionId: sessionId,
        ServerVersion: '15.02.1118.007', // Exchange 2019 CU12 version string
        DisplayName: user.displayName,
        MailboxSmtpAddress: user.email,
        AutodiscoverData: {
          EwsUrl: `https://${req.hostname}/EWS/Exchange.asmx`,
          EmwsUrl: `https://${req.hostname}/mapi/emsmdb/`,
        },
      });
      return;
    }

    case 'Execute': {
      /**
       * Outlook sends a binary ROP (Remote Operations) payload. Rather than
       * implementing the full MS-OXCROPS protocol we respond with
       * ecNotSupported (0x80040102) which causes Outlook 2013+ to
       * transparently fall back to EWS for the failed operation while
       * keeping the MAPI session open for notifications.
       */
      res.setHeader('X-RequestId', requestId);
      res.setHeader('X-ElapsedTime', '0');
      res.setHeader('ms-server-diagnostics', '1;reason="ROP not implemented — client should retry via EWS"');
      res.status(200).json({
        StatusCode: 1,            // ecNotSupported — triggers EWS fallback
        ErrorCode: 'ecNotSupported',
        Message: 'ROP Execute is not implemented. Please use EWS.',
        EwsFallbackUrl: `https://${req.hostname}/EWS/Exchange.asmx`,
      });
      return;
    }

    case 'Disconnect': {
      res.setHeader('X-RequestId', requestId);
      res.setHeader('Set-Cookie', 'MapiSession=; Max-Age=0; Path=/mapi/');
      res.status(200).json({ StatusCode: 0, Message: 'Session closed' });
      return;
    }

    case 'NotificationWait': {
      /**
       * Outlook polls this endpoint for push notifications.
       * We return immediately with NoNotification (StatusCode 0, no events)
       * to avoid indefinite long-polling connections.
       */
      res.setHeader('X-RequestId', requestId);
      res.setHeader('X-ElapsedTime', '0');
      res.status(200).json({
        StatusCode: 0,
        EventPending: false,
        Events: [],
      });
      return;
    }

    default: {
      log.warn({ requestType }, 'Unknown MAPI/EMSMDB request type');
      mapiResponse(requestId, 501, {
        StatusCode: 1,
        ErrorCode: 'UnknownRequestType',
        Message: `Request type '${requestType}' is not supported.`,
      }, res);
    }
  }
});

// ─── NSPI (Name Service Provider Interface / Address Book) ───────────────────

/**
 * POST /mapi/nspi/
 *
 * Outlook uses NSPI for address book lookups (GAL, name resolution).
 * We implement the Connect/QueryRows/Disconnect handshake and serve
 * user data from PostgreSQL for the most common operations.
 *
 * X-RequestType values handled:
 *   Bind         → open NSPI session
 *   QueryRows    → fetch address book rows
 *   ResolveNames → name resolution (alias → SMTP address)
 *   Unbind       → close NSPI session
 */
mapiRouter.post('/nspi/', async (req: Request, res: Response) => {
  const requestId = parseRequestId(req);
  const requestType = (req.headers['x-requesttype'] as string | undefined) ?? 'QueryRows';
  const email = extractEmail(req);

  log.debug({ requestType, email, requestId }, 'MAPI/NSPI request');

  switch (requestType) {
    case 'Bind': {
      if (!email) {
        mapiResponse(requestId, 401, { ErrorCode: 'AccessDenied', Message: 'Authentication required' }, res);
        return;
      }
      const sessionId = Buffer.from(`nspi:${email}:${Date.now()}`).toString('base64url');
      res.setHeader('X-RequestId', requestId);
      res.setHeader('Set-Cookie', `NspiSession=${sessionId}; HttpOnly; SameSite=Strict; Path=/mapi/nspi/`);
      res.status(200).json({ StatusCode: 0, SessionId: sessionId });
      return;
    }

    case 'QueryRows': {
      // Return all active users in the organisation as GAL entries
      const users = await prisma.user.findMany({
        select: { id: true, email: true, displayName: true },
        take: 500,
      }).catch(() => []);

      const rows = users.map((u) => ({
        PR_ENTRYID: u.id,
        PR_DISPLAY_NAME: u.displayName,
        PR_EMAIL_ADDRESS: u.email,
        PR_ADDRTYPE: 'SMTP',
        PR_OBJECT_TYPE: 6,      // MAPI_MAILUSER
        PR_DISPLAY_TYPE: 0,     // DT_MAILUSER
      }));

      mapiResponse(requestId, 200, { StatusCode: 0, Rows: rows, TotalRows: rows.length }, res);
      return;
    }

    case 'ResolveNames': {
      const body = req.body as { Names?: string[] } | undefined;
      const names = body?.Names ?? [];

      const resolved = await Promise.all(
        names.map(async (name) => {
          const user = await prisma.user.findFirst({
            where: {
              OR: [
                { email: { contains: name, mode: 'insensitive' } },
                { displayName: { contains: name, mode: 'insensitive' } },
              ],
            },
            select: { id: true, email: true, displayName: true },
          }).catch(() => null);
          return user
            ? { Input: name, Resolved: true, PR_EMAIL_ADDRESS: user.email, PR_DISPLAY_NAME: user.displayName }
            : { Input: name, Resolved: false };
        }),
      );

      mapiResponse(requestId, 200, { StatusCode: 0, Results: resolved }, res);
      return;
    }

    case 'Unbind': {
      res.setHeader('X-RequestId', requestId);
      res.setHeader('Set-Cookie', 'NspiSession=; Max-Age=0; Path=/mapi/nspi/');
      res.status(200).json({ StatusCode: 0 });
      return;
    }

    default: {
      log.warn({ requestType }, 'Unknown MAPI/NSPI request type');
      mapiResponse(requestId, 501, {
        StatusCode: 1,
        ErrorCode: 'UnknownRequestType',
        Message: `NSPI request type '${requestType}' is not supported.`,
      }, res);
    }
  }
});
