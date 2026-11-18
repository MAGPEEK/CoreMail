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
 *
 * 9.5 management scopes: a scoped admin lists, exports, creates, imports and
 * changes only DOMAIN entries of its domains and USER entries of mailboxes in
 * them; GLOBAL entries are organisation-wide (not listed, creating one → 403).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, addressVariants, domainVariants } from '@coremail/storage';
import { audit, auditContext } from '../../lib/audit.js';
import { scopeOf, scopeParam } from '../../middleware/admin-scope.js';
import { OUT_OF_SCOPE_REFUSAL, inScope, scopeDomainIds, type AdminScope } from '../../lib/admin-scope.js';
import {
  normalizeEntry, entryKey, toCsv, parseSenderListCsv, LIST_TYPES, PATTERN_TYPES, patternError, storedPattern,
  type SenderListInput,
} from '../../lib/sender-lists.js';

export const adminSenderListsRouter: RouterType = Router();
// 9.5: an entry outside the admin's management scope is "not found".
adminSenderListsRouter.param('id', scopeParam('senderList'));

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

/**
 * scopeId (and the domain it belongs to) for a target, or an error text
 * (unknown domain / mailbox). An internationalized domain is found in either
 * spelling (A-label / U-label).
 */
async function resolveTarget(scope: string, target: string): Promise<{ scopeId: string | null; domainId: string | null } | { error: string }> {
  if (scope === 'GLOBAL') return { scopeId: null, domainId: null };
  if (scope === 'DOMAIN') {
    const d = await prisma.domain.findFirst({ where: { name: { in: domainVariants(target) } }, select: { id: true } });
    return d ? { scopeId: d.id, domainId: d.id } : { error: `unknown domain ${target}` };
  }
  const u = await prisma.user.findFirst({ where: { email: { in: addressVariants(target) } }, select: { id: true, domainId: true } });
  return u ? { scopeId: u.id, domainId: u.domainId } : { error: `unknown mailbox ${target}` };
}

/**
 * 9.5: Prisma `where` of the entries inside a management scope — DOMAIN entries
 * of its domains, USER entries of mailboxes in them ({} = organisation-wide).
 */
async function scopeEntriesWhere(scope: AdminScope): Promise<Record<string, unknown>> {
  const domainIds = scopeDomainIds(scope);
  if (!domainIds) return {};
  const users = await prisma.user.findMany({ where: { domainId: { in: domainIds } }, select: { id: true } });
  return {
    OR: [
      { scope: 'DOMAIN', scopeId: { in: domainIds } },
      { scope: 'USER', scopeId: { in: users.map((u) => u.id) } },
    ],
  };
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

/** Entries (all, or those matching `scopeWhere` — see scopeEntriesWhere). */
async function listRows(scopeWhere: Record<string, unknown> = {}): Promise<Row[]> {
  return prisma.blacklist.findMany({
    where: { scope: { in: SCOPES }, ...scopeWhere },
    orderBy: [{ listType: 'asc' }, { scope: 'asc' }, { pattern: 'asc' }],
    select: { id: true, pattern: true, patternType: true, scope: true, scopeId: true, listType: true, comment: true, active: true, createdAt: true },
  });
}

adminSenderListsRouter.get('/', async (req: Request, res: Response) => {
  res.json(await withTargets(await listRows(await scopeEntriesWhere(scopeOf(req)))));
});

adminSenderListsRouter.get('/export.csv', async (req: Request, res: Response) => {
  const rows = await withTargets(await listRows(await scopeEntriesWhere(scopeOf(req))));
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
  // 9.5: GLOBAL entries and targets of other domains are outside a management scope
  if (!inScope(scopeOf(req), target.domainId)) { res.status(403).json(OUT_OF_SCOPE_REFUSAL); return; }
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
  const pattern = storedPattern(patternType, rawPattern);
  const perr = patternError(patternType, pattern);
  if (perr) { res.status(400).json({ error: perr }); return; }
  const data = {
    ...(parsed.data.listType !== undefined ? { listType: parsed.data.listType } : {}),
    ...(parsed.data.patternType !== undefined || parsed.data.pattern !== undefined ? { patternType, pattern } : {}),
    ...(parsed.data.comment !== undefined ? { comment: parsed.data.comment.trim() } : {}),
    ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
  };
  // A changed list type / pattern must not turn the entry into a duplicate of another one.
  if (parsed.data.listType !== undefined || 'pattern' in data) {
    const identity = { listType: data.listType ?? before.listType, scope: before.scope, scopeId: before.scopeId, patternType, pattern };
    const same = await prisma.blacklist.findMany({ where: identity, select: { id: true } });
    const dup = same.find((r) => r.id !== id);
    if (dup) { res.status(409).json({ error: 'entry exists already', id: dup.id }); return; }
  }
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
  const scope = scopeOf(req);
  for (const e of entries) {
    const key = `${e.scope}:${e.target}`;
    if (!cache.has(key)) cache.set(key, await resolveTarget(e.scope, e.target));
    const t = cache.get(key)!;
    if ('error' in t) errors.push({ line: e.line, error: t.error });
    // 9.5: every row must lie inside the admin's management scope
    else if (!inScope(scope, t.domainId)) errors.push({ line: e.line, error: OUT_OF_SCOPE_REFUSAL.error });
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
