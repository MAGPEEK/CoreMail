import express, { type Request, type Response, type NextFunction } from 'express';
import { createLogger } from '@coremail/core/logger';
import { verifyPassword } from '@coremail/core/auth';
import { prisma } from '@coremail/storage/prisma';
import { decodeWbxml } from './wbxml.js';
import { handleProvision } from './commands/provision.js';
import { handleFolderSync } from './commands/folder-sync.js';
import { handleSync } from './commands/sync.js';
import { handleSendMail, handleSmartReply } from './commands/send-mail.js';
import { handlePing } from './commands/ping.js';

const log = createLogger('activesync');
const app = express();
const PORT = parseInt(process.env['EAS_PORT'] ?? '3005', 10);

// ─── Raw body parser for WBXML ────────────────────────────────────────────────
app.use('/Microsoft-Server-ActiveSync', express.raw({ type: '*/*', limit: '25mb' }));

// ─── Basic Auth middleware ────────────────────────────────────────────────────
async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers['authorization'] ?? '';
  if (!authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CoreMail ActiveSync"');
    res.status(401).send('Unauthorized');
    return;
  }

  const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  const colonIdx = credentials.indexOf(':');
  if (colonIdx === -1) {
    res.status(401).send('Unauthorized');
    return;
  }
  const email = credentials.slice(0, colonIdx);
  const password = credentials.slice(colonIdx + 1);

  const user = await prisma.user.findUnique({ where: { email, active: true } });
  if (!user || !user.passwordHash) {
    log.warn({ email }, 'EAS auth: user not found');
    res.status(401).send('Unauthorized');
    return;
  }

  // Check main password first, then app passwords
  let authenticated = await verifyPassword(password, user.passwordHash);
  if (!authenticated) {
    const appPasswords = await prisma.appPassword.findMany({ where: { userId: user.id } });
    for (const ap of appPasswords) {
      if (await verifyPassword(password, ap.hash)) {
        authenticated = true;
        await prisma.appPassword.update({ where: { id: ap.id }, data: { lastUsedAt: new Date() } });
        break;
      }
    }
  }

  if (!authenticated) {
    log.warn({ email }, 'EAS auth: invalid password');
    res.status(401).send('Unauthorized');
    return;
  }

  (req as Request & { easUser: { userId: string; email: string } }).easUser = {
    userId: user.id,
    email: user.email,
  };
  next();
}

// ─── OPTIONS — Autodiscover capability negotiation ────────────────────────────
app.options('/Microsoft-Server-ActiveSync', (_req: Request, res: Response) => {
  res.setHeader('MS-Server-ActiveSync', '14.1');
  res.setHeader('MS-ASProtocolVersions', '14.0,14.1');
  res.setHeader(
    'MS-ASProtocolCommands',
    'Sync,SendMail,SmartForward,SmartReply,GetAttachment,GetHierarchy,' +
    'CreateCollection,DeleteCollection,MoveCollection,FolderSync,FolderCreate,' +
    'FolderDelete,FolderUpdate,MoveItems,GetItemEstimate,MeetingResponse,' +
    'Provision,ResolveRecipients,ValidateCert,Find,Ping,Notify,Search,' +
    'Settings,ItemOperations',
  );
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
          const attachment = await prisma.attachment.findFirst({
            where: { id: attachmentName, message: { folder: { mailbox: { userId: user.userId } } } },
          });
          if (!attachment) { res.status(404).send('Not found'); return; }
          res.setHeader('Content-Type', attachment.mimeType);
          res.setHeader('Content-Length', String(attachment.size));
          res.status(200).end(); // In production, stream from MinIO
          break;
        }
        case 'Settings':
        case 'GetItemEstimate':
        case 'ItemOperations':
        case 'MeetingResponse':
        case 'ResolveRecipients':
        case 'Search':
        case 'MoveItems':
          // Return empty success for unsupported optional commands
          res.status(200).end();
          break;
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

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'activesync', version: '0.7.0' });
});

app.listen(PORT, () => {
  log.info({ port: PORT }, 'ActiveSync (EAS) server started');
});
