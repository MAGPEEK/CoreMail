/**
 * TransportRule engine — server-wide rules (admin-configured, Exchange-style).
 *
 * Unlike MailRule (per user), TransportRules are evaluated on EVERY incoming
 * and outgoing mail. They modify the mail before delivery
 * (headers, subject, disclaimer) or control routing (reject, redirect,
 * addRecipient, quarantine).
 *
 * Usage: `applyTransportRules(parsed, opts)` returns a TransportOutcome.
 *   The caller (smtp-server/handlers/message.ts or api-gateway send)
 *   must then interpret the outcome:
 *     - `rejected`         → mail is discarded (5xx bounce)
 *     - `quarantined`      → mail goes to the quarantine table, no mailbox delivery
 *     - `redirectedTo`     → recipient is replaced
 *     - `additionalRcpts`  → additional recipients (BCC-like)
 *     - `headerChanges`    → headers added to the RFC 822 buffer
 *     - `subjectPrefix/Suffix` → prepended/appended to `parsed.subject`
 *     - `disclaimer`       → HTML block appended to bodyHtml
 */

import { prisma } from './prisma/index.js';
import type { ParsedMessage } from './mime/index.js';
import { createLogger } from '@coremail/core';

const log = createLogger('storage:transport-rules');

export type TransportField = 'from' | 'to' | 'cc' | 'subject' | 'body' | 'hasAttachment' | 'size' | 'spamScore';
export type TransportOp    = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith' | 'regex'
                            | 'greaterThan' | 'lessThan' | 'is';

export interface TransportCondition { field: TransportField; op: TransportOp; value: string }
export interface TransportAction    {
  type:  'addHeader' | 'removeHeader' | 'redirect' | 'reject' | 'addRecipient' | 'removeRecipient'
       | 'setSubjectPrefix' | 'setSubjectSuffix' | 'quarantine' | 'addDisclaimer';
  value: string;
}

export interface TransportOutcome {
  rejected:          boolean;
  rejectReason?:     string;
  quarantined:       boolean;
  redirectedTo:      string[];   // replaces original recipients
  additionalRcpts:   string[];   // additional, BCC-like
  removedRcpts:      string[];   // remove from original
  headerAdds:        { name: string; value: string }[];
  headerRemoves:     string[];
  subjectPrefix:     string;
  subjectSuffix:     string;
  disclaimerHtml:    string;
  appliedRuleIds:    string[];
}

interface TransportEvalContext {
  /** Who the original recipient is (relevant for `to`/`cc` fields in the match) */
  envelopeRcpt?: string;
  /** rspamd score (if available) */
  spamScore?:   number;
}

// ─────────────────────────────────────────────────────────────────────────────

function getFieldValue(field: TransportField, parsed: ParsedMessage, ctx: TransportEvalContext): string | number | boolean {
  switch (field) {
    case 'from':          return parsed.fromAddr.toLowerCase();
    case 'to':            return parsed.toAddrs.join(', ').toLowerCase();
    case 'cc':            return parsed.ccAddrs.join(', ').toLowerCase();
    case 'subject':       return (parsed.subject ?? '').toLowerCase();
    case 'body':          return ((parsed.bodyText ?? '') + ' ' + (parsed.bodyHtml ?? '')).toLowerCase();
    case 'hasAttachment': return parsed.attachments.length > 0;
    case 'size':          return parsed.size;
    case 'spamScore':     return ctx.spamScore ?? 0;
  }
}

function evaluateOp(fv: string | number | boolean, op: TransportOp, expected: string): boolean {
  if (typeof fv === 'boolean') {
    if (op === 'is' || op === 'equals') return fv === (expected === 'true' || expected === '1');
    return false;
  }
  if (typeof fv === 'number') {
    const n = Number(expected);
    if (Number.isNaN(n)) return false;
    switch (op) {
      case 'equals':      return fv === n;
      case 'greaterThan': return fv > n;
      case 'lessThan':    return fv < n;
      default: return false;
    }
  }
  const ev = expected.toLowerCase();
  switch (op) {
    case 'contains':    return fv.includes(ev);
    case 'notContains': return !fv.includes(ev);
    case 'equals':      return fv === ev;
    case 'startsWith':  return fv.startsWith(ev);
    case 'endsWith':    return fv.endsWith(ev);
    case 'regex': {
      try { return new RegExp(expected, 'i').test(fv); } catch { return false; }
    }
    case 'is': return fv === ev;
    default: return false;
  }
}

function ruleMatches(conditions: TransportCondition[], parsed: ParsedMessage, ctx: TransportEvalContext): boolean {
  // Conditions are AND-combined (Exchange Transport Rules standard)
  if (conditions.length === 0) return true;
  return conditions.every((c) => evaluateOp(getFieldValue(c.field, parsed, ctx), c.op, c.value));
}

// ─────────────────────────────────────────────────────────────────────────────

