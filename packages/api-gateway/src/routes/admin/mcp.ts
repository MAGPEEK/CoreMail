/**
 * Admin API of the MCP interface (10.3, BCP → Infrastruktur → KI-Schnittstelle (MCP)).
 * docs/mcp.md, scope decisions docs/rbac.md.
 *
 *   GET    /settings     switch, endpoint URL, limits; the IP allowlist only with
 *                        read access to the servers area          (every admin role)
 *   PUT    /settings     { enabled?, allowedIps? }                  (servers write, organisation-wide)
 *   GET    /tokens       own tokens; ?all=true every admin's tokens (ORGANIZATION_MANAGEMENT)
 *   POST   /tokens       { name, mode: read|write, expiresInDays }  (every admin role, own token;
 *                        the token is returned once)
 *   DELETE /tokens/:id   revoke an own token (ORGANIZATION_MANAGEMENT: any token)
 *
 * Creating a token goes through the admin guard like every admin route: current
 * role from the database and — with requireMfaForAdmins — an MFA-verified
 * session (the token remembers it). Every change is audited (`mcp.*`, always on).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { scopeOf } from '../../middleware/admin-scope.js';
import { isScoped } from '../../lib/admin-scope.js';
import { allowedActions, allowedAreas, canAccess } from '../../lib/rbac.js';
import { audit, auditContext } from '../../lib/audit.js';
import { normalizeAllowlist, MAX_ALLOWLIST_ENTRIES } from '../../lib/mcp/net.js';
import { endpointUrl, getMcpSettings, mcpSettingsChanged, invalidateMcpSettings } from '../../lib/mcp/settings.js';
import {
  createMcpToken, revokeMcpToken, tokenInputError, tokenStatus, MCP_TOKEN_DEFAULT_DAYS, MCP_TOKEN_MAX_DAYS,
  MCP_TOKEN_MODES, MCP_TOKENS_PER_ADMIN, TOKEN_PUBLIC_SELECT, type McpTokenMode,
} from '../../lib/mcp/tokens.js';
import { sessionCount } from '../../lib/mcp/sessions.js';
import { envInt } from '../../lib/user-rate-limit.js';

export const adminMcpRouter: RouterType = Router();

/** Every admin role, every method (own tokens); the routes narrow it down. */
const anyAdmin = requireArea('dashboard', () => true);
/** The switch and the allowlist: server-wide configuration (area servers). */
const serversArea = requireArea('servers');
// Router-wide: nothing below /mcp is reachable without an admin role (also unknown paths).
adminMcpRouter.use(anyAdmin);

/** May `role` use write tools at all (a write area or a narrow write action)? */
export function canHoldWriteToken(role: string, scoped: boolean): boolean {
  return Object.values(allowedAreas(role, scoped)).includes('write') || Object.keys(allowedActions(role, scoped)).length > 0;
}

const SettingsPatch = z.object({
  enabled: z.boolean().optional(),
  allowedIps: z.array(z.string().max(64)).max(MAX_ALLOWLIST_ENTRIES).optional(),
}).strict().refine((o) => o.enabled !== undefined || o.allowedIps !== undefined, { message: 'Nothing to change' });

const TokenCreate = z.object({
  name: z.string().max(200),
  mode: z.enum(MCP_TOKEN_MODES).default('read'),
  expiresInDays: z.number().int().default(MCP_TOKEN_DEFAULT_DAYS),
}).strict();

// ── settings ──────────────────────────────────────────────────────────────────

adminMcpRouter.get('/settings', anyAdmin, async (req: Request, res: Response) => {
  invalidateMcpSettings();
  const s = await getMcpSettings();
  const role = req.apiUser!.role;
  const scoped = isScoped(scopeOf(req));
  const serversRead = canAccess(role, 'servers', 'GET', scoped);
  res.json({
    enabled: s.enabled,
    endpointUrl: endpointUrl(s),
    ...(serversRead ? { allowedIps: s.allowedIps, openSessions: sessionCount() } : {}),
    canManage: canAccess(role, 'servers', 'PUT', scoped),
    canSeeAllTokens: role === 'ORGANIZATION_MANAGEMENT',
    canCreateWriteTokens: canHoldWriteToken(role, scoped),
    limits: {
      tokenDefaultDays: MCP_TOKEN_DEFAULT_DAYS,
      tokenMaxDays: MCP_TOKEN_MAX_DAYS,
      tokensPerAdmin: MCP_TOKENS_PER_ADMIN,
      toolCallsPerMinute: envInt('MCP_RATE_LIMIT_PER_MINUTE', 60),
    },
  });
});

