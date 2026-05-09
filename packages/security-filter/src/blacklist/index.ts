import { prisma, createLogger } from '@coremail/core';

const log = createLogger('security-filter:blacklist');

export interface BlacklistCheckResult {
  blocked: boolean;
  reason?: string;
  matchedPattern?: string;
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

  const lowerFrom = fromAddr.toLowerCase();
  const [, fromDomain] = lowerFrom.split('@');

  for (const entry of entries) {
    const pattern = entry.pattern.toLowerCase();

    if (entry.patternType === 'EXACT') {
      if (lowerFrom === pattern) {
        log.info({ fromAddr, pattern }, 'Blacklist: exact match');
        return { blocked: true, reason: 'Sender blocked', matchedPattern: pattern };
      }
    } else if (entry.patternType === 'WILDCARD') {
      // Support *@domain.com and user@* patterns
      if (pattern.startsWith('*@')) {
        const blockedDomain = pattern.slice(2);
        if (fromDomain === blockedDomain) {
          log.info({ fromAddr, pattern }, 'Blacklist: domain wildcard match');
          return { blocked: true, reason: 'Sender domain blocked', matchedPattern: pattern };
        }
      } else if (matchWildcard(lowerFrom, pattern)) {
        log.info({ fromAddr, pattern }, 'Blacklist: wildcard match');
        return { blocked: true, reason: 'Sender blocked', matchedPattern: pattern };
      }
    } else if (entry.patternType === 'REGEX') {
      try {
        if (new RegExp(pattern).test(lowerFrom)) {
          log.info({ fromAddr, pattern }, 'Blacklist: regex match');
          return { blocked: true, reason: 'Sender blocked by policy', matchedPattern: pattern };
        }
      } catch {
        log.warn({ pattern }, 'Invalid blacklist regex — skipping');
      }
    }
  }

  return { blocked: false };
}

function matchWildcard(str: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(str);
}
