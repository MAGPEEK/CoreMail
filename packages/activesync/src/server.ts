import { initRuntimeLogLevel, startAuthInvalidationSubscriber, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { registerLdapMailVerifier } from '@coremail/auth-ldap';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createLogger } from '@coremail/core/logger';
import { installProcessGuards, installAsyncErrorHandling, errorMiddleware, resolveBindHost } from '@coremail/core/http';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth, type EasUser } from './auth.js';
import { easLiveRequests } from './live-sessions.js';
import { decodeWbxml, type WbxmlElement } from './wbxml.js';
import { EAS_COMMANDS } from './commands.js';
import { EAS_VERSIONS, HIGHEST_EAS_VERSION, supports, type EasVersion } from './protocol-version.js';
import { versionForDevice, warnedDevices, type DeviceVersionDeps } from './device-version.js';
import { parseRequestLine, type EasCommandParams } from './request.js';
import { EasHttpError } from './http-error.js';
import { handleProvision } from './commands/provision.js';
import { handleFolderSync } from './commands/folder-sync.js';
import { handleSync, emptySyncResponse } from './commands/sync.js';
import { deviceAccess, deniedResponse } from './device-policy.js';
import { readFileSync } from 'node:fs';
import { handleSendMail, handleLegacySendMail, defaultSendMailDeps, type ComposeCommand } from './commands/send-mail.js';
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
import { waitForObjectStorage, clearMessageSizeLimitCache } from '@coremail/storage';
import { easBodyParser } from './body-limit.js';

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
// 9.4: the cap follows the configured maximum message size (body-limit.ts)
app.use('/Microsoft-Server-ActiveSync', easBodyParser());

// ─── OPTIONS — Autodiscover capability negotiation ────────────────────────────
app.options('/Microsoft-Server-ActiveSync', (_req: Request, res: Response) => {
  res.setHeader('MS-Server-ActiveSync', HIGHEST_EAS_VERSION);
  res.setHeader('MS-ASProtocolVersions', EAS_VERSIONS.join(','));
  res.setHeader('MS-ASProtocolCommands', EAS_COMMANDS.join(','));
  res.status(200).end();
});

/** The URL query without `?` (the base64 request line is not a key=value query). */
function rawQueryOf(req: Request): string {
  const i = req.originalUrl.indexOf('?');
  return i < 0 ? '' : req.originalUrl.slice(i + 1);
}

/** Answers the request with a bare HTTP status (no WBXML body). */
function sendStatusOnly(res: Response, httpStatus: number): void {
  res.removeHeader('Content-Type');
  res.status(httpStatus).end();
}

const deviceVersionDeps: DeviceVersionDeps = {
  saveVersion: (id, version) => prisma.activeSyncDevice.update({ where: { id }, data: { protocolVersion: version } }),
  warn: (fields, message) => log.warn(fields, message),
  warned: warnedDevices,
};

// ─── POST — Main command dispatcher ──────────────────────────────────────────
app.post(
  '/Microsoft-Server-ActiveSync',
  requireAuth as express.RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const user = (req as Request & { easUser: EasUser }).easUser;
    res.setHeader('MS-Server-ActiveSync', HIGHEST_EAS_VERSION);
    res.setHeader('Content-Type', 'application/vnd.ms-sync.wbxml');

    // Plain query + headers, or the base64-encoded request line ([MS-ASHTTP]).
    const parsed = parseRequestLine(rawQueryOf(req), (name) => req.get(name));
    if (!parsed.ok) {
      log.info({ userId: user.userId, reason: parsed.reason }, 'EAS request line refused');
      res.status(400).send('Invalid request line');
      return;
    }
    const { command, deviceId, deviceType, params } = parsed.line;
    if (!command) {
      res.status(400).send('Missing Cmd');
      return;
    }

    try {
      const device = await prisma.activeSyncDevice.findUnique({
        where: { userId_deviceId: { userId: user.userId, deviceId } },
        select: { id: true, status: true, policyKey: true, protocolVersion: true },
      });
      // Protocol version: the requested one (unannounced → highest), else the device's last one.
      const requestedVersion = parsed.line.protocolVersion;
      const version = await versionForDevice({ userId: user.userId, deviceId, requested: requestedVersion }, device, deviceVersionDeps);

      // Device access: provisioned, current policy key, not blocked / wiped ([MS-ASPROV]).
      const access = deviceAccess(device, command, parsed.line.policyKey);
      if (!access.allow) {
        const denied = deniedResponse(command, access.status, version, parsed.line.policyKey);
        log.info({ userId: user.userId, deviceId, command, version, status: access.status }, 'EAS request refused by device policy');
        if (denied.body) res.status(denied.httpStatus).send(denied.body);
        else sendStatusOnly(res, denied.httpStatus);
        return;
      }

      const handler = HANDLERS[command];
      if (!handler) {
        log.warn({ command }, 'Unknown EAS command');
        res.status(501).send('Not implemented');
        return;
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (handler.needsBody && raw.length === 0) {
        if (command === 'Sync') { res.status(200).send(emptySyncResponse()); return; }
        res.status(400).send('Missing body');
        return;
      }
      let body: WbxmlElement | null = null;
      if (raw.length > 0 && !handler.mimeBody?.(version)) {
        try {
          body = decodeWbxml(raw);
        } catch (err) {
          log.error({ err, command }, 'WBXML decode error');
          res.status(400).send('Invalid WBXML');
          return;
        }
      }
      await handler.run({ req, res, body: body as WbxmlElement, raw, user, deviceId, deviceType, version, requestedVersion, params });
    } catch (err) {
      if (err instanceof EasHttpError) {
        log.info({ userId: user.userId, deviceId, command, httpStatus: err.httpStatus }, `EAS ${err.message}`);
        if (!res.headersSent) sendStatusOnly(res, err.httpStatus);
        return;
      }
      log.error({ err, command }, 'EAS command error');
      if (!res.headersSent) res.status(500).send('Internal server error');
    }
  },
);

