/**
 * Admin API for the per-mailbox mail flow (9.4, storage mail-flow.ts):
 *
 *   GET /api/v1/admin/mailboxes/:id/mail-flow          (id = user id)
 *   PUT /api/v1/admin/mailboxes/:id/mail-flow
 *   GET /api/v1/admin/shared-mailboxes/:id/mail-flow   (id = SharedMailbox id)
 *   PUT /api/v1/admin/shared-mailboxes/:id/mail-flow
 *
 * PUT takes any subset of the fields (absent = unchanged) and answers with the
 * stored policy. Send limits (maxSendSizeMb, maxRecipients, 10.5: the hourly
 * send rate maxMessagesPerHour / maxRecipientsPerHour) exist for user
 * mailboxes only — mail to a Shared Mailbox is sent by users under their own
 * limits. Every change is audited as `mailbox.mailflow.update` with the diff.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  prisma, loadMailFlowPolicy, saveMailFlowPolicy, parseSenderList, isMailAddress,
  MAX_FLOW_SIZE_MB, MAX_FLOW_RECIPIENTS, MAX_SENDER_LIST_ENTRIES, MAX_FLOW_MESSAGES_PER_HOUR, MAX_FLOW_RECIPIENTS_PER_HOUR,
  type MailFlowOwner, type MailFlowSettings,
} from '@coremail/storage';
import { audit, auditContext } from './audit.js';
import { canManageAccount } from './rbac.js';

export type MailFlowKind = 'user' | 'shared';

const sizeMb = z.number().int().min(1).max(MAX_FLOW_SIZE_MB).nullable();
const senderList = z.array(z.string().max(320)).max(MAX_SENDER_LIST_ENTRIES);

const BaseSchema = z.object({
  hiddenFromGal: z.boolean(),
  forwardTo: z.string().trim().max(320).nullable(),
  forwardKeepCopy: z.boolean(),
  acceptFrom: senderList,
  rejectFrom: senderList,
  maxReceiveSizeMb: sizeMb,
}).partial().strict();

const UserSchema = BaseSchema.extend({
  maxSendSizeMb: sizeMb.optional(),
  maxRecipients: z.number().int().min(1).max(MAX_FLOW_RECIPIENTS).nullable().optional(),
  // 10.5: hourly send rate of this user (storage submission-rate.ts); null = global
  maxMessagesPerHour: z.number().int().min(1).max(MAX_FLOW_MESSAGES_PER_HOUR).nullable().optional(),
  maxRecipientsPerHour: z.number().int().min(1).max(MAX_FLOW_RECIPIENTS_PER_HOUR).nullable().optional(),
}).strict();

export type MailFlowPatch = Partial<MailFlowSettings>;

/**
 * Pure: validates a PUT body. `ownAddresses` (lower case) are the mailbox's own
 * primary address and aliases — forwarding to itself is refused.
 */
export function parseMailFlowPatch(
  body: unknown,
  kind: MailFlowKind,
  ownAddresses: readonly string[],
): { ok: true; patch: MailFlowPatch } | { ok: false; error: string } {
  const p = (kind === 'user' ? UserSchema : BaseSchema).safeParse(body ?? {});
  if (!p.success) return { ok: false, error: 'Ungültige Eingabe' };
  const patch: MailFlowPatch = {};
  const d = p.data as z.infer<typeof UserSchema>;
  if (d.hiddenFromGal !== undefined) patch.hiddenFromGal = d.hiddenFromGal;
  if (d.forwardKeepCopy !== undefined) patch.forwardKeepCopy = d.forwardKeepCopy;
  if (d.forwardTo !== undefined) {
    const to = d.forwardTo === null || d.forwardTo === '' ? null : d.forwardTo.toLowerCase();
    if (to !== null && !isMailAddress(to)) return { ok: false, error: 'Weiterleitungsadresse ist ungültig' };
    if (to !== null && ownAddresses.includes(to)) return { ok: false, error: 'Ein Postfach kann nicht an sich selbst weiterleiten' };
    patch.forwardTo = to;
  }
  for (const key of ['acceptFrom', 'rejectFrom'] as const) {
    const list = d[key];
    if (list === undefined) continue;
    const parsed = parseSenderList(list);
    if (!parsed.ok) return { ok: false, error: `Ungültige Einträge: ${parsed.invalid.slice(0, 5).join(', ')}` };
    patch[key] = parsed.values;
  }
  if (d.maxReceiveSizeMb !== undefined) patch.maxReceiveSizeMb = d.maxReceiveSizeMb;
  if (d.maxSendSizeMb !== undefined) patch.maxSendSizeMb = d.maxSendSizeMb;
  if (d.maxRecipients !== undefined) patch.maxRecipients = d.maxRecipients;
  if (d.maxMessagesPerHour !== undefined) patch.maxMessagesPerHour = d.maxMessagesPerHour;
  if (d.maxRecipientsPerHour !== undefined) patch.maxRecipientsPerHour = d.maxRecipientsPerHour;
  return { ok: true, patch };
}

