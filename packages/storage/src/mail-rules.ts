import { prisma } from './prisma/index.js';
import { moveMessages, touchMessages } from './message-store.js';
import type { ParsedMessage } from './mime/index.js';
import { deliveredImportance } from './importance.js';
import { createLogger } from '@coremail/core';
import {
  matchRulePattern, createRulePatternBudget, evaluateRulePattern, withRuleBudget, ruleMessageStepBudget, type RulePatternBudget,
} from './rule-pattern.js';

export {
  validateRulePattern, matchRulePattern, tryMatchRulePattern, MAX_RULE_PATTERN_LENGTH, MAX_RULE_MATCH_INPUT,
  createRulePatternBudget, rulePatternStepBudget, countRegexConditions, MAX_REGEX_CONDITIONS_PER_USER,
  DEFAULT_RULE_PATTERN_STEP_BUDGET, canonicalizeCodeUnit, type RulePatternBudget,
  DEFAULT_RULE_PATTERN_MESSAGE_STEP_BUDGET, ruleMessageStepBudget, withRuleBudget, evaluateRulePattern,
} from './rule-pattern.js';

const log = createLogger('storage:mail-rules');

// ─────────────────────────────────────────────────────────────────────────────
// Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

export type RuleField =
  | 'from'        // From address
  | 'to'          // To recipient (any)
  | 'cc'          // CC recipient (any)
  | 'bcc'         // BCC recipient
  | 'subject'     // Subject
  | 'body'        // Body (Text + HTML)
  | 'recipient'   // To/CC/BCC combined
  | 'hasAttachment'   // Boolean
  | 'size'        // Bytes
  | 'importance'  // 'high' | 'normal' | 'low' from X-Priority
  | 'sentOnlyToMe';   // recipients == only user.email

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
    case 'importance': return parsed.importance ?? 'normal';
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
  budget?: RulePatternBudget,
): boolean {
  // Boolean fields: only is/equals make sense
  if (typeof fieldValue === 'boolean') {
    if (operator === 'is' || operator === 'equals') return fieldValue === Boolean(expected);
    if (operator === 'notEquals') return fieldValue !== Boolean(expected);
    return false;
  }
  // Numeric fields
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
  // String fields
  const fv = String(fieldValue);
  const ev = String(expected).toLowerCase();
  switch (operator) {
    case 'contains':    return fv.includes(ev);
    case 'notContains': return !fv.includes(ev);
    case 'equals':      return fv === ev;
    case 'notEquals':   return fv !== ev;
    case 'startsWith':  return fv.startsWith(ev);
    case 'endsWith':    return fv.endsWith(ev);
    case 'regex':
      // Never the backtracking engine on mail content (ReDoS on the SMTP
      // delivery path): linear-time matcher, input capped at 64 KB.
      return matchRulePattern(String(expected), fv, budget);
    case 'is': return fv === ev;
    default: return false;
  }
}

function matchCondition(cond: RuleCondition, parsed: ParsedMessage, userEmail: string, budget?: RulePatternBudget): boolean {
  const fv = getFieldValue(cond.field, parsed, userEmail);
  return evaluateOperator(fv, cond.operator, cond.value, budget);
}

/** Tri-state: a regex condition whose step budget ran out is `exhausted`, not a plain no-match. */
function conditionState(cond: RuleCondition, parsed: ParsedMessage, userEmail: string, budget?: RulePatternBudget): 'match' | 'nomatch' | 'exhausted' {
  const fv = getFieldValue(cond.field, parsed, userEmail);
  if (cond.operator === 'regex' && budget && typeof fv !== 'boolean' && typeof fv !== 'number') {
    const r = evaluateRulePattern(String(cond.value), String(fv), budget);
    return r === 'match' ? 'match' : r === 'exhausted' ? 'exhausted' : 'nomatch';
  }
  return evaluateOperator(fv, cond.operator, cond.value, budget) ? 'match' : 'nomatch';
}

/**
 * Inbox rules fail OPEN on an exhausted regex budget: a condition that cannot be
 * evaluated does not match, an exception that cannot be evaluated counts as
 * matched — either way the rule is not applied (and `onExhausted` logs it).
 * Inbox rules only file/flag/forward the user's own mail; the security-relevant
 * fail-closed handling is in the transport rules.
 */
