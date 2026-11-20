/**
 * Admin MCP interface (10.3) — the `/mcp` endpoint (Model Context Protocol
 * 2025-06-18, Streamable HTTP transport). docs/mcp.md.
 *
 * Order of the checks on every request:
 *   1. switch (ServerSettings.mcpEnabled) off           → 404, same body as any unknown path
 *   2. client IP not in the allowlist (if one is set)   → 404 as well (no hint)
 *   3. Origin header present but not a configured host  → 403 (DNS rebinding protection)
 *   4. client IP locked by the shared login lockout     → 429
 *   5. bearer MCP token (lib/mcp/tokens.ts)             → 401 + `WWW-Authenticate: Bearer`
 *      (unknown / malformed tokens count against the client IP like failed logins)
 *   6. POST: JSON-RPC message; DELETE: end the session; GET: 405 (no server stream)
 *
 * Authorization is not done with OAuth (MCP authorization is optional for HTTP
 * servers): the endpoint publishes no authorization-server metadata and accepts
 * only personal MCP tokens. Tools run as the token's admin (tools.ts, dispatch.ts).
 */
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { createLogger } from '@coremail/core';
import { sharedLoginLockout } from '@coremail/storage';
import { createUserRateLimiter, envInt } from '../user-rate-limit.js';
import { audit } from '../audit.js';
import { isScoped } from '../admin-scope.js';
import {
  JSONRPC_ERRORS, MCP_PROTOCOL_VERSION, acceptsJson, classifyMessage, headerVersionSupported, isJsonContentType,
  negotiateVersion, rpcError, rpcResult, type JsonRpcId,
} from './protocol.js';
import { ipAllowed, originAllowed } from './net.js';
import { allowedOrigins, getMcpSettings } from './settings.js';
import { verifyMcpToken, type VerifiedMcpToken } from './tokens.js';
import { createSession, endSession, getSession, type McpSession } from './sessions.js';
import { describeTool, toolsFor, ToolError, type McpTool } from './tools.js';
import { dispatchAdmin } from './dispatch.js';
import { capResult, redactArguments, stripSecrets } from './result.js';

const log = createLogger('mcp');

/** Request body limit (MCP_MAX_BODY_KB, default 64 KiB). */
const bodyLimitKb = (): number => Math.min(Math.max(envInt('MCP_MAX_BODY_KB', 64), 1), 1024);
/** Tool result cap (MCP_MAX_RESULT_KB, default 256 KiB). */
export const resultLimitBytes = (): number => Math.min(Math.max(envInt('MCP_MAX_RESULT_KB', 256), 4), 4096) * 1024;

/** Tool calls per token and minute (MCP_RATE_LIMIT_PER_MINUTE, default 60; 0 = off). */
export const toolRateLimiter = createUserRateLimiter({
  scope: 'mcp-tool',
  limit: envInt('MCP_RATE_LIMIT_PER_MINUTE', 60),
  windowSec: 60,
});

