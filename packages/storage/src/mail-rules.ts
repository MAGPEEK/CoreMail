import { prisma } from './prisma/index.js';
import type { ParsedMessage } from './mime/index.js';
import { createLogger } from '@coremail/core';

const log = createLogger('storage:mail-rules');

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

export type RuleField =
  | 'from'        // From-Adresse
  | 'to'          // To-Empfänger (irgendein)
  | 'cc'          // CC-Empfänger (irgendein)
  | 'bcc'         // BCC-Empfänger
  | 'subject'     // Betreff
  | 'body'        // Body (Text + HTML)
  | 'recipient'   // To/CC/BCC kombiniert
  | 'hasAttachment'   // Boolean
  | 'size'        // Bytes
  | 'importance'  // 'high' | 'normal' | 'low' aus X-Priority
  | 'sentOnlyToMe';   // Empfänger == nur user.email

export type RuleOperator =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'greaterThan'   // size only
  | 'lessThan'      // size only
  | 'is';           // hasAttachment / importance / sentOnlyToMe

export interface RuleCondition {
  field: RuleField;
  operator: RuleOperator;
  value: string | number | boolean;
}

export type RuleAction =
  | { type: 'moveTo';        folderId: string }
  | { type: 'copyTo';        folderId: string }
  | { type: 'delete' }
  | { type: 'hardDelete' }
  | { type: 'markRead' }
  | { type: 'markFlagged' }
  | { type: 'pin' }
  | { type: 'categorize';    categoryId: string }
  | { type: 'forward';       address: string }
  | { type: 'redirect';      address: string }
  | { type: 'markJunk' }
  | { type: 'setImportance'; value: 'high' | 'normal' | 'low' };

export interface MailRuleData {
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: RuleCondition[];
  exceptions: RuleCondition[];
  actions: RuleAction[];
  stopProcessing: boolean;
  matchAll: boolean; // true = AND, false = OR
}

