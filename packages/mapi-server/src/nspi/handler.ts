/**
 * The address book endpoint /mapi/nspi (MS-OXCMAPIHTTP 2.2.5). Routing,
 * validation and authentication are in place; PING answers. The address book
 * request types answer 16 "Endpoint Disabled" until the address book
 * implementation is added (it plugs in here, keyed by X-RequestType).
 */
import type { RequestHandler } from 'express';
import { ResponseCode } from '../http/envelope.js';
import { respondFailure, respondStreaming } from '../http/responder.js';
import { admit, type EmsmdbDeps } from '../emsmdb/handler.js';

export function nspiHandler(deps: Pick<EmsmdbDeps, 'authenticate' | 'config'>): RequestHandler {
  return async (req, res) => {
    const admitted = await admit('nspi', req, res, deps.authenticate);
    if (!admitted) return;
    const { h } = admitted;
    if (h.requestType === 'PING') {
      await respondStreaming(res, h, { pendingMs: deps.config.pendingMs, expirationMs: deps.config.idleMs },
        async () => ({ responseCode: ResponseCode.Success, body: Buffer.alloc(0) }));
      return;
    }
    respondFailure(res, h, ResponseCode.EndpointDisabled, 'address book endpoint not available');
  };
}
