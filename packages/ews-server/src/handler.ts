import type { Request, Response } from 'express';
import { parseSoapRequest } from './soap/parser.js';
import { errorResponse } from './soap/response.js';
import { createLogger } from '@coremail/core';
import { findItem } from './operations/find-item.js';
import { getItem } from './operations/get-item.js';
import { createItem } from './operations/create-item.js';
import { updateItem } from './operations/update-item.js';
import { deleteItem } from './operations/delete-item.js';
import { syncFolderHierarchy, syncFolderItems } from './operations/sync-folder.js';
import { resolveNames } from './operations/resolve-names.js';
import { getUserAvailability } from './operations/get-user-availability.js';
import { subscribe, unsubscribe, getStreamingEvents } from './operations/subscription.js';
import { moveItem, copyItem } from './operations/move-copy-item.js';

const log = createLogger('ews:handler');

export async function handleEwsRequest(req: Request, res: Response): Promise<void> {
  const user = req.ewsUser;
  if (!user) {
    res.status(401).send(errorResponse('EWS', 'ErrorAccessDenied', 'Not authenticated'));
    return;
  }

  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const envelope = await parseSoapRequest(body);

  if (!envelope) {
    res.status(400).send(errorResponse('EWS', 'ErrorSchemaValidation', 'Invalid SOAP request'));
    return;
  }

  log.debug({ action: envelope.action, userId: user.userId }, 'EWS request');

  let responseXml: string;

  try {
    switch (envelope.action) {
      case 'FindItem':
        responseXml = await findItem(envelope.requestBody, user);
        break;

      case 'GetItem':
        responseXml = await getItem(envelope.requestBody, user);
        break;

      case 'CreateItem':
        responseXml = await createItem(envelope.requestBody, user);
        break;

      case 'UpdateItem':
        responseXml = await updateItem(envelope.requestBody, user);
        break;

      case 'DeleteItem':
        responseXml = await deleteItem(envelope.requestBody, user);
        break;

      case 'MoveItem':
        responseXml = await moveItem(envelope.requestBody, user);
        break;

      case 'CopyItem':
        responseXml = await copyItem(envelope.requestBody, user);
        break;

      case 'SyncFolderHierarchy':
        responseXml = await syncFolderHierarchy(envelope.requestBody, user);
        break;

      case 'SyncFolderItems':
        responseXml = await syncFolderItems(envelope.requestBody, user);
        break;

      case 'ResolveNames':
        responseXml = await resolveNames(envelope.requestBody, user);
        break;

      case 'GetUserAvailability':
        responseXml = await getUserAvailability(envelope.requestBody, user);
        break;

      case 'Subscribe':
        responseXml = await subscribe(envelope.requestBody, user);
        break;

      case 'Unsubscribe':
        responseXml = await unsubscribe(envelope.requestBody, user);
        break;

      case 'GetStreamingEvents':
        // Streaming: hands off to long-poll handler — response sent directly
        await getStreamingEvents(envelope.requestBody, user, res);
        return;

      default:
        log.warn({ action: envelope.action }, 'Unknown EWS action');
        responseXml = errorResponse(
          envelope.action,
          'ErrorInvalidRequest',
          `Operation ${envelope.action} not supported`,
        );
    }
  } catch (err) {
    log.error({ err, action: envelope.action }, 'EWS operation failed');
    responseXml = errorResponse(envelope.action, 'ErrorInternalServerError', 'Internal server error');
  }

  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(responseXml);
}
