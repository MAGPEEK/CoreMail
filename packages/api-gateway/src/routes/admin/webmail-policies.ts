/**
 * Admin API: webmail policies (9.4) — module switches and attachment / content
 * policy per level. See @coremail/storage webmail-policy.ts and
 * docs/webmail-policies.md.
 *
 *   GET|PUT /api/v1/admin/webmail-policies                 server level
 *   GET|PUT /api/v1/admin/webmail-policies/domains/:id     domain level
 *   GET|PUT /api/v1/admin/webmail-policies/users/:id       user level
 *
 * PUT body: { features?: { calendar?: 'inherit'|'on'|'off', … },
 *             content?: { blockedExtensions?: string[]|null, downloadOnlyExtensions?: string[]|null,
 *                         maxUploadMb?: number|null, externalImages?: 'ask'|'contacts'|'block'|null } }
 * (server level: no 'inherit' / null — except maxUploadMb null = no own limit).
 * Answer: { level, id?, features, settings, inherited, effective, sources, users? }.
 *
 * RBAC like the protocol switches: server + domain level = area `servers`
 * (domain level read also for `domains` readers), user level = area
 * `recipients`, admin accounts ORGANIZATION_MANAGEMENT only. Every change is
 * audited as `settings.webmail-policy.update` with before/after.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@coremail/core';
import {
  prisma, readWebmailPolicyLevel, updateWebmailPolicy, WEBMAIL_FEATURES, SWITCH_SETTINGS, EXTERNAL_IMAGE_MODES,
  CONTENT_KEYS, MAX_UPLOAD_MB_LIMIT,
  type PolicyScope, type WebmailPolicyLevel, type WebmailPolicyPatch, type WebmailPolicyView,
} from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { canAccess, canManageAccount, isReadMethod } from '../../lib/rbac.js';
import { audit, auditContext } from '../../lib/audit.js';

const log = createLogger('admin:webmail-policies');
export const adminWebmailPoliciesRouter: RouterType = Router();

const extensionList = z.array(z.string().max(32)).max(200);
const featureSetting = z.enum(SWITCH_SETTINGS);
export const WebmailPolicyPatchSchema = z.object({
  features: z.object(
    Object.fromEntries(WEBMAIL_FEATURES.map((f) => [f, featureSetting.optional()])) as Record<typeof WEBMAIL_FEATURES[number], z.ZodOptional<typeof featureSetting>>,
  ).strict().optional(),
  content: z.object({
    blockedExtensions: extensionList.nullable().optional(),
    downloadOnlyExtensions: extensionList.nullable().optional(),
    maxUploadMb: z.number().int().min(1).max(MAX_UPLOAD_MB_LIMIT).nullable().optional(),
    externalImages: z.enum(EXTERNAL_IMAGE_MODES).nullable().optional(),
  }).strict().optional(),
}).strict().refine(
  (o) => Object.values(o.features ?? {}).some((v) => v !== undefined) || Object.values(o.content ?? {}).some((v) => v !== undefined),
  { message: 'At least one value is required' },
);

const serversArea = requireArea('servers');
const domainArea = requireArea('servers', (role, req) => isReadMethod(req.method) && canAccess(role, 'domains', 'GET'));
const recipientsArea = requireArea('recipients');

function viewBody(scope: PolicyScope, view: WebmailPolicyView, users?: number): Record<string, unknown> {
  const id = scope.level === 'domain' ? scope.domainId : scope.level === 'user' ? scope.userId : undefined;
  return { level: scope.level, ...(id ? { id } : {}), features: WEBMAIL_FEATURES, ...view, ...(users !== undefined ? { users } : {}) };
}

async function sendView(res: Response, scope: PolicyScope): Promise<void> {
  const view = await readWebmailPolicyLevel(scope);
  if (!view) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(viewBody(scope, view));
}

/** Only the values that changed (before → after), for the audit log (pure). */
export function policyDiff(before: WebmailPolicyLevel, after: WebmailPolicyLevel): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const f of WEBMAIL_FEATURES) if (before.features[f] !== after.features[f]) out[f] = { before: before.features[f], after: after.features[f] };
  for (const k of CONTENT_KEYS) {
    if (JSON.stringify(before.content[k]) !== JSON.stringify(after.content[k])) out[k] = { before: before.content[k], after: after.content[k] };
  }
  return out;
}

/** The patch without undefined values (exactOptionalPropertyTypes). */
function cleanPatch(data: z.infer<typeof WebmailPolicyPatchSchema>): WebmailPolicyPatch {
  const defined = <T extends object>(o: T | undefined) =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
  return { features: defined(data.features), content: defined(data.content) } as WebmailPolicyPatch;
}

async function update(req: Request, res: Response, scope: PolicyScope, targetName: string): Promise<void> {
  const parsed = WebmailPolicyPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  let r;
  try {
    r = await updateWebmailPolicy(scope, cleanPatch(parsed.data));
  } catch (err) {
    if (err instanceof RangeError) { res.status(400).json({ error: err.message }); return; }
    throw err;
  }
  if (!r) { res.status(404).json({ error: 'Not found' }); return; }
  const changes = policyDiff(r.before, r.after.settings);
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'settings.webmail-policy.update',
    targetType: scope.level === 'global' ? 'settings' : scope.level === 'domain' ? 'domain' : 'mailbox',
    targetId: scope.level === 'domain' ? scope.domainId : scope.level === 'user' ? scope.userId : 'webmail-policy',
    targetName,
    changes: { values: changes, users: r.users },
    ...auditContext(req),
  });
  log.info({ level: scope.level, target: targetName, changes, users: r.users }, 'Webmail policy changed');
  res.json(viewBody(scope, r.after, r.users));
}

// ── Server level ──────────────────────────────────────────────────────────────

adminWebmailPoliciesRouter.get('/', serversArea, async (_req: Request, res: Response) => {
  await sendView(res, { level: 'global' });
});

adminWebmailPoliciesRouter.put('/', serversArea, async (req: Request, res: Response) => {
  await update(req, res, { level: 'global' }, 'server');
});

// ── Domain level ──────────────────────────────────────────────────────────────

adminWebmailPoliciesRouter.get('/domains/:id', domainArea, async (req: Request, res: Response) => {
  await sendView(res, { level: 'domain', domainId: req.params['id'] ?? '' });
});

adminWebmailPoliciesRouter.put('/domains/:id', domainArea, async (req: Request, res: Response) => {
  const domain = await prisma.domain.findUnique({ where: { id: req.params['id'] ?? '' }, select: { id: true, name: true } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  await update(req, res, { level: 'domain', domainId: domain.id }, domain.name);
});

// ── User level ────────────────────────────────────────────────────────────────

adminWebmailPoliciesRouter.get('/users/:id', recipientsArea, async (req: Request, res: Response) => {
  await sendView(res, { level: 'user', userId: req.params['id'] ?? '' });
});

adminWebmailPoliciesRouter.put('/users/:id', recipientsArea, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.params['id'] ?? '' }, select: { id: true, email: true, role: true } });
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }
  if (!canManageAccount(req.apiUser!.role, user.role)) {
    res.status(403).json({ error: 'Only Organization Management may modify admin accounts', code: 'FORBIDDEN_ROLE' });
    return;
  }
  await update(req, res, { level: 'user', userId: user.id }, user.email);
});
