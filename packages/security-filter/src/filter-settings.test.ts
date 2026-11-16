import { test } from 'node:test';
import assert from 'node:assert/strict';

// @coremail/core validates the environment on import.
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';
// no Prisma engine in unit tests — the stub is picked up by @coremail/storage/prisma
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { buildPipelineConfig, DEFAULT_PIPELINE_CONFIG } = await import('./settings.js');
const { runIpChecks, runContentChecks, runGreylistCheck, decideClamav } = await import('./pipeline/index.js');
const { checkAttachments, fileExtension } = await import('./attachment/index.js');
const { matchBlacklistEntry, matchWildcard } = await import('./blacklist/index.js');
const { parseClamdResponse } = await import('./clamav/index.js');
const { isGreylistExempt } = await import('./greylisting/index.js');

type Deps = Parameters<typeof runContentChecks>[3];

const SEC = {
  dnsblEnabled: true, geoipMode: 'DISABLED', geoipCountries: [] as unknown,
  attachmentEnabled: true, attachmentMaxSizeMb: 50, attachmentBlockedExt: ['exe', 'js'] as unknown,
  rspamdEnabled: true, rspamdSpamScore: 6, rspamdRejectScore: 15,
  clamavEnabled: true, clamavAction: 'quarantine', clamavBlockOnFailure: false,
};

// ── settings → config ─────────────────────────────────────────────────────────

test('buildPipelineConfig: defaults equal the schema defaults', () => {
  const cfg = buildPipelineConfig(null, null);
  assert.equal(cfg.spamScoreJunk, 6.0);
  assert.equal(cfg.spamScoreReject, 15.0);
  assert.equal(cfg.dnsblEnabled, true);
  assert.equal(cfg.greylistingEnabled, true);
  assert.equal(cfg.clamavAction, 'quarantine');
  assert.equal(cfg.clamavBlockOnFailure, false);
  assert.equal(cfg.maxAttachmentBytes, 50 * 1024 * 1024);
  assert.deepEqual([...cfg.blockedExtensions!], [...DEFAULT_PIPELINE_CONFIG.blockedExtensions]);
  assert.equal(cfg.countryFilter, null);
});

test('buildPipelineConfig maps every BCP field', () => {
  const table: Array<[Partial<typeof SEC>, (c: ReturnType<typeof buildPipelineConfig>) => void]> = [
    [{ geoipMode: 'BLACKLIST', geoipCountries: ['ru', 'CN', 'bad', 7] }, (c) => assert.deepEqual(c.countryFilter, { mode: 'blacklist', countries: ['RU', 'CN'] })],
    [{ geoipMode: 'WHITELIST', geoipCountries: ['de'] }, (c) => assert.deepEqual(c.countryFilter, { mode: 'whitelist', countries: ['DE'] })],
    [{ geoipMode: 'DISABLED', geoipCountries: ['de'] }, (c) => assert.equal(c.countryFilter, null)],
    [{ geoipMode: 'WHITELIST', geoipCountries: [] }, (c) => assert.equal(c.countryFilter, null)],
    [{ dnsblEnabled: false }, (c) => assert.equal(c.dnsblEnabled, false)],
    [{ attachmentEnabled: false }, (c) => assert.equal(c.attachmentEnabled, false)],
    [{ attachmentMaxSizeMb: 2 }, (c) => assert.equal(c.maxAttachmentBytes, 2 * 1024 * 1024)],
    [{ attachmentBlockedExt: ['docm', 1] }, (c) => assert.deepEqual(c.blockedExtensions, ['docm'])],
    [{ clamavAction: 'reject' }, (c) => assert.equal(c.clamavAction, 'reject')],
    [{ clamavAction: 'nonsense' }, (c) => assert.equal(c.clamavAction, 'quarantine')],
    [{ clamavBlockOnFailure: true }, (c) => assert.equal(c.clamavBlockOnFailure, true)],
    [{ rspamdSpamScore: 4, rspamdRejectScore: 9 }, (c) => { assert.equal(c.spamScoreJunk, 4); assert.equal(c.spamScoreReject, 9); }],
  ];
  for (const [patch, check] of table) check(buildPipelineConfig({ ...SEC, ...patch }, null));
  assert.equal(buildPipelineConfig(SEC, { greylistingEnabled: false }).greylistingEnabled, false);
});

// ── settings → behaviour (stages with injected deps) ─────────────────────────