function matchRule(
  rule: MailRuleData, parsed: ParsedMessage, userEmail: string, budget?: RulePatternBudget, onExhausted?: () => void,
): boolean {
  let exhausted = false;
  const state = (c: RuleCondition): 'match' | 'nomatch' | 'exhausted' => {
    const s = conditionState(c, parsed, userEmail, budget);
    if (s === 'exhausted') exhausted = true;
    return s;
  };
  try {
    // Exceptions are ALWAYS OR: if any exception matches → skip the rule
    for (const exc of rule.exceptions) {
      if (state(exc) !== 'nomatch') return false;
    }
    if (rule.conditions.length === 0) return true;
    if (rule.matchAll) return rule.conditions.every((c) => state(c) === 'match');
    return rule.conditions.some((c) => state(c) === 'match');
  } finally {
    if (exhausted) onExhausted?.();
  }
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
  /**
   * Regex step budget for this message (RULE_PATTERN_STEP_BUDGET), shared with
   * the transport rules by the delivery path; default: a fresh one.
   */
  patternBudget: RulePatternBudget = createRulePatternBudget({ steps: ruleMessageStepBudget(), onExhausted: () => logBudgetExhausted(userId) }),
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

    // Each rule has its own step budget, bounded by the message budget.
    const matched = withRuleBudget(patternBudget, (budget) => matchRule(rule, parsed, userEmail, budget, () =>
      log.warn({ userId, ruleId: rule.id }, 'Regex step budget exhausted — inbox rule treated as not matching')));
    if (!matched) continue;

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

function logBudgetExhausted(userId: string): void {
  log.warn({ userId }, 'Message regex step budget exhausted (RULE_PATTERN_MESSAGE_STEP_BUDGET) — remaining inbox rules with regex conditions do not apply');
}

// Convenience export for tests
export const __internals = { matchCondition, matchRule, evaluateOperator, getFieldValue };

// ─────────────────────────────────────────────────────────────────────────────
// Run-Now (retroactive application of a rule to existing DB messages)
// ─────────────────────────────────────────────────────────────────────────────

export interface RunNowResult {
  scanned: number;
  matched: number;
  moved: number;
  flagged: number;
  errors: number;
}

/**
 * Applies a single rule retroactively to existing messages.
 * Forward/redirect actions are NOT executed (that would be spam) —
 * only Move/Copy/Flag/Categorize/Pin/MarkRead/SetImportance.
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
  // Always scoped to the rule owner's mailbox: caller-supplied folderIds only
  // narrow the selection, they can never reach another user's folders.
  const messages = await prisma.message.findMany({
    where: {
      folder: { mailbox: { userId } },
      deletedAt: null,
      ...(opts.folderIds && opts.folderIds.length > 0 ? { folderId: { in: opts.folderIds } } : {}),
    },
    select: {
      id: true, folderId: true, flags: true,
      subject: true, fromAddr: true, fromName: true,
      toAddrs: true, ccAddrs: true, bccAddrs: true,
      replyTo: true, messageId: true, inReplyTo: true,
      date: true, bodyText: true, bodyHtml: true,
      rawSize: true, importance: true,
    },
    take: limit,
    orderBy: { date: 'desc' },
  });

  for (const m of messages) {
    result.scanned++;
    // build a synthetic ParsedMessage from DB fields
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
      references: [],
      dispositionNotificationTo: null,
      importance: m.importance === 'high' || m.importance === 'low' ? m.importance : null,
      sensitivity: null,   // no rule condition reads it
      date:      m.date,
      bodyText:  m.bodyText,
      bodyHtml:  m.bodyHtml,
      attachments: [], // hasAttachment condition cannot be checked here
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

      const updates: { flags?: string[]; pinnedAt?: Date | null; importance?: string | null } = {};
      let changed = false;
      let moveTo: string | null = null;

      if (outcome.targetFolderId && outcome.targetFolderId !== m.folderId) {
        moveTo = outcome.targetFolderId;
        result.moved++;
      }
      const newFlags = [...new Set([...m.flags, ...outcome.flagsToAdd])];
      if (newFlags.length !== m.flags.length) {
        updates.flags = newFlags;
        result.flagged++;
        changed = true;
      }
      if (outcome.pinned) { updates.pinnedAt = new Date(); changed = true; }
      // 9.4: "set importance" — the stored value (normal = null), through the message store
      if (outcome.importance !== null) {
        const level = deliveredImportance(null, outcome.importance);
        if (level !== (m.importance ?? null)) { updates.importance = level; changed = true; }
      }
      // Move → new UID in the target folder + new modSeq; other changes → new modSeq.
      if (moveTo) {
        const target = moveTo;
        await prisma.$transaction((tx) => moveMessages(tx, [m.id], target, { data: updates }));
      } else if (changed) {
        await prisma.$transaction((tx) => touchMessages(tx, [m.id], updates));
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
