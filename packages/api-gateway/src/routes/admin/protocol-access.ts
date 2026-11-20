/**
 * Admin API: per-protocol access switches (9.4) — see @coremail/storage
 * protocol-access.ts and docs/protocol-access.md.
 *
 *   GET /api/v1/admin/protocol-access                 server level (two-state)
 *   PUT /api/v1/admin/protocol-access                 { imap?: 'on'|'off', … }  (no 'inherit' → 400)
 *   GET /api/v1/admin/protocol-access/domains/:id     domain level
 *   PUT /api/v1/admin/protocol-access/domains/:id     { imap?: 'inherit'|'on'|'off', … }
 *   GET /api/v1/admin/protocol-access/users/:id       user level
 *   PUT /api/v1/admin/protocol-access/users/:id
 *   GET /api/v1/admin/protocol-access/overview        w2b: combined model — per protocol the
 *       server switch, its ports (listeners), overriding domains / mailboxes and
 *       consistency warnings / notices (lib/protocol-overview.ts); read-only, writes use
 *       the level routes above and /admin/services/listeners. Domain names need read
 *       on `domains`, mailbox addresses read on `recipients` (else counts only).
 *
 * Every level answer: { level, id?, protocols, settings, inherited, inheritedFrom, effective, changedUsers? }
 * (`inherited` = what `inherit` resolves to on that level, `inheritedFrom` = from
 * which level: default | server | domain).
 *
 * RBAC: server + domain level write = area `servers` (SERVER_MANAGEMENT,
 * ORGANIZATION_MANAGEMENT); domain level read also for `domains` readers (the
 * BCP domain dialog); user level = area `recipients`, admin accounts
 * ORGANIZATION_MANAGEMENT only (canManageAccount). Every change is audited as
 * `settings.protocol-access.update` with before/after (always logged).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@coremail/core';
import {
  prisma, readProtocolLevel, readProtocolOverrides, updateProtocolSettings, ACCESS_PROTOCOLS, PROTOCOL_SETTINGS,
  SERVER_PROTOCOL_SETTINGS, type ProtocolLevelView, type ProtocolScope, type ProtocolSettings,
} from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { canAccess, canManageAccount } from '../../lib/rbac.js';
import { requireInScope } from '../../middleware/admin-scope.js';
import { audit, auditContext } from '../../lib/audit.js';
import {
  buildProtocolOverview, redactOverrideNames, submissionPorts, type HttpsState, type ProtocolOverview,
} from '../../lib/protocol-overview.js';
import { loadServedHttpsCert } from '../../lib/served-https-cert.js';
import { httpsServerState } from '../../tls-proxy.js';

const log = createLogger('admin:protocol-access');
export const adminProtocolAccessRouter: RouterType = Router();

/** Partial switches of a level; unknown protocols are refused, at least one switch is required. */
function patchSchema<S extends readonly [string, ...string[]]>(settings: S) {
  const setting = z.enum(settings);
  return z.object(
    Object.fromEntries(ACCESS_PROTOCOLS.map((p) => [p, setting.optional()])) as Record<typeof ACCESS_PROTOCOLS[number], z.ZodOptional<typeof setting>>,
  ).strict().refine((o) => Object.values(o).some((v) => v !== undefined), { message: 'At least one protocol switch is required' });
}
/** Domain and user level: inherit | on | off. */
export const ProtocolPatchSchema = patchSchema(PROTOCOL_SETTINGS);
/** Server level: two-state, on | off (no broader level to inherit from). */
export const ServerProtocolPatchSchema = patchSchema(SERVER_PROTOCOL_SETTINGS);

const serversArea = requireArea('servers');
/**
 * Domain level: write = servers; read also for `domains` readers (BCP domain
 * dialog). 9.5: guarded as the domains area (+ servers access) so a scoped
 * domains reader keeps the read — for the domains of its scope only.
 */
const domainArea = [
  requireArea('domains', (role, req, scoped) => canAccess(role, 'servers', req.method, scoped)),
  requireInScope('domain'),
];
const recipientsArea = [requireArea('recipients'), requireInScope('user')];

function viewBody(scope: ProtocolScope, view: ProtocolLevelView, changedUsers?: number): Record<string, unknown> {
  const id = scope.level === 'domain' ? scope.domainId : scope.level === 'user' ? scope.userId : undefined;
  return {
    level: scope.level,
    ...(id ? { id } : {}),
    protocols: ACCESS_PROTOCOLS,
    ...view,
    ...(changedUsers !== undefined ? { changedUsers } : {}),
  };
}

async function sendView(res: Response, scope: ProtocolScope): Promise<void> {
  const view = await readProtocolLevel(scope);
  if (!view) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(viewBody(scope, view));
}