adminMcpRouter.put('/settings', serversArea, async (req: Request, res: Response) => {
  const parsed = SettingsPatch.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', details: parsed.error.issues }); return; }
  let allowedIps: string[] | undefined;
  if (parsed.data.allowedIps !== undefined) {
    const n = normalizeAllowlist(parsed.data.allowedIps);
    if (!n.ok) { res.status(400).json({ error: n.error }); return; }
    allowedIps = n.entries;
  }
  const before = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { mcpEnabled: true, mcpAllowedIps: true } });
  const data = {
    ...(parsed.data.enabled !== undefined ? { mcpEnabled: parsed.data.enabled } : {}),
    ...(allowedIps !== undefined ? { mcpAllowedIps: allowedIps } : {}),
  };
  const after = await prisma.serverSettings.upsert({
    where: { id: 'singleton' }, update: data, create: { id: 'singleton', ...data },
    select: { mcpEnabled: true, mcpAllowedIps: true },
  });
  // this instance: drop the cache (switch off → every session ends now); others via Redis
  await mcpSettingsChanged();
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'mcp.settings.update', targetType: 'settings', targetId: 'singleton', targetName: 'mcp',
    changes: {
      before: { enabled: before?.mcpEnabled ?? false, allowedIps: before?.mcpAllowedIps ?? [] },
      after: { enabled: after.mcpEnabled, allowedIps: after.mcpAllowedIps },
    },
    ...auditContext(req),
  });
  res.json({ enabled: after.mcpEnabled, allowedIps: after.mcpAllowedIps });
});

// ── tokens ────────────────────────────────────────────────────────────────────

type TokenRow = {
  id: string; userId: string; name: string; prefix: string; mode: string; mfaVerified: boolean;
  expiresAt: Date; lastUsedAt: Date | null; lastUsedIp: string | null; createdAt: Date;
  revokedAt: Date | null; revokedReason: string | null; user?: { email: string } | null;
};

function tokenView(row: TokenRow, withOwner: boolean, now = Date.now()): Record<string, unknown> {
  const { user, ...rest } = row;
  return {
    ...rest,
    status: tokenStatus(row, now),
    ...(withOwner ? { owner: user?.email ?? null } : {}),
  };
}

adminMcpRouter.get('/tokens', anyAdmin, async (req: Request, res: Response) => {
  const all = req.query['all'] === 'true' || req.query['all'] === '1';
  const actor = req.apiUser!;
  if (all && actor.role !== 'ORGANIZATION_MANAGEMENT') {
    res.status(403).json({ error: 'Only Organization Management sees the tokens of other admins', code: 'FORBIDDEN_ROLE' });
    return;
  }
  const rows = await prisma.mcpToken.findMany({
    where: all ? {} : { userId: actor.userId },
    select: { ...TOKEN_PUBLIC_SELECT, ...(all ? { user: { select: { email: true } } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 500,
  }) as TokenRow[];
  const now = Date.now();
  res.json({ tokens: rows.map((r) => tokenView(r, all, now)) });
});

adminMcpRouter.post('/tokens', anyAdmin, async (req: Request, res: Response) => {
  const parsed = TokenCreate.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', details: parsed.error.issues }); return; }
  const input = { name: parsed.data.name, mode: parsed.data.mode as McpTokenMode, expiresInDays: parsed.data.expiresInDays };
  const err = tokenInputError(input);
  if (err) { res.status(400).json({ error: err }); return; }
  const actor = req.apiUser!;
  if (input.mode === 'write' && !canHoldWriteToken(actor.role, isScoped(scopeOf(req)))) {
    res.status(403).json({ error: 'This admin role has no write access — create a read token', code: 'FORBIDDEN_ROLE' });
    return;
  }
  const created = await createMcpToken(actor.userId, input, actor.mfaVerified === true);
  if (!created) {
    res.status(409).json({ error: `At most ${MCP_TOKENS_PER_ADMIN} active tokens per admin — revoke one first`, code: 'TOKEN_LIMIT' });
    return;
  }
  audit({
    actorId: actor.userId, actorEmail: actor.email,
    action: 'mcp.token.create', targetType: 'mcp-token', targetId: created.id, targetName: created.name,
    changes: { mode: created.mode, expiresAt: created.expiresAt.toISOString(), prefix: created.prefix, mfaVerified: actor.mfaVerified === true },
    ...auditContext(req),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({
    token: created.token,
    id: created.id, name: created.name, prefix: created.prefix, mode: created.mode,
    expiresAt: created.expiresAt, createdAt: created.createdAt, status: 'active',
  });
});

adminMcpRouter.delete('/tokens/:id', anyAdmin, async (req: Request, res: Response) => {
  const actor = req.apiUser!;
  const id = String(req.params['id'] ?? '');
  const row = await prisma.mcpToken.findUnique({ where: { id }, select: { id: true, userId: true, name: true, revokedAt: true } });
  // another admin's token is "not found" unless the caller is ORGANIZATION_MANAGEMENT
  if (!row || (row.userId !== actor.userId && actor.role !== 'ORGANIZATION_MANAGEMENT')) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  const own = row.userId === actor.userId;
  const changed = await revokeMcpToken(row, own ? 'owner' : 'admin');
  audit({
    actorId: actor.userId, actorEmail: actor.email,
    action: 'mcp.token.revoke', targetType: 'mcp-token', targetId: row.id, targetName: row.name,
    changes: { owner: own ? 'self' : row.userId, alreadyRevoked: !changed },
    ...auditContext(req),
  });
  res.json({ ok: true, revoked: changed });
});