function fakeDeps(over: Partial<NonNullable<Deps>> = {}): NonNullable<Deps> & { calls: string[] } {
  const calls: string[] = [];
  const d = {
    calls,
    dnsbl: async () => { calls.push('dnsbl'); return { listed: true, whitelisted: false, hits: [{ zone: { id: 'z', host: 'zen.example', name: 'z', action: 'REJECT' as const, weight: 1, isWhitelist: false }, response: '127.0.0.2' }], totalScore: 1, action: 'REJECT' as const }; },
    country: async () => { calls.push('country'); return { allowed: false, countryCode: 'RU', reason: 'Country RU is blocked' }; },
    greylist: async () => { calls.push('greylist'); return { action: 'defer' as const, reason: 'Greylisted' }; },
    authenticate: async () => ({ spf: 'pass', dkim: 'pass', dmarc: 'pass', summary: 'ok' }),
    blacklist: async () => ({ blocked: false }),
    parse: async () => ({ attachments: [{ filename: 'invoice.EXE', mimeType: 'application/octet-stream', size: 10 }] }),
    clamav: async () => { calls.push('clamav'); return { status: 'infected' as const, clean: false, virusName: 'Eicar' }; },
    rspamd: async () => { calls.push('rspamd'); return { score: 7 }; },
    isLocalDomain: async (d: string) => d === 'local.example',
    ...over,
  };
  return d as never;
}

test('IP stage: dnsblEnabled=false skips DNSBL, no country filter skips GeoIP', async () => {
  const deps = fakeDeps();
  const r = await runIpChecks('203.0.113.9', buildPipelineConfig({ ...SEC, dnsblEnabled: false }, null), deps);
  assert.equal(r.action, 'accept');
  assert.deepEqual(deps.calls, []);
});

test('IP stage: DNSBL REJECT hit rejects; GeoIP blacklist rejects', async () => {
  assert.equal((await runIpChecks('203.0.113.9', buildPipelineConfig(SEC, null), fakeDeps())).action, 'reject');
  const deps = fakeDeps({ dnsbl: async () => ({ listed: false, whitelisted: false, hits: [], totalScore: 0, action: null }) });
  const r = await runIpChecks('203.0.113.9', buildPipelineConfig({ ...SEC, geoipMode: 'BLACKLIST', geoipCountries: ['RU'] }, null), deps);
  assert.equal(r.action, 'reject');
  assert.match(r.reason, /RU/);
});

test('greylisting switch comes from SmtpSettings', async () => {
  const ctx = { senderIp: '203.0.113.9', mailFrom: 'a@b.example', rcptTo: 'u@local.example' };
  assert.equal((await runGreylistCheck(ctx, buildPipelineConfig(SEC, { greylistingEnabled: true }), fakeDeps())).action, 'defer');
  assert.equal((await runGreylistCheck(ctx, buildPipelineConfig(SEC, { greylistingEnabled: false }), fakeDeps())).action, 'accept');
});

test('content stage behaviour table', async () => {
  const ctx = { senderIp: '203.0.113.9', mailFrom: 'a@b.example', rcptTo: 'u@local.example' };
  const raw = Buffer.from('Subject: x\r\n\r\nbody');
  const cases: Array<[string, Partial<typeof SEC>, Partial<NonNullable<Deps>>, string, boolean?]> = [
    ['blocked extension rejects', {}, {}, 'reject'],
    ['attachment filter off → clamav quarantine', { attachmentEnabled: false }, {}, 'quarantine'],
    ['extension not in configured list → clamav', { attachmentBlockedExt: ['docm'] }, {}, 'quarantine'],
    ['clamavAction=reject', { attachmentEnabled: false, clamavAction: 'reject' }, {}, 'reject'],
    ['clamavAction=pass → rspamd junk (score 7 ≥ 6)', { attachmentEnabled: false, clamavAction: 'pass' }, {}, 'accept', true],
    ['clamav error + blockOnFailure → defer', { attachmentEnabled: false, clamavBlockOnFailure: true }, { clamav: async () => ({ status: 'error', clean: false, error: 'down' }) }, 'defer'],
    ['clamav error, no block → continue', { attachmentEnabled: false }, { clamav: async () => ({ status: 'error', clean: false, error: 'down' }) }, 'accept', true],
    ['clamav disabled', { attachmentEnabled: false, clamavEnabled: false }, {}, 'accept', true],
    ['reject threshold from settings', { attachmentEnabled: false, clamavEnabled: false, rspamdRejectScore: 7 }, {}, 'reject'],
    ['rspamd disabled', { attachmentEnabled: false, clamavEnabled: false, rspamdEnabled: false }, {}, 'accept', false],
    ['size limit from settings', { attachmentMaxSizeMb: 1, attachmentBlockedExt: [] }, { parse: async () => ({ attachments: [{ filename: 'big.pdf', mimeType: 'application/pdf', size: 2 * 1024 * 1024 }] }) as never }, 'reject'],
  ];
  for (const [name, patch, over, action, junk] of cases) {
    const r = await runContentChecks(raw, ctx, buildPipelineConfig({ ...SEC, ...patch }, null), fakeDeps(over));
    assert.equal(r.action, action, name);
    if (junk !== undefined) assert.equal(r.junkFolder ?? false, junk, name);
  }
});