export interface RuleOutcome {
  targetFolderId?: string;
  flagsToAdd: string[];
  categoriesToAdd: string[];
  pinned: boolean;
  forwards: { address: string; mode: 'forward' | 'redirect' }[];
  copyTargets: string[];
  deleted: 'soft' | 'hard' | null;
  forceJunk: boolean;
  importance: 'high' | 'normal' | 'low' | null;
  appliedRuleIds: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Condition Evaluation
// ─────────────────────────────────────────────────────────────────────────────

function getFieldValue(field: RuleField, parsed: ParsedMessage, userEmail: string): string | number | boolean {
  switch (field) {
    case 'from':      return parsed.fromAddr.toLowerCase();
    case 'to':        return parsed.toAddrs.join(', ').toLowerCase();
    case 'cc':        return parsed.ccAddrs.join(', ').toLowerCase();
    case 'bcc':       return parsed.bccAddrs.join(', ').toLowerCase();
    case 'recipient': return [...parsed.toAddrs, ...parsed.ccAddrs, ...parsed.bccAddrs].join(', ').toLowerCase();
    case 'subject':   return (parsed.subject ?? '').toLowerCase();
    case 'body':      return ((parsed.bodyText ?? '') + ' ' + (parsed.bodyHtml ?? '')).toLowerCase();
    case 'hasAttachment': return parsed.attachments.length > 0;
    case 'size':      return parsed.size;
    case 'importance': return 'normal'; // TODO: aus X-Priority parsen, vorerst neutral
    case 'sentOnlyToMe': {
      const me = userEmail.toLowerCase();
      const recips = [...parsed.toAddrs, ...parsed.ccAddrs, ...parsed.bccAddrs].map((r) => r.toLowerCase());
      return recips.length === 1 && recips[0] === me;
    }
  }
}

function evaluateOperator(
  fieldValue: string | number | boolean,
  operator: RuleOperator,
  expected: string | number | boolean,
): boolean {
  // Bool-Felder: nur is/equals sinnvoll
  if (typeof fieldValue === 'boolean') {
    if (operator === 'is' || operator === 'equals') return fieldValue === Boolean(expected);
    if (operator === 'notEquals') return fieldValue !== Boolean(expected);
    return false;
  }
  // Numerische Felder
  if (typeof fieldValue === 'number') {
    const exp = Number(expected);
    if (Number.isNaN(exp)) return false;
    switch (operator) {
      case 'equals':      return fieldValue === exp;
      case 'notEquals':   return fieldValue !== exp;
      case 'greaterThan': return fieldValue > exp;
      case 'lessThan':    return fieldValue < exp;
      default: return false;
    }
  }
  // String-Felder
  const fv = String(fieldValue);
  const ev = String(expected).toLowerCase();
  switch (operator) {
    case 'contains':    return fv.includes(ev);
    case 'notContains': return !fv.includes(ev);
    case 'equals':      return fv === ev;
    case 'notEquals':   return fv !== ev;
    case 'startsWith':  return fv.startsWith(ev);
    case 'endsWith':    return fv.endsWith(ev);
    case 'regex': {
      try {
        const re = new RegExp(String(expected), 'i');
        return re.test(fv);
      } catch {
        return false;
      }
    }
    case 'is': return fv === ev;
    default: return false;
  }
}

function matchCondition(cond: RuleCondition, parsed: ParsedMessage, userEmail: string): boolean {
  const fv = getFieldValue(cond.field, parsed, userEmail);
  return evaluateOperator(fv, cond.operator, cond.value);
}

function matchRule(rule: MailRuleData, parsed: ParsedMessage, userEmail: string): boolean {
  // Exceptions IMMER OR: trifft eine Exception zu → Regel überspringen
  for (const exc of rule.exceptions) {
    if (matchCondition(exc, parsed, userEmail)) return false;
  }
  if (rule.conditions.length === 0) return true;
  if (rule.matchAll) {
    return rule.conditions.every((c) => matchCondition(c, parsed, userEmail));
  }
  return rule.conditions.some((c) => matchCondition(c, parsed, userEmail));
}

// ─────────────────────────────────────────────────────────────────────────────
// Action Execution (returns outcome, does NOT touch DB except for read-validation)
// ─────────────────────────────────────────────────────────────────────────────

async function executeActions(
  rule: MailRuleData,
  outcome: RuleOutcome,
  userId: string,
): Promise<void> {
  for (const action of rule.actions) {
    switch (action.type) {
      case 'moveTo': {
        const folder = await prisma.folder.findFirst({
          where: { id: action.folderId, mailbox: { userId } },
        });
        if (folder) outcome.targetFolderId = folder.id;
        break;
      }
      case 'copyTo': {
        const folder = await prisma.folder.findFirst({
          where: { id: action.folderId, mailbox: { userId } },
        });
        if (folder && !outcome.copyTargets.includes(folder.id)) {
          outcome.copyTargets.push(folder.id);
        }
        break;
      }
      case 'delete':
        outcome.deleted = outcome.deleted === 'hard' ? 'hard' : 'soft';
        break;
      case 'hardDelete':
        outcome.deleted = 'hard';
        break;
      case 'markRead':
        if (!outcome.flagsToAdd.includes('\\Seen')) outcome.flagsToAdd.push('\\Seen');
        break;
      case 'markFlagged':
        if (!outcome.flagsToAdd.includes('\\Flagged')) outcome.flagsToAdd.push('\\Flagged');
        break;
      case 'pin':
        outcome.pinned = true;
        break;
      case 'categorize':
        if (!outcome.categoriesToAdd.includes(action.categoryId)) {
          outcome.categoriesToAdd.push(action.categoryId);
        }
        break;
      case 'forward':
        outcome.forwards.push({ address: action.address, mode: 'forward' });
        break;
      case 'redirect':
        outcome.forwards.push({ address: action.address, mode: 'redirect' });
        break;
      case 'markJunk':
        outcome.forceJunk = true;
        break;
      case 'setImportance':
        outcome.importance = action.value;
        break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export async function applyMailRules(
  parsed: ParsedMessage,
  userId: string,
  userEmail: string,
  defaultFolderId: string,
): Promise<RuleOutcome> {
  const outcome: RuleOutcome = {
    targetFolderId: defaultFolderId,
    flagsToAdd: [],
    categoriesToAdd: [],
    pinned: false,
    forwards: [],
    copyTargets: [],
    deleted: null,
    forceJunk: false,
    importance: null,
    appliedRuleIds: [],
  };

  let rules: { id: string; userId: string; name: string; enabled: boolean; priority: number;
               conditions: unknown; exceptions: unknown; actions: unknown;
               stopProcessing: boolean; matchAll: boolean }[];
  try {
    rules = await prisma.mailRule.findMany({
      where: { userId, enabled: true },
      orderBy: { priority: 'asc' },
    });
  } catch (err) {
    log.error({ err, userId }, 'Failed to load mail rules — skipping rule processing');
    return outcome;
  }

  if (rules.length === 0) return outcome;

  for (const raw of rules) {
    const rule: MailRuleData = {
      id: raw.id,
      userId: raw.userId,
      name: raw.name,
      enabled: raw.enabled,
      priority: raw.priority,
      conditions: Array.isArray(raw.conditions) ? raw.conditions as RuleCondition[] : [],
      exceptions: Array.isArray(raw.exceptions) ? raw.exceptions as RuleCondition[] : [],
      actions:    Array.isArray(raw.actions)    ? raw.actions as RuleAction[]    : [],
      stopProcessing: raw.stopProcessing,
      matchAll: raw.matchAll,
    };

    if (!matchRule(rule, parsed, userEmail)) continue;

    try {
      await executeActions(rule, outcome, userId);
      outcome.appliedRuleIds.push(rule.id);
      log.debug({ ruleId: rule.id, ruleName: rule.name, userId }, 'Mail rule applied');
    } catch (err) {
      log.error({ err, ruleId: rule.id }, 'Rule action execution failed — continuing with next rule');
    }

    if (rule.stopProcessing) break;
  }

  return outcome;
}

// Convenience export for tests
export const __internals = { matchCondition, matchRule, evaluateOperator, getFieldValue };

// ─────────────────────────────────────────────────────────────────────────────
// Run-Now (retroaktive Anwendung einer Regel auf bestehende DB-Messages)
// ─────────────────────────────────────────────────────────────────────────────

export interface RunNowResult {
  scanned: number;
  matched: number;
  moved: number;
  flagged: number;
  errors: number;
}

/**
 * Wendet eine einzelne Rule retroaktiv auf vorhandene Messages an.
 * Forward/Redirect-Aktionen werden NICHT ausgeführt (das wäre Spam) —
 * nur Move/Copy/Flag/Categorize/Pin/MarkRead.
 */
export async function runRuleOnExisting(
  ruleId: string,
  userId: string,
  userEmail: string,
  opts: { folderIds?: string[]; limit?: number } = {},
): Promise<RunNowResult> {
  const result: RunNowResult = { scanned: 0, matched: 0, moved: 0, flagged: 0, errors: 0 };

  const raw = await prisma.mailRule.findFirst({ where: { id: ruleId, userId } });
  if (!raw) throw new Error('Rule not found');

  const rule: MailRuleData = {
    id: raw.id, userId: raw.userId, name: raw.name, enabled: raw.enabled, priority: raw.priority,
    conditions: Array.isArray(raw.conditions) ? raw.conditions as unknown as RuleCondition[] : [],
    exceptions: Array.isArray(raw.exceptions) ? raw.exceptions as unknown as RuleCondition[] : [],
    actions:    Array.isArray(raw.actions)    ? raw.actions as unknown as RuleAction[]    : [],
    stopProcessing: raw.stopProcessing, matchAll: raw.matchAll,
  };

  const limit = Math.min(opts.limit ?? 1000, 5000);
  const folderFilter = opts.folderIds && opts.folderIds.length > 0
    ? { folderId: { in: opts.folderIds } }
    : { folder: { mailbox: { userId } } };

  const messages = await prisma.message.findMany({
    where: folderFilter,
    select: {
      id: true, folderId: true, flags: true,
      subject: true, fromAddr: true, fromName: true,
      toAddrs: true, ccAddrs: true, bccAddrs: true,
      replyTo: true, messageId: true, inReplyTo: true,
      date: true, bodyText: true, bodyHtml: true,
      rawSize: true,
    },
    take: limit,
    orderBy: { date: 'desc' },
  });

  for (const m of messages) {
    result.scanned++;
    // synthetische ParsedMessage aus DB-Feldern bauen
    const synth: ParsedMessage = {
      subject:   m.subject ?? '',
      fromAddr:  m.fromAddr,
      fromName:  m.fromName ?? '',
      toAddrs:   m.toAddrs,
      ccAddrs:   m.ccAddrs,
      bccAddrs:  m.bccAddrs,
      replyTo:   m.replyTo,
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      date:      m.date,
      bodyText:  m.bodyText,
      bodyHtml:  m.bodyHtml,
      attachments: [], // hasAttachment-Condition kann hier nicht geprüft werden
      size:      m.rawSize,
    };

    if (!matchRule(rule, synth, userEmail)) continue;
    result.matched++;

    try {
      const outcome: RuleOutcome = {
        targetFolderId: m.folderId,
        flagsToAdd: [], categoriesToAdd: [], pinned: false,
        forwards: [], copyTargets: [], deleted: null, forceJunk: false,
        importance: null, appliedRuleIds: [],
      };
      await executeActions(rule, outcome, userId);

      const updates: { folderId?: string; flags?: string[]; pinnedAt?: Date | null } = {};
      let changed = false;

      if (outcome.targetFolderId && outcome.targetFolderId !== m.folderId) {
        updates.folderId = outcome.targetFolderId;
        result.moved++;
        changed = true;
      }
      const newFlags = [...new Set([...m.flags, ...outcome.flagsToAdd])];
      if (newFlags.length !== m.flags.length) {
        updates.flags = newFlags;
        result.flagged++;
        changed = true;
      }
      if (outcome.pinned) { updates.pinnedAt = new Date(); changed = true; }
      if (changed) {
        await prisma.message.update({ where: { id: m.id }, data: updates });
      }
      // Categories
      for (const catId of outcome.categoriesToAdd) {
        await prisma.messageCategory.upsert({
          where:  { messageId_categoryId: { messageId: m.id, categoryId: catId } },
          create: { messageId: m.id, categoryId: catId },
          update: {},
        }).catch(() => undefined);
      }
    } catch (err) {
      log.warn({ err, ruleId, msgId: m.id }, 'run-now: action failed for one message');
      result.errors++;
    }
  }

  return result;
}
