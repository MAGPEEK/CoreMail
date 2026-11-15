import { initRuntimeLogLevel } from '@coremail/core';
import { registerLdapMailVerifier } from '@coremail/auth-ldap';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createLogger } from '@coremail/core/logger';
import { installProcessGuards, installAsyncErrorHandling, errorMiddleware, resolveBindHost } from '@coremail/core/http';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth } from './auth.js';
import { decodeWbxml, type WbxmlElement } from './wbxml.js';
import { EAS_COMMANDS } from './commands.js';
import { handleProvision } from './commands/provision.js';
import { handleFolderSync } from './commands/folder-sync.js';
import { handleSync } from './commands/sync.js';
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

const log = createLogger('activesync');
installProcessGuards(log);
// v6.1: LDAP accounts can log in on the mail protocols (shared credential check)
registerLdapMailVerifier();
// v6: e.g. the async requireAuth (Prisma) used to crash the process on DB errors
installAsyncErrorHandling(express);
const app = express();
const PORT = parseInt(process.env['EAS_PORT'] ?? '3005', 10);

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
    const user = (req as Request & { easUser: { userId: string; email: string } }).easUser;
    const command = req.query['Cmd'] as string | undefined;
    const deviceId = req.query['DeviceId'] as string ?? 'unknown';
    const deviceType = req.query['DeviceType'] as string ?? 'Unknown';

    res.setHeader('MS-Server-ActiveSync', '14.1');
    res.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');

    if (!command) {
      res.status(400).send('Missing Cmd');
      return;
    }

    const bodyBuf = req.body as Buffer;
    let wbxmlBody = null;
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
      switch (command) {
        case 'Provision': {
          if (!wbxmlBody) { res.status(400).send('Missing body'); return; }
          const result = await handleProvision(wbxmlBody, user.userId, deviceId, deviceType);
          res.status(200).send(result);
          break;
        }
        case 'FolderSync': {
          if (!wbxmlBody) { res.status(400).send('Missing body'); return; }
          const result = await handleFolderSync(wbxmlBody, user.userId, deviceId);
          res.status(200).send(result);
          break;
        }
        case 'Sync': {
          if (!wbxmlBody) { res.status(400).send('Missing body'); return; }
          const result = await handleSync(wbxmlBody, user.userId, deviceId);
          res.status(200).send(result);
          break;
        }
        case 'SendMail': {
          if (!wbxmlBody) { res.status(400).send('Missing body'); return; }
          const result = await handleSendMail(wbxmlBody, user.userId);
          res.status(200).send(result);
          break;
        }
        case 'SmartReply': {
          if (!wbxmlBody) { res.status(400).send('Missing body'); return; }
          const result = await handleSmartReply(wbxmlBody, user.userId, 'SmartReply');
          res.status(200).send(result);
          break;
        }
        case 'SmartForward': {
          if (!wbxmlBody) { res.status(400).send('Missing body'); return; }
          const result = await handleSmartReply(wbxmlBody, user.userId, 'SmartForward');
          res.status(200).send(result);
          break;
        }
        case 'Ping': {
          if (!wbxmlBody) {
            // Empty ping — return heartbeat
            res.status(200).end();
            return;
          }
          // Ping is handled specially: it holds the connection
          await handlePing(wbxmlBody, user.userId, res);
          break;
        }
        case 'GetAttachment': {
          // Simple attachment fetch by AttachmentName query param
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
          break;
        }
        case 'ItemOperations': {
          if (!wbxmlBody) { res.status(400).send('Missing body'); return; }
          const result = await handleItemOperations(wbxmlBody, user.userId, prismaItemOperationsDeps((msg, err) => log.warn({ err }, msg)));
          res.status(200).send(result);
          break;
        }
        case 'GetItemEstimate': {
          if (!wbxmlBody) { res.status(400).send('Missing body'); return; }
          res.status(200).send(await handleGetItemEstimate(wbxmlBody, user.userId));
          break;
        }
        case 'Settings':
        case 'Search':
        case 'MoveItems':
        case 'MeetingResponse':
        case 'ResolveRecipients': {
          if (!wbxmlBody) { res.status(400).send('Missing body'); return; }
          const result = await runCommand(command, wbxmlBody, user.userId, deviceId, req.get('MS-ASProtocolVersion') ?? '14.1');
          res.status(200).send(result);
          break;
        }
        default:
          log.warn({ command }, 'Unknown EAS command');
          res.status(501).send('Not implemented');
      }
    } catch (err) {
      log.error({ err, command }, 'EAS command error');
      res.status(500).send('Internal server error');
    }
  },
);

function runCommand(command: string, body: WbxmlElement, userId: string, deviceId: string, protocolVersion: string): Promise<Buffer> {
  switch (command) {
    case 'Settings': return handleSettings(body, userId, deviceId, protocolVersion);
    case 'Search': return handleSearch(body, userId);
    case 'MoveItems': return handleMoveItems(body, userId);
    case 'MeetingResponse': return handleMeetingResponse(body, userId);
    default: return handleResolveRecipients(body, userId);
  }
}

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'activesync', version: '0.7.0' });
});

// v6: shared error middleware (registered last)
app.use(errorMiddleware(log));

void initRuntimeLogLevel('activesync', { aliases: ['eas'] }); // BCP per-service log level
// v6: internal service behind the api-gateway — loopback by default
const HOST = resolveBindHost();
app.listen(PORT, HOST, () => {
  log.info({ port: PORT, host: HOST }, 'ActiveSync (EAS) server started');
});
