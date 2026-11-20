/**
 * 10.5 — Admin: attack protection (BCP → Schutz → Angriffsschutz),
 * docs/attack-protection.md. Area hygiene (write HYGIENE_MANAGEMENT, read
 * VIEW_ONLY_ORG), organisation-wide only (requireUnscoped — client IPs and
 * locks are server-wide data).
 *
 * GET    /api/v1/admin/security/protection/locks          currently locked IPs + accounts (Redis)
 * POST   /api/v1/admin/security/protection/locks/release  { scope, id, resetStrikes? } — audit security.lock.release
 * GET    /api/v1/admin/security/protection/rules          block list + exceptions (+ the caller's IP)
 * POST   /api/v1/admin/security/protection/rules          { kind, cidr, note?, expiresInDays?, confirmOwnIp? } — audit security.ip-rule.create
 * DELETE /api/v1/admin/security/protection/rules/:id      audit security.ip-rule.delete
 * GET    /api/v1/admin/security/protection/settings       notifications + repeat-offender escalation
 * PUT    /api/v1/admin/security/protection/settings       audit security.protection.settings.update
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger, getRedisClient } from '@coremail/core';
import {
  prisma, parseCidr, cidrContains, publishIpAccessReload, ipAccessVerdict,
  listActiveLocks, releaseLock, lockIdOf, resetRepeatCounter,
  loadAttackProtectionSettings, saveAttackProtectionSettings, attackNoticeRecipients,
  invalidateAttackProtectionSettings, ATTACK_PROTECTION_LIMITS, MAX_IP_RULES_PER_KIND, REPEAT_LOCK_WINDOW_SEC,
  createExemptIpMatcher, normalizeIp,
  type LockScanRedis, type AttackProtectionSettings,
} from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { requireUnscoped } from '../../middleware/admin-scope.js';
import { audit, auditContext } from '../../lib/audit.js';

const log = createLogger('admin:security-protection');
export const adminSecurityProtectionRouter: RouterType = Router();
adminSecurityProtectionRouter.use(requireArea('hygiene'), requireUnscoped); // server-wide (client IPs, locks)

// ── Test seams ────────────────────────────────────────────────────────────────
let redisOverride: LockScanRedis | null = null;
/** Tests: an in-memory Redis for the lock view (null = the shared client). */
export function setProtectionRedisForTests(r: LockScanRedis | null): void { redisOverride = r; }
const lockRedis = (): LockScanRedis => redisOverride ?? (getRedisClient() as unknown as LockScanRedis);

/** Smallest accepted prefix per family — a list entry never covers a whole address family. */
export const MIN_PREFIX = { 4: 8, 6: 16 } as const;

const actorOf = (req: Request) => ({ actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email });
const callerIp = (req: Request): string => normalizeIp(req.ip ?? req.socket?.remoteAddress ?? '');

interface RuleRow {
  id: string; kind: 'BLOCK' | 'ALLOW'; cidr: string; note: string; auto: boolean;
  expiresAt: Date | null; createdBy: string | null; createdAt: Date;
}
const ruleView = (r: RuleRow, now = Date.now()) => ({
  id: r.id, kind: r.kind, cidr: r.cidr, note: r.note, auto: r.auto,
  expiresAt: r.expiresAt?.toISOString() ?? null, createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
  expired: r.expiresAt !== null && r.expiresAt.getTime() <= now,
});

// ── Locks ─────────────────────────────────────────────────────────────────────

adminSecurityProtectionRouter.get('/locks', async (_req: Request, res: Response) => {
  try {
    const r = await listActiveLocks(lockRedis(), { max: 500 });
    res.json({ ...r, repeatWindowDays: REPEAT_LOCK_WINDOW_SEC / 86_400 });
  } catch (err) {
    log.warn({ err }, 'lock view failed — Redis unavailable?');
    res.status(503).json({ error: 'Sperren können nicht gelesen werden (Redis nicht erreichbar)', code: 'REDIS_UNAVAILABLE' });
  }
});

const ReleaseSchema = z.object({
  scope: z.enum(['ip', 'account']),
  id: z.string().trim().min(1).max(254),
  resetStrikes: z.boolean().optional(),
});