/** Only the switches that actually change (before → after), for the audit log. */
function diff(before: ProtocolSettings, after: ProtocolSettings): Record<string, { before: string; after: string }> {
  const out: Record<string, { before: string; after: string }> = {};
  for (const p of ACCESS_PROTOCOLS) if (before[p] !== after[p]) out[p] = { before: before[p], after: after[p] };
  return out;
}

async function update(req: Request, res: Response, scope: ProtocolScope, targetName: string): Promise<void> {
  const schema = scope.level === 'global' ? ServerProtocolPatchSchema : ProtocolPatchSchema;
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) as Partial<ProtocolSettings>;
  const r = await updateProtocolSettings(scope, patch);
  if (!r) { res.status(404).json({ error: 'Not found' }); return; }
  const changes = diff(r.before, r.after.settings);
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'settings.protocol-access.update',
    targetType: scope.level === 'global' ? 'settings' : scope.level === 'domain' ? 'domain' : 'mailbox',
    targetId: scope.level === 'domain' ? scope.domainId : scope.level === 'user' ? scope.userId : 'protocol-access',
    targetName,
    changes: { switches: changes, changedUsers: r.changedUsers },
    ...auditContext(req),
  });
  log.info({ level: scope.level, target: targetName, changes, changedUsers: r.changedUsers }, 'Protocol access changed');
  res.json(viewBody(scope, r.after, r.changedUsers));
}

// ── Server level ──────────────────────────────────────────────────────────────

adminProtocolAccessRouter.get('/', serversArea, async (_req: Request, res: Response) => {
  await sendView(res, { level: 'global' });
});

adminProtocolAccessRouter.put('/', serversArea, async (req: Request, res: Response) => {
  await update(req, res, { level: 'global' }, 'server');
});

// ── Combined overview (w2b) ───────────────────────────────────────────────────

/**
 * The integrated HTTPS server: `active` = the proxy listens (httpsServerState —
 * also without a certificate marked isActiveHttps; the redirect keeps its own
 * opt-in state); certificate and trust from the certificate the proxy serves
 * for the public host name (lib/served-https-cert.ts: SNI exact → wildcard →
 * default) — not only the one marked isActiveHttps.
 */
async function loadHttpsState(): Promise<HttpsState> {
  const state = httpsServerState();
  const { cert } = await loadServedHttpsCert();
  return { active: state.listening, port: state.port, cert };
}

/** Reads ports, switches and the HTTPS state and builds the combined model (lib/protocol-overview.ts). */
export async function loadProtocolOverview(): Promise<ProtocolOverview> {
  const [overrides, listeners, https] = await Promise.all([
    readProtocolOverrides(),
    prisma.serviceListener.findMany({
      where: { service: { in: ['SMTP_RECEIVE', 'IMAP', 'POP3'] } },
      select: { id: true, service: true, address: true, port: true, ssl: true, active: true, allowLegacyTls: true },
    }),
    loadHttpsState(),
  ]);
  return buildProtocolOverview({ overrides, listeners, https, submissionPorts: submissionPorts() });
}

/** Readers of the servers area get the counts; the names only with read access to domains / recipients. */
adminProtocolAccessRouter.get('/overview', serversArea, async (req: Request, res: Response) => {
  const role = req.apiUser!.role;
  res.json(redactOverrideNames(await loadProtocolOverview(), {
    domains: canAccess(role, 'domains', 'GET'),
    users: canAccess(role, 'recipients', 'GET'),
  }));
});

// ── Domain level ──────────────────────────────────────────────────────────────

adminProtocolAccessRouter.get('/domains/:id', domainArea, async (req: Request, res: Response) => {
  await sendView(res, { level: 'domain', domainId: req.params['id'] ?? '' });
});

adminProtocolAccessRouter.put('/domains/:id', domainArea, async (req: Request, res: Response) => {
  const domain = await prisma.domain.findUnique({ where: { id: req.params['id'] ?? '' }, select: { id: true, name: true } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  await update(req, res, { level: 'domain', domainId: domain.id }, domain.name);
});

// ── User level ────────────────────────────────────────────────────────────────

adminProtocolAccessRouter.get('/users/:id', recipientsArea, async (req: Request, res: Response) => {
  await sendView(res, { level: 'user', userId: req.params['id'] ?? '' });
});

adminProtocolAccessRouter.put('/users/:id', recipientsArea, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.params['id'] ?? '' }, select: { id: true, email: true, role: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (!canManageAccount(req.apiUser!.role, user.role)) {
    res.status(403).json({ error: 'Only Organization Management may modify admin accounts', code: 'FORBIDDEN_ROLE' });
    return;
  }
  await update(req, res, { level: 'user', userId: user.id }, user.email);
});