/** Version reported in serverInfo (COREMAIL_VERSION, else the api-gateway package version). */
const SERVER_VERSION: string = (() => {
  if (process.env['COREMAIL_VERSION']) return process.env['COREMAIL_VERSION'];
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const SERVER_INFO = { name: 'coremail-admin', title: 'CoreMail administration', version: SERVER_VERSION };
const INSTRUCTIONS = 'Administration of a CoreMail mail server. Every tool runs with the role and management scope of the '
  + 'admin who owns the token; objects outside that scope are reported as not found. Mailboxes and domains cannot be '
  + 'deleted through this interface, and no tool returns passwords or keys.';

const notFound = (res: Response): void => { res.status(404).json({ error: 'Not found' }); };

function unauthorized(res: Response, invalid: boolean): void {
  res.setHeader('WWW-Authenticate', invalid ? 'Bearer realm="CoreMail MCP", error="invalid_token"' : 'Bearer realm="CoreMail MCP"');
  res.status(401).json({ error: invalid ? 'Invalid or expired token' : 'Authorization required' });
}

interface McpRequestState { token: VerifiedMcpToken; authStartedAt: number }

/** Steps 1–5. Calls next() with `res.locals.mcp` set, or answers. */
function gate(req: Request, res: Response, next: NextFunction): void {
  const authStartedAt = Date.now();
  const ip = req.ip ?? '';
  void (async () => {
    const settings = await getMcpSettings();
    if (!settings.enabled || !ipAllowed(ip, settings.allowedIps)) { notFound(res); return; }
    if (!originAllowed(req.get('origin'), settings.publicHostname ? [settings.publicHostname] : [], allowedOrigins())) {
      log.warn({ ip, origin: req.get('origin')?.slice(0, 200) }, 'MCP request with a foreign Origin refused');
      res.status(403).json(rpcError(null, JSONRPC_ERRORS.SERVER_REFUSED, 'Forbidden: Origin not allowed'));
      return;
    }
    const lockout = sharedLoginLockout();
    const locked = await lockout.ipLockedFor(ip);
    if (locked > 0) {
      res.setHeader('Retry-After', String(locked));
      res.status(429).json({ error: 'Too many failed attempts — try again later', code: 'LOCKED' });
      return;
    }
    const header = req.get('authorization') ?? '';
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!m) { unauthorized(res, false); return; }
    const check = await verifyMcpToken(m[1]!, ip);
    if (!check.ok) {
      if (check.reason === 'mfa') { res.status(403).json({ error: check.error, code: check.code }); return; }
      if (check.reason === 'unknown' || check.reason === 'malformed') await lockout.failIp(ip);
      log.info({ ip, reason: check.reason }, 'MCP token refused');
      unauthorized(res, true);
      return;
    }
    res.locals['mcp'] = { token: check.token, authStartedAt } satisfies McpRequestState;
    next();
  })().catch((err: unknown) => {
    log.error({ err }, 'MCP request check failed');
    if (!res.headersSent) res.status(503).json({ error: 'Service temporarily unavailable' });
  });
}

/** JSON body parser with the MCP limit; parse errors answer a JSON-RPC parse error. */
function jsonBody(req: Request, res: Response, next: NextFunction): void {
  if (!isJsonContentType(req.get('content-type'))) {
    res.status(415).json(rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Content-Type must be application/json'));
    return;
  }
  express.json({ limit: `${bodyLimitKb()}kb`, strict: false })(req, res, (err?: unknown) => {
    if (!err) { next(); return; }
    const e = err as { type?: string; status?: number };
    if (e.type === 'entity.too.large') {
      res.status(413).json(rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Request body too large'));
      return;
    }
    res.status(400).json(rpcError(null, JSONRPC_ERRORS.PARSE_ERROR, 'Parse error'));
  });
}

interface CallContext {
  req: Request;
  token: VerifiedMcpToken;
  session: McpSession | null;
}

/** tools/call: validation, rate limit, run, audit. Returns a JSON-RPC result or error object. */
async function callTool(id: JsonRpcId, params: Record<string, unknown>, c: CallContext, res: Response): Promise<Record<string, unknown> | null> {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const rawArgs = params['arguments'] ?? {};
  const scoped = isScoped(c.token.scope);
  const tool: McpTool | undefined = toolsFor(c.token.mode, c.token.role, scoped).find((t) => t.name === name);
  if (!tool) return rpcError(id, JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${name.slice(0, 100)}`);

  const decision = await toolRateLimiter.hit(c.token.tokenId);
  if (!decision.allowed) {
    res.setHeader('Retry-After', String(decision.retryAfterSec));
    res.status(429);
    return rpcError(id, JSONRPC_ERRORS.SERVER_REFUSED, 'Rate limit exceeded — too many tool calls with this token', { retryAfter: decision.retryAfterSec });
  }

  const ip = c.req.ip ?? '';
  const userAgent = c.req.get('user-agent') ?? '';
  const argsForAudit = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? redactArguments(rawArgs as Record<string, unknown>) : {};
  const writeAudit = (success: boolean, extra: { target?: { type: string; id?: string; name?: string }; error?: string; fields?: Record<string, unknown> }): void => {
    audit({
      actorId: c.token.userId,
      actorEmail: c.token.email,
      action: `mcp.tool.${tool.name}`,
      targetType: extra.target?.type ?? 'mcp-tool',
      ...(extra.target?.id ? { targetId: extra.target.id } : {}),
      ...(extra.target?.name ? { targetName: extra.target.name } : {}),
      ipAddress: ip,
      userAgent,
      changes: {
        tokenId: c.token.tokenId,
        tokenName: c.token.tokenName,
        mode: tool.mode,
        arguments: argsForAudit,
        ...(c.session ? { client: c.session.clientName || undefined } : {}),
        ...(extra.fields ?? {}),
      },
      success,
      ...(extra.error ? { errorMsg: extra.error.slice(0, 500) } : {}),
    });
  };

  const parsed = tool.input.safeParse(rawArgs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? ` (${issue.path.join('.')})` : '';
    const message = `Invalid arguments: ${issue?.message ?? 'invalid input'}${where}`;
    writeAudit(false, { error: message });
    return rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });
  }

  const ctx = {
    role: c.token.role,
    scoped,
    call: (r: Parameters<typeof dispatchAdmin>[1]) => {
      // defence in depth: a read token never reaches a mutating route
      if (c.token.mode !== 'write' && r.method !== 'GET') return Promise.reject(new ToolError('Read-only token', 403));
      return dispatchAdmin(
        { userId: c.token.userId, email: c.token.email, role: c.token.role, domainId: c.token.domainId, mfaVerified: c.token.mfaVerified },
        r, { ip, userAgent: `mcp/${userAgent}` },
      );
    },
  };
  try {
    const out = await tool.run(parsed.data, ctx);
    // Secret fields are dropped at any depth (result.ts). The one intended
    // exception is `initialPassword` of create_mailbox (generated, shown once) —
    // it is not a stored secret and not on the list.
    const data = stripSecrets(out.data);
    writeAudit(true, { ...(out.target ? { target: out.target } : {}), ...(out.audit ? { fields: out.audit } : {}) });
    return rpcResult(id, { content: [{ type: 'text', text: capResult(data, resultLimitBytes()) }], isError: false });
  } catch (err) {
    if (err instanceof ToolError) {
      writeAudit(false, { error: err.message });
      return rpcResult(id, { content: [{ type: 'text', text: err.message }], isError: true });
    }
    log.error({ err, tool: tool.name }, 'MCP tool failed');
    writeAudit(false, { error: 'internal error' });
    return rpcResult(id, { content: [{ type: 'text', text: 'The tool failed with an internal error.' }], isError: true });
  }
}

async function handlePost(req: Request, res: Response): Promise<void> {
  const { token, authStartedAt } = res.locals['mcp'] as McpRequestState;
  if (!acceptsJson(req.get('accept'))) {
    res.status(406).json(rpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Not acceptable: the client must accept application/json'));
    return;
  }
  const msg = classifyMessage(req.body);
  if (msg.kind === 'invalid') { res.status(400).json(rpcError(msg.id, JSONRPC_ERRORS.INVALID_REQUEST, msg.message)); return; }

  // initialize opens a session; everything else needs one
  if (msg.kind === 'request' && msg.method === 'initialize') {
    const version = negotiateVersion(msg.params['protocolVersion']);
    const clientInfo = msg.params['clientInfo'] as { name?: unknown; version?: unknown } | undefined;
    const clientName = typeof clientInfo?.name === 'string' ? `${clientInfo.name}${typeof clientInfo.version === 'string' ? ` ${clientInfo.version}` : ''}` : '';
    const session = createSession({ tokenId: token.tokenId, userId: token.userId, protocolVersion: version, clientName, authStartedAt });
    res.setHeader('Mcp-Session-Id', session.id);
    res.json(rpcResult(msg.id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
    }));
    return;
  }

  const sessionId = req.get('mcp-session-id');
  if (!sessionId) {
    res.status(400).json(rpcError(msg.kind === 'request' ? msg.id : null, JSONRPC_ERRORS.INVALID_REQUEST, 'Bad Request: Mcp-Session-Id header is required'));
    return;
  }
  const session = getSession(sessionId, token.tokenId);
  if (!session) {
    res.status(404).json(rpcError(msg.kind === 'request' ? msg.id : null, JSONRPC_ERRORS.INVALID_REQUEST, 'Session not found'));
    return;
  }
  if (!headerVersionSupported(req.get('mcp-protocol-version'))) {
    res.status(400).json(rpcError(msg.kind === 'request' ? msg.id : null, JSONRPC_ERRORS.INVALID_REQUEST,
      `Bad Request: unsupported MCP-Protocol-Version (supported: ${MCP_PROTOCOL_VERSION})`));
    return;
  }
  if (msg.kind !== 'request') { res.status(202).end(); return; } // notifications + client responses

  const scoped = isScoped(token.scope);
  switch (msg.method) {
    case 'ping':
      res.json(rpcResult(msg.id, {}));
      return;
    case 'tools/list':
      res.json(rpcResult(msg.id, { tools: toolsFor(token.mode, token.role, scoped).map(describeTool) }));
      return;
    case 'tools/call': {
      const out = await callTool(msg.id, msg.params, { req, token, session }, res);
      if (out) res.json(out);
      return;
    }
    default:
      res.json(rpcError(msg.id, JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${msg.method.slice(0, 100)}`));
  }
}

/** The /mcp router (mounted before the global JSON body parser — own limit). */
export function createMcpRouter(): Router {
  const router = Router();
  router.use(gate);
  router.post('/', jsonBody, (req, res, next) => { handlePost(req, res).catch(next); });
  router.delete('/', (req, res) => {
    const { token } = res.locals['mcp'] as McpRequestState;
    const id = req.get('mcp-session-id');
    if (!id) { res.status(400).json({ error: 'Mcp-Session-Id header is required' }); return; }
    if (!endSession(id, token.tokenId)) { res.status(404).json({ error: 'Session not found' }); return; }
    res.status(204).end();
  });
  // No server-initiated stream: the transport allows 405 for GET.
  router.get('/', (_req, res) => { res.setHeader('Allow', 'POST, DELETE'); res.status(405).json({ error: 'Method not allowed' }); });
  router.all('/', (_req, res) => { res.setHeader('Allow', 'POST, DELETE'); res.status(405).json({ error: 'Method not allowed' }); });
  // sub-paths do not exist
  router.use((_req, res) => notFound(res));
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, 'MCP request failed');
    if (!res.headersSent) res.status(500).json(rpcError(null, JSONRPC_ERRORS.INTERNAL_ERROR, 'Internal error'));
  });
  return router;
}