adminSecurityProtectionRouter.post('/locks/release', async (req: Request, res: Response) => {
  const parsed = ReleaseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Ungültige Eingabe', code: 'VALIDATION' }); return; }
  const { scope, resetStrikes } = parsed.data;
  const id = lockIdOf(scope, parsed.data.id);
  if (!id) { res.status(400).json({ error: scope === 'ip' ? 'Ungültige IP-Adresse' : 'Ungültige Konto-Kennung', code: 'INVALID_ID' }); return; }
  let result: Awaited<ReturnType<typeof releaseLock>>;
  try {
    result = await releaseLock(lockRedis(), scope, id, { resetStrikes: resetStrikes === true });
  } catch (err) {
    log.warn({ err }, 'lock release failed — Redis unavailable?');
    res.status(503).json({ error: 'Sperre kann nicht aufgehoben werden (Redis nicht erreichbar)', code: 'REDIS_UNAVAILABLE' });
    return;
  }
  const targetName = scope === 'ip' ? id : (result.info?.account ?? id);
  audit({
    ...actorOf(req),
    action: 'security.lock.release', targetType: scope === 'ip' ? 'ip' : 'account', targetId: id, targetName,
    changes: { scope, resetStrikes: resetStrikes === true, wasLocked: result.released, protocol: result.info?.protocol ?? null, strikes: result.info?.strikes ?? null },
    ...auditContext(req),
  });
  log.info({ scope, id: scope === 'ip' ? id : '(account)', released: result.released }, 'lock released by an admin');
  res.json({ released: result.released, scope, id });
});

// ── Block list / exceptions ───────────────────────────────────────────────────

adminSecurityProtectionRouter.get('/rules', async (req: Request, res: Response) => {
  const rows = await prisma.ipAccessRule.findMany({ orderBy: [{ createdAt: 'desc' }] }) as RuleRow[];
  const now = Date.now();
  const ip = callerIp(req);
  const env = createExemptIpMatcher(process.env['MAIL_AUTH_EXEMPT_CIDRS']);
  res.json({
    block: rows.filter((r) => r.kind === 'BLOCK').map((r) => ruleView(r, now)),
    allow: rows.filter((r) => r.kind === 'ALLOW').map((r) => ruleView(r, now)),
    callerIp: ip,
    callerVerdict: ipAccessVerdict(ip),
    // exemptions from the environment (read-only on the page)
    envExempt: (process.env['MAIL_AUTH_EXEMPT_CIDRS'] ?? '').split(/[\s,]+/).map((s) => s.trim()).filter((s) => s && !env.invalid.includes(s)),
    maxEntries: MAX_IP_RULES_PER_KIND,
    minPrefix: MIN_PREFIX,
  });
});

const RuleSchema = z.object({
  kind: z.enum(['BLOCK', 'ALLOW']),
  cidr: z.string().trim().min(1).max(64),
  note: z.string().trim().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  confirmOwnIp: z.boolean().optional(),
});

adminSecurityProtectionRouter.post('/rules', async (req: Request, res: Response) => {
  const parsed = RuleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Ungültige Eingabe', code: 'VALIDATION' }); return; }
  const { kind, note, expiresInDays, confirmOwnIp } = parsed.data;
  const c = parseCidr(parsed.data.cidr);
  if (!c) { res.status(400).json({ error: 'Keine gültige IP-Adresse oder CIDR (z. B. 203.0.113.7 oder 203.0.113.0/24)', code: 'INVALID_CIDR' }); return; }
  if (c.prefix < MIN_PREFIX[c.family]) {
    res.status(400).json({ error: `Bereich zu groß — mindestens /${MIN_PREFIX[c.family]} (${c.family === 4 ? 'IPv4' : 'IPv6'})`, code: 'TOO_BROAD' });
    return;
  }
  if (kind === 'BLOCK' && (cidrContains(c, '127.0.0.1') || cidrContains(c, '::1'))) {
    res.status(400).json({ error: 'Loopback-Adressen können nicht gesperrt werden', code: 'LOOPBACK' });
    return;
  }
  const ip = callerIp(req);
  if (kind === 'BLOCK' && ip && cidrContains(c, ip) && confirmOwnIp !== true) {
    res.status(409).json({ error: `Dieser Eintrag sperrt Ihre eigene IP-Adresse (${ip}) — Sie verlieren sofort den Zugang zum BCP.`, code: 'BLOCKS_OWN_IP', callerIp: ip });
    return;
  }
  const count = await prisma.ipAccessRule.count({ where: { kind } });
  if (count >= MAX_IP_RULES_PER_KIND) {
    res.status(409).json({ error: `Höchstens ${MAX_IP_RULES_PER_KIND} Einträge je Liste`, code: 'LIMIT' });
    return;
  }
  const exists = await prisma.ipAccessRule.findUnique({ where: { kind_cidr: { kind, cidr: c.cidr } } });
  if (exists) { res.status(409).json({ error: `${c.cidr} steht bereits in der Liste`, code: 'DUPLICATE' }); return; }
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;
  const row = await prisma.ipAccessRule.create({
    data: { kind, cidr: c.cidr, note: note ?? '', auto: false, expiresAt, createdBy: req.apiUser!.email },
  }) as RuleRow;
  await publishIpAccessReload();
  audit({
    ...actorOf(req),
    action: 'security.ip-rule.create', targetType: 'ip-rule', targetId: row.id, targetName: `${kind} ${c.cidr}`,
    changes: { kind, cidr: c.cidr, note: row.note, expiresAt: row.expiresAt?.toISOString() ?? null, ownIp: kind === 'BLOCK' && cidrContains(c, ip) },
    ...auditContext(req),
  });
  res.status(201).json(ruleView(row));
});