// ── attachment filter ─────────────────────────────────────────────────────────

test('attachment filter: configured extensions, trailing dots, double extensions, size', () => {
  const a = (filename: string, size = 10, mimeType = 'application/octet-stream') => ({ filename, size, mimeType }) as never;
  assert.equal(checkAttachments([a('Setup.MSI')], { blockedExtensions: ['msi'] }).blocked, true);
  assert.equal(checkAttachments([a('run.exe. ')], { blockedExtensions: ['.EXE'] }).blocked, true);
  assert.equal(checkAttachments([a('report.pdf')], { blockedExtensions: ['exe'] }).blocked, false);
  assert.equal(checkAttachments([a('invoice.pdf.exe')], { blockedExtensions: [] }).blocked, true);
  assert.equal(checkAttachments([a('x.bin', 11)], { maxSizeBytes: 10, blockedExtensions: [] }).blocked, true);
  assert.equal(checkAttachments([a('x.exe')], { enabled: false }).blocked, false);
  assert.equal(fileExtension('archive.tar.GZ'), 'gz');
  assert.equal(fileExtension('noext'), '');
});

// ── blacklist ─────────────────────────────────────────────────────────────────

test('blacklist REGEX is not lower-cased (\\D stays \\D) and is case-insensitive', () => {
  // "^\D+@" = local part without digits. Lower-casing turned it into "^\d+@".
  const e = { pattern: '^\\D+@spam\\.example$', patternType: 'REGEX' };
  assert.equal(matchBlacklistEntry(e, 'Promo@SPAM.example')?.matched, true);
  assert.equal(matchBlacklistEntry(e, '12345@spam.example')?.matched, false);
  assert.equal(matchBlacklistEntry({ pattern: '([', patternType: 'REGEX' }, 'a@b.c'), null);
  assert.equal(matchBlacklistEntry({ pattern: '*@Spam.Example', patternType: 'WILDCARD' }, 'x@spam.example')?.matched, true);
  assert.equal(matchBlacklistEntry({ pattern: 'news?@*', patternType: 'WILDCARD' }, 'news?@x.example')?.matched, true);
  assert.equal(matchBlacklistEntry({ pattern: 'news?@*', patternType: 'WILDCARD' }, 'new@x.example')?.matched, false);
  assert.equal(matchBlacklistEntry({ pattern: 'A@B.C', patternType: 'EXACT' }, 'a@b.c')?.matched, true);
});

test('v8.1: blacklist REGEX/WILDCARD run in linear time on hostile sender addresses (no ReDoS)', () => {
  const hostile = `${'a'.repeat(5000)}!@x.example`;
  const t0 = Date.now();
  // catastrophic for a backtracking engine
  assert.equal(matchBlacklistEntry({ pattern: '^(a+)+$', patternType: 'REGEX' }, hostile)?.matched, false);
  assert.equal(matchBlacklistEntry({ pattern: '*a*a*a*a*a*a*a*a*b', patternType: 'WILDCARD' }, hostile)?.matched, false);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  // backreferences / lookarounds are unsupported → skipped (null), never a throw
  assert.equal(matchBlacklistEntry({ pattern: '(a)\\1', patternType: 'REGEX' }, 'aa@x'), null);
  assert.equal(matchBlacklistEntry({ pattern: '(?=a)a', patternType: 'REGEX' }, 'a@x'), null);
  // wildcard semantics unchanged
  assert.equal(matchWildcard('bulk-42@news.example', 'bulk-*@*.example'), true);
  assert.equal(matchWildcard('bulk@news.example', 'bulk-*@*.example'), false);
  assert.equal(matchWildcard('', '*'), true);
  assert.equal(matchWildcard('abc', 'a*c*'), true);
  assert.equal(matchWildcard('abcd', 'a*c'), false);
});

