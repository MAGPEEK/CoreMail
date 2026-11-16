/**
 * ClamAV policy (9.2): signature categories, oversize/timeout/failure handling,
 * the X-CoreMail-Virus-Scan note, VERSION/STATS parsing and the EICAR self-test.
 * Run: node --import tsx --test src/clamav/clamav-policy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { buildPipelineConfig, DEFAULT_PIPELINE_CONFIG } = await import('../settings.js');
const { evaluateClamav, scanWithPolicy, runContentChecks } = await import('../pipeline/index.js');
const {
  classifySignature, parseClamdResponse, parseClamdVersion, parseClamdStats, eicarTestMessage,
} = await import('./index.js');
const { clamavStatus, eicarTest } = await import('./routes.js');

type ClamavResult = import('./index.js').ClamavResult;

const SEC = {
  dnsblEnabled: true, geoipMode: 'DISABLED', geoipCountries: [] as unknown,
  attachmentEnabled: false, attachmentMaxSizeMb: 50, attachmentBlockedExt: [] as unknown,
  rspamdEnabled: true, rspamdSpamScore: 6, rspamdRejectScore: 15,
  clamavEnabled: true, clamavAction: 'quarantine', clamavBlockOnFailure: false,
};
const infected = (virusName: string): ClamavResult => ({ status: 'infected', clean: false, virusName });

test('defaults keep the pre-9.2 behaviour', () => {
  const cfg = buildPipelineConfig(SEC, null, {});
  assert.equal(cfg.clamavTimeoutMs, 20_000);
  assert.equal(cfg.clamavScanLimitBytes, 50 * 1024 * 1024);
  assert.equal(cfg.clamavOversizeAction, 'accept');
  assert.equal(cfg.clamavHeuristicsAsVirus, true);
  assert.equal(cfg.clamavPuaAsVirus, true);
  assert.equal(cfg.clamavEncryptedAsVirus, true);
  assert.equal(buildPipelineConfig(null, null, {}).clamavTimeoutMs, DEFAULT_PIPELINE_CONFIG.clamavTimeoutMs);
  // every FOUND result is still a virus by default
  for (const sig of ['Win.Test.EICAR_HDB-1', 'Heuristics.Phishing.Email.SpoofedDomain', 'PUA.Win.Packer.Upx-1', 'Heuristics.Encrypted.Zip']) {
    assert.equal(evaluateClamav(infected(sig), cfg).decision?.action, 'quarantine', sig);
  }
});

test('settings mapping clamps out-of-range values', () => {
  const cfg = buildPipelineConfig({ ...SEC, clamavTimeoutSec: 999, clamavScanLimitMb: 0, clamavOversizeAction: 'bogus' }, null, {});
  assert.equal(cfg.clamavTimeoutMs, 25_000);
  assert.equal(cfg.clamavScanLimitBytes, 1024 * 1024);
  assert.equal(cfg.clamavOversizeAction, 'accept');
  assert.equal(buildPipelineConfig({ ...SEC, clamavOversizeAction: 'reject' }, null, {}).clamavOversizeAction, 'reject');
});

test('signature categories', () => {
  assert.equal(classifySignature('Win.Test.EICAR_HDB-1'), 'malware');
  assert.equal(classifySignature('Eicar-Signature'), 'malware');
  assert.equal(classifySignature('Heuristics.Encrypted.Zip'), 'encrypted');
  assert.equal(classifySignature('Heuristics.Encrypted.PDF'), 'encrypted');
  assert.equal(classifySignature('PUA.Win.Packer.Upx-1'), 'pua');
  assert.equal(classifySignature('Heuristics.OLE2.ContainsMacros'), 'heuristic');
  assert.equal(classifySignature('Heuristics.Limits.Exceeded'), 'heuristic');
  assert.equal(classifySignature('Broken.Executable'), 'heuristic');
  assert.equal(classifySignature(undefined), 'malware');
});

test('categories switched off → delivered with a "suspicious" note; real malware is never downgraded', () => {
  const cfg = buildPipelineConfig({ ...SEC, clamavHeuristicsAsVirus: false, clamavPuaAsVirus: false, clamavEncryptedAsVirus: false }, null, {});
  for (const sig of ['Heuristics.OLE2.ContainsMacros', 'PUA.Win.Packer.Upx-1', 'Heuristics.Encrypted.Zip']) {
    const r = evaluateClamav(infected(sig), cfg);
    assert.equal(r.decision, null, sig);
    assert.deepEqual(r.note, { status: 'suspicious', signature: sig });
  }
  assert.equal(evaluateClamav(infected('Win.Trojan.Agent-1'), cfg).decision?.action, 'quarantine');
  // switches are independent
  const onlyPua = buildPipelineConfig({ ...SEC, clamavPuaAsVirus: false }, null, {});
  assert.equal(evaluateClamav(infected('PUA.Win.Packer.Upx-1'), onlyPua).decision, null);
  assert.equal(evaluateClamav(infected('Heuristics.Encrypted.Zip'), onlyPua).decision?.action, 'quarantine');
});

test('infected: quarantine carries the note, pass delivers tagged, reject has no note in the decision', () => {
  const q = evaluateClamav(infected('Eicar'), buildPipelineConfig(SEC, null, {}));
  assert.deepEqual(q.decision?.virusScan, { status: 'infected', signature: 'Eicar' });
  const p = evaluateClamav(infected('Eicar'), buildPipelineConfig({ ...SEC, clamavAction: 'pass' }, null, {}));
  assert.equal(p.decision, null);
  assert.deepEqual(p.note, { status: 'infected', signature: 'Eicar' });
  const r = evaluateClamav(infected('Eicar'), buildPipelineConfig({ ...SEC, clamavAction: 'reject' }, null, {}));
  assert.equal(r.decision?.action, 'reject');
  assert.equal(r.decision?.virusScan, undefined);
});

test('oversize and scanner errors follow their own policies', () => {
  const big: ClamavResult = { status: 'oversize', clean: false };
  const err: ClamavResult = { status: 'error', clean: false, error: 'scan timeout' };
  const base = buildPipelineConfig(SEC, null, {});
  assert.deepEqual(evaluateClamav(big, base), { decision: null, note: { status: 'unscanned', reason: 'too-large' } });
  assert.equal(evaluateClamav(big, buildPipelineConfig({ ...SEC, clamavOversizeAction: 'reject' }, null, {})).decision?.action, 'reject');
  assert.deepEqual(evaluateClamav(err, base), { decision: null, note: { status: 'unscanned', reason: 'scanner-error' } });
  assert.equal(evaluateClamav(err, buildPipelineConfig({ ...SEC, clamavBlockOnFailure: true }, null, {})).decision?.action, 'defer');
  assert.deepEqual(evaluateClamav({ status: 'clean', clean: true }, base), { decision: null });
  // clamd's own StreamMaxLength answer counts as oversize, not as a scanner failure
  assert.equal(parseClamdResponse('INSTREAM size limit exceeded. ERROR\0').status, 'oversize');
});

test('scanWithPolicy: above the limit clamd is not contacted; the timeout is passed on', async () => {
  const seen: Array<number | undefined> = [];
  const scan = async (_raw: Buffer, opts?: { timeoutMs?: number }): Promise<ClamavResult> => { seen.push(opts?.timeoutMs); return { status: 'clean', clean: true }; };
  const cfg = buildPipelineConfig({ ...SEC, clamavScanLimitMb: 1, clamavTimeoutSec: 7 }, null, {});
  assert.equal((await scanWithPolicy(Buffer.alloc(1024 * 1024 + 1), cfg, scan)).status, 'oversize');
  assert.deepEqual(seen, []);
  assert.equal((await scanWithPolicy(Buffer.alloc(10), cfg, scan)).status, 'clean');
  assert.deepEqual(seen, [7000]);
});

test('content pipeline: the note reaches the accepted result; a rspamd reject drops it', async () => {
  const ctx = { senderIp: '203.0.113.9', mailFrom: 'a@b.example', rcptTo: 'u@local.example' };
  const raw = Buffer.from('Subject: x\r\n\r\nbody');
  const deps = (score: number, clam: ClamavResult) => ({
    dnsbl: async () => ({ listed: false, whitelisted: false, hits: [], totalScore: 0, action: null }),
    country: async () => ({ allowed: true }),
    greylist: async () => ({ action: 'accept' as const }),
    authenticate: async () => ({ spf: 'pass', dkim: 'pass', dmarc: 'pass', summary: 'ok' }),
    blacklist: async () => ({ blocked: false }),
    parse: async () => ({ attachments: [] }),
    clamav: async () => clam,
    rspamd: async () => ({ score }),
    isLocalDomain: async () => false,
  }) as never;
  const cfg = buildPipelineConfig(SEC, null, {});
  const ok = await runContentChecks(raw, ctx, cfg, deps(1, { status: 'error', clean: false, error: 'down' }));
  assert.equal(ok.action, 'accept');
  assert.deepEqual(ok.virusScan, { status: 'unscanned', reason: 'scanner-error' });
  const junk = await runContentChecks(raw, ctx, cfg, deps(8, { status: 'error', clean: false, error: 'down' }));
  assert.equal(junk.junkFolder, true);
  assert.deepEqual(junk.virusScan, { status: 'unscanned', reason: 'scanner-error' });
  const rej = await runContentChecks(raw, ctx, cfg, deps(99, { status: 'error', clean: false, error: 'down' }));
  assert.equal(rej.action, 'reject');
  assert.equal(rej.virusScan, undefined);
  const clean = await runContentChecks(raw, ctx, cfg, deps(1, { status: 'clean', clean: true }));
  assert.equal(clean.virusScan, undefined);
  const q = await runContentChecks(raw, ctx, cfg, deps(1, infected('Eicar')));
  assert.equal(q.action, 'quarantine');
  assert.equal(q.virusScan?.status, 'infected');
});

test('clamd VERSION / STATS parsing', () => {
  const v = parseClamdVersion('ClamAV 1.4.1/27450/Mon Nov 16 09:23:00 2026\0');
  assert.equal(v.engine, '1.4.1');
  assert.equal(v.signatureVersion, 27450);
  assert.ok(v.signatureDate && v.signatureDate.startsWith('2026-11-16'));
  assert.deepEqual(parseClamdVersion('ClamAV 1.4.1'), { raw: 'ClamAV 1.4.1', engine: '1.4.1' });
  assert.deepEqual(parseClamdVersion('COMMAND UNAVAILABLE'), { raw: 'COMMAND UNAVAILABLE' });
  const s = parseClamdStats('POOLS: 1\n\nSTATE: VALID PRIMARY\nTHREADS: live 1  idle 0 max 10 idle-timeout 30\nQUEUE: 0 items\n\tSTATS 0.000038\n\nMEMSTATS: heap N/A\nEND');
  assert.equal(s.queueItems, 0);
  assert.equal(s.threadsMax, 10);
});

test('status report: online with signature age; offline with the error', async () => {
  // clamd prints the database date without a zone (parsed as local time)
  const now = Date.parse('Mon Nov 16 09:23:00 2026') + 48 * 3_600_000;
  const up = await clamavStatus(buildPipelineConfig(SEC, null, {}), {
    command: async (c) => (c === 'VERSION' ? 'ClamAV 1.4.1/27450/Mon Nov 16 09:23:00 2026' : 'QUEUE: 2 items\nEND'),
    now: () => now,
  });
  assert.equal(up.online, true);
  assert.equal(up.enabled, true);
  assert.equal(up.version?.signatureVersion, 27450);
  assert.equal(up.stats?.queueItems, 2);
  assert.ok(up.signatureAgeHours !== undefined && up.signatureAgeHours >= 47 && up.signatureAgeHours <= 49);
  const down = await clamavStatus(buildPipelineConfig({ ...SEC, clamavEnabled: false }, null, {}), {
    command: async () => { throw new Error('connect ECONNREFUSED'); },
    now: () => now,
  });
  assert.deepEqual({ online: down.online, enabled: down.enabled, error: down.error }, { online: false, enabled: false, error: 'connect ECONNREFUSED' });
});

test('EICAR self-test scans a MIME message with the base64 test file and reports the pipeline outcome', async () => {
  const msg = eicarTestMessage().toString('ascii');
  assert.match(msg, /^Content-Transfer-Encoding: base64$/m);
  const b64 = /\r\n\r\n([A-Za-z0-9+/=]+)\r\n--cm-eicar--/.exec(msg)?.[1] ?? '';
  assert.match(Buffer.from(b64, 'base64').toString('ascii'), /^X5O!P%@AP\[4\\PZX54\(P\^\)7CC\)7\}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H\+H\*$/);

  let scanned = '';
  const found = async (raw: Buffer): Promise<ClamavResult> => { scanned = raw.toString('ascii'); return infected('Win.Test.EICAR_HDB-1'); };
  const r = await eicarTest(buildPipelineConfig(SEC, null, {}), found);
  assert.equal(scanned, msg);
  assert.deepEqual({ detected: r.detected, outcome: r.outcome, category: r.category, countsAsVirus: r.countsAsVirus },
    { detected: true, outcome: 'quarantine', category: 'malware', countsAsVirus: true });
  assert.equal((await eicarTest(buildPipelineConfig({ ...SEC, clamavAction: 'reject' }, null, {}), found)).outcome, 'reject');
  assert.equal((await eicarTest(buildPipelineConfig({ ...SEC, clamavAction: 'pass' }, null, {}), found)).outcome, 'deliver-tagged');
  const down = await eicarTest(buildPipelineConfig({ ...SEC, clamavBlockOnFailure: true }, null, {}), async () => ({ status: 'error', clean: false, error: 'connect ECONNREFUSED' }));
  assert.deepEqual({ detected: down.detected, outcome: down.outcome, error: down.error }, { detected: false, outcome: 'defer', error: 'connect ECONNREFUSED' });
  const missed = await eicarTest(buildPipelineConfig(SEC, null, {}), async () => ({ status: 'clean', clean: true }));
  assert.deepEqual({ detected: missed.detected, outcome: missed.outcome }, { detected: false, outcome: 'deliver' });
});

test('scanBuffer: clamd closing mid-stream with "size limit exceeded" is oversize, not a scanner error', async () => {
  const net = await import('node:net');
  const { scanBuffer } = await import('./index.js');
  const server = net.createServer((sock) => {
    let got = 0;
    sock.on('error', () => undefined);
    sock.on('data', (d: Buffer) => {
      got += d.length;
      if (got > 64 * 1024 && !sock.destroyed) {
        // like clamd: reply, stop reading, close with unread data (→ RST while the client still writes)
        sock.pause();
        sock.write('INSTREAM size limit exceeded. ERROR\0', () => setTimeout(() => sock.destroy(), 50));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('node:net').AddressInfo).port;
  try {
    for (let i = 0; i < 5; i++) {
      const r = await scanBuffer(Buffer.alloc(16 * 1024 * 1024, 0x41), { timeoutMs: 5_000, endpoint: { host: '127.0.0.1', port } });
      assert.equal(r.status, 'oversize', `run ${i}: ${r.error ?? ''}`);
    }
  } finally {
    server.close();
  }
});