adminSecurityProtectionRouter.delete('/rules/:id', async (req: Request, res: Response) => {
  const id = String(req.params['id'] ?? '');
  const row = await prisma.ipAccessRule.findUnique({ where: { id } }) as RuleRow | null;
  if (!row) { res.status(404).json({ error: 'Eintrag nicht gefunden' }); return; }
  await prisma.ipAccessRule.delete({ where: { id } });
  await publishIpAccessReload();
  // An automatic entry removed by an admin: the repeat-offender count starts again.
  if (row.auto) {
    const ipOnly = row.cidr.replace(/\/(32|128)$/, '');
    await resetRepeatCounter(lockRedis(), ipOnly).catch(() => undefined);
  }
  audit({
    ...actorOf(req),
    action: 'security.ip-rule.delete', targetType: 'ip-rule', targetId: row.id, targetName: `${row.kind} ${row.cidr}`,
    changes: { kind: row.kind, cidr: row.cidr, note: row.note, auto: row.auto },
    ...auditContext(req),
  });
  res.status(204).end();
});

// ── Settings ──────────────────────────────────────────────────────────────────

adminSecurityProtectionRouter.get('/settings', async (_req: Request, res: Response) => {
  invalidateAttackProtectionSettings();
  const s = await loadAttackProtectionSettings();
  const effectiveRecipients = await attackNoticeRecipients(s).catch(() => [] as string[]);
  res.json({ ...s, effectiveRecipients, limits: ATTACK_PROTECTION_LIMITS });
});

const L = ATTACK_PROTECTION_LIMITS;
const SettingsSchema = z.object({
  notifyEnabled: z.boolean().optional(),
  notifyRecipient: z.union([z.string().trim().email().max(254), z.literal('')]).optional(),
  failureAlertThreshold: z.number().int().min(L.failureAlertThreshold.min).max(L.failureAlertThreshold.max).optional(),
  autoBlockEnabled: z.boolean().optional(),
  autoBlockThreshold: z.number().int().min(L.autoBlockThreshold.min).max(L.autoBlockThreshold.max).optional(),
  autoBlockDays: z.number().int().min(L.autoBlockDays.min).max(L.autoBlockDays.max).optional(),
}).strict();

adminSecurityProtectionRouter.put('/settings', async (req: Request, res: Response) => {
  const parsed = SettingsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Ungültige Einstellungen', code: 'VALIDATION' }); return; }
  invalidateAttackProtectionSettings();
  const before = await loadAttackProtectionSettings();
  const patch: Partial<AttackProtectionSettings> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
  const after = await saveAttackProtectionSettings(patch);
  audit({
    ...actorOf(req),
    action: 'security.protection.settings.update', targetType: 'settings', targetId: 'singleton', targetName: 'attack-protection',
    changes: { before, after },
    ...auditContext(req),
  });
  const effectiveRecipients = await attackNoticeRecipients(after).catch(() => [] as string[]);
  res.json({ ...after, effectiveRecipients, limits: ATTACK_PROTECTION_LIMITS });
});
