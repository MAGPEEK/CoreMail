import { createLogger } from '@coremail/core';
import { prisma, tryMatchRulePattern } from '@coremail/storage';

const log = createLogger('security-filter:blacklist');

export interface BlacklistCheckResult {
  blocked: boolean;
  reason?: string;
  matchedPattern?: string;
}

export interface BlacklistEntryLike {
  pattern: string;
  patternType: string; // EXACT | WILDCARD | REGEX
}

/**
 * Pure: does one blacklist entry match the sender address?
 * EXACT/WILDCARD compare case-insensitively. REGEX patterns are matched
 * as written, case-insensitively — they must NOT be lower-cased first
 * (that turned `\D` into `\d`, `\S` into `\s`, `\W` into `\w`).
 * Returns null for an invalid or unsupported regex.
 */
export function matchBlacklistEntry(entry: BlacklistEntryLike, fromAddr: string): { matched: boolean; reason: string } | null {
  const lowerFrom = fromAddr.toLowerCase();
  const fromDomain = lowerFrom.includes('@') ? lowerFrom.slice(lowerFrom.lastIndexOf('@') + 1) : '';

  if (entry.patternType === 'EXACT') {
    return { matched: lowerFrom === entry.pattern.toLowerCase(), reason: 'Sender blocked' };
  }
  if (entry.patternType === 'WILDCARD') {
    const pattern = entry.pattern.toLowerCase();
    if (pattern.startsWith('*@')) {
      return { matched: fromDomain === pattern.slice(2), reason: 'Sender domain blocked' };
    }
    return { matched: matchWildcard(lowerFrom, pattern), reason: 'Sender blocked' };
  }
  if (entry.patternType === 'REGEX') {
    // v8.1: linear-time matcher (storage rule-pattern.ts) — the sender address is
    // attacker-controlled; a backtracking RegExp could stall the filter (ReDoS).
    // Unsupported syntax (backreferences, lookarounds) → null (skipped + logged);
    // new patterns are validated when saved in the admin API.
    const m = tryMatchRulePattern(entry.pattern, fromAddr);
    return m === null ? null : { matched: m, reason: 'Sender blocked by policy' };
  }
  return { matched: false, reason: '' };
}

export async function checkBlacklist(
  fromAddr: string,
  domainId?: string,
  userId?: string,
): Promise<BlacklistCheckResult> {
  // Fetch all relevant blacklist entries (global + domain + user)
  const entries = await prisma.blacklist.findMany({
    where: {
      active: true,
      OR: [
        { scope: 'GLOBAL' },
        ...(domainId ? [{ scope: 'DOMAIN', scopeId: domainId }] : []),
        ...(userId ? [{ scope: 'USER', scopeId: userId }] : []),
      ],
    },
  });

  for (const entry of entries) {
    const m = matchBlacklistEntry(entry, fromAddr);
    if (m === null) {
      log.warn({ pattern: entry.pattern }, 'Invalid blacklist regex — skipping');
      continue;
    }
    if (m.matched) {
      log.info({ fromAddr, pattern: entry.pattern, type: entry.patternType }, 'Blacklist match');
      return { blocked: true, reason: m.reason, matchedPattern: entry.pattern };
    }
  }

  return { blocked: false };
}

/**
 * Glob match with `*` (any run, also empty) — iterative two-pointer algorithm,
 * O(len(str) × len(pattern)) worst case, no RegExp backtracking.
 * (Exported for tests.)
 */
export function matchWildcard(str: string, pattern: string): boolean {
  let s = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (s < str.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === str[s]) { s++; p++; continue; }
    if (p < pattern.length && pattern[p] === '*') { star = p++; mark = s; continue; }
    if (star >= 0) { p = star + 1; s = ++mark; continue; }
    return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}
