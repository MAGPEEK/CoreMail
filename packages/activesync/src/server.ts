import { initRuntimeLogLevel, startAuthInvalidationSubscriber } from '@coremail/core';
import { registerLdapMailVerifier } from '@coremail/auth-ldap';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createLogger } from '@coremail/core/logger';
import { installProcessGuards, installAsyncErrorHandling, errorMiddleware, resolveBindHost } from '@coremail/core/http';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth, type EasUser } from './auth.js';
import { easLiveRequests } from './live-sessions.js';
import { decodeWbxml, type WbxmlElement } from './wbxml.js';
import { EAS_COMMANDS } from './commands.js';
import { handleProvision } from './commands/provision.js';
import { handleFolderSync } from './commands/folder-sync.js';
import { handleSync, emptySyncResponse } from './commands/sync.js';
import { deviceAccess, deniedResponse } from './device-policy.js';
import { readFileSync } from 'node:fs';
import { handleSendMail, handleSmartReply } from './commands/send-mail.js';
import { handlePing } from './commands/ping.js';
import { handleGetAttachment } from './commands/get-attachment.js';
import { handleItemOperations, prismaItemOperationsDeps } from './commands/item-operations.js';
import { handleGetItemEstimate } from './commands/get-item-estimate.js';
import { handleSettings } from './commands/settings.js';
import { handleSearch } from './commands/search.js';
import { handleMoveItems } from './commands/move-items.js';
import { handleMeetingResponse } from './commands/meeting-response.js';
import { handleResolveRecipients } from './commands/resolve-recipients.js';
import { getObjectStream } from '@coremail/storage/minio';
import { waitForObjectStorage } from '@coremail/storage';

const log = createLogger('activesync');
installProcessGuards(log);
// v6.1: LDAP accounts can log in on the mail protocols (shared credential check)
registerLdapMailVerifier();
// v6: e.g. the async requireAuth (Prisma) used to crash the process on DB errors
installAsyncErrorHandling(express);
const app = express();
const PORT = parseInt(process.env['EAS_PORT'] ?? '3005', 10);
const APP_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch { return 'unknown'; }
})();

// ─── Raw body parser for WBXML ────────────────────────────────────────────────
app.use('/Microsoft-Server-ActiveSync', express.raw({ type: '*/*', limit: '25mb' }));

// ─── OPTIONS — Autodiscover capability negotiation ────────────────────────────
app.options('/Microsoft-Server-ActiveSync', (_req: Request, res: Response) => {
  res.setHeader('MS-Server-ActiveSync', '14.1');
  res.setHeader('MS-ASProtocolVersions', '14.0,14.1');
  res.setHeader('MS-ASProtocolCommands', EAS_COMMANDS.join(','));
  res.status(200).end();
});

// ─── POST — Main command dispatcher ──────────────────────────────────────────
app.post(
  '/Microsoft-Server-ActiveSync',
  requireAuth as express.RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const user = (req as Request & { easUser: EasUser }).easUser;
    const command = req.query['Cmd'] as string | undefined;
    const deviceId = req.query['DeviceId'] as string ?? 'unknown';
    const deviceType = req.query['DeviceType'] as string ?? 'Unknown';
    const protocolVersion = req.get('MS-ASProtocolVersion') ?? '14.1';

    res.setHeader('MS-Server-ActiveSync', '14.1');
    res.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');

    if (!command) {
      res.status(400).send('Missing Cmd');
      return;
    }

    const bodyBuf = req.body as Buffer;
    let wbxmlBody: WbxmlElement | null = null;
    if (bodyBuf && bodyBuf.length > 0) {
      try {
        wbxmlBody = decodeWbxml(bodyBuf);
      } catch (err) {
        log.error({ err, command }, 'WBXML decode error');
        res.status(400).send('Invalid WBXML');
        return;
      }
    }

    try {
      // Device access: provisioned, current policy key, not blocked / wiped ([MS-ASPROV]).
      const device = await prisma.activeSyncDevice.findUnique({
        where: { userId_deviceId: { userId: user.userId, deviceId } },
        select: { status: true, policyKey: true },
      });
      const access = deviceAccess(device, command, req.get('X-MS-PolicyKey'));
      if (!access.allow) {
        const denied = deniedResponse(command, access.status, protocolVersion);
        log.info({ userId: user.userId, deviceId, command, status: access.status }, 'EAS request refused by device policy');
        if (denied.body) res.status(denied.httpStatus).send(denied.body);
        else { res.removeHeader('Content-Type'); res.status(denied.httpStatus).end(); }
        return;
      }

      const handler = HANDLERS[command];
      if (!handler) {
        log.warn({ command }, 'Unknown EAS command');
        res.status(501).send('Not implemented');
        return;
      }
      if (handler.needsBody && !wbxmlBody) {
        if (command === 'Sync') { res.status(200).send(emptySyncResponse()); return; }
        res.status(400).send('Missing body');
        return;
      }
      await handler.run({ req, res, body: wbxmlBody as WbxmlElement, user, deviceId, deviceType, protocolVersion });
    } catch (err) {
      log.error({ err, command }, 'EAS command error');
      if (!res.headersSent) res.status(500).send('Internal server error');
    }
  },
);

