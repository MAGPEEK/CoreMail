/**
 * Sender lists (BCP → Protection → Sender lists; table `blacklist`).
 *
 * Each entry is a BLOCK or an ALLOW entry for one scope: GLOBAL, DOMAIN (recipient domain)
 * or USER (recipient mailbox). The envelope sender is matched per recipient:
 *  - the most specific scope with a matching entry decides (USER > DOMAIN > GLOBAL), and
 *    within that scope ALLOW wins over BLOCK — a user can allow a sender the organisation
 *    blocks, and an organisation-wide allow entry overrides a global block entry;
 *  - RCPT TO stage: a BLOCK verdict refuses that recipient (550 5.7.1);
 *  - content stage: refused when every recipient blocks the sender (the RCPT check failed
 *    open), and the spam verdict is skipped when every recipient allows the sender AND the
 *    sender domain is authenticated (pipeline/index.ts) — an allow entry never bypasses
 *    SPF/DKIM/DMARC, the virus scan or the attachment filter.
 * USER-JUNK entries (webmail "Junk" action) are handled by smtp-server at delivery.
 */
import { createLogger } from '@coremail/core';
import { prisma, tryMatchRulePattern } from '@coremail/storage';

const log = createLogger('security-filter:blacklist');

export interface BlacklistCheckResult {
  blocked: boolean;
  /** Every recipient allows the sender (content stage: spam verdict skipped when authenticated). */
  allowed?: boolean;
  reason?: string;
  matchedPattern?: string;
}

export type SenderListScope = 'GLOBAL' | 'DOMAIN' | 'USER';
export const SENDER_LIST_SCOPES: readonly SenderListScope[] = ['GLOBAL', 'DOMAIN', 'USER'];
export type SenderListType = 'BLOCK' | 'ALLOW';

export interface SenderListEntry extends BlacklistEntryLike {
  scope: string;
  scopeId: string | null;
  listType: string;
}

/** Domain / mailbox owner of one recipient address (empty = not a local recipient). */
export interface RecipientScope {
  domainId?: string;
  userId?: string;
}

export interface SenderListVerdict {
  verdict: 'block' | 'allow' | 'none';
  entry?: SenderListEntry;
  reason?: string;
}

/** Pure: does the entry apply to this recipient? */
export function appliesTo(entry: Pick<SenderListEntry, 'scope' | 'scopeId'>, scope: RecipientScope): boolean {
  if (entry.scope === 'GLOBAL') return true;
  if (entry.scope === 'DOMAIN') return !!scope.domainId && entry.scopeId === scope.domainId;
  if (entry.scope === 'USER') return !!scope.userId && entry.scopeId === scope.userId;
  return false;
}

const SPECIFICITY: readonly SenderListScope[] = ['USER', 'DOMAIN', 'GLOBAL'];

/**
 * Pure: sender-list verdict for one recipient. Invalid REGEX entries are skipped
 * (`onInvalid` is told). A null sender (`<>`, bounces) never matches.
 */
export function senderListVerdict(
  entries: readonly SenderListEntry[],
  fromAddr: string,
  scope: RecipientScope,
  onInvalid: (entry: SenderListEntry) => void = () => undefined,
): SenderListVerdict {
  if (!fromAddr) return { verdict: 'none' };
  for (const level of SPECIFICITY) {
    let block: SenderListVerdict | null = null;
    for (const entry of entries) {
      if (entry.scope !== level || !appliesTo(entry, scope)) continue;
      const m = matchBlacklistEntry(entry, fromAddr);
      if (m === null) { onInvalid(entry); continue; }
      if (!m.matched) continue;
      if (entry.listType === 'ALLOW') return { verdict: 'allow', entry };
      block ??= { verdict: 'block', entry, reason: m.reason };
    }
    if (block) return block;
  }
  return { verdict: 'none' };
}

/**
 * Pure: one result for a message with several recipients — blocked only when every
 * recipient blocks the sender, allowed only when every recipient allows it.
 */
