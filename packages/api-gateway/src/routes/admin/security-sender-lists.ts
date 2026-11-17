/**
 * BCP → Protection → Sender lists (9.4). Mounted under
 * /api/v1/admin/security/sender-lists by security.ts (inherits requireArea('hygiene'):
 * read for GET, write for POST/PATCH/DELETE).
 *
 *   GET    /             entries (GLOBAL / DOMAIN / USER; webmail USER-JUNK entries excluded)
 *   POST   /             create one entry
 *   PATCH  /:id          change list type, pattern, comment or the active switch
 *   DELETE /:id          delete an entry
 *   GET    /export.csv   all entries as CSV (lib/sender-lists.ts)
 *   POST   /import       CSV import { csv } — all rows are validated first, nothing is
 *                        written when one row is invalid; duplicates are skipped
 *
 * Every change is audited with the entry data (`security.sender-list.*`). The security
 * filter reads the table per message — no reload needed.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { audit, auditContext } from '../../lib/audit.js';
import {
  normalizeEntry, entryKey, toCsv, parseSenderListCsv, LIST_TYPES, PATTERN_TYPES, patternError,
  type SenderListInput,
} from '../../lib/sender-lists.js';

export const adminSenderListsRouter: RouterType = Router();

const SCOPES = ['GLOBAL', 'DOMAIN', 'USER'];

interface Row {
  id: string; pattern: string; patternType: string; scope: string; scopeId: string | null;
  listType: string; comment: string; active: boolean; createdAt: Date;
}

/** Rows with the readable target (domain name / mailbox address) of their scope. */
async function withTargets(rows: Row[]): Promise<Array<Row & { target: string }>> {
  const ids = (scope: string) => [...new Set(rows.filter((r) => r.scope === scope && r.scopeId).map((r) => r.scopeId!))];
  const [domains, users] = await Promise.all([
    prisma.domain.findMany({ where: { id: { in: ids('DOMAIN') } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: ids('USER') } }, select: { id: true, email: true } }),
  ]);
  return rows.map((r) => ({
    ...r,
    target: r.scope === 'DOMAIN' ? domains.find((d) => d.id === r.scopeId)?.name ?? ''
      : r.scope === 'USER' ? users.find((u) => u.id === r.scopeId)?.email ?? '' : '',
  }));
}

/** scopeId for a target, or an error text (unknown domain / mailbox). */
async function resolveTarget(scope: string, target: string): Promise<{ scopeId: string | null } | { error: string }> {
  if (scope === 'GLOBAL') return { scopeId: null };
  if (scope === 'DOMAIN') {
    const d = await prisma.domain.findUnique({ where: { name: target }, select: { id: true } });
    return d ? { scopeId: d.id } : { error: `unknown domain ${target}` };
  }
  const u = await prisma.user.findUnique({ where: { email: target }, select: { id: true } });
  return u ? { scopeId: u.id } : { error: `unknown mailbox ${target}` };
}

function auditEntry(req: Request, action: string, targetId: string, changes: Record<string, unknown>): void {
  audit({
    ...(req.apiUser?.userId !== undefined ? { actorId: req.apiUser.userId } : {}),
    ...(req.apiUser?.email !== undefined ? { actorEmail: req.apiUser.email } : {}),
    action: `security.sender-list.${action}`,
    targetType: 'sender-list',
    targetId,
    changes,
    ...auditContext(req),
  });
}

const describe = (e: Pick<SenderListInput, 'listType' | 'scope' | 'target' | 'patternType' | 'pattern'>) =>
  ({ listType: e.listType, scope: e.scope, target: e.target, patternType: e.patternType, pattern: e.pattern });

async function listRows(): Promise<Row[]> {
  return prisma.blacklist.findMany({
    where: { scope: { in: SCOPES } },
    orderBy: [{ listType: 'asc' }, { scope: 'asc' }, { pattern: 'asc' }],
    select: { id: true, pattern: true, patternType: true, scope: true, scopeId: true, listType: true, comment: true, active: true, createdAt: true },
  });
}

adminSenderListsRouter.get('/', async (_req: Request, res: Response) => {
  res.json(await withTargets(await listRows()));
});

adminSenderListsRouter.get('/export.csv', async (_req: Request, res: Response) => {
  const rows = await withTargets(await listRows());
  const csv = toCsv(rows.map((r) => ({
    listType: r.listType as SenderListInput['listType'], scope: r.scope as SenderListInput['scope'], target: r.target,
    patternType: r.patternType as SenderListInput['patternType'], pattern: r.pattern, comment: r.comment, active: r.active,
  })));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sender-lists.csv"');
  res.send(csv);
});

adminSenderListsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = normalizeEntry((req.body ?? {}) as Record<string, unknown>);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const e = parsed.entry;
  const target = await resolveTarget(e.scope, e.target);
  if ('error' in target) { res.status(400).json({ error: target.error }); return; }
  const dup = await prisma.blacklist.findFirst({
    where: { listType: e.listType, scope: e.scope, scopeId: target.scopeId, patternType: e.patternType, pattern: e.pattern },
    select: { id: true },
  });
  if (dup) { res.status(409).json({ error: 'entry exists already', id: dup.id }); return; }
  const row = await prisma.blacklist.create({
    data: {
      listType: e.listType, scope: e.scope, scopeId: target.scopeId, patternType: e.patternType,
      pattern: e.pattern, comment: e.comment, active: e.active,
    },
  });
  auditEntry(req, 'create', row.id, describe(e));
  res.status(201).json({ ...row, target: e.target });
});

const PatchSchema = z.object({
  listType: z.enum(LIST_TYPES).optional(),
  patternType: z.enum(PATTERN_TYPES).optional(),
  pattern: z.string().max(254).optional(),
  comment: z.string().max(500).optional(),
  active: z.boolean().optional(),
}).strict();

adminSenderListsRouter.patch('/:id', async (req: Request, res: Response) => {
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const id = String(req.params['id']);
  const before = await prisma.blacklist.findUnique({ where: { id } });
  if (!before || !SCOPES.includes(before.scope)) { res.status(404).json({ error: 'entry not found' }); return; }
  const patternType = parsed.data.patternType ?? before.patternType as SenderListInput['patternType'];
  const rawPattern = (parsed.data.pattern ?? before.pattern).trim();
  const pattern = patternType === 'REGEX' ? rawPattern : rawPattern.toLowerCase();
  const perr = patternError(patternType, pattern);
  if (perr) { res.status(400).json({ error: perr }); return; }
  const data = {
    ...(parsed.data.listType !== undefined ? { listType: parsed.data.listType } : {}),
    ...(parsed.data.patternType !== undefined || parsed.data.pattern !== undefined ? { patternType, pattern } : {}),
    ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment.trim() } : {}),
    ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
  };
  const row = await prisma.blacklist.update({ where: { id }, data });
  const changes: Record<string, { from: string; to: string }> = {};
  for (const [k, v] of Object.entries(data)) {
    const from = (before as unknown as Record<string, unknown>)[k];
    if (from !== v) changes[k] = { from: String(from), to: String(v) };
  }
  if (Object.keys(changes).length) auditEntry(req, 'update', id, { pattern: before.pattern, ...changes });
  res.json(row);
});

adminSenderListsRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = String(req.params['id']);
  const row = await prisma.blacklist.findUnique({ where: { id } });
  if (!row || !SCOPES.includes(row.scope)) { res.status(404).json({ error: 'entry not found' }); return; }
  await prisma.blacklist.delete({ where: { id } });
  auditEntry(req, 'delete', id, { listType: row.listType, scope: row.scope, scopeId: row.scopeId, patternType: row.patternType, pattern: row.pattern });
  res.json({ ok: true });
});

adminSenderListsRouter.post('/import', async (req: Request, res: Response) => {
  const csv = (req.body as { csv?: unknown } | undefined)?.csv;
  if (typeof csv !== 'string') { res.status(400).json({ error: 'body { csv: string } expected' }); return; }
  const { entries, errors } = parseSenderListCsv(csv);
  // targets → ids (unknown domain / mailbox is a row error)
  const resolved: Array<SenderListInput & { scopeId: string | null }> = [];
  const cache = new Map<string, Awaited<ReturnType<typeof resolveTarget>>>();
  for (const e of entries) {
    const key = `${e.scope}:${e.target}`;
    if (!cache.has(key)) cache.set(key, await resolveTarget(e.scope, e.target));
    const t = cache.get(key)!;
    if ('error' in t) errors.push({ line: e.line, error: t.error });
    else resolved.push({ ...e, scopeId: t.scopeId });
  }
  if (errors.length) {
    res.status(400).json({ error: 'import refused — no entry was written', errors: errors.sort((a, b) => a.line - b.line).slice(0, 50) });
    return;
  }
  const existing = new Set((await listRows()).map(entryKey));
  const fresh = resolved.filter((e) => {
    const k = entryKey(e);
    if (existing.has(k)) return false;
    existing.add(k);
    return true;
  });
  if (fresh.length) {
    await prisma.blacklist.createMany({
      data: fresh.map((e) => ({
        listType: e.listType, scope: e.scope, scopeId: e.scopeId, patternType: e.patternType,
        pattern: e.pattern, comment: e.comment, active: e.active,
      })),
    });
  }
  const result = { created: fresh.length, skipped: resolved.length - fresh.length };
  auditEntry(req, 'import', 'csv', { ...result, entries: fresh.slice(0, 100).map(describe) });
  res.json(result);
});