interface CommandContext {
  req: Request;
  res: Response;
  /** Decoded request (null only for commands with needsBody = false). */
  body: WbxmlElement;
  user: EasUser;
  deviceId: string;
  deviceType: string;
  protocolVersion: string;
}

/** Reply with a WBXML buffer. */
const wbxml = (run: (c: CommandContext) => Promise<Buffer>) => async (c: CommandContext) => { c.res.status(200).send(await run(c)); };

const HANDLERS: Record<string, { needsBody: boolean; run: (c: CommandContext) => Promise<void> }> = {
  Provision: { needsBody: true, run: wbxml((c) => handleProvision(c.body, c.user.userId, c.deviceId, c.deviceType)) },
  FolderSync: { needsBody: true, run: wbxml((c) => handleFolderSync(c.body, c.user.userId, c.deviceId)) },
  Sync: { needsBody: true, run: wbxml((c) => handleSync(c.body, c.user.userId, c.deviceId)) },
  SendMail: { needsBody: true, run: wbxml((c) => handleSendMail(c.body, c.user.userId)) },
  SmartReply: { needsBody: true, run: wbxml((c) => handleSmartReply(c.body, c.user.userId, 'SmartReply')) },
  SmartForward: { needsBody: true, run: wbxml((c) => handleSmartReply(c.body, c.user.userId, 'SmartForward')) },
  // Ping holds the connection; an empty Ping reuses the device's last parameters.
  Ping: { needsBody: false, run: (c) => handlePing(c.req.body?.length ? c.body : null, c.user.userId, c.res, c.user, { deviceId: c.deviceId }) },
  GetAttachment: {
    needsBody: false,
    run: async ({ req, res, user }) => {
      const attachmentName = req.query['AttachmentName'] as string | undefined;
      if (!attachmentName) { res.status(400).send('Missing AttachmentName'); return; }
      res.removeHeader('Content-Type'); // set by the handler (attachment MIME type)
      await handleGetAttachment(res, user.userId, attachmentName, {
        findAttachment: (id, userId) => prisma.attachment.findFirst({
          where: { id, message: { deletedAt: null, folder: { mailbox: { userId } } } },
          select: { mimeType: true, size: true, storagePath: true },
        }),
        openStream: getObjectStream,
        warn: (msg, err) => log.warn({ err }, msg),
      });
    },
  },
  ItemOperations: { needsBody: true, run: wbxml((c) => handleItemOperations(c.body, c.user.userId, prismaItemOperationsDeps((msg, err) => log.warn({ err }, msg)))) },
  GetItemEstimate: { needsBody: true, run: wbxml((c) => handleGetItemEstimate(c.body, c.user.userId, c.deviceId)) },
  Settings: { needsBody: true, run: wbxml((c) => handleSettings(c.body, c.user.userId, c.deviceId, c.protocolVersion)) },
  Search: { needsBody: true, run: wbxml((c) => handleSearch(c.body, c.user.userId)) },
  MoveItems: { needsBody: true, run: wbxml((c) => handleMoveItems(c.body, c.user.userId, c.deviceId)) },
  MeetingResponse: { needsBody: true, run: wbxml((c) => handleMeetingResponse(c.body, c.user.userId, undefined, c.protocolVersion)) },
  ResolveRecipients: { needsBody: true, run: wbxml((c) => handleResolveRecipients(c.body, c.user.userId)) },
};

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'activesync', version: process.env['COREMAIL_VERSION'] ?? APP_VERSION });
});

// v6: shared error middleware (registered last)
app.use(errorMiddleware(log));

void initRuntimeLogLevel('activesync', { aliases: ['eas'] }); // BCP per-service log level
// v7.1.0: credential changes end the user's Ping long-polls with 401.
easLiveRequests.attachInvalidation();
startAuthInvalidationSubscriber();
// v6: internal service behind the api-gateway — loopback by default
const HOST = resolveBindHost();
// v7.1: no listener while the object storage misses the referenced objects
void waitForObjectStorage('activesync').then(() => {
  app.listen(PORT, HOST, () => {
    log.info({ port: PORT, host: HOST }, 'ActiveSync (EAS) server started');
  });
});
