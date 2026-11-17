/**
 * 9.3: scanner deployment detection (absent / unavailable / available) and the
 * pipeline skip for absent scanners.
 * Run: node --import tsx --test src/capabilities.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const {
  detectScanner, applyScannerCapabilities, CapabilityMonitor, BadResponse, errorCode, checkIntervalMs,
} = await import('./capabilities.js');
const { buildPipelineConfig } = await import('./settings.js');
const { runContentChecks } = await import('./pipeline/index.js');

type Cap = import('./capabilities.js').ScannerCapability;
type Caps = import('./capabilities.js').ScannerCapabilities;
type ClamavResult = import('./clamav/index.js').ClamavResult;

const codeErr = (code: string) => Object.assign(new Error(code), { code });
const deps = (lookup: (h: string) => Promise<unknown>, timeoutMs = 200) => ({ lookup, timeoutMs, now: () => Date.UTC(2026, 10, 17) });
const resolves = async () => [{ address: '10.0.0.5', family: 4 }];
const okProbe = async () => undefined;

test('env switched off → absent without DNS or probe', async () => {
  let looked = 0, probed = 0;
  const cap = await detectScanner(
    { envDisabled: true, host: 'clamav', probe: async () => { probed++; } },
    deps(async () => { looked++; return []; }),
  );
  assert.equal(cap.state, 'absent');
  assert.equal(cap.reason, 'disabled-by-config');
  assert.equal(looked + probed, 0);
  assert.equal(cap.checkedAt, '2026-11-17T00:00:00.000Z');
});

test('host name not in DNS (stopped container / NXDOMAIN / typo) → unavailable host-not-found, never absent', async () => {
  for (const code of ['ENOTFOUND', 'EAI_NONAME', 'ENODATA', 'NXDOMAIN']) {
    let probed = 0;
    const cap = await detectScanner(
      { envDisabled: false, host: 'clamav', probe: async () => { probed++; } },
      deps(async () => { throw codeErr(code); }),
    );
    assert.deepEqual([cap.state, cap.reason, cap.detail], ['unavailable', 'host-not-found', code]);
    assert.equal(probed, 0);
  }
});

test('defaultDetector: only CLAMAV_ENABLED / RSPAMD_ENABLED=false make a scanner absent', async () => {
  const { defaultDetector } = await import('./capabilities.js');
  const off = defaultDetector({ CLAMAV_ENABLED: 'false', RSPAMD_ENABLED: 'off' }, 50);
  assert.deepEqual([(await off('clamav')).state, (await off('clamav')).reason], ['absent', 'disabled-by-config']);
  assert.deepEqual([(await off('rspamd')).state, (await off('rspamd')).reason], ['absent', 'disabled-by-config']);
  // env switches are read once: a later change of the environment does not flip the state
  const env: NodeJS.ProcessEnv = { CLAMAV_ENABLED: 'true' };
  const on = defaultDetector(env, 50);
  env['CLAMAV_ENABLED'] = 'false';
  assert.notEqual((await on('clamav')).state, 'absent');
});

test('other DNS failures and DNS timeouts are unavailable, never absent', async () => {
  const again = await detectScanner({ envDisabled: false, host: 'rspamd', probe: okProbe }, deps(async () => { throw codeErr('EAI_AGAIN'); }));
  assert.deepEqual([again.state, again.reason, again.detail], ['unavailable', 'dns-error', 'EAI_AGAIN']);
  const slow = await detectScanner({ envDisabled: false, host: 'rspamd', probe: okProbe }, deps(() => new Promise(() => undefined), 30));
  assert.deepEqual([slow.state, slow.reason], ['unavailable', 'timeout']);
});

test('host resolves, connection refused → unavailable (real socket)', async () => {
  // a port that was just free: listen, note the port, close
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  const probe = () => new Promise<void>((resolve, reject) => {
    const s = net.createConnection(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(); });
    s.on('error', reject);
  });
  const cap = await detectScanner({ envDisabled: false, host: 'clamav', probe }, deps(resolves, 2000));
  assert.deepEqual([cap.state, cap.reason, cap.detail], ['unavailable', 'connect-failed', 'ECONNREFUSED']);
});

test('probe timeout / bad reply → unavailable; ping answered → available', async () => {
  const hang = await detectScanner({ envDisabled: false, host: 'clamav', probe: () => new Promise(() => undefined) }, deps(resolves, 30));
  assert.deepEqual([hang.state, hang.reason], ['unavailable', 'timeout']);
  const bad = await detectScanner({ envDisabled: false, host: 'rspamd', probe: async () => { throw new BadResponse('HTTP_503'); } }, deps(resolves));
  assert.deepEqual([bad.state, bad.reason, bad.detail], ['unavailable', 'bad-response', 'HTTP_503']);
  const ok = await detectScanner({ envDisabled: false, host: 'clamav', probe: okProbe }, deps(resolves));
  assert.deepEqual([ok.state, ok.reason, ok.detail], ['available', 'ok', undefined]);
});

test('IP literals skip the DNS lookup', async () => {
  let looked = 0;
  const lookup = async () => { looked++; throw codeErr('ENOTFOUND'); };
  assert.equal((await detectScanner({ envDisabled: false, host: '10.1.2.3', probe: okProbe }, deps(lookup))).state, 'available');
  assert.equal((await detectScanner({ envDisabled: false, host: '[fd00::5]', probe: okProbe }, deps(lookup))).state, 'available');
  assert.equal(looked, 0);
});

test('errorCode: codes only — fetch causes unwrapped, free-text messages (hosts, URLs) dropped', () => {
  assert.equal(errorCode(codeErr('ECONNREFUSED')), 'ECONNREFUSED');
  assert.equal(errorCode(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })), 'ENOTFOUND');
  assert.equal(errorCode(new Error('connect ECONNREFUSED 10.0.0.5:3310')), undefined);
  assert.equal(errorCode(codeErr('http://user:pw@host/')), undefined);
});

test('checkIntervalMs: default 300 s, at least 30 s', () => {
  assert.equal(checkIntervalMs({}), 300_000);
  assert.equal(checkIntervalMs({ SCANNER_CHECK_INTERVAL_SEC: '60' }), 60_000);
  assert.equal(checkIntervalMs({ SCANNER_CHECK_INTERVAL_SEC: '5' }), 300_000);
});

const cap = (state: Cap['state'], reason: Cap['reason'] = state === 'available' ? 'ok' : state === 'absent' ? 'disabled-by-config' : 'connect-failed'): Cap =>
  ({ state, reason, checkedAt: '2026-11-17T00:00:00.000Z' });

test('applyScannerCapabilities: only absent scanners are switched off', () => {
  const base = buildPipelineConfig(null, null, {});
  const both = applyScannerCapabilities(base, { rspamd: cap('absent'), clamav: cap('absent') });
  assert.equal(both.rspamdEnabled, false);
  assert.equal(both.clamavEnabled, false);
  const down = applyScannerCapabilities(base, { rspamd: cap('unavailable'), clamav: cap('unavailable') });
  assert.equal(down.rspamdEnabled, true);
  assert.equal(down.clamavEnabled, true);
  // a scanner disabled in the BCP stays disabled when available
  const bcpOff = { ...base, clamavEnabled: false };
  assert.equal(applyScannerCapabilities(bcpOff, { rspamd: cap('available'), clamav: cap('available') }).clamavEnabled, false);
});

// ── pipeline ──────────────────────────────────────────────────────────────────

const SEC = {
  dnsblEnabled: true, geoipMode: 'DISABLED', geoipCountries: [] as unknown,
  attachmentEnabled: false, attachmentMaxSizeMb: 50, attachmentBlockedExt: [] as unknown,
  rspamdEnabled: true, rspamdSpamScore: 6, rspamdRejectScore: 15,
  // the strictest failure policy: an unreachable scanner defers (451)
  clamavEnabled: true, clamavAction: 'quarantine', clamavBlockOnFailure: true,
};
const ctx = { senderIp: '203.0.113.9', mailFrom: 'a@b.example', rcptTo: 'u@local.example' };
const raw = Buffer.from('Subject: x\r\n\r\nbody');

function pipelineDeps(calls: string[]) {
  const down: ClamavResult = { status: 'error', clean: false, error: 'connect ECONNREFUSED' };
  return {
    dnsbl: async () => ({ listed: false, whitelisted: false, hits: [], totalScore: 0, action: null }),
    country: async () => ({ allowed: true }),
    greylist: async () => ({ action: 'accept' as const }),
    authenticate: async () => ({ spf: 'pass', dkim: 'pass', dmarc: 'pass', summary: 'ok' }),
    blacklist: async () => ({ blocked: false }),
    parse: async () => ({ attachments: [] }),
    clamav: async () => { calls.push('clamav'); return down; },
    rspamd: async () => { calls.push('rspamd'); return { score: 0 }; },
    isLocalDomain: async () => false,
  } as never;
}

test('pipeline: absent scanners are skipped — no unscanned note, no 451, scanners not contacted', async () => {
  const caps: Caps = { rspamd: cap('absent'), clamav: cap('absent', 'disabled-by-config') };
  const cfg = applyScannerCapabilities(buildPipelineConfig(SEC, null, {}), caps);
  const calls: string[] = [];
  const r = await runContentChecks(raw, ctx, cfg, pipelineDeps(calls));
  assert.equal(r.action, 'accept');
  assert.equal(r.virusScan, undefined);
  assert.equal(r.junkFolder, false);
  assert.deepEqual(calls, []);
});

test('pipeline: an unavailable scanner keeps the failure policy (451 with clamavBlockOnFailure)', async () => {
  const caps: Caps = { rspamd: cap('unavailable'), clamav: cap('unavailable') };
  const cfg = applyScannerCapabilities(buildPipelineConfig(SEC, null, {}), caps);
  const calls: string[] = [];
  const r = await runContentChecks(raw, ctx, cfg, pipelineDeps(calls));
  assert.equal(r.action, 'defer');
  assert.deepEqual(calls, ['clamav']);
  // without block-on-failure: delivered, tagged unscanned
  const lenient = applyScannerCapabilities(buildPipelineConfig({ ...SEC, clamavBlockOnFailure: false }, null, {}), caps);
  const r2 = await runContentChecks(raw, ctx, lenient, pipelineDeps([]));
  assert.equal(r2.action, 'accept');
  assert.deepEqual(r2.virusScan, { status: 'unscanned', reason: 'scanner-error' });
});

test('pipeline: host-not-found (container stopped / NXDOMAIN) keeps the failure policy and the unscanned header', async () => {
  const nx = await detectScanner({ envDisabled: false, host: 'clamav', probe: okProbe }, deps(async () => { throw codeErr('ENOTFOUND'); }));
  const caps: Caps = { rspamd: nx, clamav: nx };
  const calls: string[] = [];
  const r = await runContentChecks(raw, ctx, applyScannerCapabilities(buildPipelineConfig(SEC, null, {}), caps), pipelineDeps(calls));
  assert.equal(r.action, 'defer', 'clamavBlockOnFailure still defers');
  assert.deepEqual(calls, ['clamav']);
  const lenient = applyScannerCapabilities(buildPipelineConfig({ ...SEC, clamavBlockOnFailure: false }, null, {}), caps);
  const r2 = await runContentChecks(raw, ctx, lenient, pipelineDeps([]));
  assert.equal(r2.action, 'accept');
  assert.deepEqual(r2.virusScan, { status: 'unscanned', reason: 'scanner-error' });
});

// ── monitor ───────────────────────────────────────────────────────────────────

test('CapabilityMonitor: one log line per scanner at start, then only on state changes', async () => {
  const lines: string[] = [];
  const logger = { info: (o: object) => lines.push(`info ${JSON.stringify(o)}`), warn: (o: object) => lines.push(`warn ${JSON.stringify(o)}`) };
  let clamav: Cap = cap('absent');
  let detections = 0;
  let t = 1_000;
  const m = new CapabilityMonitor(async (name) => { detections++; return name === 'rspamd' ? cap('available') : clamav; }, () => t, logger);
  assert.equal(m.get().clamav.reason, 'not-checked');

  await m.refresh();
  assert.equal(lines.length, 2);
  assert.match(lines.join('\n'), /info .*"scanner":"clamav","state":"absent"/);
  await m.refresh();
  assert.equal(lines.length, 2, 'no repeated lines while nothing changes');

  clamav = cap('available');
  await m.refresh();
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, /"scanner":"clamav","state":"available"/);
  assert.equal(m.get().clamav.state, 'available');

  // ensureFresh re-checks only when the cache is older than maxAge
  const before = detections;
  await m.ensureFresh(30_000);
  assert.equal(detections, before);
  t += 31_000;
  await m.ensureFresh(30_000);
  assert.equal(detections, before + 2);

  // concurrent refreshes share one run
  const n = detections;
  await Promise.all([m.refresh(), m.refresh(), m.refresh()]);
  assert.equal(detections, n + 2);
});

test('CapabilityMonitor: never moves into absent at runtime; available → unavailable is a warn line', async () => {
  const lines: string[] = [];
  const logger = { info: (o: object) => lines.push(`info ${JSON.stringify(o)}`), warn: (o: object) => lines.push(`warn ${JSON.stringify(o)}`) };
  let clamav: Cap = cap('available');
  const m = new CapabilityMonitor(async (name) => (name === 'rspamd' ? cap('available') : clamav), () => 1, logger);
  await m.refresh();
  clamav = cap('unavailable', 'host-not-found');
  await m.refresh();
  assert.equal(m.get().clamav.state, 'unavailable');
  assert.match(lines.at(-1)!, /^warn .*"scanner":"clamav","state":"unavailable","reason":"host-not-found"/);
  // a detector that suddenly says absent is kept unavailable
  clamav = cap('absent');
  await m.refresh();
  assert.equal(m.get().clamav.state, 'unavailable');
  // absent from the first check (env switch) stays absent
  const m2 = new CapabilityMonitor(async () => cap('absent'), () => 1, logger);
  await m2.refresh();
  await m2.refresh();
  assert.equal(m2.get().clamav.state, 'absent');
});
