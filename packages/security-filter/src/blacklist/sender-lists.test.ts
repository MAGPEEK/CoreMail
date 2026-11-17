/**
 * 9.4 (BCP review): sender lists with BLOCK/ALLOW entries per scope (global, domain, user)
 * — enforced per recipient at RCPT TO, allow entries skip the spam verdict only for an
 * authenticated sender; DNSBL SCORE_ONLY weights reach the spam score; the local-spoof
 * settings come from the BCP with the environment as override.
 * Run: node --import tsx --test src/blacklist/sender-lists.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  user: [{ id: 'u1', email: 'bob@corp.test', domainId: 'd1' }, { id: 'u2', email: 'eve@corp.test', domainId: 'd1' }],
  emailAlias: [{ address: 'sales@corp.test', domainId: 'd1', targetUserId: 'u1', active: true }],
  sharedMailbox: [{ email: 'team@other.test', domainId: 'd2' }],
  domain: [{ id: 'd1', name: 'corp.test' }, { id: 'd2', name: 'other.test' }],
  blacklist: [],
};
const inList = (row: Row, where: Row): boolean => Object.entries(where).every(([k, cond]) => {
  if (k === 'OR') return (cond as Row[]).some((w) => inList(row, w));
  if (cond && typeof cond === 'object' && 'in' in (cond as Row)) return ((cond as { in: unknown[] }).in).includes(row[k]);
  return row[k] === cond;
});
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  ...Object.fromEntries(Object.keys(tables).map((t) => [t, {
    findMany: async ({ where }: { where: Row }) => tables[t]!.filter((r) => inList(r, where)),
  }])),
};

const lists = await import('./index.js');
const { runSenderListCheck, runContentChecks, spamVerdict } = await import('../pipeline/index.js');
const { scoreOnlyContribution } = await import('../dnsbl/index.js');
const { buildPipelineConfig } = await import('../settings.js');

const entry = (over: Row) => ({ pattern: '*@spam.example', patternType: 'WILDCARD', scope: 'GLOBAL', scopeId: null, listType: 'BLOCK', active: true, ...over });

// ── pure verdicts ────────────────────────────────────────────────────────────

test('most specific scope decides; ALLOW wins within a scope; null sender never matches', () => {
  const e = [
    entry({}),                                                                  // global block of the domain
    entry({ pattern: 'boss@spam.example', patternType: 'EXACT', scope: 'USER', scopeId: 'u1', listType: 'ALLOW' }),
    entry({ pattern: '*@news.example', scope: 'DOMAIN', scopeId: 'd1' }),
    entry({ pattern: '*@news.example', scope: 'DOMAIN', scopeId: 'd1', listType: 'ALLOW' }),
    entry({ pattern: 'friend@good.example', patternType: 'EXACT', listType: 'ALLOW' }),
    entry({ pattern: 'friend@good.example', patternType: 'EXACT', scope: 'USER', scopeId: 'u2' }),
  ] as never[];
  const bob = { userId: 'u1', domainId: 'd1' };
  const eve = { userId: 'u2', domainId: 'd1' };
  assert.equal(lists.senderListVerdict(e, 'x@spam.example', bob).verdict, 'block');
  assert.equal(lists.senderListVerdict(e, 'boss@spam.example', bob).verdict, 'allow', 'user allow overrides the global block');
  assert.equal(lists.senderListVerdict(e, 'boss@spam.example', eve).verdict, 'block', 'other users keep the block');
  assert.equal(lists.senderListVerdict(e, 'a@news.example', bob).verdict, 'allow', 'same scope: allow wins');
  assert.equal(lists.senderListVerdict(e, 'friend@good.example', bob).verdict, 'allow');
  assert.equal(lists.senderListVerdict(e, 'friend@good.example', eve).verdict, 'block', 'a user block beats a global allow');
  assert.equal(lists.senderListVerdict(e, '', bob).verdict, 'none', 'bounces (<>) are never listed');
  assert.equal(lists.senderListVerdict(e, 'x@spam.example', {}).verdict, 'block', 'global entries apply to every recipient');
});

test('invalid REGEX entries are skipped and reported', () => {
  const bad: string[] = [];
  const v = lists.senderListVerdict([entry({ pattern: '(a)\\1', patternType: 'REGEX' })] as never[], 'aa@x.example', {}, (x) => bad.push(x.pattern));
  assert.equal(v.verdict, 'none');
  assert.deepEqual(bad, ['(a)\\1']);
});

test('combineVerdicts: blocked only when every recipient blocks, allowed only when every recipient allows', () => {
  const b = { verdict: 'block' as const, reason: 'Sender blocked', entry: entry({}) as never };
  const a = { verdict: 'allow' as const };
  const n = { verdict: 'none' as const };
  assert.deepEqual(lists.combineVerdicts([b, b]), { blocked: true, reason: 'Sender blocked', matchedPattern: '*@spam.example' });
  assert.deepEqual(lists.combineVerdicts([b, n]), { blocked: false });
  assert.deepEqual(lists.combineVerdicts([a, a]), { blocked: false, allowed: true });
  assert.deepEqual(lists.combineVerdicts([a, n]), { blocked: false });
  assert.deepEqual(lists.combineVerdicts([]), { blocked: false });
});

// ── recipient scopes + RCPT TO stage (fake database) ─────────────────────────

test('recipient scopes: user, alias (target user), shared mailbox, local domain, foreign', async () => {
  const s = await lists.resolveRecipientScopes(['Bob@corp.test', 'sales@corp.test', 'team@other.test', 'nobody@corp.test', 'x@ext.example']);
  assert.deepEqual(s, [
    { userId: 'u1', domainId: 'd1' }, { domainId: 'd1', userId: 'u1' }, { domainId: 'd2' }, { domainId: 'd1' }, {},
  ]);
});

test('RCPT TO: a user-scoped block refuses only that recipient; inactive entries are ignored', async () => {
  tables['blacklist'] = [
    entry({ pattern: 'pest@ext.example', patternType: 'EXACT', scope: 'USER', scopeId: 'u1' }),
    entry({ pattern: 'old@ext.example', patternType: 'EXACT', active: false }),
  ];
  const ctx = (rcptTo: string, mailFrom = 'pest@ext.example') => ({ senderIp: '198.51.100.7', mailFrom, rcptTo });
  assert.equal((await runSenderListCheck(ctx('bob@corp.test'))).action, 'reject');
  assert.equal((await runSenderListCheck(ctx('sales@corp.test'))).action, 'reject', 'alias of the user');
  assert.equal((await runSenderListCheck(ctx('eve@corp.test'))).action, 'accept');
  assert.equal((await runSenderListCheck(ctx('bob@corp.test', 'old@ext.example'))).action, 'accept');
  // content stage (all recipients): blocked only if every recipient blocks
  assert.equal((await lists.checkBlacklist('pest@ext.example', ['bob@corp.test', 'eve@corp.test'])).blocked, false);
  assert.equal((await lists.checkBlacklist('pest@ext.example', ['bob@corp.test', 'sales@corp.test'])).blocked, true);
});

// ── content stage: allow list + DNSBL score ──────────────────────────────────

const authOk = (verified: string[]) => ({
  spf: 'pass', dkim: 'pass', dmarc: 'pass', arc: 'none', dmarcPolicy: null, headerFromDomain: 'news.example',
  spfDomain: 'news.example', dkimDomains: [], verifiedDomains: verified, summary: 'ok', fromHeaderFields: 1, fromMailboxes: 1,
});
function contentDeps(over: Row = {}) {
  return {
    authenticate: async () => authOk(['news.example']),
    blacklist: async () => ({ blocked: false }),
    parse: async () => ({ attachments: [] }),
    clamav: async () => ({ status: 'clean' as const, clean: true }),
    rspamd: async () => ({ score: 8, action: 'add header' as const, symbols: {}, isSpam: true }),
    isLocalDomain: async () => false,
    ...over,
  } as never;
}
const raw = Buffer.from('From: a@news.example\r\nSubject: x\r\n\r\nbody');
const cctx = { senderIp: '198.51.100.7', mailFrom: 'a@news.example', rcptTo: 'bob@corp.test', rcpts: ['bob@corp.test'] };

test('allow-listed AND authenticated sender: spam verdict skipped (score kept); forged sender: still junk', async () => {
  const allowed = async () => ({ blocked: false, allowed: true });
  const ok = await runContentChecks(raw, cctx, {}, contentDeps({ blacklist: allowed }));
  assert.equal(ok.junkFolder, false);
  assert.equal(ok.spamScore, 8);
  assert.match(ok.reason, /allow-listed/);

  const forged = await runContentChecks(raw, cctx, {}, contentDeps({ blacklist: allowed, authenticate: async () => authOk([]) }));
  assert.equal(forged.junkFolder, true, 'unauthenticated envelope domain: allow entry ignored');

  const blocked = await runContentChecks(raw, cctx, {}, contentDeps({ blacklist: async () => ({ blocked: true, reason: 'Sender blocked' }) }));
  assert.equal(blocked.action, 'reject');
});

test('DNSBL SCORE_ONLY: weights reach the spam score; DNSWL / TAG / REJECT zones do not', async () => {
  const zone = (action: string, weight: number, isWhitelist = false) => ({ zone: { id: action, host: `${action.toLowerCase()}.example`, name: action, action, weight, isWhitelist }, response: '127.0.0.2' });
  const result = { listed: true, whitelisted: false, hits: [zone('SCORE_ONLY', 3), zone('SCORE_ONLY', 2), zone('TAG', 4)], totalScore: 9, action: 'TAG' as const };
  assert.deepEqual(scoreOnlyContribution(result as never), { score: 5, zones: ['score_only.example', 'score_only.example'] });
  assert.deepEqual(scoreOnlyContribution({ ...result, whitelisted: true } as never), { score: 0, zones: [] });

  // rspamd 4 + DNSBL 3 = 7 ≥ 6 → Junk
  const deps = (score: number) => contentDeps({
    rspamd: async () => ({ score: 4, action: 'no action' as const, symbols: {}, isSpam: false }),
    dnsblScore: async () => ({ score, zones: ['psbl.example'] }),
  });
  const junk = await runContentChecks(raw, cctx, {}, deps(3));
  assert.equal(junk.junkFolder, true);
  assert.equal(junk.spamScore, 7);
  assert.match(junk.reason, /DNSBL \+3: psbl\.example/);
  assert.equal((await runContentChecks(raw, cctx, { dnsblEnabled: false }, deps(3))).junkFolder, false, 'DNSBL off: no score');
  assert.equal((await runContentChecks(raw, cctx, {}, deps(0))).junkFolder, false);
});

test('spamVerdict thresholds', () => {
  assert.equal(spamVerdict(15, {}), 'reject');
  assert.equal(spamVerdict(6, {}), 'junk');
  assert.equal(spamVerdict(5.9, {}), 'inbox');
  assert.equal(spamVerdict(99, {}, true), 'inbox');
  assert.equal(spamVerdict(3, { spamScoreJunk: 2, spamScoreReject: 4 }), 'junk');
});

// ── local-spoof settings from the BCP ────────────────────────────────────────

test('local-spoof action from SecuritySettings (BCP) applies; the environment variable overrides it', async () => {
  const SEC = {
    dnsblEnabled: true, geoipMode: 'DISABLED', geoipCountries: [], attachmentEnabled: false, attachmentMaxSizeMb: 50,
    attachmentBlockedExt: [], rspamdEnabled: false, rspamdSpamScore: 6, rspamdRejectScore: 15,
    clamavEnabled: false, clamavAction: 'quarantine', clamavBlockOnFailure: false,
    localSpoofAction: 'reject', localSpoofAllow: ['198.51.100.9'], arcTrustedSealers: [],
  };
  const spoof = { ...authOk([]), headerFromDomain: 'corp.test', spf: 'none', dkim: 'none', dmarc: 'none', summary: 's' };
  const deps = contentDeps({ authenticate: async () => spoof, isLocalDomain: async (d: string) => d === 'corp.test' });
  const ctx = { ...cctx, mailFrom: 'ceo@corp.test' };

  const bcp = buildPipelineConfig(SEC, null, {});
  assert.equal((await runContentChecks(raw, ctx, bcp, deps)).action, 'reject', 'BCP: reject');
  assert.equal((await runContentChecks(raw, { ...ctx, senderIp: '198.51.100.9' }, bcp, deps)).action, 'accept', 'BCP allow list');

  const env = buildPipelineConfig(SEC, null, { LOCAL_SPOOF_ACTION: 'junk' });
  const r = await runContentChecks(raw, ctx, env, deps);
  assert.equal(r.action, 'accept');
  assert.equal(r.junkFolder, true, 'LOCAL_SPOOF_ACTION=junk overrides the BCP value');
});