/** Pure: the changed fields as { field: { from, to } } (for the audit entry). */
export function mailFlowDiff(before: MailFlowSettings, after: MailFlowSettings): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after) as Array<keyof MailFlowSettings>) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { from: before[k], to: after[k] };
  }
  return out;
}

interface Target { owner: MailFlowOwner; email: string; addresses: string[]; role: string | null }

async function loadTarget(kind: MailFlowKind, id: string): Promise<Target | null> {
  if (kind === 'user') {
    const u = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, aliases: { select: { address: true } } } });
    return u ? { owner: { userId: u.id }, email: u.email, addresses: [u.email, ...u.aliases.map((a) => a.address)].map((a) => a.toLowerCase()), role: u.role } : null;
  }
  const s = await prisma.sharedMailbox.findUnique({ where: { id }, select: { id: true, email: true, aliases: { select: { address: true } } } });
  return s ? { owner: { sharedMailboxId: s.id }, email: s.email, addresses: [s.email, ...s.aliases.map((a) => a.address)].map((a) => a.toLowerCase()), role: null } : null;
}

/** Pure: the API view of a policy (send limits only for user mailboxes). */
export function mailFlowView(policy: MailFlowSettings, kind: MailFlowKind): Partial<MailFlowSettings> {
  if (kind === 'user') return policy;
  const { maxSendSizeMb: _s, maxRecipients: _r, maxMessagesPerHour: _m, maxRecipientsPerHour: _h, ...rest } = policy;
  return rest;
}

export function getMailFlowHandler(kind: MailFlowKind) {
  return async (req: Request, res: Response): Promise<void> => {
    const target = await loadTarget(kind, String(req.params['id'] ?? ''));
    if (!target) { res.status(404).json({ error: 'Postfach nicht gefunden' }); return; }
    res.json(mailFlowView(await loadMailFlowPolicy(target.owner), kind));
  };
}

export function putMailFlowHandler(kind: MailFlowKind) {
  return async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params['id'] ?? '');
    const target = await loadTarget(kind, id);
    if (!target) { res.status(404).json({ error: 'Postfach nicht gefunden' }); return; }
    const actor = req.apiUser!;
    // Same rule as other changes of an account: admin mailboxes are ORGANIZATION_MANAGEMENT-only.
    if (target.role !== null && !canManageAccount(actor.role, target.role)) {
      res.status(403).json({ error: 'Nur die Organisationsverwaltung darf Admin-Postfächer ändern', code: 'FORBIDDEN' });
      return;
    }
    const parsed = parseMailFlowPatch(req.body, kind, target.addresses);
    if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
    const before = await loadMailFlowPolicy(target.owner);
    const after = await saveMailFlowPolicy(target.owner, { ...before, ...parsed.patch });
    const diff = mailFlowDiff(before, after);
    if (Object.keys(diff).length > 0) {
      audit({
        actorId: actor.userId, actorEmail: actor.email,
        action: 'mailbox.mailflow.update', targetType: kind === 'user' ? 'mailbox' : 'sharedMailbox', targetId: id, targetName: target.email,
        changes: diff,
        ...auditContext(req),
      });
    }
    res.json(mailFlowView(after, kind));
  };
}
