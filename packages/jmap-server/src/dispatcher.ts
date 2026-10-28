/**
 * Request processing (RFC 8620 §3.2–3.7): check capabilities, execute method calls
 * sequentially, resolve result references (`#arg` → {resultOf,name,path}),
 * pass creation ids (`#creationId`) through, wrap errors.
 */
import { createLogger } from '@coremail/core';
import { MethodError, RequestError } from './errors.js';
import { ALL_CAPABILITIES, CAP_CORE } from './capabilities.js';
import { LIMITS } from './limits.js';
import type {
  AccountContext, HandlerResult, Invocation, JmapRequest, JmapResponse, JmapUser,
  JsonObject, MethodContext, MethodDefinition, MethodHandler,
} from './types.js';

const log = createLogger('jmap:dispatch');
const METHODS = new Map<string, MethodDefinition>();

export function registerMethod(name: string, capability: string, handler: MethodHandler): void {
  METHODS.set(name, { capability, handler });
}

export function listMethods(): string[] {
  return [...METHODS.keys()].sort();
}

export function parseRequest(body: unknown): JmapRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('notRequest', 400, 'Request body is not a JMAP Request object');
  }
  const b = body as JsonObject;
  if (!Array.isArray(b['using']) || !b['using'].every((u) => typeof u === 'string')) {
    throw new RequestError('notRequest', 400, '"using" must be a String[]');
  }
  if (!Array.isArray(b['methodCalls'])) {
    throw new RequestError('notRequest', 400, '"methodCalls" must be an Invocation[]');
  }
  for (const c of b['methodCalls']) {
    if (!Array.isArray(c) || c.length !== 3 || typeof c[0] !== 'string' || typeof c[2] !== 'string'
      || !c[1] || typeof c[1] !== 'object' || Array.isArray(c[1])) {
      throw new RequestError('notRequest', 400, 'Invalid Invocation in methodCalls');
    }
  }
  for (const u of b['using'] as string[]) {
    if (!ALL_CAPABILITIES.includes(u)) {
      throw new RequestError('unknownCapability', 400, `Unknown capability: ${u}`);
    }
  }
  if (b['methodCalls'].length > LIMITS.maxCallsInRequest) {
    throw new RequestError('limit', 400, 'Too many method calls', { limit: 'maxCallsInRequest' });
  }
  const createdIds = b['createdIds'];
  if (createdIds !== undefined && (typeof createdIds !== 'object' || createdIds === null || Array.isArray(createdIds))) {
    throw new RequestError('notRequest', 400, '"createdIds" must be an object');
  }
  return {
    using: b['using'] as string[],
    methodCalls: b['methodCalls'] as Invocation[],
    ...(createdIds ? { createdIds: createdIds as Record<string, string> } : {}),
  };
}

// ── Result references (RFC 8620 §3.7) ────────────────────────────────────────

function evalPointer(value: unknown, tokens: string[]): unknown {
  if (tokens.length === 0) return value;
  const [tok, ...rest] = tokens;
  const t = tok!.replace(/~1/g, '/').replace(/~0/g, '~');
  if (t === '*') {
    if (!Array.isArray(value)) throw new MethodError('invalidResultReference', 'Wildcard on non-array');
    const results = value.map((v) => evalPointer(v, rest));
    // JMAP extension: arrays are merged flat
    return results.flatMap((r) => (Array.isArray(r) ? r : [r]));
  }
  if (Array.isArray(value)) {
    const idx = Number(t);
    if (!Number.isInteger(idx) || idx < 0 || idx >= value.length) throw new MethodError('invalidResultReference', `Index ${t} out of range`);
    return evalPointer(value[idx], rest);
  }
  if (value && typeof value === 'object' && t in (value as JsonObject)) {
    return evalPointer((value as JsonObject)[t], rest);
  }
  throw new MethodError('invalidResultReference', `Path segment "${t}" not found`);
}

function resolveReferences(args: JsonObject, responses: Invocation[]): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith('#')) { out[key] = value; continue; }
    const plain = key.slice(1);
    if (plain in args) throw new MethodError('invalidArguments', `Both "${plain}" and "${key}" given`);
    if (!value || typeof value !== 'object') throw new MethodError('invalidResultReference', 'ResultReference must be an object');
    const ref = value as { resultOf?: unknown; name?: unknown; path?: unknown };
    if (typeof ref.resultOf !== 'string' || typeof ref.name !== 'string' || typeof ref.path !== 'string') {
      throw new MethodError('invalidResultReference', 'ResultReference needs resultOf/name/path');
    }
    const match = responses.find((r) => r[2] === ref.resultOf);
    if (!match) throw new MethodError('invalidResultReference', `No response with methodCallId ${ref.resultOf}`);
    if (match[0] !== ref.name) throw new MethodError('invalidResultReference', `Response name mismatch: ${match[0]} ≠ ${ref.name}`);
    const path = ref.path.startsWith('/') ? ref.path.slice(1) : ref.path;
    out[plain] = path === '' ? match[1] : evalPointer(match[1], path.split('/'));
  }
  return out;
}

// ── Execution ───────────────────────────────────────────────────────────────

export async function processRequest(
  req: JmapRequest,
  user: JmapUser,
  accounts: Map<string, AccountContext>,
  sessionState: string,
): Promise<JmapResponse> {
  const using = new Set(req.using);
  using.add(CAP_CORE);
  const createdIds = new Map<string, string>(Object.entries(req.createdIds ?? {}));
  const responses: Invocation[] = [];

  const ctx: MethodContext = {
    user, accounts, createdIds, responses, using,
    resolveId(id: string): string {
      if (id.startsWith('#')) {
        const real = createdIds.get(id.slice(1));
        if (!real) throw new MethodError('invalidArguments', `Unknown creation id ${id}`);
        return real;
      }
      return id;
    },
    account(accountId: unknown): AccountContext {
      if (typeof accountId !== 'string') throw new MethodError('invalidArguments', 'accountId must be a String');
      const acc = accounts.get(accountId);
      if (!acc) throw new MethodError('accountNotFound');
      return acc;
    },
  };

  for (const [name, rawArgs, callId] of req.methodCalls) {
    const def = METHODS.get(name);
    if (!def || !using.has(def.capability)) {
      responses.push(['error', { type: 'unknownMethod' }, callId]);
      continue;
    }
    try {
      const args = resolveReferences(rawArgs, responses);
      const result: HandlerResult = await def.handler(args, ctx, callId);
      if (Array.isArray(result)) {
        for (const r of result) responses.push([r.name, r.args, callId]);
      } else {
        responses.push([name, result, callId]);
      }
    } catch (err) {
      if (err instanceof MethodError) {
        responses.push(['error', err.toJson(), callId]);
      } else {
        log.error({ err, method: name }, 'Unexpected error in JMAP method');
        responses.push(['error', { type: 'serverFail', description: err instanceof Error ? err.message : String(err) }, callId]);
      }
    }
  }

  return {
    methodResponses: responses,
    ...(createdIds.size ? { createdIds: Object.fromEntries(createdIds) } : {}),
    sessionState,
  };
}
