import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';

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

/** Longer user regexes are refused (cheap guard against pathological patterns). */
const MAX_REGEX_LENGTH = 512;

/**
 * Pure: does one blacklist entry match the sender address?
 * EXACT/WILDCARD compare case-insensitively. REGEX patterns are compiled
 * as written with the `i` flag — they must NOT be lower-cased first
 * (that turned `\D` into `\d`, `\S` into `\s`, `\W` into `\w`).
 * Returns null for an invalid regex.
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
    if (entry.pattern.length > MAX_REGEX_LENGTH) return null;
    try {
      return { matched: new RegExp(entry.pattern, 'i').test(fromAddr), reason: 'Sender blocked by policy' };
    } catch {
      return null;
    }
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

function matchWildcard(str: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(str);
}