interface CommandContext {
  req: Request;
  res: Response;
  /** Decoded WBXML request (null for an empty body, and for a MIME body — see `raw`). */
  body: WbxmlElement;
  /** The request body octets (the MIME message of a 12.1 SendMail/SmartReply/SmartForward). */
  raw: Buffer;
  user: EasUser;
  deviceId: string;
  deviceType: string;
  /** Negotiated protocol version. */
  version: EasVersion;
  /**
   * The version the request names, as sent ('' = none). Only MeetingResponse reads it: an
   * unannounced 16.x client keeps the server-sent meeting reply it asks for (as before 9.4).
   */
  requestedVersion: string;
  /** Command parameters of the request line. */
  params: EasCommandParams;
}

interface CommandHandler {
  needsBody: boolean;
  /** True when, in this version, the body is a MIME message instead of WBXML. */
  mimeBody?: (version: EasVersion) => boolean;
  run: (c: CommandContext) => Promise<void>;
}

/** Reply with a WBXML buffer. */
const wbxml = (run: (c: CommandContext) => Promise<Buffer>) => async (c: CommandContext) => { c.res.status(200).send(await run(c)); };

/** 12.1 sends compose commands as raw MIME (ComposeMail WBXML is 14.0+). */
const legacyCompose = (version: EasVersion) => !supports(version, 'composeMailWbxml');

/**
 * SendMail / SmartReply / SmartForward: ComposeMail WBXML (14.0+; success = empty response,
 * [MS-ASCMD] 2.2.1.17) or MIME + request line (12.1, no response body).
 */
const compose = (command: ComposeCommand) => async (c: CommandContext): Promise<void> => {
  if (!legacyCompose(c.version)) {
    const body = await handleSendMail(c.body, c.user.userId, command, defaultSendMailDeps, c.deviceId);
    if (body.length === 0) sendStatusOnly(c.res, 200);
    else c.res.status(200).send(body);
    return;
  }
  sendStatusOnly(c.res, await handleLegacySendMail(c.raw, c.params, c.user.userId, command, defaultSendMailDeps, c.deviceId));
};

const HANDLERS: Record<string, CommandHandler> = {
  Provision: { needsBody: true, run: wbxml((c) => handleProvision(c.body, c.user.userId, c.deviceId, c.deviceType, c.version)) },
  FolderSync: { needsBody: true, run: wbxml((c) => handleFolderSync(c.body, c.user.userId, c.deviceId)) },
  Sync: { needsBody: true, run: wbxml((c) => handleSync(c.body, c.user.userId, c.deviceId, {}, c.version)) },
  SendMail: { needsBody: true, mimeBody: legacyCompose, run: compose('SendMail') },
  SmartReply: { needsBody: true, mimeBody: legacyCompose, run: compose('SmartReply') },
  SmartForward: { needsBody: true, mimeBody: legacyCompose, run: compose('SmartForward') },
  // Ping holds the connection; an empty Ping reuses the device's last parameters.
  Ping: { needsBody: false, run: (c) => handlePing(c.raw.length ? c.body : null, c.user.userId, c.res, c.user, { deviceId: c.deviceId }) },
  GetAttachment: {
    needsBody: false,
    run: async ({ res, user, params }) => {
      const attachmentName = params.attachmentName;
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
  ItemOperations: { needsBody: true, run: wbxml((c) => handleItemOperations(c.body, c.user.userId, prismaItemOperationsDeps((msg, err) => log.warn({ err }, msg)), c.version)) },
  GetItemEstimate: { needsBody: true, run: wbxml((c) => handleGetItemEstimate(c.body, c.user.userId, c.deviceId, undefined, c.version)) },
  Settings: { needsBody: true, run: wbxml((c) => handleSettings(c.body, c.user.userId, c.deviceId, c.version)) },
  Search: { needsBody: true, run: wbxml((c) => handleSearch(c.body, c.user.userId)) },
  MoveItems: { needsBody: true, run: wbxml((c) => handleMoveItems(c.body, c.user.userId, c.deviceId)) },
  MeetingResponse: { needsBody: true, run: wbxml((c) => handleMeetingResponse(c.body, c.user.userId, undefined, c.requestedVersion || c.version)) },
  ResolveRecipients: { needsBody: true, run: wbxml((c) => handleResolveRecipients(c.body, c.user.userId, c.version)) },
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
// 9.4: a settings save (BCP → SMTP / Settings → Mail) applies the message size limit and
// the request-body cap at once instead of after the 60 s cache.
try {
  const settingsSub = getRedisClient().duplicate();
  settingsSub.on('error', (err) => log.warn({ err }, 'Settings subscriber Redis error'));
  void settingsSub.subscribe(CHANNEL_SETTINGS_RELOAD);
  settingsSub.on('message', () => clearMessageSizeLimitCache());
} catch (err) {
  log.warn({ err }, 'Redis subscription failed — the message size limit refreshes after 60 s');
}
// v6: internal service behind the api-gateway — loopback by default
const HOST = resolveBindHost();
// v7.1: no listener while the object storage misses the referenced objects
void waitForObjectStorage('activesync').then(() => {
  app.listen(PORT, HOST, () => {
    log.info({ port: PORT, host: HOST }, 'ActiveSync (EAS) server started');
  });
});