export async function applyTransportRules(
  parsed: ParsedMessage,
  ctx: TransportEvalContext = {},
): Promise<TransportOutcome> {
  const outcome: TransportOutcome = {
    rejected:        false,
    quarantined:     false,
    redirectedTo:    [],
    additionalRcpts: [],
    removedRcpts:    [],
    headerAdds:      [],
    headerRemoves:   [],
    subjectPrefix:   '',
    subjectSuffix:   '',
    disclaimerHtml:  '',
    appliedRuleIds:  [],
  };

  let rules: { id: string; name: string; conditions: unknown; actions: unknown; priority: number; enabled: boolean }[];
  try {
    rules = await prisma.transportRule.findMany({
      where: { enabled: true },
      orderBy: { priority: 'asc' },
    });
  } catch (err) {
    log.error({ err }, 'TransportRules load failed — mail flow continues without rule evaluation');
    return outcome;
  }

  if (rules.length === 0) return outcome;

  for (const raw of rules) {
    const conditions = Array.isArray(raw.conditions) ? raw.conditions as unknown as TransportCondition[] : [];
    const actions    = Array.isArray(raw.actions)    ? raw.actions as unknown as TransportAction[]    : [];

    if (!ruleMatches(conditions, parsed, ctx)) continue;
    outcome.appliedRuleIds.push(raw.id);

    for (const action of actions) {
      switch (action.type) {
        case 'addHeader': {
          // value format: "X-Header-Name: value"  or "X-Header-Name=value"
          const sep = action.value.indexOf(':') >= 0 ? ':' : '=';
          const idx = action.value.indexOf(sep);
          if (idx > 0) {
            const name  = action.value.slice(0, idx).trim();
            const value = action.value.slice(idx + 1).trim();
            outcome.headerAdds.push({ name, value });
          }
          break;
        }
        case 'removeHeader':
          if (action.value.trim()) outcome.headerRemoves.push(action.value.trim());
          break;
        case 'redirect':
          // comma-separated list — replaces original recipients
          outcome.redirectedTo.push(...action.value.split(',').map((s) => s.trim()).filter(Boolean));
          break;
        case 'reject':
          outcome.rejected = true;
          outcome.rejectReason = action.value || `Blocked by transport rule: ${raw.name}`;
          break;
        case 'addRecipient':
          outcome.additionalRcpts.push(...action.value.split(',').map((s) => s.trim()).filter(Boolean));
          break;
        case 'removeRecipient':
          outcome.removedRcpts.push(...action.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
          break;
        case 'setSubjectPrefix':
          outcome.subjectPrefix = outcome.subjectPrefix + action.value;
          break;
        case 'setSubjectSuffix':
          outcome.subjectSuffix = outcome.subjectSuffix + action.value;
          break;
        case 'quarantine':
          outcome.quarantined = true;
          break;
        case 'addDisclaimer':
          outcome.disclaimerHtml += `\n<div style="border-top:1px solid #ccc;margin-top:1em;padding-top:0.5em;font-size:0.85em;color:#666">${action.value}</div>`;
          break;
      }
    }

    // Reject is terminal — do not evaluate further rules
    if (outcome.rejected) {
      log.info({ ruleId: raw.id, ruleName: raw.name, reason: outcome.rejectReason }, 'Mail rejected by TransportRule');
      break;
    }
  }

  if (outcome.appliedRuleIds.length > 0) {
    log.debug({ ruleIds: outcome.appliedRuleIds }, 'TransportRules applied');
  }

  return outcome;
}

/**
 * Applies the header/subject/disclaimer modifications from the outcome to an
 * RFC 822 buffer. Local helper so the caller does not have to do
 * MIME parsing itself.
 */
export function applyOutcomeToBuffer(buffer: Buffer, outcome: TransportOutcome): Buffer {
  if (
    outcome.headerAdds.length === 0 &&
    outcome.headerRemoves.length === 0 &&
    !outcome.subjectPrefix &&
    !outcome.subjectSuffix &&
    !outcome.disclaimerHtml
  ) {
    return buffer;
  }

  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return buffer; // No RFC 822 header/body separator found → do nothing

  let headerText = buffer.subarray(0, headerEnd).toString('utf8');
  let bodyBuf    = buffer.subarray(headerEnd + 4);

  // Subject manipulation
  if (outcome.subjectPrefix || outcome.subjectSuffix) {
    headerText = headerText.replace(
      /^Subject:\s*(.*)$/im,
      (_m, current: string) => `Subject: ${outcome.subjectPrefix}${current}${outcome.subjectSuffix}`,
    );
  }

  // Header removes (case-insensitive, all occurrences)
  for (const name of outcome.headerRemoves) {
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:.*(?:\\r?\\n[ \\t].*)*\\r?\\n`, 'gim');
    headerText = headerText.replace(re, '');
  }

  // Header adds
  for (const h of outcome.headerAdds) {
    headerText += `\r\n${h.name}: ${h.value}`;
  }

  // Disclaimer (modify HTML body only — plain-text fallback skipped for MVP)
  if (outcome.disclaimerHtml) {
    const bodyStr = bodyBuf.toString('utf8');
    // Simple heuristic: insert before </body>, otherwise append at the end
    const modified = bodyStr.includes('</body>')
      ? bodyStr.replace('</body>', `${outcome.disclaimerHtml}\n</body>`)
      : bodyStr + outcome.disclaimerHtml;
    bodyBuf = Buffer.from(modified, 'utf8');
  }

  return Buffer.concat([Buffer.from(headerText + '\r\n\r\n', 'utf8'), bodyBuf]);
}