// ── ClamAV ────────────────────────────────────────────────────────────────────

test('clamd reply parsing: FOUND before OK, errors are errors', () => {
  assert.deepEqual(parseClamdResponse('stream: OK\0'), { status: 'clean', clean: true });
  assert.deepEqual(parseClamdResponse('stream: Eicar-Test-Signature FOUND\0'), { status: 'infected', clean: false, virusName: 'Eicar-Test-Signature' });
  // signature name containing "OK" must not be read as clean
  assert.equal(parseClamdResponse('stream: Win.Trojan.OKrat-1 FOUND').status, 'infected');
  assert.equal(parseClamdResponse('stream: Win.Trojan.OKrat-1 FOUND').virusName, 'Win.Trojan.OKrat-1');
  // 9.2: clamd's StreamMaxLength answer is "too large" (clamavOversizeAction), not a scanner failure
  assert.equal(parseClamdResponse('INSTREAM size limit exceeded. ERROR').status, 'oversize');
  assert.equal(parseClamdResponse('').status, 'error');
  assert.equal(parseClamdResponse('stream: OK but weird').status, 'error');
});

test('decideClamav applies clamavAction and clamavBlockOnFailure', () => {
  const inf = { status: 'infected' as const, clean: false, virusName: 'X' };
  const err = { status: 'error' as const, clean: false, error: 'down' };
  const ok = { status: 'clean' as const, clean: true };
  assert.equal(decideClamav(inf, {})?.action, 'quarantine');
  assert.equal(decideClamav(inf, { clamavAction: 'reject' })?.action, 'reject');
  assert.equal(decideClamav(inf, { clamavAction: 'pass' }), null);
  assert.equal(decideClamav(err, {}), null);
  assert.equal(decideClamav(err, { clamavBlockOnFailure: true })?.action, 'defer');
  assert.equal(decideClamav(ok, { clamavBlockOnFailure: true }), null);
});

// ── greylisting whitelist (CIDR) ──────────────────────────────────────────────

test('greylist whitelist: real CIDR matching (IPv4/IPv6), IP, sender, domain', () => {
  const wl = ['192.0.2.0/25', '2001:db8:1::/48', '198.51.100.7', 'Partner@Example.org', 'trusted.example'];
  assert.equal(isGreylistExempt(wl, '192.0.2.100', ''), true);
  assert.equal(isGreylistExempt(wl, '192.0.2.200', ''), false); // outside /25 (old /24 approximation said yes)
  assert.equal(isGreylistExempt(['10.0.0.0/8'], '10.200.3.4', ''), true); // old code only compared 3 octets
  assert.equal(isGreylistExempt(wl, '2001:db8:1:ffff::5', ''), true);
  assert.equal(isGreylistExempt(wl, '2001:db8:2::5', ''), false);
  assert.equal(isGreylistExempt(wl, '::ffff:198.51.100.7', ''), true);
  assert.equal(isGreylistExempt(wl, '203.0.113.1', 'partner@example.org'), true);
  assert.equal(isGreylistExempt(wl, '203.0.113.1', 'x@TRUSTED.example'), true);
  assert.equal(isGreylistExempt(wl, '203.0.113.1', 'x@untrusted.example'), false);
  assert.equal(isGreylistExempt(['192.0.2.0/99', 'garbage/x'], '192.0.2.1', ''), false);
});

test('RSPAMD_ENABLED=false / CLAMAV_ENABLED=false override the BCP settings (minimal compose)', () => {
  const on = buildPipelineConfig({ ...SEC, rspamdEnabled: true, clamavEnabled: true }, null, {});
  assert.equal(on.rspamdEnabled, true);
  assert.equal(on.clamavEnabled, true);
  const off = buildPipelineConfig({ ...SEC, rspamdEnabled: true, clamavEnabled: true }, null, { RSPAMD_ENABLED: 'false', CLAMAV_ENABLED: '0' });
  assert.equal(off.rspamdEnabled, false);
  assert.equal(off.clamavEnabled, false);
  // without a settings row as well
  const none = buildPipelineConfig(null, null, { RSPAMD_ENABLED: 'off' });
  assert.equal(none.rspamdEnabled, false);
  assert.equal(none.clamavEnabled, DEFAULT_PIPELINE_CONFIG.clamavEnabled);
  // "true" never forces a scanner on against the BCP
  const keep = buildPipelineConfig({ ...SEC, rspamdEnabled: false }, null, { RSPAMD_ENABLED: 'true' });
  assert.equal(keep.rspamdEnabled, false);
});