export function combineVerdicts(verdicts: readonly SenderListVerdict[]): BlacklistCheckResult {
  if (verdicts.length === 0) return { blocked: false };
  if (verdicts.every((v) => v.verdict === 'block')) {
    const first = verdicts[0]!;
    return { blocked: true, reason: first.reason ?? 'Sender blocked', ...(first.entry ? { matchedPattern: first.entry.pattern } : {}) };
  }
  if (verdicts.every((v) => v.verdict === 'allow')) return { blocked: false, allowed: true };
  return { blocked: false };
}

const domainOf = (addr: string): string => addr.slice(addr.lastIndexOf('@') + 1);

/** Domain / mailbox owner of each recipient (users, aliases, shared mailboxes, local domains). */
export async function resolveRecipientScopes(rcpts: readonly string[]): Promise<RecipientScope[]> {
  const addrs = rcpts.map((r) => r.trim().toLowerCase());
  const unique = [...new Set(addrs.filter((a) => a.includes('@')))];
  if (unique.length === 0) return addrs.map(() => ({}));
  const [users, aliases, shared, domains] = await Promise.all([
    prisma.user.findMany({ where: { email: { in: unique } }, select: { id: true, email: true, domainId: true } }),
    prisma.emailAlias.findMany({ where: { address: { in: unique }, active: true }, select: { address: true, domainId: true, targetUserId: true } }),
    prisma.sharedMailbox.findMany({ where: { email: { in: unique } }, select: { email: true, domainId: true } }),
    prisma.domain.findMany({ where: { name: { in: [...new Set(unique.map(domainOf))] } }, select: { id: true, name: true } }),
  ]);
  return addrs.map((addr): RecipientScope => {
    const user = users.find((u) => u.email.toLowerCase() === addr);
    if (user) return { userId: user.id, domainId: user.domainId };
    const alias = aliases.find((a) => a.address.toLowerCase() === addr);
    if (alias) return { domainId: alias.domainId, ...(alias.targetUserId ? { userId: alias.targetUserId } : {}) };
    const box = shared.find((s) => s.email.toLowerCase() === addr);
    if (box) return { domainId: box.domainId };
    const domain = domains.find((d) => d.name.toLowerCase() === domainOf(addr));
    return domain ? { domainId: domain.id } : {};
  });
}

/** Active GLOBAL entries plus the DOMAIN / USER entries of the given recipients. */
async function loadSenderListEntries(scopes: readonly RecipientScope[]): Promise<SenderListEntry[]> {
  const domainIds = [...new Set(scopes.map((s) => s.domainId).filter((v): v is string => !!v))];
  const userIds = [...new Set(scopes.map((s) => s.userId).filter((v): v is string => !!v))];
  return prisma.blacklist.findMany({
    where: {
      active: true,
      OR: [
        { scope: 'GLOBAL' },
        ...(domainIds.length ? [{ scope: 'DOMAIN', scopeId: { in: domainIds } }] : []),
        ...(userIds.length ? [{ scope: 'USER', scopeId: { in: userIds } }] : []),
      ],
    },
    select: { pattern: true, patternType: true, scope: true, scopeId: true, listType: true },
  });
}

/** Sender-list result of a message (or of one RCPT TO when `rcpts` has one element). */
export async function checkBlacklist(fromAddr: string, rcpts: readonly string[]): Promise<BlacklistCheckResult> {
  if (!fromAddr) return { blocked: false };
  const scopes = await resolveRecipientScopes(rcpts.length ? rcpts : ['']);
  const entries = await loadSenderListEntries(scopes);
  if (entries.length === 0) return { blocked: false };
  const warn = (e: SenderListEntry) => log.warn({ pattern: e.pattern }, 'Invalid sender-list regex — skipping');
  const verdicts = scopes.map((scope) => senderListVerdict(entries, fromAddr, scope, warn));
  const result = combineVerdicts(verdicts);
  if (result.blocked) log.info({ fromAddr, pattern: result.matchedPattern }, 'Sender-list block');
  return result;
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
