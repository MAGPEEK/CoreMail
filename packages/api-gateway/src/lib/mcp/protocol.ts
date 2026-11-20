/**
 * Admin MCP interface (10.3, docs/mcp.md) — JSON-RPC 2.0 framing of the Model
 * Context Protocol, revision 2025-06-18, Streamable HTTP transport. Pure
 * helpers, no I/O.
 *
 * The server answers every JSON-RPC request with one `application/json`
 * response (no SSE stream; GET /mcp → 405 as the transport allows), accepts
 * notifications and client responses with 202, and does not support JSON-RPC
 * batches (removed in 2025-06-18).
 */

/** The revision this server implements (answered to clients asking for it or for an unknown one). */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Revisions a client may negotiate. 2025-03-26 differs only in features this
 * server does not use (batching, which is refused either way).
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26'];

/** Revision assumed when a request carries no MCP-Protocol-Version header (transport spec). */
export const HEADER_DEFAULT_VERSION = '2025-03-26';

export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Server-defined (-32000…-32099): refused by a server policy (rate limit, origin). */
  SERVER_REFUSED: -32000,
} as const;

export type JsonRpcId = string | number;

export type ClassifiedMessage =
  | { kind: 'request'; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'response' }
  | { kind: 'invalid'; id: JsonRpcId | null; message: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isId = (v: unknown): v is JsonRpcId =>
  (typeof v === 'string' && v.length > 0 && v.length <= 256) || (typeof v === 'number' && Number.isFinite(v));

/** Pure: what a parsed POST body is. Arrays (batches) are `invalid`. */
export function classifyMessage(body: unknown): ClassifiedMessage {
  if (Array.isArray(body)) return { kind: 'invalid', id: null, message: 'Batch requests are not supported' };
  if (!isObject(body) || body['jsonrpc'] !== '2.0') return { kind: 'invalid', id: null, message: 'Not a JSON-RPC 2.0 message' };
  const rawId = body['id'];
  const id = isId(rawId) ? rawId : null;
  if (typeof body['method'] === 'string') {
    const method = body['method'];
    const rawParams = body['params'];
    if (rawParams !== undefined && !isObject(rawParams)) {
      return { kind: 'invalid', id, message: 'params must be an object' };
    }
    const params = (rawParams ?? {}) as Record<string, unknown>;
    if (!('id' in body)) return { kind: 'notification', method, params };
    // MCP: a request id is a string or a number, never null
    if (id === null) return { kind: 'invalid', id: null, message: 'Invalid request id' };
    return { kind: 'request', id, method, params };
  }
  if ('result' in body || 'error' in body) return { kind: 'response' };
  return { kind: 'invalid', id, message: 'Not a JSON-RPC request, notification or response' };
}

/** Pure: the revision answered to `initialize` (the requested one when supported, else ours). */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested : MCP_PROTOCOL_VERSION;
}

/** Pure: is the MCP-Protocol-Version header acceptable? (Absent → the transport default.) */
export function headerVersionSupported(header: string | undefined): boolean {
  return header === undefined || header === '' || SUPPORTED_PROTOCOL_VERSIONS.includes(header.trim());
}

/** Pure: may the response be `application/json`? A missing Accept header is accepted. */
export function acceptsJson(accept: string | undefined): boolean {
  if (!accept) return true;
  return accept.split(',').some((part) => {
    const type = part.split(';')[0]!.trim().toLowerCase();
    return type === 'application/json' || type === 'application/*' || type === '*/*';
  });
}

/** Pure: is the request body declared as JSON? */
export function isJsonContentType(contentType: string | undefined): boolean {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';
}

export function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
